// ═══════════════════════════════════════════════════════════════
// SKILLS SYSTEM — SKILL.md parser, dynamic context, substitutions
// Phase 4: T4.1 through T4.7
// ═══════════════════════════════════════════════════════════════

import type { Plugin } from "@opencode-ai/plugin"
import { tool } from "@opencode-ai/plugin"
import { readFile, writeFile, mkdirSync, readdirSync, existsSync, statSync } from "fs"
import { promisify } from "util"
import { execSync } from "child_process"

const readFileAsync = promisify(readFile)
const writeFileAsync = promisify(writeFile)

// ─── Types ───────────────────────────────────────────────────

interface SkillDefinition {
  name: string
  commandName: string          // what user types: /name
  description: string
  whenToUse?: string
  argumentHint?: string
  arguments?: string[]         // named positional args
  disableModelInvocation?: boolean
  userInvocable?: boolean
  allowedTools?: string[]
  disallowedTools?: string[]
  model?: string
  effort?: string
  context?: string             // "fork" to run in subagent
  agent?: string               // subagent type for fork
  paths?: string[]             // glob patterns for when to activate
  shell?: string               // "bash" or "powershell"
  body: string                 // raw SKILL.md content (before substitutions)
  directory: string            // skill directory path
  lastModified: number         // for live change detection
}

// ─── Skill Registry ──────────────────────────────────────────

class SkillRegistry {
  private skills: Map<string, SkillDefinition> = new Map()
  private lastScan = 0
  private readonly SCAN_INTERVAL = 2000 // 2 seconds between scans

  async scanDirectory(dirPath: string, prefix = "") {
    if (!existsSync(dirPath)) return

    try {
      const entries = readdirSync(dirPath, { withFileTypes: true })
      for (const entry of entries) {
        if (entry.isDirectory()) {
          const skillPath = `${dirPath}/${entry.name}/SKILL.md`
          if (existsSync(skillPath)) {
            await this.loadSkill(skillPath, `${dirPath}/${entry.name}`, prefix)
          } else {
            // Check for nested skill directory
            await this.scanDirectory(`${dirPath}/${entry.name}`, prefix ? `${prefix}:${entry.name}` : entry.name)
          }
        } else if (entry.name === "SKILL.md") {
          // SKILL.md at the directory root level (plugin format)
          await this.loadSkill(`${dirPath}/SKILL.md`, dirPath, prefix)
        }
      }
    } catch { /* directory read failed */ }
  }

  async loadSkill(skillFilePath: string, skillDir: string, prefix: string) {
    try {
      const content = await readFileAsync(skillFilePath, "utf8")
      const stat = statSync(skillFilePath)
      const def = parseSkillDefinition(content, skillDir, stat.mtimeMs, prefix)
      if (def) {
        this.skills.set(def.commandName, def)
      }
    } catch { /* load failed */ }
  }

  async scanAll(directory: string) {
    const now = Date.now()
    if (now - this.lastScan < this.SCAN_INTERVAL) return
    this.lastScan = now

    // Scan user skills
    const homeDir = process.env.HOME || process.env.USERPROFILE || ""
    if (homeDir) {
      await this.scanDirectory(`${homeDir}/.opencode/skills`, "")
    }

    // Scan project skills
    await this.scanDirectory(`${directory}/.opencode/skills`, "")
  }

  get(commandName: string): SkillDefinition | undefined {
    return this.skills.get(commandName)
  }

  getAll(): SkillDefinition[] {
    return Array.from(this.skills.values())
  }

  search(query: string): SkillDefinition[] {
    const q = query.toLowerCase()
    return Array.from(this.skills.values()).filter(s =>
      s.commandName.toLowerCase().includes(q) ||
      s.description.toLowerCase().includes(q) ||
      s.body.toLowerCase().includes(q)
    )
  }
}

// ─── YAML Frontmatter Parser ─────────────────────────────────

function parseSkillDefinition(content: string, dirPath: string, lastModified: number, prefix: string): SkillDefinition | null {
  const match = content.match(/^---\s*\n([\s\S]*?)\n---\s*\n([\s\S]*)$/)
  if (!match) {
    // No frontmatter — treat whole content as skill body
    const dirName = dirPath.split("/").pop() || dirPath.split("\\").pop() || "unknown"
    return {
      name: dirName,
      commandName: prefix ? `${prefix}:${dirName}` : dirName,
      description: content.split("\n")[0].slice(0, 200),
      body: content,
      directory: dirPath,
      lastModified,
    }
  }

  const [, yamlStr, body] = match
  const fields: Record<string, any> = {}
  const lines = yamlStr.split("\n")

  for (const line of lines) {
    const kvMatch = line.match(/^([\w-]+):\s*(.*)$/)
    if (kvMatch) {
      let value = kvMatch[2].trim()
      const key = kvMatch[1]

      if (value === "true") fields[key] = true
      else if (value === "false") fields[key] = false
      else if (value.startsWith("[")) {
        fields[key] = value.slice(1, -1).split(",").map(s => s.trim().replace(/^["']|["']$/g, ""))
      }
      else fields[key] = value.replace(/^["']|["']$/g, "")
    }
  }

  const dirName = dirPath.split("/").pop() || dirPath.split("\\").pop() || "unknown"
  const commandName = prefix ? `${prefix}:${dirName}` : dirName

  return {
    name: fields.name || dirName,
    commandName,
    description: fields.description || "",
    whenToUse: fields.when_to_use || fields["when-to-use"],
    argumentHint: fields["argument-hint"],
    arguments: fields.arguments ? (Array.isArray(fields.arguments) ? fields.arguments : fields.arguments.split(/[,\s]+/).filter(Boolean)) : undefined,
    disableModelInvocation: fields["disable-model-invocation"] === true,
    userInvocable: fields["user-invocable"] !== false,
    allowedTools: fields["allowed-tools"] ? (Array.isArray(fields["allowed-tools"]) ? fields["allowed-tools"] : fields["allowed-tools"].split(/[,\s]+/).filter(Boolean)) : undefined,
    disallowedTools: fields["disallowed-tools"] ? (Array.isArray(fields["disallowed-tools"]) ? fields["disallowed-tools"] : fields["disallowed-tools"].split(/[,\s]+/).filter(Boolean)) : undefined,
    model: fields.model,
    effort: fields.effort,
    context: fields.context,
    agent: fields.agent,
    paths: fields.paths ? (Array.isArray(fields.paths) ? fields.paths : fields.paths.split(/[,\s]+/).filter(Boolean)) : undefined,
    shell: fields.shell || "bash",
    body: body.trim(),
    directory: dirPath,
    lastModified,
  }
}

// ─── Dynamic Context Injection (T4.2) ────────────────────────

function injectDynamicContext(body: string, shell: string): string {
  // Pattern 1: `command` — run shell command, inject output
  let result = body.replace(/`([^`]+)`/g, (_match, cmd) => {
    try {
      const output = execSync(cmd, {
        encoding: "utf8",
        timeout: 30000,
        stdio: ["pipe", "pipe", "pipe"],
      })
      return output.trim().slice(0, 10000) // cap output
    } catch (err: any) {
      return `[command failed: ${err.message}]`
    }
  })

  // Pattern 2: ```! code blocks — run multi-line commands
  result = result.replace(/```\!\s*\n([\s\S]*?)```/g, (_match, code) => {
    try {
      const ext = shell === "powershell" ? "ps1" : "sh"
      const output = execSync(code, {
        encoding: "utf8",
        timeout: 60000,
        stdio: ["pipe", "pipe", "pipe"],
      })
      return "```\n" + output.trim().slice(0, 10000) + "\n```"
    } catch (err: any) {
      return "```\n[command failed: " + err.message + "]\n```"
    }
  })

  return result
}

// ─── String Substitutions (T4.3) ─────────────────────────────

function applySubstitutions(
  body: string,
  args: string,
  skillDef: SkillDefinition,
  sessionId: string,
  effort: string
): string {
  let result = body

  // $ARGUMENTS — all arguments
  result = result.replace(/\$ARGUMENTS/g, args || "")

  // $0, $1, $2, etc. — positional args
  const positionalArgs = args.split(/\s+/).filter(Boolean)
  result = result.replace(/\$(\d+)/g, (_match, idx) => positionalArgs[parseInt(idx)] || "")

  // Named arguments from frontmatter
  if (skillDef.arguments) {
    skillDef.arguments.forEach((name, idx) => {
      const regex = new RegExp(`\\$${name}`, "g")
      result = result.replace(regex, positionalArgs[idx] || "")
    })
  }

  // ${CLAUDE_SESSION_ID}
  result = result.replace(/\$\{CLAUDE_SESSION_ID\}/g, sessionId || "unknown")

  // ${CLAUDE_EFFORT}
  result = result.replace(/\$\{CLAUDE_EFFORT\}/g, effort || "medium")

  // ${CLAUDE_SKILL_DIR}
  result = result.replace(/\$\{CLAUDE_SKILL_DIR\}/g, skillDef.directory)

  return result
}

// ─── Plugin ──────────────────────────────────────────────────

export const SkillsPlugin: Plugin = async ({ directory }) => {
  const registry = new SkillRegistry()
  await registry.scanAll(directory)

  return {
    tool: {
      // ─── Tool: list_skills ───────────────────────────
      list_skills: tool({
        description: "Lists all available skills (SKILL.md files).",
        args: {
          query: tool.schema.string().describe("Search query (optional)").optional().default(""),
        },
        async execute(args) {
          // Rescan for new skills
          await registry.scanAll(directory)

          const skills = args.query ? registry.search(args.query) : registry.getAll()
          if (skills.length === 0) return { output: "No skills found." }

          const lines = skills.map(s =>
            `/${s.commandName}: ${s.description.slice(0, 80)}`
          )
          return { output: lines.join("\n") }
        },
      }),

      // ─── Tool: get_skill ─────────────────────────────
      get_skill: tool({
        description: "Gets full details of a skill, including its processed content.",
        args: {
          name: tool.schema.string().describe("Skill command name (without /)"),
          arguments: tool.schema.string().describe("Arguments to pass to the skill").optional().default(""),
        },
        async execute(args) {
          const skill = registry.get(args.name)
          if (!skill) return { output: `Skill "/${args.name}" not found. Use list_skills to see available skills.` }

          // Apply dynamic context injection
          let content = injectDynamicContext(skill.body, skill.shell || "bash")

          // Apply string substitutions
          content = applySubstitutions(content, args.arguments, skill, "current-session", "medium")

          // Build metadata
          const meta = [
            `Skill: ${skill.commandName}`,
            `Description: ${skill.description}`,
            skill.model ? `Model: ${skill.model}` : null,
            skill.effort ? `Effort: ${skill.effort}` : null,
            skill.allowedTools ? `Allowed tools: ${skill.allowedTools.join(", ")}` : null,
            skill.disallowedTools ? `Disallowed tools: ${skill.disallowedTools.join(", ")}` : null,
            skill.context === "fork" ? `Context: forked subagent` : null,
            skill.shell ? `Shell: ${skill.shell}` : null,
            `Directory: ${skill.directory}`,
          ].filter(Boolean).join("\n")

          return {
            output: `=== SKILL METADATA ===\n${meta}\n\n=== SKILL CONTENT ===\n${content.slice(0, 10000)}`
          }
        },
      }),

      // ─── Tool: invoke_skill ──────────────────────────
      invoke_skill: tool({
        description: "Invokes a skill, returning its processed content for the model to follow.",
        args: {
          name: tool.schema.string().describe("Skill command name (without /)"),
          arguments: tool.schema.string().describe("Arguments to pass ($ARGUMENTS)").optional().default(""),
        },
        async execute(args) {
          const skill = registry.get(args.name)
          if (!skill) return { output: `Skill "/${args.name}" not found.` }

          // Check if user-invocable
          if (skill.userInvocable === false) {
            return { output: `Skill "/${args.name}" is model-only (not user-invocable).` }
          }

          // Apply dynamic context injection
          let content = injectDynamicContext(skill.body, skill.shell || "bash")

          // Apply string substitutions
          content = applySubstitutions(content, args.arguments, skill, "current-session", "medium")

          return {
            output: `=== INVOKING SKILL: ${skill.commandName} ===\n\n${content.slice(0, 15000)}`
          }
        },
      }),

      // ─── Tool: create_skill ──────────────────────────
      create_skill: tool({
        description: "Creates a new skill with SKILL.md file.",
        args: {
          name: tool.schema.string().describe("Skill name (becomes /name)"),
          description: tool.schema.string().describe("What the skill does and when to use it"),
          content: tool.schema.string().describe("Skill instructions (markdown)"),
          allowedTools: tool.schema.array(tool.schema.string()).describe("Tools allowed during skill").optional().default([]),
          disableModelInvocation: tool.schema.boolean().describe("If true, only user can invoke").optional().default(false),
        },
        async execute(args) {
          const dir = `${directory}/.opencode/skills/${args.name}`
          mkdirSync(dir, { recursive: true })

          const frontmatter = [
            `description: ${args.description}`,
            args.allowedTools.length > 0 ? `allowed-tools: [${args.allowedTools.join(", ")}]` : null,
            args.disableModelInvocation ? `disable-model-invocation: true` : null,
          ].filter(Boolean).join("\n")

          const content = `---\n${frontmatter}\n---\n\n${args.content}\n`
          await writeFileAsync(`${dir}/SKILL.md`, content)

          // Reload skills
          registry.skills.clear()
          await registry.scanAll(directory)

          return { output: `Skill "/${args.name}" created at ${dir}/SKILL.md. Available immediately.` }
        },
      }),

      // ─── Tool: create_builtin_skills ─────────────────
      create_builtin_skills: tool({
        description: "Creates all bundled skills at once (code-review, debug, verify, commit, test).",
        args: {},
        async execute() {
          const skillsDir = `${directory}/.opencode/skills`
          mkdirSync(skillsDir, { recursive: true })

          const skills: Array<{ name: string; desc: string; content: string }> = [
            {
              name: "code-review",
              desc: "Review code for bugs, security issues, and quality problems",
              content: `## Code Review

Review the code thoroughly:

1. **Security**: Check for injection, XSS, CSRF, auth bypass, hardcoded secrets
2. **Correctness**: Check for logic errors, off-by-one, null handling, type mismatches
3. **Performance**: Check for N+1 queries, unnecessary allocations, missing indexes
4. **Quality**: Check for naming, structure, dead code, missing error handling

For each issue found:
- File path and line number
- Severity: critical / high / medium / low
- Description of the problem
- Suggested fix

If no issues found, say so explicitly.`,
            },
            {
              name: "debug",
              desc: "Systematic debugging workflow for errors and failures",
              content: `## Debug

Systematically debug the issue:

1. Read the error message carefully
2. Find the exact line causing the error
3. Trace the execution path
4. Check inputs, data types, edge cases
5. Identify the ROOT CAUSE (not just symptoms)
6. Propose a minimal fix
7. Verify the fix doesn't break other things

Never guess. Always trace actual code.`,
            },
            {
              name: "verify",
              desc: "Build and run the app to confirm a code change works",
              content: `## Verify

Confirm the recent code change actually works:

1. Check if the project builds successfully
2. Run the test suite
3. If no tests exist, verify the change manually
4. Check for compilation errors
5. Verify no regressions in related code

Report: PASS or FAIL with details.`,
            },
            {
              name: "commit",
              desc: "Stage and commit current changes with a good message",
              content: `## Commit

Stage and commit the current changes:

1. Run \`git status\` to see what changed
2. Run \`git diff\` to review changes
3. Stage all relevant files: \`git add <files>\`
4. Write a clear commit message:
   - First line: imperative mood, <50 chars
   - Blank line
   - Body: explain WHY, not WHAT
5. Commit: \`git commit -m "<message>"\`

Do NOT include generated files or secrets.`,
            },
            {
              name: "test",
              desc: "Run the test suite and report results",
              content: `## Test

Run the test suite and report results:

1. Detect test runner (jest, vitest, pytest, go test, cargo test)
2. Run the full test suite
3. Report: total tests, passed, failed, skipped
4. For each failure: test name, error message, likely cause
5. Suggest fixes for failures`,
            },
          ]

          let created = 0
          for (const skill of skills) {
            const dir = `${skillsDir}/${skill.name}`
            mkdirSync(dir, { recursive: true })
            const filePath = `${dir}/SKILL.md`

            // Don't overwrite existing skills
            if (existsSync(filePath)) continue

            const content = `---\ndescription: ${skill.desc}\n---\n\n${skill.content}\n`
            await writeFileAsync(filePath, content)
            created++
          }

          // Reload
          registry.skills.clear()
          await registry.scanAll(directory)

          return { output: `Created ${created} bundled skills (${skills.length - created} already existed). Total skills: ${registry.getAll().length}` }
        },
      }),

      // ─── Tool: reload_skills ─────────────────────────
      reload_skills: tool({
        description: "Forces a rescan of all skill directories.",
        args: {},
        async execute() {
          registry.skills.clear()
          registry.lastScan = 0
          await registry.scanAll(directory)
          return { output: `Reloaded. ${registry.getAll().length} skills found.` }
        },
      }),
    },

    // ─── Compaction: preserve skill content ─────────────
    "experimental.session.compacting": async (_input, output) => {
      output.context.push(
        `## Skills System\n` +
        `Skills are loaded via /skill-name or by the model.\n` +
        `Use list_skills to see available skills.\n` +
        `Use invoke_skill <name> to re-invoke a skill after compaction.`
      )
    },
  }
}
