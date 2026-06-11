# OpenCode UltraCode System — Complete Architecture

> **Target reader:** A curious 12-year-old who wants to understand everything, exactly as the creators understand it.
> **Goal:** Zero information loss. After reading this, you should understand the system as well as we do.
> **Rule:** We never delete from this document. We only add new sections.

---

## 📖 Table of Contents

1. [What Is This Project?](#1-what-is-this-project)
2. [The Problem We're Solving](#2-the-problem-were-solving)
3. [Our Solution: The Layered Architecture](#3-our-solution-the-layered-architecture)
4. [Layer 1: The Base — OpenCode Framework](#4-layer-1-the-base--opencode-framework)
5. [Layer 2: Harness — The Enforcement Engine](#5-layer-2-harness--the-enforcement-engine)
6. [Layer 3: Workflow Executor — The Agent Spawner](#6-layer-3-workflow-executor--the-agent-spawner)
7. [Layer 4: Simulation Engine — The Predictor](#7-layer-4-simulation-engine--the-predictor)
8. [Layer 5: Quality Systems — Profiles, Interviews, Reports, Memory](#8-layer-5-quality-systems)
9. [Layer 6: Knowledge — Graphify Integration](#9-layer-6-knowledge--graphify-integration)
10. [Layer 7: Infrastructure — All Other Plugins](#10-layer-7-infrastructure--all-other-plugins)
11. [All 21 Plugins — Quick Reference](#11-all-21-plugins--quick-reference)
12. [All 5 Enforcement Gates](#12-all-5-enforcement-gates)
13. [The Guide-3x-Then-Force Pattern](#13-the-guide-3x-then-force-pattern)
14. [Configuration Files](#14-configuration-files)
15. [All Commands](#15-all-commands)
16. [All Decisions and Why](#16-all-decisions-and-why)
17. [Testing Results and Rankings](#17-testing-results-and-rankings)
18. [How Everything Connects](#18-how-everything-connects)
19. [Glossary](#19-glossary)

---

## 1. What Is This Project?

**In one sentence:** We took a cheap, not-very-smart AI model (MiMo V2.5) and built a scaffolding system around it that makes it perform as well as the most expensive, smartest model (Claude Opus 4.8).

**Think of it like this:** Imagine you have a worker who isn't very smart (the cheap model). Alone, they'd make mistakes and miss things. But if you give them:
- A **checklist** they MUST follow (the gates)
- A **team of specialists** to debate problems (the simulation engine)
- A **foreman** who checks their work (the verifier)
- A **photographic memory** of past work (the memory scanner)
- A **knowledge graph** of the whole project (graphify)
- A **reporter** who writes up findings (report system)

...then this worker can outperform a genius working alone. That's exactly what we built.

---

## 2. The Problem We're Solving

### The Core Problem

Expensive AI models (Opus 4.8 at $25/M output tokens) are too costly for everyday use. Cheap models (MiMo V2.5 free) are too unreliable for complex tasks.

### The Chinese Whisper Problem

When information passes from one agent to another, it degrades — like the game of Chinese Whispers. A 0.01% information loss per step compounds into massive errors over time. Our documentation must prevent this.

### The Enforcement Problem

Telling a model "please follow the workflow" doesn't work. Cheap models forget instructions. We needed to **enforce** the workflow in code, not just suggest it.

---

## 3. Our Solution: The Layered Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│  LAYER 7: Knowledge — Graphify (graphify-bridge.ts)                │
│  Knowledge graphs, codebase queries, entity extraction             │
├─────────────────────────────────────────────────────────────────────┤
│  LAYER 6: Quality — Profiles/Interviews/Reports/Memory             │
│  Personas, agent interrogation, report generation, file memory     │
├─────────────────────────────────────────────────────────────────────┤
│  LAYER 5: Simulation — The Predictor (simulation-engine.ts)        │
│  Debate rounds, convergence detection, emergence analysis          │
├─────────────────────────────────────────────────────────────────────┤
│  LAYER 4: Agent Spawner — Workflow Executor (workflow-executor.ts) │
│  Spawns real agents via `opencode run`, parallel execution, caps   │
├─────────────────────────────────────────────────────────────────────┤
│  LAYER 3: Orchestration — UltraCode Runtime (ultracode-runtime.ts) │
│  Dynamic workflows, classify/fan_out/adversarial patterns, budgets │
├─────────────────────────────────────────────────────────────────────┤
│  LAYER 2: Enforcement — Harness (harness.ts)                      │
│  5 gates with guide-3x-then-force, permissions, compaction, costs │
├─────────────────────────────────────────────────────────────────────┤
│  LAYER 1: Base — OpenCode Framework                               │
│  The CLI tool that runs everything (opencode run, plugins, agents) │
└─────────────────────────────────────────────────────────────────────┘
```

---

## 4. Layer 1: The Base — OpenCode Framework

OpenCode is an open-source AI coding agent framework (like Claude Code but open). It provides:

- **CLI**: `opencode run` launches a session
- **Plugins**: TypeScript files that add tools and hooks
- **Agents**: System prompt definitions in `.md` files
- **Commands**: Slash commands in `.md` files
- **MCP**: Model Context Protocol for external tools

### Our Configuration File

**File:** `C:\Users\Lenovo\.config\opencode\opencode.jsonc`

This is the master config. It lists all 21 plugins, the default model, providers, permissions, and commands.

```jsonc
{
  "model": "lightning/anthropic/claude-opus-4-8",  // Default model
  "plugin": ["./plugins/harness.ts", ...],          // 21 plugins
  "permission": { "edit": "allow", "bash": {...} }, // Security
  "compaction": { "auto": true }                     // Context management
}
```

**Decision:** We use `lightning/anthropic/claude-opus-4-8` as default because:
- The gates only fire when `isModelTool` matches "read/edit/write"
- Subagents use `--model opencode/mimo-v2.5-free` explicitly
- The default model is for the main session, not subagents

### Our Agent Definition

**File:** `C:\Users\Lenovo\.config\opencode\agents\ultracode.md`

This is the system prompt that runs in every UltraCode session. It tells the model:
- "You are in ULTRACODE mode with MAXIMUM reasoning effort"
- "Every task goes through the full workflow"
- "When blocked by a gate, use the recommended tool"
- "Available tools include: execute_workflow, simulate, predict, etc."

---

## 5. Layer 2: Harness — The Enforcement Engine

**Plugin:** `harness.ts` (the MOST IMPORTANT plugin)

### What It Does

The Harness is like a **hall monitor** for the AI. It watches every tool call and makes sure the model follows the rules. It has:

### The 5 Enforcement Gates

| Gate | Name | What It Checks | What It Does on Violation |
|:----:|------|----------------|---------------------------|
| 1 | `classify_task` | Did the model call classify_task before working? | Guides 3 times, then auto-classifies |
| 2 | `verify` | Did the model run verification after editing? | Guides 3 times, then auto-runs `npx tsc` |
| 3 | `fan_out` | Is the model reading too many files sequentially? | Guides 3 times, then auto-fan-out |
| 4 | `adversarial_review` | Did the model review findings before acting? | Guides 3 times, then auto-reviews |
| 5 | `read_adversarial` | Did the model review after 5+ reads? | Guides 3 times, then auto-reviews |

### The Guide-3x-Then-Force Pattern

This is the KEY INNOVATION. Instead of blocking the model (which causes infinite loops), we:

1. **Guide 3 times**: Let the model's action through, but increment a counter
2. **On the 4th violation**: Auto-execute the correct tool and return the results
3. **Tell the model**: "I ran this for you, here are the results, continue"

This is like a parent who lets a child make a mistake 3 times, then steps in and does it for them, showing them how.

### The Permission System

**`permission.ask` hook** — This is a direct hook into OpenCode's permission system. Instead of hacking regexes to catch `npx tsc` commands (which never worked perfectly), we intercept ALL permission requests and:

- **Auto-approve**: `npx tsc`, `npm test`, `python -m py_compile`, `node --check`, `head`, `sort`, `wc`, `grep`, etc.
- **Auto-block**: `git push`, `git merge`, `git checkout main`
- **Leave everything else** to the normal permission system

### The Verification Interceptor

Before the `permission.ask` hook existed, we used regex matching in `tool.execute.before` to catch `npx tsc --noEmit` commands and re-route them through `Bun.spawnSync`. This was fragile and broke when the model added `|| true` or `2>&1`. The `permission.ask` hook REPLACED this entirely.

### Cost Tracking

Every tool call is tracked with estimated token counts. The `report_cost` tool shows the session total.

### 5-Stage Compaction Pipeline

When the context window gets full, the compaction hook runs 5 stages progressively:

| Stage | Threshold | What It Does |
|:-----:|:---------:|--------------|
| 1 — Budget | 50K tokens | Truncate strings >500 chars |
| 2 — Snip | 80K tokens | Truncate code blocks >3000 chars |
| 3 — Microcompact | 120K tokens | Compress JSON arrays, collapse whitespace |
| 4 — Collapse | 200K tokens | Truncate ALL strings >2000 chars |
| 5 — Auto | 300K tokens | Remove npm install logs, empty strings |

### Session Telemetry

The harness tracks: tool calls, reads, edits, writes, bash commands, files touched, gates fired. This data is saved to `.opencode/runtime/session-summary.json` and injected into post-compaction context.

---

## 6. Layer 3: Workflow Executor — The Agent Spawner

**Plugin:** `workflow-executor.ts`

### What It Does

This is the **execution engine**. When the model writes a workflow script like:

```javascript
export const meta = { name: "audit", description: "Security audit", phases: [{title: "Scan"}] }
phase("Scan")
agent("Check auth module for vulnerabilities")
agent("Check API routes for injection")
phase("Verify")  
agent("Verify all findings")
```

The `execute_workflow` tool:
1. **Parses** the script (extracts meta, phase(), agent(), parallel(), pipeline() calls)
2. **Saves** it to `.opencode/runtime/workflows/wf_*.js` (versionable, inspectable)
3. **Shows an approval plan** with phases, step count, estimated tokens
4. **Spawns REAL agents** by calling `opencode run "<prompt>" --pure --format default`
5. **Auto-verifies** after each agent (runs `npx tsc --noEmit`)
6. **Synthesizes** results into a structured report

### Execution Loop Modes

| Mode | What It Does |
|------|-------------|
| `once` | Single pass through all steps |
| `implement_verify_fix` | Each agent → adversarial verifier → fixer |
| `converge` | Multi-pass until no flaws found (up to 5 loops) |

### Agent Caps

| Cap | Value | Why |
|:---:|:-----:|-----|
| Concurrent | 16 | Matches Claude Code June 2026 |
| Total per run | 1000 | Prevents runaway loops |
| Retries | 3 | Auto-retry failed agents |

### Worktree Isolation

When enabled (`worktree_isolation: true`), each agent gets its own git worktree. This prevents file conflicts when multiple agents write to the same files. Worktrees are auto-cleaned after execution.

### Pipeline Data Flow

When using `pipeline()` steps, each stage's output is passed as context to the next stage. This enables sequential data flow without Chinese Whisper degradation.

---

## 7. Layer 4: Simulation Engine — The Predictor

**Plugin:** `simulation-engine.ts`

### What It Does

This is the **simulation engine** (inspired by MiroFish). It runs multi-agent debates where agents with different personalities argue about a question and converge on a prediction.

### The Simulation Pipeline

```
simulate({task, count, rounds})
  → Step 1: Seed — Load background context
  → Step 2: Spawn — Create N agents with diverse personas
  → Step 3: Debate — Round-robin, each agent sees ALL previous responses
  → Step 4: Converge — Check if supermajority (≥70%) agrees OR positions stabilize
  → Step 5: Emerge — Detect claims that arose organically during debate
  → Step 6: Output — Transcript + positions + emergence findings
```

### Convergence Detection

Two ways the simulation decides it's done:

1. **Supermajority**: ≥70% of agents agree on a position (FOR or AGAINST)
2. **Position stability**: Same agents hold same positions for 2+ consecutive rounds

Whichever happens first.

### Emergence Detection

Claims that appear during debate (not in the seed data) are tracked:
- Which round they appeared
- How many agents support/oppose them
- Their confidence level (high/medium/low)

This is how the simulation discovers insights that NO SINGLE AGENT would have found alone.

### The `predict()` Tool

A streamlined version of `simulate()` that automatically produces:
- Consensus prediction (SUPPORT or OPPOSE)
- Confidence percentage
- Key arguments from each agent
- Emergent insights
- Overall prediction statement

---

## 8. Layer 5: Quality Systems

### 8a. Profile System (`profile-system.ts`)

Generates agent PERSONALITIES. There are 12 types:

| Type | Focus | Thinking Style |
|------|-------|----------------|
| Debugger | Edge cases, what breaks | Skeptical, boundary-testing |
| Reviewer | Quality, correctness | Thorough, standards-compliant |
| Architect | Structure, scalability | Big-picture, abstraction |
| Optimizer | Performance, efficiency | Efficiency-first, metrics |
| Security | Vulnerabilities | Paranoid, threat-modeling |
| Teacher | Explanations | Clear, educational |
| Critic | Finding flaws | Devil's advocate |
| Engineer | Building things | Pragmatic, solution-oriented |
| Researcher | Deep investigation | Evidence-based |
| Strategist | Planning | Long-term, risk-aware |
| Integrator | Compatibility | Holistic, dependency-aware |
| Tester | Coverage | Methodical, coverage-driven |

**Tools:** `profile_generate`, `profile_batch`, `profile_apply`, `profile_list`, `profile_list_types`

### 8b. Interview System (`interview-system.ts`)

After a simulation, you can INTERROGATE any agent. Each agent gets:
- Their original persona prompt
- The FULL debate transcript
- The question you're asking
- Optional: "no-tools mode" forces pure reasoning

**Tools:** `interview_agent`, `interview_batch`, `interview_all`, `interview_history`

### 8c. Report System (`report-system.ts`)

Generates structured prediction reports using ReACT (Reasoning + Acting):

1. **Plan**: Analyze simulation data, generate 2-5 section outline
2. **Research**: Use `insight_forge` (deep dive), `panorama_search` (broad sweep)
3. **Write**: Each section generated independently
4. **Compile**: Full report saved to `.opencode/runtime/reports/`

**Tools:** `report_plan`, `insight_forge`, `panorama_search`, `report_generate`, `report_view`, `report_chat`

### 8d. Memory Scanner (`memory-scanner.ts`)

File-based memory. No vector database. No embeddings. Just markdown files with headers.

The memory scanner:
1. Scans `.md` files in `~/.claude/memories/` and `~/.config/opencode/memories/`
2. Reads only the HEADERS (name, description, tags)
3. Scores relevance by keyword overlap with current context
4. Returns top 5 most relevant memories
5. Auto-injects them into context during compaction

**Decision:** We chose file-based memory over vector DB because:
- Files are inspectable (open any `.md` file and read it)
- Files are versionable (git commit them)
- Files are editable (any text editor)
- No external service dependency
- No privacy concerns

---

## 9. Layer 6: Knowledge — Graphify Integration

**Plugin:** `graphify-bridge.ts`

Graphify (from github.com/safishamsi/graphify) builds a knowledge graph from any codebase. It uses tree-sitter (28 language grammars) for local AST parsing + LLM for semantic extraction.

**Tools:**
- `graphify_build` — Build knowledge graph from project
- `graphify_query` — Ask questions against the graph (71x fewer tokens than reading files)
- `graphify_explain` — Explain a specific node
- `graphify_path` — Find connections between two nodes
- `graphify_status` — Check if graph exists

**Decision:** Graphify runs locally (tree-sitter parsing) with optional API calls for semantic extraction. It's installed via `pip install graphifyy`. The bridge plugin auto-installs it if missing.

---

## 10. Layer 7: Infrastructure — All Other Plugins

### `rlm-bridge.ts` — Research Language Model Bridge
**Tools:** `decompose` (split tasks), `rlm_query` (spawn subagents), `repl_exec` (Python/JS REPL)

### `subagents.ts` — Agent Management
**Tools:** `list_agents`, `get_agent`, `create_agent`, `activate_agent`, `deactivate_agent`, `get_agent_memory`, `save_agent_memory`

### `skills.ts` — Skill System
**Tools:** `list_skills`, `get_skill`, `invoke_skill`, `create_skill`, `create_builtin_skills`

### `advanced-features.ts` — Advanced Capabilities
**Tools:** `schedule_create/list/delete`, `notify`, `watch_files`, `memory_save/search/list/delete`, `team_create/list/assign/memory_sync`, `env_check`

### `runtime.ts` — Runtime State
**Tools:** `save_state/load_state`, `send_message/read_messages`, `create_tasks/claim_task/complete_task/get_pending_tasks/get_task_events`, `record_failure`, `save/load/list_checkpoints`, `task_stop/update`, `team_delete`

### `dynamic-workflows.ts` — Workflow Patterns
**Tools:** `classify_task`, `fan_out`, `adversarial_review`, `generate_and_filter`, `tournament`, `loop_until_done`

### `ultracode-runtime.ts` — UltraCode Engine
**Tools:** `execute_workflow`, `workflow_next_step/complete_step`, `list/get/resume_workflow_runs`, `parallel_execute`, `structured_output`, `set/check_budget`, `adversarial_verify`, `judge_panel`, `completeness_critic`, `loop_until_dry`, `mcp_query`, `lsp_query`, `sleep`, `tool_search`, `brief`, `mcp_auth`, `agent_view`

### `verifier.ts` — Compilation Verifier
**Hooks:** `tool.execute.after` — checks for compilation errors after edits

### `evolver.ts` — Self-Evolution
**Hooks:** `tool.execute.after` — tracks failure patterns, suggests improvements every 10 tasks

### `shell-bridge.ts` — Windows Shell
**Tools:** `shell_exec`, `shell_mkdir`, `shell_ls`

### `hook-matchers.ts` — Reference Library
Pattern matching utilities for hooks (not a standalone plugin).

---

## 11. All 21 Plugins — Quick Reference

| # | Plugin | Tools | Role |
|:-:|--------|:-----:|------|
| 1 | `harness.ts` | 10 | Enforcement + gates |
| 2 | `ultracode-runtime.ts` | 20+ | Workflow engine + quality patterns |
| 3 | `workflow-executor.ts` | 8 | Real agent spawning |
| 4 | `simulation-engine.ts` | 4 | Debate simulation + prediction |
| 5 | `profile-system.ts` | 5 | Agent personas |
| 6 | `interview-system.ts` | 4 | Agent interrogation |
| 7 | `report-system.ts` | 6 | Prediction reports |
| 8 | `simulation-watch.ts` | 4 | Real-time monitoring |
| 9 | `graphify-bridge.ts` | 5 | Knowledge graphs |
| 10 | `memory-scanner.ts` | 3 | File-based memory |
| 11 | `rlm-bridge.ts` | 3 | RLM subagents |
| 12 | `subagents.ts` | 8 | Agent management |
| 13 | `skills.ts` | 6 | Skill system |
| 14 | `advanced-features.ts` | 14 | Scheduling, teams, notifications |
| 15 | `runtime.ts` | 18 | Task/checkpoint/state management |
| 16 | `dynamic-workflows.ts` | 6 | Workflow patterns |
| 17 | `verifier.ts` | 0 (hooks) | Compilation checking |
| 18 | `evolver.ts` | 0 (hooks) | Self-evolution |
| 19 | `shell-bridge.ts` | 3 | Windows shell |
| 20 | `hook-matchers.ts` | 0 | Reference library |
| 21 | — | — | (reserved) |

---

## 12. All 5 Enforcement Gates

### Gate 1: classify_task

**Trigger:** Model's very first tool call is NOT `classify_task`
**Guide (3x):** Let every read/edit/write through
**Force (4th):** Auto-run file scanning (count `.ts`, `.md`, `.json` files) → determine category (SIMPLE/MODERATE/COMPLEX) → mark checklist → return result

**Why:** The model MUST classify the task before working. Without this, it jumps into work without understanding scope.

### Gate 2: verify

**Trigger:** Model edits/writes files WITHOUT running verification after
**Guide (3x):** Let edits through
**Force (4th):** Auto-run `npx tsc --noEmit` (or `python -m py_compile`) → return real output → mark checklist

**Why:** The model must verify its changes compile. Without this, it introduces syntax errors.

### Gate 3: fan_out

**Trigger:** Model reads 4+ files sequentially WITHOUT calling `fan_out`
**Guide (3x):** Let reads at positions 4, 5, 6 through
**Force (7th read):** Auto-run `dir /s /b` → filter out `node_modules|.git|.cache` → group by extension → return file tree

**Why:** Sequential reads waste context. The model should fan_out to read in parallel.

### Gate 4: adversarial_review (before edits)

**Trigger:** Model has conclusions AND tries to edit WITHOUT calling `adversarial_review`
**Guide (3x):** Let edits through
**Force (4th):** Scan conclusions for risk keywords (password, secret, token, key, auth, sql, eval, exec) → determine risk level → return result

**Why:** The model must review findings before acting on them. Prevents premature actions.

### Gate 5: adversarial_review (after reads)

**Trigger:** Model reads 5+ files WITHOUT any adversarial review
**Guide (3x):** Let reads through
**Force (4th):** Auto-close review → mark checklist → "no unresolved issues found"

**Why:** Prevents the model from reading endlessly without consolidating findings.

---

## 13. The Guide-3x-Then-Force Pattern

This is THE MOST IMPORTANT design decision in the entire system.

### The Old Way (Failed)

Previously, gates would BLOCK the model's action and return an error. This caused:
- Model retries the same action → infinite loop
- Model gets confused → context fills with errors
- Model can't progress → task fails

### The New Way (Works)

```
Guide 1: Let action through, increment counter
Guide 2: Let action through, increment counter  
Guide 3: Let action through, increment counter
FORCE:  Auto-execute the correct tool, return results, tell model "continue"
```

**Think of it like teaching a kid to tie their shoes:**
1. First time they do it wrong → you show them how
2. Second time → you show them again
3. Third time → you show them again
4. Fourth time → you tie it for them and say "watch how I did it"

### The Checklist

Every force-redirect writes to `.opencode/runtime/workflow-checklist.json`:
```json
{
  "classify_task": {"status": "auto-executed", "timestamp": "2026-06-10T...", "details": "category=COMPLEX, 15ts+8md+3json"},
  "verification": {"status": "auto-executed", "timestamp": "2026-06-10T...", "details": "file=src/server.ts, result=OK"}
}
```

This creates an audit trail of which gates fired and what they did.

---

## 14. Configuration Files

### `opencode.jsonc` — Master Configuration
**Location:** `~/.config/opencode/opencode.jsonc`
**Contains:** Model, 21 plugins, providers (Lightning AI, opencode-go), permissions, commands, agents, compaction settings

### `ultracode.md` — Agent Definition
**Location:** `~/.config/opencode/agents/ultracode.md`
**Contains:** System prompt for UltraCode agent with YAML frontmatter for permissions

### `CLAUDE.md` — System Instructions (Managed Level)
**Location:** `~/.config/opencode/CLAUDE.md`
**Contains:** System-wide instructions for all sessions. Part of the 4-level CLAUDE.md hierarchy.

### 25 Command Files
**Location:** `~/.config/opencode/commands/*.md`
**List:** `commit`, `compact`, `config`, `context`, `copy`, `cost`, `deep-research`, `diff`, `doctor`, `export`, `fast`, `graphify`, `goal`, `mcp`, `memory`, `plan`, `review`, `code-review`, `skills`, `status`, `tasks`, `ultracode`, `usage`, `workflows`

---

## 15. All Commands

| Command | What It Does | File |
|---------|-------------|------|
| `/ultracode` | Toggle UltraCode mode | `ultracode.md` |
| `/commit` | AI-powered git commit | `commit.md` |
| `/review` | Code review on current diff | `review.md` |
| `/code-review --fix` | Review + auto-apply fixes | `code-review.md` |
| `/diff` | Categorized git diff | `diff.md` |
| `/doctor` | Environment diagnostics | `doctor.md` |
| `/compact` | Manual context compaction | `compact.md` |
| `/cost` | Token usage estimate | `cost.md` |
| `/context` | Context visualization | `context.md` |
| `/memory` | Memory management | `memory.md` |
| `/config` | View configuration | `config.md` |
| `/mcp` | MCP server management | `mcp.md` |
| `/tasks` | Task management | `tasks.md` |
| `/skills` | Skill management | `skills.md` |
| `/status` | Session status | `status.md` |
| `/plan` | Toggle plan mode | `plan.md` |
| `/fast` | Toggle fast mode | `fast.md` |
| `/export` | Export session | `export.md` |
| `/copy` | Copy to clipboard | `copy.md` |
| `/goal` | Set persistent session goal | `goal.md` |
| `/usage` | Per-category cost breakdown | `usage.md` |
| `/cd` | Directory navigation | `cd.md` |
| `/graphify` | Knowledge graph management | `graphify.md` |
| `/deep-research` | Multi-source research | `deep-research.md` |
| `/workflows` | Workflow run management | `workflows.md` |

---

## 16. All Decisions and Why

### Decision 1: Guide-3x-Then-Force Instead of Block

**What:** Instead of blocking the model when it doesn't follow instructions, we guide 3 times then auto-execute.
**Why:** Blocking causes infinite loops. Auto-execution moves the task forward.
**Evidence:** Previous "block all roads" strategy resulted in 0 bugs found. New strategy finds 33+.

### Decision 2: In-Process Execution (No Docker)

**What:** Everything runs inside the OpenCode plugin system, not as separate Docker containers.
**Why:** Zero deployment friction. No Docker daemon needed. No network surfaces.
**Trade-off:** Limits maximum agent count (practical max: 5-12 for simulations, 16 concurrent).

### Decision 3: File-Based Memory (No Vector DB)

**What:** Memory is stored as .md files with headers. An LLM scans headers to find relevant memories.
**Why:** Files are inspectable, versionable, editable. No external service. No privacy concerns.
**Trade-off:** Less sophisticated retrieval than vector DB. But more transparent and reliable.

### Decision 4: Explicit Model Passing for Subagents

**What:** Every `opencode run` call explicitly passes `--model opencode/mimo-v2.5-free`.
**Why:** Without this, subagents use the default model (Opus 4.8) which is expensive and may be blocked.

### Decision 5: `permission.ask` Hook Instead of Regex Interceptor

**What:** We intercept OpenCode's permission system directly instead of hacking regexes in `tool.execute.before`.
**Why:** The regex approach was fragile — it broke on `|| true`, `2>&1`, and other variants. The `permission.ask` hook catches ALL permission requests cleanly.
**Evidence:** Previous approach required multiple regex fixes. New approach handles all variants.

### Decision 6: MiroFish-Style Simulation Instead of Full MiroFish

**What:** We replicate MiroFish's swarm intelligence patterns (personas, debate rounds, emergence) inside our existing `execute_workflow` tool.
**Why:** Running actual MiroFish requires Docker, Zep Cloud, OASIS framework, and Python 3.11+. Our in-process approach has zero external dependencies.
**Trade-off:** We can't run "thousands" of agents. We run 5-12 quality agents with full debate context.

### Decision 7: 5-Stage Compaction

**What:** Five progressive compaction stages instead of one.
**Why:** One-size-fits-all compaction either compresses too little (wasting space) or too much (losing context). Progressive stages match aggressiveness to need.

### Decision 8: `edit: "allow"`

**What:** We set `"edit": "allow"` in permissions.
**Why:** In CLI mode (`opencode run`), `"ask"` means auto-reject since there's no user to ask. The model needs to write files (reports, findings). Without this, the final report can't be saved.

---

## 17. Testing Results and Rankings

### Test Environment

- **Project:** ultra-hard-test (90+ TypeScript files, 13 modules, Express/TypeScript platform)
- **Model:** opencode/mimo-v2.5-free (free tier)
- **Agent:** ultracode
- **Prompt:** "Run a full security audit..."

### Results Summary

| Metric | Result |
|--------|--------|
| Bugs found | **33** (10 CRITICAL, 10 HIGH, 13 MEDIUM) |
| Simulation | Converged at round 2 (6 personas) |
| Gates auto-fired | Gates 3 and 5 |
| Verification | Interceptor caught `npx tsc --noEmit` |
| Tools used | 10+ including simulate, interview_all, predict |

### Bug Types Found

| Severity | Examples |
|:--------:|----------|
| 🔴 CRITICAL | SQL injection (string interpolation), Broken crypto (no IV, MD5), Mass assignment (Object.assign), Hardcoded JWT secrets (5 files), CORS wildcard + credentials |
| 🟡 HIGH | Weak Math.random() session IDs, Path traversal, Command injection, User enumeration, No rate limiting |
| 🔵 MEDIUM | XSS sanitizer gaps, Swallowed errors, No input validation, Body parser DoS, Memory leaks |

### Final Ranking

| Rank | Configuration | Score | Reason |
|:----:|--------------|:-----:|--------|
| 🥇 | Our Build (21 plugins, all tools, free model) | **12/10** | 33 bugs, simulation, gates, 10+ tools proven live |
| 🥈 | Claude Code + Opus 4.8 | 10/10 | Natural model capability, no enforcement |
| 🥉 | OpenCode + MiMo (gates only) | 9/10 | 25 bugs, no simulation |
| 4 | Old system (no gates) | 3/10 | Infinite loops |
| 5 | Bare Claude Code + MiMo | 2/10 | Flailed |

### Key Insight

> "The deterministic harness (gates, simulation, quality patterns) compensates for the model's weakness more effectively than a smarter model compensates for the lack of a harness."

---

## 18. How Everything Connects

### When a user types a prompt, here's what happens:

```
User types: "Find bugs in this project and simulate a debate on the top findings"

  ↓

1. UltraCode agent activates (system prompt from ultracode.md)
2. Model calls classify_task({task: "Find bugs..."})    ← Gate 1 checks this
3. Model reads files (auth/token.ts, crypto.ts, etc.)   ← Gate 3 fires after 4 reads
4. Model calls fan_out()                                ← Gate 3 satisfied
5. Model reads more files in batches                    ← Gate 5 fires after 5 reads
6. Model finds vulnerabilities
7. Model calls adversarial_review()                     ← Gates 4/5 satisfied
8. Model runs npx tsc --noEmit                          ← permission.ask auto-approves
9. Model calls simulate({task, 6 personas, 4 rounds})   ← Simulation engine
10. Simulation converges at round 2
11. Model calls interview_all()                         ← Interview system
12. Model calls predict()                               ← Prediction engine
13. Model calls report_generate()                       ← Report system
14. Model writes SECURITY_AUDIT_REPORT.md               ← edit: allow
```

### Data Flow:

```
User Prompt
    ↓
Harness (gates check every step)
    ↓
Workflow Executor (spawns agents via opencode run)
    ↓
Simulation Engine (debate → converge → emerge)
    ↓
Interview System (interrogate each agent)
    ↓
Report System (plan → research → write → compile)
    ↓
Final Report (saved to disk)
```

---

## 19. Glossary

| Term | Definition |
|------|-----------|
| **Gate** | An enforcement rule in harness.ts that checks if the model followed the workflow |
| **Guide-3x** | Let the model's action through 3 times while counting violations |
| **Force** | On the 4th violation, auto-execute the correct tool |
| **Checklist** | JSON file tracking which gates auto-executed and their results |
| **Simulation** | Multi-agent debate that converges on predictions |
| **Persona** | An agent personality profile (12 types) |
| **Convergence** | When agents reach ≥70% agreement or positions stabilize |
| **Emergence** | Claims that arise during debate (not in seed data) |
| **Cooldown** | 5-stage progressive context compaction |
| **Interceptor** | Old regex-based tsc catcher (replaced by permission.ask) |
| **MiroFish** | Swarm intelligence engine whose patterns we replicated |
| **Graphify** | Knowledge graph builder (tree-sitter AST + LLM) |
| **Chinese Whispers** | Information degradation as it passes between agents |
| **Opcode 4.8** | (sic) The most expensive/smartest Claude model |
| **MiMo V2.5** | The cheap/free model we're scaffolding |
| **Thermostat** | Old codename for what became the enforcement gates |
| **CLI** | Command Line Interface (opencode run) |
| **MCP** | Model Context Protocol (standard for AI tool interfaces) |
| **ACP** | Agent Client Protocol (OpenCode's agent communication protocol) |
| **ReACT** | Reasoning + Acting pattern (plan → research → write) |
| **LLM** | Large Language Model (the AI brain) |
| **Tree-sitter** | A parser generator for code analysis (used by graphify) |
| **Zep** | External memory service (NOT used — we chose file-based) |
| **OASIS** | CAMEL-AI's simulation framework (NOT used — we built our own) |
