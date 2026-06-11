---
name: compact
description: Manually trigger context compaction to save tokens
---

Manually compact the conversation context:

1. Summarize what's been accomplished so far in this session
2. Summarize any pending tasks or decisions
3. Identify any state that needs preservation (checkpoints, memory, task lists)
4. Save a checkpoint if the system supports it
5. Summarize the current working state concisely:
   ```
   ## Session State
   - Project: [name]
   - Branch: [current]
   - Last action: [what was just done]
   - Next step: [what's pending]
   - Key decisions: [any unresolved choices]
   ```
6. Present the summary to the user
