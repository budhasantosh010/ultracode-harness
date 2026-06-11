import type { Plugin } from "@opencode-ai/plugin"
import { tool } from "@opencode-ai/plugin"
import { mkdirSync, readdirSync } from "fs"
import { readFile, writeFile } from "fs/promises"

export const OpenCodeRuntime: Plugin = async ({ directory }) => {
  const RUNTIME_DIR = `${directory}/.opencode/runtime`
  const STATE_FILE = `${RUNTIME_DIR}/state.json`
  const MESSAGES_DIR = `${RUNTIME_DIR}/messages`
  const TASKS_FILE = `${RUNTIME_DIR}/tasks.json`
  const PROGRESS_FILE = `${RUNTIME_DIR}/progress.json`
  const WORKDIR_BASE = `${RUNTIME_DIR}/workdirs`
  const CHECKPOINTS_DIR = `${RUNTIME_DIR}/checkpoints`
  const EVENTS_FILE = `${RUNTIME_DIR}/events.json`

  try {
    mkdirSync(RUNTIME_DIR, { recursive: true })
    mkdirSync(MESSAGES_DIR, { recursive: true })
    mkdirSync(WORKDIR_BASE, { recursive: true })
    mkdirSync(CHECKPOINTS_DIR, { recursive: true })
  } catch { /* dirs may already exist */ }

  // ─── Event Logger (T6.2) ──────────────────────────────────
  async function appendEvent(type: string, workflowId: string, data: Record<string, any>) {
    const events = JSON.parse(await readFile(EVENTS_FILE, "utf8").catch(() => "[]"))
    events.push({ type, workflowId, ...data, timestamp: new Date().toISOString() })
    // Keep last 500 events
    if (events.length > 500) events.splice(0, events.length - 500)
    await writeFile(EVENTS_FILE, JSON.stringify(events, null, 2))
  }

  return {
    tool: {
      // ═══════════════════════════════════════════════════
      // STATE MANAGEMENT
      // ═══════════════════════════════════════════════════
      save_state: tool({
        description: "Saves workflow state to disk. Enables background execution and resume.",
        args: {
          workflow_id: tool.schema.string().describe("Unique workflow ID"),
          step: tool.schema.number().describe("Current step number"),
          data: tool.schema.string().describe("JSON string of state to save"),
        },
        async execute(args) {
          const state = JSON.parse(await readFile(STATE_FILE, "utf8").catch(() => "{}"))
          state[args.workflow_id] = {
            step: args.step,
            data: JSON.parse(args.data),
            timestamp: new Date().toISOString(),
            status: "running"
          }
          await writeFile(STATE_FILE, JSON.stringify(state, null, 2))
          return { output: `State saved: workflow="${args.workflow_id}" step=${args.step}` }
        }
      }),

      load_state: tool({
        description: "Loads saved workflow state. Enables resuming interrupted runs.",
        args: {
          workflow_id: tool.schema.string().describe("Workflow ID to load"),
        },
        async execute(args) {
          const state = JSON.parse(await readFile(STATE_FILE, "utf8").catch(() => "{}"))
          const wf = state[args.workflow_id]
          return { output: wf ? JSON.stringify(wf, null, 2) : `Workflow "${args.workflow_id}" not found` }
        }
      }),

      complete_workflow: tool({
        description: "Marks a workflow as complete.",
        args: {
          workflow_id: tool.schema.string().describe("Workflow ID"),
          result: tool.schema.string().describe("Final result"),
        },
        async execute(args) {
          const state = JSON.parse(await readFile(STATE_FILE, "utf8").catch(() => "{}"))
          if (state[args.workflow_id]) {
            state[args.workflow_id].status = "complete"
            state[args.workflow_id].result = args.result
            state[args.workflow_id].completedAt = new Date().toISOString()
          }
          await writeFile(STATE_FILE, JSON.stringify(state, null, 2))
          return { output: `Workflow "${args.workflow_id}" marked complete: ${args.result}` }
        }
      }),

      // ═══════════════════════════════════════════════════
      // WORKSPACE ISOLATION
      // ═══════════════════════════════════════════════════
      create_workdir: tool({
        description: "Creates an isolated workspace directory for an agent.",
        args: {
          agent_name: tool.schema.string().describe("Agent identifier"),
          workflow_id: tool.schema.string().describe("Workflow ID"),
        },
        async execute(args) {
          const workdir = `${WORKDIR_BASE}/${args.workflow_id}/${args.agent_name}`
          mkdirSync(workdir, { recursive: true })
          return { output: `Created workspace: ${workdir}` }
        }
      }),

      merge_workdirs: tool({
        description: "Merges results from multiple agent workdirs.",
        args: {
          workflow_id: tool.schema.string().describe("Workflow ID"),
          agents: tool.schema.array(tool.schema.string()).describe("Agent names whose workdirs to merge"),
        },
        async execute(args) {
          const results: string[] = []
          for (const agent of args.agents) {
            const workdir = `${WORKDIR_BASE}/${args.workflow_id}/${agent}`
            try {
              const files = readdirSync(workdir)
              results.push(`${agent}: ${files.join(", ") || "empty"}`)
            } catch {
              results.push(`${agent}: empty`)
            }
          }
          return { output: `Merged ${results.length} workdirs:\n${results.join("\n")}` }
        }
      }),

      // ═══════════════════════════════════════════════════
      // PROGRESS TRACKING
      // ═══════════════════════════════════════════════════
      update_progress: tool({
        description: "Updates workflow progress.",
        args: {
          workflow_id: tool.schema.string().describe("Workflow ID"),
          phase: tool.schema.string().describe("Current phase name"),
          status: tool.schema.string().describe("running/complete/error"),
          details: tool.schema.string().describe("Phase details").optional().default(""),
        },
        async execute(args) {
          const progress = JSON.parse(await readFile(PROGRESS_FILE, "utf8").catch(() => "{}"))
          if (!progress[args.workflow_id]) progress[args.workflow_id] = { phases: [] }
          progress[args.workflow_id].phases.push({
            phase: args.phase,
            status: args.status,
            details: args.details,
            timestamp: new Date().toISOString()
          })
          await writeFile(PROGRESS_FILE, JSON.stringify(progress, null, 2))
          return { output: `Progress updated: workflow="${args.workflow_id}" phase="${args.phase}" status=${args.status}` }
        }
      }),

      get_progress: tool({
        description: "Reads workflow progress.",
        args: {
          workflow_id: tool.schema.string().describe("Workflow ID"),
        },
        async execute(args) {
          const progress = JSON.parse(await readFile(PROGRESS_FILE, "utf8").catch(() => "{}"))
          const wf = progress[args.workflow_id] || { phases: [] }
          return { output: JSON.stringify(wf, null, 2) }
        }
      }),

      // ═══════════════════════════════════════════════════
      // MESSAGE BUS
      // ═══════════════════════════════════════════════════
      send_message: tool({
        description: "Sends a message from one agent to another.",
        args: {
          from: tool.schema.string().describe("Sender agent name"),
          to: tool.schema.string().describe("Recipient agent name"),
          content: tool.schema.string().describe("Message content"),
          workflow_id: tool.schema.string().describe("Workflow ID"),
        },
        async execute(args) {
          const msgDir = `${MESSAGES_DIR}/${args.workflow_id}`
          mkdirSync(msgDir, { recursive: true })
          const msgFile = `${msgDir}/${args.to}.json`
          const messages = JSON.parse(await readFile(msgFile, "utf8").catch(() => "[]"))
          messages.push({
            from: args.from,
            content: args.content,
            timestamp: new Date().toISOString()
          })
          await writeFile(msgFile, JSON.stringify(messages, null, 2))
          return { output: `Message sent from "${args.from}" to "${args.to}" (${args.content.length} chars)` }
        }
      }),

      read_messages: tool({
        description: "Reads messages for an agent. Clears after reading.",
        args: {
          agent: tool.schema.string().describe("Agent name"),
          workflow_id: tool.schema.string().describe("Workflow ID"),
        },
        async execute(args) {
          const msgFile = `${MESSAGES_DIR}/${args.workflow_id}/${args.agent}.json`
          const messages = JSON.parse(await readFile(msgFile, "utf8").catch(() => "[]"))
          await writeFile(msgFile, "[]")
          return { output: messages.length > 0 ? JSON.stringify(messages, null, 2) : "No messages" }
        }
      }),

      // ═══════════════════════════════════════════════════
      // SHARED TASK LIST
      // ═══════════════════════════════════════════════════
      create_tasks: tool({
        description: "Creates a shared task list for a workflow. Supports dependency tracking — tasks with dependencies only become claimable when their deps are complete.",
        args: {
          workflow_id: tool.schema.string().describe("Workflow ID"),
          tasks: tool.schema.array(tool.schema.string()).describe("Task descriptions"),
          dependencies: tool.schema.string().describe('JSON map of task_index -> [dep_task_indices]. e.g. {"2":[0,1]} means task 2 depends on tasks 0 and 1').optional().default("{}"),
        },
        async execute(args) {
          let deps: Record<string, number[]> = {}
          try { deps = JSON.parse(args.dependencies) } catch { /* ignore */ }

          const tasks = args.tasks.map((t, i) => {
            const taskDeps = deps[String(i)] || []
            return {
              id: i,
              description: t,
              status: taskDeps.length > 0 ? "blocked" : "pending",
              claimed_by: null,
              result: null,
              depends_on: taskDeps,
              blocked_reason: taskDeps.length > 0 ? `Waiting for tasks: ${taskDeps.join(", ")}` : null,
            }
          })

          const all = JSON.parse(await readFile(TASKS_FILE, "utf8").catch(() => "{}"))
          all[args.workflow_id] = tasks
          await writeFile(TASKS_FILE, JSON.stringify(all, null, 2))

          // T6.2: Emit TaskCreated events
          for (const task of tasks) {
            await appendEvent("TaskCreated", args.workflow_id, {
              taskId: task.id,
              description: task.description,
              dependsOn: task.depends_on,
            })
          }

          const blocked = tasks.filter(t => t.depends_on.length > 0).length
          return { output: `Created ${tasks.length} tasks for workflow "${args.workflow_id}" (${blocked} have dependencies)` }
        }
      }),

      claim_task: tool({
        description: "Claims a task from the shared list. Tasks with unmet dependencies cannot be claimed.",
        args: {
          workflow_id: tool.schema.string().describe("Workflow ID"),
          task_id: tool.schema.number().describe("Task ID to claim"),
          agent: tool.schema.string().describe("Agent claiming"),
        },
        async execute(args) {
          const all = JSON.parse(await readFile(TASKS_FILE, "utf8").catch(() => "{}"))
          const tasks = all[args.workflow_id] || []
          const task = tasks.find((t: any) => t.id === args.task_id)
          if (task && task.status === "pending") {
            task.status = "in_progress"
            task.claimed_by = args.agent
            all[args.workflow_id] = tasks
            await writeFile(TASKS_FILE, JSON.stringify(all, null, 2))
            await appendEvent("TaskClaimed", args.workflow_id, { taskId: args.task_id, agent: args.agent })
            return { output: `Task ${args.task_id} claimed by "${args.agent}"` }
          }
          if (task && task.status === "blocked") {
            return { output: `Task ${args.task_id} is blocked. Waiting for: ${task.blocked_reason}` }
          }
          return { output: `Task ${args.task_id} not available (status: ${task?.status || "not found"})` }
        }
      }),

      complete_task: tool({
        description: "Marks a task as complete with result. Automatically unblocks downstream tasks that were waiting on this one.",
        args: {
          workflow_id: tool.schema.string().describe("Workflow ID"),
          task_id: tool.schema.number().describe("Task ID"),
          result: tool.schema.string().describe("Task result"),
        },
        async execute(args) {
          const all = JSON.parse(await readFile(TASKS_FILE, "utf8").catch(() => "{}"))
          const tasks = all[args.workflow_id] || []
          const task = tasks.find((t: any) => t.id === args.task_id)
          if (task) {
            task.status = "complete"
            task.result = args.result
            all[args.workflow_id] = tasks
            await writeFile(TASKS_FILE, JSON.stringify(all, null, 2))
            await appendEvent("TaskCompleted", args.workflow_id, { taskId: args.task_id, result: args.result })

            // T6.1: Unblock downstream tasks whose deps are now all satisfied
            const unblocked: string[] = []
            for (const other of tasks) {
              if (other.status === "blocked" && other.depends_on) {
                const depsSatisfied = other.depends_on.every((depId: number) => {
                  const depTask = tasks.find((t: any) => t.id === depId)
                  return depTask && depTask.status === "complete"
                })
                if (depsSatisfied) {
                  other.status = "pending"
                  other.blocked_reason = null
                  unblocked.push(`Task ${other.id}`)
                }
              }
            }

            let output = `Task ${args.task_id} completed: ${args.result}`
            if (unblocked.length > 0) {
              output += `\nUnblocked: ${unblocked.join(", ")} — now claimable by agents`
            }
            return { output }
          }
          return { output: `Task ${args.task_id} not found` }
        }
      }),

      get_pending_tasks: tool({
        description: "Gets all pending (claimable) tasks — excludes blocked tasks waiting on dependencies.",
        args: {
          workflow_id: tool.schema.string().describe("Workflow ID"),
        },
        async execute(args) {
          const all = JSON.parse(await readFile(TASKS_FILE, "utf8").catch(() => "{}"))
          const tasks = all[args.workflow_id] || []
          const pending = tasks.filter((t: any) => t.status === "pending")
          const blocked = tasks.filter((t: any) => t.status === "blocked")
          let output = pending.length > 0
            ? `CLAIMABLE (${pending.length}):\n${JSON.stringify(pending, null, 2)}`
            : "No claimable tasks"
          if (blocked.length > 0) {
            output += `\n\nBLOCKED (${blocked.length}):\n${blocked.map((t: any) => `  Task ${t.id}: ${t.blocked_reason}`).join("\n")}`
          }
          return { output }
        }
      }),

      // ═══════════════════════════════════════════════════
      // T6.2: TASK LIFECYCLE EVENTS
      // ═══════════════════════════════════════════════════
      get_task_events: tool({
        description: "Gets recent task lifecycle events (TaskCreated, TaskClaimed, TaskCompleted) for coordination between agents.",
        args: {
          workflow_id: tool.schema.string().describe("Workflow ID"),
          since: tool.schema.string().describe("ISO timestamp — only return events after this time").optional().default(""),
        },
        async execute(args) {
          const events = JSON.parse(await readFile(EVENTS_FILE, "utf8").catch(() => "[]"))
          let filtered = events.filter((e: any) => e.workflowId === args.workflow_id)
          if (args.since) {
            filtered = filtered.filter((e: any) => e.timestamp > args.since)
          }
          // Return last 50 most relevant
          const recent = filtered.slice(-50)
          if (recent.length === 0) return { output: `No events for workflow "${args.workflow_id}"` }
          return { output: JSON.stringify(recent, null, 2) }
        }
      }),

      // ═══════════════════════════════════════════════════
      // RETRY MANAGER
      // ═══════════════════════════════════════════════════
      record_failure: tool({
        description: "Records a failure for retry tracking.",
        args: {
          workflow_id: tool.schema.string().describe("Workflow ID"),
          step: tool.schema.number().describe("Step that failed"),
          error: tool.schema.string().describe("Error message"),
          max_retries: tool.schema.number().describe("Max retry attempts").optional().default(3),
        },
        async execute(args) {
          const state = JSON.parse(await readFile(STATE_FILE, "utf8").catch(() => "{}"))
          const wf = state[args.workflow_id] || { failures: [] }
          if (!wf.failures) wf.failures = []
          wf.failures.push({
            step: args.step,
            error: args.error,
            timestamp: new Date().toISOString()
          })
          const attempts = wf.failures.filter((f: any) => f.step === args.step).length
          const shouldRetry = attempts < args.max_retries
          state[args.workflow_id] = wf
          await writeFile(STATE_FILE, JSON.stringify(state, null, 2))
          return { output: `Failure recorded: step=${args.step}, attempts=${attempts}/${args.max_retries}, retry=${shouldRetry}` }
        }
      }),

      // ═══════════════════════════════════════════════════
      // CHECKPOINT SAVE/RESTORE (Feature 3: Checkpoint Rewind)
      // ═══════════════════════════════════════════════════
      save_checkpoint: tool({
        description: "Saves a checkpoint for rewinding later.",
        args: {
          checkpoint_id: tool.schema.string().describe("Checkpoint identifier"),
          description: tool.schema.string().describe("What this checkpoint captures"),
          data: tool.schema.string().describe("JSON string of state to save"),
        },
        async execute(args) {
          const checkpoint = {
            id: args.checkpoint_id,
            description: args.description,
            data: JSON.parse(args.data),
            timestamp: new Date().toISOString()
          }
          await writeFile(
            `${CHECKPOINTS_DIR}/${args.checkpoint_id}.json`,
            JSON.stringify(checkpoint, null, 2)
          )
          return { output: `Checkpoint "${args.checkpoint_id}" saved: ${args.description}` }
        }
      }),

      load_checkpoint: tool({
        description: "Loads a saved checkpoint for rewinding.",
        args: {
          checkpoint_id: tool.schema.string().describe("Checkpoint to load"),
        },
        async execute(args) {
          try {
            const data = await readFile(`${CHECKPOINTS_DIR}/${args.checkpoint_id}.json`, "utf8")
            const parsed = JSON.parse(data)
            return { output: JSON.stringify(parsed, null, 2) }
          } catch {
            return { output: `Checkpoint "${args.checkpoint_id}" not found` }
          }
        }
      }),

      list_checkpoints: tool({
        description: "Lists all saved checkpoints.",
        args: {},
        async execute() {
          try {
            const files = readdirSync(CHECKPOINTS_DIR)
            const names = files.filter(Boolean).map(n => n.replace(".json", ""))
            return { output: names.length > 0 ? names.join("\n") : "No checkpoints" }
          } catch {
            return { output: "No checkpoints" }
          }
        }
      }),

      // ═════════════════════════════════════════════════
      // TaskStopTool: Stop a running task
      // ═════════════════════════════════════════════════
      task_stop: tool({
        description: "Stops a running task, marking it as cancelled. Use when a task needs to be abandoned or is stuck. Equivalent to Claude Code's TaskStopTool.",
        args: {
          workflow_id: tool.schema.string().describe("Workflow ID containing the task"),
          task_id: tool.schema.number().describe("Task ID to stop"),
          reason: tool.schema.string().describe("Reason for stopping").optional().default(""),
        },
        async execute(args) {
          try {
            const raw = await readFile(`${RUNTIME_DIR}/tasks.json`, "utf8")
            const all = JSON.parse(raw)
            const tasks = all[args.workflow_id] || []
            const task = tasks.find((t: any) => t.id === args.task_id)
            if (task && (task.status === "pending" || task.status === "in_progress")) {
              task.status = "cancelled"
              task.result = args.reason || "Cancelled by user"
              all[args.workflow_id] = tasks
              await writeFile(`${RUNTIME_DIR}/tasks.json`, JSON.stringify(all, null, 2))
              return { output: `Task ${args.task_id} stopped: ${args.reason || "cancelled"}` }
            }
            return { output: `Task ${args.task_id} not running (status: ${task?.status || "not found"})` }
          } catch { return { output: `Task ${args.task_id} not found.` } }
        }
      }),

      // ═════════════════════════════════════════════════
      // TaskUpdateTool: Update task properties
      // ═════════════════════════════════════════════════
      task_update: tool({
        description: "Updates a task's properties (status, description, priority). Use to modify tasks after creation. Equivalent to Claude Code's TaskUpdateTool.",
        args: {
          workflow_id: tool.schema.string().describe("Workflow ID"),
          task_id: tool.schema.number().describe("Task ID to update"),
          status: tool.schema.enum(["pending", "in_progress", "complete", "cancelled"]).describe("New status").optional().default(""),
          description: tool.schema.string().describe("New description").optional().default(""),
          result: tool.schema.string().describe("Result or notes").optional().default(""),
        },
        async execute(args) {
          try {
            const raw = await readFile(`${RUNTIME_DIR}/tasks.json`, "utf8")
            const all = JSON.parse(raw)
            const tasks = all[args.workflow_id] || []
            const task = tasks.find((t: any) => t.id === args.task_id)
            if (task) {
              if (args.status) task.status = args.status
              if (args.description) task.description = args.description
              if (args.result) task.result = args.result
              all[args.workflow_id] = tasks
              await writeFile(`${RUNTIME_DIR}/tasks.json`, JSON.stringify(all, null, 2))
              return { output: `Task ${args.task_id} updated. Status: ${task.status}` }
            }
            return { output: `Task ${args.task_id} not found` }
          } catch { return { output: "Task update failed." } }
        }
      }),

      // ═════════════════════════════════════════════════
      // TeamDeleteTool: Delete a team
      // ═════════════════════════════════════════════════
      team_delete: tool({
        description: "Deletes a team and removes all its agents. Use for cleanup when a team is no longer needed. Equivalent to Claude Code's TeamDeleteTool.",
        args: {
          team_name: tool.schema.string().describe("Name of the team to delete"),
        },
        async execute(args) {
          const TEAMS_FILE = `${RUNTIME_DIR}/teams.json`
          try {
            const raw = await readFile(TEAMS_FILE, "utf8")
            const teams = JSON.parse(raw)
            if (teams[args.team_name]) {
              delete teams[args.team_name]
              await writeFile(TEAMS_FILE, JSON.stringify(teams, null, 2))
              return { output: `Team "${args.team_name}" deleted.` }
            }
            return { output: `Team "${args.team_name}" not found.` }
          } catch {
            await writeFile(TEAMS_FILE, JSON.stringify({}, null, 2))
            return { output: `Team "${args.team_name}" not found (no teams exist).` }
          }
        }
      }),
    }
  }
}
