---
name: graphify
description: Build and query a knowledge graph of the current project for codebase understanding
---

Build and query a knowledge graph of the codebase:

1. `graphify_build()` — Build knowledge graph from the project. Use BEFORE complex tasks.
2. `graphify_query({question})` — Ask questions against the graph (71x fewer tokens than reading files).
3. `graphify_explain({node})` — Explain a specific function, class, or concept.
4. `graphify_path({from, to})` — Find hidden connections between two concepts.
5. `graphify_status()` — Check if graph exists and see its stats.

The graph is stored in `graphify-out/` and can be reused across sessions. Build once, query many times.
