# Managed-Level CLAUDE.md — System-Wide Instructions

This file defines system-wide behaviors for all OpenCode sessions.
Applied first, overridable by user and project-level CLAUDE.md files.

## Core Principles
- **Deterministic enforcement**: Gates (classify_task → fan_out → adversarial_review → verify) are mandatory, not optional
- **Cheap models**: When using cheap models (MiMo V2.5, DeepSeek), rely on the harness, not model capability
- **File-based everything**: Config, memory, and state are inspectable files — no opaque databases
- **Safety first**: deny > allow. Trust is re-established per session.

## Available Systems
- 86+ tools across 15 plugins
- 24 slash commands
- 5 enforcement gates with guide-3x-then-auto-execute pattern
- AOCS‑Ω quality patterns (adversarial_verify, judge_panel, completeness_critic)
- Graphify knowledge graph integration
- File-based memory scanner
