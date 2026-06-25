---
name: nodes-dashboards
description: Use when building or changing a dashboard / inspector / panel on the newspack-nodes substrate (topology console, debug overlay, event & performance dashboards, or a consumer plugin's dashboard) — especially before writing a "view node" that receives a whole model, or a server command that computes everything.
---

# Dashboards Are Node Graphs, Not God Objects

A dashboard's data flow is a **real node graph with message traffic at every edge** — composable, introspectable, reusable — exactly like a worker pipeline. If your dashboard is one *view node* that receives a finished model from one server command and hands it to React, you have NOT built a Nodes dashboard: you've built a React app with a dead node stapled on. It sits at **counter 0 / 0 B** in the console — zero traffic, nothing to drop a `Tee` into, nothing for the debug overlay to show, nothing reusable.

**God nodes and god commands are the same anti-pattern.** One client node holding the whole model is a god node; one server verb (`insights` → `{sources, top, accumulated}`) computing the whole model is a god command. Both kill composition, introspection, and reuse. Decompose BOTH sides.

## The pattern — compose the data flow

```
Timer ─> Tee ─> Fetcher(recv=countsIn, cmd=counts) ─┐
              └> Fetcher(recv=topIn,    cmd=top)    ─┤   target = _shell/_http/<ci>
                                                     ▼
                    _shell (Tap — watch every send) ─> _http (HttpOut)
                                       POST one batch │ ▲ responses batch back
                                                     ▼ │
                          ═══ server graph: small verbs / nodes, NO god command ═══
                                                     │
        countsIn (Tee) ─> Counter ─> counts-view-node ─> <CountsWidget/>
        topIn    (Tee) ─> Ranker  ─> top-view-node    ─> <TopTableWidget/>
```

- **`Timer`** ticks the poll and **hitchhikes** the router tick, so every command emitted on a tick — and every response — **batches into ONE HTTP round-trip** (`HttpOut` locks on the tick, buffers, `flush()`es one `postBatch`). **Fan-out is free: ten fetchers, one request.**
- **`Fetcher`** (generic, reusable; net-new primitive): args = `(receiver, command, command_args…)`. Its `fill()` ignores the payload — any message is just the **trigger** to emit *its configured* command with `FROM` = its receiver. The command is configured on the node, **never read from the triggering message** — a node that just sends whatever command its message carries IS a `Shell` (a Shell *sends* commands; a command *interpreter* is what interprets them), and a named, always-firing Shell wired into the graph is verboten. `connect_node` it to **`_shell/_http/<ci>`** (not `_http/<ci>` directly): `_shell` is an observe-only **`Tap`** on the command-send path, so you can `connect _shell` and watch every command going out without touching the graph. So `Timer ─> Tee ─> N Fetchers`, each a different configured command, all batched into one tick's POST.
- **Receiver = a `Tee`**: the reply routes back `TO` = the fetcher's receiver and the `Tee` fans it to transforms + per-widget view nodes.
- **Transforms** are small reusable nodes (rank, count, filter, parse) — each consumes and emits, so the work is *on the graph*, inspectable and composable.
- **View nodes** are thin: each holds one widget's slice and `setState`s it for a small React component (`useNodeState`).
- **Server side decomposes too** — small verbs / a server-side graph, one Fetcher per slice; never one verb that returns everything.

## Why (what a god object forfeits)

Traffic at every edge is the whole point: you can **`connect <node>` / drop a `Tee`** to inspect any stage, the **debug overlay** shows the counts move, and the nodes (`Fetcher`, `Tee`, a `Ranker`, a `Counter`) are **reused across dashboards** instead of re-implemented per page. A god view-node + god command gives you none of it — and it's undebuggable precisely because nothing flows.

## Reusable primitives

`Timer`, `Tee`, `HttpOut` (`_http`), `Callback`/`Hook` (transforms), thin view nodes — already in the JS runtime. The generic **`Fetcher`** (trigger → emit command, `FROM` = receiver) is the missing piece: build/reuse it, never inline a bespoke command-firing view node. `mountExospine()` clips your graph onto the `_command_interpreter → _router` backbone.

## Red flags — STOP, you're building a god object

- A view node that receives the whole model and `setState`s it → split into Fetcher → Tee → transforms → per-widget views.
- A server command that returns `{everythingTheDashboardNeeds}` → split into small verbs; one Fetcher per slice.
- A dashboard node sitting at **counter 0** in the console → nothing flows through it; it's dead, not composed.
- "I'll just `useDashboardGraph` + one view + one `poll` command" → that IS the god pattern; it's the shortcut that produced every current god-object dashboard.
- A node that sends whatever command its incoming message carries → that's a `Shell` (Shells *send* commands; interpreters interpret them), and a named always-firing one is verboten. Configure the command on the node (the `Fetcher` pattern); the message is only a trigger. Route through `_shell` (a `Tap`) to watch sends.
- Nothing on the canvas you could drop a `Tee` into, or that the overlay would show moving → there is no graph.

## Required background

`nodes-review` gate #8d (everything sinks into the interpreter; flow via `target`/`TO`/invoke). The Tachikoma batching principle — the tick hitchhike means more fetchers cost the same one POST. Pair with `writing-a-dashboard.md` (the worked rebuild of Publisher Insights this way).
