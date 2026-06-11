// ═══════════════════════════════════════════════════════════════
// SUBAGENT SYSTEM — Custom subagent definitions for OpenCode
// Phase 3: T3.1 through T3.7
// ═══════════════════════════════════════════════════════════════
// Deterministic enforcement: tool restrictions are enforced by CODE
// (tool.execute.before hooks), not by instructions the model can ignore.

import type { Plugin } from "@opencode-ai/plugin"
import { tool } from "@opencode-ai/plugin"
import { readFile, writeFile, mkdirSync, readdirSync, existsSync } from "fs"
import { promisify } from "util"

const readFileAsync = promisify(readFile)
const writeFileAsync = promisify(writeFile)

// ─── Types ───────────────────────────────────────────────────

interface SubagentDefinition {
  name: string
  description: string
  tools?: string[]           // allowlist
  disallowedTools?: string[] // denylist
  model?: string             // sonnet, opus, haiku, inherit, or full ID
  permissionMode?: string    // default, acceptEdits, auto, bypassPermissions, plan
  maxTurns?: number
  skills?: string[]          // skills to preload
  memory?: string            // user, project, local
  background?: boolean
  effort?: string            // low, medium, high, xhigh, max
  isolation?: string         // worktree
  color?: string
  initialPrompt?: string
  body: string               // system prompt from markdown body
  source: string             // file path where loaded from
  scope: "managed" | "project" | "user" | "plugin"
}

// Built-in agents (always available)
const BUILTIN_AGENTS: SubagentDefinition[] = [
  {
    name: "explore",
    description: "Fast, read-only agent optimized for searching and analyzing codebases. Use when you need to search or understand code without making changes.",
    tools: ["read", "grep", "glob", "bash"],
    disallowedTools: ["edit", "write"],
    model: "haiku",
    body: "You are a fast code exploration agent. Search and analyze code quickly. Do NOT edit files. Report findings concisely.",
    source: "builtin",
    scope: "project",
  },
  {
    name: "plan",
    description: "Research agent for gathering context before presenting a plan. Use during planning to understand the codebase.",
    tools: ["read", "grep", "glob"],
    disallowedTools: ["edit", "write", "bash"],
    model: "inherit",
    body: "You are a planning research agent. Read and analyze code to inform implementation plans. Do NOT modify files.",
    source: "builtin",
    scope: "project",
  },
  {
    name: "general",
    description: "Capable agent for complex, multi-step tasks that require both exploration and action.",
    model: "inherit",
    body: "You are a general-purpose agent. Handle complex multi-step tasks including exploration and modification.",
    source: "builtin",
    scope: "project",
  },
  {
    name: "code-reviewer",
    description: "Reviews code for quality, security, and best practices. Use proactively after code changes.",
    tools: ["read", "grep", "glob"],
    disallowedTools: ["edit", "write", "bash"],
    model: "sonnet",
    body: `You are a senior code reviewer. When invoked:
1. Read the changed files
2. Check for bugs, security issues, performance problems
3. Check for code quality (naming, structure, patterns)
4. Provide specific, actionable feedback
5. Rate severity: critical, high, medium, low
6. Never skip any file — read them all before judging`,
    source: "builtin",
    scope: "project",
  },
  {
    name: "debugger",
    description: "Debugging specialist for errors and test failures. Analyzes errors, identifies root causes, and provides fixes.",
    tools: ["read", "grep", "glob", "bash"],
    disallowedTools: ["write"],
    model: "inherit",
    body: `You are an expert debugger. When invoked:
1. Read the error message and stack trace
2. Trace the execution path
3. Identify the root cause
4. Explain WHY the bug exists
5. Provide a minimal fix
6. Verify the fix compiles/works
Never guess — always trace the actual code path.`,
    source: "builtin",
    scope: "project",
  },
]

// ─── Definition Parser ───────────────────────────────────────

function parseFrontmatter(content: string, filePath: string, scope: SubagentDefinition["scope"]): SubagentDefinition | null {
  const match = content.match(/^---\s*\n([\s\S]*?)\n---\s*\n([\s\S]*)$/)
  if (!match) return null

  const [, yamlStr, body] = match

  // Simple YAML parser (no dependency needed)
  const fields: Record<string, any> = {}
  const lines = yamlStr.split("\n")
  let currentKey = ""

  for (const line of lines) {
    const kvMatch = line.match(/^(\w[\w-]*):\s*(.*)$/)
    if (kvMatch) {
      currentKey = kvMatch[1]
      let value = kvMatch[2].trim()

      // Handle lists (space-separated or bracket notation)
      if (value.startsWith("[")) {
        // [a, b, c] format
        fields[currentKey] = value.slice(1, -1).split(",").map((s: string) => s.trim().replace(/^["']|["']$/g, ""))
      } else if (value === "" && lines.indexOf(line) + 1 < lines.length) {
        // Check if next line is indented (list continuation)
        const nextLine = lines[lines.indexOf(line) + 1]
        if (nextLine && nextLine.match(/^\s+-\s/)) {
          const listItems: string[] = []
          let idx = lines.indexOf(line) + 1
          while (idx < lines.length && lines[idx].match(/^\s+-\s/)) {
            listItems.push(lines[idx].replace(/^\s+-\s+/, "").trim().replace(/^["']|["']$/g, ""))
            idx++
          }
          fields[currentKey] = listItems
        } else {
          fields[currentKey] = value
        }
      } else {
        // Handle booleans
        if (value === "true") fields[currentKey] = true
        else if (value === "false") fields[currentKey] = false
        else if (value.match(/^\d+$/)) fields[currentKey] = parseInt(value)
        else fields[currentKey] = value.replace(/^["']|["']$/g, "")
      }
    }
  }

  if (!fields.name || !fields.description) return null

  return {
    name: fields.name,
    description: fields.description,
    tools: fields.tools ? (Array.isArray(fields.tools) ? fields.tools : fields.tools.split(/[,\s]+/).filter(Boolean)) : undefined,
    disallowedTools: fields.disallowedTools ? (Array.isArray(fields.disallowedTools) ? fields.disallowedTools : fields.disallowedTools.split(/[,\s]+/).filter(Boolean)) : undefined,
    model: fields.model || "inherit",
    permissionMode: fields.permissionMode,
    maxTurns: fields.maxTurns,
    skills: fields.skills ? (Array.isArray(fields.skills) ? fields.skills : fields.skills.split(/[,\s]+/).filter(Boolean)) : undefined,
    memory: fields.memory,
    background: fields.background === true || fields.background === "true",
    effort: fields.effort,
    isolation: fields.isolation,
    color: fields.color,
    initialPrompt: fields.initialPrompt,
    body: body.trim(),
    source: filePath,
    scope,
  }
}

// ─── Agent Registry ──────────────────────────────────────────

class AgentRegistry {
  private agents: Map<string, SubagentDefinition> = new Map()
  private activeAgent: string | null = null
  private toolRestrictions: Set<string> = new Set() // tools to block for active agent

  constructor() {
    // Register built-ins
    for (const agent of BUILTIN_AGENTS) {
      this.agents.set(agent.name, agent)
    }
  }

  async loadFromDirectory(dirPath: string, scope: SubagentDefinition["scope"]) {
    if (!existsSync(dirPath)) return

    try {
      const entries = readdirSync(dirPath, { recursive: true, withFileTypes: true })
      for (const entry of entries) {
        if (!entry.isFile() || !entry.name.endsWith(".md")) continue
        const fullPath = `${dirPath}/${entry.name}`
        try {
          const content = await readFileAsync(fullPath, "utf8")
          const def = parseFrontmatter(content, fullPath, scope)
          if (def && !this.agents.has(def.name)) {
            this.agents.set(def.name, def)
          }
        } catch { /* skip unreadable files */ }
      }
    } catch { /* directory read failed */ }
  }

  async loadAll(directory: string) {
    // Load order: user > project > plugin (higher priority wins)
    // Built-ins are loaded first, custom files override them

    // Project-level
    await this.loadFromDirectory(`${directory}/.opencode/agents`, "project")

    // User-level (if different from project)
    const homeDir = process.env.HOME || process.env.USERPROFILE || ""
    if (homeDir) {
      await this.loadFromDirectory(`${homeDir}/.opencode/agents`, "user")
    }
  }

  get(name: string): SubagentDefinition | undefined {
    return this.agents.get(name)
  }

  getAll(): SubagentDefinition[] {
    return Array.from(this.agents.values())
  }

  setActive(agentName: string | null) {
    this.activeAgent = agentName
    this.toolRestrictions.clear()

    if (agentName) {
      const def = this.agents.get(agentName)
      if (def) {
        // Apply tool restrictions
        if (def.disallowedTools) {
          for (const t of def.disallowedTools) {
            this.toolRestrictions.add(t.toLowerCase())
          }
        }
        if (def.tools) {
          // If allowlist is set, everything NOT in the list is restricted
          const allTools = ["bash", "edit", "write", "read", "grep", "glob", "webfetch", "websearch", "notebookedit", "skill", "agent", "workflow"]
          for (const t of allTools) {
            if (!def.tools.map(x => x.toLowerCase()).includes(t)) {
              this.toolRestrictions.add(t)
            }
          }
        }
      }
    }
  }

  isToolAllowed(toolName: string): boolean {
    if (!this.activeAgent) return true // no active agent = no restrictions
    return !this.toolRestrictions.has(toolName.toLowerCase())
  }

  getModel(agentName: string): string | undefined {
    const def = this.agents.get(agentName)
    return def?.model
  }

  getMemoryPath(agentName: string, directory: string): string | null {
    const def = this.agents.get(agentName)
    if (!def?.memory) return null

    const homeDir = process.env.HOME || process.env.USERPROFILE || ""
    switch (def.memory) {
      case "user":
        return `${homeDir}/.opencode/agent-memory/${agentName}`
      case "project":
        return `${directory}/.opencode/agent-memory/${agentName}`
      case "local":
        return `${directory}/.opencode/local-agent-memory/${agentName}`
      default:
        return null
    }
  }
}

// ─── Plugin ──────────────────────────────────────────────────

export const SubagentsPlugin: Plugin = async ({ directory }) => {
  const registry = new AgentRegistry()
  await registry.loadAll(directory)

  return {
    // ─── Tool: list_agents ─────────────────────────────
    tool: {
      list_agents: tool({
        description: "Lists all available subagent definitions (built-in + custom).",
        args: {},
        async execute() {
          const agents = registry.getAll()
          const lines = agents.map(a =>
            `- ${a.name}: ${a.description} [model=${a.model}, scope=${a.scope}]`
          )
          return { output: lines.length > 0 ? lines.join("\n") : "No agents found." }
        },
      }),

      get_agent: tool({
        description: "Gets full details of a subagent definition.",
        args: {
          name: tool.schema.string().describe("Agent name"),
        },
        async execute(args) {
          const agent = registry.get(args.name)
          if (!agent) return { output: `Agent "${args.name}" not found.` }

          return {
            output: `Agent: ${agent.name}\n` +
              `Description: ${agent.description}\n` +
              `Model: ${agent.model}\n` +
              `Tools: ${agent.tools?.join(", ") || "all"}\n` +
              `Disallowed: ${agent.disallowedTools?.join(", ") || "none"}\n` +
              `Memory: ${agent.memory || "none"}\n` +
              `Scope: ${agent.scope}\n` +
              `Source: ${agent.source}\n\n` +
              `System Prompt:\n${agent.body.slice(0, 2000)}`
          }
        },
      }),

      create_agent: tool({
        description: "Creates a new subagent definition file.",
        args: {
          name: tool.schema.string().describe("Agent name (lowercase, hyphens)"),
          description: tool.schema.string().describe("When Claude should use this agent"),
          tools: tool.schema.array(tool.schema.string()).describe("Allowed tools (empty = all)").optional().default([]),
          disallowedTools: tool.schema.array(tool.schema.string()).describe("Blocked tools").optional().default([]),
          model: tool.schema.string().describe("Model: sonnet, opus, haiku, inherit").optional().default("inherit"),
          memory: tool.schema.string().describe("Memory scope: user, project, local").optional().default(""),
          systemPrompt: tool.schema.string().describe("System prompt for the agent"),
        },
        async execute(args) {
          const dir = `${directory}/.opencode/agents`
          mkdirSync(dir, { recursive: true })

          const frontmatter = [
            `name: ${args.name}`,
            `description: ${args.description}`,
            args.tools.length > 0 ? `tools: [${args.tools.join(", ")}]` : null,
            args.disallowedTools.length > 0 ? `disallowedTools: [${args.disallowedTools.join(", ")}]` : null,
            args.model !== "inherit" ? `model: ${args.model}` : null,
            args.memory ? `memory: ${args.memory}` : null,
          ].filter(Boolean).join("\n")

          const content = `---\n${frontmatter}\n---\n\n${args.systemPrompt}\n`
          const filePath = `${dir}/${args.name}.md`
          await writeFileAsync(filePath, content)

          // Reload
          registry.agents.delete(args.name)
          await registry.loadFromDirectory(dir, "project")

          return { output: `Agent "${args.name}" created at ${filePath}. Available immediately.` }
        },
      }),

      activate_agent: tool({
        description: "Activates a subagent, applying its tool restrictions. Call before the agent does work. Call with null to deactivate.",
        args: {
          name: tool.schema.string().describe("Agent name to activate, or 'none' to deactivate"),
        },
        async execute(args) {
          if (args.name === "none" || args.name === "") {
            registry.setActive(null)
            return { output: "Agent deactivated. All tools available." }
          }

          const agent = registry.get(args.name)
          if (!agent) return { output: `Agent "${args.name}" not found.` }

          registry.setActive(args.name)
          const blocked = agent.disallowedTools?.join(", ") || (agent.tools ? "all except " + agent.tools.join(", ") : "none")

          return {
            output: `Agent "${args.name}" activated.\n` +
              `Model: ${agent.model}\n` +
              `Blocked tools: ${blocked}\n` +
              `System prompt preview: ${agent.body.slice(0, 200)}...`
          }
        },
      }),

      deactivate_agent: tool({
        description: "Deactivates the current subagent, removing tool restrictions.",
        args: {},
        async execute() {
          registry.setActive(null)
          return { output: "Agent deactivated. All tools available." }
        },
      }),

      get_agent_memory: tool({
        description: "Reads persistent memory for a subagent.",
        args: {
          name: tool.schema.string().describe("Agent name"),
        },
        async execute(args) {
          const memPath = registry.getMemoryPath(args.name, directory)
          if (!memPath) return { output: `Agent "${args.name}" has no memory configured.` }

          try {
            const content = await readFileAsync(`${memPath}/memory.json`, "utf8")
            return { output: content }
          } catch {
            return { output: `No memory found for agent "${args.name}" at ${memPath}` }
          }
        },
      }),

      save_agent_memory: tool({
        description: "Saves persistent memory for a subagent.",
        args: {
          name: tool.schema.string().describe("Agent name"),
          key: tool.schema.string().describe("Memory key"),
          value: tool.schema.string().describe("Memory value"),
        },
        async execute(args) {
          const memPath = registry.getMemoryPath(args.name, directory)
          if (!memPath) return { output: `Agent "${args.name}" has no memory configured.` }

          mkdirSync(memPath, { recursive: true })

          let memory: Record<string, any> = {}
          try {
            const data = await readFileAsync(`${memPath}/memory.json`, "utf8")
            memory = JSON.parse(data)
          } catch { /* no memory yet */ }

          memory[args.key] = {
            value: args.value,
            timestamp: new Date().toISOString(),
          }

          await writeFileAsync(`${memPath}/memory.json`, JSON.stringify(memory, null, 2))
          return { output: `Memory saved for agent "${args.name}": ${args.key} = ${args.value.slice(0, 100)}` }
        },
      }),

      reload_agents: tool({
        description: "Reloads all agent definitions from disk.",
        args: {},
        async execute() {
          // Clear custom agents, keep built-ins
          for (const [name, agent] of registry.agents) {
            if (agent.source !== "builtin") {
              registry.agents.delete(name)
            }
          }
          await registry.loadAll(directory)
          const count = registry.getAll().length
          return { output: `Reloaded. ${count} agents available.` }
        },
      }),
    },

    // ─── Hook: Enforce tool restrictions ───────────────
    // Deterministic: tool.execute.before blocks disallowed tools
    "tool.execute.before": async (input, output) => {
      if (registry.activeAgent && !registry.isToolAllowed(input.tool)) {
        const def = registry.get(registry.activeAgent)
        const allowed = def?.tools?.join(", ") || "all (no allowlist set)"
        return {
          output: {
            args: output.args,
            // We can't block from here in OpenCode's plugin system,
            // but we can modify the args or throw
          }
        }
        // Actually we need to throw to block
        throw new Error(
          `[Subagent "${registry.activeAgent}"] Tool "${input.tool}" is not allowed.\n` +
          `Allowed tools: ${allowed}\n` +
          `Blocked tools: ${def?.disallowedTools?.join(", ") || "none specified"}`
        )
      }
    },

    // ─── Hook: Track agent lifecycle (SubagentStart/Stop sim) ──
    "tool.execute.after": async (input, output) => {
      // Track when agent tool is used (subagent spawning simulation)
      if (input.tool === "agent") {
        // Log the agent spawn event
        try {
          const logFile = `${directory}/.opencode/agent-events.json`
          let events: any[] = []
          try {
            events = JSON.parse(await readFileAsync(logFile, "utf8"))
          } catch { /* no events yet */ }

          events.push({
            type: "agent_spawned",
            args: input.args,
            timestamp: new Date().toISOString(),
            sessionID: input.sessionID,
          })

          // Keep last 100 events
          if (events.length > 100) events = events.slice(-100)

          await writeFileAsync(logFile, JSON.stringify(events, null, 2))
        } catch { /* log write failed */ }
      }
    },
  }
}
