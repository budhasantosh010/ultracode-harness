// ═══════════════════════════════════════════════════════════════
// HOOK MATCHERS — Pattern matching for tool/file-based hooks
// Phase 2: T2.1 + T2.3 + T2.4 + T2.5
// ═══════════════════════════════════════════════════════════════
// NOTE: This is a LIBRARY, not a plugin. It does not export a Plugin.
// harness.ts inlines the needed parts. This file exists for reference
// and for any future plugin that needs the matching engine.
//
// Deterministic enforcement: matching logic is CODE, not instructions.
// The model never decides whether a hook fires — this code does.

// ─── Pattern Types ───────────────────────────────────────────

export type ToolPattern =
  | { type: "exact"; tool: string }
  | { type: "prefix"; prefix: string }
  | { type: "glob"; pattern: string }
  | { type: "regex"; regex: string }
  | { type: "list"; patterns: ToolPattern[] }

export type FilePathPattern =
  | { type: "exact"; path: string }
  | { type: "glob"; pattern: string }
  | { type: "regex"; regex: string }
  | { type: "extension"; ext: string }

export type HookPriority = number

export interface HookRule {
  id: string
  name: string
  priority: HookPriority
  toolPattern?: ToolPattern
  filePathPattern?: FilePathPattern
  commandPattern?: string
  oncePerSession: boolean
  enabled: boolean
  handler: HookHandler
}

export type HookHandler = (
  input: { tool: string; sessionID: string; callID: string },
  output: { args: any }
) => Promise<{ action: "allow" | "block" | "modify"; reason?: string; modifiedArgs?: any } | null>

// ─── Pattern Matching Engine ─────────────────────────────────

export function matchToolName(pattern: ToolPattern, toolName: string): boolean {
  switch (pattern.type) {
    case "exact":
      return toolName === pattern.tool
    case "prefix":
      return toolName.startsWith(pattern.prefix)
    case "glob": {
      const match = pattern.pattern.match(/^(\w+)\((.+)\)$/)
      if (!match) return toolName === pattern.pattern
      const [, requiredTool, argGlob] = match
      if (toolName !== requiredTool) return false
      const regex = "^" + argGlob.replace(/\*/g, ".*").replace(/\?/g, ".") + "$"
      return new RegExp(regex).test(toolName)
    }
    case "regex":
      return new RegExp(pattern.regex).test(toolName)
    case "list":
      return pattern.patterns.some(p => matchToolName(p, toolName))
    default:
      return false
  }
}

export function matchFilePath(pattern: FilePathPattern, filePath: string): boolean {
  if (!filePath) return false
  switch (pattern.type) {
    case "exact":
      return filePath === pattern.path
    case "glob": {
      const regex = pattern.pattern
        .replace(/\*\*/g, "§DOUBLESTAR§")
        .replace(/\*/g, "[^/]*")
        .replace(/§DOUBLESTAR§/g, ".*")
      return new RegExp("^" + regex + "$").test(filePath)
    }
    case "regex":
      return new RegExp(pattern.regex).test(filePath)
    case "extension":
      return filePath.endsWith(pattern.ext)
    default:
      return false
  }
}

export function matchCommand(pattern: string, command: string): boolean {
  if (!command) return false
  return new RegExp(pattern).test(command)
}

// ─── Hook Registry ───────────────────────────────────────────

export class HookRegistry {
  private rules: HookRule[] = []
  private firedOnce: Set<string> = new Set()
  private firedInSession: Set<string> = new Set()

  addRule(rule: HookRule) {
    this.rules.push(rule)
    this.rules.sort((a, b) => a.priority - b.priority)
  }

  removeRule(id: string) {
    this.rules = this.rules.filter(r => r.id !== id)
  }

  clearSessionState() {
    this.firedInSession.clear()
    this.firedOnce.clear()
  }

  getMatchingRules(
    toolName: string,
    filePath?: string,
    command?: string
  ): HookRule[] {
    return this.rules.filter(rule => {
      if (!rule.enabled) return false
      if (rule.oncePerSession && this.firedInSession.has(rule.id)) return false
      if (rule.toolPattern && !matchToolName(rule.toolPattern, toolName)) return false
      if (rule.filePathPattern && filePath && !matchFilePath(rule.filePathPattern, filePath)) return false
      if (rule.commandPattern && command && !matchCommand(rule.commandPattern, command)) return false
      return true
    })
  }

  async executeRules(
    toolName: string,
    args: any,
    sessionID: string,
    callID: string
  ): Promise<{
    action: "allow" | "block" | "modify"
    reason?: string
    modifiedArgs?: any
    firedRules: string[]
  }> {
    const filePath = args?.filePath || args?.path || ""
    const command = args?.command || ""
    const matchingRules = this.getMatchingRules(toolName, filePath, command)
    const firedRules: string[] = []
    let finalAction: "allow" | "block" | "modify" = "allow"
    let finalReason: string | undefined
    let finalModifiedArgs: any = undefined

    for (const rule of matchingRules) {
      try {
        const result = await rule.handler(
          { tool: toolName, sessionID, callID },
          { args }
        )
        if (result) {
          firedRules.push(rule.id)
          if (rule.oncePerSession) this.firedInSession.add(rule.id)
          if (result.action === "block") {
            finalAction = "block"
            finalReason = result.reason
          } else if (result.action === "modify" && finalAction !== "block") {
            finalAction = "modify"
            finalModifiedArgs = result.modifiedArgs
            finalReason = result.reason
          }
        }
      } catch (err: any) {
        console.error(`[HookRegistry] Rule ${rule.id} failed:`, err.message)
      }
    }

    return { action: finalAction, reason: finalReason, modifiedArgs: finalModifiedArgs, firedRules }
  }

  listRules(): Array<{ id: string; name: string; priority: number; enabled: boolean }> {
    return this.rules.map(r => ({ id: r.id, name: r.name, priority: r.priority, enabled: r.enabled }))
  }
}

// ─── Built-in Rules ──────────────────────────────────────────

export function createBuiltinRules(): HookRule[] {
  return [
    {
      id: "git-safety",
      name: "Git Branch Safety",
      priority: 0,
      toolPattern: { type: "exact", tool: "bash" },
      commandPattern: /(?:^|;|\|\||&&)\s*git\s+(push|merge|checkout\s+main)\b/i.source,
      oncePerSession: false,
      enabled: true,
      handler: async (_input, output) => {
        const cmd = output.args?.command || ""
        if (/(?:^|;|\|\||&&)\s*git\s+(push|merge|checkout\s+main)\b/i.test(cmd)) {
          return { action: "block", reason: "Git push/merge/checkout-main blocked by hook. Use /push or ask user." }
        }
        return null
      },
    },
    {
      id: "track-fanout",
      name: "Track Fan-Out",
      priority: 5,
      toolPattern: { type: "exact", tool: "fan_out" },
      oncePerSession: false,
      enabled: true,
      handler: async () => ({ action: "allow" }),
    },
    {
      id: "track-adversarial",
      name: "Track Adversarial Review",
      priority: 5,
      toolPattern: { type: "exact", tool: "adversarial_review" },
      oncePerSession: false,
      enabled: true,
      handler: async () => ({ action: "allow" }),
    },
    {
      id: "log-edits",
      name: "Log File Edits",
      priority: 8,
      toolPattern: { type: "list", patterns: [
        { type: "exact", tool: "edit" },
        { type: "exact", tool: "write" },
      ]},
      oncePerSession: false,
      enabled: true,
      handler: async () => ({ action: "allow" }),
    },
  ]
}
