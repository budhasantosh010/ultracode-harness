---
name: context
description: Visualize the current conversation context — tokens, files, state
---

Visualize the current session context:

1. Estimate current context usage:
   - Count recent messages exchanged
   - Estimate token count (rough: chars/4)
   - Note what's in context (files read, errors encountered, decisions made)
2. List files that have been read or modified in this session
3. Show any active state:
   - Current workflow step (if in a workflow)
   - Feature flags status
   - Permission mode
   - Plan mode status
4. Summarize the conversation flow:
   ```
   Current session:
   - Messages: ~X
   - Estimated tokens: ~X
   - Model: [current model]
   - Active mode: [ultracode/plan/normal]
   - Files touched: X
   - Active workflow: [name] (step X/Y)
   ```
