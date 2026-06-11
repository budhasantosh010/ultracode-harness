import type { Plugin } from "@opencode-ai/plugin"
import { mkdirSync } from "fs"
import { readFile, writeFile } from "fs/promises"

const EVOLUTION_LOG = ".opencode/evolution_log.json"
const SYSTEM_EVOLUTION_LOG = "C:/Users/Lenovo/.config/opencode/evolution_log.json"

// Best-effort outcome extraction from a `tool.execute.after` output object.
// OpenCode's hook provides { title, output, metadata }; the exit code (when
// present) lives in metadata, and the textual output in `output`.
function readBashOutcome(output: any): { exitCode: number | undefined; text: string } {
  const meta = output?.metadata ?? {}
  const exitCode =
    typeof meta.exit === "number" ? meta.exit :
    typeof meta.exitCode === "number" ? meta.exitCode :
    typeof meta.code === "number" ? meta.code :
    undefined
  const text = [output?.output, meta.stderr, meta.stdout]
    .filter((s) => typeof s === "string")
    .join("\n")
  return { exitCode, text }
}

export const EvolverPlugin: Plugin = async ({ directory }) => {
  let taskCount = 0
  let failurePatterns: Array<{ pattern: string; count: number; lastSeen: string }> = []

  // Load per-project state
  try {
    const state = await readFile(`${directory}/${EVOLUTION_LOG}`, "utf8")
    const parsed = JSON.parse(state)
    taskCount = parsed.taskCount || 0
    failurePatterns = parsed.failurePatterns || []
  } catch { /* no previous state */ }

  // Load system-level state (universal patterns from all projects)
  let systemPatterns: Array<{ pattern: string; count: number; lastSeen: string }> = []
  try {
    const systemState = await readFile(SYSTEM_EVOLUTION_LOG, "utf8")
    const parsed = JSON.parse(systemState)
    systemPatterns = parsed.failurePatterns || []
  } catch { /* no system state yet */ }

  async function saveState() {
    // Save to per-project (source of truth)
    try { mkdirSync(`${directory}/.opencode`, { recursive: true }) } catch { /* exists */ }
    await writeFile(
      `${directory}/${EVOLUTION_LOG}`,
      JSON.stringify({ taskCount, failurePatterns, lastUpdated: new Date().toISOString() })
    )

    // Sync to system-level (accumulator)
    try {
      const mergedPatterns = [...systemPatterns]
      for (const pattern of failurePatterns) {
        const existing = mergedPatterns.find(f => f.pattern === pattern.pattern)
        if (existing) {
          existing.count += pattern.count
          existing.lastSeen = pattern.lastSeen
        } else {
          mergedPatterns.push({ ...pattern })
        }
      }
      await writeFile(
        SYSTEM_EVOLUTION_LOG,
        JSON.stringify({
          failurePatterns: mergedPatterns,
          lastUpdated: new Date().toISOString(),
          source: "accumulated from all projects"
        }, null, 2)
      )
    } catch { /* system write failed, continue */ }
  }

  return {
    "tool.execute.after": async (input, output) => {
      if (input.tool === "bash") {
        const { exitCode, text } = readBashOutcome(output)

        let pattern: string | null = null
        if (text.includes("TypeError")) pattern = "type_error"
        else if (text.includes("ReferenceError")) pattern = "reference_error"
        else if (text.includes("ModuleNotFoundError")) pattern = "missing_module"
        else if (text.includes("SyntaxError")) pattern = "syntax_error"
        else if (text.includes("ENOENT")) pattern = "file_not_found"
        else if (text.includes("Permission denied")) pattern = "permission_error"
        else if (typeof exitCode === "number" && exitCode !== 0) pattern = "unknown_error"

        if (pattern) {
          const existing = failurePatterns.find(f => f.pattern === pattern)
          if (existing) {
            existing.count++
            existing.lastSeen = new Date().toISOString()
          } else {
            failurePatterns.push({ pattern, count: 1, lastSeen: new Date().toISOString() })
          }

          await saveState()
        }
      }

      // Every 10 tasks, suggest harness improvements
      taskCount++
      if (taskCount % 10 === 0 && failurePatterns.length > 0) {
        const topFailures = failurePatterns
          .sort((a, b) => b.count - a.count)
          .slice(0, 3)

        const suggestion =
          `## Harness Evolution Suggestion\n\n` +
          `Based on the last 10 tasks, the most common failures are:\n` +
          topFailures.map(f => `- ${f.pattern}: ${f.count} occurrences`).join("\n") +
          `\n\nAcross ALL projects, the system has seen:\n` +
          systemPatterns.map(f => `- ${f.pattern}: ${f.count} total`).join("\n") +
          `\n\nConsider adding a rule to AGENTS.md to prevent these failures.\n` +
          `Proposed rule:\n` +
          `- For ${topFailures[0]?.pattern || "unknown"}: Add a specific check or guardrail.\n` +
          `To apply, edit AGENTS.md manually after reviewing this suggestion.`

        output.output = `${output.output || ""}\n\n${suggestion}`

        failurePatterns = []
        await saveState()
      }
    },

    "session.idle": async () => {
      await saveState()
    },
  }
}
