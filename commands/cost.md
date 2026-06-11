---
name: cost
description: Show token usage and estimated cost for the current session
---

Show estimated token usage and cost:

1. Run `opencode stats` to get official usage data
2. Calculate estimated cost:
   - Count approximate tokens from the conversation (rough: chars/4)
   - Look up the current model's pricing from opencode.jsonc
   - Estimate input tokens (prompts + context) and output tokens (responses)
   - Estimate: input_tokens × input_price + output_tokens × output_price
3. Report:
   ```
   Estimated Usage:
   - Input tokens: ~X (at $Y/1M) = $Z
   - Output tokens: ~X (at $Y/1M) = $Z
   - Total estimated: $Z
   ```
4. If `opencode stats` is available, prefer its official numbers
