import type { Plugin } from "@opencode-ai/plugin"
import { tool } from "@opencode-ai/plugin"
import { readFile, writeFile } from "fs/promises"
import { readFileSync, writeFileSync, mkdirSync } from "fs"
import { createHash } from "crypto"
export const DynamicWorkflows: Plugin = async ({ client, $, directory }) => {

  return {
    tool: {
      // PATTERN 1: Classify and Act
      classify_task: tool({
        description:
          "Pattern 1 (Classify and Act): Classifies a task and recommends " +
          "the best workflow pattern. Use FIRST for any non-trivial task.",
        args: {
          task: tool.schema.string().describe("The task to classify"),
        },
        async execute(args) {
          const taskLower = args.task.toLowerCase()
          let category = "unknown"
          let pattern = "Direct execution"
          let routing = "Proceed with direct analysis"
          let confidence = "medium"

          if (taskLower.includes("find") || taskLower.includes("bug") || taskLower.includes("fix") || taskLower.includes("debug")) {
            category = "ANALYSIS"
            pattern = "Loop Until Done"
            routing = "Read all files systematically, find bugs, verify each fix"
            confidence = "high"
          } else if (taskLower.includes("create") || taskLower.includes("build") || taskLower.includes("implement")) {
            category = "CREATIVE"
            pattern = "Generate and Filter"
            routing = "Generate multiple approaches, filter to best"
            confidence = "high"
          } else if (taskLower.includes("review") || taskLower.includes("compare")) {
            category = "COMPETITIVE"
            pattern = "Tournament"
            routing = "Multiple agents solve independently, judge picks winner"
            confidence = "high"
          } else if (taskLower.includes("research") || taskLower.includes("investigate")) {
            category = "RESEARCH"
            pattern = "Fan Out and Synthesize"
            routing = "Parallel exploration, then synthesize findings"
            confidence = "high"
          } else {
            category = "SIMPLE"
            pattern = "Direct execution"
            routing = "Proceed directly"
            confidence = "medium"
          }

          return {
            output: `TASK CLASSIFIED: ${category}. Recommended pattern: ${pattern}. Next step: ${routing}`,
          }
        }
      }),

      // PATTERN 2: Fan Out and Synthesize
      fan_out: tool({
        description:
          "Pattern 2 (Fan Out and Synthesize): Splits a task across " +
          "multiple agents, each in clean context. Returns combined results.",
        args: {
          task: tool.schema.string().describe("Overall task"),
          subtasks: tool.schema.array(tool.schema.string()).describe("Independent subtasks (each gets its own agent)"),
          context_files: tool.schema.array(tool.schema.string()).describe("File paths to include").optional().default([]),
        },
        async execute(args) {
          const contextFiles = args.context_files || []
          const fileContents: Record<string, string> = {}

          for (const file of contextFiles) {
            try {
              const content = await readFile(file, "utf8")
              fileContents[file] = content.slice(0, 3000)
            } catch { fileContents[file] = "[file not found]" }
          }

          const subtaskPlan = args.subtasks.map((st, i) => {
            const files = contextFiles.length > 0
              ? `\nContext files:\n${contextFiles.map(f => `- ${f}: ${fileContents[f]?.slice(0, 200)}...`).join("\n")}`
              : ""
            return `Agent ${i + 1}: ${st}${files}`
          }).join("\n\n")

          return {
            output: `FAN OUT PLAN: ${args.subtasks.length} parallel subtasks.\n\n${subtaskPlan}`,
          }
        }
      }),

      // PATTERN 3: Worker-Critic (Adversarial Review)
      adversarial_review: tool({
        description:
          "Pattern 3 (Worker-Critic): Worker solves task, Critic attacks " +
          "against rubric. Output kept ONLY if survives critique.",
        args: {
          task: tool.schema.string().describe("Task for worker to solve"),
          rubric: tool.schema.string().describe("Criteria critic judges against"),
          context_files: tool.schema.array(tool.schema.string()).describe("File paths to include").optional().default([]),
        },
        async execute(args) {
          const contextFiles = args.context_files || []
          const fileContents: Record<string, string> = {}

          for (const file of contextFiles) {
            try {
              const content = await readFile(file, "utf8")
              fileContents[file] = content.slice(0, 5000)
            } catch { fileContents[file] = "[file not found]" }
          }

          const workerInstruction = `WORKER TASK: ${args.task}\n\n` +
            `Context files:\n${Object.entries(fileContents).map(([f, c]) => `--- ${f} ---\n${c}`).join("\n\n")}\n\n` +
            `Produce your best answer with clear reasoning.`

          const criticInstruction = `CRITIC TASK: Find flaws in the worker's output.\n\n` +
            `Rubric: ${args.rubric}\n\n` +
            `Be adversarial. Find every flaw, weakness, false assumption.\n` +
            `Return: {"passed":true/false,"flaws":["..."],"severity":"low/medium/high"}`

          return {
            output: `ADVERSARIAL REVIEW INSTRUCTIONS:\n\n=== WORKER ===\n${workerInstruction}\n\n=== CRITIC ===\n${criticInstruction}\n\nRun worker first, then run critic on worker's output. If critic rejects, revise and re-run.`,
          }
        }
      }),

      // PATTERN 4: Generate and Filter
      generate_and_filter: tool({
        description:
          "Pattern 4 (Generate and Filter): Generate multiple candidates, " +
          "filter through rubric, keep best.",
        args: {
          task: tool.schema.string().describe("What to generate"),
          count: tool.schema.number().describe("Number of candidates to generate").optional().default(3),
          rubric: tool.schema.string().describe("Filter criteria"),
        },
        async execute(args) {
          const generationPrompt = `Generate ${args.count} different candidates for: "${args.task}"\n\nBe creative and diverse. Each takes a different approach.\nReturn JSON: {"candidates":["candidate1","candidate2","candidate3"]}`

          const filterPrompt = `You are a FILTER. Rank these candidates against this rubric:\n\nRubric: ${args.rubric}\n\nCandidates:\n{candidates}\n\nReturn JSON: {"ranked":["best","second","third"],"reasoning":"..."}`

          return {
            output: `GENERATE AND FILTER:\n\n=== GENERATION ===\n${generationPrompt}\n\n=== FILTER ===\n${filterPrompt}\n\nGenerate ${args.count} candidates, then rank them against the rubric. Keep the best one.`,
          }
        }
      }),

      // PATTERN 5: Tournament
      tournament: tool({
        description:
          "Pattern 5 (Tournament): Multiple agents compete on same task. " +
          "Judge picks winner based on quality.",
        args: {
          task: tool.schema.string().describe("Task for agents to compete on"),
          num_agents: tool.schema.number().describe("Number of competing agents").optional().default(3),
          rubric: tool.schema.string().describe("Criteria judge uses"),
        },
        async execute(args) {
          const agentPrompt = `COMPETITOR: Solve this task independently:\n${args.task}\n\nProduce your best answer with clear reasoning.`

          const judgePrompt = `JUDGE: ${args.num_agents} competitors solved the same task. Compare their outputs against this rubric:\n\nRubric: ${args.rubric}\n\nFor each competitor, score 0-10 and explain why.\nReturn JSON: {"winner": "Agent N", "scores": {"1": N, "2": N, "3": N}, "reasoning": "..."}`

          return {
            output: `TOURNAMENT:\n\n=== AGENT PROMPT ===\n${agentPrompt}\n\n=== JUDGE PROMPT ===\n${judgePrompt}\n\nSend the same task to ${args.num_agents} agents independently. Then use a judge to pick the winner.`,
          }
        }
      }),

      // PATTERN 6: Loop Until Done
      loop_until_done: tool({
        description:
          "Pattern 6 (Loop Until Done): Iterative investigation loop. " +
          "Run until no new findings emerge.",
        args: {
          task: tool.schema.string().describe("Task to investigate iteratively"),
          max_iterations: tool.schema.number().describe("Maximum iterations before stopping").optional().default(5),
        },
        async execute(args) {
          const iterationPrompt = `ITERATION INVESTIGATION: ${args.task}\n\n` +
            `Instructions:\n` +
            `1. Read the relevant files\n` +
            `2. Apply your analysis\n` +
            `3. Report what you found\n` +
            `4. If no new findings, stop\n` +
            `5. If new findings, continue to next iteration\n` +
            `Max iterations: ${args.max_iterations}`

          const gatePrompt = `GATE CHECK: Did you find anything new in this iteration?\n` +
            `Return JSON: {"new_findings": true/false, "findings": [...], "confidence": "high/medium/low"}`

          return {
            output: `LOOP UNTIL DONE:\n\n=== ITERATION ===\n${iterationPrompt}\n\n=== GATE CHECK ===\n${gatePrompt}\n\nInvestigate iteratively (max ${args.max_iterations} iterations). After each iteration, check if new findings emerged. Stop when no new findings.`,
          }
        }
      }),
      // Ralph Loop
      ralph_loop: tool({
        description: "Self-referential loop persisting state until completion. Each iteration self-corrects. Resume across interruptions.",
        args: {
          task: tool.schema.string().describe("Task to complete"),
          completion_criteria: tool.schema.array(tool.schema.string()).describe("Conditions").optional().default([]),
          max_cycles: tool.schema.number().describe("Safety limit").optional().default(10),
        },
        async execute(args) {
          const hash = createHash("sha256").update(args.task).digest("hex").slice(0,8)
          const stateFile = directory + "/.opencode/runtime/ralph/" + hash + ".json"
          mkdirSync(directory + "/.opencode/runtime/ralph", { recursive: true })
          let state = { task: args.task, cycles: 0, findings: [], completed: false }
          try { state = JSON.parse(readFileSync(stateFile, "utf8")) } catch {}
          if (state.completed) return { output: "RALPH LOOP DONE: " + state.cycles + " cycles, " + state.findings.length + " findings." }
          state.cycles++
          if (state.cycles > (args.max_cycles || 10)) return { output: "RALPH LOOP STOPPED: max cycles.\n" + state.findings.join("\n") }
          writeFileSync(stateFile, JSON.stringify(state, null, 2), "utf8")
          return { output: "RALPH LOOP (" + state.cycles + "/" + (args.max_cycles||10) + ")\nContinuar loop. Report findings. State saved.\nFile: " + stateFile }
        }
      }),
      // IntentGate
      analyze_intent: tool({
        description: "Analyzes user intent: true goal, implied intent, actual need vs literal.",
        args: { request: tool.schema.string().describe("User request"), context: tool.schema.string().describe("Context").optional().default("") },
        async execute(args) { return { output: "INTENT ANALYSIS\nRequest: " + args.request + "\n\nDetermine: true goal, implied intent, actual need vs asked, missing context, classification, confidence." } }
      }),
      // Hyperplan
      hyperplan: tool({
        description: "5 hostile agents critique from orthogonal angles.",
        args: { plan: tool.schema.string().describe("Plan to critique") },
        async execute(args) {
          const s = ["OPTIMIST: Best case?","PESSIMIST: Worst case?","CONTRARIAN: Opposite approach?","RISK-ANALYST: Risk scores?","EDGE-CASE: Race conditions?"]
          return { output: "HYPERPLAN\nPlan: " + args.plan.slice(0,1500) + "\n\n" + s.join("\n\n") + "\n\nSynthesize final recommendation." }
        }
      }),
    }
  }
}

