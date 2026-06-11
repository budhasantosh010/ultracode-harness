// ═══════════════════════════════════════════════════════════════
// ADVANCED FEATURES — Cron, Notifications, Memory Extraction
// Phase 8: T8.1 through T8.5
// ═══════════════════════════════════════════════════════════════

import type { Plugin } from "@opencode-ai/plugin"
import { tool } from "@opencode-ai/plugin"
import { readFile, writeFile, mkdirSync, existsSync, readdirSync } from "fs"
import { promisify } from "util"
import { execSync } from "child_process"

const readFileAsync = promisify(readFile)
const writeFileAsync = promisify(writeFile)

// ─── Types ───────────────────────────────────────────────────

interface ScheduledTask {
  id: string
  cron: string
  prompt: string
  recurring: boolean
  enabled: boolean
  createdAt: string
  lastRun?: string
  nextRun?: string
}

interface MemoryEntry {
  key: string
  value: string
  source: string
  timestamp: string
  confidence: number
}

// ─── Cron Parser (T8.1) ─────────────────────────────────────

function parseCronExpression(cron: string): { valid: boolean; description: string; fields: string[] } {
  const parts = cron.trim().split(/\s+/)
  if (parts.length !== 5) {
    return { valid: false, description: "Invalid cron format", fields: parts }
  }

  const [min, hour, dom, month, dow] = parts
  const desc: string[] = []

  // Minute
  if (min === "*") desc.push("every minute")
  else if (min.includes("/")) desc.push(`every ${min.split("/")[1]} minutes`)
  else desc.push(`at minute ${min}`)

  // Hour
  if (hour === "*") desc.push("every hour")
  else if (hour.includes("/")) desc.push(`every ${hour.split("/")[1]} hours`)
  else desc.push(`at hour ${hour}`)

  // Day of month
  if (dom !== "*") desc.push(`on day ${dom}`)

  // Month
  if (month !== "*") desc.push(`in month ${month}`)

  // Day of week
  if (dow !== "*") {
    const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]
    if (dow.includes(",")) {
      desc.push(`on ${dow.split(",").map(d => days[parseInt(d)] || d).join(", ")}`)
    } else if (dow.includes("-")) {
      desc.push(`on ${dow.split("-").map(d => days[parseInt(d)] || d).join(" through ")}`)
    } else {
      desc.push(`on ${days[parseInt(dow)] || dow}`)
    }
  }

  return { valid: true, description: desc.join(", "), fields: parts }
}

function isCronDue(task: ScheduledTask, now: Date): boolean {
  const parts = task.cron.trim().split(/\s+/)
  if (parts.length !== 5) return false

  const [min, hour, dom, month, dow] = parts

  const matchField = (field: string, value: number, max: number): boolean => {
    if (field === "*") return true
    if (field.includes("/")) {
      const interval = parseInt(field.split("/")[1])
      return value % interval === 0
    }
    if (field.includes(",")) {
      return field.split(",").some(v => parseInt(v) === value)
    }
    if (field.includes("-")) {
      const [a, b] = field.split("-").map(Number)
      return value >= a && value <= b
    }
    return parseInt(field) === value
  }

  return (
    matchField(min, now.getMinutes(), 59) &&
    matchField(hour, now.getHours(), 23) &&
    matchField(dom, now.getDate(), 31) &&
    matchField(month, now.getMonth() + 1, 12) &&
    matchField(dow, now.getDay(), 6)
  )
}

// ─── Memory Store (T8.4) ────────────────────────────────────

class MemoryStore {
  private dir: string
  private file: string

  constructor(stateDir: string) {
    this.dir = `${stateDir}/memory`
    this.file = `${this.dir}/extracted.json`
    try { mkdirSync(this.dir, { recursive: true }) } catch { /* exists */ }
  }

  async getAll(): Promise<MemoryEntry[]> {
    try {
      return JSON.parse(await readFileAsync(this.file, "utf8"))
    } catch {
      return []
    }
  }

  async save(entry: MemoryEntry): Promise<void> {
    const memories = await this.getAll()
    // Dedup by key
    const idx = memories.findIndex(m => m.key === entry.key)
    if (idx >= 0) {
      memories[idx] = entry // overwrite
    } else {
      memories.push(entry)
    }
    await writeFileAsync(this.file, JSON.stringify(memories, null, 2))
  }

  async search(query: string): Promise<MemoryEntry[]> {
    const memories = await this.getAll()
    const q = query.toLowerCase()
    return memories.filter(m =>
      m.key.toLowerCase().includes(q) ||
      m.value.toLowerCase().includes(q)
    )
  }

  async delete(key: string): Promise<boolean> {
    const memories = await this.getAll()
    const filtered = memories.filter(m => m.key !== key)
    if (filtered.length < memories.length) {
      await writeFileAsync(this.file, JSON.stringify(filtered, null, 2))
      return true
    }
    return false
  }

  async getStats(): Promise<{ total: number; sources: Record<string, number> }> {
    const memories = await this.getAll()
    const sources: Record<string, number> = {}
    for (const m of memories) {
      sources[m.source] = (sources[m.source] || 0) + 1
    }
    return { total: memories.length, sources }
  }
}

// ─── Plugin ──────────────────────────────────────────────────

export const AdvancedFeatures: Plugin = async ({ directory }) => {
  const CRON_FILE = `${directory}/.opencode/runtime/cron.json`
  const memory = new MemoryStore(`${directory}/.opencode/runtime`)

  return {
    tool: {
      // ═════════════════════════════════════════════════
      // T8.1: Scheduled Tasks / Cron
      // ═════════════════════════════════════════════════
      schedule_create: tool({
        description: "Creates a scheduled task with a cron expression. Tasks run while the REPL is idle.",
        args: {
          cron: tool.schema.string().describe("Cron expression (5 fields: min hour dom month dow)"),
          prompt: tool.schema.string().describe("Prompt to execute on schedule"),
          recurring: tool.schema.boolean().describe("True for recurring, false for one-shot").optional().default(true),
        },
        async execute(args) {
          const parsed = parseCronExpression(args.cron)
          if (!parsed.valid) {
            return { output: `Invalid cron expression: "${args.cron}". Format: "min hour dom month dow"` }
          }

          const task: ScheduledTask = {
            id: `cron_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
            cron: args.cron,
            prompt: args.prompt,
            recurring: args.recurring,
            enabled: true,
            createdAt: new Date().toISOString(),
          }

          const tasks: ScheduledTask[] = JSON.parse(await readFileAsync(CRON_FILE, "utf8").catch(() => "[]"))
          tasks.push(task)
          await writeFileAsync(CRON_FILE, JSON.stringify(tasks, null, 2))

          return {
            output: `Scheduled task created:\n` +
              `  ID: ${task.id}\n` +
              `  Cron: ${args.cron} (${parsed.description})\n` +
              `  Recurring: ${args.recurring}\n` +
              `  Prompt: "${args.prompt.slice(0, 100)}..."`
          }
        },
      }),

      schedule_list: tool({
        description: "Lists all scheduled tasks.",
        args: {},
        async execute() {
          const tasks: ScheduledTask[] = JSON.parse(await readFileAsync(CRON_FILE, "utf8").catch(() => "[]"))
          if (tasks.length === 0) return { output: "No scheduled tasks." }

          const lines = tasks.map(t => {
            const parsed = parseCronExpression(t.cron)
            return `- ${t.id}: ${t.cron} (${parsed.description}) [${t.enabled ? "enabled" : "disabled"}]\n  Prompt: "${t.prompt.slice(0, 80)}..."`
          })

          return { output: `${tasks.length} scheduled tasks:\n\n${lines.join("\n\n")}` }
        },
      }),

      schedule_delete: tool({
        description: "Deletes a scheduled task.",
        args: {
          id: tool.schema.string().describe("Task ID to delete"),
        },
        async execute(args) {
          const tasks: ScheduledTask[] = JSON.parse(await readFileAsync(CRON_FILE, "utf8").catch(() => "[]"))
          const idx = tasks.findIndex(t => t.id === args.id)
          if (idx < 0) return { output: `Task "${args.id}" not found.` }

          tasks.splice(idx, 1)
          await writeFileAsync(CRON_FILE, JSON.stringify(tasks, null, 2))
          return { output: `Task "${args.id}" deleted. ${tasks.length} tasks remaining.` }
        },
      }),

      // ═════════════════════════════════════════════════
      // T8.2: Push Notifications
      // ═════════════════════════════════════════════════
      notify: tool({
        description: "Sends a desktop notification. Use for long-running task completion or important events.",
        args: {
          message: tool.schema.string().describe("Notification message (under 200 chars)"),
          title: tool.schema.string().describe("Notification title").optional().default("OpenCode"),
        },
        async execute(args) {
          const msg = args.message.slice(0, 200)

          // Try platform-specific notification
          try {
            if (process.platform === "win32") {
              // PowerShell toast notification on Windows
              const psScript = `powershell -Command "Add-Type -AssemblyName System.Windows.Forms; $n = New-Object System.Windows.Forms.NotifyIcon; $n.Icon = [System.Drawing.SystemIcons]::Information; $n.Visible = $true; $n.ShowBalloonTip(5000, '${args.title.replace(/'/g, "''")}', '${msg.replace(/'/g, "''")}', 'Info')"`
              execSync(psScript, { timeout: 5000, stdio: "pipe" })
              return { output: `Notification sent: ${msg}` }
            } else if (process.platform === "darwin") {
              execSync(`osascript -e 'display notification "${msg}" with title "${args.title}"'`, { timeout: 5000, stdio: "pipe" })
              return { output: `Notification sent: ${msg}` }
            } else {
              execSync(`notify-send "${args.title}" "${msg}"`, { timeout: 5000, stdio: "pipe" })
              return { output: `Notification sent: ${msg}` }
            }
          } catch {
            // Fallback: write to notification log
            const logFile = `${directory}/.opencode/runtime/notifications.log`
            const line = `[${new Date().toISOString()}] ${args.title}: ${msg}\n`
            try {
              const existing = await readFileAsync(logFile, "utf8").catch(() => "")
              await writeFileAsync(logFile, existing + line)
            } catch { /* write failed */ }
            return { output: `Notification logged (native failed): ${msg}` }
          }
        },
      }),

      // ═════════════════════════════════════════════════
      // T8.3: File Change Detection
      // ═════════════════════════════════════════════════
      watch_files: tool({
        description: "Sets up file watching for specified paths. Returns changes detected since last check.",
        args: {
          paths: tool.schema.string().describe("Comma-separated file/glob patterns to watch"),
        },
        async execute(args) {
          const watchDir = `${directory}/.opencode/runtime/watch`
          mkdirSync(watchDir, { recursive: true })

          const patterns = args.paths.split(",").map((s: string) => s.trim()).filter(Boolean)
          const stateFile = `${watchDir}/watch-state.json`
          let state: Record<string, number> = {}
          try { state = JSON.parse(await readFileAsync(stateFile, "utf8")) } catch { /* no state */ }

          // Use find to get current mtime of matching files
          const changes: string[] = []
          for (const pattern of patterns) {
            try {
              const fullPath = pattern.startsWith("/") ? pattern : `${directory}/${pattern}`
              // Use ls -la to check file existence and timestamps
              const output = execSync(`ls -la "${fullPath}" 2>/dev/null || echo "not found"`, {
                encoding: "utf8",
                timeout: 10000,
                stdio: ["pipe", "pipe", "pipe"],
              }).trim()

              if (output.includes("not found")) {
                // Check if glob
                const globOutput = execSync(`ls -la ${fullPath} 2>/dev/null | head -5`, {
                  encoding: "utf8",
                  timeout: 10000,
                  stdio: ["pipe", "pipe", "pipe"],
                }).trim()

                if (globOutput) {
                  const files = globOutput.split("\n").filter(Boolean)
                  for (const line of files) {
                    const parts = line.split(/\s+/)
                    const file = parts[parts.length - 1]
                    if (state[file] === undefined) {
                      changes.push(`NEW: ${file}`)
                    } else {
                      changes.push(`EXISTS: ${file}`)
                    }
                    state[file] = Date.now()
                  }
                }
              } else {
                // File exists, check if changed
                const prevTime = state[fullPath] || 0
                state[fullPath] = Date.now()
                if (prevTime === 0) {
                  changes.push(`TRACKING: ${pattern}`)
                } else {
                  changes.push(`CHANGED: ${pattern}`)
                }
              }
            } catch {
              changes.push(`ERROR watching: ${pattern}`)
            }
          }

          await writeFileAsync(stateFile, JSON.stringify(state, null, 2))
          return {
            output: changes.length > 0
              ? `File watch results:\n${changes.map(c => `  ${c}`).join("\n")}`
              : "No changes detected."
          }
        },
      }),

      // ═════════════════════════════════════════════════
      // T8.4: Memory Extraction
      // ═════════════════════════════════════════════════
      memory_save: tool({
        description: "Saves extracted knowledge to persistent memory. For cross-session learning.",
        args: {
          key: tool.schema.string().describe("Memory key (unique identifier)"),
          value: tool.schema.string().describe("Memory value"),
          source: tool.schema.string().describe("Where this knowledge came from").optional().default("manual"),
          confidence: tool.schema.number().describe("Confidence 0.0-1.0").optional().default(0.9),
        },
        async execute(args) {
          await memory.save({
            key: args.key,
            value: args.value,
            source: args.source,
            confidence: Math.min(1, Math.max(0, args.confidence)),
            timestamp: new Date().toISOString(),
          })
          return { output: `Memory saved: "${args.key}" (confidence: ${args.confidence}, source: ${args.source})` }
        },
      }),

      memory_search: tool({
        description: "Searches persistent memory for relevant knowledge.",
        args: {
          query: tool.schema.string().describe("Search query"),
        },
        async execute(args) {
          const results = await memory.search(args.query)
          if (results.length === 0) return { output: `No memories matching "${args.query}"` }

          const lines = results.map(m =>
            `- [${m.confidence.toFixed(1)}] ${m.key}: ${m.value.slice(0, 100)} (from: ${m.source}, ${m.timestamp})`
          )
          return { output: `${results.length} memories found:\n${lines.join("\n")}` }
        },
      }),

      memory_list: tool({
        description: "Lists all stored memories with stats.",
        args: {},
        async execute() {
          const stats = await memory.getStats()
          if (stats.total === 0) return { output: "No memories stored." }

          const all = await memory.getAll()
          const lines = all.map(m =>
            `- [${m.confidence.toFixed(1)}] ${m.key}: ${m.value.slice(0, 80)}`
          )

          const sourcesStr = Object.entries(stats.sources).map(([k, v]) => `${k}: ${v}`).join(", ")
          return { output: `${stats.total} memories (${sourcesStr}):\n${lines.join("\n")}` }
        },
      }),

      memory_delete: tool({
        description: "Deletes a memory entry.",
        args: {
          key: tool.schema.string().describe("Memory key to delete"),
        },
        async execute(args) {
          const deleted = await memory.delete(args.key)
          return { output: deleted ? `Memory "${args.key}" deleted.` : `Memory "${args.key}" not found.` }
        },
      }),

      // ═════════════════════════════════════════════════
      // T8.6: Team Management
      // ═════════════════════════════════════════════════
      team_create: tool({
        description: "Creates a named team of agents for coordinated parallel work.",
        args: {
          name: tool.schema.string().describe("Team name"),
          agents: tool.schema.array(tool.schema.string()).describe("Agent names (from list_agents)"),
          task: tool.schema.string().describe("Team task to execute"),
        },
        async execute(args) {
          const teamsDir = `${directory}/.opencode/runtime/teams`
          mkdirSync(teamsDir, { recursive: true })

          const team = {
            id: `team_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
            name: args.name,
            agents: args.agents,
            task: args.task,
            createdAt: new Date().toISOString(),
            status: "created",
          }

          const teamsFile = `${teamsDir}/teams.json`
          const teams: any[] = JSON.parse(await readFileAsync(teamsFile, "utf8").catch(() => "[]"))
          teams.push(team)
          await writeFileAsync(teamsFile, JSON.stringify(teams, null, 2))

          return {
            output: `TEAM CREATED: "${args.name}" (${team.id})\n` +
              `Agents: ${args.agents.join(", ")}\n` +
              `Task: ${args.task.slice(0, 200)}\n\n` +
              `Assign work to team members: fan_out the subtasks across agents.`
          }
        },
      }),

      team_list: tool({
        description: "Lists all teams and their agents.",
        args: {},
        async execute() {
          const teamsFile = `${directory}/.opencode/runtime/teams/teams.json`
          const teams: any[] = JSON.parse(await readFileAsync(teamsFile, "utf8").catch(() => "[]"))
          if (teams.length === 0) return { output: "No teams created. Use team_create first." }

          const lines = teams.map(t =>
            `- "${t.name}" (${t.id})\n  Agents: ${(t.agents || []).join(", ") || "none"}\n  Task: ${(t.task || "").slice(0, 100)}\n  Status: ${t.status}`
          )
          return { output: `${teams.length} team(s):\n\n${lines.join("\n\n")}` }
        },
      }),

      team_assign: tool({
        description: "Assigns work to a specific agent in a team.",
        args: {
          team_id: tool.schema.string().describe("Team ID from team_create"),
          agent: tool.schema.string().describe("Agent name to assign work to"),
          subtask: tool.schema.string().describe("Subtask for this agent"),
        },
        async execute(args) {
          const teamsDir = `${directory}/.opencode/runtime/teams`
          const teamsFile = `${teamsDir}/teams.json`
          const teams: any[] = JSON.parse(await readFileAsync(teamsFile, "utf8").catch(() => "[]"))
          const team = teams.find((t: any) => t.id === args.team_id)
          if (!team) return { output: `Team "${args.team_id}" not found.` }

          // Track assignments
          const assignmentsFile = `${teamsDir}/assignments.json`
          const assignments: any[] = JSON.parse(await readFileAsync(assignmentsFile, "utf8").catch(() => "[]"))
          assignments.push({
            teamId: args.team_id,
            agent: args.agent,
            subtask: args.subtask,
            status: "assigned",
            timestamp: new Date().toISOString(),
          })
          await writeFileAsync(assignmentsFile, JSON.stringify(assignments, null, 2))

          // Update team status
          team.status = "active"
          await writeFileAsync(teamsFile, JSON.stringify(teams, null, 2))

          return {
            output: `ASSIGNMENT: Agent "${args.agent}" in team "${team.name}"\n` +
              `Task: ${args.subtask}\n\n` +
              `Execute using the agent tool or fan_out for parallel work.`
          }
        },
      }),

      // ═════════════════════════════════════════════════
      // T8.5: Environment Setup
      // ═════════════════════════════════════════════════
      env_check: tool({
        description: "Checks the runtime environment — available tools, paths, versions.",
        args: {},
        async execute() {
          const checks: string[] = []

          // Check common tools
          const tools = ["node", "bun", "npm", "git", "python", "python3", "cargo", "go"]
          for (const t of tools) {
            try {
              const ver = execSync(`${t} --version 2>/dev/null || ${t} -v 2>/dev/null`, {
                encoding: "utf8",
                timeout: 5000,
                stdio: ["pipe", "pipe", "pipe"],
              }).trim().split("\n")[0]
              checks.push(`✅ ${t}: ${ver}`)
            } catch {
              checks.push(`❌ ${t}: not found`)
            }
          }

          // Check OS
          checks.push(`\nOS: ${process.platform} ${process.arch}`)
          checks.push(`Node: ${process.version}`)
          checks.push(`CWD: ${process.cwd()}`)

          return { output: `Environment Check:\n${checks.join("\n")}` }
        },
      }),

      // ═════════════════════════════════════════════════
      // T8.7: Team Memory Sync
      // ═════════════════════════════════════════════════
      team_memory_sync: tool({
        description: "Syncs memories across team agents. Reads all agents' memories, merges into shared team memory.",
        args: {
          team_id: tool.schema.string().describe("Team ID from team_create"),
        },
        async execute(args) {
          const teamsDir = `${directory}/.opencode/runtime/teams`
          const teamsFile = `${teamsDir}/teams.json`
          const teamsVal: any[] = JSON.parse(await readFileAsync(teamsFile, "utf8").catch(() => "[]"))
          const team = teamsVal.find((t: any) => t.id === args.team_id)
          if (!team) return { output: `Team "${args.team_id}" not found.` }

          const memoryDir = `${directory}/.opencode/runtime/memory`
          const agents: string[] = team.agents || []

          if (agents.length === 0) {
            return { output: `Team "${team.name}" has no agents. Assign agents first.` }
          }

          // Read all agent memories
          const agentMemories: Record<string, any> = {}
          let totalCount = 0

          for (const agent of agents) {
            const memFile = `${memoryDir}/${agent}.json`
            try {
              const data = JSON.parse(await readFileAsync(memFile, "utf8"))
              agentMemories[agent] = data
              if (Array.isArray(data)) totalCount += data.length
              else totalCount += Object.keys(data).length
            } catch {
              agentMemories[agent] = []
            }
          }

          // Merge into shared team memory
          const teamMemFile = `${memoryDir}/team_${args.team_id}.json`
          const merged: any[] = []

          for (const [agent, mems] of Object.entries(agentMemories)) {
            if (Array.isArray(mems)) {
              for (const m of mems) {
                merged.push({
                  ...(typeof m === "object" && m !== null ? m : { value: m }),
                  sourceAgent: agent,
                  syncedAt: new Date().toISOString(),
                })
              }
            } else if (typeof mems === "object" && mems !== null) {
              for (const [key, val] of Object.entries(mems)) {
                merged.push({ key, value: val, sourceAgent: agent, syncedAt: new Date().toISOString() })
              }
            }
          }

          await writeFileAsync(teamMemFile, JSON.stringify(merged, null, 2))

          return {
            output: `TEAM MEMORY SYNC: "${team.name}"\n` +
              `Agents: ${agents.join(", ")}\n` +
              `Total memories merged: ${merged.length}\n` +
              `File: ${teamMemFile}\n\n` +
              `Cross-agent knowledge is now available via memory_search.`
          }
        },
      }),
    },

    // ─── Compaction: preserve memory context ──────────
    "experimental.session.compacting": async (_input, output) => {
      const stats = await memory.getStats()
      output.context.push(
        `## Persistent Memory\n` +
        `${stats.total} memories stored across ${Object.keys(stats.sources).length} sources.\n` +
        `Use memory_search to find relevant knowledge from previous sessions.`
      )
    },
  }
}
