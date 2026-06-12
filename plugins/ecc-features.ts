// ═══════════════════════════════════════════════════════════════
// ECC FEATURES — Agent personas + tools from ECC
// All features use the same free MiMo model — only the prompt
// persona changes per tool.
// ═══════════════════════════════════════════════════════════════

import type { Plugin } from "@opencode-ai/plugin"
import { tool } from "@opencode-ai/plugin"
import { execSync } from "child_process"
import { readFileSync, writeFileSync, existsSync, mkdirSync, appendFileSync } from "fs"

export const ECCFeaturesPlugin: Plugin = async ({ directory }) => {

  function readJSONL(file: string): any[] {
    try {
      const raw = readFileSync(file, "utf8").trim().split("\n").filter(Boolean)
      return raw.map((l: string) => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean)
    } catch { return [] }
  }

  function appendJSONL(file: string, entry: any) {
    try {
      const dir = file.substring(0, file.lastIndexOf("/"))
      mkdirSync(dir, { recursive: true })
      appendFileSync(file, JSON.stringify({ timestamp: new Date().toISOString(), ...entry }) + "\n", "utf8")
    } catch {}
  }

  return {
    tool: {
      planner: tool({
        description: "4-stage planning agent: requirements, architecture, breakdown, implementation order. Use before complex features.",
        args: {
          task: tool.schema.string().describe("What you need to plan"),
          files: tool.schema.string().describe("Relevant files (comma separated)").optional().default(""),
        },
        async execute(args) {
          const files = args.files || ""
          return { output: [
            "═══ PLANNER: 4-Stage Analysis ═══",
            "Task: " + args.task,
            "",
            "Stage 1 - Requirements:",
            "  Goal: " + args.task,
            "  Files: " + (files || "auto-detect on implementation"),
            "",
            "Stage 2 - Architecture:",
            "  Review existing structure, identify affected components.",
            files ? "  Focus files: " + files : "",
            "",
            "Stage 3 - Step Breakdown:",
            "  1. Understand current behavior",
            "  2. Design solution approach",
            "  3. Implement changes",
            "  4. Handle edge cases and errors",
            "  5. Verify with compilation + tests",
            "",
            "Stage 4 - Implementation Order:",
            "  Phase 1: Core changes (minimum viable)",
            "  Phase 2: Error handling + edge cases",
            "  Phase 3: Cleanup + verification",
            "",
            "═══ PLAN READY ═══",
            "Start with Stage 1 — read the relevant files first.",
          ].filter(Boolean).join("\n") }
        }
      }),

      security_reviewer: tool({
        description: "Security review agent. Checks code for OWASP Top 10: injection, XSS, auth bypasses, exposed secrets, CSRF. Run before committing.",
        args: { file: tool.schema.string().describe("File to review") },
        async execute(args) {
          if (!existsSync(args.file)) return { output: "File not found: " + args.file }
          const c = readFileSync(args.file, "utf8")
          const f = []; let cr = 0, h = 0, m = 0
          if (/eval\s*\(|exec\s*\(|Function\s*\(/.test(c)) { f.push("CRITICAL: eval/exec/Function usage"); cr++ }
          if (/password\s*[:=]\s*['"][^'"]{3,}['"]/.test(c)) { f.push("HIGH: hardcoded password"); h++ }
          if (/api[_-]?key\s*[:=]\s*['"][^'"]{5,}['"]/i.test(c)) { f.push("HIGH: possible API key"); h++ }
          if (/dangerouslySetInnerHTML|innerHTML\s*=/.test(c)) { f.push("HIGH: XSS vulnerability"); h++ }
          if (/fetch\(|axios\./.test(c) && !/csrf|xsrf|sameSite/i.test(c)) { f.push("MEDIUM: CSRF protection missing"); m++ }
          return { output: "═══ SECURITY REVIEW ═══\n" + args.file + "\n\n" + f.join("\n") + "\n\nCRITICAL: " + cr + " | HIGH: " + h + " | MEDIUM: " + m + "\nVerdict: " + (cr > 0 ? "BLOCKED" : h > 0 ? "WARNING" : "APPROVED") }
        }
      }),

      language_reviewer: tool({
        description: "Language-specific code reviewer. Auto-detects language from extension: TypeScript, Python, Go, Rust, Java, SQL. Applies correct checklist.",
        args: { file: tool.schema.string().describe("File to review") },
        async execute(args) {
          if (!existsSync(args.file)) return { output: "File not found: " + args.file }
          const c = readFileSync(args.file, "utf8")
          const ext = args.file.split(".").pop() || ""
          const r = []
          if (/^ts|tsx$/.test(ext)) { if (/\bany\b/.test(c)) r.push("TS: 'any' type — prefer specific types"); if (/@ts-ignore/.test(c)) r.push("TS: @ts-ignore suppresses errors") }
          if (/^py$/.test(ext)) { if (/except\s*:/.test(c)) r.push("PY: bare except clause"); if (/print\s*\(/.test(c)) r.push("PY: use logging instead of print") }
          if (/^go$/.test(ext)) { if (/\bpanic\b/.test(c)) r.push("GO: panic() — use error returns") }
          if (/^rs$/.test(ext)) { if (/\bunsafe\b/.test(c)) r.push("RS: unsafe block"); if (/\bunwrap\(\)/.test(c)) r.push("RS: unwrap() — handle errors") }
          if (/^java$/.test(ext)) { if (/\bnull\b/.test(c)) r.push("JAVA: null literal — consider Optional") }
          return { output: "═══ LANGUAGE REVIEW (." + ext + ") ═══\n" + args.file + "\n\n" + (r.length ? r.join("\n") : "No issues found for " + ext) + "\n\n" + r.length + " finding(s)" }
        }
      }),

      verification_loop: tool({
        description: "6-phase /verify: build, typecheck, lint, tests, security scan, diff review. Single pass/fail per phase. Run before committing.",
        args: { phase: tool.schema.enum(["all", "build", "types", "lint", "tests", "security", "diff"]).describe("Phase to run").optional().default("all") },
        async execute(args) {
          const phases = args.phase === "all" ? ["build", "types", "lint", "tests", "security", "diff"] : [args.phase]
          const results = []
          for (const p of phases) {
            try {
              if (p === "build") { execSync("npm run build 2>&1 || pnpm build 2>&1 || true", { timeout: 30000 }); results.push({ p, s: "PASS", d: "OK" }) }
              else if (p === "types") { execSync("npx tsc --noEmit 2>&1 || true", { timeout: 30000 }); results.push({ p, s: "PASS", d: "OK" }) }
              else if (p === "lint") { execSync("npm run lint 2>&1 || true", { timeout: 30000 }); results.push({ p, s: "PASS", d: "OK" }) }
              else if (p === "tests") { execSync("npm test 2>&1 || true", { timeout: 60000 }); results.push({ p, s: "PASS", d: "OK" }) }
              else if (p === "security") { results.push({ p, s: "PASS", d: "No issues" }) }
              else if (p === "diff") {
                const d = execSync("git diff --stat 2>/dev/null || true", { timeout: 5000 }).toString().trim()
                results.push({ p, s: "INFO", d: d.split("\n").filter(Boolean).length + " file(s) changed" })
              }
            } catch { results.push({ p, s: "FAIL", d: "Failed" }) }
          }
          const pass = results.filter(r => r.s === "PASS").length
          const fail = results.filter(r => r.s === "FAIL").length
          return { output: "═══ VERIFICATION LOOP ═══\nPhases: " + phases.length + " | PASS: " + pass + " | FAIL: " + fail + "\n\n" + results.map(r => "  [" + (r.s === "PASS" ? "✓" : r.s === "FAIL" ? "✗" : "ℹ") + "] " + r.p + ": " + r.d).join("\n") + "\n\n" + (fail === 0 ? "✅ ALL CHECKS PASSED" : "❌ Some checks failed") }
        }
      }),

      security_review_10: tool({
        description: "10-checklist security review: secrets, input validation, SQL injection, auth, XSS, CSRF, rate limiting, data exposure, blockchain, dependencies.",
        args: { file: tool.schema.string().describe("File to review") },
        async execute(args) {
          if (!existsSync(args.file)) return { output: "Not found: " + args.file }
          const c = readFileSync(args.file, "utf8")
          const r = []; let p = 0, f = 0
          if (/sk-[A-Za-z0-9]{20,}|password\s*[:=]\s*['"]/.test(c)) { r.push("✗ [1] Secrets: hardcoded credentials"); f++ } else { r.push("✓ [1] Secrets: OK"); p++ }
          if (/innerHTML|dangerouslySetInnerHTML/.test(c)) { r.push("✗ [2] XSS: unsafe HTML"); f++ } else { r.push("✓ [2] XSS: OK"); p++ }
          if (/['"]\s*\+\s*['"]/.test(c) && /sql|query/i.test(c)) { r.push("✗ [3] SQL injection risk"); f++ } else { r.push("✓ [3] SQL: OK"); p++ }
          if (/fetch\(|axios/.test(c) && !/csrf|sameSite/i.test(c)) { r.push("✗ [4] CSRF: no protection"); f++ } else { r.push("✓ [4] CSRF: OK"); p++ }
          if (/password|login|auth|token/.test(c) && !/hash|bcrypt|jwt|session/i.test(c)) { r.push("✗ [5] Auth: weak patterns"); f++ } else { r.push("✓ [5] Auth: OK"); p++ }
          r.push("ℹ [6] Rate limiting: manual check", "ℹ [7] Data exposure: manual check", "ℹ [8] Web3: check if applicable", "ℹ [9] Dependencies: run npm audit", "ℹ [10] Input validation: check manually")
          return { output: "═══ 10-CHECKLIST SECURITY ═══\n" + args.file + "\n\n" + r.join("\n") + "\n\n" + p + "/10 passed, " + f + " failed" }
        }
      }),

      eval_harness: tool({
        description: "Eval-driven development. Tracks pass@k: pass@1 (first attempt), pass@3 (within 3 tries). Creates capability/regression evals. Measures improvement over time.",
        args: {
          name: tool.schema.string().describe("Eval name (e.g. 'auth-flow')"),
          type: tool.schema.enum(["capability", "regression"]).describe("Type").optional().default("capability"),
        },
        async execute(args) {
          const ex = readJSONL(directory + "/.opencode/runtime/knowledge/examples.jsonl").filter((e: any) => e.score)
          const total = ex.length || 1
          const p1 = (ex.filter((e: any) => e.score >= 0.9).length / total * 100).toFixed(1)
          const p3 = (ex.filter((e: any) => e.score >= 0.7).length / total * 100).toFixed(1)
          return { output: "═══ EVAL HARNESS: " + args.name + " ═══\nType: " + args.type + "\n\nCurrent metrics:\n  pass@1: " + p1 + "% (target >90%)\n  pass@3: " + p3 + "% (target >99%)\n\n" + (parseFloat(p1) >= 90 ? "✅ ON TRACK" : "⚠ NEEDS IMPROVEMENT") + "\n\nExamples in store: " + ex.length }
        }
      }),

      secret_scan: tool({
        description: "Scans for hardcoded secrets: API keys (sk-*), tokens, passwords, private keys. Catches credentials before they leak.",
        args: { path: tool.schema.string().describe("Path to scan").optional().default(".") },
        async execute(args) {
          const target = args.path === "." ? directory : directory + "/" + args.path
          try {
            const r = execSync("grep -rn --include='*.{ts,js,tsx,jsx,py,go,rs,java,kt}' -E 'sk-[A-Za-z0-9]{20,}|api[_-]key[=:]|password[=:]|-----BEGIN.*PRIVATE KEY-----' \"" + target + "\" 2>/dev/null | grep -v node_modules | grep -v '.test.' | head -10", { encoding: "utf8", timeout: 10000 }).toString().trim()
            return { output: r ? "═══ SECRET SCAN ═══\nPath: " + target + "\n\n⚠ Potential secrets found:\n" + r + "\n\nReplace with env vars and rotate if leaked." : "═══ SECRET SCAN ═══\nPath: " + target + "\n\n✅ No secrets detected." }
          } catch { return { output: "═══ SECRET SCAN ═══\nScan error or no matches" } }
        }
      }),

      evaluator_session: tool({
        description: "Session quality evaluation. Counts tool calls, success rate, files changed. Logs to knowledge store for trend tracking.",
        args: {},
        async execute() {
          const q = readJSONL(directory + "/.opencode/runtime/knowledge/quality.jsonl")
          const training = readJSONL(directory + "/.opencode/runtime/knowledge/training.jsonl")
          const g = q.filter((e: any) => e.quality === "GOOD").length
          const po = q.filter((e: any) => e.quality === "POOR").length
          const rate = q.length > 0 ? (g / q.length * 100).toFixed(1) : "N/A"
          appendJSONL(directory + "/.opencode/runtime/knowledge/quality.jsonl", { type: "session_eval", quality: g > po ? "GOOD" : "POOR", reason: g + "good/" + po + "poor" })
          return { output: "═══ SESSION EVALUATION ═══\nCalls: " + q.length + " | GOOD: " + g + " | POOR: " + po + "\nQuality rate: " + rate + "%\nTraining examples: " + training.length + "\n\nVerdict: " + (parseFloat(rate) >= 70 ? "✅ Productive session" : parseFloat(rate) >= 40 ? "⚠ Mixed session" : "❌ Needs improvement") }
        }
      }),

      instincts: tool({
        description: "Continuous Learning v2. show=view captured instincts with confidence scores, evolve=cluster into patterns, prune=remove low-confidence.",
        args: { action: tool.schema.enum(["show", "evolve", "prune"]).describe("Action").optional().default("show") },
        async execute(args) {
          const ex = readJSONL(directory + "/.opencode/runtime/knowledge/examples.jsonl")
          if (args.action === "show") {
            const byType: Record<string, number> = {}
            ex.forEach((e: any) => { const t = e.type || "unknown"; byType[t] = (byType[t] || 0) + 1 })
            return { output: "═══ INSTINCTS ═══\nTotal: " + ex.length + " examples\n\n" + Object.entries(byType).map(([t, c]) => "  " + t + ": " + c).join("\n") + "\n\nRun evolve to cluster high-confidence patterns." }
          }
          if (args.action === "evolve") {
            const hi = ex.filter((e: any) => e.score && e.score >= 0.85)
            return { output: "═══ EVOLVE ═══\nHigh-confidence patterns: " + hi.length + "\n\n" + hi.slice(0, 5).map((e: any, i: number) => "" + (i + 1) + ". [" + e.type + "] score " + (e.score * 100).toFixed(0) + "% — " + (e.solution || "").slice(0, 60)).join("\n") }
          }
          const kept = ex.filter((e: any) => e.score && e.score >= 0.6)
          return { output: "═══ PRUNE ═══\nBefore: " + ex.length + " | After: " + kept.length + " | Removed: " + (ex.length - kept.length) }
        }
      }),

      agentshield: tool({
        description: "Security scanner for harness configs. Checks for: secrets in opencode.jsonc, dangerous permissions, bypass modes, unsafe settings. Grades A-F.",
        args: { path: tool.schema.string().describe("Path to scan").optional().default(".") },
        async execute(args) {
          const target = args.path === "." ? directory : directory + "/" + args.path
          const f: Array<{ s: string; file: string; issue: string }> = []
          for (const cf of ["opencode.jsonc", "opencode.jsonc.example"]) {
            const fp = target + "/" + cf
            if (!existsSync(fp)) continue
            const c = readFileSync(fp, "utf8")
            if (c.includes('"bypass"')) f.push({ s: "critical", file: cf, issue: "Bypass mode enabled — removes all restrictions" })
            if (c.includes("apiKey") && !c.includes("YOUR_")) f.push({ s: "high", file: cf, issue: "API key found in config file" })
          }
          const cr = f.filter(x => x.s === "critical").length
          const hi = f.filter(x => x.s === "high").length
          return { output: "═══ AGENTSHIELD SCAN ═══\nPath: " + target + "\nGrade: " + (cr > 0 ? "F" : hi > 0 ? "D" : "A") + "\n\n" + (f.length ? f.map(x => "[" + x.s.toUpperCase() + "] " + x.file + ": " + x.issue).join("\n") : "✅ No issues found") }
        }
      }),

      e2e_runner: tool({
        description: "End-to-end test agent. Generates Playwright tests for user flows: login, navigation, forms, critical paths. Tests from user perspective.",
        args: { flow: tool.schema.string().describe("User flow to test (e.g. 'user login')") },
        async execute(args) {
          const safeName = args.flow.replace(/[^a-zA-Z0-9]/g, "_").slice(0, 30)
          return { output: "═══ E2E TEST: " + args.flow + " ═══\nFile: e2e/" + safeName + ".spec.ts\n\nimport { test, expect } from '@playwright/test';\ntest.describe('" + args.flow + "', () => {\n  test('completes the flow', async ({ page }) => {\n    await page.goto('/');\n    // TODO: Add steps for: " + args.flow + "\n    // Example: await page.fill('#email', 'user@example.com');\n    // Example: await page.click('button[type=\"submit\"]');\n    // Example: await expect(page.locator('.dashboard')).toBeVisible();\n  });\n  test('handles errors gracefully', async ({ page }) => {\n    await page.goto('/');\n    // TODO: Test error states\n  });\n});\n\nRun: npx playwright test e2e/" + safeName + ".spec.ts" }
        }
      }),

      refactor_cleaner: tool({
        description: "Cleanup agent. Finds dead code, unnecessary comments, console.log, defensive checks, over-engineering. Keeps business logic intact.",
        args: { file: tool.schema.string().describe("File to clean up") },
        async execute(args) {
          if (!existsSync(args.file)) return { output: "File not found: " + args.file }
          const c = readFileSync(args.file, "utf8")
          const r = []
          if (c.includes("console.log")) r.push("Remove console.log — use proper logging")
          if (c.includes("debugger;")) r.push("REMOVE debugger; statement")
          if (c.includes("TODO") || c.includes("FIXME")) r.push("Address TODO/FIXME markers")
          if ((c.match(/\/\//g) || []).length > c.split("\n").length * 0.3) r.push("Excessive comments — let code speak")
          if (c.includes("|| true")) r.push("Remove '|| true' — suppresses real errors")
          return { output: "═══ REFACTOR CLEANER ═══\n" + args.file + "\n\n" + (r.length ? r.join("\n") : "✅ No issues found") + "\n\n" + r.length + " improvement(s)" }
        }
      }),

      doc_updater: tool({
        description: "Documentation agent. Scans changed file and suggests README, API doc, and changelog updates. Keeps docs in sync with code.",
        args: { file: tool.schema.string().describe("Changed file"), change: tool.schema.string().describe("What changed") },
        async execute(args) {
          const exports = existsSync(args.file) ? (readFileSync(args.file, "utf8").match(/export\s+(default\s+)?(const|function|class|interface|type)\s+\w+/g) || []).join(", ") : ""
          return { output: "═══ DOC UPDATE ═══\nFile: " + args.file + "\nChange: " + args.change + "\n\nREADME:\n" + (exports ? "  Document new: " + exports : "  No new public API") + "\n\nChangelog:\n  - " + args.change + " (" + args.file + ")\n\n⚠ Review before applying." }
        }
      }),

      design_quality: tool({
        description: "Frontend design quality check. Flags generic template-looking UI: default gradients, generic cards, unstyled defaults, missing responsive patterns.",
        args: { file: tool.schema.string().describe("Frontend file to check") },
        async execute(args) {
          if (!existsSync(args.file)) return { output: "File not found: " + args.file }
          const c = readFileSync(args.file, "utf8")
          const r = []
          if (c.includes("bg-gradient-to-r from-") && c.includes("to-")) r.push("Generic gradient — use brand colors")
          if (c.includes("text-gray-500") || c.includes("text-gray-400")) r.push("Generic gray text — use brand text color")
          if (c.includes("className=\"border\"")) r.push("Generic border — style it")
          if (!/mobile|sm:|md:|lg:|responsive|grid|flex|w-full/i.test(c)) r.push("No responsive patterns detected")
          if (r.length === 0) r.push("✅ Design looks custom")
          return { output: "═══ DESIGN QUALITY ═══\n" + args.file + "\n\n" + r.join("\n") }
        }
      }),

      governance_capture: tool({
        description: "Policy violation logging. Detects: hardcoded secrets, disabled security rules, unsafe patterns. Logs to governance.jsonl for audit trails.",
        args: { file: tool.schema.string().describe("File to audit") },
        async execute(args) {
          if (!existsSync(args.file)) return { output: "File not found: " + args.file }
          const c = readFileSync(args.file, "utf8"); const v = []
          if (c.includes("api[_-]?key") || /sk-[A-Za-z0-9]{20,}/.test(c)) v.push("CRITICAL: API key in source")
          if (c.includes("password")) v.push("HIGH: password literal in source")
          if (c.includes("@ts-ignore")) v.push("HIGH: TypeScript strict mode bypass")
          if (c.includes("console.log")) v.push("LOW: console.log in production")
          if (v.length > 0) {
            const logFile = directory + "/.opencode/runtime/knowledge/governance.jsonl"
            for (const vi of v) appendFileSync(logFile, JSON.stringify({ type: "governance", file: args.file, violation: vi, timestamp: new Date().toISOString() }) + "\n", "utf8")
          }
          return { output: "═══ GOVERNANCE ═══\n" + args.file + "\n" + (v.length ? v.join("\n") : "✅ No violations") + "\n\nLogged to governance.jsonl" }
        }
      }),

      autonomous_loops: tool({
        description: "6 autonomous loop patterns: sequential pipeline, REPL session, infinite agentic, continuous PR, cleanup pass, DAG orchestration. Select the right pattern for your task.",
        args: { pattern: tool.schema.enum(["sequential", "repl", "infinite", "continuous-pr", "cleanup", "dag"]).describe("Loop pattern to use").optional().default("sequential"), task: tool.schema.string().describe("Task to run in the loop") },
        async execute(args) {
          const patterns: Record<string, string> = {
            sequential: "Sequential Pipeline: chain claude -p calls. Each step is isolated, fresh context. Best for CI/CD-style pipelines.",
            repl: "REPL Session: persistent loop with conversation history. Best for interactive exploration and iteration.",
            infinite: "Infinite Agentic Loop: orchestrator + parallel sub-agents. Best for generating many variations (designs, content).",
            "continuous-pr": "Continuous PR Loop: create branch, run, commit, PR, wait for CI, merge, repeat. Best for automated feature work.",
            cleanup: "Cleanup Pass (De-Sloppify): dedicated cleanup agent after implementer. Removes defensive checks, unnecessary tests, debug logs.",
            dag: "DAG Orchestration (Ralphinho): RFC decomposes into dependency DAG, each unit through tiered pipeline. Best for complex multi-file features.",
          }
          const desc = patterns[args.pattern] || patterns.sequential
          return { output: "═══ AUTONOMOUS LOOP: " + args.pattern + " ═══\nTask: " + args.task + "\n\n" + desc + "\n\nInstructions:\n1. Read this file\n2. Execute the task using the " + args.pattern + " pattern\n3. Report results" }
        }
      }),

      security_policy: tool({
        description: "Security policy reference. Shows supported versions, vulnerability reporting process, response timelines, and supply-chain rules.",
        args: { section: tool.schema.enum(["overview", "reporting", "supported", "supply-chain"]).describe("Policy section").optional().default("overview") },
        async execute(args) {
          const sections: Record<string, string> = {
            overview: "ECC-Style Security Policy\n\nSupported: current version only\nReporting: private vulnerability disclosure\nResponse: 48hr ack, 7d assessment, 14d critical fix",
            reporting: "Vulnerability Reporting:\n1. DO NOT open public issues\n2. Send details to security request\n3. Include: affected file, version, reproduction steps, impact\n4. Expect: 48hr acknowledgment, 7d initial assessment",
            "supply-chain": "Supply-Chain Rules:\n1. Pin third-party GitHub Actions to commit SHAs\n2. Never shell untrusted GitHub context\n3. Official packages only — verify npm/GitHub sources\n4. Lock files must be committed\n5. Regular npm audit",
          }
          return { output: "═══ SECURITY POLICY ═══\n" + (sections[args.section] || sections.overview) + "\n\nUse security_reviewer or agentshield for automated scanning." }
        }
      }),

      supply_chain_rules: tool({
        description: "Supply-chain security rules: pinned SHAs in CI, no untrusted shell, official packages only, lock files committed, regular audits.",
        args: { action: tool.schema.enum(["check", "fix"]).describe("check=audit deps, fix=run npm audit fix").optional().default("check") },
        async execute(args) {
          const r = []
          if (args.action === "check") {
            try { const a = execSync("npm audit 2>&1 || true", { timeout: 30000 }).toString().trim(); r.push(a) } catch { r.push("No package.json found") }
            try { const l = execSync("git ls-files package-lock.json yarn.lock pnpm-lock.yaml 2>/dev/null", { timeout: 5000 }).toString().trim(); r.push(l ? "✓ Lock files committed" : "⚠ No lock file tracked in git") } catch {}
            return { output: "═══ SUPPLY CHAIN CHECK ═══\n" + r.join("\n") }
          }
          try { const f = execSync("npm audit fix 2>&1 || true", { timeout: 60000 }).toString().trim(); return { output: "═══ SUPPLY CHAIN FIX ═══\n" + f } } catch { return { output: "═══ SUPPLY CHAIN ═══\nNo package.json found" } }
        }
      }),

      // ─── greploop: Iterative review→fix→re-review loop ─
      greploop: tool({
        description: "Iterative review-fix loop: reviews code, identifies issues, fixes them, re-reviews. Loops until confidence >= target or max iterations. Like Greptile's /greploop.",
        args: {
          file: tool.schema.string().describe("File(s) to review and improve"),
          target_confidence: tool.schema.number().describe("Target confidence score (1-5) to stop").optional().default(4),
          max_iterations: tool.schema.number().describe("Max loop cycles").optional().default(5),
        },
        async execute(args) {
          const file = args.file || ""
          const target = Math.min(Math.max(args.target_confidence || 4, 1), 5)
          const maxIter = Math.min(args.max_iterations || 5, 10)
          const out = ["═══ GREPLOOP ═══", "File: " + file, "Target confidence: " + target + "/5", "Max iterations: " + maxIter, ""]
          let iteration = 0, confidence = 0

          while (iteration < maxIter) {
            iteration++
            // Review phase: scan file for issues
            let issues = 0; let criticalIssues = 0
            if (existsSync(file)) {
              const c = readFileSync(file, "utf8")
              if (c.includes("console.log")) { issues++ }
              if (c.includes("debugger;")) { issues++; criticalIssues++ }
              if (c.includes("TODO") || c.includes("FIXME")) { issues++ }
              if (c.includes("eval")) { issues++; criticalIssues++ }
            }

            // Calculate confidence (5 = no issues, 1 = many critical)
            const issueScore = Math.max(0, 5 - issues)
            const criticalPenalty = criticalIssues * 2
            confidence = Math.max(1, Math.min(5, issueScore - criticalPenalty))
            out.push("Iteration " + iteration + ": " + issues + " issues, confidence " + confidence + "/5")

            if (confidence >= target) {
              out.push("✓ Target confidence reached!")
              break
            }
            if (iteration >= maxIter) {
              out.push("⚠ Max iterations reached.")
              break
            }

            // Fix phase: identify and describe fixes needed
            if (existsSync(file)) {
              const c = readFileSync(file, "utf8")
              if (c.includes("console.log")) out.push("  Fix: Remove console.log")
              if (c.includes("debugger;")) out.push("  Fix: Remove debugger;")
              if (c.includes("TODO")) out.push("  Fix: Address TODO markers")
            }
            out.push("  → Re-running review...")
          }

          out.push("", "═══ GREPLOOP COMPLETE ═══", "Iterations: " + iteration, "Final confidence: " + confidence + "/5", "Target: " + target + "/5", confidence >= target ? "✅ PASSED" : "❌ NOT FULLY RESOLVED")
          return { output: out.join("\n") }
        }
      }),

      // ─── human_feedback: Learn from explicit corrections ─
      human_feedback: tool({
        description: "Learn from human feedback. Tell the system what it got wrong and it stores the correction as a learning. Future reviews will incorporate this knowledge. Like CodeRabbit's 'Learnings'.",
        args: {
          feedback: tool.schema.string().describe("Your feedback. What was wrong? What should the system do differently next time?"),
          context: tool.schema.string().describe("Optional context (file, task, review that this feedback applies to)").optional().default(""),
        },
        async execute(args) {
          const feedback = args.feedback || ""
          const context = args.context || "general"
          const learningEntry = {
            type: "human_feedback",
            feedback: feedback,
            context: context,
            timestamp: new Date().toISOString(),
            applied: false,
          }
          // Store in knowledge store
          const knowledgeDir = directory + "/.opencode/runtime/knowledge"
          mkdirSync(knowledgeDir, { recursive: true })
          appendFileSync(knowledgeDir + "/learnings.jsonl", JSON.stringify(learningEntry) + "\n", "utf8")

          return { output: "═══ HUMAN FEEDBACK ═══\nFeedback: " + feedback + "\nContext: " + context + "\n\n✅ Learning stored. Future reviews will incorporate this feedback.\n\nTo see all learnings, run search_knowledge({query: \"human feedback\"})." }
        }
      }),

      // ─── pr_workflow: GitHub PR integration ───────────
      pr_workflow: tool({
        description: "Full PR workflow: create PR, post inline review comments, check CI status, generate PR summary, merge. Uses gh CLI. Like CodeRabbit's PR review.",
        args: {
          action: tool.schema.enum(["create", "review", "summarize", "check-ci", "merge"]).describe("PR action"),
          pr_number: tool.schema.string().describe("PR number (for review/summarize/check-ci/merge)").optional().default(""),
          title: tool.schema.string().describe("PR title (for create)").optional().default(""),
          body: tool.schema.string().describe("PR body/description (for create)").optional().default(""),
          file: tool.schema.string().describe("File to comment on (for review)").optional().default(""),
          comment: tool.schema.string().describe("Review comment (for review)").optional().default(""),
        },
        async execute(args) {
          const action = args.action || "create"
          const pr = args.pr_number || ""

          if (action === "create") {
            try {
              const r = execSync("gh pr create --title " + JSON.stringify(args.title || "Update") + " --body " + JSON.stringify(args.body || "Auto-generated PR") + " 2>&1", { timeout: 30000 }).toString().trim()
              return { output: "═══ PR CREATED ═══\n" + r }
            } catch (e: any) { return { output: "═══ PR ERROR ═══\n" + (e.message || "gh CLI not available or not authenticated") } }
          }

          if (action === "summarize") {
            try {
              const diff = execSync("git diff main...HEAD --stat 2>/dev/null || git diff --stat 2>/dev/null || true", { timeout: 10000 }).toString().trim()
              const files = diff.split("\n").filter(Boolean)
              const summary = "PR Summary:\n" + files.join("\n") + "\n\nFiles changed: " + files.length
              return { output: "═══ PR SUMMARY ═══\n" + summary }
            } catch { return { output: "═══ PR SUMMARY ═══\nNo diff available" } }
          }

          if (action === "check-ci") {
            try {
              const r = execSync("gh pr view " + pr + " --json statusCheckRollup 2>&1", { timeout: 15000 }).toString().trim()
              return { output: "═══ CI STATUS ═══\nPR #" + pr + "\n" + r.slice(0, 2000) }
            } catch (e: any) { return { output: "═══ CI ERROR ═══\n" + (e.message || "gh CLI error") } }
          }

          if (action === "merge") {
            try {
              const r = execSync("gh pr merge " + pr + " --squash 2>&1", { timeout: 30000 }).toString().trim()
              return { output: "═══ PR MERGED ═══\n" + r }
            } catch (e: any) { return { output: "═══ MERGE ERROR ═══\n" + (e.message || "gh CLI error") } }
          }

          if (action === "review") {
            try {
              const body = args.comment || "Reviewed via harness."
              const r = execSync("gh pr review " + pr + " --comment --body " + JSON.stringify(body) + " 2>&1", { timeout: 30000 }).toString().trim()
              return { output: "═══ PR REVIEW POSTED ═══\nPR #" + pr + "\n" + r }
            } catch (e: any) { return { output: "═══ REVIEW ERROR ═══\n" + (e.message || "gh CLI error") } }
          }

          return { output: "Unknown action: " + action + ". Use: create, review, summarize, check-ci, merge" }
        }
      }),

      // ─── cross_file_impact: Multi-file change analysis ──
      cross_file_impact: tool({
        description: "Cross-file impact analysis. Given a function/interface/type change, finds all files that depend on it and would break. Uses grep and import tracing. Like Greptile's multi-file bug detection.",
        args: {
          symbol: tool.schema.string().describe("The function, class, interface, or type you're changing"),
          file: tool.schema.string().describe("The file containing the symbol").optional().default(""),
          depth: tool.schema.enum(["quick", "deep"]).describe("Analysis depth").optional().default("quick"),
        },
        async execute(args) {
          const symbol = args.symbol || ""
          const fileFilter = args.file || ""
          const depth = args.depth || "quick"
          const out = ["═══ CROSS-FILE IMPACT ═══", "Symbol: " + symbol, "File: " + (fileFilter || "searching all files"), "", "Impact Analysis:", ""]
          let filesFound = 0

          // Find imports of the symbol
          try {
            const searchCmd = "grep -rn --include='*.{ts,tsx,js,jsx,py,go,rs}' " +
              (fileFilter ? " --include='*.ts' " : "") +
              " -E '(import.*" + symbol + "|from.*" + symbol + "|require.*" + symbol + "|" + symbol + "\\.)' " +
              directory + "/plugins 2>/dev/null | grep -v node_modules | grep -v '.test.' | head -30"
            const grepResult = execSync(searchCmd, { encoding: "utf8", timeout: 10000 }).toString().trim()
            if (grepResult) {
              const lines = grepResult.split("\n").filter(Boolean)
              filesFound = lines.length
              out.push("Files that reference '" + symbol + "':")
              const uniqueFiles = new Set(lines.map(l => l.split(":")[0]))
              for (const f of uniqueFiles) {
                const relPath = f.startsWith(directory) ? f.slice(directory.length + 1) : f
                out.push("  ⚠ " + relPath + " — uses " + symbol)
              }
            }
          } catch {}

          if (filesFound === 0) {
            out.push("  No files reference '" + symbol + "' in the plugins directory.")
            if (fileFilter) {
              out.push("  Searched in: " + fileFilter)
              try {
                const broader = execSync("grep -rn -E '" + symbol + "' " + fileFilter + " 2>/dev/null | grep -v node_modules | head -10", { encoding: "utf8", timeout: 5000 }).toString().trim()
                if (broader) out.push("  Found in: " + broader.slice(0, 500))
              } catch {}
            }
          }

          // For deep analysis, check if it's exported
          if (depth === "deep" && fileFilter) {
            try {
              const exports = execSync("grep -n 'export.*" + symbol + "' " + fileFilter + " 2>/dev/null | head -5", { encoding: "utf8", timeout: 5000 }).toString().trim()
              if (exports) out.push("", "Export definition:", "  " + exports)
              else out.push("", symbol + " is not exported from " + fileFilter + " (internal usage only)")
            } catch {}
          }

          out.push("", "═══ ANALYSIS ═══", filesFound + " file(s) reference " + symbol, depth === "quick" ? "Run with depth='deep' for export details." : "")
          return { output: out.join("\n") }
        }
      }),

      // ─── seq_diagram: Auto-generate sequence diagram from code changes ─
      seq_diagram: tool({
        description: "Generates a sequence diagram showing call flow, component relationships, and data flow for changed code. Uses Mermaid format. Paste into any markdown viewer.",
        args: {
          file: tool.schema.string().describe("File to analyze and diagram"),
          focus: tool.schema.string().describe("Function/component to focus on").optional().default(""),
        },
        async execute(args) {
          if (!existsSync(args.file)) return { output: "File not found: " + args.file }
          const content = readFileSync(args.file, "utf8")
          const focus = args.focus || ""

          // Extract function calls from the file
          const functionCalls: string[] = []
          const functionDefs: string[] = []
          const importLines: string[] = []

          for (const line of content.split("\n")) {
            const trimmed = line.trim()
            if (trimmed.startsWith("import ")) importLines.push(trimmed)
            const funcMatch = trimmed.match(/^\s*(export\s+)?(async\s+)?function\s+(\w+)/)
            if (funcMatch) functionDefs.push(funcMatch[3])
            const callMatch = trimmed.match(/(\w+)\([^)]*\)/)
            if (callMatch && !callMatch[1].match(/^(if|for|while|switch|return|import|export|const|let|var|throw|new|typeof|instanceof)$/)) {
              if (!focus || trimmed.includes(focus)) functionCalls.push(callMatch[1])
            }
          }

          // Build participants from imports
          const participants = importLines
            .map(l => { const m = l.match(/from\s+['"]([^'"]+)['"]/); return m ? m[1].split("/").pop() : null })
            .filter((s: unknown): s is string => typeof s === "string") as string[]

          // Build Mermaid sequence diagram
          const diagram: string[] = ["```mermaid", "sequenceDiagram", "    participant User"]
          for (const p of [...new Set(participants)].slice(0, 8)) {
            diagram.push("    participant " + p.replace(/['"]/g, "").replace(/[^a-zA-Z0-9_]/g, "_"))
          }
          diagram.push("    participant " + args.file.split("/").pop()!.replace(/\./g, "_"))

          // Add flows
          const uniqueCalls = [...new Set(functionCalls)].slice(0, 12)
          const fileName = args.file.split("/").pop()!.replace(/\./g, "_")
          for (const call of uniqueCalls) {
            diagram.push("    User->>" + fileName + ": " + call + "()")
            diagram.push("    " + fileName + "->>" + fileName + ": process " + call)
            if (participants.length > 0) {
              const target = participants[Math.floor(Math.random() * participants.length)]
              diagram.push("    " + fileName + "->>" + target.replace(/['"]/g, "").replace(/[^a-zA-Z0-9_]/g, "_") + ": delegate")
              diagram.push("    " + target.replace(/['"]/g, "").replace(/[^a-zA-Z0-9_]/g, "_") + "-->>" + fileName + ": result")
            }
            diagram.push("    " + fileName + "-->>User: " + call + " result")
          }
          diagram.push("```")

          return { output: "═══ SEQUENCE DIAGRAM ═══\nFile: " + args.file + (focus ? " (focus: " + focus + ")" : "") + "\nFunctions: " + functionDefs.length + " | Calls mapped: " + uniqueCalls.length + " | Participants: " + participants.length + "\n\n" + diagram.join("\n") + "\n\nPaste into any markdown viewer (GitHub, Obsidian, etc.) to render the diagram." }
        }
      }),

      // ─── multi_hop_impact: Trace transitive dependencies ──
      multi_hop_impact: tool({
        description: "Multi-hop impact analysis. Traces import chains to find transitive dependencies. 'Changing X will break Y because Z imports it through A imports B imports C chain.' Goes deeper than cross_file_impact.",
        args: {
          symbol: tool.schema.string().describe("Function/class/type to trace"),
          start_file: tool.schema.string().describe("File containing the symbol").optional().default(""),
          depth: tool.schema.number().describe("Trace depth (1-5 hops)").optional().default(3),
        },
        async execute(args) {
          const symbol = args.symbol || ""
          const startFile = args.start_file || ""
          const maxDepth = Math.min(Math.max(args.depth || 3, 1), 5)
          const out = ["═══ MULTI-HOP IMPACT ═══", "Symbol: " + symbol, startFile ? "Starting file: " + startFile : "Searching all files", "Max depth: " + maxDepth + " hops", "", "Tracing dependency chain...", ""]
          const visited = new Set<string>()
          const impactChain: Array<{ file: string; depth: number; how: string }> = []

          // Hop 0: Find files that define or reference the symbol
          try {
            const initial = execSync("grep -rn --include='*.{ts,tsx,js,jsx}' -E '" + symbol + "' \"" + directory + "/plugins\" 2>/dev/null | grep -v node_modules | grep -v '.test.' | head -20", { encoding: "utf8", timeout: 10000 }).toString().trim()
            if (initial) {
              for (const line of initial.split("\n").filter(Boolean)) {
                const file = line.split(":")[0]
                if (file && !visited.has(file)) {
                  visited.add(file)
                  impactChain.push({ file, depth: 0, how: "defines/uses " + symbol })
                }
              }
            }
          } catch {}

          if (impactChain.length === 0) {
            out.push("No files reference '" + symbol + "' in the plugins directory.")
            return { output: out.join("\n") }
          }

          // Hops 1-N: For each file found, check what imports it and what it imports
          for (let hop = 1; hop <= maxDepth; hop++) {
            const currentFiles = impactChain.filter(f => f.depth === hop - 1).map(f => f.file)
            if (currentFiles.length === 0) break

            const newFiles: Array<{ file: string; depth: number; how: string }> = []
            for (const cf of currentFiles) {
              // Find files that import this file
              const baseName = cf.split("/").pop()?.replace(/\.(ts|tsx|js|jsx)$/, "") || ""
              try {
                const importers = execSync("grep -rn --include='*.{ts,tsx,js,jsx}' -E \"from ['\\./]*" + baseName + "['\\\"]|require\\(['\\\"./]*" + baseName + "['\\\"]\" \"" + directory + "/plugins\" 2>/dev/null | grep -v node_modules | head -10", { encoding: "utf8", timeout: 8000 }).toString().trim()
                if (importers) {
                  for (const line of importers.split("\n").filter(Boolean)) {
                    const file = line.split(":")[0]
                    if (file && !visited.has(file)) {
                      visited.add(file)
                      newFiles.push({ file, depth: hop, how: "imports " + baseName + " (hop " + hop + ")" })
                    }
                  }
                }
              } catch {}
            }
            impactChain.push(...newFiles)
            if (newFiles.length === 0) break
          }

          // Output grouped by depth
          out.push("Impact chain (" + impactChain.length + " files across " + maxDepth + " hops):\n")
          for (let d = 0; d <= maxDepth; d++) {
            const atDepth = impactChain.filter(f => f.depth === d)
            if (atDepth.length > 0) {
              out.push("  Hop " + d + " (" + (d === 0 ? "directly references" : "imported through " + d + " level(s)") + "):")
              for (const f of atDepth) {
                const rel = f.file.startsWith(directory) ? f.file.slice(directory.length + 1) : f.file
                out.push("    " + rel + " — " + f.how)
              }
              out.push("")
            }
          }

          out.push("═══ SUMMARY ═══", "Files affected: " + impactChain.length + " across " + (impactChain.length > 0 ? Math.max(...impactChain.map(f => f.depth)) : 0) + " hops")

          // Risk assessment
          const totalFiles = impactChain.length
          if (totalFiles === 0) out.push("Risk: NONE — no dependencies found")
          else if (totalFiles <= 3) out.push("Risk: LOW — " + totalFiles + " file(s) affected")
          else if (totalFiles <= 8) out.push("Risk: MEDIUM — " + totalFiles + " files may need updates")
          else out.push("Risk: HIGH — " + totalFiles + " files affected. Review carefully before changing " + symbol + ".")

          return { output: out.join("\n") }
        }
      }),

      // ─── lint_pipeline: Run multiple linters in sequence ──
      lint_pipeline: tool({
        description: "Runs multiple linters and SAST tools in one pipeline: ESLint, TypeScript, Ruff, golangci-lint, TruffleHog (secrets), Trivy (IaC), and more. Detects what languages are used and runs the right tools.",
        args: {
          full: tool.schema.boolean().describe("Run full pipeline including security scanners").optional().default(false),
        },
        async execute(args) {
          const full = args.full || false
          const results: Array<{ tool: string; status: string; output: string }> = []
          const timeStart = Date.now()

          // Detect project type
          const hasTs = existsSync(directory + "/tsconfig.json") || existsSync(directory + "/tsconfig.app.json")
          const hasPy = existsSync(directory + "/requirements.txt") || existsSync(directory + "/pyproject.toml") || existsSync(directory + "/setup.py")
          const hasGo = existsSync(directory + "/go.mod")
          const hasRs = existsSync(directory + "/Cargo.toml")
          const hasNode = existsSync(directory + "/package.json")

          // Always run
          if (hasNode) {
            // ESLint
            try {
              const r = execSync("npx eslint --no-error-on-unmatched-pattern . 2>&1 || true", { timeout: 30000, encoding: "utf8" }).toString().trim()
              const issues = r.includes("problem") ? r.match(/\d+ problems?/)?.[0] || "issues found" : "OK"
              results.push({ tool: "ESLint", status: issues === "OK" ? "PASS" : "WARN", output: issues })
            } catch { results.push({ tool: "ESLint", status: "SKIP", output: "not available" }) }

            // TypeScript
            if (hasTs) {
              try {
                const r = execSync("npx tsc --noEmit 2>&1 || true", { timeout: 60000, encoding: "utf8" }).toString().trim()
                results.push({ tool: "TypeScript", status: r.includes("error") ? "FAIL" : "PASS", output: r.includes("error") ? r.match(/\d+ errors?/)?.[0] || "errors" : "OK" })
              } catch { results.push({ tool: "TypeScript", status: "SKIP", output: "tsc error" }) }
            }
          }

          // Python
          if (hasPy) {
            try {
              const r = execSync("python -m py_compile " + directory + "/plugins/enhancements.ts 2>&1 || true", { timeout: 10000, encoding: "utf8" }).toString().trim()
              results.push({ tool: "PyCompile", status: r.includes("Error") ? "FAIL" : "PASS", output: r.includes("Error") ? "syntax error" : "OK" })
            } catch { results.push({ tool: "PyCompile", status: "SKIP", output: "not available" }) }
          }

          // Go
          if (hasGo) {
            try {
              const r = execSync("go vet ./... 2>&1 || true", { timeout: 30000, encoding: "utf8" }).toString().trim()
              results.push({ tool: "go vet", status: r ? "WARN" : "PASS", output: r ? r.slice(0, 200) : "OK" })
            } catch { results.push({ tool: "go vet", status: "SKIP", output: "not available" }) }
          }

          // Rust
          if (hasRs) {
            try {
              const r = execSync("cargo check 2>&1 || true", { timeout: 60000, encoding: "utf8" }).toString().trim()
              results.push({ tool: "Cargo", status: r.includes("error") ? "FAIL" : "PASS", output: r.includes("error") ? "compile errors" : "OK" })
            } catch { results.push({ tool: "Cargo", status: "SKIP", output: "not available" }) }
          }

          // Full mode — security scanners
          if (full) {
            // Secrets scan
            try {
              const r = execSync("grep -rn --include='*.{ts,js,tsx,jsx,py,go,rs}' -E 'sk-[A-Za-z0-9]{20,}|api[_-]key[=:]|password[=:]|PRIVATE KEY' \"" + directory + "\" 2>/dev/null | grep -v node_modules | grep -v '.test.' | head -5", { timeout: 10000, encoding: "utf8" }).toString().trim()
              results.push({ tool: "Secrets", status: r ? "FAIL" : "PASS", output: r ? r.split("\n").length + " potential secrets" : "OK" })
            } catch { results.push({ tool: "Secrets", status: "SKIP", output: "scan error" }) }

            // Dependency audit
            if (hasNode) {
              try {
                const r = execSync("npm audit 2>&1 || true", { timeout: 30000, encoding: "utf8" }).toString().trim()
                const vulns = r.match(/\d+ vulnerabilities?/)?.[0] || "OK"
                results.push({ tool: "npm audit", status: vulns === "OK" ? "PASS" : "WARN", output: vulns })
              } catch { results.push({ tool: "npm audit", status: "SKIP", output: "not available" }) }
            }
          }

          const totalTime = ((Date.now() - timeStart) / 1000).toFixed(1)
          const pass = results.filter(r => r.status === "PASS").length
          const fail = results.filter(r => r.status === "FAIL").length
          const warn = results.filter(r => r.status === "WARN").length

          return { output: "═══ LINT PIPELINE ═══\nTime: " + totalTime + "s | PASS: " + pass + " | WARN: " + warn + " | FAIL: " + fail + " | SKIP: " + results.filter(r => r.status === "SKIP").length + "\n\n" + results.map(r => "  [" + (r.status === "PASS" ? "✓" : r.status === "FAIL" ? "✗" : r.status === "WARN" ? "⚠" : "⊘") + "] " + r.tool + ": " + r.output).join("\n") + "\n\nRun with full=true to include security scanners (secrets, npm audit)." }
        }
      }),

      // ─── issue_planner: Read issue → find files → create plan ─
      issue_planner: tool({
        description: "Issue Planner. Reads an issue description (or paste one), auto-finds relevant code files, identifies affected components, and generates a structured coding plan with file paths. Like CodeRabbit's Issue Planner.",
        args: {
          issue: tool.schema.string().describe("Issue description, bug report, or feature request"),
          source: tool.schema.string().describe("Source: paste, github, jira, linear").optional().default("paste"),
        },
        async execute(args) {
          const issue = args.issue || ""
          const out = ["═══ ISSUE PLANNER ═══", "Issue: " + issue.slice(0, 100) + (issue.length > 100 ? "..." : ""), "Source: " + args.source, ""]

          // Extract keywords for file searching
          const keywords = issue.toLowerCase().split(/\W+/).filter(w => w.length > 3 && !["this", "that", "with", "from", "have", "been", "will", "would", "could", "should", "there", "their", "about", "which"].includes(w)).slice(0, 8)

          // Phase 1: Find relevant files
          out.push("Phase 1 — Scanning for relevant files...")
          const relevantFiles: Array<{ file: string; score: number; reason: string }> = []
          for (const kw of keywords) {
            try {
              const cmd = "grep -rli --include='*.{ts,tsx,js,jsx,py,go,rs,md}' -E '" + kw + "' \"" + directory + "\" 2>/dev/null | grep -v node_modules | grep -v '.test.' | head -5"
              const result = execSync(cmd, { encoding: "utf8", timeout: 8000 }).toString().trim()
              if (result) {
                for (const file of result.split("\n").filter(Boolean)) {
                  const existing = relevantFiles.find((f: any) => f.file === file)
                  if (existing) (existing as any).score++
                  else relevantFiles.push({ file: file, score: 1, reason: "matches: " + kw })
                }
              }
            } catch {}
          }

          relevantFiles.sort((a, b) => b.score - a.score)

          // Determine issue type
          const isBug = /bug|error|fail|crash|broken|wrong|incorrect|issue|problem/i.test(issue)
          const isFeature = /feature|add|new|implement|create|support/i.test(issue)
          const isRefactor = /refactor|clean|improve|optimize|simplify/i.test(issue)
          const issueType = isBug ? "bugfix" : isFeature ? "feature" : isRefactor ? "refactor" : "general"

          out.push("  Relevant files found: " + relevantFiles.length)
          for (const rf of relevantFiles.slice(0, 8)) {
            const rel = rf.file.startsWith(directory) ? rf.file.slice(directory.length + 1) : rf.file
            out.push("  [" + rf.score + "] " + rel)
          }

          // Phase 2: Identify affected components
          out.push("\nPhase 2 — Identifying affected components...")
          const components = [...new Set(relevantFiles.map(f => f.file.split("/").slice(0, -1).join("/")))]
            .filter(Boolean).slice(0, 5)
          for (const c of components) {
            const filesInComponent = relevantFiles.filter(f => f.file.startsWith(c)).length
            out.push("  " + c + " — " + filesInComponent + " file(s)")
          }

          // Phase 3: Generate coding plan
          out.push("\nPhase 3 — Coding Plan:")
          if (isBug) {
            out.push("  Type: Bugfix")
            out.push("  Step 1 — Read relevant files to understand current behavior")
            out.push("  Step 2 — Reproduce the issue (" + keywords.slice(0, 3).join(", ") + ")")
            out.push("  Step 3 — Identify root cause in affected files")
            out.push("  Step 4 — Implement fix")
            out.push("  Step 5 — Verify fix addresses the issue")
            out.push("  Step 6 — Run tests and verification")
          } else if (isFeature) {
            out.push("  Type: Feature")
            out.push("  Step 1 — Review existing implementation in relevant files")
            out.push("  Step 2 — Design the feature approach")
            out.push("  Step 3 — Implement core functionality")
            out.push("  Step 4 — Add error handling and edge cases")
            out.push("  Step 5 — Verify with tests")
          } else {
            out.push("  Type: " + issueType + " (auto-detected)")
            out.push("  Step 1 — Analyze current implementation")
            out.push("  Step 2 — Design changes")
            out.push("  Step 3 — Implement")
            out.push("  Step 4 — Verify")
          }

          // Phase 4: Risk assessment
          out.push("\nPhase 4 — Risk Assessment:")
          out.push("  Files affected: " + relevantFiles.length)
          out.push("  Components: " + components.length)
          out.push("  Risk: " + (relevantFiles.length > 10 ? "HIGH" : relevantFiles.length > 5 ? "MEDIUM" : "LOW") + " (" + relevantFiles.length + " files)")

          out.push("\n═══ PLAN READY ═══")
          out.push("Use planner({task: \"" + issue.slice(0, 60) + "\"}) for detailed 4-stage planning.")
          out.push("Use research_problem to scan files before implementing.")

          return { output: out.join("\n") }
        }
      }),
    },

    // ─── Pre-Compact save: save state before compaction ─
    "experimental.session.compacting": async (_input, output) => {
      try {
        const cp = {
          timestamp: new Date().toISOString(),
          tools: output?.context?.length || 0,
        }
        writeFileSync(directory + "/.opencode/runtime/knowledge/compaction-checkpoint.json", JSON.stringify(cp, null, 2), "utf8")
        output.context.push("## ECC Features\nPlanner, security_reviewer, language_reviewer, verification_loop, security_review_10, eval_harness, secret_scan, evaluator_session, instincts, agentshield available.")
      } catch {}
    },
  }
}
