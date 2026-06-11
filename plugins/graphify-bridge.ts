// ═══════════════════════════════════════════════════════════════
// GRAPHIVY BRIDGE — Knowledge Graph Integration for OpenCode
// Wraps graphify CLI (https://github.com/safishamsi/graphify)
// Builds a queryable knowledge graph from any codebase
// Features: build, query, explain, path-find, MCP server
// ═══════════════════════════════════════════════════════════════

import type { Plugin } from "@opencode-ai/plugin"
import { tool } from "@opencode-ai/plugin"
import { execSync } from "child_process"
import { existsSync } from "fs"
import { readFile } from "fs/promises"

const GRAPHIVY_OUT = "graphify-out"
const GRAPH_FILE = `${GRAPHIVY_OUT}/graph.json`
const REPORT_FILE = `${GRAPHIVY_OUT}/GRAPH_REPORT.md`

export const GraphifyBridge: Plugin = async ({ directory }) => {

  async function ensureGraphify(): Promise<string> {
    try {
      execSync("graphify --version 2>&1", { encoding: "utf8", timeout: 5000 })
      return "ok"
    } catch {
      // Auto-install if missing
      try {
        execSync("pip install graphifyy 2>&1", { encoding: "utf8", timeout: 120000 })
        return "installed"
      } catch (e: any) {
        return `install failed: ${e.message?.slice(0, 200)}`
      }
    }
  }

  function graphExists(): boolean {
    return existsSync(`${directory}/${GRAPH_FILE}`)
  }

  async function loadGraphSummary(): Promise<string> {
    try {
      const raw = await readFile(`${directory}/${GRAPH_FILE}`, "utf8")
      const g = JSON.parse(raw)
      const nodeCount = g.nodes?.length || 0
      const edgeCount = g.edges?.length || 0
      return `${nodeCount} nodes, ${edgeCount} edges`
    } catch {
      return "unknown"
    }
  }

  return {
    tool: {
      // ═════════════════════════════════════════════════
      // graphify_build: Build knowledge graph for a project
      // ═════════════════════════════════════════════════
      graphify_build: tool({
        description:
          "Builds a knowledge graph from the current project using graphify. " +
          "Scans all code files, docs, images, PDFs and extracts concepts, " +
          "relationships, call graphs, and dependencies. " +
          "Output: graph.json (queryable), GRAPH_REPORT.md (summary), graph.html (visualization). " +
          "Use BEFORE complex tasks to understand the codebase in 71x fewer tokens.",
        args: {
          path: tool.schema.string().describe("Project path to graph").optional().default("."),
          mode: tool.schema.enum(["standard", "deep"]).describe("Extraction depth").optional().default("standard"),
          update: tool.schema.boolean().describe("Re-extract only changed files").optional().default(false),
          wiki: tool.schema.boolean().describe("Generate markdown wiki from graph").optional().default(false),
          cluster_only: tool.schema.boolean().describe("Rerun clustering without re-extracting").optional().default(false),
          no_viz: tool.schema.boolean().describe("Skip HTML viz, produce only report+JSON").optional().default(false),
          force: tool.schema.boolean().describe("Overwrite even if fewer nodes").optional().default(false),
        },
        async execute(args) {
          const status = await ensureGraphify()
          if (status !== "ok" && status !== "installed") return { output: `Graphify setup failed: ${status}\nInstall manually: pip install graphifyy` }

          const targetPath = args.path === "." ? directory : args.path
          let cmd = `graphify "${targetPath}"`
          if (args.mode === "deep") cmd += " --mode deep"
          if (args.update) cmd += " --update"
          if (args.wiki) cmd += " --wiki"
          if (args.cluster_only) cmd += " --cluster-only"
          if (args.no_viz) cmd += " --no-viz"
          if (args.force) cmd += " --force"

          try {
            const raw = execSync(cmd, { encoding: "utf8", timeout: 300000, maxBuffer: 10*1024*1024, cwd: directory })
            const summary = await loadGraphSummary()
            let report = ""
            try { report = (await readFile(`${directory}/${REPORT_FILE}`, "utf8")).slice(0, 2000) } catch {}
            return {
              output: [
                `═══ GRAPHIFY BUILD COMPLETE ═══`,
                `Graph: ${summary}`,
                `Output: ${directory}/${GRAPHIVY_OUT}/`,
                `Report:\n${report || "(no report)"}`,
                ``,
                `Next steps: graphify_query to ask questions, graphify_explain for nodes, graphify_path for connections.`,
              ].join("\n")
            }
          } catch (e: any) {
            return { output: `Graphify build failed:\n${(e.stdout || e.message || "").toString().slice(0, 2000)}` }
          }
        }
      }),

      // ═════════════════════════════════════════════════
      // graphify_query: Ask questions against the graph
      // ═════════════════════════════════════════════════
      graphify_query: tool({
        description:
          "Queries the knowledge graph with a natural language question. " +
          "71x more token-efficient than reading raw files. " +
          "Use after graphify_build has completed.",
        args: {
          question: tool.schema.string().describe("Natural language query about the codebase"),
          budget: tool.schema.number().describe("Token budget for query").optional().default(1500),
        },
        async execute(args) {
          if (!graphExists()) {
            return { output: "No graph found. Run graphify_build first to build one." }
          }
          try {
            const cmd = `graphify query "${args.question.replace(/"/g,'\\"')}" --budget ${args.budget || 1500}`
            const raw = execSync(cmd, { encoding: "utf8", timeout: 60000, cwd: directory })
            return { output: raw.replace(/\x1B\[[0-9;]*[a-zA-Z]/g, "").trim().slice(0, 5000) }
          } catch (e: any) {
            return { output: `Query failed:\n${(e.stdout || e.message || "").toString().slice(0, 1000)}` }
          }
        }
      }),

      // ═════════════════════════════════════════════════
      // graphify_explain: Explain a specific node
      // ═════════════════════════════════════════════════
      graphify_explain: tool({
        description:
          "Explains a specific concept or node in the knowledge graph. " +
          "Shows its connections, dependencies, and callers. " +
          "Use to understand a specific function, module, or concept.",
        args: {
          node: tool.schema.string().describe("Node name to explain (function, class, module, concept)"),
        },
        async execute(args) {
          if (!graphExists()) return { output: "No graph found. Run graphify_build first." }
          try {
            const raw = execSync(`graphify explain "${args.node.replace(/"/g,'\\"')}"`, { encoding: "utf8", timeout: 30000, cwd: directory })
            return { output: raw.replace(/\x1B\[[0-9;]*[a-zA-Z]/g, "").trim().slice(0, 4000) }
          } catch (e: any) {
            return { output: `Explain failed:\n${(e.stdout || e.message || "").toString().slice(0, 1000)}` }
          }
        }
      }),

      // ═════════════════════════════════════════════════
      // graphify_path: Find path between nodes
      // ═════════════════════════════════════════════════
      graphify_path: tool({
        description:
          "Finds the shortest path between two concepts in the knowledge graph. " +
          "Reveals hidden connections: how A connects to B through intermediate nodes.",
        args: {
          from: tool.schema.string().describe("Starting node"),
          to: tool.schema.string().describe("Target node"),
        },
        async execute(args) {
          if (!graphExists()) return { output: "No graph found. Run graphify_build first." }
          try {
            const raw = execSync(`graphify path "${args.from.replace(/"/g,'\\"')}" "${args.to.replace(/"/g,'\\"')}"`, { encoding: "utf8", timeout: 30000, cwd: directory })
            return { output: raw.replace(/\x1B\[[0-9;]*[a-zA-Z]/g, "").trim().slice(0, 4000) }
          } catch (e: any) {
            return { output: `Path query failed:\n${(e.stdout || e.message || "").toString().slice(0, 1000)}` }
          }
        }
      }),

      // ═════════════════════════════════════════════════
      // graphify_status: Check graph status
      // ═════════════════════════════════════════════════
      graphify_status: tool({
        description:
          "Checks if a knowledge graph exists for the current project. " +
          "Shows node/edge counts, report summary, and last build time.",
        args: {},
        async execute() {
          const installed = await ensureGraphify()
          const exists = graphExists()
          let summary = ""
          let report = ""
          if (exists) {
            summary = await loadGraphSummary()
            try { report = (await readFile(`${directory}/${REPORT_FILE}`, "utf8")).slice(0, 1500) } catch {}
          }
          return {
            output: [
              `═══ GRAPHIFY STATUS ═══`,
              `Installed: ${installed === "ok" || installed === "installed" ? "✅" : "❌"}`,
              `Graph exists: ${exists ? "✅" : "❌"}`,
              exists ? `Graph: ${summary}` : "",
              exists && report ? `Report preview:\n${report}` : "",
              !exists ? `Run graphify_build to create a knowledge graph for this project.` : "",
            ].filter(Boolean).join("\n")
          }
        }
      }),
    }
  }
}
