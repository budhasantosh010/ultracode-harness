---
name: workflows
description: List, monitor, and manage workflow runs
---

Manage workflow runs:

1. `workflow_status({run_id})` — Check progress of a specific run
2. `stop_workflow()` — Stop all running agents
3. `execute_workflow` with `skip_approval: true` — Execute a saved workflow script

Saved workflow scripts are at `.opencode/runtime/workflows/wf_*.js`. Inspect, edit, and re-run them.
