---
name: review
description: Review the current diff for bugs, security issues, and code quality problems
---

Review all uncommitted changes in the working tree:

1. Run `git diff` to get the full diff of working tree changes
2. If that's empty, try `git diff --cached` for staged changes
3. If both empty, show all files with `git status --short`
4. Analyze every changed file for:
   - Logic bugs and off-by-one errors
   - Security vulnerabilities (injection, XSS, auth bypass, hardcoded secrets)
   - Type safety issues
   - Error handling gaps
   - Race conditions or concurrency issues
   - Performance problems
   - Code quality and maintainability
5. Rate each finding: CRITICAL / HIGH / MEDIUM / LOW
6. Suggest specific fixes with code snippets
7. Use adversarial_review tool to verify your most critical findings before reporting
