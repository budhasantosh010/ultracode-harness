import type { Plugin } from "@opencode-ai/plugin"
import { mkdirSync } from "fs"
import { readFile, writeFile } from "fs/promises"
import { execSync } from "child_process"

const EVOLUTION_LOG = ".opencode/evolution_log.json"
const SYSTEM_EVOLUTION_LOG = "C:/Users/Lenovo/.config/opencode/evolution_log.json"

// Auto-repair configurations for known failure patterns
const AUTO_FIXES: Record<string, { action: string; fixFn: (cmd: string, pattern: any, directory: string) => string | null }> = {
  missing_module: {
    action: "auto-install (npm install)",
    fixFn: (cmd, pattern, directory) => {
      // Extract the module name from the error
      const moduleMatch = cmd.match(/Cannot find module ['"]([^'"]+)['"]|Module not found: Error: Can't resolve ['"]([^'"]+)['"]/i)
      const moduleName = moduleMatch?.[1] || moduleMatch?.[2]
      if (moduleName && !moduleName.startsWith(".") && !moduleName.startsWith("/")) {
        return `npm install "${moduleName}"`
      }
      return null
    }
  },
  file_not_found: {
    action: "check-file-exists",
    fixFn: (cmd, pattern, directory) => {
      // Parse the missing file path from the error
      const pathMatch = cmd.match(/ENOENT.*?['"]([^'"]+)['"]|Cannot find (module|file) ['"]([^'"]+)['"]/i)
      if (pathMatch?.[1] || pathMatch?.[3]) return "manual: check file path"
      return null
    }
  },
  syntax_error: {
    action: "check-syntax",
    fixFn: () => null // Can't auto-fix syntax errors — too varied
  },
  permission_error: {
    action: "check-permissions",
    fixFn: () => "manual: chmod or run as administrator"
  },
}

// Track which patterns have been auto-fixed this session (avoid re-fixing)
const autoFixedThisSession = new Set<string>()

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

          // ── MISTAKE-DRIVEN AUTO-REPAIR ──
          // If pattern count >= 2 and has auto-fix, execute the fix
          if (!autoFixedThisSession.has(pattern)) {
            const count = failurePatterns.find(f => f.pattern === pattern)?.count || 1
            const autoFix = AUTO_FIXES[pattern]

            if (autoFix && count >= 2) {
              autoFixedThisSession.add(pattern)
              const cmd = (input.args?.command || "").toString()
              const fixAction = autoFix.fixFn(cmd, pattern, directory)

              if (fixAction && !fixAction.startsWith("manual:")) {
                try {
                  execSync(fixAction, { encoding: "utf8", timeout: 30000 })
                  const outRef = output as any
                  outRef.output = (outRef.output || "") +
                    `\n\n[Mistake Repair] Detected repeated "${pattern}" (${count}x). Auto-fixed: ${fixAction}`
                } catch (e: any) {
                  const outRef = output as any
                  outRef.output = (outRef.output || "") +
                    `\n\n[Mistake Repair] Tried to fix "${pattern}" (${count}x) but fix failed: ${e.message?.slice(0, 200)}`
                }
              } else if (fixAction?.startsWith("manual:")) {
                const outRef = output as any
                outRef.output = (outRef.output || "") +
                  `\n\n[Mistake Repair] Detected repeated "${pattern}" (${count}x). ${fixAction.slice(7)}`
              }
            }
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

    

    // === MISTAKE LEARNER: Inject lessons into context ===
    "experimental.session.compacting": async (_input, output) => {
      try {
        const state = await readFile(`${directory}/${EVOLUTION_LOG}`, "utf8")
        const parsed = JSON.parse(state)
        const patterns = parsed.failurePatterns || []
        if (patterns.length > 0) {
          const sorted = patterns.sort((a: any, b: any) => b.count - a.count).slice(0, 5)
          const lessons = sorted.map((f: any) => 
            `- ${f.pattern}: occurred ${f.count} times (last: ${f.lastSeen?.slice(0, 10) || "?"})`
          ).join("
")
          output.context.push(
            `## Lessons Learned from Previous Sessions
${lessons}

Avoid repeating these patterns.`
          )
        }
      } catch {}
    },

    "session.idle": async () => {
      await saveState()
    },
  }
}
