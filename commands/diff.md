---
name: diff
description: Show the current git diff with syntax categorization
---

Show the current working tree diff with analysis:

1. Run `git diff` for unstaged changes. If empty, run `git diff --cached` for staged changes.
2. Show the full diff output
3. Categorize changes by type:
   - **Added** (new files/functions)
   - **Modified** (changed logic)
   - **Fixed** (bug fixes)
   - **Removed** (deletions)
4. Count total: files changed, insertions, deletions
5. Ask if the user wants to stage these changes or proceed to /commit
