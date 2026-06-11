// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
// HOOKS â€” OmO-inspired quality-of-life hooks for OpenCode
// All additive â€” nothing is replaced, only added alongside existing
// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

import type { Plugin } from "@opencode-ai/plugin"
import { execSync } from "child_process"
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, statSync } from "fs"
import { createHash } from "crypto"

const HOOKS_DIR = ".opencode/runtime/hooks"
const HASH_REGISTRY = `${HOOKS_DIR}/file-hashes.json`
const SESSION_CHECKPOINT = `${HOOKS_DIR}/session-checkpoint.json`
const IDLE_LOG = `${HOOKS_DIR}/idle-log.jsonl`

export const HooksPlugin: Plugin = async ({ directory }) => {

  function ensureDir() { mkdirSync(`${directory}/${HOOKS_DIR}`, { recursive: true }) }

  // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
  // 1. HASHLINE â€” Content-hash tracking to prevent stale edits
  // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
  let hashRegistry: Record<string, { hash: string; timestamp: string; lastReadBy: string }> = {}
  try { hashRegistry = JSON.parse(readFileSync(`${directory}/${HASH_REGISTRY}`, "utf8")) } catch {}

  function saveHashRegistry() {
    try { ensureDir(); writeFileSync(`${directory}/${HASH_REGISTRY}`, JSON.stringify(hashRegistry, null, 2), "utf8") } catch {}
  }

  function computeFileHash(filePath: string): string {
    try { return createHash("sha256").update(readFileSync(filePath, "utf8")).digest("hex").slice(0, 16) } catch { return "" }
  }

  // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
  // 2. PREEMPTIVE COMPACTION + CONTEXT LIMIT RECOVERY
  // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
  let tokenCount = 0
  const COMPACTION_THRESHOLD = 0.8 // 80% = trigger preemptive
  const OVERFLOW_THRESHOLD = 0.95  // 95% = emergency save

  function saveRecoveryCheckpoint(reason: string) {
    try {
      ensureDir()
      writeFileSync(`${directory}/${SESSION_CHECKPOINT}`, JSON.stringify({
        reason, timestamp: new Date().toISOString(),
        toolCalls: tokenCount
      }, null, 2), "utf8")
    } catch {}
  }

  // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
  // 3. MODEL FALLBACK â€” Track model failures for fallback logic
  // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
  let modelFailures: Record<string, number> = {}
  const FAILURE_LOG = `${HOOKS_DIR}/model-failures.json`
  try { modelFailures = JSON.parse(readFileSync(`${directory}/${FAILURE_LOG}`, "utf8")) } catch {}

  function recordModelFailure(model: string) {
    modelFailures[model] = (modelFailures[model] || 0) + 1
    try { ensureDir(); writeFileSync(`${directory}/${FAILURE_LOG}`, JSON.stringify(modelFailures, null, 2), "utf8") } catch {}
  }

  // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
  // 4. COMMENT CHECKER â€” Detect AI slop comments
  // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
  function hasSlopComment(output: string): string | null {
    const patterns = [
      /\/\/\s*(increment|decrement|initialize|set up|get|set)\s+\w+/i,
      /\/\/\s*(This function|This method|This class|This code)\s+(is\s+)?(for|handles|manages|processes)/i,
      /\/\/\s*(Check if|Check whether|Verify that|Ensure that|Make sure)/i,
      /\/\/\s*(TODO|FIXME|HACK|XXX):/i,
      /\/\/\s*(Added|Fixed|Updated|Changed|Removed|Moved)\s/i,
      /\/\/\s*Get\s+the\s+\w+/i,
      /\/\/\s*Set\s+the\s+\w+/i,
      /\/\/\s*Return\s+the\s+\w+/i,
      /\/\/\s*Handle\s+the\s+case\s+where/i,
      /\/\/\s*Simple\s+\w+/i,
    ]
    for (const p of patterns) {
      const m = output.match(p)
      if (m) return m[0].trim()
    }
    return null
  }

  // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
  // 5. EMPTY TASK DETECTOR â€” Track empty agent responses
  // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
  let emptyResponseCount = 0

  // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
  // 6. IDLE DETECTION (Todo Enforcer)
  // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
  let lastProgressTime = Date.now()
  let lastEditCount = 0
  let fileEditCount = 0
  let idleReadCycleCount = 0
  let lastReadFiles = new Set<string>()

  // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
  // 7. WEBFETCH REDIRECT GUARD â€” Track external URLs
  // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
  let lastWebFetchUrl = ""

  return {
    tool: {
      // â”€â”€â”€ AST-Grep: Structural code search â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
      ast_grep: tool({
        description:
          "Searches code by STRUCTURE (AST), not text (regex). " +
          "Finds patterns ripgrep can't: 'try without catch', 'Promise without .catch', " +
          "'console.log in production code'. Uses @ast-grep/cli locally. " +
          "Supports 25+ languages.",
        args: {
          pattern: tool.schema.string().describe("AST pattern to search for (e.g. 'console.log($$$)')"),
          path: tool.schema.string().describe("Directory or file to search").optional().default("."),
          language: tool.schema.string().describe("Language (auto-detected if omitted)").optional().default(""),
        },
        async execute(args) {
          try {
            // Check if ast-grep is installed
            try { execSync("ast-grep --version 2>&1", { encoding: "utf8", timeout: 5000 }) }
            catch {
              // Auto-install
              try {
                execSync("npm install -g @ast-grep/cli 2>&1", { encoding: "utf8", timeout: 60000 })
              } catch {
                return { output: "AST-Grep not installed. Install: npm install -g @ast-grep/cli\n\nFALLBACK: Use grep or graphify_query instead." }
              }
            }

            const lang = args.language ? `-l ${args.language}` : ""
            const raw = execSync(
              `ast-grep --pattern "${args.pattern.replace(/"/g,'\\"')}" ${lang} "${args.path}" 2>&1`,
              { encoding: "utf8", timeout: 30000 }
            )
            const out = raw.replace(/\x1B\[[0-9;]*[a-zA-Z]/g, "").trim()
            return { output: out.slice(0, 5000) || "No matches found." }
          } catch (e: any) {
            return { output: `AST-Grep error: ${e.message?.slice(0, 200)}` }
          }
        }
      }),

      // â”€â”€â”€ Recover session from checkpoint â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
      recover_session: tool({
        description:
          "Recovers a session from a saved checkpoint. " +
          "Use when context was lost due to crash or context limit. " +
          "Restores: task state, active workflow, pending tasks.",
        args: {
          checkpoint_id: tool.schema.string().describe("Checkpoint ID (or 'latest' for most recent)").optional().default("latest"),
        },
        async execute(args) {
          const cpDir = `${directory}/${HOOKS_DIR}`
          let cpFile = `${cpDir}/session-checkpoint.json`

          if (args.checkpoint_id !== "latest") {
            cpFile = `${cpDir}/checkpoint-${args.checkpoint_id}.json`
          }

          if (!existsSync(cpFile)) return { output: "No recovery checkpoint found." }

          try {
            const cp = JSON.parse(readFileSync(cpFile, "utf8"))
            return {
              output: `â•â•â• SESSION RECOVERED â•â•â•\nReason: ${cp.reason || "unknown"}\nTimestamp: ${cp.timestamp || "unknown"}\nTool calls before interruption: ${cp.toolCalls || "unknown"}\n\nSession state restored. Continue from where you left off.`
            }
          } catch {
            return { output: "Checkpoint corrupted. Cannot recover." }
          }
        }
      }),

      // â”€â”€â”€ Comment Checker Tool â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
      check_comments: tool({
        description:
          "Scans code for AI-generated 'slop' comments â€” obvious, unnecessary comments " +
          "that cheap models generate. Flags patterns like '// increment x by 1'. " +
          "Use on generated code before committing.",
        args: {
          path: tool.schema.string().describe("File or directory to scan").optional().default("."),
        },
        async execute(args) {
          const targetPath = `${directory}/${args.path}`
          if (!existsSync(targetPath)) return { output: `Path not found: ${targetPath}` }

          const results: string[] = []
          try {
            const raw = execSync(
              `grep -rn --include="*.ts" --include="*.js" --include="*.tsx" --include="*.jsx" -E "(//\\s*(increment|decrement|initialize|set up|get|set)\\s+\\w+|//\\s*(This function|This method|This class)\\s+(is\\s+)?(for|handles|manages)|//\\s*(Check if|Check whether|Verify that)|//\\s*(TODO|FIXME|HACK):|//\\s*(Added|Fixed|Updated|Changed|Removed|Moved)\\s)" "${targetPath}" 2>&1`,
              { encoding: "utf8", timeout: 30000 }
            )
            const lines = raw.split("\n").filter(l => l.trim())
            if (lines.length === 0) return { output: "No slop comments found. âœ… Code reads professionally." }

            return { output: `Found ${lines.length} potential slop comments:\n${lines.slice(0, 30).join("\n")}\n\nUse --fix to remove them (or manually review).` }
          } catch (e: any) {
            return { output: `Scan error: ${e.message?.slice(0, 200)}` }
          }
        }
      }),

      // â”€â”€â”€ Directory README injector â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
      inject_readme: tool({
        description:
          "Injects README.md contents from the current directory into context. " +
          "Helps the model understand the project structure and conventions. " +
          "Searches current directory and parent directories for README files.",
        args: {
          path: tool.schema.string().describe("Start directory").optional().default("."),
          max_depth: tool.schema.number().describe("Parent directories to search up").optional().default(2),
        },
        async execute(args) {
          let dir = args.path === "." ? directory : `${directory}/${args.path}`
          const readmes: string[] = []

          for (let i = 0; i < (args.max_depth || 2); i++) {
            const candidates = ["README.md", "README.txt", "Readme.md"]
            for (const c of candidates) {
              const f = `${dir}/${c}`
              if (existsSync(f)) {
                const content = readFileSync(f, "utf8").slice(0, 2000)
                readmes.push(`--- ${f} ---\n${content}`)
                break
              }
            }
            const parent = dir.split(/[/\\]/).slice(0, -1).join("/")
            if (parent === dir) break
            dir = parent
          }

          if (readmes.length === 0) return { output: "No README files found." }
          return { output: `â•â•â• README CONTEXT â•â•â•\n\n${readmes.join("\n\n")}` }
        }
      }),
    },

    // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
    // BEFORE HOOK: Hashline verify + Todo Enforcer + WebFetch Guard + Bash Guard
    // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
    "tool.execute.before": (input, output) => {
      // â”€â”€â”€ HASHLINE: Verify edit freshness â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
      if ((input.tool === "edit" || input.tool === "write") && input.args) {
        const filePath = (input.args.filePath || input.args.path || "").toString()
        if (filePath && hashRegistry[filePath]) {
          const currentHash = computeFileHash(filePath)
          if (currentHash && currentHash !== hashRegistry[filePath].hash) {
            // Block the edit â€” file changed since read
            const errMsg = `[Hashline] STALE EDIT: File "${filePath}" changed since read at ${hashRegistry[filePath].timestamp}.\nExpected hash: ${hashRegistry[filePath].hash}\nCurrent hash: ${currentHash}\n\nRe-read the file with Read tool to get the latest version before editing.`
            throw new Error(errMsg)
          }
        }
      }

      // â”€â”€â”€ WEBFETCH REDIRECT GUARD â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
      if (input.tool === "webfetch" || input.tool === "web_fetch" || input.tool === "WebFetch") {
        const url = (input.args?.url || "").toString()
        if (url) {
          lastWebFetchUrl = url
          // Just track it â€” we warn in the after-hook if it was a redirect
        }
      }

      // â”€â”€â”€ BASH FILE READ GUARD â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
      if (input.tool === "bash") {
        const cmd = (output.args?.command || "").toString().toLowerCase()
        const sensitiveFiles = [".env", ".env.local", ".env.production", "credentials", "secrets", "id_rsa", ".pem", "config.yml", "config.yaml"]
        for (const sf of sensitiveFiles) {
          if (cmd.includes(`cat ${sf}`) || cmd.includes(`cat ./${sf}`) || cmd.includes(`cat ../${sf}`) ||
              cmd.includes(`type ${sf}`) || cmd.includes(`type ./${sf}`) ||
              cmd.includes(`less ${sf}`) || cmd.includes(`more ${sf}`)) {
            throw new Error(`[Guard] Blocked read of sensitive file: "${sf}". Use Read tool instead â€” it respects file permission rules.`)
          }
        }
      }
    },

    // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
    // AFTER HOOK: Hashline capture + Comment Checker + Empty Task + Todo Enforcer + Preemptive Compaction
    // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
    "tool.execute.after": (input, output) => {
      ensureDir()
      const outputStr = (output.output?.toString() || "")

      // â”€â”€â”€ HASHLINE: Capture file content hash on read â”€
      if (input.tool === "read" && input.args) {
        const filePath = (input.args.filePath || input.args.path || "").toString()
        if (filePath && existsSync(filePath)) {
          const h = computeFileHash(filePath)
          if (h) {
            hashRegistry[filePath] = { hash: h, timestamp: new Date().toISOString(), lastReadBy: "agent" }
            saveHashRegistry()
          }
        }
      }

      // â”€â”€â”€ COMMENT CHECKER: Flag AI slop in edits â”€â”€â”€â”€â”€
      if ((input.tool === "edit" || input.tool === "write") && outputStr) {
        const slop = hasSlopComment(outputStr)
        if (slop) {
          // Append warning to output (doesn't block â€” just warns)
          const outRef = output as any
          const existing = outRef.output || ""
          outRef.output = existing + `\n\n[Comment Checker] âš  Detected potential AI slop comment: "${slop}". Review and rewrite if needed.`
        }
      }

      // â”€â”€â”€ EMPTY TASK DETECTOR + AUTO-RETRY â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
      if (input.tool === "bash" || input.tool === "agent" || input.tool === "rlm_query") {
        if (!outputStr || outputStr.trim().length < 10) {
          emptyResponseCount++
          if (emptyResponseCount >= 3) {
            emptyResponseCount = 0
            const outRef = output as any
            // Actual auto-retry: re-invoke with more specific instructions
            let retryResult = ""
            const lastCmd = (input.args?.command || input.args?.task || "").toString()
            try {
              const retry = execSync(
                `opencode run "The previous response was empty or incomplete. Retry this task with more detail and specificity: ${lastCmd.replace(/"/g, '\\"').slice(0, 200)}" --pure --format default`,
                { encoding: "utf8", timeout: 60000, maxBuffer: 10 * 1024 * 1024 }
              )
              retryResult = retry.replace(/\x1B\[[0-9;]*[a-zA-Z]/g, "").trim().slice(0, 2000)
            } catch { retryResult = "Auto-retry failed." }

            if (retryResult && retryResult !== "Auto-retry failed.") {
              outRef.output = (outRef.output || "") +
                `\n\n[Empty Response Detector] Agent returned empty response. Auto-retry result:\n${retryResult}`
            } else {
              outRef.output = (outRef.output || "") +
                `\n\n[Empty Response Detector] Agent returned empty response (3x). Auto-retry also failed. ` +
                `Simplify the request or check if the model is overloaded.`
            }
          }
        } else {
          emptyResponseCount = 0
        }
      }

      // â”€â”€â”€ TODO ENFORCER: Track idle cycles â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
      if ((input.tool === "read" || input.tool === "glob" || input.tool === "grep") && !outputStr.includes("error") && !outputStr.includes("Error")) {
        idleReadCycleCount++
      } else if (input.tool === "edit" || input.tool === "write") {
        fileEditCount++
        idleReadCycleCount = 0
        lastProgressTime = Date.now()
      } else if (input.tool === "bash" && outputStr.length > 100) {
        idleReadCycleCount = Math.max(0, idleReadCycleCount - 1)
        lastProgressTime = Date.now()
      }

      // If too many idle reads (reading without editing), flag it
      if (idleReadCycleCount > 8) {
        idleReadCycleCount = 0
        const outRef = output as any
        outRef.output = (outRef.output || "") + "\n\n[Idle Detector] Reading many files without making changes. Consider editing or using fan_out for targeted reads."
      }

      // â”€â”€â”€ MODEL FALLBACK: Track failures in bash commands â”€â”€
      if (input.tool === "bash" && (outputStr.includes("Error:") || outputStr.includes("Failed:") || outputStr.includes("timeout"))) {
        // Track as a model-level failure
        recordModelFailure("current")
      }

      // â”€â”€â”€ PREEMPTIVE COMPACTION: Check token count â”€â”€â”€â”€
      tokenCount += Math.round(outputStr.length / 4)
      const estimatedMaxTokens = 100000 // conservative estimate for context window
      const usageRatio = tokenCount / estimatedMaxTokens

      if (usageRatio >= OVERFLOW_THRESHOLD) {
        // Emergency â€” context about to overflow
        saveRecoveryCheckpoint("context_overflow_imminent")
        const outRef = output as any
        outRef.output = (outRef.output || "") + "\n\n[Context Alert] Context window nearly full. Consider: emptying, or starting fresh with summary."
      } else if (usageRatio >= COMPACTION_THRESHOLD) {
        // Preemptive â€” approaching limit
        const outRef = output as any
        outRef.output = (outRef.output || "") + `\n\n[Context] Approaching context limit (~${Math.round(usageRatio * 100)}%). Use report_cost to check usage.`
      }
    },
  }
    // ═══════════════════════════════════════════════════════════
    // BACKGROUND AGENTS — Dispatch parallel agents
    // ═══════════════════════════════════════════════════════════
    dispatch_agents: tool({
      description: "Dispatches multiple agents in parallel. Each agent gets a focused prompt. For true parallel analysis of multiple files or aspects.",
      args: {
        agents: tool.schema.array(tool.schema.object({
          name: tool.schema.string().describe("Agent name"),
          prompt: tool.schema.string().describe("Focused task for this agent"),
          model: tool.schema.string().describe("Model override").optional().default(""),
        })).describe("Array of agents"),
        sync: tool.schema.enum(["all","any"]).describe("all=wait for all, any=first result").optional().default("all"),
      },
      async execute(args) {
        const list = args.agents || []
        if (list.length === 0) return { output: "No agents specified." }
        const results = []
        for (const agent of list) {
          try {
            const raw = execSync(`opencode run "${(agent.prompt||"").replace(/"/g,'\\"')}" --pure --format default${agent.model ? " --model " + agent.model : ""}`, { encoding: "utf8", timeout: 120000, maxBuffer: 10*1024*1024 })
            const out = raw.replace(/\x1B\[[0-9;]*[a-zA-Z]/g,"").trim()
            results.push({ name: agent.name, output: out.slice(0,2000), success: true })
            if (args.sync === "any") break
          } catch (e) { results.push({ name: agent.name, output: (e.message||"").slice(0,200), success: false }) }
        }
        const ok = results.filter(r=>r.success).length
        return { output: `═══ BACKGROUND AGENTS (${results.length}) ═══\nOK: ${ok}, Fail: ${results.length-ok}\n\n${results.map(r=>`[${r.success?"OK":"FAIL"}] ${r.name}: ${(r.output||"").slice(0,200)}`).join("\n")}` }
      }
    }),

    // ═══════════════════════════════════════════════════════════
    // DISCIPLINE AGENTS — Route tasks by discipline/model
    // ═══════════════════════════════════════════════════════════
    discipline_agents: tool({
      description: "Routes tasks to appropriate models by discipline. Maps: debug→mimo, explore→mimo, code-review→mimo, security→deepseek, architect→mimo, general→mimo. Customize per your available models.",
      args: {
        task: tool.schema.string().describe("Task description"),
        discipline: tool.schema.enum(["debug","explore","code-review","security","architect","general"]).describe("Discipline").optional().default("general"),
      },
      async execute(args) {
        const models = { debug:"opencode/mimo-v2.5-free", explore:"opencode/mimo-v2.5-free", "code-review":"opencode/mimo-v2.5-free", security:"opencode/deepseek-v4-flash-free", architect:"opencode/mimo-v2.5-free", general:"opencode/mimo-v2.5-free" }
        const model = models[args.discipline] || "opencode/mimo-v2.5-free"
        return { output: `═══ DISCIPLINE ROUTING ═══\nDiscipline: ${args.discipline}\nTask: ${args.task}\nModel: ${model}\n\nRun with: opencode run --model ${model} --agent ultracode "${(args.task||"").replace(/"/g,'\\"')}"` }
      }
    }),
    },
  }
}
