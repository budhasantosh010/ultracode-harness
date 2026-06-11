---
name: code-review
description: Review code changes and optionally apply fixes automatically
---

Review uncommitted code changes:

1. Run `git diff` to get the current working tree diff
2. Analyze every changed file for: bugs, security issues, type safety, error handling, code quality
3. Rate each finding: CRITICAL / HIGH / MEDIUM / LOW
4. If `--fix` flag is passed: attempt to apply fixes for MEDIUM+ findings automatically after presenting them
5. Use `adversarial_review` on critical findings before reporting
6. Present the review with specific file:line references and suggested fixes

Usage:
- `/code-review` — Review changes and list findings
- `/code-review --fix` — Review changes and apply fixes for MEDIUM+ severity
