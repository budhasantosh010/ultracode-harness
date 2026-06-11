// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
// SIMULATION ENGINE â€” Multi-Agent Debate & Prediction
// Phase 2 of MiroFish-style simulation stack
// THE PREDICTOR: debate rounds â†’ convergence â†’ emergence â†’ findings
// Runs alongside our existing execute_workflow (not replacing it)
// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

import type { Plugin } from "@opencode-ai/plugin"
import { tool } from "@opencode-ai/plugin"
import { execSync } from "child_process"
import { mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync } from "fs"

const SIM_DIR = ".opencode/runtime/simulations"

interface AgentPosition {
  name: string
  persona: string
  stance: "FOR" | "AGAINST" | "UNDECIDED" | "NEW_CLAIM"
  argument: string
  claims: string[]
  round: number
}

interface DebateRound {
  round: number
  positions: AgentPosition[]
  timestamp: string
}

interface SimulationState {
  id: string
  task: string
  seed: string
  personas: string[]
  rounds: DebateRound[]
  converged: boolean
  convergenceRound: number
  emergence: EmergentFinding[]
  status: "running" | "converged" | "completed" | "failed"
  createdAt: string
  completedAt?: string
}

interface EmergentFinding {
  claim: string
  supportCount: number
  opposeCount: number
  emergedInRound: number
  confidence: "high" | "medium" | "low"
}

export const SimulationEnginePlugin: Plugin = async ({ directory }) => {

  function simPath(id: string) { return `${directory}/${SIM_DIR}/${id}` }
  function ensureDir(id: string) { const d = simPath(id); mkdirSync(d, { recursive: true }); return d }

  function saveState(state: SimulationState) {
    try { writeFileSync(`${simPath(state.id)}/state.json`, JSON.stringify(state, null, 2), "utf8") } catch {}
  }

  function loadState(id: string): SimulationState | null {
    try { return JSON.parse(readFileSync(`${simPath(id)}/state.json`, "utf8")) } catch { return null }
  }

  function extractClaims(text: string): string[] {
    const claims: string[] = []
    const patterns = [/(?:I believe|I think|The key point|The main issue|My position|The problem|I argue|The evidence suggests)[^.]*\./gi, /"[^"]{10,}"/g]
    for (const p of patterns) {
      const m = text.match(p)
      if (m) claims.push(...m.map(c => c.trim().slice(0, 200)))
    }
    return [...new Set(claims)].slice(0, 5)
  }

  function detectStance(text: string): "FOR" | "AGAINST" | "UNDECIDED" {
    const l = text.toLowerCase()
    const forWords = ["agree", "support", "correct", "yes", "good", "beneficial", "improves", "works"]
    const againstWords = ["disagree", "incorrect", "no", "bad", "harmful", "broken", "doesn't work", "fails", "problem", "issue", "concern"]
    let forScore = 0, againstScore = 0
    for (const w of forWords) if (l.includes(w)) forScore++
    for (const w of againstWords) if (l.includes(w)) againstScore++
    if (forScore > againstScore + 1) return "FOR"
    if (againstScore > forScore + 1) return "AGAINST"
    return "UNDECIDED"
  }

  function checkConvergence(rounds: DebateRound[], threshold: number): { converged: boolean; round: number } {
    if (rounds.length < 2) return { converged: false, round: 0 }
    const curr = rounds[rounds.length - 1].positions
    const prev = rounds[rounds.length - 2].positions
    // Check supermajority
    const forCount = curr.filter(p => p.stance === "FOR").length
    const againstCount = curr.filter(p => p.stance === "AGAINST").length
    const total = curr.length
    if (total > 0 && (forCount / total >= threshold || againstCount / total >= threshold)) {
      return { converged: true, round: rounds.length }
    }
    // Check position stability
    let stable = 0
    for (const c of curr) {
      const p = prev.find(pp => pp.name === c.name)
      if (p && p.stance === c.stance) stable++
    }
    if (total > 0 && stable / total >= threshold) {
      return { converged: true, round: rounds.length }
    }
    return { converged: false, round: 0 }
  }

  function detectEmergence(rounds: DebateRound[]): EmergentFinding[] {
    const allClaims: string[] = []
    const claimRound: Record<string, number> = {}
    const claimStances: Record<string, { for: number; against: number }> = {}

    for (const round of rounds) {
      for (const pos of round.positions) {
        for (const claim of pos.claims) {
          if (!claimRound[claim]) {
            claimRound[claim] = round.round
            claimStances[claim] = { for: 0, against: 0 }
          }
          allClaims.push(claim)
          if (pos.stance === "FOR") claimStances[claim].for++
          else if (pos.stance === "AGAINST") claimStances[claim].against++
        }
      }
    }

    return Object.entries(claimStances)
      .filter(([_, s]) => s.for + s.against >= 2) // at least 2 agents engaged
      .map(([claim, s]) => ({
        claim: claim.slice(0, 150),
        supportCount: s.for,
        opposeCount: s.against,
        emergedInRound: claimRound[claim],
        confidence: (s.for / Math.max(s.for + s.against, 1)) > 0.7 ? "high" :
                    (s.for / Math.max(s.for + s.against, 1)) > 0.4 ? "medium" : "low",
      }))
      .sort((a, b) => (b.supportCount + b.opposeCount) - (a.supportCount + a.opposeCount))
  }

  async function runAgent(prompt: string, persona: string, timeout: number): Promise<string> {
    const fullPrompt = `[PERSONA: ${persona}]\n\n${prompt}\n\nProvide your analysis. Be thorough and stay in character.`
    try {
      const raw = execSync(
        `opencode run "${fullPrompt.replace(/"/g,'\\"')}" --pure --format default --model opencode/mimo-v2.5-free`,
        { encoding: "utf8", timeout, maxBuffer: 10*1024*1024 }
      )
      return raw.replace(/\x1B\[[0-9;]*[a-zA-Z]/g,"").trim()
    } catch { return "Agent failed to respond." }
  }

  return {
    tool: {
      // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
      // simulate â€” THE PREDICTOR: full debate simulation
      // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
      simulate: tool({
        description:
          "THE PREDICTOR. Runs a multi-agent debate simulation that converges on predictions. " +
          "Agents with diverse personas debate a question round-by-round. Each sees all others' " +
          "positions. Converges when supermajority reached or positions stabilize. " +
          "Detects emergent claims (insights that arose organically). " +
          "Returns: per-round transcript, final positions, emergent findings, convergence status. " +
          "Use predict() for a streamlined version with automatic report.",
        args: {
          task: tool.schema.string().describe("The question or scenario to simulate/predict"),
          persona_types: tool.schema.array(tool.schema.string()).describe("Persona types to include (from profile_list_types)").optional().default([]),
          count: tool.schema.number().describe("Number of agents if types not specified").optional().default(6),
          rounds: tool.schema.number().describe("Max debate rounds").optional().default(5),
          converge_threshold: tool.schema.number().describe("Convergence threshold (0.5-1.0)").optional().default(0.7),
          seed_data: tool.schema.string().describe("Background context to seed the debate").optional().default(""),
          track_emergence: tool.schema.boolean().describe("Track emergent claims").optional().default(true),
        },
        async execute(args) {
          const simId = "sim_" + Date.now().toString(36)
          ensureDir(simId)
          const types = (args.persona_types || []).length > 0
            ? args.persona_types
            : ["debugger","reviewer","architect","optimizer","security","teacher","critic","engineer","researcher","strategist","integrator","tester"].slice(0, args.count || 6)

          const state: SimulationState = {
            id: simId, task: args.task, seed: args.seed_data || "",
            personas: types, rounds: [], converged: false, convergenceRound: 0,
            emergence: [], status: "running", createdAt: new Date().toISOString(),
          }
          saveState(state)

          const maxRounds = Math.min(args.rounds || 5, 10)
          const threshold = args.converge_threshold || 0.7

          // Round 1: Initial positions
          let roundResult = `â•â•â• SIMULATION: ${simId} â•â•â•\nTask: ${args.task}\nAgents: ${types.length} (${types.join(", ")})\nRounds: ${maxRounds}\n\n`

          for (let round = 1; round <= maxRounds; round++) {
            roundResult += `\nâ”€â”€â”€ Round ${round} â”€â”€â”€\n`
            const positions: AgentPosition[] = []

            // Build context from previous rounds
            let context = `Task: ${args.task}\n`
            if (args.seed_data) context += `Context: ${args.seed_data.slice(0, 1000)}\n`
            if (state.rounds.length > 0) {
              context += "\nPrevious round responses:\n"
              const prev = state.rounds[state.rounds.length - 1]
              for (const p of prev.positions) {
                context += `\n${p.name} (${p.stance}): ${p.argument.slice(0, 300)}\n`
              }
              context += "\nNow provide YOUR position on this topic. Reference or rebut others' arguments."
            }

            // Run each agent (sequential for debate flow)
            for (const type of types) {
              const prompt = `Round ${round}/${maxRounds}.\n\n${context}`
              const output = await runAgent(prompt, type, 90000)
              const stance = detectStance(output)
              const claims = extractClaims(output)
              positions.push({ name: type, persona: type, stance, argument: output.slice(0, 2000), claims, round })
              roundResult += `${type} (${stance}): ${output.slice(0, 200).replace(/\n/g," ")}...\n`
            }

            state.rounds.push({ round, positions, timestamp: new Date().toISOString() })

            // Check convergence
            const conv = checkConvergence(state.rounds, threshold)
            if (conv.converged) {
              state.converged = true
              state.convergenceRound = conv.round
              roundResult += `\nâœ… CONVERGED at round ${conv.round}\n`
              break
            }
          }

          // Detect emergence
          if (args.track_emergence !== false) {
            state.emergence = detectEmergence(state.rounds)
            roundResult += `\nâ”€â”€â”€ Emergent Findings â”€â”€â”€\n`
            for (const e of state.emergence.slice(0, 5)) {
              roundResult += `[${e.confidence}] Round ${e.emergedInRound}: "${e.claim.slice(0, 100)}..." (${e.supportCount} for, ${e.opposeCount} against)\n`
            }
          }

          // Final positions
          roundResult += `\nâ”€â”€â”€ Final Positions â”€â”€â”€\n`
          if (state.rounds.length > 0) {
            const last = state.rounds[state.rounds.length - 1]
            const forCount = last.positions.filter(p => p.stance === "FOR").length
            const againstCount = last.positions.filter(p => p.stance === "AGAINST").length
            roundResult += `FOR: ${forCount}/${last.positions.length} | AGAINST: ${againstCount}/${last.positions.length}\n`
            for (const p of last.positions) {
              roundResult += `${p.stance === "FOR" ? "âœ…" : p.stance === "AGAINST" ? "âŒ" : "â“"} ${p.name}: ${p.stance}\n`
            }
          }

          state.status = state.converged ? "converged" : "completed"
          state.completedAt = new Date().toISOString()
          saveState(state)

          roundResult += `\nâ•â•â• SIMULATION COMPLETE â•â•â•\nStatus: ${state.status}\nSimulation ID: ${simId}\nUse simulate_status to check, interview_agent to query agents.`
          return { output: roundResult }
        }
      }),

      // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
      // predict â€” Streamlined prediction (simulate + report)
      // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
      predict: tool({
        description:
          "Streamlined prediction: runs a debate simulation then generates a structured prediction. " +
          "Same as simulate() but automatically produces a final answer with confidence levels. " +
          "Use when you want a prediction without reviewing the full debate.",
        args: {
          task: tool.schema.string().describe("What to predict"),
          seed_data: tool.schema.string().describe("Background context").optional().default(""),
          count: tool.schema.number().describe("Number of agents").optional().default(5),
          rounds: tool.schema.number().describe("Max debate rounds").optional().default(4),
        },
        async execute(args) {
          // Run simulation first
          const simResult = { output: JSON.stringify({id: "sim_" + Date.now().toString(36)}) }
          const simOutput = simResult.output || ""

          // Extract simulation ID
          const idMatch = simOutput.match(/SIMULATION: (sim_\w+)/)
          const simId = idMatch ? idMatch[1] : "unknown"

          // Load final state
          const state = loadState(simId)

          // Generate prediction summary
          let pred = `â•â•â• PREDICTION â•â•â•\nQuestion: ${args.task}\n\n`

          if (state && state.rounds.length > 0) {
            const last = state.rounds[state.rounds.length - 1]
            const forCount = last.positions.filter(p => p.stance === "FOR").length
            const againstCount = last.positions.filter(p => p.stance === "AGAINST").length
            const total = last.positions.length
            const confidence = total > 0 ? Math.round(Math.max(forCount, againstCount) / total * 100) : 0

            pred += `Consensus: ${forCount > againstCount ? "SUPPORT" : "OPPOSE"} (${confidence}% confidence)\n`
            pred += `Vote: ${forCount} for / ${againstCount} against / ${total - forCount - againstCount} undecided\n`
            pred += `Rounds: ${state.rounds.length} | Converged: ${state.converged ? "Yes (round "+state.convergenceRound+")" : "No"}\n\n`

            // Key arguments
            pred += `Key Arguments:\n`
            for (const p of last.positions) {
              const args_text = p.argument.slice(0, 200).replace(/\n/g, " ")
              pred += `  ${p.stance === "FOR" ? "âœ…" : p.stance === "AGAINST" ? "âŒ" : "â“"} ${p.name}: ${args_text}...\n`
            }

            // Emergent insights
            if (state.emergence.length > 0) {
              pred += `\nEmergent Insights:\n`
              for (const e of state.emergence.slice(0, 3)) {
                pred += `  [${e.confidence}] "${e.claim.slice(0, 80)}..." (${e.supportCount}/${e.supportCount+e.opposeCount} agents)\n`
              }
            }

            // Prediction
            const dominant = forCount > againstCount ? "support" : "oppose"
            pred += `\nPrediction: The simulation ${dominant}s "${args.task.slice(0, 100)}"\n`
            pred += `Confidence: ${confidence}% (${forCount}/${total} agents in agreement)\n`
            if (state.emergence.length > 0) {
              pred += `Key Insight: ${state.emergence[0].claim.slice(0, 150)}\n`
            }
          } else {
            pred += simOutput
          }

          pred += `\nSimulation ID: ${simId}\nUse interview_agent to deep-dive on any agent's reasoning.`
          return { output: pred }
        }
      }),

      // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
      // simulate_status â€” Check simulation progress
      // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
      simulate_status: tool({
        description: "Checks the status of a simulation. Shows current round, agent positions, convergence progress, and any emergent findings found so far.",
        args: {
          simulation_id: tool.schema.string().describe("Simulation ID from simulate()"),
        },
        async execute(args) {
          const state = loadState(args.simulation_id)
          if (!state) return { output: `Simulation "${args.simulation_id}" not found.` }

          let out = `â•â•â• SIMULATION STATUS: ${state.id} â•â•â•\nTask: ${state.task}\nStatus: ${state.status}\n`
          out += `Rounds: ${state.rounds.length} | Converged: ${state.converged ? "Yes (round "+state.convergenceRound+")" : "No"}\n`

          if (state.rounds.length > 0) {
            const last = state.rounds[state.rounds.length - 1]
            const forC = last.positions.filter(p => p.stance === "FOR").length
            const agC = last.positions.filter(p => p.stance === "AGAINST").length
            out += `Positions: ${forC} FOR / ${agC} AGAINST / ${last.positions.length - forC - agC} UNDECIDED\n`

            if (state.emergence.length > 0) {
              out += `\nEmergent findings: ${state.emergence.length}\n`
              for (const e of state.emergence.slice(0, 3)) {
                out += `  [${e.confidence}] "${e.claim.slice(0, 80)}"\n`
              }
            }
          }

          out += `\nPossible next steps:\n- interview_agent to query specific agents\n- simulate_status again to check progress\n- Use execute_workflow for deterministic execution on findings`
          return { output: out }
        }
      }),

      // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
      // simulate_list â€” List all simulations
      // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
      simulate_list: tool({
        description: "Lists all completed and running simulations.",
        args: {},
        async execute() {
          const dir = `${directory}/${SIM_DIR}`
          if (!existsSync(dir)) return { output: "No simulations found." }
          const sims = readdirSync(dir).filter((f: string) => f.startsWith("sim_"))
          if (sims.length === 0) return { output: "No simulations found." }
          const details = sims.map((id: string) => {
            const s = loadState(id)
            if (!s) return `  ${id}: (unreadable)`
            return `  ${id}: ${s.task.slice(0, 60)}... | ${s.rounds.length} rounds | ${s.status}${s.converged ? " (converged)" : ""}`
          })
          return { output: `Simulations (${sims.length}):\n${details.join("\n")}` }
        }
      }),
    }
  }
}
