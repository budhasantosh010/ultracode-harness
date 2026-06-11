// ═══════════════════════════════════════════════════════════════
// SIMULATION WATCH — Real-time Simulation Monitoring
// Phase 5 of MiroFish-style simulation stack
// Position tracking, round timeline, agent leaderboard
// ═══════════════════════════════════════════════════════════════

import type { Plugin } from "@opencode-ai/plugin"
import { tool } from "@opencode-ai/plugin"
import { readFileSync, existsSync } from "fs"

const SIM_DIR = ".opencode/runtime/simulations"

export const SimulationWatchPlugin: Plugin = async ({ directory }) => {

  function loadSim(id: string): any {
    try { return JSON.parse(readFileSync(`${directory}/${SIM_DIR}/${id}/state.json`, "utf8")) } catch { return null }
  }

  return {
    tool: {
      // ─── Live simulation status ──────────────────────
      sim_status: tool({
        description: "Real-time simulation status. Shows current round, all agent positions, convergence progress, and elapsed time.",
        args: {
          simulation_id: tool.schema.string().describe("Simulation ID"),
        },
        async execute(args) {
          const s = loadSim(args.simulation_id)
          if (!s) return { output: `Simulation "${args.simulation_id}" not found.` }

          const lastRound = (s.rounds || []).slice(-1)[0]
          const forC = lastRound ? lastRound.positions.filter((p: any) => p.stance === "FOR").length : 0
          const agC = lastRound ? lastRound.positions.filter((p: any) => p.stance === "AGAINST").length : 0
          const undC = lastRound ? lastRound.positions.filter((p: any) => p.stance === "UNDECIDED").length : 0
          const total = lastRound ? lastRound.positions.length : 0
          const convergePct = total > 0 ? Math.round(Math.max(forC, agC) / total * 100) : 0

          let out = `═══ SIM STATUS: ${args.simulation_id} ═══\n`
          out += `Task: ${s.task.slice(0, 60)}...\n`
          out += `Status: ${s.status}\n`
          out += `Rounds: ${s.rounds.length}\n`
          out += `Positions: ${forC} FOR / ${agC} AGAINST / ${undC} UNDECIDED (${convergePct}% convergence)\n`
          out += `Converged: ${s.converged ? "Yes (round "+s.convergenceRound+")" : "No"}\n`
          out += `Emergent findings: ${(s.emergence||[]).length}\n`

          if (lastRound) {
            out += `\nLatest positions:\n`
            for (const p of lastRound.positions) {
              const icon = p.stance === "FOR" ? "✅" : p.stance === "AGAINST" ? "❌" : "❓"
              out += `  ${icon} ${p.name}: ${p.argument.slice(0, 100).replace(/\n/g, " ")}...\n`
            }
          }
          return { output: out }
        }
      }),

      // ─── Round timeline ──────────────────────────────
      sim_timeline: tool({
        description: "Shows the debate evolution round-by-round. Each round shows which agents changed positions and what new claims emerged.",
        args: {
          simulation_id: tool.schema.string().describe("Simulation ID"),
        },
        async execute(args) {
          const s = loadSim(args.simulation_id)
          if (!s) return { output: "Simulation not found." }

          let out = `═══ TIMELINE: ${args.simulation_id} ═══\n`
          for (let i = 0; i < s.rounds.length; i++) {
            const round = s.rounds[i]
            const positions = (round.positions || []).map((p: any) => `${p.name}:${p.stance}`).join(", ")
            out += `\nRound ${round.round}: ${round.positions.length} agents\n  ${positions}\n`
          }

          if (s.emergence?.length > 0) {
            out += `\nEmergence timeline:\n`
            for (const e of s.emergence) {
              out += `  Round ${e.emergedInRound}: "${e.claim.slice(0, 80)}" (${e.supportCount}/${e.supportCount+e.opposeCount})\n`
            }
          }
          return { output: out }
        }
      }),

      // ─── Agent leaderboard ───────────────────────────
      sim_leaderboard: tool({
        description: "Ranks agents by debate activity: arguments made, position changes, unique claims contributed. Shows who drove the conversation.",
        args: {
          simulation_id: tool.schema.string().describe("Simulation ID"),
        },
        async execute(args) {
          const s = loadSim(args.simulation_id)
          if (!s) return { output: "Simulation not found." }

          const stats: Record<string, { arguments: number; stanceChanges: number; claims: number }> = {}
          for (const round of s.rounds || []) {
            for (const pos of round.positions || []) {
              if (!stats[pos.name]) stats[pos.name] = { arguments: 0, stanceChanges: 0, claims: 0 }
              stats[pos.name].arguments++
              stats[pos.name].claims += (pos.claims || []).length
            }
          }

          // Track stance changes
          for (let i = 1; i < s.rounds.length; i++) {
            const prev = s.rounds[i-1].positions
            const curr = s.rounds[i].positions
            for (const c of curr) {
              const p = prev.find((pp: any) => pp.name === c.name)
              if (p && p.stance !== c.stance && c.stance !== "UNDECIDED") stats[c.name].stanceChanges++
            }
          }

          const sorted = Object.entries(stats).sort((a, b) => b[1].arguments - a[1].arguments)

          let out = `═══ LEADERBOARD: ${args.simulation_id} ═══\n`
          out += `Agent               │ Arguments │ Changes │ Claims\n`
          out += `────────────────────┼───────────┼─────────┼───────\n`
          for (const [name, s] of sorted) {
            out += `${name.padEnd(18)} │ ${String(s.arguments).padStart(7)} │ ${String(s.stanceChanges).padStart(5)} │ ${s.claims}\n`
          }
          return { output: out }
        }
      }),

      // ─── Full position map ───────────────────────────
      sim_positions: tool({
        description: "Shows every agent's position on every claim. Heat-map style: FOR/AGAINST/UNDECIDED per agent per claim.",
        args: {
          simulation_id: tool.schema.string().describe("Simulation ID"),
          claim: tool.schema.string().describe("Filter by specific claim").optional().default(""),
        },
        async execute(args) {
          const s = loadSim(args.simulation_id)
          if (!s) return { output: "Simulation not found." }
          if (!s.rounds.length) return { output: "No debate rounds yet." }

          const last = s.rounds[s.rounds.length - 1]
          let out = `═══ POSITION MAP: ${args.simulation_id} ═══\n\n`
          out += `Agent'.padEnd(14) │ Stance │ Key Argument\n`
          out += `'.repeat(45)}\n`

          for (const p of last.positions) {
            const icon = p.stance === "FOR" ? "✅ FOR  " : p.stance === "AGAINST" ? "❌ AGAIN" : "❓ UNDEC"
            const arg = p.argument.slice(0, 80).replace(/\n/g, " ")
            if (args.claim && !arg.toLowerCase().includes(args.claim.toLowerCase())) continue
            out += `${p.name.padEnd(14)} │ ${icon} │ ${arg}\n`
          }
          return { output: out }
        }
      }),
    }
  }
}
