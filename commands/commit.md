---
name: commit
description: Create a git commit with an AI-generated or manual message
---

Create a well-structured git commit:

1. Run `git diff --cached --stat` to show staged files. If nothing staged, run `git status --short` to show all changed files.
2. Analyze the changes and determine the type (feat, fix, docs, refactor, test, chore, etc.)
3. Generate a concise, descriptive commit message (max 72 chars first line, detail in body)
4. Show the user the proposed message and get confirmation
5. On confirmation: `git commit -m "type(scope): description" -m "Longer description of what and why."`
6. Co-author with: `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`
