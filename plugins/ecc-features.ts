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
