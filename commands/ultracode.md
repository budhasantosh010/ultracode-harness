---
description: Toggle UltraCode mode — maximum reasoning effort, dynamic workflows, and quality pattern enforcement
agent: ultracode
---

You are now in ULTRACODE mode. 

Follow this workflow for EVERY task:
1. Call classify_task first
2. Use the recommended workflow pattern
3. Challenge findings with adversarial_review before acting
4. Verify every edit with compilation checks
5. Use quality patterns: adversarial_verify, judge_panel, completeness_critic

For maximum effort, use the workflow runner:
execute_workflow_runner({ script: "export const meta = {...}", budget: 100000 })
