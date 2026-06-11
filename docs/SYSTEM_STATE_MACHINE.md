# OpenCode UltraCode System — UML State Machine Diagram

> **Target reader:** A curious 12-year-old who learns visually.
> **Goal:** Zero information loss — the diagrams plus the architecture doc should make you understand everything.
> **Format:** Mermaid.js state diagrams (render in any markdown viewer that supports Mermaid).
> **Rule:** We never delete, only add.

---

## 📖 Diagram Index

1. [Overall System Flow (Top Level)](#1-overall-system-flow-top-level)
2. [Gate Enforcement State Machine](#2-gate-enforcement-state-machine)
3. [Workflow Executor States](#3-workflow-executor-states)
4. [Simulation Engine States](#4-simulation-engine-states)
5. [Full Pipeline (Single Task)](#5-full-pipeline-single-task)
6. [Permission System Flow](#6-permission-system-flow)
7. [Compaction Pipeline](#7-compaction-pipeline)
8. [Agent Lifecycle](#8-agent-lifecycle)
9. [Interview System Flow](#9-interview-system-flow)
10. [Report Generation Flow](#10-report-generation-flow)

---

## 1. Overall System Flow (Top Level)

This shows the ENTIRE system as one big state machine with orthogonal (parallel) regions.

```mermaid
stateDiagram-v2
    [*] --> Idle
    
    state Idle {
        [*] --> WaitingForInput
        WaitingForInput --> ProcessingInput: User types prompt
    }
    
    state ProcessingInput {
        [*] --> HarnessCheck
        HarnessCheck --> AgentSelection: Gates allow
        
        state AgentSelection {
            [*] --> ChooseAgent
            ChooseAgent --> StandardWorkflow: classify_task + fan_out + adversarial + verify
            ChooseAgent --> SimulationEngine: simulate() called
            ChooseAgent --> DirectExecution: execute_workflow called
        }
        
        StandardWorkflow --> BugFindings
        SimulationEngine --> Predictions
        DirectExecution --> Results
    }
    
    state BugFindings {
        [*] --> adversarial_review
        adversarial_review --> tsc_verification
        tsc_verification --> Report
    }
    
    state Predictions {
        [*] --> interview_all
        interview_all --> predict
        predict --> report_generate
        report_generate --> Report
    }
    
    state Report {
        [*] --> WriteToDisk
        WriteToDisk --> [*]
    }
    
    ProcessingInput --> Idle: Task Complete
```

**What this shows:** Every task goes through a harness check, then one of three paths (standard workflow, simulation, or direct execution), then produces a report. The system always returns to idle waiting for the next input.

---

## 2. Gate Enforcement State Machine

This is the MOST IMPORTANT diagram. It shows how each of the 5 gates works.

Each gate has the same pattern: **Guide 3x → Force**. This diagram shows ONE gate. All 5 gates work the same way.

```mermaid
stateDiagram-v2
    [*] --> Monitoring
    
    state Monitoring {
        [*] --> WatchingToolCalls
        
        WatchingToolCalls --> ViolationDetected: Model breaks rule
        ViolationDetected --> CountGuides
        
        state CountGuides {
            [*] --> Guide1: First violation
            Guide1 --> Guide2: Second violation
            Guide2 --> Guide3: Third violation
            Guide3 --> ForceExec: Fourth violation
        }
        
        ForceExec --> AutoExecute: Run tool programmatically
        AutoExecute --> MarkChecklist: Record in workflow-checklist.json
        MarkChecklist --> InjectResults: Return real output to model
        InjectResults --> [*]: "I ran this for you, continue"
    }
    
    Monitoring --> [*]: Model follows rules (no gates fire)
```

### Example: Gate 3 (fan_out)

Let's trace through a real example:

```
Read 1: src/auth/token.ts      → guide 1 (no action)
Read 2: src/auth/session.ts    → guide 2 (no action)
Read 3: src/auth/roles.ts      → guide 3 (no action)
Read 4: src/auth/permissions.ts → FORCE! Auto-execute fan_out
                                 → Scan 308 files
                                 → Group by extension
                                 → Return file tree
                                 → Tell model "continue"
```

**What the model sees:**
```
[AUTO] fan_out EXECUTED. 308 files found.
Breakdown: json: 162, ts: 98, md: 2...
File tree:
  .json (8+): ...
  .ts (8+): ...

Scan these files in parallel. fan_out is complete.
```

---

## 3. Workflow Executor States

This shows `execute_workflow()` — the tool that spawns REAL agents.

```mermaid
stateDiagram-v2
    [*] --> ParseScript
    
    state ParseScript {
        [*] --> ExtractMeta: Find "export const meta = {...}"
        ExtractMeta --> ParseSteps: Find agent(), parallel(), pipeline() calls
        ParseSteps --> SaveToDisk: Save as .js file
        SaveToDisk --> CheckCaps: Verify 16/1000 limits
    }
    
    CheckCaps --> ShowPlan: Under limit
    ShowPlan --> AskApproval: Display phases + tokens
    AskApproval --> ExecuteSteps: skip_approval: true
    AskApproval --> [*]: No
    
    state ExecuteSteps {
        [*] --> NextStep
        
        NextStep --> AgentStep: type === "agent"
        NextStep --> ParallelStep: type === "parallel"
        NextStep --> PipelineStep: type === "pipeline"
        NextStep --> PhaseStep: type === "phase" (skip)
        
        AgentStep --> SpawnAgent: opencode run "<prompt>"
        SpawnAgent --> AutoVerify: npx tsc --noEmit
        AutoVerify --> MoreSteps: Check remaining
        
        ParallelStep --> SpawnConcurrent: Promise.all(agents)
        SpawnConcurrent --> MoreSteps
        
        PipelineStep --> RunWithContext: Pass prev output to next
        RunWithContext --> MoreSteps
        
        MoreSteps --> NextStep: Steps remaining
        MoreSteps --> Synthesize: All done
    }
    
    Synthesize --> [*]
```

### The 3 Loop Modes

```mermaid
stateDiagram-v2
    state "once" as Once {
        [*] --> RunAgent
        RunAgent --> [*]: Return result
    }
    
    state "implement_verify_fix" as IVF {
        [*] --> Implementer
        Implementer --> Verifier: Challenge findings
        Verifier --> Fixer: Flaws found
        Verifier --> [*]: No flaws
        Fixer --> [*]: Applyed fixes
    }
    
    state "converge" as Converge {
        [*] --> Round1
        Round1 --> CheckConvergence
        CheckConvergence --> Round2: Not converged
        CheckConvergence --> [*]: Converged
        Round2 --> CheckConvergence2
        CheckConvergence2 --> Round3: Not converged
        CheckConvergence2 --> [*]: Converged
        Round3 --> CheckConvergence3
        CheckConvergence3 --> Round4: Not converged
        CheckConvergence3 --> [*]: Converged
        Round4 --> FinalRound
        FinalRound --> [*]
    }
```

---

## 4. Simulation Engine States

This shows `simulate()` — the multi-agent debate system.

```mermaid
stateDiagram-v2
    [*] --> Seed
    
    state Seed {
        [*] --> LoadContext
        LoadContext --> GeneratePersonas: 6 agents
        GeneratePersonas --> StartDebate: All agents ready
    }
    
    state Debate {
        [*] --> Round1
        
        state Round1 {
            [*] --> Agent1_1: "Security Auditor"
            Agent1_1 --> Agent2_1: "Backend Engineer"
            Agent2_1 --> Agent3_1: "DevOps Engineer"
            Agent3_1 --> Agent4_1: "Product Manager"
            Agent4_1 --> Agent5_1: "Attacker"
            Agent5_1 --> Agent6_1: "Compliance Officer"
            Agent6_1 --> [*]: All positions recorded
        }
        
        Round1 --> CheckConvergence1
        
        CheckConvergence1 --> Round2: < 70% agreement
        CheckConvergence1 --> []: ≥ 70% agreement
        CheckConvergence1 --> DetectEmergence: Check for organic claims
        
        state Round2 {
            [*] --> Agent1_2: Sees ALL round 1 responses
            Agent1_2 --> Agent2_2: Can change stance
            Agent2_2 --> Agent3_2
            Agent3_2 --> Agent4_2
            Agent4_2 --> Agent5_2
            Agent5_2 --> Agent6_2
            Agent6_2 --> [*]
        }
        
        Round2 --> CheckConvergence2
        CheckConvergence2 --> Round3: < 70%
        CheckConvergence2 --> []: ≥ 70%
        CheckConvergence2 --> DetectEmergence2
        
        Round3 --> Round4
        Round4 --> [*]: Max rounds
    }
    
    [] --> SynthesizeResults
    
    SynthesizeResults --> [*]
```

### Position State Machine (Per Agent)

Each agent goes through this during debate:

```mermaid
stateDiagram-v2
    [*] --> Undecided: Round 1 start
    
    Undecided --> FOR: Agrees with proposal
    Undecided --> AGAINST: Disagrees with proposal
    Undecided --> Undecided: Neutral
    
    FOR --> AGAINST: Convinced by others (Round 2+)
    FOR --> FOR: Stay consistent
    
    AGAINST --> FOR: Convinced by others (Round 2+)
    AGAINST --> AGAINST: Stay consistent
    
    FOR --> [*]: Simulation ends
    AGAINST --> [*]: Simulation ends
    Undecided --> [*]: Simulation ends
```

---

## 5. Full Pipeline (Single Task)

This traces what happens when the user says: "Find bugs and simulate a debate on the top findings."

```mermaid
stateDiagram-v2
    [*] --> classify_task
    classify_task --> fan_out: "ANALYSIS → Loop Until Done"
    fan_out --> ReadFiles: 6 subtasks dispatched
    
    ReadFiles --> Gate3Check: Read 4+ files
    Gate3Check --> ReadMore: Under 4 reads
    Gate3Check --> AutoFanOut: 4th+ read → auto fan_out
    
    ReadMore --> FindVulnerabilities
    
    state FindVulnerabilities {
        [*] --> JWTSecrets: Found!
        JWTSecrets --> BrokenCrypto: Found!
        BrokenCrypto --> MassAssignment: Found!
        MassAssignment --> SQLInjection: Found!
        SQLInjection --> PathTraversal: Found!
        PathTraversal --> [*]: 10+ findings
    }
    
    FindVulnerabilities --> Gate5Check: 5+ reads
    Gate5Check --> adversarial_review: Model calls it
    Gate5Check --> AutoAdversarial: Model didn't call it
    
    adversarial_review --> tscVerification
    
    tscVerification --> permission_ask: npx tsc --noEmit
    permission_ask --> AutoApprove: "Safe verification command"
    AutoApprove --> TSCResults: Compilation errors found
    
    TSCResults --> simulate: "6 personas debate top 3 findings"
    
    state simulate {
        [*] --> Round1
        Round1 --> Round2
        Round2 --> Converged
        Converged --> Emergence
        Emergence --> [*]
    }
    
    simulate --> interview_all: "Interview every agent"
    interview_all --> predict: "Final verdict"
    
    predict --> report_generate: "Full audit report"
    report_generate --> WriteReport: SECURITY_AUDIT_REPORT.md
    WriteReport --> [*]
```

---

## 6. Permission System Flow

This shows how `permission.ask` works.

```mermaid
stateDiagram-v2
    [*] --> PermissionRequest: Model calls bash
    
    state PermissionRequest {
        [*] --> CheckCommand
        
        CheckCommand --> IsTsc: starts with "npx tsc" or "tsc --noEmit"
        CheckCommand --> IsPython: starts with "python -m py_compile"
        CheckCommand --> IsNode: starts with "node --check"
        CheckCommand --> IsNpm: starts with "npm test" or "npm run"
        CheckCommand --> IsSafe: head, sort, wc, grep, etc.
        CheckCommand --> IsDestructiveGit: starts with "git push/merge/checkout main"
        CheckCommand --> IsOther: Everything else
        
        IsTsc --> AutoApprove
        IsPython --> AutoApprove
        IsNode --> AutoApprove
        IsNpm --> AutoApprove
        IsSafe --> AutoApprove
        
        IsDestructiveGit --> AutoDeny
        
        IsOther --> NormalPermissionSystem
    }
    
    state NormalPermissionSystem {
        [*] --> CheckConfig
        CheckConfig --> Allow: Pattern matched "allow"
        CheckConfig --> Ask: Pattern matched "ask" → auto-reject in CLI
        CheckConfig --> Deny: Pattern matched "deny"
    }
    
    AutoApprove --> [*]: Command runs
    AutoDeny --> [*]: Command blocked
    Allow --> [*]: Command runs
    Ask --> [*]: Command blocked (CLI auto-reject)
    Deny --> [*]: Command blocked
```

**The key insight:** The `permission.ask` hook runs BEFORE the normal permission system. It short-circuits the check entirely for known-safe commands. The normal permission system only runs for "Other" commands.

---

## 7. Compaction Pipeline

This shows the 5-stage compaction that runs when context gets full.

```mermaid
stateDiagram-v2
    [*] --> CheckTokenCount: Every compaction cycle
    
    CheckTokenCount --> Stage1Budget: > 50,000 tokens
    CheckTokenCount --> NoCompaction: < 50,000 tokens
    
    Stage1Budget --> Check80K: Truncate strings > 500 chars
    
    Check80K --> Stage2Snip: > 80,000 tokens
    Check80K --> Done: < 80,000 tokens
    
    Stage2Snip --> Check120K: Truncate code blocks to 3000 chars
    
    Check120K --> Stage3Micro: > 120,000 tokens
    Check120K --> Done: < 120,000 tokens
    
    Stage3Micro --> Check200K: Compress JSON, collapse whitespace
    
    Check200K --> Stage4Collapse: > 200,000 tokens
    Check200K --> Done: < 200,000 tokens
    
    Stage4Collapse --> Check300K: Truncate all strings > 2000 chars
    
    Check300K --> Stage5Auto: > 300,000 tokens
    Check300K --> Done: < 300,000 tokens
    
    Stage5Auto --> Done: Remove npm logs, empty strings
    
    state Done {
        [*] --> ReportStage
        ReportStage --> [*]: "Stage reached: 3-Microcompact"
    }
```

---

## 8. Agent Lifecycle

Every agent spawned by the system goes through these states:

```mermaid
stateDiagram-v2
    [*] --> Configuring
    
    state Configuring {
        [*] --> ReceivePersona: "You are a Security Auditor..."
        ReceivePersona --> ReceivePrompt: "Find bugs in auth module"
        ReceivePrompt --> Ready
    }
    
    Ready --> Running: opencode run called
    Running --> MakingToolCalls: Read files, grep, etc.
    MakingToolCalls --> ProducingOutput: "Found 3 vulnerabilities..."
    ProducingOutput --> Completed
    
    state Completed {
        [*] --> SaveResult
        SaveResult --> ReturnToOrchestrator
        ReturnToOrchestrator --> [*]
    }
    
    Running --> Failed: Timeout or error
    Failed --> Terminating
    Terminating --> RecordFailure: Save error for retry
    RecordFailure --> [*]
    
    Running --> Terminating: max_retries exceeded
```

---

## 9. Interview System Flow

After a simulation, you can interrogate any agent:

```mermaid
stateDiagram-v2
    [*] --> BuildContext
    
    state BuildContext {
        [*] --> LoadPersona: "You are a Security Auditor..."
        LoadPersona --> LoadDebateTranscript: Full debate history
        LoadDebateTranscript --> AppendQuestion: "What is your final position?"
        AppendQuestion --> AddNoToolsRule: "Do NOT use any tools" (optional)
        AddNoToolsRule --> Ready
    }
    
    Ready --> SpawnAgent: opencode run --pure
    SpawnAgent --> RecordAnswer: Save to .opencode/interviews/
    RecordAnswer --> ReturnOutput: Show in chat
    
    state interview_all {
        [*] --> IterateAgents: For EACH agent in simulation
        IterateAgents --> CollectAnswers: Run interview_agent
        CollectAnswers --> GroupByStance: FOR / AGAINST / MIXED / ERROR
        GroupByStance --> [*]: Summary with counts
    }
```

---

## 10. Report Generation Flow

The ReACT (Reasoning + Acting) report generation:

```mermaid
stateDiagram-v2
    [*] --> Planning
    
    state Planning {
        [*] --> AnalyzeSimulation
        AnalyzeSimulation --> GenerateOutline: 2-5 sections
        GenerateOutline --> SavePlan: .opencode/runtime/reports/
        SavePlan --> [*]
    }
    
    Planning --> Research
    
    state Research {
        [*] --> ForEachSection
        
        ForEachSection --> insight_forge: Deep dive on key questions
        ForEachSection --> panorama_search: Broad sweep across data
        panorama_search --> CompileFindings
        
        insight_forge --> CompileFindings
        
        CompileFindings --> NextSection: More sections
        CompileFindings --> [*]: All sections researched
    }
    
    Research --> Writing
    
    state Writing {
        [*] --> Section1: "Executive Summary"
        Section1 --> SaveSection1: section_1.md
        SaveSection1 --> Section2: "Key Arguments"
        Section2 --> SaveSection2: section_2.md
        SaveSection2 --> Section3: "Emergent Insights"
        Section3 --> SaveSection3: section_3.md
        SaveSection3 --> [*]: All sections written
    }
    
    Writing --> Compilation
    
    state Compilation {
        [*] --> MergeSections: Combine all section_*.md
        MergeSections --> AddMetadata: Date, simulation ID, agent count
        AddMetadata --> WriteFullReport: full_report.md
        WriteFullReport --> [*]
    }
```

---

## Appendix: How to Read These Diagrams

### State Machine Basics

```
┌──────────────────────┐
│     State Name       │  ← A rounded box is a STATE
│                      │     (something is happening or waiting)
└──────────────────────┘
         ↓                    ← An arrow is a TRANSITION
         ↓                       (something triggers the change)
    ┌──────────┐
    │ Next State│
    └──────────┘

[*] → State     ← The START arrow (where everything begins)
State → [*]     ← The END arrow (where everything finishes)

state Parent {
    [*] → Child   ← A COMPOSITE state (contains sub-states)
}                   (the parent runs its children in order)
```

### Orthogonal Regions

When you see `state` and `state` side by side inside a parent, they run in PARALLEL (at the same time). This is an "orthogonal region."

### Reading the Gate Diagram

```
Start → Monitoring
        Monitoring sees violation → Count 1, 2, 3 (guide)
        On count 4 → Force → Auto-execute → Mark checklist → Continue
```

This means: The gate watches. When the model breaks a rule, it counts 1, 2, 3 (guiding each time). On the 4th time, it forces the action. Then it marks the checklist and tells the model to continue.
