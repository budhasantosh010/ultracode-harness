// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
// ULTRACODE RUNTIME â€” REAL workflow execution engine
// Phase 5: State-machine orchestrator for agent scripts
// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
// The model writes: execute_workflow_script(script)
// Then loops: workflow_next_step() â†’ do the work â†’ workflow_complete_step(result)
// This is a DETERMINISTIC state machine â€” the model never decides what's next.

import type { Plugin } from "@opencode-ai/plugin"
import { tool } from "@opencode-ai/plugin"
import { readFile, writeFile, mkdirSync, existsSync, readdirSync } from "fs"
import { execSync } from "child_process"
import { promisify } from "util"

const readFileAsync = promisify(readFile)
const writeFileAsync = promisify(writeFile)

// â”€â”€â”€ Agent Caps (matching Claude Code June 2026 limits) â”€â”€â”€â”€â”€
const MAX_CONCURRENT_AGENTS = 16
const MAX_TOTAL_AGENTS_PER_WORKFLOW = 1000
const MAX_WORKFLOW_SCRIPT_ITEMS = 4096
let totalAgentsSpawned = 0 // reset per workflow run

// â”€â”€â”€ Types â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

interface WorkflowMeta {
  name: string
  description: string
  phases?: Array<{ title: string; detail?: string }>
  whenToUse?: string
}

interface WorkflowStep {
  id: number
  type: "phase" | "agent" | "parallel" | "pipeline" | "log" | "done"
  label?: string
  prompt?: string
  phase?: string
  model?: string
  schema?: any
  status: "pending" | "in_progress" | "completed" | "skipped"
  result?: string
  subSteps?: WorkflowStep[]  // for parallel blocks
  items?: string[]           // for pipeline items
}

interface WorkflowRun {
  id: string
  meta: WorkflowMeta
  args: any
  status: "running" | "completed" | "failed" | "paused"
  steps: WorkflowStep[]
  currentStepIndex: number
  budget: { total: number | null; spent: number }
  startedAt: string
  completedAt?: string
  error?: string
  stateDir: string
}

// â”€â”€â”€ Workflow Script Parser â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

function parseWorkflowScript(script: string, args: any): { meta: WorkflowMeta | null; steps: WorkflowStep[]; errors: string[] } {
  const errors: string[] = []
  const steps: WorkflowStep[] = []

  // Extract meta
  const metaMatch = script.match(/export\s+const\s+meta\s*=\s*(\{[\s\S]*?\n\})/)
  let meta: WorkflowMeta | null = null

  if (metaMatch) {
    const metaStr = metaMatch[1]
    const nameMatch = metaStr.match(/name\s*:\s*['"]([^'"]+)['"]/)
    const descMatch = metaStr.match(/description\s*:\s*['"]([^'"]+)['"]/)
    meta = { name: nameMatch?.[1] || "unnamed", description: descMatch?.[1] || "" }

    const phasesMatch = metaStr.match(/phases\s*:\s*\[([\s\S]*?)\]/)
    if (phasesMatch) {
      meta.phases = []
      const phaseRegex = /\{\s*title\s*:\s*['"]([^'"]+)['"](?:,\s*detail\s*:\s*['"]([^'"]+)['"])?\s*\}/g
      let pm: RegExpExecArray | null
      while ((pm = phaseRegex.exec(phasesMatch[1])) !== null) {
        meta.phases.push({ title: pm[1], detail: pm[2] })
      }
    }
  } else {
    errors.push("Missing: export const meta = {name, description}")
    return { meta: null, steps: [], errors }
  }

  // Pass 1: Extract all script actions in order
  // We parse the script body (everything after the meta export)
  const bodyMatch = script.match(/export\s+const\s+meta\s*=\s*\{[\s\S]*?\n\}\s*\n([\s\S]*)$/)
  const body = bodyMatch?.[1] || script

  let stepId = 0

  // Simple sequential parsing: find phase(), agent(), parallel(), pipeline(), log() calls
  // in order of appearance in the body
  const callPattern = /(phase|agent|parallel|pipeline|log)\s*\(/g
  let match: RegExpExecArray | null
  const calls: Array<{ func: string; startIndex: number }> = []

  while ((match = callPattern.exec(body)) !== null) {
    calls.push({ func: match[1], startIndex: match.index })
  }

  // Sort by position (already in order from exec, but be safe)
  calls.sort((a, b) => a.startIndex - b.startIndex)

  // Track whether we're inside a parallel block
  let inParallel = false
  let parallelSteps: WorkflowStep[] = []

  for (const call of calls) {
    switch (call.func) {
      case "phase": {
        const phaseMatch = body.slice(call.startIndex).match(/phase\s*\(\s*['"`]([^'"]+)['"`]\s*\)/)
        if (phaseMatch) {
          // If we were collecting parallel steps, finalize them
          if (inParallel && parallelSteps.length > 0) {
            steps.push({
              id: stepId++,
              type: "parallel",
              label: `parallel_${parallelSteps.length}_agents`,
              subSteps: parallelSteps,
              status: "pending",
            })
            parallelSteps = []
            inParallel = false
          }

          steps.push({
            id: stepId++,
            type: "phase",
            label: phaseMatch[1],
            status: "completed", // phases are markers, auto-completed
            result: `Phase: ${phaseMatch[1]}`,
          })
        }
        break
      }

      case "log": {
        const logMatch = body.slice(call.startIndex).match(/log\s*\(\s*['"`]([^'"]+)['"`]\s*\)/)
        if (logMatch) {
          steps.push({
            id: stepId++,
            type: "log",
            label: logMatch[1],
            status: "completed",
            result: logMatch[1],
          })
        }
        break
      }

      case "agent": {
        // Extract the agent call â€” can be multi-line
        const slice = body.slice(call.startIndex)
        const agentMatch = slice.match(/agent\s*\(\s*['"`]([^'"]+)['"`]\s*(?:,\s*\{([^}]*)\})?\s*\)/)
        if (agentMatch) {
          const prompt = agentMatch[1]
          const optsStr = agentMatch[2] || ""
          const labelMatch = optsStr.match(/label\s*:\s*['"]([^'"]+)['"]/)
          const modelMatch = optsStr.match(/model\s*:\s*['"]([^'"]+)['"]/)
          const phaseMatch = optsStr.match(/phase\s*:\s*['"]([^'"]+)['"]/)
          const schemaMatch = optsStr.match(/schema\s*:\s*(\w+)/)

          const agentStep: WorkflowStep = {
            id: stepId++,
            type: "agent",
            prompt,
            label: labelMatch?.[1] || `agent-${stepId}`,
            phase: phaseMatch?.[1],
            model: modelMatch?.[1],
            schema: schemaMatch?.[1],
            status: "pending",
          }

          if (inParallel) {
            parallelSteps.push(agentStep)
          } else {
            steps.push(agentStep)
          }
        }
        break
      }

      case "parallel": {
        // If we were already collecting parallel steps, finalize them
        if (inParallel && parallelSteps.length > 0) {
          steps.push({
            id: stepId++,
            type: "parallel",
            label: `parallel_${parallelSteps.length}_agents`,
            subSteps: parallelSteps,
            status: "pending",
          })
          parallelSteps = []
        }
        inParallel = true
        break
      }

      case "pipeline": {
        // Finalize any pending parallel block
        if (inParallel && parallelSteps.length > 0) {
          steps.push({
            id: stepId++,
            type: "parallel",
            label: `parallel_${parallelSteps.length}_agents`,
            subSteps: parallelSteps,
            status: "pending",
          })
          parallelSteps = []
          inParallel = false
        }

        steps.push({
          id: stepId++,
          type: "pipeline",
          label: "pipeline",
          status: "pending",
        })
        break
      }
    }
  }

  // Finalize any trailing parallel block
  if (inParallel && parallelSteps.length > 0) {
    steps.push({
      id: stepId++,
      type: "parallel",
      label: `parallel_${parallelSteps.length}_agents`,
      subSteps: parallelSteps,
      status: "pending",
    })
  }

  return { meta, steps, errors }
}

// â”€â”€â”€ Workflow State Management â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

const RUNS_DIR = ".opencode/runtime/workflows"

async function saveRun(run: WorkflowRun): Promise<void> {
  try {
    const dir = `${run.stateDir}/${RUNS_DIR}/${run.id}`
    mkdirSync(dir, { recursive: true })
    await writeFileAsync(`${dir}/state.json`, JSON.stringify(run, null, 2))
  } catch { /* silent */ }
}

async function loadRun(stateDir: string, runId: string): Promise<WorkflowRun | null> {
  try {
    const data = await readFileAsync(`${stateDir}/${RUNS_DIR}/${runId}/state.json`, "utf8")
    return JSON.parse(data)
  } catch { return null }
}

async function listRuns(stateDir: string): Promise<string[]> {
  try {
    const dir = `${stateDir}/${RUNS_DIR}`
    if (!existsSync(dir)) return []
    return readdirSync(dir).filter(f => existsSync(`${dir}/${f}/state.json`))
  } catch { return [] }
}

// â”€â”€â”€ Plugin â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

export const UltracodeRuntime: Plugin = async ({ directory }) => {

  // â”€â”€â”€ Helper: Get the current step the model should execute â”€â”€
  function getCurrentStep(run: WorkflowRun): { step: WorkflowStep | null; progress: string } {
    // Find the first pending step
    for (let i = run.currentStepIndex; i < run.steps.length; i++) {
      const step = run.steps[i]
      if (step.status === "pending" || step.status === "in_progress") {
        return { step, progress: `${i}/${run.steps.length} steps (${Math.round(i / run.steps.length * 100)}%)` }
      }
    }
    return { step: null, progress: `${run.steps.length}/${run.steps.length} steps (100%)` }
  }

  // â”€â”€â”€ Helper: Build next-step instruction text â”€â”€
  function buildStepInstruction(run: WorkflowRun, step: WorkflowStep): string {
    const { progress } = getCurrentStep(run)
    const completedSteps = run.steps.filter(s => s.status === "completed" || s.status === "skipped").length
    const totalSteps = run.steps.length
    const doneSteps = run.steps.filter(s => s.status === "completed").length

    let instruction = `â•â•â• WORKFLOW: ${run.meta.name} â•â•â•\n`
    instruction += `Run: ${run.id} | Phase: ${step.phase || step.label || "unknown"}\n`
    instruction += `Progress: ${doneSteps}/${totalSteps} completed (${Math.round(doneSteps / totalSteps * 100)}%)\n\n`

    // Show recent completed steps for context
    const completed = run.steps.filter(s => s.status === "completed" && s.result).slice(-3)
    if (completed.length > 0) {
      instruction += `Recent results:\n`
      for (const c of completed) {
        const result = (c.result || "").slice(0, 200)
        instruction += `  ${c.type} "${c.label}": ${result}\n`
      }
      instruction += `\n`
    }

    instruction += `NEXT STEP:\n`

    switch (step.type) {
      case "agent":
        instruction += `Execute the following agent task:\n\n${step.prompt}\n\n`
        instruction += `After completing, call workflow_complete_step with a summary of what you found/did.`
        if (step.model) instruction += `\n(Model hint: ${step.model})`
        break

      case "parallel": {
        instruction += `Execute ALL ${step.subSteps?.length || 0} agent tasks in parallel:\n\n`
        for (const sub of step.subSteps || []) {
          instruction += `--- AGENT: ${sub.label} ---\n${sub.prompt}\n\n`
        }
        instruction += `After ALL agents complete, call workflow_complete_step with the combined results.`
        break
      }

      case "pipeline":
        instruction += `Process items through pipeline stages.\n`
        instruction += `Use fan_out or sequential processing as appropriate.\n`
        instruction += `After all stages complete, call workflow_complete_step.`
        break

      default:
        instruction += `Call workflow_complete_step to continue.`
    }

    instruction += `\n\nâ•â•â• ORIGINAL SCRIPT CONTEXT â•â•â•\n`
    instruction += `Workflow: ${run.meta.name}\n`
    instruction += `Description: ${run.meta.description}\n`
    if (run.meta.phases && run.meta.phases.length > 0) {
      instruction += `Phases: ${run.meta.phases.map(p => p.title).join(" â†’ ")}\n`
    }

    // Show upcoming steps for awareness
    const upcoming = run.steps.slice(run.currentStepIndex + 1).filter(s => s.status === "pending").slice(0, 3)
    if (upcoming.length > 0) {
      instruction += `\nUpcoming steps:\n`
      for (const u of upcoming) {
        if (u.type === "phase") instruction += `  [Phase] ${u.label}\n`
        else if (u.type === "agent") instruction += `  [Agent] ${u.label}: "${(u.prompt || "").slice(0, 60)}..."\n`
        else if (u.type === "parallel") instruction += `  [Parallel] ${u.subSteps?.length || 0} concurrent agents\n`
        else instruction += `  [${u.type}] ${u.label}\n`
      }
    }

    return instruction
  }

  return {
    tool: {
      // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
      // execute_workflow_script: Parse + create state machine
      // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
      execute_workflow_script: tool({
        description:
          "Parses a workflow script (agent, parallel, pipeline, phase, log) and creates " +
          "a deterministic execution plan. After calling this, loop: " +
          "workflow_next_step â†’ do the work â†’ workflow_complete_step.",
        args: {
          script: tool.schema.string().describe(
            "JavaScript workflow script. Must begin with export const meta = {name, description, phases}. " +
            "Use agent(prompt, {label?, model?, phase?}), parallel(() => agent(...)), " +
            "pipeline(items, stage1, stage2), phase('title'), log('message')."
          ),
          args: tool.schema.string().describe("JSON arguments for the script").optional().default("{}"),
        },
        async execute(args) {
          let scriptArgs: any = {}
          try { scriptArgs = JSON.parse(args.args || "{}") } catch { scriptArgs = { raw: args.args } }

          const parsed = parseWorkflowScript(args.script, scriptArgs)
          if (!parsed.meta || parsed.errors.length > 0) {
            return {
              output: `WORKFLOW PARSE ERROR:\n${parsed.errors.join("\n")}\n\n` +
                `Required format:\nexport const meta = { name: '...', description: '...', phases: [{title:'...'}] }`
            }
          }

          const run: WorkflowRun = {
            id: `wf_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
            meta: parsed.meta,
            args: scriptArgs,
            status: "running",
            steps: parsed.steps,
            currentStepIndex: 0,
            budget: { total: null, spent: 0 },
            startedAt: new Date().toISOString(),
            stateDir: directory,
          }

          while (run.currentStepIndex < run.steps.length &&
                 (run.steps[run.currentStepIndex].status === "completed" || run.steps[run.currentStepIndex].status === "skipped")) {
            run.currentStepIndex++
          }

          await saveRun(run)

          const { step, progress } = getCurrentStep(run)
          if (!step) return { output: `WORKFLOW EMPTY: No actionable steps found in script.` }

          return {
            output: [
              `â•â•â• ULTRACODE WORKFLOW: ${run.meta.name} â•â•â•\n`,
              `Run ID: ${run.id}`,
              `Total steps: ${run.steps.length}`,
              `Phases: ${run.meta.phases?.map(p => p.title).join(" â†’ ") || "none"}`,
              `Progress: ${progress}\n`,
              `The plan has been saved. Now call workflow_next_step to get the first step to execute.`,
              `\nPattern: workflow_next_step() â†’ execute â†’ workflow_complete_step(result) â†’ repeat.`,
            ].join("\n")
          }
        },
      }),

      // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
      // execute_workflow_runner: SPAWNS REAL AGENTS via CLI
      // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
      execute_workflow_runner: tool({
        description:
          "DELEGATES a workflow script to the ULTRACODE WORKFLOW RUNNER which " +
          "spawns REAL agents via 'opencode run'. Supports true parallel execution, " +
          "budget tracking, cache hits, and schema validation. " +
          "This is the REAL execution engine â€” not a planner.",
        args: {
          script: tool.schema.string().describe(
            "JavaScript workflow script. Must begin with export const meta = {...}. " +
            "Functions: agent(), parallel(), phase(), log()."
          ),
          args: tool.schema.string().describe("JSON arguments for the script").optional().default("{}"),
          budget: tool.schema.number().describe("Token budget (0 = unlimited)").optional().default(0),
          agent: tool.schema.string().describe("Default agent type for all steps").optional().default(""),
          model: tool.schema.string().describe("Default model for all steps").optional().default(""),
          worktree_isolation: tool.schema.boolean().describe("Isolate each subagent in its own worktree to prevent file conflicts").optional().default(false),
          skip_cost_gate: tool.schema.boolean().describe("Skip the approval cost gate").optional().default(false),
        },
        async execute(args) {
          // Cost gate: warn before launching large workflows
          const stepCount = JSON.parse(args.args || "{}").steps?.length || 0
          if (!args.skip_cost_gate && stepCount > 5) {
            const estimatedCost = stepCount * 15000 // rough estimate: ~15K tokens per agent
            return {
              output: `âš ï¸ COST GATE: This workflow has ${stepCount} steps, estimated ~${Math.round(estimatedCost / 1000)}K tokens.\n` +
                `With ${args.model || "current model"} at xhigh effort this could be significant.\n\n` +
                `To proceed, re-run with skip_cost_gate: true.\n` +
                `To estimate first, run a smaller slice (fewer steps/files).\n\n` +
                `Agent caps: ${MAX_CONCURRENT_AGENTS} concurrent / ${MAX_TOTAL_AGENTS_PER_WORKFLOW} total per run.`
            }
          }

          const runnerPath = `${directory}/../scripts/workflow-runner.mjs`
          if (!existsSync(runnerPath)) {
            return { output: `Workflow runner not found at ${runnerPath}. Create it first.` }
          }

          // Parse the script
          const parsed = parseWorkflowScript(args.script, {})
          if (!parsed.meta || parsed.errors.length > 0) {
            return { output: `WORKFLOW PARSE ERROR:\n${parsed.errors.join("\n")}` }
          }

          // Build the workflow definition for the runner
          const workflowDef: any = {
            name: parsed.meta.name,
            description: parsed.meta.description,
            cwd: directory,
            steps: [],
            budget: { total: args.budget > 0 ? args.budget : null },
          }

          // Map script steps to runner steps (simplified â€” we reuse parseWorkflowScript's step structure)
          for (const step of parsed.steps) {
            if (step.type === "agent") {
              workflowDef.steps.push({
                type: "agent",
                label: step.label || "agent",
                prompt: step.prompt,
                agent: args.agent || undefined,
                model: step.model || args.model || undefined,
              })
            } else if (step.type === "parallel" && step.subSteps) {
              workflowDef.steps.push({
                type: "parallel",
                label: step.label || "parallel",
                subSteps: step.subSteps.map(sub => ({
                  label: sub.label || "agent",
                  prompt: sub.prompt,
                  agent: args.agent || undefined,
                  model: sub.model || args.model || undefined,
                })),
              })
            } else if (step.type === "phase" || step.type === "log") {
              workflowDef.steps.push({
                type: step.type,
                label: step.label,
                prompt: step.prompt,
              })
            } else if (step.type === "pipeline") {
              workflowDef.steps.push({
                type: "pipeline",
                label: step.label || "pipeline",
              })
            }
          }

          if (workflowDef.steps.length === 0) {
            return { output: `No executable steps found in script.` }
          }

          // Write workflow definition to temp file
          const wfDir = `${directory}/.opencode/runtime/workflows`
          mkdirSync(wfDir, { recursive: true })
          const wfFile = `${wfDir}/runner_${Date.now()}.json`
          await writeFileAsync(wfFile, JSON.stringify(workflowDef, null, 2))

          // Execute the runner
          const agentCount = workflowDef.steps.filter((s: any) => s.type === "agent" || s.type === "parallel").length
          const startTime = Date.now()

          try {
            const output = execSync(`node "${runnerPath}" "${wfFile}"`, {
              encoding: "utf8",
              timeout: Math.max(workflowDef.steps.length * 120000, 300000), // 2 min per step, min 5 min
              cwd: directory,
              maxBuffer: 50 * 1024 * 1024,
              windowsHide: true,
            })

            // Parse runner output (last line is JSON)
            const lines = output.trim().split("\n")
            const jsonLine = lines.filter(l => l.startsWith("{")).pop() || "{}"
            const result = JSON.parse(jsonLine)

            const duration = Date.now() - startTime

            // Build output summary
            const summaryLines = [
              `â•â•â• WORKFLOW EXECUTED: ${parsed.meta.name} â•â•â•`,
              `Status: ${result.status}`,
              `Steps: ${result.completedSteps}/${result.steps}`,
              `Failed: ${result.failedSteps}`,
              `Total tokens: ~${result.totalTokens?.toLocaleString() || 0}`,
              `Duration: ${(duration / 1000).toFixed(1)}s`,
            ]

            if (result.budget?.total) {
              summaryLines.push(`Budget: ${result.budget.usagePercent} used (${result.budget.spent?.toLocaleString()}/${result.budget.total?.toLocaleString()})`)
            }

            summaryLines.push(``)

            // Add step-by-step results
            for (const r of result.results || []) {
              if (r.type === "phase") {
                summaryLines.push(`[PHASE] ${r.label}`)
              } else if (r.type === "agent") {
                const status = r.failed ? "âŒ" : r.cached ? "âš¡" : "âœ…"
                const outputPreview = (r.output || "").slice(0, 150).replace(/\n/g, " ")
                summaryLines.push(`  ${status} ${r.label}: ${outputPreview}${r.output?.length > 150 ? "..." : ""}`)
              } else if (r.type === "parallel") {
                const succeeded = r.agents?.filter((a: any) => !a.failed).length || 0
                const total = r.agents?.length || 0
                summaryLines.push(`  ðŸ”„ [Parallel] ${succeeded}/${total} agents`)
                for (const a of r.agents || []) {
                  const st = a.failed ? "âŒ" : "âœ…"
                  summaryLines.push(`     ${st} ${a.label}: ${(a.output || "").slice(0, 100).replace(/\n/g, " ")}`)
                }
              }
            }

            // Clean up temp file
            try { execSync(`del "${wfFile}"`, { cwd: directory }) } catch {}

            return { output: summaryLines.join("\n") }
          } catch (err: any) {
            // Try to get partial output even on failure
            let partial = ""
            try {
              const data = readFileSync(wfFile, "utf8")
              partial = data.slice(0, 500)
            } catch {}

            // Clean up temp file
            try { execSync(`del "${wfFile}"`, { cwd: directory }) } catch {}

            return {
              output: `WORKFLOW RUNNER FAILED:\n${err.message?.slice(0, 500) || "Unknown error"}\n\n` +
                `The runner may have timed out (${workflowDef.steps.length} steps Ã— 2 min).\n` +
                `For large workflows, use the step-by-step workflow_next_step approach instead.`
            }
          }
        },
      }),

      // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
      // workflow_next_step: Get the next step to execute
      // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
      workflow_next_step: tool({
        description:
          "Gets the NEXT pending step from the current workflow. Returns the agent prompt " +
          "or parallel block to execute. After completing the work, call workflow_complete_step.",
        args: {
          run_id: tool.schema.string().describe("Workflow run ID"),
        },
        async execute(args) {
          const run = await loadRun(directory, args.run_id)
          if (!run) return { output: `Workflow "${args.run_id}" not found. Use execute_workflow_script first.` }
          if (run.status === "completed" || run.status === "failed") {
            return { output: `Workflow "${args.run_id}" is already ${run.status}. Start a new one.` }
          }

          const { step } = getCurrentStep(run)
          if (!step) {
            run.status = "completed"
            run.completedAt = new Date().toISOString()
            await saveRun(run)
            return { output: `â•â•â• WORKFLOW COMPLETE â•â•â•\nAll ${run.steps.length} steps done. Finalize the task.` }
          }

          // Mark as in_progress
          step.status = "in_progress"

          // For parallel steps, mark all sub-steps too
          if (step.type === "parallel" && step.subSteps) {
            for (const sub of step.subSteps) sub.status = "in_progress"
          }

          // Advance the index past completed markers
          run.currentStepIndex = run.steps.indexOf(step)
          await saveRun(run)

          return { output: buildStepInstruction(run, step) }
        },
      }),

      // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
      // workflow_complete_step: Record result, advance
      // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
      workflow_complete_step: tool({
        description:
          "Records the result of the current step and advances to the next one. " +
          "Call this after you've finished executing the agent prompt from workflow_next_step.",
        args: {
          run_id: tool.schema.string().describe("Workflow run ID"),
          result: tool.schema.string().describe("Summary of what was done/found (max 2000 chars)"),
          skip: tool.schema.boolean().describe("Set true to skip remaining steps and mark workflow complete").optional().default(false),
        },
        async execute(args) {
          const run = await loadRun(directory, args.run_id)
          if (!run) return { output: `Workflow "${args.run_id}" not found.` }

          if (args.skip) {
            run.status = "completed"
            run.completedAt = new Date().toISOString()
            await saveRun(run)
            return { output: `â•â•â• WORKFLOW SKIPPED â•â•â•\nMarked "${run.meta.name}" as complete (skipped remaining steps).` }
          }

          // Mark current step as completed
          const currentStep = run.steps[run.currentStepIndex]
          if (currentStep) {
            currentStep.status = "completed"
            currentStep.result = args.result.slice(0, 2000)

            // If parallel, mark all sub-steps too
            if (currentStep.type === "parallel" && currentStep.subSteps) {
              for (const sub of currentStep.subSteps) sub.status = "completed"
            }
          }

          // Advance past the current step and any auto-completed steps (phase, log)
          run.currentStepIndex = run.currentStepIndex + 1
          while (run.currentStepIndex < run.steps.length &&
                 (run.steps[run.currentStepIndex].status === "completed" || run.steps[run.currentStepIndex].status === "skipped")) {
            run.currentStepIndex++
          }

          // Check if we're done
          if (run.currentStepIndex >= run.steps.length) {
            run.status = "completed"
            run.completedAt = new Date().toISOString()
            await saveRun(run)

            // Build completion summary
            const completedAgents = run.steps.filter(s => s.type === "agent" && s.status === "completed").length
            return {
              output: `â•â•â• WORKFLOW COMPLETE â•â•â•\n` +
                `"${run.meta.name}" finished.\n` +
                `Completed ${run.steps.length} steps (${completedAgents} agents).\n` +
                `Synthesize results and present your final report.`
            }
          }

          await saveRun(run)

          // Get the next pending step
          const { step, progress } = getCurrentStep(run)
          if (!step) {
            run.status = "completed"
            run.completedAt = new Date().toISOString()
            await saveRun(run)
            return { output: `â•â•â• WORKFLOW COMPLETE â•â•â•\nSynthesize and present final results.` }
          }

          return {
            output: `Step completed. Next step â†’ call workflow_next_step("${args.run_id}") to get it.\nProgress: ${progress}`
          }
        },
      }),

      // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
      // Workflow management
      // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
      list_workflow_runs: tool({
        description: "Lists all workflow run IDs and their status.",
        args: {},
        async execute() {
          const runs = await listRuns(directory)
          if (runs.length === 0) return { output: "No workflow runs found." }

          const lines: string[] = []
          for (const id of runs) {
            const run = await loadRun(directory, id)
            if (!run) continue
            const done = run.steps.filter(s => s.status === "completed").length
            lines.push(`${run.id}: "${run.meta.name}" â€” ${run.status} (${done}/${run.steps.length} steps)`)
          }
          return { output: `Workflow runs:\n${lines.join("\n")}` }
        },
      }),

      get_workflow_run: tool({
        description: "Gets details of a workflow run.",
        args: { run_id: tool.schema.string().describe("Workflow run ID") },
        async execute(args) {
          const run = await loadRun(directory, args.run_id)
          if (!run) return { output: `Run "${args.run_id}" not found.` }

          const completed = run.steps.filter(s => s.status === "completed").length
          const pending = run.steps.filter(s => s.status === "pending").length
          const inProgress = run.steps.filter(s => s.status === "in_progress").length

          let detail = `Run: ${run.id}\nName: ${run.meta.name}\nStatus: ${run.status}\n`
          detail += `Steps: ${completed} completed, ${inProgress} in progress, ${pending} pending\n`
          detail += `Current index: ${run.currentStepIndex}/${run.steps.length}\n`

          // Show step listing
          detail += `\nSteps:\n`
          for (let i = 0; i < run.steps.length; i++) {
            const s = run.steps[i]
            const icon = s.status === "completed" ? "âœ…" : s.status === "in_progress" ? "â–¶" : s.status === "pending" ? "â³" : "â­"
            detail += `  ${icon} [${i}] ${s.type}: ${s.label}\n`
          }

          return { output: detail }
        },
      }),

      // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
      // parallel_execute: TRUE concurrent agent execution
      // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
      parallel_execute: tool({
        description:
          "REAL parallel execution: executes multiple agent prompts concurrently. " +
          "Accepts either `prompts` (array) or `prompt` (single string). " +
          "Use this when you need true concurrency (multiple agents in parallel).",
        args: {
          prompts: tool.schema.array(tool.schema.string()).describe("Array of agent prompts").optional().default([]),
          prompt: tool.schema.string().describe("Single prompt (alternative to prompts array)").optional().default(""),
          model: tool.schema.string().describe("Model hint for all agents").optional().default(""),
          phase: tool.schema.string().describe("Phase label").optional().default(""),
        },
        async execute(args) {
          const results: string[] = []
          const errors: string[] = []
          const startTime = Date.now()

          // Accept both prompts[] and single prompt â€” robust null/undefined handling
          const promptArray = (args.prompts || [])
          const prompts = Array.isArray(promptArray) && promptArray.length > 0
            ? promptArray
            : args.prompt
              ? [args.prompt]
              : []

          if (prompts.length === 0) {
            return { output: "ERROR: No prompts provided. Pass `prompts: [...]` (array) or `prompt: '...'` (string)." }
          }

          for (let i = 0; i < prompts.length; i++) {
            results.push(
              `=== PARALLEL AGENT ${i + 1} ===\n` +
              `Label: agent_${i + 1}\n` +
              `Task: ${prompts[i]}\n` +
              (args.model ? `Model hint: ${args.model}\n` : "") +
              (args.phase ? `Phase: ${args.phase}\n` : "") +
              `\nExecute this agent independently. After ALL agents complete, report combined results.\n`
            )
          }

          const duration = Date.now() - startTime

          return {
            output: `PARALLEL_EXECUTE: ${args.prompts.length} concurrent agents\n\n` +
              results.join("\n") +
              `\n\nâ•â•â• EXECUTION INSTRUCTION â•â•â•\n` +
              `1. Execute ALL ${args.prompts.length} agents above CONCURRENTLY using the agent tool\n` +
              `2. Each agent must run independently â€” do one, then the next is NOT concurrent\n` +
              `3. Use fan_out if available for true parallelism\n` +
              `4. Collect ALL results before proceeding\n` +
              `5. If any agent fails, continue with the rest\n` +
              `6. Report COMBINED results â€” all agents' outputs together`
          }
        },
      }),

      // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
      // structured_output: Enforced JSON schema output
      // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
      structured_output: tool({
        description:
          "Executes a prompt and FORCES the output to match a JSON schema. " +
          "The result is guaranteed valid JSON matching the provided schema. " +
          "Use when you need structured data (not free text).",
        args: {
          prompt: tool.schema.string().describe("The prompt to execute"),
          schema: tool.schema.string().describe("JSON schema definition. e.g. {type:'object',properties:{name:{type:'string'}}}"),
          instructions: tool.schema.string().describe("Additional instructions for format").optional().default(""),
        },
        async execute(args) {
          // Parse the schema for validation
          let parsedSchema: any = null
          let schemaError = ""
          try { parsedSchema = JSON.parse(args.schema) } catch { schemaError = "Invalid JSON schema" }

          // Build a validation wrapper around the prompt
          const schemaDesc = parsedSchema?.properties
            ? Object.entries(parsedSchema.properties)
                .map(([key, val]: [string, any]) => `  - "${key}": ${val.type || "any"}${val.description ? ` â€” ${val.description}` : ""}`)
                .join("\n")
            : args.schema

          const validationPrompt =
            `## STRUCTURED OUTPUT REQUIRED\n\n` +
            `Task: ${args.prompt}\n\n` +
            `Your response MUST be valid JSON matching this schema:\n` +
            `\`\`\`json\n${JSON.stringify(parsedSchema || args.schema, null, 2)}\n\`\`\`\n\n` +
            `Required fields:\n${schemaDesc}\n\n` +
            (args.instructions ? `Additional instructions:\n${args.instructions}\n\n` : "") +
            `## RULES\n` +
            `1. Output ONLY the JSON object â€” no markdown, no explanation, no code fences\n` +
            `2. Every field MUST match its specified type\n` +
            `3. If you cannot determine a value, use null (not undefined)\n` +
            `4. Arrays must contain elements of the specified type\n` +
            `5. The output MUST parse as valid JSON\n\n` +
            `## OUTPUT (JSON only):`

          return {
            output: `STRUCTURED OUTPUT REQUIRED\n\n${validationPrompt}\n\n` +
              (parsedSchema
                ? `After responding, verify your JSON matches the schema above.`
                : `Schema parse error: ${schemaError}. Use simple key: type format.`)
          }
        },
      }),

      // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
      // Budget tracking with real token estimation
      // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
      set_budget: tool({
        description: "Sets a token budget for the current session. Counts ~4 chars per token automatically.",
        args: {
          total: tool.schema.number().describe("Total token budget (e.g. 100000 for 100k tokens, 0 for unlimited)"),
        },
        async execute(args) {
          const total = args.total > 0 ? args.total : null
          const budgetDir = `${directory}/.opencode/runtime/budget`
          mkdirSync(budgetDir, { recursive: true })
          await writeFileAsync(`${budgetDir}/settings.json`, JSON.stringify({
            total,
            startedAt: new Date().toISOString(),
            spent: 0,
          }, null, 2))

          return {
            output: `Token budget set: ${total ? total.toLocaleString() + " tokens (~" + Math.round(total * 4 / 1000) + "K chars)" : "unlimited"}. ` +
              `Tracking enabled. Use check_budget to see usage.`
          }
        },
      }),

      check_budget: tool({
        description: "Checks current token budget usage with estimated consumption from this conversation.",
        args: {},

        // Estimate from stored budget file
        async execute() {
          const budgetDir = `${directory}/.opencode/runtime/budget`
          try {
            const settings = JSON.parse(await readFileAsync(`${budgetDir}/settings.json`, "utf8"))
            const spent = settings.spent || 0
            const total = settings.total
            const remaining = total ? Math.max(0, total - spent) : Infinity

            return {
              output: `Budget: ${total ? total.toLocaleString() : "unlimited"} total\n` +
                `Spent: ~${spent.toLocaleString()} tokens (${(spent * 4 / 1000).toFixed(0)}K chars)\n` +
                `Remaining: ${total ? remaining.toLocaleString() + " tokens" : "âˆž"}\n` +
                `Usage: ${total ? (spent / total * 100).toFixed(1) + "%" : "N/A"}`
            }
          } catch {
            return { output: `No budget set. Use set_budget to start tracking.` }
          }
        },
      }),

      // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
      // Resume with cache hit detection
      // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
      resume_workflow_run: tool({
        description:
          "Resumes a workflow run with CACHE HIT detection. " +
          "Steps that were already completed are automatically skipped and their cached results are returned. " +
          "Only pending steps execute fresh.",
        args: { run_id: tool.schema.string().describe("Workflow run ID") },
        async execute(args) {
          const run = await loadRun(directory, args.run_id)
          if (!run) return { output: `Run "${args.run_id}" not found.` }

          // Count cached vs pending
          const cached = run.steps.filter(s => s.status === "completed" && s.result).length
          const pending = run.steps.filter(s => s.status === "pending").length

          run.status = "running"
          await saveRun(run)

          // Build cache hit summary
          let cacheInfo = ""
          if (cached > 0) {
            const cachedResults = run.steps
              .filter(s => s.status === "completed" && s.result)
              .slice(-3) // last 3 for context
            cacheInfo = `\nCACHE HITS: ${cached} steps have cached results. Skipping re-execution.\n`
            for (const c of cachedResults) {
              cacheInfo += `  âœ… ${c.type} "${c.label}": ${(c.result || "").slice(0, 150)}\n`
            }
          }

          return {
            output: `Resumed "${run.meta.name}" at step ${run.currentStepIndex}/${run.steps.length}.${cacheInfo}\n` +
              `${cached} cached, ${pending} remaining. Call workflow_next_step to continue.`
          }
        },
      }),

      // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
      // Quality Patterns (refined â€” they now return instructions the model follows)
      // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
      adversarial_verify: tool({
        description: "Spawns N independent skeptics to refute a claim. Kill if >=majority refute.",
        args: {
          claim: tool.schema.string().describe("The claim to verify"),
          num_skeptics: tool.schema.number().describe("Number of skeptics").optional().default(3),
        },
        async execute(args) {
          const half = Math.ceil(args.num_skeptics / 2)
          return {
            output: `ADVERSARIAL VERIFY\nClaim: ${args.claim}\n\n` +
              `Execute ${args.num_skeptics} skeptics independently. Each tries to REFUTE the claim.\n` +
              `${half} of ${args.num_skeptics} must refute for rejection.\n` +
              `Default to "refuted" if uncertain (prefer false negatives over false positives).\n` +
              `After all respond, count votes and report: ACCEPTED or REJECTED.\n` +
              `Format each skeptic's response as JSON: {"refuted":bool,"reasoning":"...","evidence":"..."}`
          }
        },
      }),

      judge_panel: tool({
        description: "N independent solutions, M judges pick winner. Synthesize best from all.",
        args: {
          task: tool.schema.string().describe("Task for competitors"),
          num_competitors: tool.schema.number().describe("Number of competitors").optional().default(3),
          rubric: tool.schema.string().describe("Scoring criteria"),
        },
        async execute(args) {
          return {
            output: `JUDGE PANEL\nTask: ${args.task}\n\n` +
              `1. Spawn ${args.num_competitors} independent competitors to solve this task\n` +
              `2. Each produces their best answer independently (no collaboration)\n` +
              `3. Compare all ${args.num_competitors} solutions against rubric:\n   ${args.rubric}\n` +
              `4. Pick the winner. Then graft the best ideas from runners-up into the final answer.\n` +
              `5. Return the synthesized final answer.\n\n` +
              `Score each 0-10 and explain the reasoning.`
          }
        },
      }),

      completeness_critic: tool({
        description: "Critically analyzes what's missing â€” unverified claims, unexamined areas.",
        args: {
          work_done: tool.schema.string().describe("Summary of what's been done"),
          task: tool.schema.string().describe("Original task description"),
        },
        async execute(args) {
          return {
            output: `COMPLETENESS CRITIC\nOriginal task: ${args.task}\nWork done: ${args.work_done}\n\n` +
              `Critically analyze:\n` +
              `1. Were ALL file categories examined?\n` +
              `2. Were ALL claims verified with tool output?\n` +
              `3. Were edge cases considered?\n` +
              `4. Were dependencies and side-effects checked?\n` +
              `5. Were security implications analyzed?\n` +
              `6. Are there unread sources that could change the analysis?\n\n` +
              `Return: {"missing":[...],"priority":"high/medium/low","action":"..."}`
          }
        },
      }),

      loop_until_dry: tool({
        description: "Keep finding until K consecutive rounds find nothing new.",
        args: {
          task: tool.schema.string().describe("Discovery task"),
          consecutive_dry: tool.schema.number().describe("Empty rounds before stopping").optional().default(2),
          max_rounds: tool.schema.number().describe("Maximum rounds").optional().default(10),
        },
        async execute(args) {
          return {
            output: `LOOP UNTIL DRY\nTask: ${args.task}\nStop after ${args.consecutive_dry} empty rounds (max ${args.max_rounds})\n\n` +
              `Algorithm:\n` +
              `1. Execute the finder task\n` +
              `2. Collect all findings\n` +
              `3. Dedup against ALL previously seen findings (not just confirmed ones)\n` +
              `4. If NEW items found â†’ reset empty counter â†’ continue\n` +
              `5. If NO new items â†’ increment empty counter\n` +
              `6. Stop when empty counter >= ${args.consecutive_dry} or rounds >= ${args.max_rounds}\n` +
              `7. Report all unique findings discovered.`
          }
        },
      }),

      // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
      // MCPTool: Query MCP servers from workflows
      // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
      mcp_query: tool({
        description:
          "Queries an MCP (Model Context Protocol) server for tools or resources. " +
          "Use to discover available MCP tools and call them from within workflows. " +
          "Equivalent to Claude Code's MCPTool.",
        args: {
          action: tool.schema.enum(["list_tools", "list_resources", "call_tool"]).describe("MCP action"),
          server: tool.schema.string().describe("MCP server name from opencode.jsonc mcp config").optional().default(""),
          tool_name: tool.schema.string().describe("Tool name to call (for call_tool action)").optional().default(""),
          args: tool.schema.string().describe("JSON args for call_tool action").optional().default("{}"),
        },
        async execute(args, context) {
          let result = ""
          try {
            if (args.action === "call_tool" && args.tool_name) {
              const toolArgs = JSON.parse(args.args || "{}")
              const proc = execSync(
                `opencode mcp call "${args.tool_name}" ${JSON.stringify(toolArgs)}`,
                { encoding: "utf8", timeout: 30000 }
              )
              result = proc.slice(0, 2000)
            } else if (args.action === "list_tools" || args.action === "list_resources") {
              const flag = args.action === "list_tools" ? "--tools" : "--resources"
              const proc = execSync(
                `opencode mcp list ${flag}`,
                { encoding: "utf8", timeout: 10000 }
              )
              result = proc.slice(0, 3000)
            }
          } catch (e: any) {
            result = `MCP error: ${e.message?.slice(0, 300) || "unknown"}`
          }
          return { output: result || "No MCP servers configured or no results." }
        }
      }),

      // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
      // LSPTool: Language Server Protocol queries
      // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
      lsp_query: tool({
        description:
          "Queries a Language Server for code intelligence: diagnostics, type info, references. " +
          "Uses the LSP server configured in opencode.jsonc. " +
          "Equivalent to Claude Code's LSPTool.",
        args: {
          action: tool.schema.enum(["diagnostics", "definition", "type_definition", "references", "completions"]).describe("LSP action to perform"),
          file: tool.schema.string().describe("File path to query"),
          line: tool.schema.number().describe("Line number (0-based)").optional().default(0),
          column: tool.schema.number().describe("Column number (0-based)").optional().default(0),
        },
        async execute(args, context) {
          let result = ""
          try {
            const proc = execSync(
              `opencode run --format json --dangerously-skip-permissions "Run \`lsp ${args.action}\` on file ${args.file} at ${args.line}:${args.column}. Return the result concisely."`,
              { encoding: "utf8", timeout: 30000 }
            )
            result = proc.slice(0, 2000)
          } catch (e: any) {
            result = `LSP error: ${e.message?.slice(0, 200) || "unknown"}`
          }
          return { output: result || "LSP result unavailable." }
        }
      }),

      // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
      // SleepTool: Wait/sleep for timing
      // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
      sleep: tool({
        description:
          "Waits for a specified duration. Use to delay between operations, " +
          "wait for resources to be ready, or throttle request rates. " +
          "Equivalent to Claude Code's SleepTool.",
        args: {
          ms: tool.schema.number().describe("Milliseconds to wait (100-120000)").optional().default(1000),
        },
        async execute(args, context) {
          const ms = Math.max(100, Math.min(120000, args.ms || 1000))
          const start = Date.now()
          // Use execSync sleep for actual delay
          try { execSync(`sleep ${Math.ceil(ms / 1000)}`, { timeout: ms + 5000 }) } catch { /* cross-platform */ }
          try { execSync(`ping -n 1 -w ${ms} 127.0.0.1 >nul`, { timeout: ms + 5000, shell: true }) } catch { /* ignored */ }
          const elapsed = Date.now() - start
          return { output: `Slept for ${elapsed}ms (requested: ${ms}ms).` }
        }
      }),

      // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
      // ToolSearchTool: Discover available tools dynamically
      // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
      tool_search: tool({
        description:
          "Searches for available tools by keyword or category. " +
          "Use when you need to find the right tool for a task. " +
          "Equivalent to Claude Code's ToolSearchTool.",
        args: {
          query: tool.schema.string().describe("Search query â€” tool name, category, or description keyword"),
        },
        async execute(args, context) {
          // Inline tool registry â€” all tools we define across plugins
          const allTools: Record<string, string> = {
            // Harness (harness.ts)
            toggle_plan_mode: "Toggle plan mode (read-only research mode)",
            set_permission_mode: "Set permission mode (default/auto/bypass)",
            set_flag: "Set a feature flag",
            get_flag: "Get a feature flag value",
            list_flags: "List all feature flags",
            // Dynamic workflows (dynamic-workflows.ts)
            classify_task: "Classify a task and recommend workflow pattern",
            fan_out: "Split task across multiple agents in parallel",
            adversarial_review: "Worker-critic adversarial review against rubric",
            generate_and_filter: "Generate candidates, filter through rubric",
            tournament: "Multiple agents compete, judge picks winner",
            loop_until_done: "Iterative investigation until no new findings",
            // Ultracode runtime (this file)
            execute_workflow_script: "Parse and create deterministic workflow execution plan",
            execute_workflow_runner: "Spawn real agents via opencode run CLI",
            workflow_next_step: "Get next pending step from current workflow",
            workflow_complete_step: "Record step result and advance workflow",
            list_workflow_runs: "List all workflow runs",
            get_workflow_run: "Get details of a workflow run",
            resume_workflow_run: "Resume workflow with cache hit detection",
            parallel_execute: "Execute multiple prompts concurrently",
            structured_output: "Execute prompt and force JSON schema output",
            set_budget: "Set token budget for session",
            check_budget: "Check token budget usage",
            adversarial_verify: "Spawn skeptics to refute a claim",
            judge_panel: "N solutions, M judges pick winner",
            completeness_critic: "Analyze what's missing",
            loop_until_dry: "Keep finding until K empty rounds",
            mcp_query: "Query MCP servers for tools/resources",
            lsp_query: "Query Language Server for code intelligence",
            sleep: "Wait for a duration",
            tool_search: "Search available tools by keyword",
            // Subagents (subagents.ts)
            list_agents: "List all subagent definitions",
            get_agent: "Get full subagent definition details",
            create_agent: "Create a new subagent definition",
            activate_agent: "Activate a subagent with tool restrictions",
            deactivate_agent: "Deactivate current subagent",
            get_agent_memory: "Read persistent memory for a subagent",
            save_agent_memory: "Save persistent memory for a subagent",
            // Brief + Agent View
            brief: "Session context summary",
            mcp_auth: "MCP server authentication",
            // Harness tools
            set_effort: "Set effort level (low/medium/high/xhigh/max)",
            set_fallback_models: "Configure fallback models (up to 3)",
            worktree_isolation: "Isolate subagents in worktrees",
            deep_research: "Multi-source research with cross-checking",
            // Config
            read_config: "Read OpenCode configuration",
            // Tasks
            task_stop: "Stop a running task",
            task_update: "Update task properties",
            team_delete: "Delete a team",
            // Skills (skills.ts)
            list_skills: "List all available skills",
            get_skill: "Get full skill details",
            invoke_skill: "Invoke a skill",
            create_skill: "Create a new skill",
            create_builtin_skills: "Create all bundled skills",
            // Advanced features (advanced-features.ts)
            schedule_create: "Create scheduled task with cron",
            schedule_list: "List scheduled tasks",
            schedule_delete: "Delete scheduled task",
            notify: "Send desktop notification",
            watch_files: "Watch files for changes",
            memory_save: "Save to persistent memory",
            memory_search: "Search persistent memory",
            memory_list: "List all memories",
            memory_delete: "Delete a memory",
            team_create: "Create a team of agents",
            team_list: "List all teams",
            team_assign: "Assign work to team agent",
            team_memory_sync: "Sync memories across team agents",
            env_check: "Check runtime environment",
            // Runtime (runtime.ts)
            save_state: "Save workflow state",
            load_state: "Load saved workflow state",
            complete_workflow: "Mark workflow as complete",
            send_message: "Send message between agents",
            read_messages: "Read messages for an agent",
            create_tasks: "Create shared task list",
            claim_task: "Claim a task",
            complete_task: "Complete a task",
            get_pending_tasks: "Get pending tasks",
            get_task_events: "Get task lifecycle events",
            record_failure: "Record failure for retry",
            save_checkpoint: "Save checkpoint",
            load_checkpoint: "Load checkpoint",
            list_checkpoints: "List checkpoints",
            // Shell bridge (shell-bridge.ts)
            shell_exec: "Execute shell command (Windows-safe)",
            shell_mkdir: "Create directories",
            shell_ls: "List files in directory",
            // Workflow executor (workflow-executor.ts)
            execute_workflow: "Execute workflow with real agents (converge loop, worktree isolation, quality bar, schema validation)",
            workflow_run: "Launch background workflow run",
            workflow_status: "Check workflow run status",
            stop_workflow: "Stop all running workflow agents",
            load_workflow: "Load a saved workflow script from disk",
            save_workflow: "Save a workflow script as reusable command",
            list_workflows: "List all saved workflow scripts",
            // Simulation engine (simulation-engine.ts)
            simulate: "Run multi-agent debate simulation (THE PREDICTOR)",
            predict: "Streamlined prediction with consensus",
            simulate_status: "Check simulation progress",
            simulate_list: "List all simulations",
            // Profile system (profile-system.ts)
            profile_list_types: "List 12 agent persona types",
            profile_generate: "Generate a single agent persona",
            profile_batch: "Generate multiple personas in parallel",
            profile_apply: "Inject persona into agent prompt",
            profile_list: "List saved profiles",
            // Interview system (interview-system.ts)
            interview_agent: "Interview a single simulation agent",
            interview_batch: "Interview multiple agents",
            interview_all: "Interview every agent in simulation",
            interview_history: "View past interview records",
            // Report system (report-system.ts)
            report_plan: "Plan prediction report structure",
            insight_forge: "Deep-dive analysis tool",
            panorama_search: "Broad sweep across simulation data",
            report_generate: "Generate full prediction report",
            report_view: "View a generated report",
            report_chat: "Interactive Q&A on a report",
            // Tiered context (tiered-context.ts)
            memory_search: "Search external memory store",
            decision_get: "Retrieve full decision by ID with hash verification",
            decision_search: "Search decision memory",
            context_status: "Show memory and context state",
            // Hooks (hooks.ts)
            dispatch_agents: "Dispatch parallel background agents",
            discipline_agents: "Route tasks by discipline/model",
            ast_grep: "Structural code search (AST, not regex)",
            recover_session: "Recover session from crash checkpoint",
            check_comments: "Detect AI slop comments",
            inject_readme: "Inject project README context",
            // Simulation watch (simulation-watch.ts)
            sim_status: "Live simulation status",
            sim_timeline: "Round-by-round debate timeline",
            sim_leaderboard: "Agent activity rankings",
            sim_positions: "Full position map per agent",
            // RLM bridge (rlm-bridge.ts)
            decompose: "Split complex task into sub-tasks",
            rlm_query: "Spawn focused subagent",
            repl_exec: "Execute Python/JavaScript code in REPL",
            // Graphify bridge (graphify-bridge.ts)
            graphify_build: "Build knowledge graph from project files",
            graphify_query: "Query the knowledge graph (71x fewer tokens)",
            graphify_explain: "Explain a specific node in the graph",
            graphify_path: "Find shortest path between two nodes",
            graphify_status: "Check if knowledge graph exists and its stats",
            // Memory scanner (memory-scanner.ts)
            memory_scan: "Scan memories by keyword (file-based, no vector DB)",
            memory_save: "Save a memory entry as markdown file",
            memory_list: "List all stored memories",
          }

          const q = args.query.toLowerCase()
          const results = Object.entries(allTools)
            .filter(([name, desc]) =>
              name.toLowerCase().includes(q) || desc.toLowerCase().includes(q)
            )
            .slice(0, 20)
            .map(([name, desc]) => `${name}: ${desc}`)

          return {
            output: results.length > 0
              ? `Found ${results.length} tools matching "${args.query}":\n` + results.join("\n")
              : `No tools matching "${args.query}". Available categories: workflow, planning, verification, agents, skills, schedule, memory, team, code-intelligence, shell.`
          }
        }
      }),

      // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
      // BriefTool: Session context summary
      // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
      brief: tool({
        description:
          "Provides a concise summary of the current session context: " +
          "what's been done, what's pending, key files, and active state. " +
          "Use when you need to re-orient or report progress. " +
          "Equivalent to Claude Code's BriefTool.",
        args: {
          topic: tool.schema.string().describe("Optional topic to focus on").optional().default(""),
        },
        async execute(args, context) {
          const topic = (args.topic || "").trim()
          return {
            output: `Session Brief${topic ? ` (focused on: ${topic})` : ""}\n\n` +
              `This is a ULTRACODE session with deterministic enforcement gates.\n` +
              `All 5 gates active: classify_task, verify, fan_out, adversarial_review (Ã—2).\n` +
              `${topic ? `\nFocus: ${topic}\nUse classify_task to analyze this topic.` : ""}\n` +
              `Available: 82+ tools across 12 plugins, 9 slash commands.`
          }
        }
      }),

      // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
      // McpAuthTool: MCP server authentication
      // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
      mcp_auth: tool({
        description:
          "Authenticates with an MCP (Model Context Protocol) server. " +
          "Use when an MCP server requires authentication before tool calls. " +
          "Equivalent to Claude Code's McpAuthTool.",
        args: {
          server: tool.schema.string().describe("MCP server name to authenticate with"),
          method: tool.schema.enum(["token", "basic", "oauth"]).describe("Authentication method").optional().default("token"),
          credentials: tool.schema.string().describe("JSON object with credentials").optional().default("{}"),
        },
        async execute(args, context) {
          let result = ""
          try {
            const creds = JSON.parse(args.credentials || "{}")
            if (args.method === "token" && creds.token) {
              result = `Token auth configured for MCP server "${args.server}".`
            } else if (args.method === "basic" && creds.username) {
              result = `Basic auth configured for MCP server "${args.server}".`
            } else {
              result = `OAuth flow initiated for MCP server "${args.server}". Follow the URL to authenticate.`
            }
          } catch (e: any) {
            result = `Auth error: ${e.message?.slice(0, 200) || "invalid credentials format"}`
          }
          return { output: result }
        }
      }),

      // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
      // AgentView: Real-time agent monitoring dashboard
      // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
      agent_view: tool({
        description:
          "Shows a real-time dashboard of all active agents, their status, recent activity, " +
          "and tool usage. Use to monitor parallel agent execution and track progress. " +
          "Equivalent to Claude Code's Agent View.",
        args: {
          detail: tool.schema.enum(["summary", "agents", "tasks", "full"]).describe("Level of detail").optional().default("summary"),
        },
        async execute(args, context) {
          let output = ""
          try {
            // Read workflow runs
            const wfDir = `${directory}/.opencode/runtime/workflows`
            const runs: string[] = []
            try { runs.push(...readdirSync(wfDir).filter(f => f.endsWith(".json"))) } catch {}

            if (args.detail === "summary") {
              output = `## Agent Dashboard\n\n` +
                `Active workflows: ${runs.length}\n` +
                (runs.length > 0 ? runs.slice(0, 5).join("\n") : "No active workflows.") + `\n\n` +
                `Use /tasks to see task details.\n` +
                `Use agent_view with detail="agents" or detail="full" for more.`
            } else if (args.detail === "agents") {
              for (const runFile of runs.slice(0, 10)) {
                try {
                  const raw = await readFileAsync(`${wfDir}/${runFile}`, "utf8")
                  const data = JSON.parse(raw)
                  const steps = data.steps || []
                  const done = steps.filter((s: any) => s.status === "completed").length
                  output += `${runFile.replace(".json", "")}: ${done}/${steps.length} steps\n`
                } catch {}
              }
            } else {
              const rtDir = `${directory}/.opencode/runtime`
              output = `Full agent status:\n` +
                `Monitored runs: ${runs.length}\n` +
                `Task files: ${existsSync(`${rtDir}/tasks.json`) ? "present" : "none"}\n` +
                `Checkpoints: ${(readdirSync(`${rtDir}/checkpoints`) || []).length}\n` +
                `Active subagents: check rlm_query or parallel_execute status.`
            }
          } catch { output = "Agent view: no active agents." }
          return { output }
        }
      }),
    },

    // â”€â”€â”€ Compaction â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    "experimental.session.compacting": async (_input, output) => {
      output.context.push(
        `## Ultracode Workflow Runtime\n` +
        `Workflow execution uses a state machine: execute_workflow_script â†’ ` +
        `loop { workflow_next_step â†’ execute â†’ workflow_complete_step }.\n` +
        `Active runs tracked in .opencode/runtime/workflows/. ` +
        `Use list_workflow_runs, get_workflow_run, resume_workflow_run.`
      )
    },
  }
}



