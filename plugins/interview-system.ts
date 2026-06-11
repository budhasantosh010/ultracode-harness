// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
// INTERVIEW SYSTEM â€” Post-Simulation Agent Interrogation
// Phase 3 of MiroFish-style simulation stack
// Query any simulation agent, batch interviews, interview all
// No-tools mode for pure reasoning extraction
// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

import type { Plugin } from "@opencode-ai/plugin"
import { tool } from "@opencode-ai/plugin"
import { execSync } from "child_process"
import { mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync } from "fs"

const INTERVIEWS_DIR = ".opencode/runtime/interviews"
const SIM_DIR = ".opencode/runtime/simulations"

export const InterviewSystemPlugin: Plugin = async ({ directory }) => {

  function ensureDir() { const d = `${directory}/${INTERVIEWS_DIR}`; mkdirSync(d, { recursive: true }); return d }

  function loadSimulation(id: string): any {
    try { return JSON.parse(readFileSync(`${directory}/${SIM_DIR}/${id}/state.json`, "utf8")) } catch { return null }
  }

  function getSavedProfiles(): any[] {
    const dir = `${directory}/.opencode/runtime/profiles`
    if (!existsSync(dir)) return []
    try {
      return readdirSync(dir).filter((f: string) => f.endsWith(".json")).map((f: string) => {
        try { return JSON.parse(readFileSync(`${dir}/${f}`, "utf8")) } catch { return null }
      }).filter(Boolean)
    } catch { return [] }
  }

  function recordInterview(simId: string, agent: string, question: string, answer: string, mode: string) {
    const dir = `${ensureDir()}/${simId}`
    mkdirSync(dir, { recursive: true })
    const entry = { timestamp: new Date().toISOString(), agent, question, answer: answer.slice(0, 3000), mode }
    const file = `${dir}/${agent}_${Date.now()}.json`
    writeFileSync(file, JSON.stringify(entry, null, 2), "utf8")
  }

  return {
    tool: {
      // â”€â”€â”€ Interview a single agent â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
      interview_agent: tool({
        description: "Interviews a single agent from a simulation. Agent gets their full debate transcript + persona to answer in character. Records answer for history.",
        args: {
          simulation_id: tool.schema.string().describe("Simulation ID"),
          agent_name: tool.schema.string().describe("Agent name/persona type to interview"),
          question: tool.schema.string().describe("Question to ask the agent"),
          no_tools: tool.schema.boolean().describe("Force pure reasoning (no tool calls)").optional().default(false),
        },
        async execute(args) {
          const sim = loadSimulation(args.simulation_id)
          if (!sim) return { output: `Simulation "${args.simulation_id}" not found.` }

          // Build context from simulation
          let context = `You participated in a debate about: ${sim.task}\n\n`
          context += `Your persona: ${args.agent_name}\n\n`
          context += `Full debate transcript:\n`
          for (const round of sim.rounds || []) {
            context += `\n--- Round ${round.round} ---\n`
            for (const pos of round.positions || []) {
              if (pos.name === args.agent_name) {
                context += `YOU said: ${pos.argument.slice(0, 1000)}\n`
              } else {
                context += `${pos.name} (${pos.stance}): ${pos.argument.slice(0, 300)}\n`
              }
            }
          }

          const noTools = args.no_tools ? "\n\nIMPORTANT: Do NOT use any tools. Respond with pure reasoning only." : ""
          const prompt = `${context}\n\nNow, answer this question as your persona, based on the debate: ${args.question}${noTools}`

          try {
            const raw = execSync(
              `opencode run "${(prompt + "\n\nProvide your answer directly. Stay in character.").replace(/"/g,'\\"')}" --pure --format default`,
              { encoding: "utf8", timeout: 90000, maxBuffer: 10*1024*1024 }
            )
            const out = raw.replace(/\x1B\[[0-9;]*[a-zA-Z]/g,"").trim()
            recordInterview(args.simulation_id, args.agent_name, args.question, out, args.no_tools ? "no-tools" : "standard")
            return { output: `â•â•â• INTERVIEW: ${args.agent_name} â•â•â•\nQuestion: ${args.question}\nMode: ${args.no_tools ? "No-Tools" : "Standard"}\n\n${out.slice(0, 4000)}` }
          } catch (e: any) {
            return { output: `Interview failed: ${e.message?.slice(0, 200)}` }
          }
        }
      }),

      // â”€â”€â”€ Batch interview multiple agents â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
      interview_batch: tool({
        description: "Interviews MULTIPLE agents from a simulation in parallel. Each agent gets full context. Returns all answers grouped.",
        args: {
          simulation_id: tool.schema.string().describe("Simulation ID"),
          agent_names: tool.schema.array(tool.schema.string()).describe("Agents to interview"),
          question: tool.schema.string().describe("Question to ask all agents"),
          no_tools: tool.schema.boolean().describe("Force pure reasoning").optional().default(false),
        },
        async execute(args) {
          const agents = args.agent_names || []
          if (agents.length === 0) return { output: "No agents specified." }

          const results = await Promise.all(agents.map(async (name) => {
            try {
              const r = await this.interview_agent.execute({ simulation_id: args.simulation_id, agent_name: name, question: args.question, no_tools: args.no_tools })
              return `\nâ•â•â•â• ${name} â•â•â•â•\n${(r.output || "").slice(0, 1500)}\n`
            } catch { return `\nâ•â•â•â• ${name} â•â•â•â•\nInterview failed.` }
          }))

          return { output: `â•â•â• BATCH INTERVIEWS (${agents.length}) â•â•â•\nQuestion: ${args.question}\n${results.join("\n")}` }
        }
      }),

      // â”€â”€â”€ Interview ALL agents in simulation â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
      interview_all: tool({
        description: "Interviews EVERY agent in a simulation with the same question. Returns answers grouped by stance (FOR/AGAINST/UNDECIDED).",
        args: {
          simulation_id: tool.schema.string().describe("Simulation ID"),
          question: tool.schema.string().describe("Question to ask all agents"),
          no_tools: tool.schema.boolean().describe("Force pure reasoning").optional().default(false),
        },
        async execute(args) {
          const sim = loadSimulation(args.simulation_id)
          if (!sim) return { output: `Simulation "${args.simulation_id}" not found.` }
          const agents = sim.personas || []
          if (agents.length === 0) return { output: "No agents in this simulation." }

          const results = await Promise.all(agents.map(async (name: string) => {
            try {
              const r = await this.interview_agent.execute({ simulation_id: args.simulation_id, agent_name: name, question: args.question, no_tools: args.no_tools })
              const text = r.output || ""
              const stance = text.includes("disagree") || text.includes("against") ? "AGAINST" : text.includes("agree") || text.includes("support") ? "FOR" : "MIXED"
              return { name, stance, text: text.slice(0, 2000) }
            } catch { return { name, stance: "ERROR", text: "Interview failed." } }
          }))

          const grouped: Record<string, string[]> = { FOR: [], AGAINST: [], MIXED: [], UNDECIDED: [], ERROR: [] }
          for (const r of results) { if (grouped[r.stance]) grouped[r.stance].push(r.name) }

          let out = `â•â•â• ALL INTERVIEWS (${agents.length} agents) â•â•â•\nQuestion: ${args.question}\n\n`
          out += `FOR (${grouped.FOR.length}): ${grouped.FOR.join(", ") || "none"}\n`
          out += `AGAINST (${grouped.AGAINST.length}): ${grouped.AGAINST.join(", ") || "none"}\n`
          out += `MIXED (${grouped.MIXED.length}): ${grouped.MIXED.join(", ") || "none"}\n\n`

          for (const r of results) {
            out += `--- ${r.name} (${r.stance}) ---\n${r.text.slice(0, 600)}\n\n`
          }
          return { output: out.slice(0, 8000) }
        }
      }),

      // â”€â”€â”€ Interview history â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
      interview_history: tool({
        description: "Retrieves past interview records from a simulation. Shows all questions asked and answers given.",
        args: {
          simulation_id: tool.schema.string().describe("Simulation ID").optional().default(""),
          agent_name: tool.schema.string().describe("Filter by agent name").optional().default(""),
        },
        async execute(args) {
          const baseDir = `${directory}/${INTERVIEWS_DIR}`
          if (!existsSync(baseDir)) return { output: "No interviews recorded yet." }

          let simDirs = readdirSync(baseDir)
          if (args.simulation_id) simDirs = simDirs.filter((d: string) => d === args.simulation_id)

          const entries: string[] = []
          for (const simDir of simDirs) {
            const fullDir = `${baseDir}/${simDir}`
            if (!existsSync(fullDir)) continue
            const files = readdirSync(fullDir).filter((f: string) => f.endsWith(".json"))
            for (const file of files) {
              try {
                const d = JSON.parse(readFileSync(`${fullDir}/${file}`, "utf8"))
                if (args.agent_name && d.agent !== args.agent_name) continue
                entries.push(`[${d.timestamp?.slice(0, 16) || "?"}] ${d.agent}: "${(d.question||"").slice(0, 80)}" (${d.mode||"standard"})`)
              } catch {}
            }
          }

          if (entries.length === 0) return { output: "No matching interviews found." }
          return { output: `Interview History (${entries.length}):\n${entries.reverse().join("\n")}` }
        }
      }),
    }
  }
}

