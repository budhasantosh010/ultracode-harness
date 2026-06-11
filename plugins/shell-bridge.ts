import type { Plugin } from "@opencode-ai/plugin"
import { tool } from "@opencode-ai/plugin"
import { execSync } from 'child_process'

export const ShellBridge: Plugin = async () => {

  return {
    tool: {
      shell_exec: tool({
        description:
          "Executes a shell command using Node.js child_process. " +
          "Use this INSTEAD of the broken 'bash' tool. " +
          "Works on Windows with PowerShell.",
        args: {
          command: tool.schema.string().describe("The command to execute"),
          cwd: tool.schema.string().describe("Working directory").optional().default("."),
        },
        async execute(args) {
          try {
            const result = execSync(args.command, {
              cwd: args.cwd,
              encoding: 'utf-8',
              timeout: 30000,
              stdio: ['pipe', 'pipe', 'pipe']
            })
            return { output: result.trim() }
          } catch (err: any) {
            const stdout = err.stdout?.toString().trim() || ""
            const stderr = err.stderr?.toString().trim() || err.message
            return {
              output: stdout ? `STDOUT:\n${stdout}\nSTDERR:\n${stderr}` : stderr || err.message,
            }
          }
        }
      }),

      shell_mkdir: tool({
        description: "Creates directories (works around broken bash).",
        args: {
          path: tool.schema.string().describe("Directory path to create"),
        },
        async execute(args) {
          try {
            execSync(`powershell -Command "New-Item -ItemType Directory -Path '${args.path}' -Force"`, { encoding: 'utf-8' })
            return { output: `Created directory: ${args.path}` }
          } catch (err: any) {
            return { output: `Failed to create directory: ${err.message}` }
          }
        }
      }),

      shell_ls: tool({
        description: "Lists files in a directory (works around broken bash).",
        args: {
          path: tool.schema.string().describe("Directory path to list"),
        },
        async execute(args) {
          try {
            const result = execSync(`powershell -Command "Get-ChildItem '${args.path}' | Select-Object Name, Length"`, { encoding: 'utf-8' })
            return { output: result.trim() }
          } catch (err: any) {
            return { output: `Failed to list directory: ${err.message}` }
          }
        }
      }),
    }
  }
}
