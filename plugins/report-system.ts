// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
// REPORT SYSTEM â€” Structured Prediction Report Generation
// Phase 4 of MiroFish-style simulation stack
// ReACT planning â†’ insight forge â†’ panorama â†’ section synthesis
// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

import type { Plugin } from "@opencode-ai/plugin"
import { tool } from "@opencode-ai/plugin"
import { execSync } from "child_process"
import { mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync } from "fs"

const REPORTS_DIR = ".opencode/runtime/reports"
const SIM_DIR = ".opencode/runtime/simulations"

export const ReportSystemPlugin: Plugin = async ({ directory }) => {

  function ensureDir() { const d = `${directory}/${REPORTS_DIR}`; mkdirSync(d, { recursive: true }); return d }

  function loadSimulation(id: string): any {
    try { return JSON.parse(readFileSync(`${directory}/${SIM_DIR}/${id}/state.json`, "utf8")) } catch { return null }
  }

  function runAgent(prompt: string, timeout = 60000): string {
    try {
      const raw = execSync(
        `opencode run "${prompt.replace(/"/g,'\\"')}" --pure --format default`,
        { encoding: "utf8", timeout, maxBuffer: 10*1024*1024 }
      )
      return raw.replace(/\x1B\[[0-9;]*[a-zA-Z]/g,"").trim()
    } catch { return "Agent call failed." }
  }

  return {
    tool: {
      // â”€â”€â”€ Plan report structure â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
      report_plan: tool({
        description: "Plans the structure of a prediction report. Analyzes simulation results and generates a 2-5 section outline with descriptions.",
        args: {
          simulation_id: tool.schema.string().describe("Simulation ID"),
          format: tool.schema.enum(["summary", "detailed", "predictive"]).describe("Report format").optional().default("predictive"),
        },
        async execute(args) {
          const sim = loadSimulation(args.simulation_id)
          if (!sim) return { output: `Simulation "${args.simulation_id}" not found.` }

          const summary = `Task: ${sim.task}\nAgents: ${(sim.personas||[]).length}\nRounds: ${(sim.rounds||[]).length}\nConverged: ${sim.converged}\nEmergent findings: ${(sim.emergence||[]).length}\n\nAgent positions:\n${(sim.rounds||[]).slice(-1)[0]?.positions?.map((p: any) => `  ${p.name}: ${p.stance}`).join("\n") || "none"}`

          const plan = runAgent(`Create a report outline (2-5 sections) for a prediction report about: "${sim.task}"

Simulation summary:
${summary}

Output ONLY a JSON array: [{"section": "title", "description": "what this covers", "key_questions": ["q1","q2"]}]
No markdown, no explanation.`, 60000)

          let sections: any[] = []
          try { const j = plan.match(/\[[\s\S]*\]/); if (j) sections = JSON.parse(j[0]) } catch {}
          if (sections.length === 0) sections = [
            { section: "Executive Summary", description: "Overview of findings and prediction", key_questions: ["What is the consensus?"] },
            { section: "Key Arguments", description: "Main arguments for and against", key_questions: ["What are the strongest arguments?"] },
            { section: "Emergent Insights", description: "Findings that emerged during debate", key_questions: ["What unexpected conclusions arose?"] },
          ]

          // Save plan
          const dir = ensureDir()
          writeFileSync(`${dir}/${args.simulation_id}_plan.json`, JSON.stringify({ simulation_id: args.simulation_id, format: args.format, sections, createdAt: new Date().toISOString() }, null, 2), "utf8")

          return { output: `â•â•â• REPORT PLAN â•â•â•\nSimulation: ${args.simulation_id}\nFormat: ${args.format}\nSections: ${sections.length}\n\n${sections.map((s: any, i: number) => `  ${i+1}. ${s.section}: ${s.description}`).join("\n")}\n\nUse report_generate to write the full report.` }
        }
      }),

      // â”€â”€â”€ Deep-dive analysis tool (insight_forge) â”€â”€â”€â”€
      insight_forge: tool({
        description: "Deep-dive analysis tool. Decomposes a question into sub-angles, searches simulation data and project context, returns structured findings. Use inside report generation.",
        args: {
          question: tool.schema.string().describe("Analysis question"),
          simulation_id: tool.schema.string().describe("Simulation ID with relevant data"),
          depth: tool.schema.enum(["quick", "deep"]).describe("Analysis depth").optional().default("deep"),
        },
        async execute(args) {
          const sim = loadSimulation(args.simulation_id)
          let context = `Analysis question: ${args.question}\n\n`
          if (sim) {
            context += `Task: ${sim.task}\nRounds: ${(sim.rounds||[]).length}\nAgent count: ${(sim.personas||[]).length}\n\nAgent positions:\n`
            const lastRound = (sim.rounds||[]).slice(-1)[0]
            if (lastRound) {
              for (const p of lastRound.positions || []) {
                context += `\n${p.name} (${p.stance}): ${p.argument.slice(0, 500)}`
              }
            }
          }

          const depthInstr = args.depth === "deep" ? "Decompose into 3 sub-questions. Research each thoroughly." : "Quick analysis."
          const result = runAgent(`You are an analysis engine. ${depthInstr}

${context}

Output structured findings as JSON:
{"findings":[{"claim":"...","evidence":"...","confidence":"high|medium|low","source":"simulation"}],"summary":"..."}
No markdown.`, 90000)

          let formatted = `â•â•â• INSIGHT FORGE â•â•â•\nQuestion: ${args.question}\n\n`
          try { const j = result.match(/\{[\s\S]*\}/); if (j) { const d = JSON.parse(j[0]); formatted += `Summary: ${d.summary||""}\n\nFindings:\n${(d.findings||[]).map((f: any) => `  [${f.confidence}] ${f.claim}`).join("\n")}` } }
          catch { formatted += result.slice(0, 2000) }
          return { output: formatted }
        }
      }),

      // â”€â”€â”€ Broad search tool (panorama) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
      panorama_search: tool({
        description: "Broad search across simulation data. Returns ALL agent positions, ALL claims, ALL disagreements. Use for comprehensive coverage.",
        args: {
          simulation_id: tool.schema.string().describe("Simulation ID"),
        },
        async execute(args) {
          const sim = loadSimulation(args.simulation_id)
          if (!sim) return { output: "Simulation not found." }

          let out = `â•â•â• PANORAMA â•â•â•\nSimulation: ${args.simulation_id}\nTask: ${sim.task}\n\n`

          for (const round of sim.rounds || []) {
            out += `\nRound ${round.round}:\n`
            for (const pos of round.positions || []) {
              out += `  ${pos.name} [${pos.stance}]: ${pos.argument.slice(0, 200).replace(/\n/g," ")}...\n`
            }
          }

          if (sim.emergence?.length > 0) {
            out += `\nEmergent Findings:\n`
            for (const e of sim.emergence) {
              out += `  [${e.confidence}] "${e.claim.slice(0, 100)}" (emerged round ${e.emergedInRound})\n`
            }
          }

          return { output: out.slice(0, 8000) }
        }
      }),

      // â”€â”€â”€ Generate full report â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
      report_generate: tool({
        description: "Generates the full prediction report. Uses ReACT planning to create an outline, then generates each section with deep analysis. Saves incrementally.",
        args: {
          simulation_id: tool.schema.string().describe("Simulation ID"),
          format: tool.schema.enum(["summary", "detailed", "predictive"]).describe("Report format").optional().default("predictive"),
          include_emergence: tool.schema.boolean().describe("Include emergent findings section").optional().default(true),
        },
        async execute(args) {
          const sim = loadSimulation(args.simulation_id)
          if (!sim) return { output: "Simulation not found." }

          // Get or create plan
          let sections: any[] = []
          const planFile = `${ensureDir()}/${args.simulation_id}_plan.json`
          if (existsSync(planFile)) {
            try { sections = JSON.parse(readFileSync(planFile, "utf8")).sections || [] } catch {}
          }
          if (sections.length === 0) {
            const planResult = { output: '' } /* inline plan generation - use saved plan if exists */
            try { const pf = JSON.parse(readFileSync(planFile, "utf8")); sections = pf.sections || [] } catch {}
          }

          const reportDir = `${ensureDir()}/${args.simulation_id}`
          mkdirSync(reportDir, { recursive: true })

          // Generate each section
          const sectionContents: string[] = []
          for (let i = 0; i < sections.length; i++) {
            const sec = sections[i]
            const insight = await this.insight_forge.execute({ question: sec.key_questions?.[0] || sec.description, simulation_id: args.simulation_id, depth: "deep" })
            const sectionText = runAgent(`Write section "${sec.section}" for a prediction report about: "${sim.task}"

Description: ${sec.description}

Research data:
${(insight.output || "").slice(0, 2000)}

Write a detailed analysis section. Use evidence from the simulation. ${sec.key_questions ? "Answer: "+sec.key_questions.join(", ") : ""}

Format as markdown without H1 (use bold instead of #).`, 90000)

            const sectionContent = `## ${sec.section}\n\n${sectionText.slice(0, 3000)}`
            sectionContents.push(sectionContent)
            // Save incrementally
            writeFileSync(`${reportDir}/section_${i+1}.md`, sectionContent, "utf8")
          }

          // Emergence section
          if (args.include_emergence !== false && sim.emergence?.length > 0) {
            let emText = `## Emergent Insights\n\n`
            for (const e of sim.emergence.slice(0, 10)) {
              emText += `- **${e.claim.slice(0, 100)}** â€” Confidence: ${e.confidence}, Support: ${e.supportCount}/${e.supportCount+e.opposeCount} agents\n`
            }
            sectionContents.push(emText)
            writeFileSync(`${reportDir}/section_emergence.md`, emText, "utf8")
          }

          // Compile full report
          const fullReport = [
            `# Prediction Report: ${sim.task.slice(0, 80)}`,
            `**Generated:** ${new Date().toISOString().slice(0, 16)}`,
            `**Simulation:** ${args.simulation_id} (${(sim.rounds||[]).length} rounds, ${(sim.personas||[]).length} agents)`,
            `**Format:** ${args.format}`,
            `**Converged:** ${sim.converged ? `Yes (round ${sim.convergenceRound})` : "No"}`,
            ``,
            ...sectionContents,
            ``,
            `---`,
            `*Generated by simulation engine*`,
          ].join("\n")

          writeFileSync(`${reportDir}/full_report.md`, fullReport, "utf8")

          return { output: `â•â•â• REPORT GENERATED â•â•â•\nSimulation: ${args.simulation_id}\nSections: ${sectionContents.length}\nFile: ${reportDir}/full_report.md\n\n${fullReport.slice(0, 3000)}\n...\n\nUse report_view for full report, report_chat for interactive Q&A.` }
        }
      }),

      // â”€â”€â”€ View a report â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
      report_view: tool({
        description: "Views a generated report. Returns the full report text.",
        args: {
          simulation_id: tool.schema.string().describe("Simulation ID"),
          section: tool.schema.number().describe("Specific section number (optional)").optional().default(0),
        },
        async execute(args) {
          const reportDir = `${ensureDir()}/${args.simulation_id}`
          if (!existsSync(reportDir)) return { output: "No report found for this simulation." }

          if (args.section > 0) {
            const file = `${reportDir}/section_${args.section}.md`
            if (!existsSync(file)) return { output: `Section ${args.section} not found.` }
            return { output: readFileSync(file, "utf8") }
          }

          const fullFile = `${reportDir}/full_report.md`
          if (existsSync(fullFile)) return { output: readFileSync(fullFile, "utf8") }

          // Fallback: concatenate sections
          const files = readdirSync(reportDir).filter((f: string) => f.startsWith("section_")).sort()
          if (files.length === 0) return { output: "Report is empty." }
          const content = files.map((f: string) => readFileSync(`${reportDir}/${f}`, "utf8")).join("\n\n")
          return { output: content.slice(0, 8000) }
        }
      }),

      // â”€â”€â”€ Interactive chat on a report â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
      report_chat: tool({
        description: "Interactive Q&A on a generated report. Ask questions and get answers based on the report content + simulation data.",
        args: {
          simulation_id: tool.schema.string().describe("Simulation ID"),
          question: tool.schema.string().describe("Your question about the report"),
        },
        async execute(args) {
          const reportDir = `${ensureDir()}/${args.simulation_id}`
          let reportText = ""
          const fullFile = `${reportDir}/full_report.md`
          if (existsSync(fullFile)) reportText = readFileSync(fullFile, "utf8").slice(0, 5000)

          const sim = loadSimulation(args.simulation_id)
          let simContext = ""
          if (sim) {
            simContext = `Task: ${sim.task}\nAgents: ${(sim.personas||[]).join(", ")}\nRounds: ${(sim.rounds||[]).length}`
          }

          const answer = runAgent(`You are a report analyst. Answer the question based on the report and simulation data.

Report:
${reportText.slice(0, 4000)}

Simulation:
${simContext}

Question: ${args.question}

Provide a concise, evidence-based answer. Cite specific parts of the report.`, 60000)

          return { output: `â•â•â• REPORT CHAT â•â•â•\nQ: ${args.question}\n\n${answer.slice(0, 3000)}` }
        }
      }),
    }
  }
}

