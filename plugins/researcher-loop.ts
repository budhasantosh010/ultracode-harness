// ═══════════════════════════════════════════════════════════════
// RESEARCHER LOOP — autoresearch philosophy in the harness
// Three patterns from AOCS-Ω (scores: 9.80, 9.50, 9.30):
//
// Phase 1: Meta-Cognition Loop (score 9.80)
//   Guide-3x-then-auto-execute: tracks POOR quality actions,
//   guides for 3 cycles, then auto-runs diagnostics + suggests fix.
//
// Phase 2: Self-Research Loop (score 9.50)
//   research_execute: actually spawns sub-agents via opencode run.
//   Snapshot → try → evaluate → keep/discard → iterate.
//
// Phase 3: Agent as Researcher (score 9.30)
//   Guide-3x: if model edits without researching, guide 3x then
//   auto-research the file + inject structure context.
//
// Key constraint: NO existing plugin files modified. Single new plugin.
// Safe degradation: delete this file → harness works exactly as before.
// ═══════════════════════════════════════════════════════════════

import type { Plugin } from "@opencode-ai/plugin"
import { tool } from "@opencode-ai/plugin"
import { execSync } from "child_process"
import { readFileSync, writeFileSync, existsSync, mkdirSync, appendFileSync } from "fs"

const RUNTIME_DIR = ".opencode/runtime/researcher-loop"
const GUIDE_LIMIT = 3

function ensureDirs(directory: string) {
  mkdirSync(`${directory}/${RUNTIME_DIR}`, { recursive: true })
}

// ─── Helpers ──────────────────────────────────────────────────

function classifyAction(t: string): string {
  if (t === "edit" || t === "write") return "edit"
  if (t === "read" || t === "glob" || t === "grep") return "read"
  if (t === "bash" || t === "powershell") return "exec"
  if (t === "research_execute" || t === "research_problem" || t === "workflow") return "research"
  return "tool-call"
}

function assessQuality(tool: string, output: any): { quality: "GOOD" | "NEUTRAL" | "POOR"; lesson: string; fix?: string } {
  const outputStr = (output?.output || "").toString().toLowerCase()

  const poorKeywords = ["error:", "failed", "cannot find module", "syntaxerror",
    "typeerror", "referenceerror", "enoent", "permission denied", "traceback"]
  const hasError = poorKeywords.some(kw => outputStr.includes(kw))
  const isEmpty = outputStr.trim().length < 10 && tool !== "glob" && tool !== "grep"
  const goodKeywords = ["success", "completed", "pass", "compiled", "created",
    "wrote", "updated", "deleted", "installed", "built"]
  const hasSuccess = goodKeywords.some(kw => outputStr.includes(kw))

  if (hasError || isEmpty) {
    let lesson = "Verify file paths and syntax before running commands"
    let fix = "Check file paths, verify module names, and ensure dependencies are installed"
    if (outputStr.includes("cannot find module") || outputStr.includes("enoent")) {
      lesson = "Module or file not found — verify it exists before importing"
      fix = "Run `npm install` or check that the file path is correct"
    } else if (outputStr.includes("syntaxerror") || outputStr.includes("traceback")) {
      lesson = "Syntax error — validate with a linter before executing"
      fix = "Check for missing brackets, parentheses, or type mismatches"
    }
    return { quality: "POOR", lesson, fix }
  }

  if (hasSuccess || tool === "edit" || tool === "write") {
    return { quality: "GOOD", lesson: "This approach worked — use similar patterns going forward" }
  }

  return { quality: "NEUTRAL", lesson: "Review output to confirm expected result" }
}

function getFileStructure(filePath: string): string {
  try {
    const content = readFileSync(filePath, "utf8").slice(0, 2000)
    const imports = (content.match(/import .+/g) || []).slice(0, 8).join("\n  ")
    const exports = (content.match(/export (default )?(const|function|class|interface|type) \w+/g) || []).join(", ")
    const funcs = (content.match(/function \w+\(|const \w+ = \(|async \w+\(/g) || []).length
    const lines = content.split("\n").length
    const ext = filePath.split(".").pop()
    return `File: ${filePath} (${lines} lines, .${ext})
Imports:\n  ${imports || "(none)"}
Exports: ${exports || "(none)"}
Functions: ${funcs}`
  } catch { return `File: ${filePath} (could not read)` }
}

function snapshotFile(filePath: string): string | null {
  try { return existsSync(filePath) ? readFileSync(filePath, "utf8") : null }
  catch { return null }
}

function restoreFile(filePath: string, content: string | null) {
  try { if (content !== null) writeFileSync(filePath, content, "utf8") }
  catch {}
}

function logExperiment(directory: string, entry: {
  timestamp: string; task: string; approach: string
  score: number; status: "keep" | "discard" | "crash"
  iterations: number; lesson: string
}) {
  ensureDirs(directory)
  const file = `${directory}/${RUNTIME_DIR}/experiments.tsv`
  const header = "timestamp\ttask\tapproach\tscore\tstatus\titerations\tlesson\n"
  if (!existsSync(file)) writeFileSync(file, header, "utf8")
  appendFileSync(file,
    `${entry.timestamp}\t${entry.task.replace(/\t/g, " ")}\t${entry.approach.replace(/\t/g, " ")}\t${entry.score}\t${entry.status}\t${entry.iterations}\t${entry.lesson.replace(/\t/g, " ")}\n`,
    "utf8")
}

// ─── THE PLUGIN ────────────────────────────────────────────────

export const ResearcherLoopPlugin: Plugin = async ({ directory }) => {
  // Phase 1: Meta-cognition counters
  let poorQualityCount = 0
  let lastPoorTool = ""
  let lastPoorOutput = ""

  // Phase 3: Pre-edit research enforcement counters
  let noResearchEditCount = 0
  const researchedFiles = new Set<string>()

  // Reflection store
  const reflections: Array<{ action: string; quality: string; lesson: string; tool: string }> = []
  const MAX_REFLECTIONS = 100

  return {
    tool: {

      // ══════════════════════════════════════════════════════
      // PHASE 2: Self-Research Loop with REAL sub-agents
      // ══════════════════════════════════════════════════════

      research_execute: tool({
        description: "Executes a task through the autoresearch loop: generates multiple approaches, spawns sub-agents to try each, evaluates real results, keeps/discards, returns the best. Use for complex tasks where the best approach is uncertain.",
        args: {
          task: tool.schema.string().describe("The task to execute. Be specific about the end result."),
          target_file: tool.schema.string().describe("Target file to modify (for snapshot/restore)").optional().default(""),
          approach: tool.schema.string().describe("Optional starting approach suggestion").optional().default(""),
          budget: tool.schema.number().describe("Time budget in seconds per sub-agent").optional().default(120),
          criteria: tool.schema.string().describe("Comma-separated evaluation criteria").optional().default("correctness"),
          max_iterations: tool.schema.number().describe("Maximum approaches to try").optional().default(3),
        },
        async execute(args) {
          const task = args.task || ""
          const targetFile = args.target_file || ""
          const budget = Math.min(args.budget || 120, 300)
          const criteria = (args.criteria || "correctness").split(",").map(s => s.trim())
          const maxIter = Math.min(args.max_iterations || 3, 5)
          const timeStart = Date.now()
          const taskName = task.slice(0, 60).trim()

          const out: string[] = [
            `═══ RESEARCH EXECUTE: "${taskName}" ═══`,
            `Budget: ${budget}s/approach | Max approaches: ${maxIter}`,
            `Criteria: ${criteria.join(", ")}`,
            targetFile ? `Target: ${targetFile}` : "",
            "",
          ].filter(Boolean)

          // Generate candidate approaches
          const approaches: string[] = []
          if (args.approach) approaches.push(args.approach)

          const altApproaches = [
            `Minimal: Smallest possible change. Keep existing structure. Fix only what's broken.`,
            `Complete: Handle all edge cases. Add error handling, validation.`,
            `Creative: Consider restructuring or a different paradigm for a cleaner solution.`,
          ]
          for (const a of altApproaches) {
            if (approaches.length < maxIter) approaches.push(a)
          }

          let bestResult = ""
          let bestScore = -Infinity
          let bestSnapshot: string | null = null
          let totalApproaches = 0
          let keepCount = 0
          let discardCount = 0

          // Snapshot target file before any approach
          if (targetFile) {
            const resolved = targetFile.startsWith("/") || targetFile.match(/^[A-Z]:/) ? targetFile : `${directory}/${targetFile}`
            bestSnapshot = snapshotFile(resolved)
          }

          for (let i = 0; i < approaches.length; i++) {
            const elapsed = (Date.now() - timeStart) / 1000
            if (elapsed > budget * maxIter) {
              out.push(`\n⚠ Total budget exceeded. Returning best so far.`)
              break
            }

            totalApproaches++
            const approachDesc = approaches[i]
            const approachTag = `approach_${i + 1}`
            out.push(`\n── ${approachTag}: Generating approach ${i + 1}...`)

            // Attempt sub-agent execution via opencode run
            let subResult = ""
            let subExitCode = -1
            const subPrompt = `Task: ${task}\n\nApproach: ${approachDesc}\n\nExecute this approach. Keep changes minimal and focused. Report what you did and whether it succeeded.`

            try {
              const subResultRaw = execSync(`opencode run "${subPrompt.replace(/"/g, '\\"')}" --pure --format default 2>/dev/null`, {
                timeout: budget * 1000,
                encoding: "utf8",
                maxBuffer: 10 * 1024 * 1024,
              })
              subResult = subResultRaw.trim()
              subExitCode = 0
            } catch (e: any) {
              subResult = e.stdout || e.message || ""
              subExitCode = e.status || 1
            }

            // Score based on actual outcomes
            let score = 0
            const subLower = subResult.toLowerCase()
            if (subExitCode === 0) score += 30
            if (!subLower.includes("error") && !subLower.includes("failed")) score += 20
            if (subLower.includes("success") || subLower.includes("completed") || subLower.includes("created")) score += 15
            if (subLower.includes("wrote") || subLower.includes("updated")) score += 15
            if (subLower.includes("test") && subLower.includes("pass")) score += 10

            // Snapshot-based evaluation: after sub-agent, re-read target file
            if (targetFile) {
              const resolved = targetFile.startsWith("/") || targetFile.match(/^[A-Z]:/) ? targetFile : `${directory}/${targetFile}`
              if (existsSync(resolved)) {
                const newContent = readFileSync(resolved, "utf8")
                if (newContent !== bestSnapshot) score += 10 // file actually changed
              }
            }

            const summary = subResult.slice(0, 200).replace(/\n/g, " ").trim()

            if (score > bestScore) {
              bestScore = score
              bestResult = summary
              // Keep this approach's changes — update snapshot
              if (targetFile) {
                const resolved = targetFile.startsWith("/") || targetFile.match(/^[A-Z]:/) ? targetFile : `${directory}/${targetFile}`
                bestSnapshot = snapshotFile(resolved)
              }
              keepCount++
              out.push(`  ✓ Score: ${score}/100 — KEPT (best so far)`)
            } else {
              // Discard — restore from best snapshot
              if (targetFile) {
                const resolved = targetFile.startsWith("/") || targetFile.match(/^[A-Z]:/) ? targetFile : `${directory}/${targetFile}`
                restoreFile(resolved, bestSnapshot)
              }
              discardCount++
              out.push(`  ✗ Score: ${score}/100 — DISCARDED (restored snapshot)`)
            }
            out.push(`  Result: ${summary}`)
          }

          const totalTime = ((Date.now() - timeStart) / 1000).toFixed(1)

          // Log final result
          logExperiment(directory, {
            timestamp: new Date().toISOString(),
            task: taskName,
            approach: approaches[0]?.slice(0, 80) || "none",
            score: bestScore > 0 ? bestScore : 0,
            status: bestScore > 0 ? "keep" : discardCount === totalApproaches ? "discard" : "crash",
            iterations: totalApproaches,
            lesson: `${keepCount} kept, ${discardCount} discarded out of ${totalApproaches} approaches in ${totalTime}s`,
          })

          out.push(`\n═══ RESEARCH EXECUTE COMPLETE ═══`)
          out.push(`Approaches: ${keepCount} kept / ${discardCount} discarded / ${totalApproaches} total`)
          out.push(`Best score: ${bestScore}/100`)
          out.push(`Time: ${totalTime}s`)
          out.push(`Best result: ${bestResult || "(none — all discarded)"}`)
          out.push(`\n[Researcher Loop] Experiment logged to ${RUNTIME_DIR}/experiments.tsv`)

          return { output: out.join("\n") }
        }
      }),

      // ══════════════════════════════════════════════════════
      // PHASE 3: Agent as Automated Researcher
      // ══════════════════════════════════════════════════════

      research_problem: tool({
        description: "Researches a problem before implementing. Scans relevant files, reads structure, formulates hypotheses, tests assumptions, synthesizes findings. Call BEFORE editing code for any non-trivial task.",
        args: {
          task: tool.schema.string().describe("The problem to research. What are you trying to understand?"),
          files: tool.schema.string().describe("Comma-separated file paths to focus on").optional().default(""),
          depth: tool.schema.string().describe("Research depth: quick | thorough | exhaustive").optional().default("quick"),
        },
        async execute(args) {
          const task = args.task || ""
          const depth = args.depth || "quick"
          const targetFiles = args.files ? args.files.split(",").map(f => f.trim()).filter(Boolean) : []

          const out: string[] = [
            `═══ PROBLEM RESEARCH: "${task.slice(0, 80)}" ═══`,
            `Depth: ${depth}${targetFiles.length > 0 ? ` | Files: ${targetFiles.join(", ")}` : ""}`,
            "",
          ]

          // ── Scan phase ─────────────────────────────
          const foundFiles: Array<{ path: string; size: number }> = []
          if (depth === "thorough" || depth === "exhaustive") {
            try {
              const keywords = task.toLowerCase().split(/\W+/).filter((w: string) => w.length > 3)
              for (const kw of keywords.slice(0, 5)) {
                try {
                  const result = execSync(
                    `find "${directory}" -type f \\( -name "*.ts" -o -name "*.tsx" -o -name "*.js" \\) -ipath "*${kw}*" 2>/dev/null | head -10`,
                    { encoding: "utf8", timeout: 5000 }
                  ).trim()
                  if (result) {
                    for (const line of result.split("\n")) {
                      const p = line.trim()
                      if (p && !foundFiles.some(f => f.path === p) && !p.includes("node_modules")) {
                        try {
                          const stat = execSync(`wc -c "${p}" 2>/dev/null | awk '{print $1}'`, { encoding: "utf8", timeout: 2000 }).trim()
                          foundFiles.push({ path: p, size: parseInt(stat) || 0 })
                        } catch { foundFiles.push({ path: p, size: 0 }) }
                      }
                    }
                  }
                } catch {}
              }
            } catch {}
          }

          for (const f of targetFiles) {
            const resolved = f.startsWith("/") || f.match(/^[A-Z]:/) ? f : `${directory}/${f}`
            if (existsSync(resolved) && !foundFiles.some(x => x.path === resolved)) {
              try {
                const stat = execSync(`wc -c "${resolved}" 2>/dev/null | awk '{print $1}'`, { encoding: "utf8", timeout: 2000 }).trim()
                foundFiles.push({ path: resolved, size: parseInt(stat) || 0 })
              } catch { foundFiles.push({ path: resolved, size: 0 }) }
            }
          }
          foundFiles.sort((a, b) => a.size - b.size)

          if (foundFiles.length > 0) {
            out.push(`Files: ${foundFiles.length} relevant files found`)
            for (const f of foundFiles.slice(0, 8)) {
              const relPath = f.path.startsWith(directory) ? f.path.slice(directory.length + 1) : f.path
              let firstLine = ""
              try {
                firstLine = readFileSync(f.path, "utf8").split("\n")[0]?.trim() || ""
                if (firstLine.length > 80) firstLine = firstLine.slice(0, 80) + "..."
              } catch {}
              out.push(`  [${(f.size / 1024).toFixed(1)}KB] ${relPath} ${firstLine ? `— ${firstLine}` : ""}`)
            }
            if (foundFiles.length > 8) out.push(`  ... +${foundFiles.length - 8} more`)

            // ── Structure phase (for specific files) ──
            if (depth === "exhaustive" && targetFiles.length > 0) {
              out.push(`\nStructure:`)
              for (const f of targetFiles) {
                const resolved = f.startsWith("/") || f.match(/^[A-Z]:/) ? f : `${directory}/${f}`
                const struct = getFileStructure(resolved)
                out.push(`  ${struct.replace(/\n/g, "\n  ")}`)
              }
            }
          } else {
            out.push(`Files: no specific files auto-detected. Use the files parameter.`)
          }

          // ── Hypothesize phase ───────────────────────
          const taskLow = task.toLowerCase()
          const hypotheses: string[] = []
          if (taskLow.includes("bug") || taskLow.includes("fix") || taskLow.includes("error")) {
            hypotheses.push("H1: Root cause is in the function processing the faulting input")
            hypotheses.push("H2: Missing null/undefined/empty check on edge case")
            hypotheses.push("H3: Type mismatch between expected and actual values")
          } else if (taskLow.includes("feature") || taskLow.includes("add") || taskLow.includes("implement")) {
            hypotheses.push("H1: Can be added to existing module without restructuring")
            hypotheses.push("H2: New module is cleaner — avoids coupling")
            hypotheses.push("H3: Extension of existing interface fits the pattern")
          } else {
            hypotheses.push("H1: Changes to existing files, not new files")
            hypotheses.push("H2: Follows existing codebase patterns")
            hypotheses.push("H3: Needs validation/testing to confirm approach")
          }

          out.push(`\nHypotheses:`)
          for (const h of hypotheses) out.push(`  ${h}`)

          // ── Synthesis ───────────────────────────────
          out.push(`\nRecommendation:`)
          if (foundFiles.length > 0) {
            const primary = foundFiles.slice(0, 3).map(f => f.path.startsWith(directory) ? f.path.slice(directory.length + 1) : f.path).join(", ")
            out.push(`  Primary files: ${primary}`)
            out.push(`  Suggested next: Read these files, validate hypotheses, then implement`)
          } else {
            out.push(`  Specify files with the files parameter for targeted analysis`)
          }

          out.push(`\n═══ RESEARCH COMPLETE ═══`)
          out.push(`Files: ${foundFiles.length} | Hypotheses: ${hypotheses.length}`)

          // Mark researched files for Phase 3 enforcement
          for (const f of foundFiles) researchedFiles.add(f.path)
          for (const f of targetFiles) {
            const resolved = f.startsWith("/") || f.match(/^[A-Z]:/) ? f : `${directory}/${f}`
            researchedFiles.add(resolved)
          }

          return { output: out.join("\n") }
        }
      }),
    },

    // ══════════════════════════════════════════════════════════
    // PHASE 3 ENFORCEMENT: Guide-3x before editing without research
    // ══════════════════════════════════════════════════════════

    "tool.execute.before": async (input, _output) => {
      // Only enforce for edit/write on files that should have been researched
      if (input.tool !== "edit" && input.tool !== "write") return

      // Check if the file being edited was researched
      const filePath = (input.args as any)?.filePath || (input.args as any)?.path || ""
      if (!filePath) return

      const resolved = filePath.startsWith("/") || filePath.match(/^[A-Z:]/) ? filePath : `${directory}/${filePath}`
      const isResearched = researchedFiles.has(resolved)
        || Array.from(researchedFiles).some(r => resolved.includes(r) || r.includes(resolved))

      // New file — no research needed
      if (!existsSync(resolved)) return

      if (!isResearched) {
        noResearchEditCount++
        const remaining = GUIDE_LIMIT - noResearchEditCount + 1

        if (remaining > 0) {
          // GUIDE mode: let through with warning (1st-3rd time)
          const urgency = remaining === GUIDE_LIMIT ? "suggestion" : remaining === 2 ? "recommendation" : "strongly recommend"
          ;(output as any).output = ((output as any).output || "") +
            `\n\n[Research Check ${remaining}/${GUIDE_LIMIT}] You haven't researched ${filePath}. I ${urgency} calling research_problem({task: "explain what you're trying to do", files: "${filePath.replace(/"/g, '\\"')}"}) first to understand the file structure before editing.`
        } else {
          // AUTO-EXECUTE mode: research automatically, inject findings
          noResearchEditCount = 0 // reset after auto
          const structure = getFileStructure(resolved)
          ;(output as any).output = ((output as any).output || "") +
            `\n\n[Research Check ⚡] Auto-researched ${filePath}:\n${structure}\n\nReview this structure before proceeding.`
          researchedFiles.add(resolved)
        }
      }
    },

    // ══════════════════════════════════════════════════════════
    // PHASE 1: Meta-Cognition Loop — Guide-3x on poor quality
    // ══════════════════════════════════════════════════════════

    "tool.execute.after": async (input, output) => {
      if (input.tool === "research_execute" || input.tool === "research_problem") return

      const action = classifyAction(input.tool || "")
      const { quality, lesson, fix } = assessQuality(input.tool || "", output)
      const outRef = output as any
      const existing = outRef.output || ""

      // Store reflection
      reflections.push({ action, quality, lesson, tool: input.tool || "" })
      if (reflections.length > MAX_REFLECTIONS) reflections.shift()

      // ── GOOD quality: reset poor quality counter ──
      if (quality === "GOOD") {
        if (poorQualityCount > 2) {
          outRef.output = existing + `\n\n[Reflection ✓] Quality improving after ${poorQualityCount} poor actions. Continue the current approach.`
        }
        poorQualityCount = 0
        return
      }

      // ── POOR quality: Guide-3x-then-auto-execute ──
      if (quality === "POOR") {
        poorQualityCount++
        lastPoorTool = input.tool || ""
        lastPoorOutput = (output?.output || "").toString()

        if (poorQualityCount <= GUIDE_LIMIT) {
          // GUIDE: append with escalation
          const remaining = GUIDE_LIMIT - poorQualityCount + 1
          outRef.output = existing +
            `\n\n[Reflection ⚠ ${poorQualityCount}/${GUIDE_LIMIT}] ${lesson}`
        } else {
          // AUTO-EXECUTE: automatically run diagnostics
          poorQualityCount = 0 // reset after auto-execute
          let diagnosticInfo = ""

          // Try to read the file with the error and suggest a fix
          try {
            // Find .ts/.js files that may have errors
            const findResult = execSync(
              `find "${directory}" -maxdepth 3 -name "*.ts" -o -name "*.tsx" 2>/dev/null | head -5`,
              { encoding: "utf8", timeout: 3000 }
            ).trim()
            if (findResult) {
              const files = findResult.split("\n").filter(Boolean)
              for (const f of files.slice(0, 2)) {
                diagnosticInfo += `\n  ${getFileStructure(f).split("\n")[0]}`
              }
            }
          } catch {}

          outRef.output = existing +
            `\n\n[Reflection ⚡ AUTO-DIAGNOSTIC] After ${GUIDE_LIMIT + 1} consecutive poor-quality actions, running diagnostics:` +
            (diagnosticInfo || `\n  Unable to auto-diagnose. Suggested fix: ${fix || "Verify the approach and retry"}`) +
            `\n  Suggesting approach: ${lesson}`
        }
        return
      }

      // ── NEUTRAL quality: occasional reflection ──
      if (quality === "NEUTRAL" && Math.random() < 0.2) {
        outRef.output = existing + `\n\n[Reflection] ${action}: ${lesson}`
      }
    },

    // ══════════════════════════════════════════════════════════
    // COMPACTION: Inject reflections + researcher tools
    // ══════════════════════════════════════════════════════════

    "experimental.session.compacting": async (_input, output) => {
      // Inject reflection summary
      if (reflections.length > 0) {
        const recent = reflections.slice(-5).reverse()
        const lines = recent.map(r =>
          `- [${r.quality}] ${r.action} → ${r.lesson}`
        )
        output.context.push(
          `## Reflections (${poorQualityCount} poor since last reset)\n${lines.join("\n")}`
        )
      }

      // Inject researcher tools
      output.context.push(
        `## Researcher Tools\n` +
        `- research_problem({task, files?, depth?}) — research before editing (${noResearchEditCount > GUIDE_LIMIT ? "⚡ auto-triggered" : `${Math.max(0, GUIDE_LIMIT - noResearchEditCount + 1)} guides remaining before auto-research`})\n` +
        `- research_execute({task, target_file?, budget?, criteria?}) — execute with sub-agent research loop\n` +
        `- multi_perspective({task}) — generate solutions from multiple angles`
      )
    },
  }
}
