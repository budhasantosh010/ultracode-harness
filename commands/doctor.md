---
name: doctor
description: Diagnose and troubleshoot the current environment
---

Run environment diagnostics:

1. Check key settings:
   - Run `opencode --version` for OpenCode version
   - Run `node --version` and `bun --version` for runtimes
   - Run `git --version` for git
2. Check the current project:
   - Run `git status --short` and `git branch --show-current`
   - Check if `package.json` exists and list key dependencies
   - Check if `tsconfig.json` exists
3. Check OpenCode configuration:
   - Read `~/.config/opencode/opencode.jsonc` for model/provider/plugin config
   - List plugins directory: `ls ~/.config/opencode/plugins/`
   - List agents: `opencode agent list`
4. Check provider connectivity (if applicable)
5. Report any issues found: missing dependencies, configuration problems, version conflicts, permission issues
6. Suggest fixes for each issue found
