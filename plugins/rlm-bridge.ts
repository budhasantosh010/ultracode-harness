import type { Plugin } from "@opencode-ai/plugin"
import { tool } from "@opencode-ai/plugin"
import { readFile, writeFile } from "fs/promises"
import { execFileSync } from "child_process"

export const RLM_Bridge: Plugin = async ({ client, $, directory }) => {

  return {
    tool: {
      // ─── Tool: decompose ────────────────────────────
      decompose: tool({
        description:
          "Analyzes a complex task and splits it into independent sub-tasks. " +
          "Each sub-task is a focused prompt suitable for rlm_query. " +
          "Use this BEFORE rlm_query for any task involving >3 files or >5 steps.",
        args: {
          task: tool.schema.string().describe("The complex task to decompose"),
          files: tool.schema.array(tool.schema.string()).describe("File paths or globs to read for context"),
          max_subtasks: tool.schema.number().describe("Maximum number of subtasks").optional().default(5),
        },
        async execute(args, context) {
          let codebase = ""
          for (const pattern of args.files) {
            try {
              const psCommand =
                `Get-ChildItem -Path '${pattern.replace(/'/g, "''")}' -Recurse -File -ErrorAction SilentlyContinue | ` +
                `Select-Object -First 20 -ExpandProperty FullName`
              const stdout = execFileSync(
                "powershell",
                ["-NoProfile", "-NonInteractive", "-Command", psCommand],
                { encoding: "utf8" }
              )
              const files = stdout.trim().split(/\r?\n/).filter(Boolean)
              for (const file of files) {
                try {
                  const content = await readFile(file.trim(), "utf8")
                  codebase += `\n--- ${file.trim()} ---\n${content}\n`
                } catch { /* skip unreadable files */ }
              }
            } catch { /* pattern not found, skip */ }
          }

          const decompositionPrompt =
            `Analyze this task: "${args.task}"\n\n` +
            `Relevant code context:\n${codebase.slice(0, 15000)}\n\n` +
            `Split into at most ${args.max_subtasks} independent sub-tasks.\n` +
            `Each sub-task must be:\n` +
            `- Completable without the others\n` +
            `- A single focused prompt (1-2 sentences)\n` +
            `- Specific enough that a fresh model with no history could execute it\n\n` +
            `Return ONLY a JSON array of strings. No explanation. No markdown. Just the array.`

          return {
            output: decompositionPrompt,
          }
        }
      }),

      // ─── Tool: rlm_query ────────────────────────────
      rlm_query: tool({
        description:
          "Spawns a subagent with a focused prompt and optional context files. " +
          "The subagent gets ONLY this prompt — no conversation history. " +
          "Use for each sub-task from decompose(). " +
          "Equivalent to RLM's rlm_query().",
        args: {
          prompt: tool.schema.string().describe("The exact prompt for the subagent (1-2 sentences, focused)"),
          context_files: tool.schema.array(tool.schema.string()).describe("File paths to include as context").optional().default([]),
        },
        async execute(args, context) {
          let fullPrompt = args.prompt

          const files: string[] = args.context_files || []
          for (const file of files) {
            try {
              const content = await readFile(file, "utf8")
              const truncated = content.length > 5000
                ? content.slice(0, 5000) + "\n... [truncated]"
                : content
              fullPrompt += `\n\n--- ${file} ---\n${truncated}`
            } catch { /* file not found, skip */ }
          }

          return {
            output: fullPrompt,
          }
        }
      }),

      // ─── Tool: repl_exec ────────────────────────────
      repl_exec: tool({
        description:
          "Executes Python or JavaScript code in a sandboxed REPL. " +
          "Use for intermediate computation, data transformation, or testing ideas. " +
          "State persists across calls within a session.",
        args: {
          language: tool.schema.enum(["python", "javascript"]).describe("Language to execute"),
          code: tool.schema.string().describe("Code to execute"),
        },
        async execute(args, context) {
          const stateFile = `${directory}/.opencode/.rlm_repl_state.json`

          let replState: Record<string, any> = {}
          try {
            const stateContent = await readFile(stateFile, "utf8")
            replState = JSON.parse(stateContent)
          } catch { /* no previous state */ }

          const stateJson = JSON.stringify(replState)
          const stateCode = args.language === "python"
            ? `import json; _state = json.loads('${stateJson.replace(/'/g, "\\'")}'); globals().update(_state)`
            : `const _state = ${stateJson}; Object.assign(globalThis, _state);`

          const fullCode = `${stateCode}\n${args.code}`

          const ext = args.language === "python" ? "py" : "js"
          const tmpFile = `${directory}/.opencode/.rlm_repl_${Date.now()}.${ext}`
          await writeFile(tmpFile, fullCode)

          try {
            const runner = args.language === "python" ? "python" : "node"
            const result = await $`${runner} ${tmpFile}`
            const stdout = result.stdout?.toString() || ""
            const stderr = result.stderr?.toString() || ""

            if (args.language === "python" && !stderr) {
              const stateSave = `${stateCode}\n${args.code}\nimport json, sys; print(json.dumps({k: str(v)[:200] for k, v in globals().items() if not k.startswith('_')}))`
              await writeFile(tmpFile, stateSave)
              try {
                const stateResult = await $`python ${tmpFile}`
                const newState = JSON.parse(stateResult.stdout?.toString() || "{}")
                Object.assign(replState, newState)
                await writeFile(stateFile, JSON.stringify(replState))
              } catch { /* state save failed, continue */ }
            }

            return { output: stdout ? `STDOUT:\n${stdout}` : stderr || "Execution complete" }
          } catch (err: any) {
            return { output: err.message || "Execution failed" }
          } finally {
            try { await $`rm ${tmpFile}`.quiet() } catch { /* ignore */ }
          }
        }
      }),
    }
  }
}
