// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
// PROFILE SYSTEM â€” Agent Persona Engine
// Phase 1 of MiroFish-style simulation stack
// Generates diverse agent personalities for debate/prediction
// 12 persona types + personality matrix + batch generation
// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

import type { Plugin } from "@opencode-ai/plugin"
import { tool } from "@opencode-ai/plugin"
import { execSync } from "child_process"
import { mkdirSync, existsSync, writeFileSync, readFileSync, readdirSync } from "fs"

const PROFILES_DIR = ".opencode/runtime/profiles"

const PERSONA_TYPES = [
  { id: "debugger", name: "Debugger", desc: "Edge-case focused, finds what breaks", style: "skeptical, boundary-testing" },
  { id: "reviewer", name: "Reviewer", desc: "Quality & correctness focused", style: "thorough, standards-compliant" },
  { id: "architect", name: "Architect", desc: "System structure & scalability", style: "big-picture, abstraction-focused" },
  { id: "optimizer", name: "Optimizer", desc: "Performance & efficiency", style: "efficiency-first, metrics-driven" },
  { id: "security", name: "Security Auditor", desc: "Vulnerability focused", style: "paranoid, threat-modeling" },
  { id: "teacher", name: "Teacher", desc: "Explanatory, pedagogical", style: "clear, educational, example-driven" },
  { id: "critic", name: "Critic", desc: "Adversarial, finds flaws", style: "devil's advocate, assumption-challenging" },
  { id: "engineer", name: "Engineer", desc: "Practical, build-focused", style: "pragmatic, solution-oriented" },
  { id: "researcher", name: "Researcher", desc: "Deep investigation", style: "thorough, evidence-based" },
  { id: "strategist", name: "Strategist", desc: "High-level planning", style: "long-term, risk-aware" },
  { id: "integrator", name: "Integrator", desc: "Cross-system compatibility", style: "holistic, dependency-aware" },
  { id: "tester", name: "Tester", desc: "Test coverage & edge cases", style: "methodical, coverage-driven" },
]

export const ProfileSystemPlugin: Plugin = async ({ directory }) => {

  function ensureDir() {
    const dir = `${directory}/${PROFILES_DIR}`
    mkdirSync(dir, { recursive: true })
    return dir
  }

  function buildPersonaPrompt(typeId: string, task: string, context: string): string {
    const t = PERSONA_TYPES.find(p => p.id === typeId) || PERSONA_TYPES[0]
    return `You are a ${t.name}. ${t.desc}.

Your thinking style: ${t.style}.

Task: ${task}
Context: ${context.slice(0, 1000)}

Respond as your persona. Stay in character. Challenge assumptions that don't align with your expertise.`
  }

  return {
    tool: {
      // â”€â”€â”€ List available persona types â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
      profile_list_types: tool({
        description: "Lists all 12 available agent persona types for simulation use.",
        args: {},
        async execute() {
          const lines = PERSONA_TYPES.map(t => `  ${t.id}: ${t.name} â€” ${t.desc}`)
          return { output: `Available Personas (${PERSONA_TYPES.length}):\n${lines.join("\n")}` }
        }
      }),

      // â”€â”€â”€ Generate a single persona profile â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
      profile_generate: tool({
        description: "Generates a single agent persona with full personality matrix. Accepts persona type, task description, and optional context. Returns structured profile: name, bio, expertise, style, bias.",
        args: {
          persona_type: tool.schema.string().describe("Persona type ID (use profile_list_types)"),
          task: tool.schema.string().describe("Task description for the persona to address"),
          context: tool.schema.string().describe("Project context (code, docs, entities)").optional().default(""),
          name: tool.schema.string().describe("Optional custom name for the agent").optional().default(""),
        },
        async execute(args) {
          const prompt = buildPersonaPrompt(args.persona_type, args.task, args.context)
          const raw = execSync(
            `opencode run "${(prompt + "\n\nOutput ONLY a JSON object with: name, bio (1 line), expertise (3-5 keywords), thinking_style, decision_bias, communication_style. No markdown.").replace(/"/g,'\\"')}" --pure --format default`,
            { encoding: "utf8", timeout: 60000, maxBuffer: 10*1024*1024 }
          )
          const out = raw.replace(/\x1B\[[0-9;]*[a-zA-Z]/g,"").trim()
          // Try to extract JSON
          let profile: any = { name: args.name || args.persona_type, type: args.persona_type }
          try {
            const jsonMatch = out.match(/\{[\s\S]*\}/)
            if (jsonMatch) profile = { ...profile, ...JSON.parse(jsonMatch[1]) }
          } catch { profile.bio = out.slice(0, 200) }

          // Save to disk
          const dir = ensureDir()
          const filePath = `${dir}/${profile.name.replace(/[^a-z0-9_-]/gi,"_").toLowerCase()}.json`
          const data = JSON.stringify(profile, null, 2)
          try { writeFileSync(filePath, data, "utf8") } catch {}

          return { output: `â•â•â• PROFILE: ${profile.name} â•â•â•\nType: ${args.persona_type}\nBio: ${profile.bio||""}\nExpertise: ${(profile.expertise||[]).join(", ")}\nStyle: ${profile.thinking_style||""}\nBias: ${profile.decision_bias||""}\nSaved: ${filePath}` }
        }
      }),

      // â”€â”€â”€ Batch generate profiles â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
      profile_batch: tool({
        description: "Generates multiple agent personas in parallel. Accepts an array of persona types or a count. Returns all generated profiles.",
        args: {
          task: tool.schema.string().describe("Task description"),
          types: tool.schema.array(tool.schema.string()).describe("Persona types to generate").optional().default([]),
          count: tool.schema.number().describe("Number of profiles (if types not specified)").optional().default(5),
          context: tool.schema.string().describe("Project context").optional().default(""),
        },
        async execute(args) {
          const types = (args.types || []).length > 0 ? args.types : PERSONA_TYPES.slice(0, args.count || 5).map(t => t.id)
          const concurrency = Math.min(types.length, 8)
          const results: string[] = []

          for (let i = 0; i < types.length; i += concurrency) {
            const batch = types.slice(i, i + concurrency)
            const proms = batch.map(t => {
              const prompt = buildPersonaPrompt(t, args.task, args.context)
              try {
                const raw = execSync(
                  `opencode run "${(prompt + "\n\nOutput ONLY JSON: {\"name\":\"...\",\"bio\":\"...\",\"expertise\":[...],\"thinking_style\":\"...\",\"decision_bias\":\"...\",\"communication_style\":\"...\"}").replace(/"/g,'\\"')}" --pure --format default`,
                  { encoding: "utf8", timeout: 60000, maxBuffer: 10*1024*1024 }
                )
                const out = raw.replace(/\x1B\[[0-9;]*[a-zA-Z]/g,"").trim()
                let p: any = { type: t }
                try { const j = out.match(/\{[\s\S]*\}/); if (j) p = { ...p, ...JSON.parse(j[1]) } } catch { p.bio = out.slice(0,100) }
                // Save
                const dir = ensureDir()
                writeFileSync(`${dir}/${(p.name||t).replace(/[^a-z0-9_-]/gi,"_").toLowerCase()}.json`, JSON.stringify(p, null, 2), "utf8")
                return `  âœ… ${p.name||t}: ${(p.bio||"").slice(0,80)}`
              } catch { return `  âŒ ${t}: generation failed` }
            })
            results.push(...await Promise.all(proms))
          }

          return { output: `â•â•â• BATCH PROFILES COMPLETE â•â•â•\nGenerated: ${types.length} profiles\n\n${results.join("\n")}\n\nSaved to: ${directory}/${PROFILES_DIR}/` }
        }
      }),

      // â”€â”€â”€ Apply a profile to an agent prompt â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
      profile_apply: tool({
        description: "Injects a persona profile into an agent prompt. Prepends the persona description so the agent thinks and responds in character.",
        args: {
          profile_name: tool.schema.string().describe("Profile name (from profile_generate or profile_batch)"),
          prompt: tool.schema.string().describe("Original agent prompt to augment"),
        },
        async execute(args) {
          const dir = ensureDir()
          const filePath = `${dir}/${args.profile_name.replace(/[^a-z0-9_-]/gi,"_").toLowerCase()}.json`
          if (!existsSync(filePath)) return { output: `Profile "${args.profile_name}" not found. Use profile_list to see available profiles.` }

          let profile: any = {}
          try { profile = JSON.parse(readFileSync(filePath, "utf8")) } catch { return { output: "Could not read profile file." } }

          const augmented = `[You are ${profile.name}. ${profile.bio||""}]\n[Expertise: ${(profile.expertise||[]).join(", ")}]\n[Thinking: ${profile.thinking_style||""}]\n[Bias: ${profile.decision_bias||""}]\n[Style: ${profile.communication_style||""}]\n\n${args.prompt}`

          return { output: augmented }
        }
      }),

      // â”€â”€â”€ List saved profiles â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
      profile_list: tool({
        description: "Lists all saved agent profiles on disk.",
        args: {},
        async execute() {
          const dir = ensureDir()
          const files = readdirSync(dir).filter((f: string) => f.endsWith(".json"))
          if (files.length === 0) return { output: "No saved profiles. Generate with profile_generate or profile_batch." }
          const details = files.map((f: string) => {
            try {
              const d = JSON.parse(readFileSync(`${dir}/${f}`, "utf8"))
              return `  ${d.name||f.replace(".json","")}: ${(d.bio||"").slice(0,60)}`
            } catch { return `  ${f.replace(".json","")}` }
          })
          return { output: `Saved Profiles (${files.length}):\n${details.join("\n")}` }
        }
      }),
    }
  }
}

