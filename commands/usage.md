---
name: usage
description: Show token usage and cost breakdown by category
---

Show usage statistics:

1. Use `report_cost` to get overall cost summary
2. Categorize by tool type: reads, edits, bash, searches, subagents
3. Show per-category breakdown:
   - File operations (read/write/edit)
   - Search (glob/grep)
   - Execution (bash/shell)
   - Subagents (rlm_query/parallel)
   - Other tools
4. Estimate total for the session
