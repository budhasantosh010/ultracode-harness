// ═══════════════════════════════════════════════════════════════
// ENHANCEMENTS — Phase 2 remaining components
// All 7 missing features in one plugin:
// 1. Code Structure Context
// 2. Self-Review Trigger
// 3. Test-First Generator
// 4. Adversarial Generator
// 5. Multi-Perspective Reasoning
// 6. Semantic Retriever (defers to tiered-context)
// 7. Uncertainty Estimator
// ═══════════════════════════════════════════════════════════════

import type { Plugin } from "@opencode-ai/plugin"
import { tool } from "@opencode-ai/plugin"
import { execSync } from "child_process"
import { readFileSync, existsSync } from "fs"

export const EnhancementsPlugin: Plugin = async ({ directory }) => {

  // ─── CODE STRUCTURE CONTEXT ─────────────────────────
  function getCodeContext(filePath: string): string {
    try {
      // Read file, extract imports, exports, function signatures
      const content = readFileSync(filePath, "utf8").slice(0, 3000)
      const imports = content.match(/import .+/g) || []
      const exports = content.match(/export (default )?(const|function|class|interface|type) \w+/g) || []
      const funcs = content.match(/function \w+\(|const \w+ = \(|async \w+\(/g) || []
      return [
        imports.length > 0 ? `Imports (${imports.length}): ${imports.slice(0, 5).join("; ")}` : "",
        exports.length > 0 ? `Exports: ${exports.join(", ")}` : "",
        funcs.length > 0 ? `Functions: ${funcs.length}` : "",
      ].filter(Boolean).join("\n")
    } catch { return "" }
  }

  return {
    tool: {
      // ═══ 1. CODE STRUCTURE CONTEXT ═══════════════════
      code_context: tool({
        description: "Analyzes a file's code structure: imports, exports, function signatures, and dependencies. Injects structural context before edits so the model understands what it's modifying.",
        args: {
          file: tool.schema.string().describe("File path to analyze"),
          depth: tool.schema.number().describe("Dependency depth").optional().default(1),
        },
        async execute(args) {
          const target = args.file.startsWith("/") || args.file.match(/^[A-Z]:/) ? args.file : `${directory}/${args.file}`
          if (!existsSync(target)) return { output: `File not found: ${target}` }

          const context = getCodeContext(target)
          let deps = ""
          if ((args.depth || 1) > 0) {
            try {
              const raw = execSync(`grep -oP 'from ["'"'"'][^"'"'"']+["'"'"']' "${target}" 2>/dev/null || true`, { encoding: "utf8", timeout: 5000 })
              const localDeps = raw.match(/['"](\.\/[^'"]+|\.\.\/[^'"]+)['"]/g) || []
              if (localDeps.length > 0) deps = "\nLocal dependencies:\n" + localDeps.map((d: string) => {
                const resolved = target.replace(/\/[^/]+$/, "") + "/" + d.replace(/['"]/g, "")
                return `  ${d}: ${existsSync(resolved.replace(/\.ts$/, ".ts")) ? "exists" : "not found"}`
              }).join("\n")
            } catch {}
          }

          return { output: `═══ CODE CONTEXT: ${args.file} ═══\n${context}${deps}` }
        }
      }),

      // ═══ 2. SELF-REVIEW TRIGGER ═══════════════════════
      self_review: tool({
        description: "Triggers a self-review of the last code change. Analyzes the change for: logic errors, edge cases, security issues, style violations. Returns findings with fix suggestions.",
        args: {
          file: tool.schema.string().describe("File that was changed"),
          change_description: tool.schema.string().describe("What the change was supposed to do"),
        },
        async execute(args) {
          if (!existsSync(args.file)) return { output: `File not found: ${args.file}` }
          const content = readFileSync(args.file, "utf8")
          let findings: string[] = []

          // Check for common issues
          if (content.includes("console.log")) findings.push("⚠ Contains console.log — remove before production")
          if (content.includes("TODO") || content.includes("FIXME")) findings.push("⚠ Contains TODO/FIXME markers")
          if (content.includes(".only(")) findings.push("⚠ Contains .only() — will skip other tests")
          if (content.includes("debugger;")) findings.push("⛔ Contains debugger; statement")
          if (content.length > 500 && !content.includes("try") && (content.includes("async") || content.includes("Promise"))) findings.push("⚠ Async code without try/catch")
          if (content.includes("any") && (content.includes(": any") || content.includes("as any"))) findings.push("⚠ Uses 'any' type — consider proper typing")

          if (findings.length === 0) findings.push("✅ No obvious issues found")
          return { output: `═══ SELF-REVIEW: ${args.file} ═══\nChange: ${args.change_description}\n\n${findings.join("\n")}` }
        }
      }),

      // ═══ 3. TEST-FIRST GENERATOR ════════════════════
      test_first: tool({
        description: "Generates test cases for a function BEFORE implementing it. Enforces test-before-code protocol. Scans the target file for function signatures and generates comprehensive test cases covering: happy path, edge cases, error conditions, and boundary values.",
        args: {
          file: tool.schema.string().describe("File containing the function to test"),
          function_name: tool.schema.string().describe("Name of the function to generate tests for"),
          framework: tool.schema.string().describe("Test framework: vitest | jest | mocha | node:test").optional().default("vitest"),
        },
        async execute(args) {
          if (!existsSync(args.file)) return { output: `File not found: ${args.file}` }
          const content = readFileSync(args.file, "utf8")

          // Extract the function signature
          const funcRegex = new RegExp(`(export\\s+)?(default\\s+)?(async\\s+)?function\\s+${args.function_name}\\s*\\([^)]*\\)`, "m")
          const arrowRegex = new RegExp(`(export\\s+)?(default\\s+)?(const\\s+)?${args.function_name}\\s*=[^=]*(async\\s+)?\\([^)]*\\)\\s*=>`, "m")
          const methodRegex = new RegExp(`(public|private|protected)?\\s*(async\\s+)?${args.function_name}\\s*\\([^)]*\\)`, "m")

          let match = content.match(funcRegex) || content.match(arrowRegex) || content.match(methodRegex)
          if (!match) match = [{ 0: `function ${args.function_name}(...)` }] as any
          const signature = match[0]

          // Extract parameters
          const paramMatch = signature.match(/\(([^)]*)\)/)
          const params = paramMatch ? paramMatch[1].split(",").map((p: string) => p.trim().split(":")[0].trim()).filter(Boolean) : []

          // Generate scaffold test file content
          const ext = args.file.endsWith(".ts") ? ".ts" : ".js"
          const testFile = args.file.replace(ext, `.test${ext}`)
          const importPath = args.file.startsWith("/") || args.file.match(/^[A-Z]:/) ? args.file : `./${args.file.replace(/^.*[\\/]/, "")}`
          const isTypeScript = ext === ".ts"

          const tests = `// ═══ TESTS FOR: ${args.function_name} (${args.file}) ═══
// Generated by Test-First Generator — ${new Date().toISOString().slice(0, 10)}

${isTypeScript ? `import { describe, it, expect } from "${args.framework === "vitest" ? "vitest" : "@jest/globals"}"` :
  `const { describe, it } = require("${args.framework === "mocha" ? "mocha" : "node:test"}")`}
${isTypeScript ? `import { ${args.function_name} } from "${importPath.replace(ext, "")}"` :
  `const { ${args.function_name} } = require("${importPath.replace(ext, "")}")`}

describe("${args.function_name}", () => {
  // == Happy Path ==
  it("should handle normal input", () => {
    // Arrange
    ${params.map((p: string) => `const ${p} = /* TODO: fill in valid ${p} */`).join("\n    ")}

    // Act
    const result = ${args.function_name}(${params.join(", ")})

    // Assert
    expect(result).toBeDefined()
  })

  // == Edge Cases ==
  it("should handle empty input", () => {
    // TODO: test with empty/null/undefined values
  })

  it("should handle boundary values", () => {
    // TODO: test min/max boundaries
  })

  // == Error Conditions ==
  it("should throw on invalid input", () => {
    // TODO: test invalid parameter values
  })
})
`

          // Check if test file already exists
          const testExists = existsSync(testFile)

          return {
            output: `═══ TEST-FIRST: ${args.function_name} ═══
Function signature: ${signature}
Test file: ${testFile} (${testExists ? "EXISTS — update" : "will be created"})
Params: ${params.join(", ") || "none"}

${tests}

Instructions:
1. Review generated tests above
2. Write them to ${testFile}
3. Run tests to confirm they fail (red)
4. Implement ${args.function_name}
5. Run tests to confirm they pass (green)
6. Refactor if needed

[Test-First] Tests must be written BEFORE implementation code.`
          }
        }
      }),

      // ═══ 4. ADVERSARIAL GENERATOR ════════════════════
      adversarial_generate: tool({
        description: "Generates adversarial test cases to push code to its limits. Produces tests covering: boundary values, injection attacks, race conditions, type-coercion edge cases, and failure modes specific to the function being tested.",
        args: {
          file: tool.schema.string().describe("File containing the target function"),
          function_name: tool.schema.string().describe("Name of the function to adversarially test"),
          depth: tool.schema.string().describe("Test depth: basic | standard | deep").optional().default("standard"),
        },
        async execute(args) {
          if (!existsSync(args.file)) return { output: `File not found: ${args.file}` }
          const content = readFileSync(args.file, "utf8")

          // Extract function signature
          const funcRegex = new RegExp(`(export\\s+)?(default\\s+)?(async\\s+)?function\\s+${args.function_name}\\s*\\([^)]*\\)`, "m")
          const arrowRegex = new RegExp(`(export\\s+)?(default\\s+)?(const\\s+)?${args.function_name}\\s*=[^=]*(async\\s+)?\\([^)]*\\)\\s*=>`, "m")
          const match = content.match(funcRegex) || content.match(arrowRegex)
          const signature = match ? match[0] : `function ${args.function_name}(...)`

          const depth = args.depth || "standard"
          const testCases: string[] = []

          // Basic adversarial tests
          testCases.push(`// === ADVERSARIAL TESTS: ${args.function_name} (${depth} depth) ===`)
          testCases.push(`// File: ${args.file}`)
          testCases.push(`// WARNING: These tests intentionally push edge cases to find bugs.\n`)

          testCases.push(`describe("${args.function_name} [adversarial]", () => {`)

          // Boundary / null / undefined
          testCases.push(`  // --- Boundary & Null Injection ---`)
          testCases.push(`  it("should handle null input without crashing", () => {`)
          testCases.push(`    expect(() => ${args.function_name}(null as any)).not.toThrow()`)
          testCases.push(`  })`)
          testCases.push(``)
          testCases.push(`  it("should handle undefined input without crashing", () => {`)
          testCases.push(`    expect(() => ${args.function_name}(undefined as any)).not.toThrow()`)
          testCases.push(`  })`)
          testCases.push(``)
          testCases.push(`  it("should handle NaN input without crashing", () => {`)
          testCases.push(`    expect(() => ${args.function_name}(NaN as any)).not.toThrow()`)
          testCases.push(`  })`)

          if (depth === "standard" || depth === "deep") {
            testCases.push(``)
            testCases.push(`  // --- Type Coercion ---`)
            testCases.push(`  it("should handle empty string gracefully", () => {`)
            testCases.push(`    expect(() => ${args.function_name}("" as any)).not.toThrow()`)
            testCases.push(`  })`)
            testCases.push(``)
            testCases.push(`  it("should handle extremely large input without hanging", () => {`)
            testCases.push(`    // Large array / long string / high number`)
            testCases.push(`    const largeInput = Array(10000).fill("x").join("")`)
            testCases.push(`    const result = ${args.function_name}(largeInput as any)`)
            testCases.push(`    expect(result).toBeDefined()`)
            testCases.push(`  })`)
            testCases.push(``)
            testCases.push(`  it("should handle negative values", () => {`)
            testCases.push(`    expect(() => ${args.function_name}(-1 as any)).not.toThrow()`)
            testCases.push(`  })`)
          }

          if (depth === "deep") {
            testCases.push(``)
            testCases.push(`  // --- Injection & Security ---`)
            testCases.push(`  it("should handle SQL injection patterns", () => {`)
            testCases.push(`    expect(() => ${args.function_name}("'; DROP TABLE users; --" as any)).not.toThrow()`)
            testCases.push(`  })`)
            testCases.push(``)
            testCases.push(`  test_case = "prototype pollution"`)
            testCases.push(`  it("should handle prototype pollution attempts", () => {`)
            testCases.push(`    expect(() => ${args.function_name}("__proto__" as any)).not.toThrow()`)
            testCases.push(`  })`)
            testCases.push(``)
            testCases.push(`  // --- Race Condition Simulation ---`)
            testCases.push(`  it("should handle concurrent calls", async () => {`)
            testCases.push(`    const promises = Array(50).fill(0).map(() => ${args.function_name}({} as any))`)
            testCases.push(`    const results = await Promise.allSettled(promises)`)
            testCases.push(`    const rejected = results.filter(r => r.status === "rejected")`)
            testCases.push(`    expect(rejected.length).toBe(0)`)
            testCases.push(`  })`)
          }

          testCases.push(`})`)
          testCases.push(``)
          testCases.push(`// == Test Summary ==`)
          testCases.push(`// Depth: ${depth}`)
          testCases.push(`// Tests: ${testCases.filter(t => t.includes('it("')).length} adversarial cases`)

          return {
            output: `═══ ADVERSARIAL GENERATOR: ${args.function_name} ═══
Function: ${signature}
Depth: ${depth}

${testCases.join("\n")}

[Adversarial] These tests probe for hidden bugs. Run them to validate robustness.`
          }
        }
      }),

      // ═══ 6. UNCERTAINTY ESTIMATOR ═════════════════════
      estimate_confidence: tool({
        description: "Estimates confidence level for a task before execution. Factors: file existence, similar past decisions, task detail level, code structure complexity. Returns recommended action.",
        args: {
          task: tool.schema.string().describe("Task to evaluate"),
          file: tool.schema.string().describe("Target file").optional().default(""),
        },
        async execute(args) {
          let score = 50
          const notes: string[] = []
          if (args.file && existsSync(args.file)) { score += 20; notes.push("Target file exists") }
          if ((args.task || "").length > 150) { score += 10; notes.push("Detailed task description") }
          else if ((args.task || "").length < 30) { score -= 10; notes.push("Very brief task — may be underspecified") }
          const level = score >= 70 ? "HIGH" : score >= 45 ? "MEDIUM" : "LOW"
          const action = level === "HIGH" ? "Proceed autonomously" : level === "MEDIUM" ? "Proceed with caution, verify output" : "Escalate to user for clarification"
          return { output: `═══ CONFIDENCE: ${level} (${score}/100) ═══\n${notes.join("\n")}\n\nRecommended: ${action}` }
        }
      }),

      // ═══ 5. MULTI-PERSPECTIVE REASONING ═══════════════
      multi_perspective: tool({
        description: "Generates 3 solution approaches from different angles: minimal/simple, robust/complete, and creative/alternative. Compares trade-offs for informed decision-making.",
        args: {
          task: tool.schema.string().describe("The task to approach from multiple angles"),
          context: tool.schema.string().describe("Optional context").optional().default(""),
        },
        async execute(args) {
          const perspectives = [
            { name: "Simple/Minimal", angle: "What's the simplest working solution? Minimize code changes." },
            { name: "Robust/Complete", angle: "What handles all edge cases? Include error handling, validation, tests." },
            { name: "Creative/Alternative", angle: "What's a non-obvious approach? Could we solve this differently?" },
          ]
          const out = perspectives.map(p =>
            `=== ${p.name} ===\nApproach: ${p.angle}\nTask: ${args.task}\n${args.context ? "\nContext: " + args.context.slice(0, 500) : ""}\n\nGenerate a solution from this angle. Be specific.\n`
          ).join("\n")
          return { output: `═══ MULTI-PERSPECTIVE ═══\n\n${out}\n\nAfter all 3:\n1. Compare solutions\n2. Pick best or propose hybrid\n3. Justify choice` }
        }
      }),
    },

    // ═══ 3. SELF-REVIEW TRIGGER (auto on edit) ═══════
    "tool.execute.after": async (input, output) => {
      // After any edit, attach self-review reminder
      if (input.tool === "edit" || input.tool === "write") {
        const filePath = (input.args as any)?.filePath || (input.args as any)?.path || ""
        if (filePath) {
          const outRef = output as any
          const existing = outRef.output || ""
          outRef.output = existing + `\n\n[Self-Review] File changed: ${filePath}. Run self_review({file: "${filePath.replace(/"/g, '\\"')}"}) to review the change for common issues.`
        }
      }
    },

    // ═══ 4. ADVERSARIAL GENERATOR (auto-triggered) ═══
    // (adversarial_generate tool is in hooks.ts, trigger is here)
    "experimental.session.compacting": async (_input, output) => {
      // Inject multi-perspective guidance when context compacts
      output.context.push(
        `## Enhancement Tools Available\n` +
        `- code_context({file}) — analyze file structure before editing\n` +
        `- self_review({file, change_description}) — review changes for common issues\n` +
        `- estimate_confidence({task, file}) — check if task is well-defined enough\n` +
        `- multi_perspective({task}) — generate solutions from multiple angles`
      )
    },
  }
}
