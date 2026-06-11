---
name: memory
description: Manage persistent memory — save, search, list, and delete memories
---

Manage persistent memory across sessions:

1. If the user provides text to remember, use `memory_save` to store it
2. If the user asks about a topic, use `memory_search` to find relevant memories
3. If the user wants to see all memories, use `memory_list`
4. If the user wants to delete a memory, use `memory_delete`
5. All memories are stored with: name, description, type (user | feedback | project | reference), and content

Usage:
- `/memory save "name" "description" "content"` — Save a new memory
- `/memory search "query"` — Search memories
- `/memory list` — List all memories
- `/memory delete "name"` — Delete a memory by name
