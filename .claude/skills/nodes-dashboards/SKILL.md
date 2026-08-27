---
name: nodes-dashboards
description: Use when building or changing a dashboard / inspector / panel on the newspack-nodes substrate (topology console, debug overlay, event & performance dashboards, or a consumer plugin's dashboard) — especially before writing a "view node" that receives a whole model, or a server command that computes everything.
---

# Dashboards Are Node Graphs, Not God Objects

A dashboard's data flow is a **real node graph with message traffic at every edge** — composable, introspectable, reusable — like any worker pipeline. One *view node* that takes a finished model from one server command and hands it to React is not a Nodes dashboard; it is a React app with a dead node stapled on. It sits at **counter 0 / 0 B** in the console: nothing flows, so nothing is inspectable and nothing is reusable.

**God nodes and god commands are one anti-pattern.** A client node holding the whole model is a god node; a server verb (`insights` → `{sources, top, accumulated}`) computing the whole model is a god command. Both kill composition, introspection and reuse. Decompose BOTH sides.

## The pattern — compose the data flow

```
Timer ─> Tee ─> Fetcher(recv=countsIn, cmd=counts) ──┐
             └> Fetcher(recv=topIn,    cmd=top) ─────┤ (target = _shell/_http/<ci>)
       ┌─────────────────────────────────────────────┘                               
       ▼
       _shell (Tap — watch every send) ─> _http (HttpOut) ──────────┐
                                          │ ▲ responses batch back  │
                                          │ │                       │
                           POST one batch ▼ │                       │
                                ═══ server graph ===                │
                              (small verbs / nodes, NO god command) │
                                                                    │
       ┌────────────────────────────────────────────────────────────┘
       ▼
       countsIn (Tee) ─> Counter ─> counts-view-node ─> <CountsWidget/>
       topIn    (Tee) ─> Ranker  ─> top-view-node    ─> <TopTableWidget/>
```

- **`Timer`** ticks the poll and **hitchhikes** the router tick, so every command emitted on a tick — and every response — **batches into ONE HTTP round-trip** (`HttpOut` locks on the tick, buffers, `flush()`es one `postBatch`). **Fan-out is free: ten fetchers, one request.**
- **`Fetcher`** (generic, reusable): args = `(receiver, command, command_args…)`. Apart from a reply, its `fill()` ignores the payload — any other message is only the **trigger** to emit *its configured* command with `FROM` = its receiver. ONE ask stands at a time: it goes on the Fetcher's `outbox` when sent and leaves when the reply settles it, so a fast refresh on a slow verb asks once and waits rather than stacking identical commands. `retry_after_s` (15) is the fail-open valve for an answer that never comes. Configure the command on the node, **never read it from the triggering message**: a node that sends whatever command its message carries IS a `Shell`, and a named, always-firing Shell wired into the graph is verboten (see Security Risks). `connect_node` it to **`_shell/_http/<ci>`**, not `_http/<ci>` directly — `_shell` is an observe-only **`Tap`** on the command-send path, so `connect _shell` watches every outgoing command without touching the graph. `Timer ─> Tee ─> N Fetchers`, each with a different configured command, all batch into one tick's POST.
- **Receiver = a `Tee`**: the reply routes back `TO` = the fetcher's receiver, and the `Tee` fans it to transforms and per-widget view nodes.
- **Transforms** are small reusable nodes (rank, count, filter, parse) — each consumes and emits, so the work sits *on the graph*, inspectable and composable.
- **View nodes** are thin: each holds one widget's slice and `setState`s it for a small React component (`useNodeState`).
- **Server side decomposes too** — small verbs or a server-side graph, one Fetcher per slice; never one verb that returns everything.

## Why (what a god object forfeits)

Traffic at every edge is the point: **`connect <node>` / drop a `Tee`** to inspect any stage, the **debug overlay** shows the counts move, and the nodes (`Fetcher`, `Tee`, a `Ranker`, a `Counter`) are **reused across dashboards** rather than re-implemented per page. A god view-node plus a god command forfeits all of it, and is undebuggable precisely because nothing flows.

## Reusable primitives

`Timer`, `Tee`, `HttpOut` (`_http`), `Callback`/`Hook` (transforms) and thin view nodes already ship in the JS runtime (`src/runtime/`). The generic **`Fetcher`** (`src/runtime/fetcher-node.js` — trigger → emit command, `FROM` = receiver) is the missing piece: build and reuse it, never inline a bespoke command-firing view node. `mountExospine()` (`src/runtime/exospine.js`) clips your graph onto the `_command_interpreter → _router` backbone.

**Don't hand-wire the batching boilerplate — the substrate ships it.** Two shared helpers under `src/shared/` (consumed by sibling plugins via the `@newspack-nodes/shared` alias) own the whole `_shell`/`_http`/Timer/Tee/lock-flush and page-visibility scaffold, so a dashboard hook is *just its slices*:

- **`useBatchedPoll`** (`src/shared/hooks/useBatchedPoll.js`) — owns the exospine mount, the `_http` `HttpOut` egress, the observe-only `_shell` `Tap`, the fan-out `Tee` + router-hitchhike `Timer`, the per-tick lock/flush bracket (one POST per tick), and the page-visibility gate (HIDDEN unregisters the Timer). You supply a `build({ interpreter, tee })` that adds only the dashboard-specific nodes.
- **`addSliceFetcher`** (`src/shared/helpers/addSliceFetcher.js`) — wires ONE slice in one call: `Fetcher → target` plus a `receiver` `Tee → [transform →] view` and back to the Fetcher, which settles the ask. An independent reply path per slice. Call it once per slice inside `build`.

Consumer dashboards live in their own `src/` trees (the substrate's own are `src/event-dashboards/`, `src/event-aggregator/`, `src/topology-console/`, `src/debug-overlay/`); the shared spine stays in `newspack-nodes/src/shared/`.

## Red flags — STOP, you're building a god object

- A view node that receives the whole model and `setState`s it. Split it into Fetcher → Tee → transforms → per-widget views.
- A server command that returns `{everythingTheDashboardNeeds}`. Split it into small verbs, one Fetcher per slice.
- A dashboard node sitting at **counter 0** in the console: nothing flows through it, so it is dead, not composed.
- "I'll just `useDashboardGraph` + one view + one `poll` command" — that IS the god pattern, the shortcut that produced every current god-object dashboard.
- Nothing on the canvas you could drop a `Tee` into, or that the overlay would show moving: there is no graph.
- **An op-id, a Promise registry, or `KEY` used to match a reply to its request.** The reply is ALREADY addressed: a node mints its command with `FROM = <its own name>` and the server replies `TO = FROM`, so it lands on that node and `fill()` handles it. `makeOpId` / `PendingReplies` / `view.replies.add( id, resolve, reject )` / a Promise-returning `send()` all re-implement routing that already happened.
- **"I batch N verbs in one tick, so I need to tell the replies apart."** No — you have ONE node doing N jobs. Make it N nodes, one per concern (`slices.forEach( addSliceFetcher )`, or two Poller nodes as `RuntimeView` does). Batching is orthogonal: `HttpOut`'s lock/flush puts the whole tick in one POST however many nodes minted into it. Demux is a problem you invented.

## Security Risks
- A node that sends whatever command its incoming message carries is a `Shell` (Shells *send* commands; interpreters interpret them), and a named shell is dangerous: a maliciously routed message could execute arbitrary commands. Configure the command on the node (the `Fetcher` pattern) and treat the message as a trigger only. Route through `_shell` (a `Tap`) to watch sends.

## Required background

`nodes-review` gate #8d (everything sinks into the interpreter; flow via `target`/`TO`/invoke). The Tachikoma batching principle: the tick hitchhike means more fetchers cost the same one POST. Pair with the dashboard leg of the `docs/` tutorial track (see `docs/README.md`): `writing-a-dashboard.md` → `writing-a-real-dashboard.md` (the worked Publisher Insights rebuild) → `writing-a-view-node.md` (the thin per-widget view node).
