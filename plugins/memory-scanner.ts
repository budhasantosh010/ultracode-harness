// ═══════════════════════════════════════════════════════════════
// MEMORY SCANNER — File-based memory system for OpenCode
// Pattern from VILA-Lab: LLM scans memory-file headers,
// selects up to 5 relevant files, injects into context.
// No vector DB, no embeddings — fully inspectable.
// ═══════════════════════════════════════════════════════════════

import type { Plugin } from "@opencode-ai/plugin"
import { tool } from "@opencode-ai/plugin"
import { readFileSync, readdirSync, existsSync, mkdirSync, writeFileSync } from "fs"
import { join } from "path"

const MEM_DIRS = [
  "C:/Users/Lenovo/.claude/memories",
  "C:/Users/Lenovo/.config/opencode/memories",
]

function ensureMemDir() {
  for (const d of MEM_DIRS) { try { mkdirSync(d, { recursive: true }) } catch {} }
}

function listMemFiles(): string[] {
  const files: string[] = []
  for (const dir of MEM_DIRS) {
    if (!existsSync(dir)) continue
    try {
      const entries = readdirSync(dir, { withFileTypes: true })
      for (const e of entries) {
        if (e.isFile() && e.name.endsWith(".md")) {
          files.push(join(dir, e.name))
        }
      }
    } catch {}
  }
  return files
}

function extractHeader(filePath: string): { name: string; description: string; tags: string } {
  try {
    const content = readFileSync(filePath, "utf8")
    const nameMatch = content.match(/^#\s+(.+)/m)
    const descMatch = content.match(/\*\*Description:\*\*\s*(.+)/i) || content.match(/description:\s*(.+)/i)
    const tagsMatch = content.match(/\*\*Tags:\*\*\s*(.+)/i) || content.match(/tags:\s*(.+)/i)
    return {
      name: nameMatch?.[1]?.trim() || filePath.split(/[/\\]/).pop()?.replace(/\.md$/, "") || "unnamed",
      description: descMatch?.[1]?.trim() || "",
      tags: tagsMatch?.[1]?.trim() || "",
    }
  } catch {
    return { name: "unnamed", description: "", tags: "" }
  }
}

function readFullMemory(filePath: string): string {
  try { return readFileSync(filePath, "utf8") } catch { return "" }
}

// Simple scoring: keyword overlap + tag matches
function scoreRelevance(header: { name: string; description: string; tags: string }, query: string): number {
  const q = query.toLowerCase()
  let score = 0
  const words = q.split(/\s+/).filter(w => w.length > 2)
  for (const word of words) {
    if (header.name.toLowerCase().includes(word)) score += 3
    if (header.description.toLowerCase().includes(word)) score += 2
    if (header.tags.toLowerCase().includes(word)) score += 4
  }
  return score
}

export const MemoryScannerPlugin: Plugin = async () => {
  ensureMemDir()

  return {
    tool: {
      // ─── memory_scan: Find relevant memories by keyword ──
      memory_scan: tool({
        description:
          "Scans memory files and returns the most relevant ones for the current task. " +
          "Reads file headers (not full content), scores by relevance, returns top 5. " +
          "No vector DB — fully inspectable, editable, version-controllable. " +
          "Pattern from Claude Code's architecture (VILA-Lab analysis).",
        args: {
          query: tool.schema.string().describe("Search query — what you're working on"),
          max_results: tool.schema.number().describe("Max memories to return").optional().default(5),
        },
        async execute(args) {
          const files = listMemFiles()
          if (files.length === 0) {
            return { output: "No memory files found. Create .md files in:\n" + MEM_DIRS.join("\n") }
          }

          const headers = files.map(f => ({ path: f, header: extractHeader(f) }))
          const scored = headers.map(h => ({ ...h, score: scoreRelevance(h.header, args.query || "") }))
          const top = scored.sort((a, b) => b.score - a.score).slice(0, args.max_results || 5)

          if (top.length === 0 || top[0].score === 0) {
            return { output: "No relevant memories found for: " + args.query + "\n\nAvailable memories:\n" + headers.map(h => "  - " + h.header.name + ": " + h.header.description).join("\n") }
          }

          let output = "═══ RELEVANT MEMORIES ═══\nQuery: " + args.query + "\n\n"
          for (const item of top) {
            const full = readFullMemory(item.path)
            output += "--- " + item.header.name + " (score: " + item.score + ") ---\n"
            output += full.slice(0, 800) + (full.length > 800 ? "\n..." : "") + "\n\n"
          }
          return { output: output.trim() }
        }
      }),

      // ─── memory_save: Save a memory file ─────────────────
      memory_save: tool({
        description: "Saves a memory entry as a markdown file. Memories are inspectable, versionable .md files — no vector DB.",
        args: {
          name: tool.schema.string().describe("Memory name (used as filename)"),
          description: tool.schema.string().describe("One-line description of what this memory contains"),
          tags: tool.schema.string().describe("Comma-separated keywords for retrieval"),
          content: tool.schema.string().describe("The memory content (markdown)"),
          scope: tool.schema.enum(["user", "project"]).describe("Where to save").optional().default("user"),
        },
        async execute(args) {
          const safeName = args.name.replace(/[^a-z0-9_-]/gi, "_").toLowerCase()
          const dir = args.scope === "project" ? ".claude/memories" : MEM_DIRS[0]
          try { mkdirSync(dir, { recursive: true }) } catch {}
          const filePath = join(dir, safeName + ".md")
          const content = "# " + args.name + "\n\n**Description:** " + (args.description || "") + "\n**Tags:** " + (args.tags || "") + "\n\n" + (args.content || "")
          try { writeFileSync(filePath, content, "utf8"); return { output: "Memory saved: " + filePath } } catch (e: any) { return { output: "Failed to save: " + (e.message || "unknown") } }
        }
      }),

      // ─── memory_list: List all memories ──────────────────
      memory_list: tool({
        description: "Lists all memory entries with their names, descriptions, and tags.",
        args: {},
        async execute() {
          const files = listMemFiles()
          if (files.length === 0) return { output: "No memories found.\nSave one with memory_save." }
          const headers = files.map(f => extractHeader(f))
          return { output: "Memories (" + headers.length + "):\n" + headers.map(h => "  - " + h.name + ": " + h.description + (h.tags ? " [" + h.tags + "]" : "")).join("\n") }
        }
      }),
    },

    // ─── Compaction hook: auto-inject memories ──────────
    "experimental.session.compacting": async (_input, output) => {
      try {
        const files = listMemFiles()
        if (files.length === 0) return

        // Read all headers
        const headers = files.map(f => ({ path: f, header: extractHeader(f) }))
        const contextText = output.context.join(" ")
        // Score against conversation context
        const scored = headers.map(h => ({ ...h, score: scoreRelevance(h.header, contextText.slice(0, 2000)) }))
        const top = scored.sort((a, b) => b.score - a.score).slice(0, 3)

        if (top.length > 0 && top[0].score > 0) {
          const memBlock = top.filter(t => t.score > 0).map(t => {
            const full = readFullMemory(t.path)
            return "## Memory: " + t.header.name + "\n" + full.slice(0, 600)
          }).join("\n\n")
          if (memBlock) {
            output.context.push("\n\n--- Relevant Memories ---\n" + memBlock + "\n---")
          }
        }
      } catch {}
    },
  }
}
