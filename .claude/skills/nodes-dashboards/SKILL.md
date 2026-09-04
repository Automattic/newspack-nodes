---
name: nodes-dashboards
description: Use when building or changing a dashboard / inspector / panel on the newspack-nodes substrate (topology console, debug overlay, event & performance dashboards, or a consumer plugin's dashboard) — especially before writing a "view node" that receives a whole model, or a server command that computes everything.
---

# Dashboards Are Node Graphs, Not God Objects

A dashboard's data flow is a **real node graph with message traffic at every edge** — composable, introspectable, reusable — like any worker pipeline. One *view node* that takes a finished model from one server command and hands it to React is not a Nodes dashboard; it is a React app with a dead node stapled on. The Inspector's Throughput panel says so: the counter never moves and the byte totals stay at zero, so nothing is inspectable and nothing is reusable.

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
                                ═══ server graph ═══                │
                              (small verbs / nodes, NO god command) │
                                                                    │
       ┌────────────────────────────────────────────────────────────┘
       ▼
       countsIn (Tee) ─> counts-view-node ─> <CountsWidget/>
       topIn    (Tee) ─> transform ─> top-view-node ─> <TopTableWidget/>
```

- **`Timer`** ticks the poll and **hitchhikes** the router tick, so every command emitted on a tick — and every response — **batches into ONE HTTP round-trip**. The **Router** owns that bracket, not the dashboard: `RouterNode.fireCb()` calls `_http.lock()`, notifies every TIMER registrant, and flushes in a `finally`, so the whole tick leaves as one `postBatch`. **Fan-out is free: ten fetchers, one request.** A mount that opened a bracket of its own would cost that tick a second POST.
- **`Fetcher`** (generic, reusable, registered under the name `Fetcher`): args = `<receiver> <command> [<command_args>…]`. Apart from a reply, its `fill()` ignores the payload — any other message is only the **trigger** to emit *its configured* command with `FROM` = its receiver. A trigger mints ONE ask and mints nothing more while any ask stands: the ask goes on the Fetcher's `outbox` when sent and leaves when the reply settles it, so a fast refresh on a slow verb asks once and waits rather than stacking identical commands. `retry_after_s` (15 seconds) re-asks an answer that never came; `0` disables that re-ask, which is what a WRITE wants, because an unanswered write may already have applied. An ask standing for 120 seconds is retired outright, so a lost reply costs one slow refresh rather than a dead widget. Configure the command on the node, **never read it from the triggering message**: a node that sends whatever command its message carries IS a `Shell`, and a named, always-firing Shell wired into the graph is verboten (see Security Risks). Target **`_shell/_http/<ci>`**, not `_http/<ci>` directly — `_shell` is an observe-only **`Tap`** on the command-send path, so `connect _shell` watches every outgoing command without touching the graph, and skipping it is silent. Compose the path with `egressPath( ci )` rather than by hand.
- **Receiver = a `Tee`**: the reply routes back `TO` = the fetcher's receiver, and the `Tee` fans it to transforms, to the per-widget view node, and last of all back to the Fetcher, which settles the ask.
- **Transforms** are small nodes on the receiver→view edge (rank, count, filter, join) — each consumes and emits, so the work sits *on the graph*, inspectable and composable rather than buried in a view. `WorkerStatusTransformNode` is the shipped example, joining a `dump_graph` snapshot on the `workerstatus:in → workerstatus:view` edge.
- **View nodes** are thin: each holds one widget's slice and publishes it with `setState( 'view', … )` for a small React component (`useNodeState`).
- **Server side decomposes too** — small verbs or a server-side graph, one Fetcher per slice; never one verb that returns everything. `Service_CI_Node::slice_verb()` is the builder for a CI that genuinely splits. A verb whose sections must come from one atomic snapshot (`dump_graph`) legitimately stays one verb and is fanned to one transform on the client.

## Why (what a god object forfeits)

Traffic at every edge is the point: **`connect <node>` or drop a `Tee`** to inspect any stage, the **debug overlay** shows the counters move, and the nodes (`Fetcher`, `Tee`, a transform) are **reused across dashboards** rather than re-implemented per page. A god view-node plus a god command forfeits all of it, and is undebuggable precisely because nothing flows.

Go and look before you claim a graph works. `?nodes-debug=1` opens the overlay gate and sticks it in `localStorage`; **Ctrl+`** then toggles the panel, which draws the page's own live `Core.nodes` — every Fetcher, Tee and view at its real counter, climbing on each tick.

## Reusable primitives

Don't hand-wire the spine — the substrate ships it. `mountExospine()` (`src/runtime/exospine.js`) clips your graph onto the `_command_interpreter → _router` backbone and hands back the five backbone nodes — `interpreter`, `router`, `shell` (`_shell`), `http` (`_http`), `heartbeat` (`_heartbeat`) — plus a `reinit()` and the `teardown()` your effect must call. Everything below sits on top of it.

Three aliases carry the substrate into a dashboard, all three resolved by the one `src/build-kit/alias-map.cjs` that esbuild and jest share. `@newspack-nodes/runtime` is the node-graph barrel — `Core`, `Node`, the `Message` constants, `mountExospine`, the React bridge, and every node class a consumer subclasses or hands to `makeNode`. `@newspack-nodes/debug-overlay` is the overlay component a dashboard mounts dormant. `@newspack-nodes/shared/<subpath>` is everything in the tables below; `shared` has no barrel file, so every import names its subpath.

**The poll spine** — a dashboard that asks on a cadence.

| Primitive | Subpath | What it owns |
|---|---|---|
| `useBatchedPoll` | `hooks/useBatchedPoll` | The exospine mount, the fan-out `Tee`, the router-hitchhike `Timer`, the page-visibility gate, the first-load and unsigned-tick retries. You supply `build( { interpreter, tee } )` and nothing else. `paused` suspends an open surface, `enabled: false` costs a never-opened one nothing at all, and `passenger: true` clips onto a backbone another mount owns. |
| `addSliceFetcher` | `helpers/addSliceFetcher` | ONE slice in one call: `Fetcher → target`, a receiver `Tee → [transform →] view`, and the edge back to the Fetcher that settles the ask. Call it once per slice inside `build`. Its `argsFn` is a fire-time getter assigned to the Fetcher's `command_args`, so a filter, a sort or a page value reaches the wire without re-wiring the graph; a `null` return sends nothing that tick. |
| `egressPath` | `helpers/egressPath` | `_shell/_http/<ci>`, or a bare `_shell/_http` for a command-interpreter builtin such as `taillog`. |
| `useCatalogSlice` | `hooks/useBatchedPoll` | One CI's `list` verb as a slice, plus `loading`, `error` and `refresh()`. Default cadence 30 seconds — the tick IS the retry, so a refusal recovers with no latch and no memoised promise. |
| `useCommandOnce` | `hooks/useCommandOnce` | One verb sent once per `run( args )`, parked in the Fetcher's outbox and riding the same batch. `onDone` registers on the result node, so it runs once per reply rather than once per render, and `subjectOf` names what each send is ABOUT so the answer comes back carrying it. |
| `useRouterTick` | `hooks/useRouterTick` | "Call me on the router heartbeat" for any React poller, as a passenger on a backbone somebody else owns. `intervalMs` defaults to 0, which fires on every Router tick; a sub-second value takes a `setInterval` slot of its own but stays a graph node `list_timers` can see. |

`useBatchedPoll` returns `{ interpreterRef, pollNow }`. `pollNow()` marks this poll due and runs the Router's tick, which is how a filter change refreshes off-cadence; rebuilding a lock/flush bracket around hand-sent copies of the same verbs re-implements that one line.

`intervalMs` is **required and at least 1000 ms**; a lower value throws a `TypeError` naming the timer. That floor is `TimerNode`'s own hitchhike threshold — a sub-second timer takes its own `setInterval` slot outside the Router's bracket, which is one POST per slice per tick and no batch at all. Exactly 1000 rides every tick; above it the Timer throttles against the shared wall-clock grid ([ADR-17](../../../docs/architecture-decisions.md#adr-17-timers-fire-on-a-shared-wall-clock-grid)), so two surfaces on one cadence meet on the same tick and share the POST.

A readout that needs no React hook at all takes a **`Poller`** instead: it rides the tick, mints its configured verb, and publishes the answer on `reply` for `useNodeState`, with a subclass supplying `publish()` — `Uptime` keeps the elapsed run, `Dmesg` tallies a stderr tail. Its default cadence is 10 seconds, deliberately slow, because a poll reply carries a whole row list rather than a delta. `Poller` is registered in `includeNodes` but not exported on the runtime alias, so reach it as `interpreter.makeNode( 'Poller', name )` rather than by import.

**The stream spine** — a dashboard that follows a log over SSE.

| Primitive | Subpath | What it owns |
|---|---|---|
| `useStreamGraph` | `hooks/useStreamGraph` | The three nodes every SSE dashboard is made of — `<prefix>:link` (`RemoteLink`), `<prefix>:stream` (a pass-through `Tee` the overlay taps), `<prefix>:view` — plus when the stream is open and where it reopens. Pause takes the same close path as the visibility gate, so pausing frees the bounded server slot. |
| `LogStreamViewNode` | `nodes/log-stream-view-node` | The base of every log-stream view: the O(1) newest-first ring (default cap 100 000 rows), the paused belt and step budget, the decaying `lps` readout, seek tracking, and the `pause` / `step` / `connection` / `browse` / `follow` / `clear` / `filter` / `select` controls. Subclasses implement `shapeRow( message )` and extend `_control()` / `viewModel()`. |
| `useLogCatalog` | `hooks/useStreamGraph` | The catalog a subscription is chosen from, polled as a `passenger` slice every 10 seconds. |
| `useSteppedRead` | `hooks/useStreamGraph` | The paused single step: one record over the command channel, admitted through the view's paused belt. |
| `useSegmentBrowse`, `useLogPositions`, `useLogStatusSegments` | `hooks/useLogPositions` | The browse rail and the SSE `positions` seed each control selects. A seek needs no transport of its own. |
| `SeekTracker`, `browseControl` | `nodes/seekTracker` | The segment breadcrumbs and the replay-caught-up-to-live flip, both derived from each record's `segment:offset:length` ID. `LogStreamViewNode` owns one; a subclass never re-derives them. |
| `RateSmoother` | `rateSmoother` | The windowed average plus EMA behind every per-second readout, so an idle rate decays to zero instead of freezing at its last burst. |
| `LogStreamViewer`, `LogRowList`, `LogBrowser`, `LogListHeader` | `components/…` | The chrome, the ring-aware DOM virtualization, the segment rail and the column header. |
| `useDeepLinkedSelection` | `hooks/useDeepLinkedSelection` | The `?param=` contract for a picker: seed the selection from the URL once, on the first non-empty catalog, then reflect every pick back. |

**View nodes** — where a reply becomes a render model.

- **`sliceView( { empty, parse, json, description } )`** (`nodes/slice-view-node`) is the default: a view whose whole content is an empty-model literal and a guard-then-map parse is a DECLARATION, not a class. `registerSliceViews( views )` declares a bundle's views, registers the names, and returns the classes — hand `addSliceFetcher` the CLASS when a hub tab builds through another bundle's interpreter, because `includeNodes` is a per-bundle static ([ADR-16](../../../docs/architecture-decisions.md#adr-16-js-node-class-resolution--names-are-the-tsl-surface-classes-are-the-api)).
- **`SliceViewNode`** is the base to subclass only when a view owns more than its slice — its own `fill()`, a timer, a teardown. Neither failure mode blanks the widget: a TM_ERROR keeps the slice on screen and adds `error`, and an unparseable payload keeps the prior slice.
- **`CommandResultNode`** (`nodes/command-result-node`) is its deliberate opposite, and where a one-shot's reply lands: EVERY reply publishes on `result`, refusals included, because a caller is waiting on the answer.
- **`CatalogListViewNode`** (`nodes/catalog-list-view-node`) is a `sliceView()` declaration holding a picker's rows under `items`, and `useLogCatalog` is its only builder.
- **`controlMsg` / `isControl`** (`helpers/controlMsg`) are the one control minter and its recognizer. A control is recognised by WHO SENT IT — the view's `controlFrom`, which `addSliceFetcher` assigns — never by what its payload looks like. A view declaring no `controlFrom` takes no controls, and `controlMsg()` throws rather than stamp an origin nothing trusts.
- **`HookNode` (a predicate gate) and `CallbackNode` (an inline closure)** ship on `@newspack-nodes/runtime`, but each takes its closure as a REQUIRED constructor argument and neither appears in `includeNodes`. `makeNode` instantiates with a bare `new NodeClass()`, so no TSL line, no palette entry and no `addSliceFetcher` `transform` slot can build one — import the class and construct it yourself.

**The React bridge** (`@newspack-nodes/runtime`) is how a component reads what a node publishes. Every hook addresses a node by NAME and re-resolves it, because the graph is rebuilt underneath the React tree.

- **`useNodeState( name, event )`** returns the LATEST cached payload. A burst of notifications inside one React batch costs one re-render, so this is the rendering half; a widget reads its own slice here and owns its own empty state.
- **`useNodeEvent( name, event, onNotify )`** runs once per NOTIFY. Anything that ACTS on each publication — rather than rendering the last one — registers here, or two replies in one batch collapse into one.
- **`useNodeFill( name )`** returns a stable callback that fills a message into the named node, resolving the name at call time so it survives a rebuild and drops the message while nothing holds it. The console sends a typed REPL line into `_command_interpreter` through it. A `controlMsg()` goes to the view instance instead, which is what `useStreamGraph`'s `control()` does.
- **`useGraphGeneration()`** re-renders on Core's full-rebuild signal, and re-runs a graph-building effect when it sits in that effect's deps.

**The presentation layer** — shared so that no two surfaces disagree about what a byte count, a rate or a status color reads as. Reach for these before writing a chart, a table or a dialog.

| Primitive | Subpath | What it owns |
|---|---|---|
| `useTimeChart`, `openFrame`, `drawAxes`, `drawLegend`, `setupTooltip` | `hooks/useTimeChart` | The one d3 frame every time chart is drawn on: one set of margins, one tick style, one hover behaviour. A caller owns its marks and nothing else. |
| `useVirtualization` | `hooks/useVirtualization` | The row window for a long list, plus the spacer heights that keep the scrollbar honest, measured against whichever element actually scrolls. |
| `useColumnPicker`, `gridTemplate`, `ColumnPicker` | `hooks/useColumnPicker`, `components/ColumnPicker` | A table's visible column set, its persisted selection, and the CSS grid track list that lays it out. |
| `usePersistedState`, `usePersistedChoice` | `hooks/usePersistedState` | A preference that outlives the page: read, validate against what the UI still offers, fall back, write back. The codec is the caller's. |
| `usePageVisibility` | `hooks/usePageVisibility` | The one read of tab visibility every poller gates on. A hidden tab's timers are throttled rather than stopped, so ignoring it polls at a degraded, jittery cadence. |
| `useContainerRefit` | `hooks/useContainerRefit` | A debounced re-run when an element's box changes, with a window fallback where `ResizeObserver` is missing. Every chart and canvas refits through it. |
| `useDismissable`, `Modal` | `hooks/useDismissable`, `components/Modal` | ESC and click-outside, and the plain-DOM dialog shell carrying the canonical `.newspack-nodes-modal` role. |
| `HeaderSlot`, `ConnectionBanner` | `components/…` | Portalling a dashboard's own controls into its host's header, and the reconnect banner. |
| `useAskPicker`, `useAdminMenuWidth` | `hooks/…` | Ask-about-this-element picking off one `data-ask` attribute, and the admin-menu width a fixed-position UI needs as a number. |
| `formatters`, `formatUtils`, `axis-ticks` | `utils/…` | Byte sizes, byte and message rates, compact counts, elapsed age, consumer ETA, status and duration colors, and axis ticks. |
| `errorMessage`, `answerStatus` | `errorMessage`, `utils/answerStatus` | The readable text behind a TM_ERROR reply, and an answer rendered as the working / failed / succeeded line a row shows. |
| `theme`, `buttonClass` | `theme`, `utils/buttonClass` | The single `theme-<slug>` class on `<html>` that re-skins every surface at once, and the canonical confirm-button class list the style-ownership test requires. |
| `storage`, `queryParams`, `fnv1a`, `parseOffsetJump` | `utils/…` | `localStorage` without a try/catch per call site, `?param=` reads and writes that preserve every other param, the hash, and the offset-jump parser. |

**Where it mounts.** A substrate dashboard ships as a DevTools tab: `registerDevtoolsTab( descriptor )` (`devtools/tabRegistry`), rendered by `DevtoolsTabHost` on the hub page, the debug overlay, or both. The descriptor requires `id`, `label` and `component`, and a `host` of `overlay`, `hub` or `both`; `order` (ties broken alphabetically by label), `slug` (the `?tab=` deep link, defaulting to the id), `param` (a query param the tab owns, which the host clears while another tab is active), `gate` (a predicate excluding the tab), `icon` and `fullBleed` are optional. Registering an id again SHADOWS whatever held it, which is what lets a lazy tab register a placeholder carrying the same descriptor object — label, slug and order resolve before the bundle loads, and the arriving bundle swaps in the live component rather than adding a second tab beside it.

Consumer dashboards live in their own `src/` trees. The substrate's own are `src/event-dashboards/`, `src/topology-console/`, `src/event-aggregator/`, `src/vault/`, `src/sessions/`, `src/devtools-hub/` and `src/debug-overlay/`; the shared spine stays in `newspack-nodes/src/shared/`, and there is never a per-plugin `src/shared/`.

## Red flags — STOP, you're building a god object

- A view node that receives the whole model and `setState`s it. Split it into Fetcher → Tee → transforms → per-widget views.
- A server command that returns `{everythingTheDashboardNeeds}`. Split it into small verbs, one Fetcher per slice.
- A dashboard node whose console counter never moves: nothing flows through it, so it is dead, not composed.
- "I'll just mount one view node and fire one `poll` command" — that IS the god pattern, the convenience that produced every god-object dashboard.
- Nothing on the canvas you could drop a `Tee` into, or that the overlay would show moving: there is no graph.
- **An op-id, a Promise registry, or `KEY` used to match a reply to its request.** The reply is ALREADY addressed: a node mints its command with `FROM = <its own name>` and the server replies `TO = FROM`, so it lands on that node and `fill()` handles it. An id minted into `message[ID]`, a `{ resolve, reject }` map keyed by it, or a Promise-returning `send()` all re-implement routing that already happened. A subject the answer must name rides on FROM as `<receiver>/<subject>` and comes back as the reply's remaining TO.
- **"I batch N verbs in one tick, so I need to tell the replies apart."** No — you have ONE node doing N jobs. Make it N nodes, one per concern — one `addSliceFetcher` call per slice, or the two `Poller` nodes `RuntimeView` mounts for `list_timers` and `list_handles`. Batching is orthogonal: the Router's lock/flush puts the whole tick in one POST however many nodes minted into it. Demux is a problem you invented.

## Security Risks

A node that sends whatever command its incoming message carries is a `Shell` (Shells *send* commands; interpreters interpret them), and a named shell is dangerous: a maliciously routed message could execute arbitrary commands. Configure the command on the node (the `Fetcher` pattern) and treat the message as a trigger only. Route through `_shell` (a `Tap`) so every send is watchable.

## Required background

`nodes-review` gate #8d — everything sinks into the interpreter, and flow is steered by `target` / `TO`, never by a bespoke `sink` chain. The Tachikoma batching principle: the tick hitchhike means more fetchers cost the same one POST. Pair with the dashboard leg of the tutorial track (see [`docs/README.md`](../../../docs/README.md)): [`writing-a-dashboard.md`](../../../docs/writing-a-dashboard.md) → [`writing-a-real-dashboard.md`](../../../docs/writing-a-real-dashboard.md) (the worked Publisher Insights rebuild) → [`writing-a-view-node.md`](../../../docs/writing-a-view-node.md) (the thin per-widget view node).
