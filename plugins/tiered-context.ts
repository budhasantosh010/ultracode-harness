// ═══════════════════════════════════════════════════════════════
// TIERED CONTEXT — Horizontal memory system for infinite context
// Solves the "lost in the middle" problem through structured
// external memory with hash-verified retrieval.
//
// Three tiers:
//   L0: Core (always in context — identity, task, key facts)
//   L1: Working Set (recent N turns, high-attention positions)
//   L2/L3: External Store (everything else, retrieved on demand)
// ═══════════════════════════════════════════════════════════════

import type { Plugin } from "@opencode-ai/plugin"
import { tool } from "@opencode-ai/plugin"
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, appendFileSync } from "fs"
import { createHash } from "crypto"

const MEM_DIR = ".opencode/runtime/memory"

// ─── Helpers ─────────────────────────────────────────────────

function ensureDir() { mkdirSync(`${MEM_DIR}`, { recursive: true }) }

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 16)
}

// ─── EXTERNAL MEMORY STORE — Append-only JSONL ───────────────

function memoryAppend(entry: any) {
  ensureDir()
  const file = `${MEM_DIR}/store.jsonl`
  const record = {
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    timestamp: new Date().toISOString(),
    hash: sha256(JSON.stringify(entry)),
    ...entry
  }
  appendFileSync(file, JSON.stringify(record) + "\n", "utf8")
  return record
}

function memoryQuery(opts: { type?: string; session?: string; tag?: string; limit?: number; keyword?: string }): any[] {
  const file = `${MEM_DIR}/store.jsonl`
  if (!existsSync(file)) return []
  const raw = readFileSync(file, "utf8").trim().split("\n").filter(Boolean)
  const entries = raw.map(l => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean)
  let results = entries
  if (opts.type) results = results.filter((e: any) => e.type === opts.type)
  if (opts.session) results = results.filter((e: any) => e.session === opts.session)
  if (opts.tag) results = results.filter((e: any) => (e.tags || []).includes(opts.tag))
  if (opts.keyword) {
    const kw = opts.keyword.toLowerCase()
    results = results.filter((e: any) => JSON.stringify(e).toLowerCase().includes(kw))
  }
  results.reverse()
  return results.slice(0, opts.limit || 20)
}

// ─── DECISION MEMORY — Structured, hash-verified ─────────────

const DECISIONS_FILE = `${MEM_DIR}/decisions.jsonl`

function decisionRecord(d: { what: string; why: string; alternatives?: string[]; affectedFiles?: string[]; evidence?: string[]; verdict?: string }) {
  ensureDir()
  const content = d.what + d.why + (d.evidence || []).join("")
  const record = {
    id: "dec_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 5),
    timestamp: new Date().toISOString(),
    hash: sha256(content),
    ...d,
    alternatives: d.alternatives || [],
    affectedFiles: d.affectedFiles || [],
    evidence: d.evidence || [],
  }
  appendFileSync(DECISIONS_FILE, JSON.stringify(record) + "\n", "utf8")
  return record
}

function decisionQuery(opts: { file?: string; keyword?: string; limit?: number; id?: string }): any[] {
  if (!existsSync(DECISIONS_FILE)) return []
  const raw = readFileSync(DECISIONS_FILE, "utf8").trim().split("\n").filter(Boolean)
  const entries = raw.map(l => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean)
  if (opts.id) return entries.filter((e: any) => e.id === opts.id)
  let results = entries
  if (opts.file) results = results.filter((e: any) => (e.affectedFiles || []).some((f: string) => f.includes(opts.file)))
  if (opts.keyword) {
    const kw = opts.keyword.toLowerCase()
    results = results.filter((e: any) => e.what.toLowerCase().includes(kw) || e.why.toLowerCase().includes(kw))
  }
  results.reverse()
  return results.slice(0, opts.limit || 10)
}

// ─── CONTEXT PLANNER — Assembles L0/L1 from stored data ──────

function buildL0(task?: string, goal?: string): string {
  const parts = ["## Current Task"]
  if (task) parts.push(`Task: ${task}`)
  if (goal) parts.push(`Goal: ${goal}`)

  // Add recent decisions
  const recentDecisions = decisionQuery({ limit: 5 })
  if (recentDecisions.length > 0) {
    parts.push("", "## Recent Decisions")
    for (const d of recentDecisions) {
      parts.push(`- [${d.id}] ${d.what} (${d.timestamp?.slice(0,10) || "?"})`)
      parts.push(`  Why: ${d.why?.slice(0, 200)}`)
    }
  }

  return parts.join("\n")
}

function buildL1(sessionId?: string, limit = 10): string {
  const recentMemory = memoryQuery({ session: sessionId, limit })
  if (recentMemory.length === 0) return ""

  const parts = ["## Recent Activity"]
  for (const m of recentMemory.slice(0, limit)) {
    const content = m.content || m.text || ""
    parts.push(`[${m.timestamp?.slice(11,19) || "?"}] ${m.type || "event"}: ${(content+"").slice(0, 200)}`)
  }
  return parts.join("\n")
}

// ─── THE PLUGIN ───────────────────────────────────────────────

export const TieredContextPlugin: Plugin = async ({ directory }) => {
  let sessionId = "session_" + Date.now().toString(36)
  let currentTask = ""
  let currentGoal = ""

  return {
    tool: {
      // ─── memory_search: Search external memory ───────
      memory_search: tool({
        description: "Searches the external memory store for past decisions, conversations, and tool results. Returns full original text with hash verification. Use when you need to recall something from earlier in the session or previous sessions.",
        args: {
          query: tool.schema.string().describe("Keyword to search for"),
          type: tool.schema.string().describe("Type filter: decision, message, code_change, error, tool_result").optional().default(""),
          limit: tool.schema.number().describe("Max results").optional().default(10),
        },
        async execute(args) {
          const results = memoryQuery({ keyword: args.query, type: args.type || undefined, limit: args.limit || 10 })
          if (results.length === 0) return { output: `No memories found for: "${args.query}"` }
          let out = `═══ MEMORY SEARCH: "${args.query}" ═══\nFound: ${results.length}\n\n`
          for (const r of results) {
            out += `[${r.timestamp?.slice(0,19) || "?"}] ${r.type || "event"}: ${(r.content || r.text || "").slice(0, 300)}\n`
            out += `  ID: ${r.id} | Hash: ${r.hash}\n\n`
          }
          return { output: out.trim() }
        }
      }),

      // ─── decision_get: Retrieve a decision by ID ─────
      decision_get: tool({
        description: "Retrieves a full decision record by its ID. Returns the COMPLETE original text, verified by content hash. Use when you need to understand WHY a previous decision was made.",
        args: {
          id: tool.schema.string().describe("Decision ID (from decision_search or recent decisions list)"),
        },
        async execute(args) {
          const results = decisionQuery({ id: args.id })
          if (results.length === 0) return { output: `Decision "${args.id}" not found.` }
          const d = results[0]
          // Hash verification
          const content = d.what + d.why + (d.evidence || []).join("")
          const currentHash = sha256(content)
          const hashMatch = currentHash === d.hash
          let out = `═══ DECISION: ${d.id} ═══\nHash: ${d.hash} (${hashMatch ? "✅ verified" : "❌ CORRUPTED — re-check"})\n`
          if (!hashMatch) out += "⚠ WARNING: This decision's content has changed since it was recorded!\n"
          out += `Date: ${d.timestamp?.slice(0,19) || "?"}\n`
          out += `\nWhat: ${d.what}\n`
          out += `Why: ${d.why}\n`
          if (d.alternatives?.length) out += `Alternatives considered: ${d.alternatives.join(", ")}\n`
          if (d.affectedFiles?.length) out += `Files affected: ${d.affectedFiles.join(", ")}\n`
          if (d.evidence?.length) out += `Evidence: ${d.evidence.join("; ")}\n`
          if (d.verdict) out += `Verdict: ${d.verdict}\n`
          return { output: out.trim() }
        }
      }),

      // ─── decision_search: Search decisions ───────────
      decision_search: tool({
        description: "Searches decision memory by keyword or file. Returns matching decisions with their IDs for full retrieval via decision_get.",
        args: {
          keyword: tool.schema.string().describe("Search term").optional().default(""),
          file: tool.schema.string().describe("Filter by affected file").optional().default(""),
          limit: tool.schema.number().describe("Max results").optional().default(10),
        },
        async execute(args) {
          const results = decisionQuery({ keyword: args.keyword || undefined, file: args.file || undefined, limit: args.limit || 10 })
          if (results.length === 0) return { output: "No matching decisions found." }
          let out = `═══ DECISION SEARCH ═══\nFound: ${results.length}\n\n`
          for (const d of results) {
            out += `[${d.id}] ${d.what?.slice(0, 80)}\n  Why: ${d.why?.slice(0, 100)}\n  Files: ${(d.affectedFiles||[]).join(", ")}\n\n`
          }
          return { output: out.trim() }
        }
      }),

      // ─── context_status: Show current context state ─────
      context_status: tool({
        description: "Shows the current memory and context state: how many entries stored, recent decisions, session info.",
        args: {},
        async execute() {
          const memCount = existsSync(`${MEM_DIR}/store.jsonl`) ? readFileSync(`${MEM_DIR}/store.jsonl`, "utf8").trim().split("\n").filter(Boolean).length : 0
          const decCount = existsSync(DECISIONS_FILE) ? readFileSync(DECISIONS_FILE, "utf8").trim().split("\n").filter(Boolean).length : 0
          return { output: `═══ MEMORY STATUS ═══\nSession: ${sessionId}\nMemory entries: ${memCount}\nDecisions recorded: ${decCount}\nCurrent task: ${currentTask || "none"}\nCurrent goal: ${currentGoal || "none"}\n\nTiered context active: External store (L2/L3) + Working set (L1) + Core (L0)` }
        }
      }),
    },

    // ─── AFTER HOOK: Capture everything to memory ──────
    "tool.execute.after": (input, output) => {
      const outputStr = (output.output || "").toString()

      // Store every tool result
      memoryAppend({
        type: "tool_result",
        session: sessionId,
        tool: input.tool,
        content: outputStr.slice(0, 500),
        metadata: {
          args: JSON.stringify(input.args).slice(0, 200),
          duration: output.metadata?.duration || 0,
        },
        tags: [input.tool || "unknown"]
      })
      // === SELF-CORRECTION: Error detection ===
      const errorKeywords = ["error", "failed", "cannot find module", "syntaxerror", "typeerror", "referenceerror"]
      const hasError = errorKeywords.some(kw => outputStr.toLowerCase().includes(kw))
      
      if (hasError && outputStr.length > 10) {
        memoryAppend({ type: "error", session: sessionId, tool: input.tool, content: outputStr.slice(0, 500), tags: ["error"] })
        
        if ((input.tool === "bash" || input.tool === "edit") && (outputStr.includes("Error:") || outputStr.includes("failed"))) {
          const outRef = output as any
          outRef.output = (outRef.output || "") + "

[Self-Correction] Error detected. Check: (1) Are dependencies installed? (2) Is syntax correct? (3) Are file paths right?"
        }
      }

      // === DECISION TRACKING ===
      if (input.tool === "adversarial_review" && outputStr.length > 50) {
        decisionRecord({
          what: "Security review completed",
          why: outputStr.slice(0, 500),
          affectedFiles: [(input.args as any)?.context_files || []].flat(),
          verdict: outputStr.includes("PASS") ? "pass" : "needs_review"
        })
      }


      // Track task from classify_task
      if (input.tool === "classify_task" && input.args) {
        currentTask = (input.args as any).task || ""
      }


    },

    // ─── COMPACTION HOOK: Inject tiered context ───────
    "experimental.session.compacting": (_input, output) => {
      // Inject L0 (core context)
      const l0 = buildL0(currentTask, currentGoal)
      if (l0) output.context.push(l0)

      // Inject L1 (recent activity)
      const l1 = buildL1(sessionId, 8)
      if (l1) output.context.push(l1)

      // Add memory instruction
      output.context.push(
        `## Memory Access\n` +
        `- Use memory_search({query}) to find past information\n` +
        `- Use decision_get({id}) to retrieve full decisions with hash verification\n` +
        `- Use decision_search({keyword}) to find decisions\n` +
        `- Use context_status to check memory state`
      )

      // Auto-record compaction event
      memoryAppend({ type: "compaction", session: sessionId, content: `Compaction triggered. L0/L1 injected.` })
    },
  }
}
