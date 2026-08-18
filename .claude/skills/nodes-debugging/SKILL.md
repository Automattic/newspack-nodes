---
name: nodes-debugging
description: Debugging the newspack-nodes substrate live — REPL commands, log paths, worker health, and common failure modes. Use when something flowing through the node graph isn't behaving as expected, when workers are unhealthy, or when you need to inspect node state without redeploying.
argument-hint: "[symptom]"
---

# Newspack Nodes Debugging

The full live-investigation reference lives in **`docs/troubleshooting.md`** (promoted from this skill so humans get it too). Read that file — it covers the REPL's bare vs pivoted modes, the verb table, piping into the REPL, worker health verbs, the on-disk log layout, the common failure modes, and the wire format.

Claude-specific notes on top of it:

- `wp nodes doctor` first when the environment is suspect (memcache / WP-Cron / filesystem / ownership) — each failure line names the concrete degradation.
- Run the cli as the web user, never root — it refuses otherwise, because the workers own the IPC dirs it appends to: `wp nodes cli <reader>.p<N>`.
- For the event-logger application's reqgrep pretty-printer, see the event-logger-nodes debugging skill — it unwraps the envelope and renders the inner entry.

## Related Skills

- `nodes-workflow` — workflow for landing changes
- `nodes-review` — substrate contract checklist
