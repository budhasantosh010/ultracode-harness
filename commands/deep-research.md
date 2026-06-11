---
name: deep-research
description: Deep multi-source research — executes parallel research agents, cross-checks claims, synthesizes cited report
---

Conduct deep multi-source research:

1. Break the question into 3-5 sub-angles
2. Use `execute_workflow` with the following script pattern:
   - Phase 1: Search — parallel web searches for each sub-angle
   - Phase 2: Fetch — fetch and extract content from found sources
   - Phase 3: Cross-check — adversarially verify claims across sources
   - Phase 4: Synthesize — aggregate findings into cited report
3. Use `quality_bar: "Every claim must cite its source. Unverified claims excluded."`
4. Use `loop: "implement_verify_fix"` so the verifier checks sources are cited
5. Present the final report with markdown citations

Example:
```
execute_workflow({
  script: `export const meta = {name:"deep-research", description:"Multi-source research", phases:[{title:"Search"},{title:"Verify"},{title:"Report"}]}
phase("Search")
agent("Search for information on the topic. Return URLs and key claims.")
agent("Search for opposing viewpoints. Return sources.")  
phase("Verify")
agent("Cross-check claims from both searches. Cite which source supports each claim.")
phase("Report")  
agent("Synthesize findings into a structured report. Every claim must cite its source URL.")`,
  quality_bar: "Every claim must cite its source. No unverified claims.",
  loop: "implement_verify_fix",
  skip_approval: true
})
```
