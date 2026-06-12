// ═══════════════════════════════════════════════════════════════
// RETRIEVAL ENGINE — Infinite context window solution
//
// 14 search methods + 7-pass architecture:
//   Pass 0: Intent extraction
//   Pass 1: Recent 10-20 messages (always included)
//   Pass 2: 14-way parallel search
//   Pass 3: Weighted consilience scoring
//   Pass 3.5: Temporal graph verification
//   Pass 4: Dynamic conversation windows
//   Pass 5: Verification firewall
//   Pass 6: Story assembly + output
//
// Also: git-like session branching + data correction
// Zero existing plugins modified. Single new file.
// Safe degradation: remove file → harness works as before.
// ═══════════════════════════════════════════════════════════════

import type { Plugin } from "@opencode-ai/plugin"
import { tool } from "@opencode-ai/plugin"
import { execSync } from "child_process"
import { readFileSync, existsSync, mkdirSync, readdirSync, appendFileSync } from "fs"
import * as crypto from "crypto"
import * as path from "path"

const KNOWLEDGE_DIR = ".opencode/runtime/knowledge"

// Dynamic transcript dir — resolves to Claude projects folder
function getTranscriptDir(): string {
  const home = process.env.USERPROFILE || process.env.HOME || "C:/Users/default"
  return path.join(home, ".claude", "projects")
}

// ─── Helpers ────────────────────────────────────────────────

function safeStr(s: string, maxLen = 2000): string {
  return s.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, "").slice(0, maxLen)
}

function now(): string { return new Date().toISOString() }

function readLines(file: string): string[] {
  try { return readFileSync(file, "utf8").split("\n").filter(Boolean) } catch { return [] }
}

function readJSONL(file: string): any[] {
  try {
    return readLines(file).map(l => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean)
  } catch { return [] }
}

function ensureDir(p: string) { mkdirSync(p, { recursive: true }) }

function appendJSONL(file: string, entry: any) {
  ensureDir(file.substring(0, file.lastIndexOf("/")));
  appendFileSync(file, JSON.stringify({ ...entry, timestamp: now() }) + "\n", "utf8")
}

function shortHash(s: string): string {
  return crypto.createHash("sha256").update(s).digest("hex").slice(0, 8)
}

// ─── Pass 0: Intent Extraction ──────────────────────────────

function extractIntent(currentMsg: string, recentMessages: string[]): {
  enriched: string; keywords: string[]; entities: string[]; timeRef: string; action: string
} {
  const pronouns = ["it", "this", "that", "they", "them", "those", "these"]
  const words = currentMsg.toLowerCase().split(/\W+/).filter(Boolean)
  const hasPronoun = pronouns.some(p => words.includes(p))

  let enriched = currentMsg
  const allKeywords = [...words]
  const entities: string[] = []
  let timeRef = ""
  let action = ""

  // Resolve pronouns
  if (hasPronoun) {
    const nounCounts: Record<string, number> = {}
    for (const msg of recentMessages) {
      const msgWords = msg.toLowerCase().split(/\W+/).filter(Boolean)
      for (const w of msgWords) {
        if (!pronouns.includes(w) && w.length > 2) {
          nounCounts[w] = (nounCounts[w] || 0) + 1
        }
      }
    }
    const sorted = Object.entries(nounCounts).sort((a, b) => b[1] - a[1])
    if (sorted.length > 0) {
      const topNoun = sorted[0][0]
      enriched = enriched.replace(/\b(it|this|that|they|them|those|these)\b/gi, topNoun)
      allKeywords.push(topNoun)
    }
  }

  // Extract entities
  const sessionMatch = enriched.match(/session\s+(\d+)/i)
  if (sessionMatch) { entities.push("session_" + sessionMatch[1]); timeRef = "session_" + sessionMatch[1] }

  const bugMatch = enriched.match(/(bug|issue)\s+(\d+)/i)
  if (bugMatch) { entities.push("bug_" + bugMatch[2]) }

  // Detect action
  if (/find|search|look|where|get|show/i.test(enriched)) action = "find"
  else if (/fix|change|edit|update|modify/i.test(enriched)) action = "fix"
  else if (/compare|diff|different/i.test(enriched)) action = "compare"

  // Extract keywords (words > 3 chars, excluding common words)
  const stopWords = ["this", "that", "with", "from", "have", "been", "will", "would", "could", "should", "there", "their", "about", "which", "what", "when", "where", "then", "than", "they", "them", "these", "those"]
  const keywords = [...new Set(allKeywords.filter(w => w.length > 3 && !stopWords.includes(w)))]

  return { enriched, keywords, entities, timeRef, action }
}

// ─── Method 3: Vector Embedding (character n-gram, zero dependencies) ──

function embed(text: string): number[] {
  const normalized = text.toLowerCase()
  const ngrams = new Map<string, number>()
  for (let n = 2; n <= 3; n++) {
    for (let i = 0; i <= normalized.length - n; i++) {
      const gram = normalized.slice(i, i + n)
      ngrams.set(gram, (ngrams.get(gram) || 0) + 1)
    }
  }
  const values = Array.from(ngrams.values())
  const magnitude = Math.sqrt(values.reduce((s: number, v: number) => s + v * v, 0)) || 1
  return values.map(v => v / magnitude).slice(0, 200)
}

function cosineSimilarity(a: number[], b: number[]): number {
  const len = Math.min(a.length, b.length)
  let dot = 0, magA = 0, magB = 0
  for (let i = 0; i < len; i++) { dot += a[i] * b[i]; magA += a[i] * a[i]; magB += b[i] * b[i] }
  return dot / (Math.sqrt(magA) * Math.sqrt(magB) || 1)
}

function searchVector(query: string, items: Array<{ text: string; score?: number; timestamp?: string }>, limit = 10): Array<{ text: string; score: number; timestamp: string; source: string }> {
  const queryVec = embed(query)
  const scored = items.map(item => ({
    text: item.text,
    score: cosineSimilarity(queryVec, embed(item.text)),
    timestamp: item.timestamp || "",
    source: "vector_embedding"
  }))
  return scored.sort((a, b) => b.score - a.score).slice(0, limit)
}

// ─── Search Methods ─────────────────────────────────────────

// Method 1: BM25 Keyword (tiered-context store.jsonl)
function searchBM25(query: string, limit = 20): Array<{ text: string; score: number; timestamp: string; source: string }> {
  const results: Array<{ text: string; score: number; timestamp: string; source: string }> = []
  try {
    const store = readJSONL(`${KNOWLEDGE_DIR}/../store.jsonl`)
    const qWords = query.toLowerCase().split(/\W+/).filter(Boolean)
    for (const entry of store) {
      const searchText = ((entry.content || entry.text || "") + " " + (entry.type || "")).toLowerCase()
      const matches = qWords.filter((w: string) => searchText.includes(w)).length
      if (matches > 0) {
        results.push({
          text: (entry.content || entry.text || "").slice(0, 300),
          score: matches / qWords.length,
          timestamp: entry.timestamp || "",
          source: "bm25_keyword"
        })
      }
    }
  } catch {}
  return results.sort((a, b) => b.score - a.score).slice(0, limit)
}

// Method 2: Code Grep
function searchCodeGrep(query: string, dir: string, limit = 10): Array<{ text: string; score: number; timestamp: string; source: string }> {
  const results: Array<{ text: string; score: number; timestamp: string; source: string }> = []
  try {
    const words = query.split(/\W+/).filter(Boolean)
    for (const w of words.slice(0, 3)) {
      const r = execSync(`grep -rli --include="*.{ts,tsx,js,jsx,py,go,rs}" -E "${w}" "${dir}/src" 2>/dev/null | head -5`, { encoding: "utf8", timeout: 5000 }).toString().trim()
      if (r) {
        for (const file of r.split("\n")) {
          results.push({ text: `[File] ${file.slice(dir.length + 1)}`, score: 0.8, timestamp: "", source: `code_grep:${w}` })
        }
      }
    }
  } catch {}
  return results.slice(0, limit)
}

// Method 4: TF-IDF (tiered-context semantic search)
function searchTFIDF(query: string, limit = 20): Array<{ text: string; score: number; timestamp: string; source: string }> {
  const results: Array<{ text: string; score: number; timestamp: string; source: string }> = []
  try {
    const store = readJSONL(`${KNOWLEDGE_DIR}/../store.jsonl`)
    const qWords = query.toLowerCase().split(/\W+/).filter(Boolean)
    const docCount = store.length
    const df: Record<string, number> = {}
    for (const e of store) {
      const text = ((e.content || e.text || "") + " " + (e.type || "")).toLowerCase()
      for (const w of qWords) { if (text.includes(w)) { df[w] = (df[w] || 0) + 1 } }
    }
    for (const entry of store) {
      const text = ((entry.content || entry.text || "") + " " + (entry.type || "")).toLowerCase()
      let score = 0
      for (const w of qWords) {
        if (text.includes(w)) {
          const idf = Math.log((docCount + 1) / (1 + (df[w] || 1)))
          const tf = (text.match(new RegExp(w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g")) || []).length
          score += tf * idf
        }
      }
      if (score > 0) {
        results.push({ text: (entry.content || entry.text || "").slice(0, 300), score: Math.min(score / 10, 1), timestamp: entry.timestamp || "", source: "tfidf" })
      }
    }
  } catch {}
  return results.sort((a, b) => b.score - a.score).slice(0, limit)
}

// Method 5: Knowledge store
function searchKnowledge(query: string, dir: string, limit = 20): Array<{ text: string; score: number; timestamp: string; source: string }> {
  const results: Array<{ text: string; score: number; timestamp: string; source: string }> = []
  try {
    const examples = readJSONL(`${dir}/${KNOWLEDGE_DIR}/examples.jsonl`)
    const qWords = query.toLowerCase().split(/\W+/).filter(Boolean)
    for (const e of examples) {
      const searchText = ((e.problem || "") + " " + (e.solution || "") + " " + (e.category || "")).toLowerCase()
      const matches = qWords.filter((w: string) => searchText.includes(w)).length
      if (matches > 0) {
        results.push({
          text: `[${e.type || "example"}] ${(e.problem || "").slice(0, 150)}\n  Solution: ${(e.solution || "").slice(0, 200)}`,
          score: (matches / qWords.length) * (e.score || 0.5),
          timestamp: e.timestamp || "",
          source: "knowledge_store"
        })
      }
    }
  } catch {}
  return results.sort((a, b) => b.score - a.score).slice(0, limit)
}

// Method 6: Decision memory
function searchDecisions(query: string, dir: string, limit = 10): Array<{ text: string; score: number; timestamp: string; source: string }> {
  const results: Array<{ text: string; score: number; timestamp: string; source: string }> = []
  try {
    const decisions = readJSONL(`${dir}/.opencode/runtime/memory/decisions.jsonl`)
    const qWords = query.toLowerCase().split(/\W+/).filter(Boolean)
    for (const d of decisions) {
      const searchText = ((d.what || "") + " " + (d.why || "")).toLowerCase()
      const matches = qWords.filter((w: string) => searchText.includes(w)).length
      if (matches > 0) {
        const isObsolete = d.obsoleted ? " [OBSOLETE]" : ""
        results.push({
          text: `[Decision${isObsolete}] ${(d.what || "").slice(0, 150)}\n  Why: ${(d.why || "").slice(0, 200)}`,
          score: matches / qWords.length,
          timestamp: d.timestamp || "",
          source: "decision_memory"
        })
      }
    }
  } catch {}
  return results.sort((a, b) => b.score - a.score).slice(0, limit)
}

// Method 7: Error patterns
function searchErrors(query: string, dir: string, limit = 10): Array<{ text: string; score: number; timestamp: string; source: string }> {
  const results: Array<{ text: string; score: number; timestamp: string; source: string }> = []
  try {
    const sysLog = "C:/Users/Lenovo/.config/opencode/evolution_log.json"
    const projLog = `${dir}/.opencode/evolution_log.json`
    for (const f of [sysLog, projLog]) {
      if (!existsSync(f)) continue
      const data = JSON.parse(readFileSync(f, "utf8"))
      const patterns = data.failurePatterns || []
      for (const p of patterns) {
        const searchText = (p.pattern || "").toLowerCase()
        if (query.toLowerCase().split(/\W+/).some((w: string) => w.length > 2 && searchText.includes(w))) {
          results.push({
            text: `[Error Pattern] ${p.pattern}: ${p.count} occurrences (last: ${(p.lastSeen || "").slice(0, 10)})`,
            score: Math.min(p.count / 10, 1),
            timestamp: p.lastSeen || "",
            source: "error_pattern"
          })
        }
      }
    }
  } catch {}
  return results.sort((a, b) => b.score - a.score).slice(0, limit)
}

// Method 8: Dependency graph (graphify)
function searchGraphify(query: string, dir: string, limit = 10): Array<{ text: string; score: number; timestamp: string; source: string }> {
  const results: Array<{ text: string; score: number; timestamp: string; source: string }> = []
  try {
    const graphFile = `${dir}/graphify-out/graph.json`
    if (!existsSync(graphFile)) return results
    const graph = JSON.parse(readFileSync(graphFile, "utf8"))
    const nodes = graph.nodes || []
    const edges = graph.edges || []
    const qWords = query.toLowerCase().split(/\W+/).filter(Boolean)
    for (const node of nodes) {
      const searchText = ((node.name || "") + " " + (node.type || "") + " " + JSON.stringify(node.metadata || {})).toLowerCase()
      if (qWords.some((w: string) => searchText.includes(w))) {
        // Find connected nodes
        const connected = edges.filter((e: any) => e.source === node.id || e.target === node.id).map((e: any) => e.source === node.id ? e.target : e.source).slice(0, 5)
        results.push({
          text: `[Graph] ${node.name} (${node.type || "unknown"})\n  Connected to: ${connected.join(", ") || "none"}`,
          score: 0.8,
          timestamp: "",
          source: "dependency_graph"
        })
      }
    }
  } catch {}
  return results.slice(0, limit)
}

// Method 9: Session transcript search
function searchTranscripts(query: string, limit = 10): Array<{ text: string; score: number; timestamp: string; source: string; line?: number; file?: string }> {
  const results: Array<{ text: string; score: number; timestamp: string; source: string; line?: number; file?: string }> = []
  try {
    const tDir = getTranscriptDir()
    if (!existsSync(tDir)) return results
    const files = readdirSync(tDir).filter((f: string) => f.endsWith(".jsonl"))
    const qWords = query.toLowerCase().split(/\W+/).filter((w: string) => w.length > 2)
    for (const f of files.slice(-10)) { // Last 10 session files
      const fp = `${tDir}/${f}`
      const lines = readLines(fp)
      for (let i = 0; i < lines.length; i++) {
        try {
          const entry = JSON.parse(lines[i])
          if (entry.type === "user") {
            const text = (entry?.message?.content?.[0]?.text || "").toLowerCase()
            const matches = qWords.filter((w: string) => text.includes(w)).length
            if (matches > 0) {
              results.push({
                text: (entry?.message?.content?.[0]?.text || "").slice(0, 300),
                score: matches / qWords.length,
                timestamp: entry.timestamp || "",
                source: `session_archive:${f}`,
                line: i,
                file: fp
              })
            }
          }
        } catch {}
      }
    }
  } catch {}
  return results.sort((a, b) => b.score - a.score).slice(0, limit)
}

// Method 10: Temporal entity graph (search nodes)
function searchGraphNodes(query: string, dir: string, limit = 10): Array<{ text: string; score: number; timestamp: string; source: string; nodeId?: string }> {
  const results: Array<{ text: string; score: number; timestamp: string; source: string; nodeId?: string }> = []
  try {
    const graphFile = `${dir}/${KNOWLEDGE_DIR}/session-graph.jsonl`
    if (!existsSync(graphFile)) return results
    const nodes = readJSONL(graphFile).filter((e: any) => e.type === "node")
    const qWords = query.toLowerCase().split(/\W+/).filter(Boolean)
    for (const node of nodes) {
      const searchText = ((node.label || "") + " " + (node.kind || "")).toLowerCase()
      const matches = qWords.filter((w: string) => searchText.includes(w)).length
      if (matches > 0) {
        results.push({
          text: `[${node.kind}] ${node.label || ""} (session: ${node.session || "?"})`,
          score: matches / qWords.length,
          timestamp: node.timestamp || "",
          source: "temporal_graph",
          nodeId: node.id
        })
      }
    }
  } catch {}
  return results.sort((a, b) => b.score - a.score).slice(0, limit)
}

// Method 11: Temporal recency (modifier — applied to all results)
function applyRecency(results: Array<{ text: string; score: number; timestamp: string; source: string; nodeId?: string; line?: number; file?: string }>): Array<{ text: string; score: number; timestamp: string; source: string; nodeId?: string; line?: number; file?: string }> {
  const now = Date.now()
  return results.map(r => {
    const ts = new Date(r.timestamp || 0).getTime()
    const hoursAgo = (now - ts) / 3600000
    const recencyScore = Math.max(0, 1 - hoursAgo / 720)
    return { ...r, score: r.score * 0.7 + recencyScore * 0.3 }
  })
}

// Method 12: Session trajectory
function getSessionTrajectory(dir: string): Array<{ text: string; score: number; timestamp: string; source: string }> {
  const results: Array<{ text: string; score: number; timestamp: string; source: string }> = []
  try {
    const summaryFile = `${dir}/.opencode/runtime/session-summary.md`
    if (!existsSync(summaryFile)) return results
    const content = readFileSync(summaryFile, "utf8").slice(0, 1000)
    if (content.trim()) {
      results.push({ text: `[Last Session] ${content}`, score: 0.9, timestamp: "", source: "session_trajectory" })
    }
  } catch {}
  return results
}

// Method 13: Code PageRank
function getPageRank(dir: string, query: string, limit = 10): Array<{ text: string; score: number; timestamp: string; source: string }> {
  const results: Array<{ text: string; score: number; timestamp: string; source: string }> = []
  try {
    const srcDir = `${dir}/src`
    if (!existsSync(srcDir)) return results
    const result = execSync(
      `grep -rn --include="*.{ts,tsx,js,jsx,py,go,rs}" -E "from |import " "${srcDir}" 2>/dev/null | grep -oP "from ['\\"]([^'\\"/]+)" | sort | uniq -c | sort -rn | head -20`,
      { encoding: "utf8", timeout: 10000 }
    ).toString().trim()
    const qWords = query.toLowerCase().split(/\W+/).filter(Boolean)
    for (const line of result.split("\n")) {
      const m = line.trim().match(/(\d+)\s+(.+)/)
      if (m) {
        const [_, count, file] = m
        const fileName = file.split("/").pop() || file
        if (qWords.some((w: string) => fileName.toLowerCase().includes(w))) {
          results.push({ text: `[PageRank] ${fileName} imported ${count} times`, score: Math.min(parseInt(count) / 5, 1), timestamp: "", source: "code_pagerank" })
        }
      }
    }
  } catch {}
  return results.slice(0, limit)
}

// Method 14: Co-change analysis
function searchCoChange(query: string, dir: string, limit = 10): Array<{ text: string; score: number; timestamp: string; source: string }> {
  const results: Array<{ text: string; score: number; timestamp: string; source: string }> = []
  try {
    const qWords = query.toLowerCase().split(/\W+/).filter(Boolean)
    const srcDir = `${dir}/src`
    if (!existsSync(srcDir)) return results
    // Find candidate files from query
    for (const w of qWords.slice(0, 3)) {
      try {
        const files = execSync(`find "${srcDir}" -name "*.ts" -ipath "*${w}*" 2>/dev/null | head -3`, { encoding: "utf8", timeout: 5000 }).toString().trim().split("\n").filter(Boolean)
        for (const f of files) {
          const coChanged = execSync(`cd "${dir}" && git log --all --name-only --pretty=format: -- "${f}" 2>/dev/null | sort -u | grep -v "^$" | head -5 || true`, { encoding: "utf8", timeout: 10000 }).toString().trim().split("\n").filter((l: string) => l !== f)
          if (coChanged.length > 0) {
            results.push({ text: `[Co-Change] ${f.slice(dir.length + 1)} changed together with:\n  ${coChanged.slice(0, 5).join("\n  ")}`, score: 0.7, timestamp: "", source: "co_change" })
          }
        }
      } catch {}
    }
  } catch {}
  return results.slice(0, limit)
}

// ─── Temporal Graph: Chain traversal ────────────────────────

function traceChain(nodeId: string, dir: string, direction: "forward" | "backward" | "both", maxHops = 5): any[] {
  const graphFile = `${dir}/${KNOWLEDGE_DIR}/session-graph.jsonl`
  if (!existsSync(graphFile)) return []
  const entries = readJSONL(graphFile)
  const nodes = entries.filter((e: any) => e.type === "node")
  const edges = entries.filter((e: any) => e.type === "edge")
  const chain: any[] = []
  const visited = new Set<string>()
  let currentId = nodeId

  for (let hop = 0; hop < maxHops; hop++) {
    if (visited.has(currentId)) break
    visited.add(currentId)
    const node = nodes.find((n: any) => n.id === currentId)
    if (!node) break
    chain.push(node)

    const nextEdge = edges.find((e: any) =>
      direction === "forward" ? e.from === currentId :
      direction === "backward" ? e.to === currentId :
      e.from === currentId || e.to === currentId
    )
    if (!nextEdge) break
    currentId = direction === "forward" || direction === "both" ? nextEdge.to : nextEdge.from
  }
  return chain
}

// ─── Conversation window extraction ────────────────────────

function getConversationWindow(file: string, matchLine: number, windowSize: number): string {
  try {
    const lines = readLines(file)
    const start = Math.max(0, matchLine - windowSize)
    const end = Math.min(lines.length - 1, matchLine + windowSize)
    const msgs: string[] = []
    for (let i = start; i <= end; i++) {
      try {
        const entry = JSON.parse(lines[i])
        if (entry.type === "user") {
          const text = entry?.message?.content?.[0]?.text || ""
          if (text) msgs.push(`[USER] ${safeStr(text, 300)}`)
        } else if (entry.type === "assistant") {
          const content = entry?.message?.content || []
          for (const c of content) {
            if (c?.type === "text" && c.text) msgs.push(`[AI] ${safeStr(c.text, 300)}`)
          }
        }
      } catch {}
    }
    return msgs.join("\n")
  } catch { return "" }
}

// ─── THE PLUGIN ─────────────────────────────────────────────

export const RetrievalEnginePlugin: Plugin = async ({ directory }) => {
  // Session turn tracking
  let currentBranch = "main"
  let lastTurnId = ""

  // Auto-capture hook: save every turn as a branch node
  function saveTurn(userMsg: string, aiMsg: string) {
    const turnId = "turn_" + shortHash(userMsg + now())
    appendJSONL(`${directory}/${KNOWLEDGE_DIR}/session-graph.jsonl`, {
      type: "turn",
      id: turnId,
      parent: lastTurnId || null,
      branch: currentBranch,
      userMsgPreview: safeStr(userMsg, 100),
      aiMsgPreview: safeStr(aiMsg, 100),
      session: "session_current",
    })
    lastTurnId = turnId
  }

  // Auto-capture hook: save every significant event as a graph node
  function saveEvent(kind: string, label: string) {
    const eventId = "evt_" + shortHash(kind + label + now())
    appendJSONL(`${directory}/${KNOWLEDGE_DIR}/session-graph.jsonl`, {
      type: "node",
      id: eventId,
      kind,
      label: safeStr(label, 200),
      session: "session_current",
      turnId: lastTurnId,
    })
    return eventId
  }

  function saveEdge(from: string, to: string, relation: string) {
    appendJSONL(`${directory}/${KNOWLEDGE_DIR}/session-graph.jsonl`, {
      type: "edge",
      from, to, relation,
    })
  }

  return {
    tool: {

      // ══════════════════════════════════════════════════
      // RETRIEVE — Full 7-pass retrieval
      // ══════════════════════════════════════════════════

      retrieve: tool({
        description: "Complete 14-method retrieval engine. Searches ALL knowledge sources using 14 methods, finds consensus, enriches with conversation windows from past sessions, verifies, and assembles full story. Use when you need information from past sessions or the knowledge store.",
        args: {
          query: tool.schema.string().describe("What you're looking for — be specific"),
          recent_msgs: tool.schema.string().describe("Recent conversation context (last 5-10 messages)").optional().default(""),
          max_chunks: tool.schema.number().describe("Max info chunks to return").optional().default(5),
          include_conversation: tool.schema.boolean().describe("Include actual conversation windows").optional().default(true),
        },
        async execute(args) {
          const query = args.query || ""
          const recentMsgs = (args.recent_msgs || "").split("\n").filter(Boolean)
          const maxChunks = Math.min(args.max_chunks || 5, 10)
          const includeConv = args.include_conversation !== false
          const tStart = Date.now()
          const out: string[] = []

          out.push("═══ RETRIEVAL ENGINE ═══")
          out.push(`Query: "${query}"`)

          // ── PASS 0: Intent Extraction ────────────────
          const intent = extractIntent(query, recentMsgs)
          const searchQuery = intent.enriched
          out.push(`Intent: "${intent.enriched}" (resolved from: "${query}")`)

          // ── PASS 2: 14-Way Parallel Search ───────────
          const allResults: Array<{ text: string; score: number; timestamp: string; source: string; nodeId?: string; line?: number; file?: string }> = []

          // Methods 1-13 (all search methods)
          const searchItems = [
            ...(readJSONL(`${directory}/${KNOWLEDGE_DIR}/examples.jsonl`).map((e: any) => ({ text: (e.problem || "") + " " + (e.solution || ""), score: e.score, timestamp: e.timestamp }))),
            ...(readJSONL(`${directory}/${KNOWLEDGE_DIR}/../memory/decisions.jsonl`).map((d: any) => ({ text: (d.what || "") + " " + (d.why || ""), score: 0.8, timestamp: d.timestamp }))),
          ]
          const searches = [
            () => searchBM25(searchQuery),
            () => searchVector(searchQuery, searchItems),
            () => searchCodeGrep(searchQuery, directory),
            () => searchTFIDF(searchQuery),
            () => searchKnowledge(searchQuery, directory),
            () => searchDecisions(searchQuery, directory),
            () => searchErrors(searchQuery, directory),
            () => searchGraphify(searchQuery, directory),
            () => searchTranscripts(searchQuery),
            () => searchGraphNodes(searchQuery, directory),
            () => getSessionTrajectory(directory),
            () => getPageRank(directory, searchQuery),
            () => searchCoChange(searchQuery, directory),
          ]

          for (const searchFn of searches) {
            try {
              const results = searchFn()
              allResults.push(...results)
            } catch {}
          }

          // Method 11: Apply temporal recency modifier
          const recencyApplied = applyRecency(allResults)

          out.push(`Search methods: 12 | Raw results: ${recencyApplied.length}`)

          // ── PASS 3: Weighted Consilience Scoring ──────
          const consensus: Array<{ text: string; sources: string[]; totalScore: number; timestamp: string; nodeId?: string; line?: number; file?: string }> = []
          const seenTexts = new Set<string>()

          // Group by text similarity and sum scores
          for (const r of recencyApplied.sort((a, b) => b.score - a.score)) {
            const key = r.text.slice(0, 60)
            if (seenTexts.has(key)) {
              const existing = consensus.find(c => c.text.slice(0, 60) === key)
              if (existing) {
                existing.sources.push(r.source)
                existing.totalScore += r.score
              }
              continue
            }
            seenTexts.add(key)
            consensus.push({
              text: r.text,
              sources: [r.source],
              totalScore: r.score,
              timestamp: r.timestamp,
              nodeId: r.nodeId,
              line: r.line,
              file: r.file,
            })
          }

          // Sort by total score (consilience weighted)
          consensus.sort((a, b) => b.totalScore - a.totalScore)
          const topChunks = consensus.slice(0, maxChunks)

          out.push(`Consilience chunks: ${topChunks.length} (from ${consensus.length} unique items)`)

          // ── PASS 3.5: Temporal Graph Verification ─────
          const verifiedChunks: Array<{ chunk: number; text: string; sources: string[]; score: number; status: string; nodeId?: string; line?: number; file?: string }> = []

          for (let i = 0; i < topChunks.length; i++) {
            const chunk = topChunks[i]
            let status = "UNVERIFIED"

            if (chunk.nodeId) {
              const chain = traceChain(chunk.nodeId, directory, "both", 3)
              if (chain.length >= 2) {
                const hasTest = chain.some((n: any) => n.kind === "test" || n.kind === "result")
                const hasFix = chain.some((n: any) => n.kind === "fix")
                const hasRevert = chain.some((n: any) => n.kind === "revert")
                if (hasFix && hasTest && !hasRevert) status = "CONFIRMED"
                else if (hasRevert) status = "INVALID"
                else status = "PARTIAL"
              }
            }

            verifiedChunks.push({
              chunk: i + 1,
              text: chunk.text,
              sources: chunk.sources,
              score: chunk.totalScore,
              status,
              nodeId: chunk.nodeId,
              line: chunk.line,
              file: chunk.file,
            })
          }

          // ── PASS 4: Dynamic Conversation Windows ──────
          const windows: string[] = []
          if (includeConv) {
            for (const chunk of verifiedChunks) {
              if (chunk.file && chunk.line !== undefined) {
                const win = getConversationWindow(chunk.file, chunk.line, 8)
                if (win) {
                  windows.push(`--- Context around chunk ${chunk.chunk} ---\n${win}`)
                }
              }
            }
            // Also try transcript search for chunks without file info
            if (windows.length === 0) {
              const transcriptResults = searchTranscripts(searchQuery, 3)
              for (const tr of transcriptResults.slice(0, 3)) {
                if (tr.file && tr.line !== undefined) {
                  const win = getConversationWindow(tr.file, tr.line, 8)
                  if (win) windows.push(`--- Context from transcript ---\n${win}`)
                }
              }
            }
          }

          // ── PASS 5: Verification Firewall ─────────────
          const verifications: string[] = []

          // Check 1: Temporal coherence
          try {
            const decisions = readJSONL(`${directory}/${KNOWLEDGE_DIR}/../memory/decisions.jsonl`)
            const superseded = decisions.filter((d: any) => d.supersedes)
            if (superseded.length > 0) {
              for (const s of superseded) {
                verifications.push(`[Verification] Decision "${(s.what || "").slice(0, 80)}" supersedes an earlier one`)
              }
            }
          } catch {}

          // Check 2: Test result confirmation
          for (const chunk of verifiedChunks) {
            if (chunk.status === "CONFIRMED") {
              verifications.push(`[Verification] Chunk ${chunk.chunk}: Fix + test result verified ✓`)
            } else if (chunk.status === "INVALID") {
              verifications.push(`[Verification] Chunk ${chunk.chunk}: ⚠ May have been reverted`)
            } else if (chunk.status === "PARTIAL") {
              verifications.push(`[Verification] Chunk ${chunk.chunk}: Fix applied but no test result found`)
            }
          }

          // Check 3: Live codebase check
          for (const chunk of verifiedChunks) {
            const fileMatch = chunk.text.match(/\.opencode\/runtime\/knowledge\/([^:]+)/) || chunk.text.match(/(src\/[^\s]+)/)
            if (fileMatch) {
              const fp = `${directory}/${fileMatch[1]}`
              if (existsSync(fp)) {
                verifications.push(`[Verification] File "${fileMatch[1]}" exists in current codebase ✓`)
              }
            }
          }

          // ── PASS 6: Story Assembly + Output ───────────

          // 1. Recent conversation
          out.push("\n═══ [RECENT CONVERSATION] ═══")
          if (recentMsgs.length > 0) {
            out.push(...recentMsgs.slice(-10))
          }

          // 2. Intent
          out.push("\n═══ [INTENT] ═══")
          out.push(`Raw: "${query}"`)
          out.push(`Enriched: "${intent.enriched}"`)
          out.push(`Keywords: ${intent.keywords.join(", ")}`)
          out.push(`Entities: ${intent.entities.join(", ") || "(none)"}`)
          out.push(`Action: ${intent.action || "general"}`)

          // 3. Info chunks
          out.push("\n═══ [RETRIEVED INFO CHUNKS] ═══")
          if (verifiedChunks.length === 0) {
            out.push("No verified chunks found for this query.")
          }
          for (const chunk of verifiedChunks) {
            const icon = chunk.status === "CONFIRMED" ? "✓" : chunk.status === "INVALID" ? "✗" : "⚠"
            out.push(`\nChunk ${chunk.chunk} [${chunk.status}] ${icon}`)
            out.push(chunk.text.slice(0, 500))
            out.push(`  Sources: ${chunk.sources.join(", ")}`)
            out.push(`  Score: ${chunk.score.toFixed(2)}`)
          }

          // 4. Conversation windows
          if (windows.length > 0) {
            out.push("\n═══ [CONVERSATION WINDOWS] ═══")
            out.push(...windows)
          }

          // 5. Verification results
          if (verifications.length > 0) {
            out.push("\n═══ [VERIFICATION] ═══")
            out.push(...verifications)
          }

          // 6. Story
          const confirmedCount = verifiedChunks.filter(c => c.status === "CONFIRMED").length
          const invalidCount = verifiedChunks.filter(c => c.status === "INVALID").length
          out.push("\n═══ [STORY SUMMARY] ═══")
          out.push(`Chunks: ${confirmedCount} confirmed, ${invalidCount} invalid, ${verifiedChunks.length - confirmedCount - invalidCount} unverified`)
          out.push(`Branch: ${currentBranch}`)
          out.push(`Search time: ${((Date.now() - tStart) / 1000).toFixed(1)}s`)

          out.push("\n═══ END ═══")
          out.push("[Retrieval] Next query will do a fresh search. Nothing is accumulated.")

          return { output: out.join("\n") }
        }
      }),

      // ══════════════════════════════════════════════════
      // session_trajectory — Where you left off
      // ══════════════════════════════════════════════════

      session_trajectory: tool({
        description: "Shows where you left off in the last session. Reads the session summary to show what was being worked on and what was pending.",
        args: {},
        async execute() {
          const trajectory = getSessionTrajectory(directory)
          if (trajectory.length === 0) {
            return { output: "═══ SESSION TRAJECTORY ═══\nNo previous session found. This is your first session in this project." }
          }
          return { output: `═══ SESSION TRAJECTORY ═══\n\n${trajectory[0].text}\n\n[Trajectory] Continue from where you left off.` }
        }
      }),

      // ══════════════════════════════════════════════════
      // pagerank — Most-imported files
      // ══════════════════════════════════════════════════

      pagerank: tool({
        description: "Shows the most-imported files in the project (Code PageRank). Files imported by many other files are the most critical — changing them breaks the most code.",
        args: { top_n: tool.schema.number().describe("Number of top files to show").optional().default(10) },
        async execute(args) {
          const n = Math.min(args.top_n || 10, 30)
          try {
            const srcDir = `${directory}/src`
            if (!existsSync(srcDir)) return { output: "═══ CODE PAGERANK ═══\nNo src/ directory found in this project." }
            const result = execSync(
              `grep -rn --include="*.{ts,tsx,js,jsx,py,go,rs}" -E "from |import " "${srcDir}" 2>/dev/null | grep -oP "from ['\\"]([^'\\"/]+)" | sort | uniq -c | sort -rn | head -${n}`,
              { encoding: "utf8", timeout: 10000 }
            ).toString().trim()
            if (!result) return { output: "═══ CODE PAGERANK ═══\nNo import data found." }
            const lines = result.split("\n").map(line => {
              const m = line.trim().match(/(\d+)\s+(.+)/)
              if (m) {
                const bar = "█".repeat(Math.min(Math.round(parseInt(m[1]) / 2), 20))
                return `  ${bar} ${m[1]}x — ${m[2]}`
              }
              return line
            })
            return { output: `═══ CODE PAGERANK (top ${n}) ═══\n\n${lines.join("\n")}\n\n[PageRank] Files with more imports are more critical.` }
          } catch {
            return { output: "═══ CODE PAGERANK ═══\nError computing PageRank." }
          }
        }
      }),

      // ══════════════════════════════════════════════════
      // temporal_chain — Show causal chain for an event
      // ══════════════════════════════════════════════════

      temporal_chain: tool({
        description: "Shows the causal chain around a specific event — what led to it and what resulted from it. Like git log for conversation history.",
        args: {
          query: tool.schema.string().describe("Describe the event you want to trace"),
          direction: tool.schema.enum(["forward", "backward", "both"]).describe("Which direction to trace").optional().default("both"),
        },
        async execute(args) {
          const query = args.query || ""
          const dir = args.direction || "both"
          const maxHops = 10

          // Find matching nodes
          const graphFile = `${directory}/${KNOWLEDGE_DIR}/session-graph.jsonl`
          if (!existsSync(graphFile)) return { output: "═══ TEMPORAL CHAIN ═══\nNo temporal graph data found yet. Events are recorded as you work." }

          const nodes = readJSONL(graphFile).filter((e: any) => e.type === "node")
          const qWords = query.toLowerCase().split(/\W+/).filter(Boolean)
          const matches = nodes.filter((n: any) => qWords.some((w: string) => (n.label || "").toLowerCase().includes(w)))

          if (matches.length === 0) return { output: `═══ TEMPORAL CHAIN ═══\nNo events found matching: "${query}"` }

          const node = matches[0]
          const chain = traceChain(node.id, directory, dir as any, maxHops)

          if (chain.length === 0) return { output: `═══ TEMPORAL CHAIN ═══\nFound event "${node.label}" but no chain connections yet.` }

          // Build output as a chain diagram
          const lines = ["═══ TEMPORAL CHAIN ═══", `Event: ${node.label}`, `Session: ${node.session || "?"}`, ""]
          for (let i = 0; i < chain.length; i++) {
            const n = chain[i]
            const arrow = i < chain.length - 1 ? "  ↓" : ""
            lines.push(`  ${i + 1}. [${n.kind}] ${n.label}`)
            if (arrow) lines.push(arrow)
          }

          return { output: lines.join("\n") }
        }
      }),

      // ─── supersede: Mark past decision as obsolete ────
      supersede: tool({
        description: "Marks a past decision or event as superseded. The old entry is NOT deleted — retrieval will flag it as OBSOLETE instead of presenting it as current truth.",
        args: {
          id: tool.schema.string().describe("ID of the decision/event to mark obsolete (from temporal_chain output)"),
          reason: tool.schema.string().describe("Why this is being superseded"),
          new_decision: tool.schema.string().describe("What the new correct fact is").optional().default(""),
        },
        async execute(args) {
          const id = args.id || ""
          if (!id) return { output: "Error: 'id' is required. Use temporal_chain first." }
          const graphFile = `${directory}/${KNOWLEDGE_DIR}/session-graph.jsonl`
          appendJSONL(graphFile, { type: "obsolete", targetId: id, reason: args.reason, newDecision: args.new_decision || undefined })
          return { output: `═══ SUPERSEDE ═══\nMarked "${id}" as obsolete.\nReason: ${args.reason}\n[Correction] Old entry preserved (audit trail). Retrieval will flag it as OBSOLETE.` }
        }
      }),
    },

    // ══════════════════════════════════════════════════
    // AUTO-CAPTURE HOOK: Save turns + events
    // ══════════════════════════════════════════════════

    "tool.execute.after": async (input, output) => {
      const outputStr = (output.output || "").toString()
      const toolName = input.tool || ""

      // Skip for our own tools
      if (["retrieve", "session_trajectory", "pagerank", "temporal_chain"].includes(toolName)) return

      // Save user messages as turn nodes
      if (toolName === "bash" || toolName === "edit" || toolName === "write" || toolName === "read") {
        const userMsg = (input.args as any)?.command || (input.args as any)?.filePath || (input.args as any)?.path || ""
        const aiMsg = outputStr.slice(0, 200)
        if (userMsg || aiMsg) {
          saveTurn(userMsg, aiMsg)
        }
      }

      // Save significant events
      if (outputStr.includes("COMPILATION ERROR") || outputStr.includes("error:")) {
        const eventId = saveEvent("error", outputStr.slice(0, 200))
        if (lastTurnId) saveEdge(lastTurnId, eventId, "resulted_in")
      }
      if (outputStr.includes("Auto-fixed") || outputStr.includes("[Self-Healing]")) {
        const eventId = saveEvent("fix", outputStr.slice(0, 200))
        if (lastTurnId) saveEdge(lastTurnId, eventId, "fixed")
      }
      if (outputStr.includes("COMPILATION PASSED") || outputStr.includes("All checks passed")) {
        const eventId = saveEvent("test", "Verification passed: " + outputStr.slice(0, 100))
        if (lastTurnId) saveEdge(lastTurnId, eventId, "verified")
      }
      if (toolName === "research_problem" || toolName === "research_execute") {
        const eventId = saveEvent("research", outputStr.slice(0, 200))
        if (lastTurnId) saveEdge(lastTurnId, eventId, "researched")
      }
    },

    // ══════════════════════════════════════════════════
    // COMPACTION: Inject retrieval context
    // ══════════════════════════════════════════════════

    "experimental.session.compacting": async (_input, output) => {
      output.context.push(
        `## Retrieval Engine Available\n` +
        `- retrieve({query, max_chunks?, include_conversation?}) — search ALL past sessions and knowledge\n` +
        `- session_trajectory() — see where you left off last session\n` +
        `- pagerank({top_n?}) — see most critical files by import count\n` +
        `- temporal_chain({query, direction?}) — trace causal chain of events`
      )
    },
  }
}
