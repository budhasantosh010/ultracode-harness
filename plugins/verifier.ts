import type { Plugin } from "@opencode-ai/plugin"
import { execSync } from "child_process"
import { readFileSync, writeFileSync, existsSync } from "fs"

const CHECK_COMMANDS: Record<string, string> = {
  ts: "npx tsc --noEmit",
  js: "node --check",
  py: "python -m py_compile",
  go: "go vet",
  rs: "cargo check",
}

// Checks that target a single file (others run project-wide).
const PER_FILE_CHECKS = new Set(["js", "py"])

// Self-healing: max converge attempts for compilation fixes
const MAX_CONVERGE_LOOPS = 5

// Track convergence state per file (avoid infinite loops)
const convergeTracker: Record<string, { attempts: number; lastError: string }> = {}

// Best-effort outcome extraction from a `tool.execute.after` output object.
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

export const VerifierPlugin: Plugin = async () => {

  return {
    "tool.execute.after": async (input, output) => {
      // ─── Self-Healing Compilation Check after edit/write ─────────
      if (input.tool === "edit" || input.tool === "write") {
        const filePath = (input.args?.filePath || input.args?.path || "").toString()
        const ext = filePath.split(".").pop()?.toLowerCase()

        if (ext && CHECK_COMMANDS[ext]) {
          const checkCmd = CHECK_COMMANDS[ext]
          const fullCmd = PER_FILE_CHECKS.has(ext) ? `${checkCmd} "${filePath}"` : checkCmd

          let report = ""
          try {
            execSync(fullCmd, {
              encoding: "utf8",
              stdio: ["pipe", "pipe", "pipe"],
              timeout: 60000,
              maxBuffer: 10 * 1024 * 1024,
            })
          } catch (err: any) {
            const out = ((err.stdout?.toString() || "") + (err.stderr?.toString() || "")).trim()
            const toolMissing =
              err?.code === "ENOENT" || err?.status === 127 || err?.status === 9009 ||
              /is not recognized as an internal|command not found/i.test(out)
            if (!toolMissing) report = out || err?.message || ""
          }

          if (report.trim()) {
            // ── SELF-HEALING: Auto-fix compilation errors via converge loop ──
            const errorKey = filePath
            const currentError = report.trim().slice(0, 1000)

            // Track attempts for this file
            if (!convergeTracker[errorKey]) {
              convergeTracker[errorKey] = { attempts: 0, lastError: "" }
            }
            const tracker = convergeTracker[errorKey]
            tracker.attempts++
            tracker.lastError = currentError

            // Report compilation error
            let verifierMsg = `[verifier] COMPILATION ERROR in ${filePath}:\n${currentError}\n`

            // Auto-fix via converge loop (only if not exceeded max attempts)
            if (tracker.attempts <= MAX_CONVERGE_LOOPS) {
              let fixSuccess = false
              let fixedByAgent = false

              try {
                // Spawn fix sub-agent via opencode run
                const fixPrompt = `Fix this compilation error in ${filePath}.\n\nError:\n${currentError}\n\nRead the file, fix the error, and confirm it compiles. Fix ONLY the error — do not change functionality. Keep the fix minimal.`
                execSync(`opencode run "${fixPrompt.replace(/"/g, '\\"')}" --pure --format default`, {
                  encoding: "utf8",
                  timeout: 60000,
                  maxBuffer: 10 * 1024 * 1024,
                })
                fixedByAgent = true

                // Re-check compilation after fix agent
                try {
                  execSync(fullCmd, { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"], timeout: 60000, maxBuffer: 10 * 1024 * 1024 })
                  fixSuccess = true
                } catch { /* still fails, will check on next edit */ }
              } catch { /* agent spawning failed, fall through */ }

              if (fixSuccess) {
                verifierMsg += `✅ [Self-Healing] Auto-fixed compilation error (attempt ${tracker.attempts}/${MAX_CONVERGE_LOOPS}).\n`
                // Reset tracker on success
                delete convergeTracker[errorKey]
              } else {
                const remaining = MAX_CONVERGE_LOOPS - tracker.attempts
                if (remaining > 0) {
                  verifierMsg += `🔄 [Self-Healing] Attempted fix but error persists (${tracker.attempts}/${MAX_CONVERGE_LOOPS}). ${fixedByAgent ? "Fix agent ran — the model should check the file." : "Will retry on next edit."}\n`
                } else {
                  verifierMsg += `⚠️ [Self-Healing] Max converge attempts (${MAX_CONVERGE_LOOPS}) reached for this file. Manual fix required.\n`
                }
              }
            } else {
              verifierMsg += `⚠️ Max converge attempts (${MAX_CONVERGE_LOOPS}) reached. Manual fix required.\n`
            }

            verifierMsg += `Do not proceed until the code compiles cleanly.`
            output.output = `${output.output || ""}\n\n${verifierMsg}`
          } else {
            // Compilation OK — reset converge tracker for this file
            delete convergeTracker[filePath]
          }
        }
      }

      // ─── Test Failure Detection ─────────────────────
      if (input.tool === "bash") {
        const cmd = (input.args?.command || "").toString().toLowerCase()
        const { exitCode, text } = readBashOutcome(output)

        const isTest = /\b(test|pytest|jest|vitest|mocha|cargo test|go test)\b/.test(cmd)
        const looksFailed =
          (typeof exitCode === "number" && exitCode !== 0) ||
          text.includes("FAIL") ||
          text.toLowerCase().includes("failed")

        if (isTest && looksFailed) {
          output.output =
            `${output.output || ""}\n\n[verifier] TESTS FAILED:\n` +
            `${text.slice(0, 1500)}\n` +
            `DIAGNOSE THE ROOT CAUSE. Do not just retry. ` +
            `Read the error, understand WHY it failed, then fix the underlying issue.`
        }
      }

      // ─── General Error Detection ────────────────────
      if (input.tool === "bash") {
        const { exitCode, text } = readBashOutcome(output)

        if (typeof exitCode === "number" && exitCode !== 0) {
          output.output =
            `${output.output || ""}\n\n[verifier] Command failed (exit code ${exitCode}):\n` +
            `${text.slice(0, 1000)}\n` +
            `Diagnose the root cause before retrying.`
        }
      }
    },

    // ─── Compaction: task completion reminder ─────────
    "experimental.session.compacting": async (_input, output) => {
      output.context.push(
        `## Verification Reminder\n` +
        `After compaction, you may have lost context. Before marking any task complete:\n` +
        `1. Re-read the original request\n` +
        `2. Verify ALL parts are done\n` +
        `3. Run compilation checks\n` +
        `4. Run tests if available\n` +
        `5. List what's done vs what remains`
      )
    },
  }
}
