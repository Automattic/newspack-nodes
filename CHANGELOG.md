# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

- **The debug overlay builds its graph BEFORE it renders the canvas (Phase 1.1) — the fast open-and-type race is fixed at the source, not at dispatch.** The panel now mounts as a separate open-gated subtree (`DebugPanel`) only while open, and `useDebugRepl` constructs its infra (`_output` Dumper + `_completion`/`_metadata`/`_cwd` via the interpreter's `makeNode`) in a `useState` lazy-initializer that runs render-phase — before the canvas paints and auto-layouts — binding `shell.sink` to the always-present interpreter as part of that build. No `useEffect` creates the overlay's graph nodes anymore, and there is no separate `shell.sink` bind effect in `DebugOverlay`. This removes the dispatch-time `shell.sink = Core.node(...)` resolve band-aid from both `useDebugRepl.dispatchStatement` and `useDebugGraph.sendVerb` (the prior fix in this changelog): with the graph built before render, `shell.sink` is bound before any typed line or gesture can dispatch. The genuine-absence canary (`Core.stderr('… no command interpreter …')`) is kept for the case where the page truly has no interpreter, and the build is idempotent under React StrictMode's double-invoked initializer. Behavior-preserving (REPL, completion, inspector, palette drop, Reset Graph unchanged) — only the build timing changed. Full JS suite green.
- **make_node-discipline foundations (Phase 0).** Groundwork for routing all non-backbone node creation through the interpreter and building the overlay graph before render: (1) `Command_Interpreter_Node` (JS) gains a public `makeNode( type, name, args )` — the `make_node` verb delegates to it — plus a `registerNodeClasses()` extension point and registration of the substrate classes (`Dumper`/`Completion`/`Metadata`/`Uptime`/`SseIn`/`HttpOut`/`Heartbeat`) into `includeNodes`, so the graph can be constructed through the interpreter rather than bare `new`. (2) `Shell` / `Shell_Node` are forcibly unnamed — `setName()`/`name()` throws (the Shell is the REPL front-end, never a graph node). (3) `removeNode()` / `remove_node()` now clear the `patron` back-pointer, so a removed sibling no longer keeps its owner alive (closing the Partition↔`:config`-CI cycle). (4) a new `useNodeGraph()` hook builds the graph in a `useState` lazy-initializer (before render, not a `useEffect`), with `mountExospine` made idempotent under React StrictMode. Behavior-preserving except the now-fatal Shell naming and the patron teardown. Full JS suite + substrate PHPUnit green.
- **Topology console + debug overlay de-duplicated onto a shared core.** The two surfaces were parallel copies of the same canvas/REPL machinery; the shared middle is now extracted into reusable units — `useGraphSource` (the metadata‖`coreToGraph` graph source), `dispatchLocalCommand` (the REPL `clear`/`echo`/`status`/`debug_level`/`show_parse` block), `useCompletion`, `useGraphHandlers` (connect/remove/disconnect/send/trace/invoke/drop, with the `is_interpreter`→target logic living once), and `usePanelChrome` (theme + palette persistence) — which both the overlay and the full console adopt. The shared presentational surface (the `Header` + ready-gated `GraphView` + `ReplFooter`) is likewise extracted into a `<ConsoleShell>` component both render; the console keeps its edit toolbar, topology picker, and modals as siblings (no edit-mode concern leaks into the shell). The console's worker-pivot/SSE/edit extras travel as injected params with overlay-safe defaults (`coreFallback`, `skip`, `prefix`/`replyFrom`, `sseGuard`, `paletteKey`), so the shared code is a superset-by-parameter, not a lossy merge. `TopologyConsole.js` shed ~490 lines and `useDebugGraph.js` ~150. Behavior-preserving, with two overlay-invoke inconsistencies fixed by the reconciliation onto the console's behavior: the overlay now honors `kind: 'request'` (emits a real `TM_REQUEST` to the node instead of a misrouted `TM_COMMAND` to its `:config` sibling) and honors the cwd prefix on `invoke` at a non-root Path-menu scope. Full JS suite green (1600 tests).
- **Canvas layout model rebuilt (debug overlay + topology console).** `SchematicCanvas` is now a pure renderer — it no longer runs `autoLayout` or seeds positions back up. A new `useCanvasLayout` hook owns the position map: it runs `autoLayout` exactly once when the complete graph is ready (or adopts a worker topology's server-saved layout), persists `{ positions, viewport, modified }` to one localStorage key, and from then on the stored map *is* the layout — `autoLayout` never re-runs except on Reset Layout. A newly-appeared node that the user didn't drop is positioned below the left-most-then-bottom-most node (`placeBelow`), written to storage, and marks the layout dirty (so Reset Layout appears). Both surfaces gate the canvas on a readiness signal so it only ever renders over the *complete* graph: the debug overlay waits for its own infra nodes to mount, then paints instantly from the in-process graph (`coreToGraph`) gated on a composite `replReady && graphHasNodes`; the topology console waits for the first `dump_metadata` payload (and, for a worker scope, the layout fetch — an untitled/new topology counts as resolved so its canvas renders). The console's "diverged from saved" check and Save Layout filter to the current graph's nodes, so a deleted node's stale position no longer surfaces false chips or gets written to the server. This removes the seed feedback loop (`onSeedLayout`), the dual `computeNodePositions`/`placeNewNode` placement paths, the `dirty`-via-seed flag, and the partial-graph race that left isolated nodes mis-placed (stacked in the left column) on a fresh open. `useDebugLayout` is deleted. Behavior-preserving for an existing saved layout; full JS suite green.
- **Service interpreters now take normal commands with arguments — the request-side command `payload` field is gone.** Every `*_CI` verb parses its input from the `arguments` string instead of a separate structured `payload` slot, so the request command VALUE on the wire is now `{ name, arguments }` (the response result still rides as `{ name, payload }`). A new `Command_Args` helper (PHP `Command_Args::parse`/`format`, JS `parseCommandArgs`/`formatCommandArgs`) is the single home for the Tachikoma argument grammar — required args positional, optional args `--key=value`, bare `--key` boolean flags, comma-separated lists, and double-quoted values with spaces — used by verbs to parse and by callers/forwarders to build, round-tripping through `parse`/`format`. `layouts save` / `topologies save` take their structured blob (positions JSON / `.tsl` body) as the rest-of-line after the name (`Service_CI::split_first_token`, preserving the body verbatim); `workers restart` takes `<type>… [--partition=<n>]`. The `Command_Auth` HMAC canonical drops the `payload` element (signer + verifier in lockstep). Behavior-preserving; full substrate suite green.
- **PHPStan raised to level 7.** Builds on the level-6 value-type work: the node registry is now `Node`-typed (`Core::register_node()`/`Core::node()` and `Event_Framework::set_timer()` take `Node`/`Timer_Node`, matching the "everything is a Node" contract), and the few unguarded builtin returns are made safe — `Message::packed()` guards `wp_json_encode()` (`false`→`''`), `Log_Node` stores a failed `fopen()` as `null`, `Router_Node::notify_timer()` only calls `fire_cb()` on a `Timer_Node` (the sole TIMER registrant), `Hook_Node::fill()` skips an empty hook name, `Supervisor`/`Tail_Node` int bounds are narrowed, and `preg_split()`/`filemtime()` results are coerced explicitly. Behavior-preserving; new tests cover the timer-dispatch and `fopen`-failure paths, and the now-moot duck-typed-registry test was retired. Full substrate suite green.
- **PHPStan raised to level 6.** The static-analysis gate now enforces value types on every iterable (`array<…>`), so all method/parameter/return/property arrays carry explicit shapes. Substrate-wide this is PHPDoc-only — the 7-field positional Message is documented as `array<int, mixed>`, `node_schema()` returns as `array<string, mixed>`, and WP-CLI handlers as `array<int, string>` / `array<string, mixed>`. No runtime behavior changes.

### Fixed

- **The REPL transcript wraps at whitespace, and tab-completion candidates align into columns.** Long transcript lines were breaking mid-word (`.topology-repl__entry` used `word-break: break-all`); they now wrap at whitespace (`overflow-wrap: anywhere`), only splitting a token when it alone can't fit. The second-Tab completion listing pads each candidate to a uniform width via a new `tabulateCandidates` helper — the panel-width-responsive in-browser equivalent of the interpreter's `tabulate()` (the PHP / Tachikoma `help` grid) — so candidates reflow into an aligned column grid instead of a ragged mid-word-wrapped line. Applies to both the debug overlay and the topology console.
- **The debug overlay's REPL now lists ambiguous tab-completion candidates on the second Tab.** `ReplFooter` does readline two-stage completion — the first Tab extends to the longest common prefix, a second consecutive Tab on an ambiguous token lists the candidates via an `onShowCandidates` callback. The debug overlay never wired that prop (the topology console does), so the second Tab was a silent no-op. The overlay now passes `handleShowCandidates`, printing the candidate set into the `_output` transcript. The `_output` Dumper also renders bare `TM_COMMAND` / `TM_REQUEST` messages as `recv` transcript entries. Adds a regression test.
- **Tab completion no longer dies after Reset Graph in the debug overlay.** `useDebugRepl` rebuilds `_completion` (and the other overlay infra nodes) on every graph-generation bump, but the post-rebuild re-render that re-binds sibling `useNodeState` subscriptions was gated on a boolean `mounted` flag — which flips `false→true` only on the first mount and no-ops on a rebuild. So after the first Reset Graph the candidates subscription stayed bound to the removed old `_completion` node and every Tab fired at a node nobody was listening to. Replaced the boolean with a remount counter that increments on every (re)mount, so `useNodeState` re-resolves the rebuilt node — fixing tab completion (and any other `useNodeState` consumer of an overlay-rebuilt node, e.g. the metadata canvas) after a reset. Adds a reinit regression test plus a node-level completion round-trip test.
- **The topology console no longer freezes for ~40s when leaving a large topology.** The canvas position memo's "saved-layout present" path called `placeNewNode` once per unplaced node, and `placeNewNode` scans every edge (O(E)) plus does an `Object.values(positions).some(...)` collision scan (O(positions)) per call — so a saved layout that didn't cover the current graph (e.g. a leave/reconnect transition) was O(N·E) of synchronous work and blocked the main thread for ~40s on the 3145-node `test` topology (CPU profile: one ~45s `placeNewNode` task). The logic is extracted to `computeNodePositions()`, which batches a flood of unplaced nodes (> 100) through a single `autoLayout` pass (≈35ms) while keeping pinned overrides; a few genuine newcomers still take the cheap incremental path. Adds a perf regression test over the real `test.tsl` (3145-node) fixture.
- **The debug overlay now logs the commandline in the transcript when you click a command in the Inspector (or use the canvas gestures).** The overlay's Inspector actions (`dump` / `tail` / `disconnect` / `send` / `trace` / `invoke`) and the connect / remove / `make_node`-drop gestures dispatched straight through `shell.sendCommand`, so only the *reply* landed in the transcript — the command itself was invisible, unlike a typed REPL line or the topology console (both echo a `sent` entry). Every overlay dispatch now routes through a `sendVerb` helper that appends the equivalent commandline to the `_output` Dumper before dispatching, matching `TopologyConsole.handleInspectorAction`. The echo is display-only; dispatch still uses the structured `sendCommand` args, so there's no re-parse/quoting risk.

## [0.10.2] - 2026-05-31

### Changed

- **`_metadata` poll cadence floor raised from 1s to 5s.** Small graphs now poll `dump_metadata` every 5 seconds instead of every second (`computePollIntervalMs` floors at 5000ms; the round-to-5s scaling above that is unchanged), cutting idle poll traffic for the common case. The Inspector's activity-window label widens to match (a small graph reads `last ~5m`).

### Fixed

- **The debug overlay's path menu no longer disappears when you `cd` into a remote scope (e.g. `/_http`).** The overlay built its `cd` path options from the polled `graph` (the current cwd's `dump_metadata`), so navigating into `/_http` made `graph` the remote scope, dropped the local `_http`/`_*` nodes, and collapsed `pathOptions` to `['']` — hiding the whole Path selector. It now reads the local `Core` registry, which always holds the navigable scopes regardless of cwd. (The topology console's path menu was unaffected — its options come from a stable topology list, not the scope graph.)

## [0.10.1] - 2026-05-31

### Fixed

- **SSE stream crash on a multi-partition subscription.** `/messages/stream` opens one `Consumer` per partition for a multi-partition log subscription (e.g. `gyroscope`, `completed`), but `run_stream_loop()` named them all after the subscription — so with `num_partitions > 1` the second `Consumer::name()` hit the v0.10.0 duplicate-name throw and fataled the entire stream (`node name collision: gyroscope already registered`, surfacing as `…:source already registered` once a child was created). Each Consumer now gets a distinct `{sub}:p{i}` node name; the partition the dashboard parses rides the message stamp/FROM, not the node name, so nothing downstream changes. (Single-partition subscriptions keep the bare `{sub}` name.)

## [0.10.0] - 2026-05-31

### Changed

- **The debug overlay and topology console now share ONE implementation of the Reset Graph / graph-dirty / chip logic — `useGraphReset` — instead of two drifting copies.** Both surfaces route every graph mutation through the Shell's new single `dispatch()` chokepoint (`sendCommand`, a parsed REPL line, and a GUI gesture all funnel through it), and the hook taps `Shell.onDispatch` to flip a structure-dirty flag whenever a graph-mutating verb (`make_node` / `connect_node` / `disconnect_node` / `remove_node` + their aliases) is sent — so the Reset Graph chip tracks edits identically whether they arrive from the canvas, the Inspector, or a typed command, on either surface. The chip surfaces on `structureDirty || hasUserNodes` (a rewire OR a surviving user node), and Reset Graph runs the same sequence everywhere: tear down every node → `Core.bumpGraphGeneration()` (rebuild off the canonical wiring) → keep the layout → `markDirty()` so Reset Layout resurfaces. To get there, `useConsoleGraph` now subscribes to the generation signal (`useGraphGeneration()` in its effect deps) and its bespoke `resetKey` prop was removed; the Shell stays verb-agnostic (it only announces a dispatch — the hook classifies). The overlay's per-handler dirtying wrappers (`onConnectDirtying` / `onRemoveNodeDirtying` / the disconnect dirtier) and the console's `resetLocalGraph` / `hasUserAddedLocalNodes` / `PROTECTED_NODE_NAMES` are gone, replaced by the one hook.
- **Browser "Reset Graph" now rebuilds the ENTIRE graph in place — every node, no exceptions — and a dashboard gets it for free with zero extra wiring.** The consumer contract stays one line: hand `mountExospine( build )` your build callback, keep the returned `teardown`, done — no generation/reset/rebuild plumbing leaks into the hook. Reset Graph removes every node then bumps a new `Core.graphGeneration` signal; `mountExospine` subscribes to that signal itself (unsubscribing on teardown) and, on a bump, tears down its backbone **and** build nodes and reconstructs both, re-running your build against the fresh backbone. The overlay's own infra (`_output`/`_metadata`/`_completion`/`_cwd`, in `useDebugRepl`) rebuilds off the same signal. The ordering is safe because `mountExospine`'s rebuild is a synchronous `Core` listener while the overlay's is an async React effect — so the fresh `_router` always exists before `_metadata` re-registers its TIMER onto it (no frozen canvas after a reset). New runtime API: `Core.bumpGraphGeneration()` / `Core.subscribeGraphGeneration()` and the `useGraphGeneration()` hook. The finer-grained `reinit()` (rebuild just the build nodes, keep the backbone — stashed on `Core.reinit`) is retained and, on dashboard surfaces, gates whether the overlay offers the Reset Graph chip (`canRebuild: !! reinit`); the topology console uses a bare `mountExospine()` (so `Core.reinit` stays null) and rebuilds off the `graphGeneration` signal instead, its chip gated on live-mode + local-scope by the shared `useGraphReset` hook above. Reset Graph also re-dirties the layout (`markDirty()`) so the Reset Layout chip resurfaces when the rebuild may have shifted the saved positions, and a node removal or disconnect (not just a connect) now dirties the graph so an exospine edit is both visible and recoverable in place. (`useDebugLayout` gained `markDirty()` earlier; the Raw Logs / Worker Status dashboard hooks build through `mountExospine( build )` and bump a render counter on each rebuild so a consumer's `useNodeState` re-subscribes to the freshly-rebuilt view node.)
- `Node::name()` now requires a non-empty name: `name(null)` / `name('')` throw (`use remove_node()` to unregister). A node is committed to its name until removal; renames are still allowed and a same-name call is an idempotent no-op. Sibling naming and collision checks moved to the protected `check_name_availability()` / `set_sibling_names()` template-method hooks; `has_value()` centralizes the Perl `length()` presence test (false on null/`''`, true on `'0'`). `Consumer_Node::arguments()` tears down its prior partition children before rebuilding, so reconfigure-in-place no longer collides on the `:source` / `:offsetlog` slots.
- **Removed the default-binary Partition index.** Without a `with_index()` formatter, `Partition_Node` no longer writes (or even opens) an `.idx` companion — the old 8-byte `(segment_id, offset)` binary sidecar is gone. Indexing is now opt-in and always JSONL: `with_index($formatter)` records one JSONL entry per write, `scan_index()` walks those entries (a no-op when no formatter is set), and `read_at()` seeks. The lone consumer of the default binary index (the application's dead `Events_CI::recent` verb) was removed alongside it.
- Node subclasses now carry a `_Node` suffix with matching `class-*-node.php` / `*-node.js` filenames (shell / `make_node` names unchanged).
- The command interpreter is spelled `interpreter` throughout (variables, node-name literals, comments, docs); service-CI `*_CI_Node` identifiers keep `CI`. `mountExospine()` now returns `{ interpreter, router, teardown }`.
- JS nodes declare `accepts_fill` / `has_target` in `nodeSchema()` and `useJsCatalog` propagates them to the palette (and filters `CommandInterpreter` out of the overlay palette); PHP `Dumper_Node` / `HTTP_In_Node` declare `has_target: false`.
- Inlined `SSE_Stream_Trait` into `SSE_Out_Node` and deleted `includes/rest/trait-sse-stream.php`; the trait had a single remaining consumer. Removed the dead `stream_permissions_check()` (the route uses an inline `permission_callback`).
- **Removed every `eslint-disable` directive from the JS; the code now lints clean without suppressions.** Most were stale (no-ops under the current `@wordpress/eslint-plugin` test-unit override) and were deleted outright. `no-bitwise` is turned off in `.eslintrc.js` — the 7-field Message `TYPE` is a bitmask (Tachikoma convention), so `&`/`|` on it are idiomatic, not a smell. `no-console` now allows `warn`/`error` (the runtime's stderr sink is the browser console) while still flagging stray `console.log`; `no-unused-vars` honors the `^_` unused-arg convention; a `scripts/**/*.mjs` override gives build scripts Node globals + console.
- **The topology console's `autoLayout` was rewritten to a force-layered algorithm** — DAG-depth columns, barycenter crossing-reduction, canvas-anchored midpoint row "springs", and a barycenter-preserving (pool-adjacent-violators) de-overlap — and made **independent of node registration order** (nodes are alphabetically canonicalized), so the same graph lays out identically whether the runtime hands them over backbone-first or a topology file lists them alphabetically. Validated against the performance-dashboard, firehose-worker, and matching/root graphs under node + edge permutations; ~38 ms on a 3145-node topology.
- **`SchematicCanvas` culls for the viewport:** nodes and edges outside the viewBox aren't rendered, and below a readable scale (the smaller of the width/height fit ratios under `preserveAspectRatio="meet"`) cards drop their detail (labels, sparkline, ports → a bare rect). A 3145-node graph goes from ~44k DOM nodes / 31k `<text>` to ~4.7k / 0 `<text>` when zoomed out, ~860 DOM when zoomed in.
- **Wheel zoom is scale-space + canvas-aspect** with an absolute zoom-in cap, so a tall-narrow graph can be zoomed in far enough to read individual cards (the old clamp keyed on the whole-graph-fit width and never crossed readability on a tall graph).
- **The canvas measures itself via `ResizeObserver` and the viewport cull gained more LOD tiers, so a multi-thousand-node graph stays light at every zoom.** Nodes are culled to the true on-screen world region — the viewBox expanded to the canvas aspect under `preserveAspectRatio="meet"`, so a letterboxed tall-narrow graph isn't culled into its own thin strip — plus a half-viewport overscan band on each axis (`NODE_OVERSCAN`); together these keep panning smooth and stop a narrow column blinking out the moment it's nudged sideways (the old strict raw-viewBox cull dropped the whole column the instant it crossed the viewBox edge, even though it was still visible in the letterbox margin). An edge is culled only when BOTH endpoints are off-screen (`isEdgeVisible`); one visible endpoint is enough, so an edge to/from an in-view node always draws even when its peer scrolled off — and a one-endpoint-visible edge is **truncated** to a straight stub at the viewport boundary (`clipSegmentExit`) instead of a giant bezier whose control points balloon out to the off-screen peer, so a zoomed-in hub with many off-screen connections paints short stubs the browser can flatten cheaply rather than long off-screen curves. The whole edge layer LODs away at the **same** readable scale as the node labels (`showDetail`) — you can't trace an edge in the overview anyway, and that drops ~2.8k paths in one step with the text. Each bare node also has a minimum on-screen size (`MIN_NODE_PX`): at extreme zoom-out the rect is enlarged in world units so it never shrinks to a sub-pixel that some browsers (Firefox) drop, and the bare LOD rect is filled with a strong ink (`--ink-2`) instead of the near-background `--paper-2` so zoomed-out nodes read with real contrast. The canvas size feeding the cull comes from a `ResizeObserver` on the SVG rather than a one-shot mount read, so a panel resize re-fits and re-culls instead of measuring against a stale size.
- **The `dump_metadata` poll self-throttles to graph size instead of hammering once a second.** `MetadataNode` stays bound to the shared `_router` TIMER (so its poll still batches into the same tick as the heartbeat/uptime requests) but now self-gates on its own `interval_ms` = `nodeCount × 10`ms, rounded to the nearest second (nearest 5s past 5s, floored at 1s) and recomputed from each reply's node count — a 3145-node graph polls every ~30s instead of every 1s, while small dashboards stay at 1s. A `cd` to another pivot re-polls immediately via a `lastPath` check, so navigation stays snappy. The per-node rate is already normalized by real elapsed time (`dCount/dTime`) so it's unaffected; the Inspector's Activity label now reports the true trailing window (`last ~60s` → `last ~30m` on a big graph) instead of a fixed minute.

### Fixed

- **Three Reset Graph / chip inconsistencies between the topology console and the debug overlay, resolved by unifying both onto `useGraphReset`.** (1) Topology console — a live drag-rewire (changing a connection between two endpoints) now surfaces the Reset Graph chip; the gate was node-only before, so a pure rewire produced no chip. (2) Topology console — Reset Graph no longer wipes the layout (which yanked the canvas into a re-autofit shift) and no longer leaves you with no way to recover: it keeps the layout and `markDirty()`s it so the Reset Layout chip resurfaces, matching the overlay. (3) Debug overlay — a `connect_node` typed in the REPL now dirties the graph like a canvas rewire; the old per-handler dirtying only saw GUI gestures, so a REPL rewire silently produced no chip.
- **Wheel-zoom over the canvas no longer scrolls the page behind it** (and Chrome/Firefox stop logging "Unable to preventDefault inside passive event listener invocation"). React's `onWheel` is a passive listener, so the zoom handler's `preventDefault()` was ignored — Safari honored that strictly and scrolled the page underneath while still zooming. The zoom listener is now attached via a non-passive `addEventListener( 'wheel', …, { passive: false } )` (the same pattern `DebugOverlay` already uses), so `preventDefault()` takes effect.
- **The debug overlay pins the page behind it while the pointer is inside the panel.** Safari ignores the canvas wheel's `preventDefault` when the event target is the SVG canvas (it honours it from an HTML listener but not the svg), so wheel-zooming the overlay's graph still scrolled the host page in Safari. The overlay now physically locks the page from scrolling on pointer-enter and restores it on leave/close — `overflow: hidden` on BOTH `<html>` and `<body>` (Chrome's scroller is `<html>`, but Safari ignores `<html>` alone and keeps scrolling `<body>`), scrollbar-gutter-compensated so the page doesn't shift, with a panel callback-ref that releases the lock even if the panel unmounts while the pointer is inside. Inner scrollables (the transcript) and the graph zoom are unaffected; only the page behind is held still.
- **Wheel zoom from the autofit no longer flings the graph off-screen.** The cursor anchor used the cursor's *world fraction within the viewBox*, but on a letterboxed tall-narrow autofit the whole graph renders as a thin strip — so that fraction swung wildly with a 1–2px cursor move and threw the graph past the viewport on the very first zoom step (every direction). It now anchors on the cursor's *screen fraction* of the canvas, which is correct under letterbox and identical once the viewBox is canvas-aspect. Verified: the first zoom now lands the point under the cursor with 0px drift.
- Timer JS runtime gained the Router-hitchhike mode (no-arg `setTimer()` registers `TIMER` on `_router`) the PHP `Timer_Node` already had; `fire()` emits a `TM_BYTESTREAM` timestamp tick matching PHP.
- Timer JS `fire()` no longer double-counts `counter` (a divergence from PHP that inflated hitchhike-mode ticks 2×), and `setTimer()` re-arm now guards on `mode` + clears any live `setInterval` handle (fixes a leaked interval on same-mode re-arm).
- **Accessibility: dropped the `jsx-a11y` suppressions by making the elements genuinely accessible.** Modal/OpenTopologyModal backdrops are `role="presentation"` (decorative; ESC still dismisses). The REPL transcript resize handle is now a keyboard-operable `role="slider"` — ArrowUp/ArrowDown resize, `aria-orientation="vertical"` + `aria-valuemin/max/now` — instead of a non-interactive `separator` carrying mouse-only handlers; the transcript pane is `role="presentation"` (it delegates clicks to its children). The Inspector verb-checkbox label carries an `aria-label` so its accessible text is detectable.
- **React dependency arrays are now honest (no `react-hooks/exhaustive-deps` suppressions).** `ReplFooter`'s `setExpanded` is wrapped in `useCallback` (it was an unstable `onExpandedChange` wrapper, not a state setter); its document-listener and Tab-completion effects declare their real deps (the completion effect's new `value` dep fixes a latent stale read, guarded against re-fire by `pendingToken`/`seq`). `SchematicCanvas`'s window wire-drag listeners are `useCallback`s, `setViewport` is memoized, and the autofit-freeze effect reads a `nodes` ref so it stays keyed on `nodes.length`.
- **Destructive / data-entry actions use in-app modals instead of native dialogs (no `no-alert` suppressions).** `TopologyConsole`'s topology-delete now uses the existing `ConfirmModal`; the Inspector's "Send bytes" uses `PromptModal`. Confirm-to-proceed, cancel-aborts, and empty-input-doesn't-submit behavior is preserved.
- **`wp nodes cli` ignored all input.** `CLI_Stdin_Reader_Node` is a `Timer_Node`, and the no-sink guard now lives in `Timer_Node::fire_cb()` — but the reader had no sink, so the guard skipped its stdin-drain `fire()` entirely and the REPL never read a line. It now sinks into `_command_interpreter` (every node sinks into the interpreter; only `_router` has none), so `fire_cb()` reaches `fire()`. A new `fire_cb`-path test covers it (the suite previously only called `fire()` directly, masking the guard).
- **`Router_Node` generates `NOT_AVAILABLE` via a Tachikoma-style `send_error()`** — the error's `FROM` is the unreachable destination and its `TO` is the sender's FROM, re-routed back along the breadcrumb trail. Fixed an undefined `$node_name` in `send_error()` (it lived in `fill()`, not the extracted method) that cached `node => null` in the `NOT_AVAILABLE` state and emitted a PHP warning; it's now recomputed via `Message::split_first( $message[TO] )`.
- **The HTTP/SSE egress operates as `_output`**, so a browser's `dump_metadata`/`uptime` replies resolve instead of bouncing `NOT_AVAILABLE` through a pivoted `wp nodes cli`. `Core::stderr` now falls back `_repl ?? _sse ?? _output`, so an SSE process's own stderr broadcast (empty TO) reaches the `_sse` egress → the client, rather than being silently dropped by the pid-gating `_output` reply filter.
- **The topology canvas no longer piles up thousands of pending CSS animations on a large graph.** Each node carried a staggered entrance `animationDelay` of `index * 50ms` (each edge `200 + index * 80ms`); with ~3000 nodes that queued thousands of animations the browser tracks as "active" for up to ~2.5 minutes, and with `fill: both` it held high-index cards invisible for the whole delay — while panning restarted a fade on every node that crossed the viewport (cull churn). The staggers are gone and the entrance fade / edge marching-ants now gate on the same readable-scale `showDetail` flag (a `.is-static` class zeroes the animation), so the whole-graph overview runs the 2 header-LED pulses and nothing else, while a zoomed-in view animates only the handful of cards actually on screen.

## [0.9.1] - 2026-05-29

### Fixed

- **`/command` rate-limit gave a 429 to a steady 1 req/sec client after ~30s.** `HTTP_In_Node::check_rate_limit` kept a single per-user transient and re-set its 1-second TTL on every successful write, so a steady stream never let the bucket expire and the counter grew monotonically until it hit `RATE_LIMIT_BURST` (30) — even though no individual second contained more than one request. Switched to per-second buckets keyed by `${user_id}:${floor(microtime)}`: each clock-second is an independent counter, so a 1 req/sec client stays at count=1 in every bucket forever. Test-only `HTTP_In_Node::$clock_now_seam` lets the suite simulate 5× BURST seconds at 1 req/sec without sleeping.
- **`Inspector` reserved-node gating was too wide.** Live-mode + edit-mode hid Routing/Constructor/Verbs/rename/Delete/class-catalog verb buttons for every name in `reserved-node-names.json` (`_metadata`, `_http`, `_output`, `_uptime`, `_completion`, `_heartbeat`, `_cwd`, …). The original goal was just `_repl`, which is auto-mounted by the worker and not user-owned; the other spine nodes are inspectable / configurable. Narrowed `isReserved` to `node.reserved || node.id === '_repl'` and dropped the `reserved-node-names.json` import.

### Changed

- **`autoLayout` rewritten for fan-out symmetry.** Five-part overhaul that turns the layout from a column-shoved chain into a properly-paired graph for typical worker topologies:
  - **Source-only nodes pinned at col 0** — the existing forward-pull pass now skips nodes with no incoming edges, so `firehose:consumer` / `jobintake:consumer` don't drift right just because their downstream targets do.
  - **Sinks + isolated nodes cluster at maxDepth** — every node with no outgoing edges (terminal partitions AND the worker's auto-mounted `_repl` anchor) gets pushed to the rightmost column, eliminating the "scattered partitions" look when a fan-out reaches leaves at uneven natural depths.
  - **Pass 2 snap is HALF-row precision for fan-outs** — `Math.round(mean * 2) / 2`, so a source fanning to targets at rows 0+1 lands at 1.5 (the visual midpoint) instead of being forced onto an integer row. Single-target snap takes the exact target row to preserve straight pairs.
  - **Pass 3a re-snap is leaves-only** — middle nodes keep Pass 2's target-snap row; re-snapping them to predecessor rows pulled them AWAY from the midpoint of their fan-out. Fan-out leaves (single pred whose pred has multiple children) keep their Pass 1 alpha spread so they don't collapse onto the pred and cascade.
  - **Pass 3b (new) is right-to-left middle-node re-snap to FINAL target rows** — after Pass 3a's deconflict moved leaves around, Pass 2's pre-deconflict middle-node rows were stale. The actual repro: `completed:tee` in `firehose-workers-and-jobs` stayed at row 1 (mean of `completed:partition` row 0 and the STALE Pass-1 `gyroscope:partition` row 2), then `gyroscope:partition` shifted to row 1 via straightness, leaving the two on the same row. Re-snapping with finalized target rows puts `completed:tee` at the actual midpoint (row 0.5).

### Tests

- **5 new `autoLayout` cases**: local-Shell pairing (`_metadata-_cwd`, `_heartbeat-_http`, `_sse-_output`); sink + isolated cluster at maxDepth; source-only at col 0; multi-target fan-out near midpoint; exact-half-row precision for 2-target fan-outs; full `firehose-workers-and-jobs` repro asserting `completed:tee` sits at `(completed:partition + gyroscope:partition) / 2`.
- **2 new `HTTP_In_Node` cases**: steady 1 req/sec across 5× BURST seconds never 429s (the production complaint), plus a smoke test that the clock seam doesn't leak between tests.

## [0.9.0] - 2026-05-29

### Fixed

- **`CLI::live_position()` was reading a cache key nothing writes.** Promoted the cursor-cache key format to a shared `Consumer_Node::POSITION_KEY_PREFIX` + a `position_key($host, $source_base_dir, $partition)` helper. All three callers — Consumer's writer, Workers_CI's dashboard reader, and CLI's `wp nodes status` reader — now use the helper. Previously `wp nodes status` always missed the cache and fell through to the on-disk offsetlog, showing a stale "Behind" column for live workers while the dashboard's Workers_CI showed fresh values.
- **`Core::resolve_config_token` no longer silently returns `''`** for an unknown namespace OR a null/missing key. A typo in `<config:base_dir>` (vs `base_directory`) yielded empty string with zero diagnostic, silently corrupting paths. Now warns via `Core::stderr` for both cases; still returns `''` for back-compat.
- **`make_node` no longer silently drops object args.** `array_filter( $ctor_args, '\is_scalar' )` is correct (object deps aren't round-trippable through `arguments()`), but a caller who passes `$cli` positionally instead of as a public property got no diagnostic. Now emits a rate-limited stderr warning naming the node type + name when objects are filtered out.
- **Debug overlay REPL silently dropped wire commands on dashboards.** `DebugOverlay`'s `shell.sink` `useEffect` resolved `Core.node(COMMAND_INTERPRETER)` once with `[shell]` deps; if the dashboard's mount effect ordered after the overlay's first render, the lookup captured null and `shell.sink` stayed null forever. The `s.sink?.fill(parsed)` optional-chain in `useDebugRepl.dispatchStatement` then dropped every wire command without diagnostic — local builtins (echo, cd, status) worked but `ls`, `dump_node`, `connect_node`, etc. produced zero `/command` POSTs and zero feedback. Fix is two-part: (1) include the interpreter resolution in the effect deps so the bind re-fires when it appears later; (2) when `shell.sink` is null at dispatch the Array-branch surfaces a `Core.stderr` warning naming the dropped verb — `Core.stderr` (not `print_less_often`) so every occurrence is visible (this is a programmer-error class, not noise).

### Added

- **`/command` rate-limit per user** in `HTTP_In_Node`. `RATE_LIMIT_WINDOW_S = 1`, `RATE_LIMIT_BURST = 30` — ~6× the realistic dashboard peak (mount-time list fan-outs across classes/topologies/layouts/raw-logs/workers + REPL keystrokes). Configurable via `apply_filters( 'newspack_nodes/command_rate_limit', int $burst )` (floored at 1). Test-mode bypass via `public static HTTP_In_Node::$rate_limit_disabled` (closure-property test-seam pattern). Wired through a new `check_permission()` callback that runs `manage_options` FIRST, then rate-limit (so an unauthorized request gets a clean 401 vs. a 429). Mirrors `Spawn_Controller::check_rate_limit` shape with a counter-based rolling window instead of a single-timestamp cooldown.

### Changed

- **Raw Logs SSE chain collapsed to `_sse → rawlogs:view`.** The dashboard's `:route` was dead — it checked `KEY === 'connection'` but the substrate's `SseConnector` uses `KEY === 'connected'` AND snoops it off before routing, so the control-target branch was unreachable. The `:transform` did real shaping (extract partition from FROM, JSON-stringify object VALUE, prepend KEY, clip at 1000 chars), but the info was all in the envelope and could be inlined into the view's `fill()`. Both Nodes deleted (`rawLogsRoute.js`, `rawLogsTransform.js`, `transformLogLine.js` + tests). `useRawLogsGraph` now mounts just `_sse + _http + _heartbeat + rawlogs:view`. Same architectural mistake I made (not "inherited from a template") and that landed in v0.7.0/v0.8.0 — three sibling SSE dashboards in `newspack-event-logger-nodes` collapsed in lockstep.

### Tests

- **TopologyConsole de-flaked under parallel coverage.** `~/Documents/DN/bin/run-coverage`'s 3-way `partty` fan-out surfaced 2 flaky `reset-graph` tests and 25 act warnings per run. Three independent root causes fixed: (1) the auto-started Router 1s real-timer raced slow tests by replacing test-injected metadata with a fresh `dump_metadata` reply; the `useConsoleGraph` mock now stops the timer after the ctor's initial `_tick()`. (2) `fetchLayout`'s `.then` read `resp.positions` on a null mock-resolved response, threw, and the `.catch` fired `setSavedLayout({positions:null})` outside any test's `act()` — 25 warnings per run; production now optional-chains (`resp?.positions || null`) and the global mock returns a never-resolving Promise. (3) `getByText('reset-graph')` raced multiple state settlements; upgraded 5 affected tests to `findByText`. Verified under 5× 3-way + 3× 4-way consecutive parallel coverage runs: 1306/1306 each, 0 warnings each.

### Removed

- **Dead code deleted** (zero production callers; only their own tests referenced them; verified across both this repo and `newspack-event-logger-nodes`):
  - `Supervisor_Base::STALE_PARTITION_AGE_S` (unused constant)
  - `Core::$nodes_by_fd` and `Core::$nodes_by_id` (declared + reset; never written to — Tachikoma FD-machinery vestiges)
  - `Lock_Node::force_release()` (instance method) — static `force_release_at()` remains
  - `Lock_Node::clear_restart()` — `write_acquire_files()` already clears the restart flag inline
  - `Consumer_Node::mark_eof()` and `Consumer_Node::update_offset()` — only ConsumerTest's direct-`fgets()` path used them
  - `Partition_Node::get_current_position()` — same data via `get_segments()`
- **Stale doc-comments fixed**: `class-service-ci.php` no longer references the nonexistent `decode_args` helper (refactored into `require_valid_name`); the malformed-schema-node test fixture comment uses `'commands'` instead of the v0.6.0-renamed `'verbs'`.

### Docs

- **Three rounds of doc audit** against the v0.6 → v0.8 substrate refactor (Tachikoma `arguments()` parity, schema field renames, dashboard substrate-I/O backbone, dead REPL-mount cleanup). AGENTS.md / API.md / ARCHITECTURE.md / README.md / GETTING-STARTED.md / WRITING-A-PLUGIN.md and all three `.claude/skills/*/SKILL.md` files audited against current code, with factual errors corrected (TM_STRUCT bit value was wrong in nodes-review skill; "Tail and Consumer stamp FROM" was wrong — Tail does not call `stamp_message`; IPC path layout; verb table additions; etc.) and the `ai-newsletter` example PHP migrated from the pre-0.5.2 manual `Command_Interpreter_Node` + `attach_interpreter()` pattern to the v0.5.2+ inline `'handler' => static fn ...` auto-wire pattern that the walkthrough text already taught.

## [0.8.1] - 2026-05-28

### Fixed

- **`sync-shared.sh` writes atomically** so parallel `~/Documents/DN/bin/run-coverage` (3 plugins fanned out through `partty`) doesn't race: nodes' `npm run build` writes into `../newspack-event-logger-nodes/src/shared/` while ELN's `npm run test:js:coverage` reads the same path. The old two-step `printf > file` + `cat >> file` exposed a torn-write window — switched to a per-process `.$name.$$.tmp` + `mv` so concurrent readers see either the old contents or the new ones, never a half-written file.
- **Debug overlay z-index** bumped to `999999` (FAB) / `999998` (panel) so it sits above `@wordpress/components` modals (~`100000`) and ELN's flame-graph tooltip (`100001 !important`). The old `99999`/`99998` let dashboard modals eat overlay clicks.
- **`fireMsg` test helper drains React's deferred-batch queue** with a trailing empty `act()` so the 3 `reset-graph` chip tests don't flake under parallel-coverage CPU pressure (the post-fill re-render was slipping past a single `act` boundary; isolated runs were green, only the 3-jest-parallel `run-coverage` fanned out enough contention to surface the race).

### Changed

- **Debug overlay drops the dead `_uptime` Uptime mount.** Same architectural mistake as the v0.8.0 dashboard cleanup — copy-pasted from the topology console template, but the overlay never renders an uptime surface (no `useNodeState('_uptime', 'uptime')` consumer). The topology console DOES render its uptime in the Header (legitimate); the overlay doesn't. `NON_NAVIGABLE` keeps the filter entry defensively (cheap; covers a future host page that mounts uptime).

### Tests

- **Five debug-overlay / topology-utils files lifted above the 80% coverage floor.** `replDismissHandler.js` (50% → 100%), `DebugOverlay.js` (65.8% → 99.1%), `useDebugRepl.js` (74.6% → 92.1%), `useDebugGraph.js` (76.2% → 100%), `useDebugLayout.js` (76.6% → 100%). +47 tests; JS total 91.0% → 92.7%; zero files under 80%. Two defensive dead-code branches left uncovered with one-line rationales (DebugOverlay resetGraph pre-baseline guard; useDebugRepl dumperRef-null guards after teardown).

## [0.8.0] - 2026-05-28

### Changed

- **`useWorkerStatusGraph` migrated to the substrate `_http` pattern.** Drops the bespoke `workerStatusPoll` Node. The hook now mounts the runtime spine + `_http` (HttpOut) + `workerstatus:transform` + `workerstatus:view`. The hook owns the `setInterval` that fills `dump_metadata` TM_COMMANDs into the interpreter (FROM=`workerstatus:transform`, TO=`_http/workers`) so the transform owns its prev-snapshot diff math; `restart` uses FROM=view so the awaited Promise resolves via the view's pending Map. The transform forwards TM_ERROR replies to the view so the disconnect banner still surfaces via the un-correlated-error path.
- **`useRawLogsGraph` migrated to the substrate `_sse` pattern.** Drops the bespoke `rawLogsStream` Node. The hook mounts spine + `_sse` (SseIn) + `_http` (HttpOut) + `_heartbeat` (Heartbeat) + `rawlogs:route`/`transform`/`view`. `_sse` subscribes to the raw-logs stream; `_heartbeat.target = '_http/workers'`; the slot bridge mirrors `useRequestLogGraph`. `list_logs` rides through `_http` and the resolved payload is fed back as a `{action:'logs', logs}` control — keeping the pending-Map gate uniform across both dashboards.
- **Both views adopt the canonical contract from `servers:view`** (`newspack-event-logger-nodes` v0.8.0): pending-matched TM_ERROR rejects the Promise without polluting global view.error (per-call surface is the caller's catch); `_errorMessage()` helper handles string and structured `{ message }` TM_ERROR payloads. `rawLogsView`'s pending-Map gate guards on `'name' in value` so a row's VALUE (`{p, line}`) can never accidentally settle a Promise.

## [0.7.0] - 2026-05-28

### Added

- **Three I/O primitives promoted to shared runtime.** `Heartbeat`, `HttpOut`, `SseIn` moved from `src/topology-console/nodes/` to `src/runtime/` and exported from `@newspack-nodes/runtime` so any dashboard can mount them without reaching into topology-console internals. `Completion`, `Dumper`, `Uptime`, and `Metadata` + `parseMetadata` promoted the same way. Sets up `newspack-event-logger-nodes` dashboards (starting with Request Log + Event Aggregator) to drop bespoke `*Command` / `*Stream` Nodes and ride the substrate's `_http` + `_sse` + `_heartbeat` triad.
- **`Echo` Node ported from Perl Tachikoma.** Bounces messages back to their FROM path; drops `TM_ERROR` with empty FROM (no return path). Exported from runtime, registered in `Command_Interpreter_Node.includeNodes` so `make_node Echo …` works browser-side. Closes the parity gap with Tachikoma's `Echo.pm`.
- **`Timer` ports Tachikoma `fire()`.** Each tick emits a `TM_INFO` with the current timestamp into `target`, increments `counter`, and notifies the `FIRE` subscriber set. `make_node Timer t 1000; connect t /_output` now streams timestamps into the transcript; the JS Router pivots on it for its 1s self-tick. Subscribers can `timer.register('FIRE', name, cb)` for per-tick work.
- **Debug overlay reaches parity with the topology console for live cwd-aware operation.** REPL prompt reflects cwd; path-menu enumerates reachable scopes (filtered to navigable substrate names); Inspector buttons honor the live cwd via `shell.sendCommand` prefixing; verb-routing keys on the catalog's `is_interpreter` flag (not a `Core.node` `:config` presence check, which silently misroutes in remote scopes); `_completion` mounted for tab-completion; `_metadata` drives the canvas (`dump_metadata` poll routes through `_cwd`); per-cwd canvas layout; global theme + palette state shared with the topology console; reset-graph chip gated to local scope.
- **`debug_state *` wildcard verb.** Sets every node's `debugState` in one shot (matches the PHP cli convention).
- **Argument prompt on drop.** Dragging a palette chip onto the live canvas (in topology console + debug overlay) opens a `window.prompt` for declared schema args; the prompt shows a template with `*` flagging required fields and `=default` shown where applicable. Nodes with no declared args (Tee, Echo, Hook) drop instantly. Cancel aborts the `make_node`.
- **Auto-layout grid fallback.** When a graph has zero edges (e.g. a request-scope service-CI set), `autoLayout` switches from depth-driven to an alpha-sorted column-major grid (rows = `ceil(sqrt(n))`). The previous depth path stacked every edgeless node in column 0.

### Fixed

- **`Router` self-starts its 1s TIMER in the constructor.** Tachikoma fidelity — the Router IS timer-driven. `Router.removeNode` overrides to call `stopTimer()` so the self-started `setInterval` doesn't leak when `Core.unregisterNode` is called outside `mountExospine`'s teardown.
- **`HttpOut._post` routes synchronous POST-body replies through `this.sink`.** Was a direct `Core.node('_sse').fill(reply)`; the documented `httpOut.sink = interpreter` wiring was dead code. Reply routing through `interpreter → router → resolved-by-TO` is unchanged for the topology console (server-side `HTTP_Filter` already strips the `_sse:{pid}` head), and dashboards that mount `HttpOut` without a paired `_sse` now route replies correctly.
- **`HttpOut._post` surfaces POST rejections via `print_less_often`.** Was a silent `.catch(() => {})` that masked 5xx + network drops as "Inspector click did nothing."
- **Out-of-band emitters bump their counter.** Heartbeat / Metadata / Uptime / HttpOut emit through `sink.fill(...)` without going through the standard `fill → counter` plumbing, so the debug overlay showed `0` activity on nodes that were clearly active. Bump explicitly per emission.
- **`Node.arguments` setter applies schema defaults on empty args.** Previously early-returned, so `make_node X y` (no positional) skipped optional fields with `default` in the schema.
- **`Timer.interval_ms` predeclared as own field.** The Tachikoma schema walker gates on `name in this`; without predeclaration the schema arg was parsed but not assigned, and `make_node Timer t 1000` silently failed to start.
- **Per-cwd scope key in topology console + debug overlay.** `scopeFromCwd` used to lump every non-`_sse` non-worker cwd into `key='local'`, so `/` and `/_http` overwrote each other's canvas-layout localStorage. Each top-level cwd now gets its own key; label strips the leading underscore so `CanvasFrame` doesn't render `topologies/_http.tsl` as a phantom file.
- **`useDebugLayout` debounce-timer cleared on key change.** A pan in scope A can no longer write to scope B's key after `cd`.
- **`useClassCatalog` gated on `enabled && open && !!cwd`** in the overlay. Was firing the `classes.list` HTTP fetch unconditionally on every page mount.
- **`useDebugGraph.onDropNode` uniques against the displayed graph.** Uses remote `dump_metadata` when cwd is remote, local `Core` otherwise — so `make_node` doesn't collide with a remote node the local `Core` doesn't know about.
- **`useDebugRepl` cwd init `''` + separate `mounted` flag.** Was `null`, which leaked through `prompt={\`/${cwd}\`}` as the literal string `/null` for one render frame after the panel opened.

### Changed

- **Service-CI verbs target `_http/<ci>` instead of `_sse/<ci>`.** Request-scope replies ride the POST body; the pid-pivot through `_sse` is dead weight, and for log-tail SSE channels (like the request log's `completed` subscription) the demux isn't available for ad-hoc commands anyway. Worker IPC paths (`_sse/{topology}.p{N}`) still require the pivot and stay unchanged. The bare `_sse` entry was dropped from the topology-console path menu; the debug overlay's path menu picks reachable substrate nodes (excluding internals + bare `_sse`).
- **`Heartbeat.target` now `_http/workers`** for both consoles. Same rationale — request-scope reply is discarded by `Heartbeat.fill`.
- **Debug overlay canvas reads from `useNodeState(_metadata, 'metadata')`** instead of `setInterval(coreToGraph, 1000)`. `cd /_http` swaps the canvas to the server's request-scope graph; `cd /` returns to local.
- **Frame dimensions + theme + palette state are global across surfaces** (`newspack-nodes:debug:frame`, `newspack-nodes:theme`, `newspack-nodes:palette-collapsed:{live,edit}`) so a setting picked anywhere applies everywhere. Palette defaults to collapsed in live mode (not useful while watching), open in edit mode (you drop from it).

## [0.6.0] - 2026-05-27

### Added

- **`Shell::send_command( path, name, args )` / `Shell.sendCommand( path, name, args )`** — thin wrapper that builds a TM_COMMAND via the inherited `Node::command()` helper, stamps the Shell session's FROM/LOCAL provenance (PHP: `_output/<pid>` + ID; JS: `_output`) and target TO (verbatim — no cwd prefix; the typed-line `cmd ...` layer in `parse()` is what applies `prefix()`), and fills it through `$this->sink`. Lets overlay/programmatic callers issue commands as method calls instead of building Messages by hand or piggy-backing on `parse()`. Mirrors `Tachikoma::Nodes::Shell::send_command`.
- **`Node::command()` helper on the base Node** (PHP + JS) — builds a TM_COMMAND `Message` envelope (`VALUE = { name, arguments, payload }`) so `Shell::send_command` and overlay callers can issue commands without hand-building messages. Mirrors `Tachikoma::Node::command`. Precursor to the `arguments()` Tachikoma-parity refactor.
- **The live canvas is directly editable — gestures issue live commands.** Always-on: in view mode, dragging an out-port to an in-port runs `connect_node`, selecting a node + Delete runs `remove_node`, dragging a palette chip runs `make_node <Shell> <name>` (auto-named, collision-free against the live graph). Each is dispatched through the same `sendLine` path as a typed command, so it works on the local graph and a worker cwd alike; the next `dump_metadata` tick redraws (poll-reflect). The topology editor's draft gestures are unchanged (the handlers branch on mode). `SchematicCanvas` gained an `interactive` prop decoupling "gestures on" from edit-mode draft styling. A view-mode "⟳ Reset graph" chip re-mounts the browser graph (state-bump remount, not a page reload) to recover from a self-inflicted break.
- **A reserved `_repl` connection-anchor in edit mode.** The topology editor now shows `_repl` (the worker's auto-mounted REPL command-interpreter — the broadcast handle) as a fixed anchor you can draw `connect_node <node> _repl` edges to (e.g. to observe `log`/`tell` broadcasts). It can't be renamed or deleted, and it's never serialized as a `make_node` line (the worker mounts it) — only edges *to* it are emitted. `withReplAnchor()` seeds it into the draft + baseline on edit entry, so its presence doesn't mark the draft dirty.

### Fixed

- **The "⟳ Reset graph" chip shows only on the local in-browser graph.** It re-mounts the browser console graph, which is meaningless on any pivoted view — a worker over `_sse` or the `_http` broadcast boundary self-heals on respawn. Since the console boots into a worker view, the chip previously showed everywhere; it's now gated to the cwd root (`'' === cwd`).
- **The canvas draws an edge to the head node of a path target.** A node whose `target` is a path (e.g. `_heartbeat`'s `_sse/workers`) now draws its edge to the head segment the router actually delivers to (`_sse`), instead of to the non-existent full-path string (which drew no edge). `parseMetadata` peels the head.
- **The `_cwd` connecting-window guard.** At a worker cwd, while the SSE stream is still connecting (no pid), the poll target routes to the local interpreter (`_cwd.target = ''`) instead of POSTing worker polls whose replies the server can't demux. Once the pid lands (or off-worker), it points at the real cwd.

### Changed

- **`dump_config` round-trips idempotently through `make_node`.** With every Node subclass now reading positional config through schema-driven `arguments()` (and re-emitting that string via the getter), `dump_config` → parse + dispatch → `dump_config'` produces byte-identical output. New regression test `CommandInterpreterTest::test_dump_config_round_trips_idempotently_through_make_node` builds a representative graph (Tee fan-out + Echo sinks + Hook source), teardown via `remove_node`, then rebuilds the graph from the dumped lines and asserts `===` on the two dumps. Closes Task 12 of the arguments() Tachikoma-parity refactor — the entire chainsaw is now landed and verified.
- **`make_node` uses the uniform Tachikoma sequence (no-arg ctor + `arguments()` + sink) — PHP and JS.** The Task-7 conditional that branched on `getNumberOfParameters() > 0` is gone; every Node subclass goes through the same `new $fqcn() / name() / arguments() / sink` path. `Workers_CI_Node`, the last substrate class with a programmatic-dep ctor (`object $cli`, `?object $cache`), migrates to no-arg ctor + public-property dep injection (`$ci->cli = $cli; $ci->cache = $cache;`) — the bootstrap captures the `make_node` return value and assigns the deps before any verb dispatch. `make_node` still filters its scalar tokens into `arguments()` (object deps passed positionally to programmatic `make_node()` calls are silently dropped — they aren't round-trippable as `arguments` tokens anyway). End of the "two shapes" bridge.
- **JS topology-console nodes migrated to the Tachikoma idiom.** `SseConnector` (parent of `SseIn`) now has a no-arg ctor + `static nodeSchema()` declaring three required string args (`subscribe`, `baseUrl`, `nonce`) + an overridden `set arguments` that calls `super.arguments = value` (base walker assigns each token as a string) then splits the comma-separated `subscribe` token into the array form the runtime expects. `_arguments` (the raw string) is left untouched so `dump_config` round-trips byte-identically. `Dumper` and `HttpOut` move to no-arg ctors + public-property programmatic-dep injection (`dumper.debugLevelRef = ref`, `httpOut.client = client`) — Tachikoma's pattern for non-config dependencies. `Metadata` / `Uptime` / `Completion` / `Heartbeat` / `Shell` were already no-arg; each now declares `static nodeSchema()` with `category: 'Hidden'` + `arguments: []` for uniform schema contract. Every caller (`useConsoleGraph`, `useDebugRepl`, the topology-console tests, the `FakeSseIn` test double in `useConsoleGraph.test.js`) migrated to the new pattern. +28 new tests covering construction + round-trip; JS suite at 1264 passing.
- **`Topic_Node` / `Consumer_Node` / `Tail_Node` / `Log_Node` / `Hook_Node` migrated to the Tachikoma idiom** — each one drops its positional ctor, declares `node_schema()['arguments']` with REAL int defaults (closing the placeholder-string trap from the Task 7 changelog), and overrides `arguments()` to chain `parent::arguments()` + re-normalize + re-derive any computed state. All four override-bearing classes include the empty-string short-circuit (`'' === $args` returns the result without rerunning derivation against declaration-default props). Side effects that used to fire in the ctor — `Tail_Node`'s `set_timer`, `Log_Node`'s `mkdir -p` + `fopen` + `ftell`, `Consumer_Node`'s source/offsetlog `Partition_Node` materialization — moved into the `arguments()` override (gated on non-empty args so `arguments('')` stays a no-op). Consumer's schema arg `offsetlog_base_dir` writes to a private input-shaped property; the override derives the canonical `$offsetlog_dir` via `rtrim('/')`. `Hook_Node` is the simplest: typed properties + base setter, no override needed. ~155 caller sites migrated across both repos. `Echo`/`Tee`/`Timer`/`Router`/`Callback`/`Command_Interpreter`/`Dumper`/`Shell`/`Lock`/`Command_Signer`/`HTTP_Filter` confirmed already aligned (no-arg ctor + `'arguments' => []`); the few remaining positional-ctor nodes (`Callback`, `Dumper`, `Lock`, `HTTP_Filter`) carry programmatic dependencies (paths, callables, streams) and stay category=Hidden — never constructed via `make_node`.
- **`Partition_Node` migrated to the Tachikoma idiom (no-arg ctor + schema-driven `arguments()`)** — the reference migration. Ctor takes 0 params; `node_schema()['arguments']` declares the 5 positional args with REAL int constants as defaults (`DEFAULT_SEGMENT_SIZE`/`NUM_SEGMENTS`/`MAX_LIFESPAN`) — replacing the placeholder strings (`'<config:segment_size>'`) that crashed the schema walker when assigning to typed int properties. Overridden `arguments()` chains `parent::arguments()` then re-normalizes (`rtrim`/`max(1,)`/`max(2,)`/`max(0,)`) and re-derives `partition_dir`; empty-string args short-circuits to match the base setter's no-op (otherwise `partition_dir` would synthesize to `/p0` at filesystem root). Every caller — 177 sites across `newspack-nodes` (Topic, Consumer, Bootstrap, Cli_Command, Worker_Base, Raw_Logs_CI, Workers_CI, PartitionTest, ConsumerTest, etc.) AND `newspack-event-logger-nodes` (Stream_Merger, JobIntake, Events_CI, Performance_CI, Reqgrep) — migrated to `new Partition_Node(); $p->arguments("...");`. `Command_Interpreter_Node::make_node()` branches on ctor param count: migrated zero-param ctors get `new $fqcn()`; legacy positional ctors keep `newInstanceArgs($ctor_args)`. Task 8 will migrate the other newspack-nodes Node classes (Topic, Consumer, Tail) — until then, those still carry placeholder-string defaults and would crash on short-token `make_node` calls.
- **Base `Node::arguments()` is the setter-that-parses-and-applies (PHP + JS).** The setter now walks `node_schema()['arguments']` — an array of `{ name, type, default?, required? }` declarations — splits the raw string by whitespace, coerces each token to the declared type (`string`/`int`/`float`/`bool`), and assigns each declared positional argument to `$this->{$name}` (PHP) / `this[name]` (JS). Tokens beyond declared positions are ignored; missing optional tokens use the schema's `default`. Subclasses override the whole method when the default schema walk isn't enough (multi-token args, derived state, validation). Mirrors `Tachikoma::Node::arguments`. JS uses a `get`/`set` accessor pair backed by a `_arguments` own field; `_nodeSnapshot` renames `_arguments` → `arguments` in dump_node output so the public surface keeps emitting `arguments`. One existing test (`CommandInterpreterTest::test_remove_node_calls_node_remove_node_method`) adapted to pass all 5 positional `Partition_Node` args explicitly — its schema's `default` values are UI placeholder strings (`'<config:segment_size>'`) against int-typed properties; Task 7's Partition migration replaces those with real int defaults (`DEFAULT_SEGMENT_SIZE` etc.).
- **`node_schema()` field renamed `'ctor'` → `'arguments'`** across PHP + JS, both repos. Mirrors Tachikoma — `arguments` is the canonical name for the positional-args contract on a Node. Schema declarations, schema reads, the wire-format field in `classes.list`, the JS `schema.arguments` accessor in `Inspector`/`serializeTsl`, fixtures, and docs all use the new name. Schema-bound locals renamed in lockstep (`ctorSpecs` → `argumentSpecs`, not bare `arguments` to avoid shadowing the function-implicit `arguments` object); locals naming the data concept (`ctorArgs`, `CtorField`, DOM ids) stay untouched. Precondition for the schema-driven `arguments()` setter coming next — the setter reads `node_schema()['arguments']`, parses the raw string positionally, and assigns to instance properties. Same wire shape, same behavior — just the name changes.
- **`node_schema()` field renamed `'verbs'` → `'commands'`** across PHP + JS, both repos. Tachikoma calls them commands; the codebase was using "verbs" — a misnomer that conflated the schema-field name with the verb-as-action-name sense. The `:config` CI surface declarations, the wire-format field in the `classes.list` HTTP response, the JS `schema.commands` accessor in `Inspector`/`TopologyConsole`/`serializeTsl`, and the cognate method `Classes_CI_Node::strip_commands` all use the new name. Local variables that existed solely to hold the schema array (`verbSpecs`/`vspec`/`verbName`) renamed to match (`commandSpecs`/`cspec`/`commandName`); locals in the verb-as-action-name sense (e.g. per-invocation records, UI section titles, `inv.verb`) stay untouched. Test fixtures + docs updated. Same wire shape, same behavior — just the name changes.
- **The debug overlay dispatches through `Shell.sendCommand`, not a free-standing `dispatchLocal` helper.** `DebugOverlay` constructs one `Shell` per mount (sink = the page's `_command_interpreter`) and shares it between `useDebugGraph` (canvas gestures + Inspector actions) and `useDebugRepl` (typed REPL lines). Every gesture is now `shell.sendCommand('', verb, args)` (empty TO = local interpreter) — handlers compose the same primitive the REPL uses, no parallel dispatch path. The shell's sink is resolved in a `useEffect` (commit phase) so siblings that mount the exospine in their own `useEffect` (e.g. `useWorkerStatusGraph`) get a chance to register `_command_interpreter` first; resolving in `useMemo` (render phase) would freeze sink=null and silently swallow every dispatch. Inspector "invoke" falls back to the node itself when the `${nodeId}:config` sibling isn't registered (mirrors `TopologyConsole`'s `is_interpreter` branch — interpreter-class nodes carry their own verb table). `src/topology-console/utils/localCommand.js` and its test deleted.
- **The console allows every interaction — the safety rails are gone.** Removed `PROTECTED_NODES` and the `node === this` guard from `remove_node`: `rm` now removes ANY node, including the backbone (`_command_interpreter`/`_router`/`_output`). The Inspector's verb/action buttons no longer gate on `live` (`streamStatus === 'open'`) — they're always clickable (form-validation `disabled` and the streaming display indicator stay). You can break the graph; reload resets it. People learn by breaking things.
- **The console node classes are registered for `make_node`.** A side-effect module (`includeConsoleNodes`) `Object.assign`s `Dumper`/`Metadata`/`Uptime`/`Completion`/`Heartbeat`/`HttpOut`/`SseIn` onto `CommandInterpreter.includeNodes` (Tachikoma's `include_nodes` — the runtime can't import the console nodes, so the console includes them). `make Metadata mymeta` now builds in the browser; the arg-needing ones (Dumper/HttpOut/SseIn) throw on a bare `make` until the arguments() chainsaw.
- **The console working directory is a node (`_cwd`).** A plain `Node` named `_cwd` (sink → interpreter, shown on the canvas) holds the cwd in its `target`; `cd` and the Path menu set `_cwd.target`. The canvas poll nodes (`_metadata`/`_uptime`) just `target = '_cwd'` and emit unconditionally — the poll routes `_metadata → interpreter → router →(peel _cwd)→ _cwd →(re-stamps the cwd)→ interpreter → router → destination`, so one indirection handles every scope (local root interprets in-browser when `_cwd.target` is empty; a worker/request cwd routes out). `_heartbeat` targets `_sse/workers` directly. This replaced the per-cwd poll-gating helpers `pollTargetFor`/`canvasPollTargetFor`/`replInputEnabled` (deleted); `workerPollPath` (SSE-stream gate) and `toNeedsSseSession` (send gates) stay. The REPL input is always enabled now.
- **`make_node` sets `arguments()` itself**, uniformly, from the scalar tokens it was given — instead of relying on each node's constructor to set `$this->arguments` downstream (which some did and some, like Partition, didn't, leaving `dump_config` unreliable). Object dependencies passed to programmatic `make_node` (the service CIs) are filtered out — they aren't round-trippable config. Every made node now round-trips through `dump_config` from one place. (Both PHP and the JS runtime.)

### Removed

- **The generic `mark_verb_invoked()` / `$invoked_verbs` recorder.** `dump_config` no longer replays a recorded list of `cmd {node}:config <verb>` lines. Instead, a node with runtime-configurable state overrides `dump_config()` to emit those lines **from its own state** (`Partition` now does this for `allow_large_writes` and the `with_index` formatter name). Configuration lives in the node, not in a side-channel ledger; one-shot *actions* (which aren't config) don't belong in `dump_config` at all.

### Added

- **`dump_config` restored to the JS interpreter** (it had been dropped). Mirrors PHP: `Node.dumpConfig()` emits `make_node <Type> <name> [<arguments>]` + a `set_sink` line when the sink isn't the default interpreter + a `connect_node` per target; the `dump_config` verb concatenates every node's, skipping the baseline scaffolding. With `make_node` now setting `arguments`, the browser graph dumps back as a runnable build script.
- **`make_node` constructs nodes in the browser** instead of refusing ("runs on a worker"). Mirrors PHP `Command_Interpreter_Node::make_node`: split the args on whitespace, spread the trailing tokens into the constructor as positional args, `name()`, `sink($self)` (the new node auto-sinks into the CI, rule #2). Types resolve through `CommandInterpreter.includeNodes` — a flat name→class table standing in for PHP's namespace-prefix resolution (no `register_namespace`); the console extends it with its own node classes. `Hook`/`Router`/`Callback` are intentionally absent (you don't make a second router, or a predicate/closure node, from the shell). The console graph is now a live, hackable thing.
- **`mountExospine()` runtime helper.** Constructs + registers the canonical rule-#2 backbone every browser node graph clips onto — `_command_interpreter` (sink → `_router`) and a bare `_router` — and returns `{ interpreter, router, teardown }`. `teardown()` fully removes both (clearing the sink edge and any caller-registered TIMER listeners). Exported from `@newspack-nodes/runtime` so dashboards in both this plugin and consumers (ELN) wire the same backbone one way instead of hand-rolling a Router/interpreter per graph.

### Changed

- **The Raw Logs dashboard graph is wired onto the exospine (rule #2).** Every node (`rawlogs:stream`, the new `rawlogs:route` classifier, `rawlogs:transform`, `rawlogs:view`) now sinks into the `_command_interpreter` and steers flow purely with `target`/`TO` through `_router` — no bespoke `stream.sink = transform` chain, no `controlSink` side-channel. The data/control split is a first-class, inspectable node (`rawlogs:route`) that classifies on the stream-set `KEY='connection'` marker (not VALUE content, so a streamed structured log line carrying its own `action` field can't be mistaken for a control). Node names moved from `rawlogs/X` to `rawlogs:X` because `_router` peels TO on `/`. The dashboard renders identically; this is a substrate-conformance refactor.
- **The Worker Status dashboard graph is wired onto the exospine (rule #2).** `workerstatus:poll`, `workerstatus:transform`, and `workerstatus:view` now sink into the `_command_interpreter` and steer flow with `target`/`TO` through `_router` — the `poll.sink = transform` chain is gone. Poll-driven with no data/control split (the transform converts `metadata` snapshots to the render model and forwards `error` controls through), so no route node. Node names moved `workerstatus/X` → `workerstatus:X`. Renders identically.
- **The topology console graph is folded onto `mountExospine()` and its last rule-#2 drift fixed.** `useConsoleGraph` now builds its backbone via `mountExospine()` instead of hand-constructing the Router + CommandInterpreter, and the SSE node's `sse.sink = _router` direct wiring became `sse.sink = _command_interpreter` — so the SSE node matches the Shell/metadata/uptime/heartbeat nodes (everything sinks into the CI; steering stays `sse.target = _output`). Behaviorally identical (the CI forwards the non-command / non-empty-TO SSE traffic to the router); teardown delegates the backbone removal to the exospine.

## [0.5.2] - 2026-05-27

### Changed

- **A node's sibling `:config` CI is auto-wired from `node_schema()`.** Declare a verb's handler inline in `node_schema()['verbs'][n]['handler']` and the base `Node::__construct()` builds the `{node}:config` Command_Interpreter from every handler-bearing verb — no per-node `config_verbs()` + `new Command_Interpreter_Node()` / `patron()` / `commands()` / `attach_interpreter()` boilerplate, and no declaring each verb twice (table + manifest). A verb without a `handler` stays palette-only; a CI never gets a sibling (it dispatches its own verbs); a node with its own constructor calls `parent::__construct()` after setting properties. Because `node_schema()` is static, handlers reach the node via `$ci->patron()`. The auto-wire is idempotent — a double `parent::__construct()` or a manually-attached interpreter is preserved, never duplicated. Migrated `Partition` to the new shape; `Timer_Node` / `Topic_Node` / `HTTP_In_Node` now chain `parent::__construct()`. `WRITING-A-PLUGIN.md` updated to teach the single-declaration pattern.

## [0.5.1] - 2026-05-27

### Fixed

- **The canvas keeps polling `dump_metadata`/`uptime` at the local graph (`cd /`) and request scope (`cd /_sse`).** #12 gated ALL polling to worker cwds, so the canvas froze (stale counts) the moment you left a worker. But those contexts are pollable without the worker stream: the local graph interprets `dump_metadata` in-browser, and request scope replies synchronously in the POST body. The metadata/uptime poll target now follows a new `canvasPollTargetFor()` (worker LCP for a worker cwd, else the cwd itself); only the slot `_heartbeat` stays worker-only (`pollTargetFor`), since its poke keeps a worker-stream slot alive.
- **The Active Topologies "restore defaults" (↺) loads the config-file `topologies`, not the full catalog.** It was sourcing defaults from `Bootstrap::get_topology_catalog()` (every registered `.tsl`), so ↺ — and the unset-option initial render — checked EVERYTHING, spawning every fleet (wrong for role-specific deployments like docker-admin / docker-render). It now reads `Config::load_config_defaults()['topologies']` (the curated set declared in `newspack-nodes-config.php` or a `LOCAL_NEWSPACK_NODES_CONF` override), matching `Bootstrap::get_topologies()`'s own precedence. The available checkbox list still comes from the full registry — only the default selection changed.
- **The REPL can send commands at the local graph (`cd /`) and request scope (`cd /_sse`).** 0.5.0 re-enabled the prompt off the worker stream, but the three send gates (typed line, tab-completion, Inspector verb-invoke) still rejected EVERY send when there was no session pid — so `cd /` then `ls` returned "[no sse_pid yet] retry once CONNECTED". Only a worker pivot (`_sse/{topology}.pN`) routes its reply async over the stream and needs the pid; a local-root command interprets in-browser and a request-scope command replies synchronously in the POST body. The gates now key on a new `toNeedsSseSession()` test of the message's TO instead of the bare `ssePid` presence.

## [0.5.0] - 2026-05-27

### Added

- **`make_node Node <name>` resolves the base `Node` class.** The base `Node` carries no `_Node` suffix, so it was unreachable through `make_node` (which appends `_Node` and resolved `{prefix}{type}_Node`); resolution now special-cases `Node` to the bare class and accepts it via `is_a(…, true)` instead of `is_subclass_of`. This makes the base `Node` a first-class type — a bare routing/fan-in primitive whose default `fill()` stamps `TO=target` and forwards to `sink` (e.g. the SSE-stream process's `_default_route`) — and round-trips through `dump_config` (its shell name is `Node`). Added the matching `Node_Names::HEARTBEAT` const so the JS↔PHP reserved-name parity guard passes.
- **A `_heartbeat` slot-keepalive poll node** in the topology console (JS) — the SSE slot keep-alive moved off its own `setInterval` onto the Router TIMER, so the `workers/heartbeat` poke now rides in the SAME batched POST as the canvas polls (`dump_metadata`/`uptime`) — one request per tick instead of two. `_heartbeat` is a silent poll node (like `_metadata`/`_uptime`): it holds the slot acquired by the live SSE stream, pokes at most every 5 s (half the 10 s TTL), and consumes its reply rather than transcripting it. `HttpOut` now only prepends a `connect_worker_input` for an actual worker reader (`{topology}.p{N}`); a server-CI target (`workers`, …) rides bare, so the poke routes through `_sse`→`_http`→`workers` without spuriously mounting an input partition.
- **`reply_to <node path> <command>` interpreter verb** (PHP + JS) — runs `<command>` in the interpreter that receives it but routes the reply to `<node path>` (the inverse of `command_node`, which runs it *at* the path). Mints the sub-command stamped `FROM=<path>` (so `interpret()` replies `TO=FROM`) and re-enters `fill()`; `LOCAL` authorizes the in-process mint. Enables driving a remote interpreter's output to one session.
- **A `_command_interpreter` in the SSE-stream process** — the otherwise egress-only `/messages/stream` process now interprets commands that arrive over the stream, so a worker can introspect/drive it: `cmd _repl/_command_interpreter reply_to _http/_sse:411/_output ls -als` runs `ls -als` in the SSE process and lands the result in that one client's transcript. Wired canonically (Tachikoma rule #2): the bespoke `_stream_sink` Callback is replaced by a plain `Node` `_default_route` (whose default `fill()` stamps `TO=_sse` only when TO is empty — Consumers can't carry that target since they force `TO=target()` on every message); Consumers sink into `_default_route`, which sinks into `_command_interpreter` → `_router`. Empty-TO worker broadcasts (stderr/events) route to the `_sse` egress; non-empty-TO replies route by their breadcrumb through `_http`; a command addressed `_command_interpreter` (TO empty after the worker peels `_repl` from `_repl/_command_interpreter`) is interpreted in-process. Authorized with the HMAC verifier (the cli already signed the command; the signature survives the partition).

### Changed

- **`HttpOut` dedups `connect_worker_input` within a batched POST.** When several commands pivot to the SAME worker in one Router tick (e.g. `dump_metadata` + `uptime` both to `aggregator.p0`), the buffer now carries a single leading `connect_worker_input` for that worker instead of one per command. `register_worker_partition` is idempotent, so the repeats were pure wire/parse waste; distinct workers still each get their own connect, and `flush()` resets the per-batch dedup set.
- **The topology console only polls and streams while pivoted into a live worker.** The canvas poll nodes (`_metadata`/`_uptime`/`_heartbeat`) and the SSE EventSource now gate on whether the cwd's longest worker-prefix is non-null: a `cd /` (local graph), `cd /_sse` (request scope), or any non-worker cwd nulls all three poll targets AND closes the SSE stream, so the browser stops poking and streaming when there's nothing to watch (and the server reclaims the slot at TTL). `cd`-ing back onto a worker reopens the stream and re-acquires a slot. The stream gate (`streamEnabled`) is a separate effect from the graph build, so toggling it doesn't tear down/rebuild the node graph. Both the poll target and the stream gate derive from ONE active-set-aware `workerPollPath()` helper (a worker-shaped path for an *inactive* topology resolves to no menu entry, so neither the stream nor the polls fire for it — they can't disagree and strand a slot with no keepalive). `SseConnector.close()` now clears the cached session pid so a reopen never reports a stale one. The REPL prompt stays usable in non-worker contexts: `cd /` and `cd /_sse` close the stream and null the session pid, but their commands are local builtins or synchronous `_http` POSTs that never use the stream, so the prompt's enable gate (`replInputEnabled()`) only waits on the stream while pivoted into a worker — otherwise a `cd /` would disable the prompt with "Connecting…" and leave no way to `cd` back onto a worker.
- **`Tee` fans out sub-path-addressed messages** (mirrors OG Tachikoma `join '/', grep length, owner, TO`): a message with an empty TO copies to each target as `TO=<target>`; a message in transit toward a sub-path (non-empty TO) copies as `TO=<target>/<TO>`. Correspondingly, `Tee` only treats a `TM_REQUEST` as its own `GET_TARGETS` request when TO is empty — a non-empty-TO request fans out like any other message instead of being consumed.
- **`stderr` is a broadcast that now surfaces at the REPL in every context.** `Core::stderr` (PHP + JS) routes the formatted line to whichever reply sink the process wired — the worker's `_repl` output partition, a REPL `_output` Dumper, the SSE-stream `_sse` egress, or (PHP) the `_http` POST-`/command` response writer — in addition to the `dmesg` ring + console. So `log`/`dmesg` (and any node's stderr) now echo at the prompt in the browser console, `wp nodes cli` bare mode, the ephemeral `/command` request, and the SSE stream — not just inside a worker. The SSE controller's egress node is now named `_sse` so its process's stderr reaches the client instead of dead-ending in `HTTP_Filter`. Each process registers exactly one sink, so a line never doubles. `log` stays a broadcast (it returns nothing — that's what distinguishes it from `echo`).
- **The `/command` HTTP response is JSONL** (one packed Message per line). A single command can emit MORE than one message (e.g. a `log`/stderr line plus the verb response), so `HTTP_In` writes newline-delimited records and the browser client splits + unpacks each line (routing every reply via `_sse`) instead of `JSON.parse`-ing the whole body. `CommandClient.send()` returns the final (response) line; `postBatch()` returns all lines.
- **The JS runtime gained Tachikoma-style node-level logging** (`Core.log_prefix`/`log_midfix`/`stderr` + `Node.log_midfix`/`stderr`/`print_less_often`/`print_least_often`), so `log` / `dmesg` emit dated, node-tagged, newline-terminated lines matching the PHP cli (`<ts> UTC newspack-nodes: <node>: <msg>`) instead of raw concatenated text (`foo` + `bar` → `foobar`). The `log` verb (PHP + JS) routes through the CI node's own `stderr` so it carries the `_command_interpreter:` midfix; hostname/pid are omitted (unavailable in-browser).
- **Topologies are no longer plugin-owned.** `Topology_Registry::register_plugin()` now only registers a namespace + stock dir; the catalog (`publish_catalog`) is built from every `.tsl` in `Topology_Registry::list()` (user dir ∪ all stock dirs, so editor-created topologies are first-class); `spawn_worker` is a single substrate-registered, ungated handler driven by the active set. `Bootstrap::get_topologies()` derives the active set from the `topologies` config key (wp-option overlay, else config-file default) — **empty means nothing is active** (no full-catalog fallback). Fixes a class of bug where a topology shown by `wp nodes status` / selectable in the editor could never spawn because no plugin's curated `names:` allowlist owned it.
- **Workers keep a durable offsetlog for their IPC input**, so commands queued during a restart (worker fleets recycle ~10 min) aren't dropped — a respawned worker resumes from its last read offset (first spawn tail-seeks to end to skip the input partition's retained history; the worker checkpoints the input cursor at shutdown, so a clean recycle never replays already-consumed commands). The IPC input + output *data* Partitions now use a 1 MiB `segment_size` (`Worker_Base::IPC_SEGMENT_SIZE`); the small input cursor offsetlog keeps its own default.
- Added a shared `ConnectionBanner` component (`src/shared/components/`, mirrored into newspack-event-logger-nodes by `sync-shared.sh`) and wired it into the **Raw Logs** SSE dashboard (a new `onStatus`→`controlSink`→`connectionError` reconnect surface, mirroring Error Log) and the **Worker Status** dashboard (replacing its bespoke `worker-status-error-inline` markup) — so every dashboard's connection/reconnect banner is identical.
- Removed the silent `?? '/tmp/newspack-nodes'` `base_directory` fallbacks across the substrate's own readers (`Bootstrap`, `Log_Discovery`, the CLI commands, `Layouts_CI`, `Raw_Logs_CI`, `Workers_CI`). They now resolve through the strict `Config::get_base_directory()`, which throws when `base_directory` is unconfigured — failing loudly instead of silently reading an empty `/tmp/newspack-nodes` while the writer uses the real dir. (The admin settings field falls back to empty string, not `/tmp`, so the page where you'd fix the config never throws.)
- **i18n infrastructure** (foundation for translating the dashboard UI): declared `@wordpress/i18n` as a dependency, enabled the `@wordpress/eslint-plugin` i18n ruleset (pinned to the `newspack-nodes` text domain), and added the `Text Domain` / `Domain Path` plugin headers plus a `make-pot` script + `languages/` dir. (`build.mjs` already externalized `@wordpress/i18n → wp.i18n`.)
- Wrapped the dashboard UI strings for translation (`@wordpress/i18n` `__()`/`_n()`/`sprintf`, domain `newspack-nodes`) across every dashboard — `WorkerStatus`, `TopologyConsole`, the node `Inspector`, `RawLogs`, and the topology-console chrome (REPL footer, header, canvas, modals, and the skin labels in `themes.js`). `ConnectionBanner` consumers pass a translated `message` (its default stays an English fallback); protocol/command strings, comparison values, theme slug-keys, and map-keys stay raw. The translation template `languages/newspack-nodes.pot` (199 strings) is generated by `npm run make-pot`.

### Removed

- **`dump_config` is gone from the JS console CommandInterpreter** (verb, help topic, and the `_cmdDumpConfig` method). Browser graph nodes aren't `make_node`-authored and the JS `Node` has no `dumpConfig()`, so the verb only ever returned an empty string in the console. It remains a PHP server command (where nodes are `make_node`'d and round-trippable).

### Fixed

- **The topology console's `ls`/`list_nodes` now run the full `_cmdList`** instead of a flat name-dump. The console wired a `listLocalNodes` override that ignored all arguments, so `ls -a`, `ls -c`, `ls -s`, `ls -t`, and name globs did nothing in the browser. Dropping the override restores the full verb: bare `ls` lists the interpreter's siblings (Tachikoma default), `ls -a` lists every node, and the column flags work.
- **`status` is a Shell builtin, not a server command, so `help` now lists it under `### SHELL BUILTINS ###`** (both the PHP cli and the JS console) instead of `### SERVER COMMANDS ###` — it was carried in the interpreter help-topic map, which feeds the server-command table. The JS console's `status` builtin also now reports a live summary (SSE session + cwd + worker pivot) via a new exported `statusLines()` helper kept current by the host; its `statusLines` carrier was previously never populated, so `status` printed nothing.
- **Topology console LIVE mode now recovers from a worker restart** without a page reload or topology switch. When the worker is momentarily offline (mid fleet-restart) at subscribe time, `open_subscription` tails the worker's persisting IPC `output` dir instead of stranding on the (often-absent) log feed — so the session re-binds and resumes once the worker respawns. (Pairs with the durable IPC-input offsetlog above, so the queued poll commands the reconnected session needs are still processed.)
- **`Log` now creates its parent directory** (`mkdir -p`) on construction, and `fill()` warns once (rate-limited) instead of silently dropping writes when no file handle is open. A configured log path under a not-yet-existing dir (e.g. an example topology writing `/tmp/<plugin>/out.log`) previously failed silently until the dir was hand-created.
- **Topology editor: the DELETE button now appears on edit (and after save) for a user-saved topology, not only after opening it via the Open modal.** It's driven by the `source` field the `get`/`save` responses already return (a new `editingSource`), rather than the Open-modal topology list (which isn't loaded until Open is shown) — so editing a user/shadowing topology no longer looks like the stock copy.
- **Deleting a user topology now restarts the active fleet** (symmetry with save), so the worker reloads the stock copy it falls back to.
- **Restored read-time type coercion in the WP-option overlay (`Config::load_config`).** A prior simplification removed the per-key coercion, so a `memcache_servers`/`array_strings` option stored as a newline string overlaid the config as a raw string (breaking the `foreach`/`implode` consumers that need a list) and an `int` option stored as a numeric string overlaid as a string. A minimal `coerce_option_value()` now splits the array types into a trimmed list and casts `int` (non-numeric → falls back to the file default), restoring the shape consumers expect. Per-element `sanitize_text_field` was deliberately NOT restored — it moved to the write-time `register_setting` callbacks, off the per-request read path.
- **Topology console assumed every interpreter verb targets `<node>:config`.** Command verbs were unconditionally routed to the `<name>:config` sibling interpreter, so a verb on a node that IS a `Command_Interpreter` subclass (the `*_CI_Node` service CIs) hit a non-existent `<name>:config` → `NOT_AVAILABLE`. `Classes_CI` now exposes `is_interpreter` (`is_subclass_of( Command_Interpreter_Node )`); the live invoke + `serializeTsl` + `Node::dump_config()` target the bare node for interpreters and `<name>:config` otherwise, and `parseTsl` round-trips the bare form.

- **`wp nodes status` "Behind" column assumed every worker drains `firehose.log`.** It
  hardcoded `{logs_dir}/firehose.log/p{N}`, so a worker with a different input log (any
  non-ELN topology — e.g. the ai-newsletter `digest`) showed `-`. It now resolves each
  worker's real input basename from its offsetlog's `source_basename` (a new
  `CLI::input_basename()`, mirroring how the web console already computes Behind), falling
  back to the `firehose` convention only when no basename is recorded.
- **`/` and `/_sse` reused the last worker topology's header + auto-fit/layout.** The
  canvas header (title / `.tsl` / sheet) and the viewport + node-position localStorage
  keys were driven by the stale `topology`/`partition` state, which only updates on
  worker paths — so the local and request-scope views inherited the last worker's
  identity and shared its saved layout. They now derive from the cwd scope: a worker →
  `{topology}.p{N}` (unchanged keys), `/` → `local`, `/_sse` → `request scope` — each with
  its own header (no `.tsl` line for the non-worker scopes) and its own viewport/layout.
- **`Log`'s `rotate` was mis-categorized as a command `verb`.** `Log::fill()` handles
  `rotate` in its `TM_REQUEST` branch (the node services it itself; `Log` has no
  `{name}:config` sibling interpreter), but `node_schema()` listed it under `verbs` — so the
  console Inspector routed it to `{node}:config` and got `NOT_AVAILABLE`. Moved to
  `requests`; the Inspector now sends `request_node {node} rotate` to the node, which
  rotates. (Verified live.)
- **Live-mode Inspector verb buttons targeted the bare node, not its `{name}:config`
  sibling interpreter.** Command verbs (`node_schema` `verbs` — e.g. `tick`/`flush`/`set_*`) live on
  the node's sibling CommandInterpreter (`Node::dump_config()` emits `cmd {node}:config
  {verb}`; `.tsl` topologies use the same form), but the topology-console Inspector sent
  `TM_COMMAND` to the bare node — a no-op, since a plain Node doesn't interpret commands.
  So clicking a verb did nothing. Command verbs now route to `prefix({node}:config)`;
  requests (`TM_REQUEST`) still target the node, which answers them.

### Changed

- **Raw Logs dashboard reimplemented as a JS-Node graph + thin React view.** The data
  flow moved out of React effects into a `Core`-registered graph — `rawlogs/stream`
  (SSE-in, owning the connection + slot heartbeat + reconnect), `rawlogs/transform`
  (envelope → row), `rawlogs/view` (the ring buffer + lines/sec view model) — wired by
  `useRawLogsGraph`. `RawLogs.js` is now a thin view: `useNodeState`/control callbacks
  drive the chrome, and the canvas rAF reads the high-volume buffer (`node.lines`/`.lps`)
  directly each frame (no per-line React re-render — preserving the original's
  performance, with an idle-frame re-render guard). Behavior + appearance are identical
  (dropdown, canvas, smooth/virtual scroll, filter, pause, LPS, "Xs ago", Clear), and the
  dashboard is now introspectable via `Core.nodes`. This is the reference for the
  "every dashboard is a JS-Node graph" conversion. (Two intentional deltas: the hidden-tab
  stream-pause and the brief "Loading…" status are not carried into the component — stream
  lifecycle is the graph layer's concern, and folding visibility-pause into the user's
  explicit pause would corrupt it.)
- **Worker Status dashboard reimplemented as a JS-Node graph + thin React view.** Following
  the Raw Logs reference, the poll-based data flow moved out of React effects into a
  `Core`-registered graph — `workerstatus/poll` (the `dump_metadata` transport + `restart`,
  behind an injectable command seam), `workerstatus/transform` (snapshot → enriched model:
  per-worker read rates, per-log write rates, segment add/remove tracking — all ported
  verbatim), `workerstatus/view` (the published view model) — wired by `useWorkerStatusGraph`,
  which owns the page-visibility-gated poll interval (Worker Status has no SSE; the repeated
  poll IS the live data). `WorkerStatus.js` is now a thin view: `useNodeState('workerstatus/view',
  'view')` for the model + control callbacks (restart, refresh interval); the pure render
  helpers (`buildRenderPlan`, `SegmentBar`, `LogSection`, `WorkerConnector`, `SupervisorStatus`)
  are unchanged. Behavior + appearance are identical, and the dashboard is now introspectable
  via `Core.nodes`. Because Worker Status has no rAF to mask it, the hook adds an explicit
  re-render trigger so `useNodeState` re-subscribes to the freshly-mounted view node (mirrors
  `useConsoleGraph`'s `setShell`).
- **The `/workers/spawn` response sanitizer projects by value TYPE, not an ELN field
  whitelist.** It previously surfaced `status` plus only five hardcoded ELN counter names
  (`entries_processed`/`requests_complete`/…), stripping any other plugin's worker
  counters. It now keeps `status` and surfaces any field with a numeric value (cast to int)
  under a safe `[a-zA-Z0-9_]` key, capped at 32 — so any plugin's counters come through
  while strings/arrays/paths/traces are still dropped (the no-leak posture is unchanged).
- **Raw Logs interpreter verbs de-firehose'd.** `firehose_logs` → `list_logs`, `firehose_status` →
  `log_status`, and the fallback const `DEFAULT_LOG_KEY` → `PREFERRED_LOG_KEY` (value still
  `firehose`, a soft preference: used when present, else the first-discovered log). Generic
  log inspection for any plugin's logs; the substrate stops naming these after ELN's
  firehose. (`RawLogs.js` updated to call the new verb name.)
- **Worker Status refresh-interval storage key renamed** `newspack-event-logger-nodes-worker-refresh`
  → `newspack-nodes-worker-refresh`, with a one-time read-with-fallback migration (the
  extracted `initialRefresh()` reads the new key, falls back to the legacy key and writes
  it forward) so an operator's saved refresh preference isn't dropped.
- **Internal `event-logger-*` identifiers renamed to `newspack-nodes-*`.** The substrate was
  extracted from the event-logger plugin and still named internal identifiers after it: ~64
  CSS class names + their `className` references (across the Raw Logs + Worker Status admin
  dashboards), the three admin mount DOM ids (`…-workers`/`…-rawlogs`/`…-topology-console`),
  and the topology-console root id. All renamed to the `newspack-nodes-*` prefix. Purely
  internal (no user-visible change); a substrate-agnostic runtime no longer carries its
  progenitor's name. (Legitimate references to the `newspack-event-logger-nodes` plugin by
  name are unchanged.)
- **Topology `<ns:key>` tokens resolve via per-namespace resolvers — no merged config.**
  `<config:foo>` was resolved from a single `Core::$config` array that callers had to
  populate, forcing apps to merge substrate + app config into one blob to feed
  `Topology_Loader::load($config)`. That array is gone: `Core` now holds a
  `register_config_namespace( $ns, $resolver )` registry, `Shell::interpolate` resolves
  ANY `<ns:key>` through the namespace's resolver, and the substrate registers its own
  `config` namespace (`Config::register_token_namespace()` — `logs_dir`/`offsets_dir`
  derived, other keys off `Config::load_config()`). `Topology_Loader::load()` dropped its
  `$config` parameter. Each config owner now answers only for its own keys; nothing
  merges. (Apps with their own topology tokens register their own namespace — e.g.
  `<eln:…>`; see newspack-event-logger-nodes.)
- **Service CIs derive their command table from `node_schema()` — each verb declared
  ONCE.** `Service_CI_Node` now has a constructor that builds its `commands()` dispatch
  table from `static::node_schema()['verbs']`, where each verb entry carries its own
  `handler` closure. The verb's name, description, args, AND handler live in one place
  instead of being split across a `node_schema()` descriptor and a separate
  `verb_table()`. `Classes_CI` strips the non-serializable `handler` when it serializes
  the catalog (inlining only `{name, description, args}` for the editor palette).
  All four substrate service CIs (`Topologies_CI`, `Raw_Logs_CI`, `Layouts_CI`,
  `Workers_CI`) are migrated to the mechanism — their `verb_table()`s/constructors
  removed. (`Workers_CI` keeps a constructor only to receive its injected `cli`/`cache`,
  which its handlers now read off the dispatched instance via `$self->` since a static
  `node_schema()` can't capture them.) The application service CIs in
  newspack-event-logger-nodes follow. A named verb with no callable
  handler is a schema bug — it now emits one rate-limited warning and is skipped (rather
  than silently showing in the palette yet dispatching to "unknown command"), and a
  malformed verb entry is skipped from the catalog rather than fatal-ing the whole `list`
  scan.

### Added

- **Onboarding docs + a runnable example.** `GETTING-STARTED.md` (one screen of concept,
  then run the bundled example in ~5 minutes) and `WRITING-A-PLUGIN.md` (build that example
  from an empty directory, one node at a time, ending with a live worker graph in the
  topology console). Both center on `examples/ai-newsletter/`, a dependency-free digest
  pipeline (two sources → summarizer → builder → `Log`). `README.md` links both.
- **`Topology_Registry::register_plugin()` — one-call topology+worker registration.** A
  plugin whose `.tsl` files live in a topologies dir can register everything it needs
  with a single call (namespace resolution, the stock dir, a `newspack_nodes/topologies`
  catalog contribution per topology, and a default `newspack_nodes/spawn_worker` handler),
  instead of hand-wiring those four hooks. `$names = null` publishes every `*.tsl` in the
  dir. The spawn handler is **guarded to the plugin's own topology names** so it never
  collides with another plugin's handler, and registration is **idempotent** (a repeat
  call with the same prefix+dir no-ops, preventing a double worker spawn). The default
  worker-spawn path sits behind a `\Closure` seam (`$spawn_runner`) so it's testable
  without forking a process. Before building a worker it fires a
  `newspack_nodes/before_worker_spawn` action (so a plugin can run worker-runtime init
  before its topology loads), and `num_partitions` defaults to the substrate
  `num_partitions` option (clamped 1–16) when not given. Applications needing
  operator-overlay config, custom descriptors, or a job-context-wrapped spawn (e.g.
  newspack-event-logger-nodes) still hand-wire the underlying hooks.

## [0.4.0] - 2026-05-23

### Added

- **Invoke a node's verbs from the live-mode Inspector.** The Inspector now
  renders every schema verb (both TM_COMMAND `verbs` and TM_REQUEST `requests`)
  as a button. Argless verbs fire immediately; verbs with arguments open a modal
  whose fields reuse the same widgets as edit mode (`CtorField` — text, int,
  enum/`formatter_name`/`node_name` selects). Run delivers the args both ways —
  a positional `arguments` string AND a by-name `payload` map — so substrate
  node-verbs and REST service-CI verbs are both reachable. The invocation echoes
  in the transcript and the reply streams back like a typed command.
- **REST service CIs declare their own `node_schema()`.** `Topologies_CI`,
  `Layouts_CI`, `Raw_Logs_CI`, `Workers_CI`, and `Classes_CI` now publish a
  `Service`-category schema with each verb's name, description, and argument spec
  (instead of inheriting the generic Hidden/empty CommandInterpreter schema) — so
  their verbs are introspectable by the console.
- **Every CommandInterpreter answers `help` by default.** An interpreter that installs a
  custom verb table (the REST service CIs) previously had no `help`; the base now
  injects one that lists the interpreter's own verb names (sorted, newline-separated). Interpreters
  shipping their own richer `help` (the base table) are untouched.
- **REPL `cd` mounts a worker exactly like a Path-menu pick.** `cd` keeps its
  free-navigation behavior (any path, including a worker's sub-nodes), but now
  routes through the same handler the menu uses: the cwd resolves to the largest
  worker menu item that is a prefix of the path, and mounting a *different* worker
  re-keys the graph and re-subscribes `_sse` to its output. `cd` within the
  current worker (or onto a non-worker/root path) is a pure cwd move with no
  rebuild — so you can `cd` into the current worker's sub-nodes freely. (Crossing
  to another worker rebuilds and lands at that worker's root.)

- **The browser Shell and CommandInterpreter reach 1:1 parity with the PHP
  reference.** The JS Shell gains the full builtin set (`pwd`, `var`/`<var>`
  interpolation, `echo`, `show_parse`, `status`, …); the JS CommandInterpreter
  gains the full verb table (`make_node`, `connect_node`, `set_sink`,
  `remove_node`, `dump_node`/`dump_config`/`dump_metadata`, `ls`/`list_nodes`,
  `log`, `dmesg`, `stats`, `uptime`, `debug_state`, `help`) operating on the
  in-browser node graph. (Browser-local `make_node` still needs a class registry —
  tracked separately; `make_node` itself works on workers.)
- **Node lifecycle + quote-aware shell args.** `Node.removeNode()` /
  `Node.disconnectNode()` and `Tee.disconnectNode()` give the `remove_node` /
  `disconnect_node` verbs real teardown (clear registrations/sink/target, cascade
  the sibling interpreter, unregister last), matching PHP. The JS Shell now
  tokenizes arguments quote-aware — `var x = "a b"` stores `a b`, quoted bodies
  keep interior spaces — matching PHP `Shell::tokenize`.
- **`dmesg`/`uptime` work in the browser interpreter.** Added the JS `Core` `recentLog`
  ring (fed by `Core.stderr`, capped at 100) and `initTime`, matching PHP `Core`,
  so the verbs report the recent stderr tail and session uptime.
- **Command history in the console REPL.** Up/Down arrows recall submitted
  commands (clamp at the oldest; Down past the newest restores the in-progress
  draft); empty lines and immediate duplicates are skipped — standard shell behavior.
- **Completion-query mode in the CommandInterpreters.** `help`/`ls` with
  `KEY='completion'` return a bare candidate list (sorted verb names / node names,
  no help text or columns) instead of the elaborate output — the foundation for
  REPL tab-completion. Implemented in both the JS and PHP CIs (identical
  candidates), mirroring Tachikoma's TM_COMPLETION via a KEY flag.
- **Tab-completion in the console REPL (browser).** Tab completes the longest
  common prefix of the candidates — verb names (`help`) when on the command word,
  node names (`ls`) on an argument — routed through a new `_completion` node (a
  peer of `_metadata`/`_uptime`, wrapped by `_sse` so worker replies pivot back to
  the session). Multiple candidates with no further common prefix are listed.
- **Tab-completion in `wp nodes cli`.** readline completion backed by a candidate
  cache refreshed via the same `KEY='completion'` queries; readline does the LCP +
  listing. (Cache is one-keystroke-stale by design; the live-terminal behavior
  needs interactive verification.)
- **Completion candidates now include aliases and all nodes.** `help` in
  completion mode sources the verb dispatch table (so aliases `ls`/`rm`/`make`/…
  complete, not just canonicals); `ls` in completion mode lists ALL nodes (like
  `-a`, so `cd <tab>` reaches `_`-prefixed nodes). The browser REPL appends a
  trailing space after a unique completion, matching readline.
- **Browser REPL lists ambiguous candidates on the second consecutive Tab**
  (matching readline's default). The first Tab extends to the common prefix (or
  bells if it can't); a second consecutive Tab — whether or not the first
  extended — lists the options. Typing or cursor movement resets the run.

### Changed

- **JS `CommandInterpreter` drops `classMap`/`registerClass`.** The browser has no
  class registry or autoload — node construction is server-side. `classMap`,
  `registerClass`, and the browser-local `makeNode` are removed; the `make_node`
  verb now returns a "cd to a worker path" hint (at a worker path the command
  routes to that worker's PHP interpreter). The palette already comes from the server
  catalog (`useClassCatalog` → `classes.list`).
- **`make_node` resolves classes by namespace prefix + `_Node`; `register_class`
  removed.** Plugins now call `Command_Interpreter_Node::register_namespace()`
  (one call per namespace) instead of ~36 per-class `register_class()` calls.
  `make_node( $type )` resolves the first `{$prefix}{$type}_Node` that exists and
  is a concrete `Node` subclass; the shell-name is the class short-name minus
  `_Node`. The palette catalog (`Classes_CI list`) is now built by scanning the
  composer classmap for `*_Node` Node subclasses under the registered prefixes
  (skipping abstract / Hidden / no-category). `register_class()` / `class_map()`
  are deleted.
- **Internal: node/helper class names normalized (newspack-nodes).** Every class
  is now `Word_Word` with ALL-CAPS acronyms; Node subclasses carry a `_Node`
  suffix (`CommandInterpreter` → `Command_Interpreter_Node`, `Tee` → `Tee_Node`,
  helpers like `EventFramework` → `Event_Framework`). Behavior-neutral this stage:
  `register_class` shell-names and `.tsl` topologies are unchanged (the canvas /
  `dump_metadata` `class` field still reports the shell-name via `shell_name_for`).
  First stage of the `register_class`→namespace-prefix refactor.
- **Live-canvas polling runs on a single Router TIMER, batched into one request.**
  The browser `Router` now fires a `TIMER` notification once per second (matching
  PHP Router). Each tick locks `HttpOut` before notifying subscribers and flushes
  it after, so everything emitted during the tick rides in ONE `postBatch`. The
  `_metadata` and `_uptime` nodes register as TIMER subscribers and emit their own
  poll commands (`_metadata` every tick; `_uptime` self-throttled to 5s), removing
  the timer drift between them — `uptime` now always goes out in the same HTTP
  request as `dump_metadata` on the 5s tick. Replaces the two `setInterval` polls
  in `TopologyConsole`; emission is gated via the nodes' `pollTo` (null in edit
  mode / before the SSE pid).
- **Scalar REST service-CI verbs read positional `arguments`, not `payload`.**
  `Topologies get`/`delete`, `Layouts get`, `Raw_Logs firehose_status`, and
  `Workers heartbeat` now take their single/scalar args from the command's
  `arguments` string, so they're typeable from the REPL (e.g. `command_node
  topologies get Home`). The JS callers were updated to match. The genuinely
  structured verbs (`Topologies save`'s TSL, `Layouts save`'s position map,
  `Workers restart`'s type array) still use `payload`.
- **Per-node logging on `Node`.** `Node` now owns `stderr()` / `print_less_often()`
  / `print_least_often()` with a real `log_midfix()` (a `<name>: ` tag, ported
  from Tachikoma `Node.pm`); node-context callers use `$this->…`, and `Core`
  remains the no-`$this` fallback (process-global, untagged).
- **Dropped the "forbidden verb" list.** Control-flow keywords (`if`/`while`/…)
  are no longer special-cased; they flow through as ordinary commands and the
  target CommandInterpreter answers `unknown command: <verb>`. `Shell::validate_line`
  now only flags a structural error (unterminated backslash continuation).

- **Single path menu in the console header.** The Topology + Partition selectors
  are replaced by one "Path" menu listing `/`, `/_sse`, and `/_sse/{topology}.p{N}`
  for each worker. Selecting a worker re-subscribes the SSE and `cd`s there; `/`
  and `/_sse` just move the cwd. The menu also surfaces an off-menu cwd (set by a
  REPL `cd`) as its own option so the control always reflects the real location.
- **The EDIT button is hidden unless the cwd is a worker** (`_sse/{worker}`); the
  local (`/`) and request-scope (`/_sse`) graphs aren't editable.
- **`dump_node` leads with the node's class name.** `Node::dump_node()` now
  carries the runtime class (subclass-aware); `cmd_dump_node` heads the dump with
  it and returns a display string (no longer a structured array). `_http` stays a
  real, routable node — it's just not listed in the path menu.
- **The `_http` boundary stamps incoming messages server-side.** `HTTP_In` now
  `stamp_message`s every incoming `/command` message with `_http` (I/O-boundary
  stamping), instead of the client hardcoding the `_http` prefix. Clients send a
  bare reply path (`_output`, `_sse:{pid}/…`, or '') — `SseIn` and `CommandClient`
  no longer prepend `_http` to FROM. A side effect: a bare-FROM command (e.g.
  `cd /_http`) now gets `_http/_output` stamped on, so its reply routes back.
- **Dropped the dead `interval` SSE query param.** The stream server fixes its own
  cadence (`HEARTBEAT_MS`) and never read `interval`; removed it from the
  `SseConnector` URL/ctor and `useConsoleGraph`.

### Fixed

- **Live-mode Inspector verb modal: empty node picker + blacked-out dropdowns in
  dark skins.** The `node_name` arg `<select>` in the live verb modal was wired to
  an empty list — it now draws from the live graph (`parsed.nodes`, minus the
  inspected node), so worker-target pickers populate. And native `<option>`
  popups had no theming, so in dark skins the dropdown rendered dark-on-dark when
  opened; `.topology-app select option` now follows `--paper-2`/`--ink` (fixes the
  verb-modal selects and the header Path/Skin menus). The modal `<select>` *field*
  itself also blacked out on focus in Safari (WebKit paints native selects via
  `-webkit-text-fill-color` and ignores the themed background) — `select.topology-edit-row__input`
  now strips `appearance` + pins `-webkit-text-fill-color` + supplies a chevron,
  matching the header select. Its focus ring was also WordPress-admin blue (a
  `box-shadow` glow) — now a themed `--oxide` `:focus-visible` outline with the WP
  glow suppressed, matching the header. The remaining blue-focus holdouts — the
  "+ add target…" chip select (`.topology-edit-add-chip`) and the Send-message
  modal input (`.topology-modal__input`) — get the same `--oxide` ring too, so
  every focusable control in the console is consistent. The header Path/Skin
  selects also suppress WP's focus glow (it rendered as white edges around the
  oxide ring).
- **Canvas polls targeted a deep sub-node instead of the worker.** `dump_metadata`
  / `uptime` are worker-level polls; they now target the LCP (the longest worker
  menu item that prefixes the cwd — the path the menu selects) rather than
  `shell.path`, so `cd`-ing into a worker's sub-node keeps the canvas/uptime
  polling the worker interpreter. Non-worker cwds (local, `_sse`, `_http`) poll themselves.
- **`cd` didn't echo in the console transcript.** `cd` parses to `null` (it only
  moves the cwd), so the transcript echo — which sat after the null-return — was
  skipped, unlike every other builtin. The echo now happens before the return
  (blank lines stay silent), so `cd <path>` shows in the transcript like `ls`.
- **Path menu listed inactive topologies.** The console's Path menu now lists
  worker entries only for ACTIVE topologies (inactive ones have no live workers
  to reach); an off-menu cwd is still surfaced separately. Matches the active
  state the edit-mode Open modal already shows.
- **Modals were blinding in dark skins.** The modal backdrop used `var(--ink)`,
  which flips to a light color in dark skins and *brightened* the screen instead
  of dimming it; it's now a fixed dark wash. The modal header fully inverted
  (`--ink` background), becoming a bright strip in dark skins; it now sits on the
  theme surface (`--paper-3`) with an accent underline. Both read correctly in
  every skin.
- **Topology Console reconnected to `/messages/stream` every ~minute.** The console
  subscribes to a worker partition (60s aggregator slot TTL) but never poked
  `workers/heartbeat`, so its SSE slot lapsed and `check_slot` tore the stream down.
  It now pokes on the same half-TTL cadence as the dashboards — and, because its slot
  lives at the worker's partition (not the browser pool's `-1`), the poke carries
  `partition` so it touches the right slot.

### Added

- **Topology Console skin menu.** A header picker switches the console between the
  current drafting-plotter skin and 12 alternatives (Cyanotype Blueprint, CRT Phosphor
  Terminal, Swiss Brutalist, Synthwave Outrun, Nord Frost, Aurora Glass, Solarized
  Workshop, Botanical Naturalist, Bauhaus Constructivist, Neo-Tokyo HUD, Pastel Toy,
  Control-Room SCADA). The choice persists per browser (localStorage). The stylesheet
  was refactored to CSS custom properties so each skin is a token-override block with
  no change to the default look.
- **Topology Console chrome polish.** Header menus and edit/modal form controls now theme
  over the WordPress-admin defaults (no white boxes on dark skins; focused text stays
  legible via `-webkit-text-fill-color`); the REPL terminal stays monospace on every skin
  (`--font-terminal`); the prompt bar shares the transcript's frosted material; the
  prompt placeholder no longer lists example commands; and the prompt input drops
  WordPress-admin's blue focus ring (the brass caret signals focus instead).

### Security

- **Command authorization (two-tier).** A `TM_COMMAND` arriving on an untrusted
  path can no longer execute. Client tier: a `Message::LOCAL` provenance field,
  set only by a `Shell` and stripped at the wire boundary by `packed()`/`pack()`,
  so an SSE/IPC-injected command lacks it and is refused. Server tier: `/command`
  and pivoted `wp nodes cli` HMAC-sign command semantics; worker and request-scope
  CommandInterpreters verify the signature (windowed, with single-use nonces) and
  refuse unsigned/forged/replayed commands. Every command is gated.

### Changed

- **`cd` navigation in the REPL/console (browser + cli).** The shell path is a
  node-graph tree you walk with `cd`: `/` is the local in-browser graph, `/_sse`
  the HTTP/SSE session boundary, `/_sse/{worker}` a worker (cli: `/` local, then
  the worker mounts as a named node). The prompt reflects the cwd (per-transcript
  entry, so history doesn't rewrite on `cd`), and the canvas + `ls`/`dump_metadata`
  show the nodes at the current path — local graph, request-scope graph, or worker
  graph. The browser interpreter gained local `ls`/`list_nodes`/`dump_metadata` verbs.
- **`_sse` is the bidirectional session node; replies are per-session private.** A
  console command's reply pivots through `_sse:{pid}` (`HTTP_Filter` matches that
  head) so only the originating session sees it; the synchronous `/command`
  response is fed back into the receive graph (`HttpOut` → `_sse`, which strips its
  own `_sse:{pid}` head). Routed-onward commands return a bare `202` (no body).
- **The Router has no sink.** It routes solely by peeling `TO` and drops what it
  cannot peel (empty/unknown head → `NOT_AVAILABLE`); setting a sink on it now
  throws. `HTTP_In` routes incoming `/command` messages through the base
  `_command_interpreter` (which interprets an empty-`TO` command and forwards the
  rest to `_router`), mirroring the client's `Shell → interpreter → _router` spine.

## [0.3.0] - 2026-05-22

### Fixed

- **Text-field reset buttons (Base Directory, Memcache Servers) now clear** — they were wired to an unbound `data-field`; switched to `data-newspack-nodes-reset-target`, which `render_reset_button_handler` binds.
- **Empty Topology Console canvas.** The request-scoped `/command` graph never
  mounted worker-input Partitions, so the dashboard's pivoted `dump_metadata`
  poll hit `NOT_AVAILABLE` and never reached the worker. The canvas now batches
  a `connect_worker_input` verb ahead of its command (same JSONL request),
  mounting only the one named worker via the new targeted
  `Bootstrap::register_worker_partition()` (validates the client-supplied reader
  id; idempotent). The reply also failed to parse due to the double-encoding
  fixed below.
- **cli REPL emitted a stray trailing newline** in TTY mode.

### Changed

- **Caching is the single shared `Core::$memd` handle — no `Cache_Interface`.**
  `Core::$memd` (a raw `\Memcached`, built once by the app bootstrap) is the one
  caching handle; the app-side `Cache_Interface` / `Memcached_Cache` abstraction
  is gone. `Sse_Slot_Pool` reads `Core::$memd` directly (its `wire()` installs
  the `SSE_Out` seams), and `Workers_CI`'s injected cache is now just a
  `\Memcached`-shaped object (or null). The `FakeMemcached` test helper is a
  duck-typed `\Memcached`-method double for `Core::$memd`, not a `Cache_Interface`
  implementer.
- **The Topology Console runs a real in-browser node graph (In/Out nodes).**
  Send: `Shell` → `_command_interpreter` → `_router` → `_http` (`HttpOut`, POSTs
  `/command`). Receive: `_sse` (`SseIn`) → `_router` → `_output` (`Dumper`,
  transcript-only) / `_metadata` / `_uptime`. The `Shell` stamps
  `FROM=_http/<ssePid>/_output` so a worker reply pivots back to the transcript,
  and `Dumper` renders structured replies (`dump_node`, etc.) as pretty JSON
  instead of `[object Object]` / dropping them. ONE positional Message format
  throughout (the `{type,…}` object shape is gone). React reads node state via
  `useNodeState`/`useNodeFill`; `SessionSink`, the `dumperRender`/`shell` utils,
  and the orphaned `useTopologyStream`/`sendCommand` modules are deleted.
- **In/Out boundary nodes.** `Command_Controller` + `HTTP_Out` merged into
  `HTTP_In`, and `Messages_Stream_Controller` → `SSE_Out` — each one substrate
  `Node` + REST controller. `HTTP_Filter` strips the pivot pid; the shared
  `Message::split_first()` is the canonical TO-head peel (`Router` + `HTTP_Filter`).
- **Shared-canonical reserved node names.** `Node_Names` (PHP) +
  `reserved-node-names.json` (imported by the JS graph) name the eight reserved
  nodes from one source; `NodeNamesTest` is the bidirectional drift guard.
- **`TM_*` flag renumber** — `TM_STRUCT=16`, `TM_REQUEST=128`, `TM_RESPONSE=256`
  (contiguous bit sequence). A reply to a `TM_REQUEST` is `TM_STRUCT|TM_RESPONSE`,
  not an echoed `TM_REQUEST`.
- **Command protocol no longer double-encodes the Message `VALUE`.** Command and
  response `VALUE` carry a structured array (`{name, arguments, payload}` /
  `{name, payload}`); verbs return live PHP structures, not `wp_json_encode`'d
  strings. The only `json_encode`/`json_decode` is the message envelope/wire
  (`Message::packed`/`unpacked`, the SSE/HTTP frame). `TM_COMMAND` stays
  `TM_COMMAND` — not conflated with `TM_STRUCT`. Mirrored in JS
  (`command_client`, `unwrapCommandResponse`, `parseMetadata`, the
  `command_interpreter` port).
- **`/command` batch body is JSONL** (one packed Message per line), posted as
  `text/plain` — a multi-line body sent as `application/json` is rejected by
  WordPress's REST dispatcher before the handler runs.
- Topology Console polls `dump_metadata` + `uptime` as one batched request
  behind a single `connect_worker_input` (was two requests + two mounts);
  `cmd_dump_metadata` uses a `get_class` basename instead of `ReflectionClass`
  on the per-poll path; the topology-console `unwrapCommandResponse` re-exports
  the canonical copy instead of duplicating it.
- Renamed `sendInterpretedCommand` → `sendWorkerCommand`, `shellInterpret` →
  `shell`.

## [0.2.9] - 2026-05-20

### Changed

- **Deleted `TopologyStreamController`; the Topology Console now rides the
  generic `/messages/stream` + `/command` endpoints.** The console subscribes to
  the worker's broadcast IPC partition (`subscribe={topology}.p{N}`, resolved by
  `open_subscription` → `Cli::attach_to_worker`) and sends commands — plus its
  1s/5s `dump_metadata`/`uptime` canvas poll, now client-side — through
  `/command`, pivoted via `FROM=_http/<ssePid>` (the pid from messages-stream's
  `connected` envelope). Removes a redundant ~440-line SSE controller + its two
  test suites. No new endpoints; the substrate already supported all of it.

## [0.2.8] - 2026-05-20

### Changed

- **Shared `useMessageStream` hook no longer sends an `interval` query param.**
  Completes the client side of the 0.2.7 server-side removal — the hook (and the
  RawLogs dashboard's 100ms cadence) dropped it. Cadence is server-owned
  (hardcoded 2s); synced to sibling plugins via `sync-shared.sh`.

## [0.2.7] - 2026-05-20

### Changed

- **Removed the `interval` query param from `/messages/stream`.** The heartbeat
  cadence is now a hardcoded `HEARTBEAT_MS = 2000` constant, not client-
  configurable. Data flushes every drain tick regardless, so `interval` only
  ever paced the idle heartbeat — callers no longer pass it.

## [0.2.6] - 2026-05-20

### Changed

- **`/messages/stream` heartbeat default lowered to 2s** (from the 5s set in
  0.2.5). Matches the dashboard's default refresh, so the aggregator's "Server
  HB" reads 0–2s; still ~4× less idle traffic than the old 500ms.

## [0.2.5] - 2026-05-20

### Changed

- **`/messages/stream` heartbeat interval now defaults to 5s** (was 500ms).
  Since the SSE flush fix, data flushes every drain tick regardless, so the
  interval only paces the idle keepalive — 5s is ample for browser and machine
  consumers and ~10× less idle traffic (each heartbeat drags a 4KB flush
  comment with it). Callers no longer pass `interval`; the aggregator and the
  dashboards both rely on this single default.

## [0.2.4] - 2026-05-20

### Changed

- **Consolidated the two parallel SSE traits into one `SSE_Stream_Trait`.**
  `SSE_Helpers_Trait` (messages-stream) and `SSE_Stream_Trait` (topology) were
  near-duplicates with subtly different wire contracts. Kept the canonical body
  (matches the legacy `SSEControllerBase`: inline `flush()` in `send_sse_event`,
  no-space `:` flush-comment framing the dashboard hooks expect) under the
  `SSE_Stream_Trait` name; both stream controllers now share it.
- **`send_sse_event()` throws `InvalidArgumentException` on an event name that
  sanitizes to empty** rather than emitting a nameless `event:` line the client
  would silently treat as a default `message` — fail-loud per the error policy.
  Partial-unsafe names still sanitize-and-continue.

### Fixed

- **SSE message streams now flush payloads through proxy buffers.**
  `Messages_Stream_Controller::run_stream_loop()` emitted events but never
  called `flush_if_needed()`, so the `FLUSH_SIZE` padding comment that pushes
  data past fastcgi/nginx buffers never fired — opening a stream URL showed
  nothing until ~4KB of real data accumulated. It now flushes after the
  `connected` envelope and on every drain tick (before the event loop sleeps),
  matching `Topology_Stream_Controller`.

## [0.2.3] - 2026-05-20

### Changed

- **`Message::unpacked()` now rejects malformed wire data instead of silently
  substituting an empty message.** It throws `InvalidArgumentException` unless
  the payload decodes to exactly a 7-element positional array (previously it
  returned `new_message()` for any non-conforming input, masking on-disk
  corruption). The on-disk readers in `Consumer` (cursor seeding + the drain
  loop) catch and skip the bad entry — with a rate-limited log — rather than
  abort the poll/construction.
- **Rate-limited logging reworked to match the Perl Tachikoma reference.**
  `print_less_often` emits on first sight; `print_least_often` emits at the
  10th occurrence; both re-window when `Core::prune_logs()` (called each Router
  tick) ages `recent_log_timers` entries past `log_timeout`. This replaces the
  never-pruned `$print_table`, which grew unbounded in long-running workers.
  `Core::$recent_log` now keeps a bounded 100-line stderr tail, surfaced via a
  new `dmesg` CommandInterpreter verb (port of Perl Tachikoma's `dmesg`).

## [0.2.2] - 2026-05-19

### Fixed

- **Supervisor restart button on the Workers dashboard now actually restarts.** `Cli::ls_workers()` only enumerates `{type}.p{N}.lock.d/` directories, so the supervisor (which lives at `supervisor.lock.d/` without a partition suffix) was absent from the worker list `restart_workers` walked, and the dashboard's `types: ['supervisor']` filter never matched anything. Restart now routes through a dedicated `Cli::restart_supervisor()` — the verb peels `'supervisor'` off the type filter, drops the restart flag at the un-suffixed lock dir, and delegates the rest to `restart_workers`.

### Removed

- **`newspack_nodes/standalone_workers` filter, `is_standalone` branch, and the "standalone workers" abstraction.** Originally an extension point for plugin-registered non-partitioned worker groups, but the supervisor is the only such worker in practice — the abstraction never grew the second user that would justify it. Cleaning up makes the surface honest: the supervisor is the supervisor, partitioned workers are partitioned workers, no fuzzy middle category. `Cli::restart_workers` simplifies to partitioned-only; `Workers_CI::collect_dump_metadata` returns a single `supervisor` object instead of a `standalone[]` array; `Workers_CI::build_standalone_status` becomes `build_supervisor_status` (fewer parameters); the helper enumeration plumbing is gone. JS: `StandaloneWorkers` component becomes `SupervisorStatus`, CSS classes renamed from `standalone-worker-*` to `supervisor-*`. Apps that depended on `newspack_nodes/standalone_workers` (none in this codebase) would need to roll their own equivalent — but a worker that's neither the supervisor nor a partition fleet probably wants to be modeled as a partition fleet anyway.

## [0.2.1] - 2026-05-19

### Fixed

- **`WorkerStatus` dashboard renders per-log `segment_size` correctly.** `buildRenderPlan` was dropping the `segment_size` field off log catalog entries before passing them to `LogSection`, so every SegmentBar rendered against the global default (64 MiB) instead of the per-log cap. Logs declared with a hardcoded 1 MiB segment_size in their TSL (`completed.log`, `gyroscope.log`) rendered as ~1.5% full at 1 MiB instead of ~100%. Threading restored through all three plan-push sites (`logsCatalog`-fallback, step-walking `renderLog`, and the catalog tail-append pass).

### Changed

- **`Log_Cleaner` now computes the topology-derived `expected_basenames` set itself; the `newspack_nodes/expected_log_basenames` filter receives that set as its input.** Inverts the prior contract where applications computed the full set from scratch (active topologies, running workers, topology-to-basename lookups, runtime basenames) and the substrate passed `[]`. That asked the application to be a partial reimplementation of substrate state — which it got wrong twice (`$config['topologies']` reading the app's file-default list instead of the operator overlay, then again after the v0.2.34 patch where the app started reading substrate state). New shape: substrate publishes its truth as the filter input; application callbacks extend it with runtime-pinned basenames they manage outside the topology graph (`firehose` / `jobintake` in `newspack-event-logger-nodes`). New public `Log_Cleaner::expected_basenames( $base_dir )` is the single source of truth; the `Workers_CI::cleanup_status` diagnostic verb uses it too so dashboard output and cleanup decisions never diverge.

## [0.2.0] - 2026-05-18

### Changed

- **TM_COMMAND wire format: `arguments` is a literal CLI tail, `payload` carries structured data.** Restores the Tachikoma contract that drifted when the M3 dashboards' dispatcher started `JSON.stringify(args)`-ing every command and verb handlers grew matching `json_decode($args)` calls. The wire was triple-encoded for any structured argument (outer envelope JSON → VALUE JSON → arguments JSON), every layer paying for the same trip just to ship an object. Now: `arguments` is the literal string a Shell would produce by peeling the verb name off the front of a command line (the way `make_node ClassName name "ctor args"` always worked); `payload` is the structured-data slot in the VALUE struct, used by verbs that genuinely need more than a positional argument line (dashboards' settings-update / layouts-save / workers-restart all migrated). `CommandInterpreter::interpret()` no longer round-trips through `execute()` to reglue + re-split name+args; it dispatches directly via a new `dispatch( name, args, envelope, payload )` method. `CommandInterpreter::execute()` deleted (~180 test callers migrated to `dispatch( 'verb', 'args' )`). `Service_CI::decode_args()` deleted; the four substrate Service_CI subclasses (Workers_CI, Topologies_CI, Layouts_CI, Raw_Logs_CI) read structured data from `$payload` directly. JS `CommandClient.send( { to, verb, args, payload } )` takes `args` as a string (default `''`) and an optional structured `payload`; dashboards pass `payload: { ... }` where they used to pass `args: { ... }`. Verb closure signature gained `mixed $payload` as the 4th positional; 3-parameter closures keep working unchanged (PHP silently drops extra positional args). `Message::value_size()` deleted — the right primitive for "how big is this message" is `Message::packed_size()` (on-wire bytes); the body-size caps in Layouts_CI / Topologies_CI verbs now check `Message::packed_size( $envelope )` against `MAX_BODY_BYTES`. 1420 substrate tests pass; browser smoke confirms topology console save/load, workers restart, raw logs streaming all work on the new wire.

- **JS build toolchain: replaced `@wordpress/scripts` with esbuild + standalone tooling.** `npm run build` now runs `scripts/build.mjs` (esbuild + sass + rtlcss, ~200 lines) instead of webpack via wp-scripts. The script implements two small esbuild plugins: WordPress externals (rewrites `@wordpress/*` and `react/jsx-runtime` imports to `window.wp.*` / `window.ReactJSXRuntime` reads, and records the WP enqueue handles for `index.asset.php`) and Sass compilation; the runtime alias is now a one-line esbuild `alias` config rather than a plugin. Build outputs are structurally identical to wp-scripts: `index.js`, `index.css`, `index-rtl.css`, `index.asset.php` per entry, with the same WP enqueue handles. Other wp-scripts subcommands replaced too: `wp-scripts test-unit-js` → `jest` (standalone config + babel-jest), `wp-scripts lint-js` → `eslint` (still using `@wordpress/eslint-plugin/recommended` directly), `wp-scripts lint-style` → `stylelint` (still using `@wordpress/stylelint-config/scss-stylistic`), `wp-scripts format` → `prettier`. `prettier` is installed via the `npm:wp-prettier` alias so `@wordpress/prettier-config`'s `isWPPrettier` detection still triggers the `parenSpacing: true` style — without the alias, lint-as-prettier flags 4500+ existing files for missing-space-inside-bracket formatting. `webpack.config.js` deleted. `package-lock.json` shrinks from 2024 packages to 1236; `npm audit` goes from 11 alerts (1 moderate, 10 high — none fixable without breaking-change `@wordpress/scripts` downgrade) to **0** after pinning the deep `@typescript-eslint/typescript-estree` minimatch transitive to ≥9.0.7 via a scoped npm override. All 189 jest tests still pass; all three admin dashboards (Topology Console, Workers, Raw Logs) render and function identically in the browser; bundle bytes match within 3% of the wp-scripts output.

### Added

- **`Topology_Registry::segment_size_overrides_for( $name )` + per-log `segment_size` on `workers.dump_metadata`.** Topologies that hardcode the Partition `segment_size` positional arg (e.g. `completed.log` / `gyroscope.log` declared with literal `1048576` instead of `<config:segment_size>`) now surface that override per-log in the dashboard payload. Workers_CI builds a `{basename → int}` map by iterating `Bootstrap::get_topologies()` and unioning `Topology_Registry::segment_size_overrides_for()` results, then attaches `segment_size` to each entry returned by `enumerate_logs`. `WorkerStatus.js`'s `LogSection` consumes `item.segment_size` for the per-log "max segment size" indicator, falling back to the global default when no override is set. Memoized like `basenames_for`; cache cleared by `reset_basename_cache()` / `reset()`.

- **Workers + Raw Logs admin dashboards moved here from `newspack-event-logger-nodes`.** Both surface substrate state — worker fleets, raw on-disk log segments — so they belong in the substrate. `Workers_CI` (`workers`) and `Raw_Logs_CI` (`raw-logs`) register via the standard `request_graph_ready` mount alongside Classes/Layouts/Topologies. The Workers cache (memcache live-position lookups + SSE-slot heartbeat verb) comes from a `newspack_nodes/workers_cache` filter — applications fill it in (e.g. event-logger-nodes wires its `Memcached_Cache`); a null cache falls back to on-disk offsetlog reads exclusively. Submenus appear under the "Nodes" top-level menu alongside the Topology Console.
- **`sync-shared.sh` (run via `npm run sync` from `npm run build`).** Canonical React utilities — `commandClient`, `unwrapCommandResponse`, `usePageVisibility`, `useMessageStream`, etc. — now live under `src/shared/`. The script copies them into sibling plugins that need the same utilities (currently `../newspack-event-logger-nodes/src/shared/`) with a "Synced from..." header so PreToolUse hooks block accidental hand-edits to the copies. Restored from the legacy `newspack-event-logger-plugins` monorepo's pattern. `sync-shared.sh` is in `.distignore` — not part of the installable zip.
- **`webpack.config.js`.** Aliases `@newspack-nodes/runtime` to `src/runtime/` so the now-substrate-owned event-dashboards bundle and the existing topology-console bundle both resolve runtime imports the same way the app bundles do.

### Fixed

- **`Cli::restart_workers()` handles non-partitioned standalone workers.** Standalone workers like the supervisor live at `{locks}/{type}.lock.d` (no `.pN` suffix), but `restart_workers` always built `{type}.p0.lock.d`, so the Workers dashboard's restart button silently no-op'd for supervisor / stream-merger / health-check rows while partitioned-fleet restarts worked fine. The dashboard sends `partition: null` for these rows (matches `Workers_CI::build_standalone_status`); the fix peels that case off the front of the loop and uses the un-suffixed lock dir.

- **Supervisor arms Log_Cleaner once per lifecycle.** Orphan log directories were lingering on disk for topologies the operator had toggled off — `completed.log`, `errors.log`, `flames.log`, `gyroscope.log`, `requests.log` all sat unused on `datapoke1.newspackstaging.com` despite only `firehose-jobs-only` + `job-workers` being active. Root cause: `Log_Cleaner::cleanup_orphan_partitions` runs only when the substrate-side `LOGS_DIRTY_OPTION` flag is set, and that flag was set only via `Supervisor::check_config`'s fleet-shrink diff (`prior_set` vs `current_set` from `FLEET_DESCRIPTORS_OPTION`). Any path where reality drifted from configuration but the persisted prior set already matched current — supervisor respawn between the operator-toggle and the cleanup tick, upgrade from a substrate predating Log_Cleaner, manual `wp option update` — silently kept orphans forever. Fix: `tick_loop` arms the dirty flag once at boot (before the loop), so every supervisor lifecycle guarantees one reconciliation sweep. Steady-state behavior unchanged — subsequent ticks within the same process don't re-arm; the diff branch still catches mid-run shrinks. New test `test_tick_loop_arms_log_cleaner_on_boot` exercises the lifecycle preamble with `FLEET_DESCRIPTORS_OPTION` pre-seeded to current set (no diff fires).

- **`/messages/stream` emits `heartbeat` SSE events during idle windows.** The M6 migration deleted the legacy `/topology/stream` controller (which had its own heartbeat tick) without wiring an equivalent into the new `Messages_Stream_Controller::run_stream_loop`. Dashboards listening for the `heartbeat` event went silent on idle streams — the "last received" indicator stuck at the timestamp of the last `msg` event, even though the EventSource was still alive. Drain loop now tracks `microtime(true)` and emits a `{ ts }` heartbeat on the SSE channel every `interval` ms (the same `interval` query param the `connected` envelope echoes to the client). Without a forwarded `msg` event, the dashboard now sees regular heartbeats and renders "live" instead of "35s ago…".

- **`newspack_nodes_mount_substrate_cis` is now idempotent.** Production was hitting `PHP Fatal error: Uncaught RuntimeException: node name collision: workers already registered` on the `Command_Controller::dispatch` path — `make_node('Workers_CI', 'workers', ...)` throwing because all five substrate CIs (`classes`, `layouts`, `topologies`, `raw-logs`, `workers`) were already registered in `Core::$nodes_by_name`. The hook (`newspack_nodes/request_graph_ready`) fires once per dispatch by design, but something was re-firing it within a single PHP request (suspected: a bootstrap path that loads the plugin file twice; the exact mechanism is still unidentified). An early-return guard on `Core::node('workers')` makes the second call a no-op instead of fataling the REST response with a 500. New unit test `test_mount_substrate_cis_is_idempotent` exercises the double-invocation path; without the guard it errors with `node name collision: classes already registered` on the second mount.

- **`Partition::read_at` no longer rejects reads larger than 10MB; `MAX_READ_SIZE` deleted.** The 10MB cap was misapplied at the buffer-allocation layer and obscured what it was actually trying to do. A legitimate full-segment read of a long-lived offsetlog can exceed 10MB before the segment rotates — segment_size config defaults to 16MB. Pre-fix, `read_at($id, 0, $size)` silently returned `''` once the segment grew past 10MB, which broke three callers in different ways: (1) `Consumer::load_offsetlog` lost the checkpoint and reset cursor to (0,0) on restart, causing the worker to reprocess the entire upstream log; (2) downstream `Workers_CI::read_offsetlog_latest_entry` dropped the consumer row, hiding worker cards in the dashboard; (3) `StreamMerger::restore_position_for` fell back to the previous segment (often also >10MB), ultimately returning null and resetting the hub's cross-server position. Removed the cap from `read_at` (negatives still rejected; PHP's fread bounds memory by file size). Per-record DoS protection lives one layer up: `Consumer` / `Tail` already enforce `MAX_LINE_BUFFER_SIZE` (20MB) on the \n-delimited line buffer. The internal Consumer chunk-size budget moved out of Partition into `Consumer::MAX_POLL_BYTES` where it belongs (caps a single fread so giant segments drain across polls).

### Changed

- **`scan_index` no longer skips .idx files larger than 10MB.** Was using the same `MAX_READ_SIZE` cap; with that constant gone, the check is too. .idx file size is bounded by message-count per segment (8 bytes per packed entry, or one JSONL line per entry); a `segment_size`-bounded log produces a proportionally bounded .idx.

### Removed

- **`Bootstrap::register_standalone_workers()` — the map of singleton runtime workers.** Returned a single-entry array `{ supervisor: { class, partitions: false } }` consulted by `SpawnController` (validate_worker_type, validate_partition) and `Supervisor` (cleanup_lock_dirs candidate filter). With only one entry and no realistic extension path, the factory was scaffolding for a polymorphism that never arrived — every caller now inlines `'supervisor' === $type` at the one place it actually matters. Substrate stays simpler.

### Added

- **`Topology_Registry::reset_basename_cache()` — narrow invalidation tied to `Config::RESET_ACTION`.** Drops only the parsed-basename cache; keeps `$stock_dirs` + `$user_dir` intact so long-lived workers surviving a config reload re-read newly-edited TSLs without losing their registry lookups. Wired alongside the existing `Log_Discovery::reset()` hook in `newspack-nodes.php`. Pairs the two discovery primitives' invalidation behavior — both clear on the same signal, neither tears down state a worker needs to keep running.

- **`Log_Discovery::on_disk()` — substrate primitive for "what log directories exist."** Globs `{base}/logs/*.log/` and returns the sorted basename list (no `.log` suffix). Memoized per-PHP-process; invalidated on `Config::RESET_ACTION` so long-lived workers surviving a config reload pick up newly-created log dirs. Replaces the `newspack_nodes/num_logs` filter — admin "Total Log Storage" now counts directly from the discovery primitive, and applications no longer have to register a `+N` callback that drifts every time they add a topology Partition. Seven unit tests in `LogDiscoveryTest.php`.
- **`Topology_Registry::basenames_for(string $name): array<string>`** — parses a topology TSL's `make_node Partition` lines and returns the declared basenames (sorted, deduplicated, `.log` suffix stripped). Memoized per-topology. Applications' `expected_log_basenames` filter callbacks now derive their per-topology data from this method instead of a hand-maintained const map — the TSL is the single source of truth for what each topology writes. Nine unit tests in `TopologyRegistryBasenamesTest.php`.

### Changed

- **Admin "Total Log Storage" widget** counts log streams via `Log_Discovery::on_disk()` instead of `apply_filters('newspack_nodes/num_logs', 0)`. The `num_logs` filter surface is gone — adding a partition to a topology shows up automatically.

### Changed

- **`Messages_Stream_Controller::open_subscription()` stamps log-subscription Consumers with `{sub}.pN` (partition-aware) instead of plain `{sub}`.** Mirrors the existing IPC-subscription shape and surfaces the partition number to dashboard JS without a sidecar metadata channel — RawLogs (and other M6 dashboards) parses partition out of the Message FROM field. The IPC subscription shape (`{type}.p{N}`) is unchanged.

### Added

- **M6.1 / M6.2 — slot-pool seams on `Messages_Stream_Controller`.** Three static Closure properties (`$acquire_slot`, `$release_slot`, `$check_slot`) let applications plug in memcache-backed concurrency caps without bringing the cache interface into the substrate. Default: when the seam closure is unset, acquire returns slot 1 and release/check are no-ops (unmetered — same as the removed `M1 stub: $slot = 1`). `stream()` now acquires the slot BEFORE `init_sse_headers()` so a rate-limited connection can still return a JSON `WP_Error` with HTTP 429; the drain predicate consults `$check_slot` per iteration and aborts on false; `run_stream_loop`'s `finally` block calls `$release_slot` on every exit path including client disconnect. Partition is extracted from the subscription shape: `{type}.p{N}` IPC subs yield partition N; log subs default to -1 (shared browser pool). Six new unit tests in `tests/unit/MessagesStreamSlotPoolTest.php` pin the contract.
- **Docstring on the permission_callback pinning the capability-only gate (M6.1).** Explains why no nonce check belongs there — WordPress's REST `determine_current_user` filter resolves both cookie+nonce (browsers) and `Authorization: Basic` (RemoteSource Application Password cross-server pull) auth before the callback fires, so a "secure-by-default" nonce check would silently break cross-server SSE.

- **M4 dashboard #7 (topology-console) cutover to `/command` + final M4 milestone.** The topology-console React tree (the canonical substrate dashboard) now reaches all substrate state through `CommandClient` instead of three per-resource REST controllers. Rewrite landed at `05403b1`; deletion at `895ab89`. All 7 verbs (`classes.list`, `layouts.get`, `layouts.save`, `topologies.list`, `topologies.get`, `topologies.save`, `topologies.delete`) wired through one apiFetch path with `X-WP-Nonce` (the WP page nonce), and `Command_Controller::permission_callback` enforces `manage_options` on every dispatch — replacing the prior per-controller per-action nonce policy. Browser smoke-test confirmed live-mode topology renders with throughput, edit-mode populates the 15-class palette, and the EDIT-button POST returns 200.
- **M4 COMPLETE.** All 7 dashboards have migrated to the unified `POST /command` endpoint via `CommandClient`. ~30 `apiFetch` calls cut over across both repos. 14 legacy REST controllers deleted: 3 here (`ClassesController`, `LayoutsController`, `TopologiesController` — row 7) and 11 in `newspack-event-logger-nodes` (rows 1–6 in the app's `MIGRATION.md` running log). Reusable helpers established in both repos: `getCommandClient()` singleton + `unwrapCommandResponse()` peeler in `src/shared/utils/`. Pivoted-REPL POST (`TopologyStreamController`) + the 5 SSE controllers stay alive — `CommandInterpreter` dispatch is request/response only. Next: M5 — schema-parity verification + final SSE-controller deletion sweep.

### Removed

- **3 legacy substrate REST controllers — `ClassesController`, `LayoutsController`, `TopologiesController`** — and their 7 PHPUnit suites (`tests/unit/{Layouts,Topologies}ControllerTest.php`, `tests/integration/{Classes,TopologiesGet,TopologiesGetOne,TopologiesPost}ControllerTest.php`). Replaced by `Classes_CI` / `Layouts_CI` / `Topologies_CI` reachable via the unified `POST /newspack-nodes/v1/command` endpoint. `Bootstrap::register_rest_routes()` no longer registers them; the `use Newspack_Nodes\Rest\…Controller` imports are dropped. The 3-test gate in `M3BootstrapTest::test_legacy_*_controller_class_is_gone` enforces non-existence at the class-loader level so accidental re-registration trips CI.
- **`saveTopologyNonce` + `saveLayoutNonce` from the topology-console's localized data (`Admin::enqueue_topology_console_assets`)** — and their two corresponding `wp_create_nonce()` mintings. The rewrite reaches the substrate via `CommandClient` (apiFetch's `X-WP-Nonce` header carries the cookie nonce), and `Command_Controller::permission_callback` enforces `manage_options`; the body-borne per-action nonces are no longer a part of the request shape.

### Added

- **`newspack_nodes/request_graph_ready` action — applications mount service CIs here.** Fires from `Command_Controller::dispatch()` after building the request-scope graph (`_router`, `_command_interpreter`, `_http`). Hook signature: `function ( \Newspack_Nodes\CommandInterpreter $base_ci ): void`. Application plugins (the first being `newspack-event-logger-nodes`) hook this and call `$base_ci->make_node( $shell_name, $node_name, ...$ctor_args )` to atomically instantiate + name + sink each service CI in one step. The sink wiring is what closes the loop — verb responses walk back via `TO=FROM` through the base CI → router → `_http`. CIs registered without the sink (e.g. via a bare `register_class()` + manual name) silently drop their replies.
- **`Command_Controller::dispatch()` lazy-builds the request-scope graph.** REST requests to `/command` previously assumed some earlier entry point had already built the graph and returned 500 (`request-scope graph not initialized`) when none had. CLI/workers/SSE controllers each build their own; the REST path had no equivalent. The new `ensure_request_graph()` helper is idempotent — call sites that pre-build pay nothing.

### Added

- **`node_schema` advertises `accepts_fill` and `has_target` port flags.** Default Node returns both as `true`. Tail/Consumer override `accepts_fill: false` (pure producers — no upstream `fill()`); Partition/Log override `has_target: false` (terminal storage — no downstream forwarding). The substrate REST `/classes` endpoint passes both through; the topology canvas conditionally renders the IN / OUT port circles per flag, so Consumer/Tail nodes no longer show an unwired left-side input port and Partition/Log nodes no longer show an unwired right-side output port. Edit-mode wire-dragging naturally inherits the constraint — you can't initiate a wire from a port that doesn't render.
- **`Timer::node_schema()` merges from `parent::node_schema()`** so subclasses (Tail, Consumer, Partition) inherit the port-flag defaults through the Node → Timer → subclass chain.

### Added

- **`Log_Cleaner` GC for orphan partition + log directories, gated by a `newspack_nodes_logs_dirty` WP option.** The supervisor's `check_config()` arms the flag (non-autoloaded) when it sees the worker fleet shrink — either `num_partitions` was reduced or an entire topology was disabled — by comparing against the prior tick's `{type}.p{N}` descriptor set persisted in `newspack_nodes_fleet_descriptors`. `Log_Cleaner::cleanup_orphan_partitions()` short-circuits when the flag isn't set (steady-state ticks pay nothing) and clears the flag only when the sweep finished without a lock dir blocking any deletion — a still-running pre-shrink worker keeps the flag set until its lock dir clears.
- **Two-pronged sweep**: per-partition slices (`{base}/logs/*.log/p{N}/` and `{base}/offsets/*.p{N}/` where `N >= num_partitions`) are gated by the per-N lock-dir check; entire log directories (`{base}/logs/{name}.log/`) whose basename isn't in `apply_filters('newspack_nodes/expected_log_basenames', [])` are deleted outright — the substrate trusts the filter to keep a basename expected while its workers are still alive. All deletions route through `SupervisorBase::delete_directory_recursive()` for containment + depth-cap safety.
- **`Log_Cleaner::LOGS_DIRTY_OPTION` and `Log_Cleaner::FLEET_DESCRIPTORS_OPTION` constants** — option keys referenced from one place to prevent typos.
- **Topology console: conditional ports + canvas-dismiss + save-modal pre-fill.** `SchematicCanvas` reads the new `accepts_fill` / `has_target` schema flags off the class catalog (passed from `TopologyConsole`) and skips the corresponding IN / OUT port circle when the class declares it doesn't accept fill() / set target(). New `onBackgroundClickConsumed` prop lets the parent spend the first canvas click on dismissing the REPL prompt (blur + collapse) and defer the autofit to the next click. `TopologyConsole` lifts `inputRef` for the REPL prompt, runs a `refocusReplIfExpanded` rAF after node/edge selection so the "transcript visible ⟺ prompt focused" invariant survives the browser's default focus shift, and pre-fills the Save Topology modal with the current `topology` name (text auto-selected for easy rename — Save-as-rename is rare; one-click overwrite is the common case).

### Fixed

- **REPL footer's prompt input wires `onFocus → setExpanded(true)`** to maintain the invariant "transcript visible ⟺ prompt focused" on the input side. Click the prompt and the transcript pops open without a separate keystroke; programmatic focus restoration from the parent also passes through here. Deliberately no `onBlur → setExpanded(false)` — that would also fire when focus moves to a clicked node or Inspector button, collapsing the pane when we want it open. The blur half of the invariant is handled explicitly by the canvas-background-click consumer and the Escape key.

### Changed

- **`Topology_Registry::resolve()` / `describe()` / `list()` now filter via `is_file()` instead of `file_exists()`.** A directory at `{user_dir|stock_dir}/{name}.tsl/` no longer surfaces as a topology. PHP 8.0+'s `file_get_contents()` returns `""` on a directory path, which would have made the REST `get_topology` endpoint return a 200-OK with an empty body for a directory-shaped path — `is_file()` filters that at the source so callers take the `null → not_found` branch.
- **`Echo` now silently drops `TM_ERROR` messages with empty TO** (previously it called `set_state('DROPPED_ERROR', …)`). The drop was always the contract — the state set was noise that no other node consumed.

### Tests

- **Round-3 coverage push: 94.4% → 95.8% (4747/4955 stmts across 39 classes).** Paired-class deep-dive on `Cli_Command` (`Cli_Stdin_Reader::fire()` re-arm branches + readline-mode queued-line path), `Consumer` (`node_schema`, `next_offset` array/recent/end defaults, `open()` mid-loop match, `load_offsetlog` null guard, `poll` empty-source + skip-older-segment branches), `Node` (`dump_node` reflection-snapshot + sink-string/object/resource branches, `drop_message` NOT_AVAILABLE rate-limit, `notify` dead-listener prune), `Supervisor` (future-window token reject, heartbeat refresh, `reconcile_lock_dirs` rewrite guard, kill-readers MAX_PARTITIONS fallback), `Partition` (17 tests including `__destruct` flush via cleanup chain), and `TopologiesController` (new `is_file()` directory-rejection coverage).

### Added

- **3 substrate-side service CIs replacing `ClassesController`, `LayoutsController`, `TopologiesController`: `Classes_CI` (1 verb), `Layouts_CI` (2 verbs), `Topologies_CI` (4 verbs).** All reachable via `POST /newspack-nodes/v1/command` using the same `{type, to, from, id, value}` envelope the M2 application CIs use. `to` is the CI shell-name (`classes` / `layouts` / `topologies`); the substrate's `Router` peels it and dispatches to the named CI. Verb-by-verb args + return shapes are documented in [MIGRATION.md](MIGRATION.md#m3-substrate-service-cis--verb-reference).
- **All 3 CIs mount via the existing `newspack_nodes/request_graph_ready` hook** — symmetric with how M2 applications mount their CIs. The substrate's `newspack-nodes.php` registers a single mount callback (`newspack_nodes_mount_substrate_cis`) that calls `$base_ci->make_node()` for each CI. Named function (not closure) so test fixtures wiping `$GLOBALS['_wp_actions']` can re-attach without duplicating the mount logic.
- **M3 e2e dispatch test asserts every substrate CI responds via the unified `/command` endpoint.** `tests/integration/M3CommandDispatchE2ETest.php` drives one representative read-only verb per CI (`classes.list`, `layouts.get`, `topologies.list`) through the production `Command_Controller::dispatch()` path with `set_test_mode(true)`, captures the body via `ob_get_clean()`, and verifies the response carries the caller's correlation id and the `TM_COMMAND | TM_RESPONSE` flags (explicitly rejecting `TM_ERROR`). Mutating verbs are covered by per-verb tests — this one proves the dispatch path. Mirrors the application-side `M2CommandDispatchE2ETest` in `newspack-event-logger-nodes`.
- **`VerbHarness` test fixture (substrate side)** at `tests/Helpers/VerbHarness.php` for unit-testing CI verbs in isolation. `VerbHarness::fire( $ci, $name, $verb, $args_json, $key )` builds a fresh request-scope graph (`_router` / `_command_interpreter` / `_http`), wires the supplied CI through it, fires a TM_COMMAND envelope, unpacks the response, and returns the verb's decoded payload (auto-JSON-decoded when the verb returned `wp_json_encode(...)`; raw string otherwise). Ported verbatim from the M2 application-side harness — both use the same dispatch surface.

### Notes

- **`TopologyStreamController` stays as a REST controller** — SSE doesn't fit the synchronous `CommandInterpreter` model. SSE controllers each build their own request-scope graph and stream out of band; the `/command` endpoint is request/response only. Same reasoning applies to `MessagesStreamController` and `SpawnController`.
- **Legacy substrate REST controllers (`ClassesController`, `LayoutsController`, `TopologiesController`) remain alive until M5 deletion.** The M4 topology-console rebuild cuts over JS callers to the `/command` path; M5 removes the legacy controller files, their route registrations in `Bootstrap::register_rest_routes()`, and their PHPUnit suites.

## [0.1.31] - 2026-05-15

### Added

- **`;` is now a statement separator in both the JS topology-console REPL and the `wp nodes cli` REPL.** `help; ls` dispatches as two commands instead of being tokenized as `verb=help;` → `unknown command`. Same convention `Shell::split_statements()` already applied for TSL files via `Topology_Loader`. Single, double, and backtick quotes shield interior `;` from splitting.

### Fixed

- **Stray `tttt` text node in the REPL footer.** Literal text snuck into JSX during the resize-handle restructure (likely an errant paste while wrestling with tab indentation around the new fragment). React rendered it as a text-node sibling of `.topology-repl__transcript` and `.topology-repl__bar`, showing up as floating text just above the prompt bar.

### Removed

- **`show_sse` Shell builtin + the entire `Dumper::$broadcast_filter` machinery it was the only caller of.** Designed for opting cli sessions into a periodic stats fan-out; the dump_metadata polling route superseded it and the builtin has been dead code. Drops `Dumper::toggle_broadcast_filter()`, `Dumper::broadcast_filter_enabled()`, the broadcast-rescue clause in `Dumper::fill()`'s multi-session filter, six tests, and four stale comment references.

## [0.1.30] - 2026-05-15

### Added

- **`/` from anywhere in the live view focuses the REPL input.** Same convention as Discord/Slack/vim search. Pressing `/` over the canvas, header, palette, or any non-editable element jumps focus to the REPL and expands the transcript if collapsed. The literal `/` is preserved when typed inside an `<input>`/`<textarea>`/contenteditable so the shortcut doesn't steal slashes mid-edit.
- **Drag-to-resize transcript pane.** Top-edge handle (faint center bar, brass on hover) lets the operator size the transcript up or down. Default = 20% of the canvas area, clamped `[80px, full canvas]`; persisted to `localStorage` so the preference survives reloads.

### Changed

- **Transcript entries cluster at the bottom of the pane.** Terminal-style anchor — a few entries sit near the input bar instead of floating at the top of an otherwise-empty pane. Once entries overflow the pane, normal scroll kicks in and the existing scrollTop=scrollHeight effect keeps the newest line visible.
- **Esc now blurs the REPL input after minimizing the transcript.** Lets a subsequent `/` keystroke fire the focus-shortcut and re-summon the pane without clicking out first. Esc → minimize, `/` → restore: clean toggle.

## [0.1.29] - 2026-05-15

### Fixed

- **`Tail` actually delivers to `connect_node` targets.** `Tail::emit_message` bypassed `Node::fill`, so the `TO=target` stamp that `connect_node` relies on never happened. Every TSL topology wiring Tail downstream via `connect_node` (REPL tail, Log-as-sink, fan-outs) was silently emitting bytes to nowhere. Now routes through `parent::fill()` like Consumer does. Production-affecting for anyone using a Tail node.
- **Topology editor saves now include schema defaults.** Operator drags Partition from the palette, types only `base_dir` → save would strip the empty trailing positional slots and emit `make_node Partition flames:partition /tmp/flames.log` instead of the operator's intended `... /tmp/flames.log <partition> <config:segment_size> <config:num_segments> <config:max_lifespan>`. Topology_Loader then fell through to the PHP class's hard-coded literal defaults, silently ignoring the operator's substrate-config values. `serializeTsl` now takes an optional `schemas` map and fills empty positional slots from each spec entry's `default` before the trailing-empty trim. Same treatment for verb args.
- **Inspector int/float fields accept TSL substitution tokens.** `coerceValue` was falling back to `prevRaw` whenever `parseInt`/`parseFloat` returned `NaN` — silently swallowed every keystroke of `<partition>` / `<config:foo>`. Now only converts when the raw matches a pure-numeric regex; otherwise passes through as a string and lets the TSL loader coerce at load time. Also catches the lossy `parseInt('123abc')` → `123` case.
- **`send_node` / `send` REPL verb appends `\n`.** Line-oriented downstream nodes (Log, Tail) need each `send_node` payload terminated so consecutive sends don't run together on disk. Both the PHP `Shell` parser and the JS topology-console REPL apply this now; the two paths stay byte-identical on the wire. Mirrors Tachikoma `Shell.pm`.
- **Two stale VIP-lint warnings silenced on intentional code paths.** `Supervisor::fire_and_forget_post()` (raw curl is required because `wp_remote_post` clamps timeout to `max($timeout, 1)` second, defeating `CURLOPT_TIMEOUT_MS=10`) and `SupervisorBase::remove_stale_directory()` (substrate operates inside its own reserved base_dir tree).

### Added

- **`Node::dump_node(): array` is overridable for per-class redaction.** Reflection-based default snapshot logic moved out of `CommandInterpreter::cmd_dump_node` and onto `Node`, so subclasses can scrub secrets or synthesize derived fields before the dump hits the REPL. The motivating use case is in the application plugin: `RemoteSource` overrides this to return `[REDACTED]` for `auth_password` / `auth_token` instead of leaking raw credentials via `dump_node my_remote`.
- **TSL-substitution defaults on substrate schemas.** Consumer's `source_partition`, Topic's `num_partitions`/`segment_size`/`num_segments`/`max_lifespan`, and Partition's `partition`/`segment_size`/`num_segments`/`max_lifespan` ship with `<partition>` / `<config:*>` defaults. The editor pre-fills the same tokens the production TSL uses; required-flags are preserved alongside.
- **`bytes_read` / `bytes_written` / `lgst_msg` actually populated for Tail, Log, Topic.** The dump_metadata columns existed and were emitted, but the underlying counters on `Node` were never incremented for these primitives — Inspector sparklines for them were dead lines. Tail's `poll()` now bumps `bytes_read`; Log's `fill()` bumps `bytes_written` and tracks `largest_msg_sent` (its fill bypasses `parent::fill`); Topic does the same per-Message via `Message::value_size`.
- **Two-way URL sync for `topology` + `partition` in the topology console.** Selecting from the dropdowns rewrites `?topology=<name>&partition=<n>` via `history.replaceState`; opening the page with those params initialises the selectors. Refresh / copy-link preserves the operator's current view. `replaceState` not `pushState` — these are filter toggles, not navigation events.

### Changed

- **Rate sparkline clamps `dt` to the nominal tick interval (1s).** When two `gui:auto` responses arrived bunched up (e.g. 100ms apart after a worker stall), `dCount / 0.1` produced 10× spikes on the auto-scaling sparkline. Worst case post-clamp is under-reporting on a genuinely fast tick; the prior nonsense peaks were worse for the auto-scale envelope.

### Tests

- **Coverage push: every class in `includes/` is now ≥80% statement coverage** (lowest is `WorkerCliCommand` at 80.0%; total moved from 80.2% → 90.5% across 39 classes). New test files: `ConfigUtilsTest`, `LayoutsControllerTest`, `TopologiesControllerTest`, `TopologyStreamControllerTest`. Existing files extended: Bootstrap, CliWorkerCommand, Consumer, Core, Shell, SseStreamTrait, Tee, integration/ClassesController.
- **`--enforce-time-limit` is the documented PHPUnit default.** Class-level `#[Medium]` raises the 1s budget to 10s for tests that legitimately sleep through production code.
- New jest coverage for `coerceValue`, `serializeTsl` (default expansion), and `shellInterpret` (send_node LF).

## [0.1.28] - 2026-05-15

### Fixed

- **Operator-selected topologies that aren't in the app's catalog now inherit the substrate's `num_partitions`.** `Bootstrap::get_topologies()` was synthesizing entries for these names with a hardcoded `default_num_partitions=1`, so e.g. a user with `newspack_nodes_num_partitions=2` who checks `aggregator` (commented out of the application's file-default `topologies` list) got `aggregator.p0` only — every other fleet ran p0+p1, but the aggregator's StreamMerger silently dropped partition-1-keyed firehose data. Synthesis now reads `Config::load_config()['num_partitions']` and passes it as the default, so an operator-checked topology sizes to match the rest of the stack.
- **Topology console partition dropdown sizes correctly for non-catalog topologies.** Same fix applied in `Admin::enqueue_topology_console()` — the partition dropdown for TSL files the operator could pick (but the app didn't ship in its catalog) was capped at p0 instead of inheriting the substrate's `num_partitions`.
- **Supervisor stops orphaned workers state-free, in one disk-driven sweep.** Previously: `kill_readers()` flagged workers of removed topology types (driven by an `$active_types` diff in `check_config`), and `cleanup_stale_partitions()` walked `[num_partitions, MAX_PARTITIONS)` for cold-stale dirs only — live workers in dropped partitions / unchecked topologies kept heartbeating forever, and a 2→1 transition that straddled a supervisor respawn boundary was invisible to the diff. Now `reconcile_lock_dirs()` runs every `check_config()` tick: one `glob()` over `{base}/locks/*.lock.d`, then for any dir that doesn't belong in the live fleet (`{type}.p{N}` where N >= per-type partition count, OR type isn't in `$active_types` at all, OR standalone-worker exception) it first attempts cold-removal, then drops a restart flag if the dir is still there. Replaces `cleanup_stale_partitions()` + `cleanup_orphan_type_locks()` + the `kill_readers()` call from `check_config()`; `Supervisor::kill_readers()` remains as a public deactivation-path API.
- **`reconcile_lock_dirs()` skips rewriting an in-flight `restart` flag.** Without the guard, every 15s tick stomped the file in orphan partitions until the worker actually exited — no behavioral impact, just wasted disk churn.

### Changed

- **`wp nodes types` reports the active topology set, not the app's published catalog.** Previously read `apply_filters( 'newspack_nodes/topologies', [] )` directly — so an operator-selected topology not in the app's catalog (e.g. `aggregator` for event-logger-nodes) would appear in `wp nodes ls` as a running worker but be denied by `wp nodes types`. Now reads `Bootstrap::get_topologies()`, matching what the supervisor actually spawns.
- **`Supervisor::fire_and_forget_post()` bypasses `wp_remote_post` for spawn POSTs.** WP's Requests library clamps the timeout at `max($timeout, 1)` second (`Requests/src/Transport/Curl.php:427` — a SIGALRM-resolver guard against curl's synchronous DNS) so a 4-spawn per-tick sweep used to serialize into 4+ seconds of blocked supervisor. The new helper uses raw curl with `CURLOPT_NOSIGNAL=1 + CURLOPT_TIMEOUT_MS=10`, returning in ~10ms regardless of how the spawn endpoint hangs. Tests inject a closure via `Supervisor::$curl_exec` so the existing `$_test_outbound_posts` capture keeps working — production never references that seam.
- **`Cli_Stdin_Reader::install_handler()` / `fire()` route libreadline through a swappable seam.** `Cli_Stdin_Reader::$readline_handler_install` and `$readline_read_char` default to the real libreadline calls; `tests/bootstrap.php` reassigns to no-ops so phpunit-in-a-terminal (where stdin/stdout ARE a tty, so `posix_isatty` gating is useless) doesn't get the prompt written to fd 1 and `readline_callback_read_char` doesn't block on real stdin. Production gates `$has_readline` on `posix_isatty(STDIN)` at the construction site — workers without a real tty never reach the seam at all.

### Removed

- **Substrate `Config` mode dispatching deleted.** `$option_schema_extended` was an empty placeholder after `memcache_servers` moved into core; the per-mode `$config` / `$config_full` cache pair, the `$mode` parameter on `load_config()`, and the `'full'`-only branch in `load_config()` are all gone. Single `$option_schema` array, single cache, single signature. Callers passing `'full'` cleaned up in 4 sites (`Admin`, `Cli_Worker_Command`, `Consumer`, and the app plugin's substrate calls).

### Added

- **`Config::RESET_ACTION` constant + broadcast.** `Config::reset()` now fires `do_action( self::RESET_ACTION )` so dependent Configs (e.g. `Newspack_Event_Logger_Nodes\Config`, which layers app overrides on top of substrate config and maintains its own merged-result static cache) can invalidate alongside us. Without that fan-out, the supervisor's per-tick `check_config()` only cleared the substrate cache, leaving the app's static cache showing stale `num_partitions` — the actual root cause behind the "only aggregator spawns when num_partitions changes" symptom this release fixes upstream.

### Tests

- **`phpunit --enforce-time-limit` is the documented default invocation.** AGENTS.md and the repository's test conventions now flag the flag explicitly. Tests that legitimately sleep through production code (`Lock` orphan grace, `Supervisor` tick_loop) carry class-level `#[Medium]` to raise the limit from 1s to 10s.
- **`$_wp_test_remote_posts` renamed to `$_test_outbound_posts`** — the old name implied the captures came only from `wp_remote_post`, but `Supervisor::$curl_exec`'s capture also writes to it now.

## [0.1.27] - 2026-05-14

### Removed

- **`Config::get_option_schema_core/extended()` filter hooks.** No plugin used `apply_filters( 'newspack_nodes_option_schema_core' )` or `…_extended` to extend the substrate's option schema; both methods are now inline `private static $option_schema_core/extended` arrays. Plugins still extend the application surface via the application's own Config class, just not by filtering the substrate's schema.
- **`Config::invalidate_cache()` and `Config::register_cache_invalidation()`.** The supervisor's `wp_cache_delete( 'alloptions', 'options' )` + `Config::reset()` pair (added in v0.1.25/0.1.26 at the top of every `check_config()` tick) handles option-snapshot staleness for the only consumer that actually needed the one-shot-on-`plugins_loaded` reset. Per-request callers don't have a long enough lifetime to need it.
- **`tests/unit/ConfigTest.php` tests for the removed filters and methods** (−60 lines).

## [0.1.26] - 2026-05-14

### Changed

- **`Core::emit_stderr()` promoted to public `Core::stderr()`.** Same body (re-entry guard + handler dispatch); now callable from anywhere a single line should be visible to the operator without going through the rate-limited `print_less_often` / `print_least_often` paths. Use this instead of bare `\error_log()` so the message routes through `Core::$stderr_handler` (worker → `_repl` conduit → cli session; tests → captured handler).
- **`cmd_log` (the REPL `log <msg>` builtin) routes through `Core::stderr()`.** Previously called `\error_log()` directly, which bypassed the stderr_handler entirely — operators typing `log foo` in a pivoted-cli session got nothing in their terminal because the message landed in PHP's error log, not the `_repl` Partition the cli was tailing. Now visible in the cli where it was issued.
- **`Supervisor` spawn-failure messages route through `Core::stderr()`.** Spawn POST failures (`spawn failed for <type>|<partition>`) and supervisor-respawn failures (`spawn_next_supervisor failed`) previously went to `\error_log()` and disappeared. Now they surface through the same handler chain as every other stderr message.
- **`Config_Utils` validation failures route through `Core::stderr()`.** Path-validation rejections (null byte, non-`.php`, outside allowed dirs) and config-file shape rejections now go through the handler instead of bare `\error_log()` — consistent with the rest of the substrate.

### Fixed

- **`wp nodes cli` (bare mode) now wires up a `_repl` echo node so `Core::stderr()` calls land in the cli session.** Previously the bare cli had no `_repl` registered, so the default stderr handler fell through to `\error_log()` and the operator saw nothing — defeated the purpose of `Core::stderr()` for any in-process diagnostic.

## [0.1.25] - 2026-05-14

### Fixed

- **Supervisor now sees operator option changes within 15s, not 595s.** The supervisor is a long-running PHP process — `wp_load_alloptions()` caches into a static `$alloptions` on first call and never re-reads, so option toggles in admin (`newspack_nodes_topologies`, `enable_logging`, partition counts) had no effect until the supervisor's natural respawn boundary. `check_config()` now drops `wp_cache_delete( 'alloptions', 'options' )` and calls `Config::reset()` at the top of every 15s tick, mirroring the legacy event-logger supervisor's preamble. Topology changes now propagate end-to-end in ≤ 15s (add) / ≤ 75s (remove + ghost cleanup).
- **Orphan-type lock dirs are reaped once the worker exits.** When `kill_readers()` flags a removed-topology worker to exit, the lock dir was lingering on disk forever — `wp nodes ls` and the topology console kept surfacing it as a stale ghost. New `cleanup_orphan_type_locks()` runs on every `check_config()` tick: scans `{base}/locks/*.lock.d`, skips standalone runtime workers and dirs whose type is still in the active set, then `remove_stale_directory()`s any whose heartbeat is older than `Lock::STALE_TIMEOUT` (60s). Live workers are never touched — the heartbeat-cold gate ensures we only collect corpses.

## [0.1.24] - 2026-05-14

### Added

- **DELETE button in the topology console header.** Appears in edit mode only when the currently-edited topology has a user-saved copy (`source: user` or `both` per `/topologies` list). New `DELETE /newspack-nodes/v1/topologies/{name}` endpoint removes the operator-saved file from `{user_dir}/{name}.tsl`; stock copies shipped by plugins are protected (the endpoint returns 404 if asked to delete a stock-only topology). After delete, if a stock fallback exists the topology automatically reverts to it; the success toast says which case happened. Same `save_nonce` permission gate as save.
- **Active topologies sort to the top of the console dropdown.** The supervisor's currently-spawned set (the merged `newspack_nodes/topologies` catalog + `newspack_nodes_topologies` operator overlay) is now grouped first, followed by the rest of `Topology_Registry::list()` alphabetically. New `activeTopologies` field on `window.NewspackNodesData` drives the order.

### Fixed

- **Edit mode renders class labels on node cards.** Live mode reads `n.class` from `dump_metadata` via `parseMetadata`; edit mode reads it from `parseTsl` / `draftGraph`. Both shapes write the same `class` field, but the canvas was reading `n.klass` — which `parseMetadata` had renamed to dodge nothing in particular. Normalized everywhere to `node.class`.
- **`Bootstrap::get_topology_catalog()` is no longer guarded by `class_exists()` from inside the substrate.** Same pattern as the earlier same-plugin guard cleanups: with the classmap autoloader, defending against load-order races for own-plugin classes is dead branch.

### Changed

- **Topology-console partition dropdown enumerates `Topology_Registry::list()`.** Previously sourced from `Bootstrap::get_topology_catalog()`, which only surfaced the app's file-default catalog — operators couldn't select TSL files they hadn't yet checked in the admin UI. Partition counts now come from the catalog when present, else synthesized from each TSL file's frontmatter via `Topology_Registry::synthesize_entry()`.
- **`/topologies` REST endpoint's `active` flag reads `Bootstrap::get_topologies()`.** Previously checked only the app-published catalog filter, so a topology the operator had checked but the app didn't ship in its catalog (e.g. `aggregator`) reported `active: false` despite the supervisor spawning it.

## [0.1.23] - 2026-05-14

### Fixed

- **`Bootstrap::get_topologies()` honors admin-UI topology selections that aren't in the app catalog.** The admin Topologies form renders every TSL file found by `Topology_Registry::list()`, but the bootstrap was intersecting the operator's selections against the app-published catalog from the `newspack_nodes/topologies` filter — silently dropping any name the app hadn't shipped as a file-default. Checking e.g. `aggregator` in the admin UI saved the option but the supervisor never spawned a worker for it. The bootstrap now falls back to `Topology_Registry` for selections not in the catalog, synthesizing an entry from the TSL frontmatter. Names that don't resolve to a TSL file are still dropped (typos / stale option values can't crash the supervisor).

### Added

- **`Topology_Registry::synthesize_entry( $name, $default_num_partitions, $default_stale_timeout )` helper.** Public, returns the same `{topology, num_partitions, stale_timeout}` shape the application's `newspack_nodes/topologies` filter callback was building inline. Applications can now call this from their filter instead of duplicating the frontmatter-read + shape-build logic.

### Changed

- Drops three `class_exists()` guards on same-plugin classes (`Topology_Registry` in admin × 2, `Config` in worker-cli-command). With the classmap autoloader, these defended against load-order races that can't happen.

## [0.1.22] - 2026-05-14

### Fixed

- **`build-release.sh` now runs `npm run build` before staging.** v0.1.21 shipped without `build/topology-console/` because the release script only ran `composer install` and rsynced whatever happened to be on disk — so if the developer hadn't built bundles locally before tagging, the zip carried no React tree. The substrate's admin enqueue then silently bails on the missing `index.asset.php` and the topology console renders an empty mount div. The release script now always builds bundles before rsync.

## [0.1.21] - 2026-05-14

### Fixed

- **Inspector renders `bool` ctor/verb args as text inputs.** Bool args were native checkboxes, which couldn't hold a substitution token like `<config:enable_aggregator>` — forcing operators to hand-edit TSL whenever a bool needed to come from config. Now they're text inputs with a `true | false | <config:...>` placeholder hint; the TSL loader / verb handler does the string→bool coercion at runtime, exactly as int and string args already do. Legacy stored boolean values (from the old checkbox UI) are stringified to `"true"`/`"false"` on render so existing layouts round-trip cleanly.

## [0.1.20] - 2026-05-14

### Changed

- **Substrate owns the `newspack_nodes_topologies` operator overlay.** `Bootstrap::get_topologies()` reads the `newspack_nodes/topologies` filter as a file-default catalog (what the application publishes), then applies the `newspack_nodes_topologies` WP-option overlay itself: `false` (never saved) → full catalog, `[]` → empty, array → intersection. New `Bootstrap::get_topology_catalog()` returns the unfiltered catalog for admin UI rendering. Previously, applications duplicated `get_option` logic inside their `newspack_nodes/topologies` filter callback — the substrate is the right place for substrate options.
- **Admin Topologies checkbox list + `↺` Load Defaults chip both read `Bootstrap::get_topology_catalog()`.** Single source of truth for what the application ships in its config file. Removes the parallel `newspack_nodes/topologies_defaults` filter that briefly existed for the chip.

## [0.1.19] - 2026-05-14

### Added

- **Topology console: save / reset layout.** Layouts decouple from topologies — TSL describes graph structure; the `.layout` file describes node positions, stored server-side at `{base_directory}/layouts/{name}.layout` via a new `LayoutsController` (GET/POST `/newspack-nodes/v1/layouts/{name}`) with a dedicated `newspack_nodes_save_layout` nonce. Save Layout (edit-mode only) persists the current pinned positions; Reset Layout shows when current ≠ default for the mode — in edit it clears overrides to `autoLayout` (with confirm modal), in live it reverts to the saved layout. Mode-transition auto-fit fires when re-entering live mode from a different topology or from a fresh reset, batching positionOverrides + viewport=null so the canvas's autofit-commit hook fires on the rebuilt bbox in one render.
- **Node schemas exposed for the Inspector.** `Topic`, `Log`, `Tail`, `Consumer`, `Hook` now declare their constructor arguments via `node_schema()`, so the topology console renders an editable form for each. `Log` adds the `rotate` verb. `Callback` and `Lock` flip to `category: 'Hidden'` — Callback wraps a PHP closure that can't be expressed in TSL or constructed from the GUI; Lock is an internal primitive used by `Partition::allow_large_writes()` and Worker lifecycle, not meaningful as a standalone graph node.
- **Topology admin UI mirrors the resolved fleet.** When `newspack_nodes_topologies` is unset (`get_option` returns `false`), the checkboxes pre-check the resolved `newspack_nodes/topologies` filter so an operator visiting a fresh install sees what's actually running. Once they save once, the option becomes authoritative (including `[]` = explicit "spawn nothing").
- **`<config:offsets_dir>` helper.** `WorkerCliCommand` now derives `offsets_dir` alongside `logs_dir` from `base_directory`, so TSL can reference `<config:offsets_dir>` directly instead of building `<config:base_directory>/offsets/...` inline.

### Changed

- **`Newspack_Nodes\Config_Utils` owns the sanitize / validate / path-guard primitives** every plugin's Config previously duplicated. Methods are public + static so tests call them directly. Substrate `Config` shrinks from 691 → 478 lines by delegating; the moved methods (`sanitize_option`, `sanitize_string`, `is_within`, `validate_config_values`, `load_config_file`) are gone from Config itself. `validate_config_path` stays on Config as a thin wrapper that injects its allowed-dirs list before delegating to Config_Utils.
- **`newspack-nodes-config.php` declares `base_directory` explicitly** instead of relying on the hardcoded `/tmp/newspack-nodes` fallback inside `Config::load_config_defaults()`. The fallback is gone — the config file is now the only source of the default.

## [0.1.18] - 2026-05-13

### Added

- **More `set_state()` coverage** so `debug_state <node> 1` produces a meaningful trace of failure modes and lifecycle moments instead of being effectively silent:
  - **`Router::fill`** — `NOT_AVAILABLE` set_state when a routed path's leading segment doesn't resolve to a node. `debug_state _router 1` turns "why isn't my message landing?" debugging from a guessing game into a per-failure trace.
  - **`Partition::fill`** — `DROPPED` set_state with `reason=oversize`, size, and max when a packed message exceeds `MAX_LINE_SIZE`/`MAX_LARGE_LINE_SIZE`. The most common "where did my message go?" mystery — the silent drop — is now visible.
  - **`Consumer::poll`** — `OVERFLOW` set_state with seg/off/limit when the DoS line-buffer guard fires. Mirrors the existing `print_less_often` stderr emission so debug_state observers see the same event.
  - **`Log::rotate`** — `ROTATED` set_state with the new rotated filename.
  - **`Log::prune_rotated`** — `PRUNED` set_state with the count of rotated files unlinked (only when something was actually pruned).
  - **`Echo::fill`** — `DROPPED_ERROR` set_state with the originating FROM when a TM_ERROR with empty TO is dropped (avoids bouncing the error trail to an unsuspecting producer).

## [0.1.17] - 2026-05-13

### Fixed

- **Partition was missing `largest_msg_sent` tracking.** Its `fill()` override (writes the packed message to disk) skipped the base `Node::fill()`'s `largest_msg_sent` update, so `stats` and `dump_metadata` reported 0 for every Partition. Now mirrors Node's tracking — measures `Message::value_size()` and updates `$largest_msg_sent` if the new size exceeds the previous max.

- **Consumer was missing `bytes_read` tracking.** Consumer's `poll()` reads bytes via `$this->source->read_at()`, which incremented the source Partition's `bytes_read` but not the Consumer's. Stats showed `read=0` for every Consumer despite Consumers being the user-facing read nodes. Now both increment in parallel: the Partition tracks file-system read volume; the Consumer tracks what surfaces in `stats`.

- **`cmd_uptime` was using `\date()`** for the clock segment, which the `WordPress.DateTime.RestrictedFunctions.date_date` PHPCS rule rightly flags as runtime-timezone-dependent. Switched to `\gmdate()` — UTC is more predictable across worker environments anyway, and the test suite doesn't assert on the clock portion so semantics are preserved.

### Chores

- **Locked `brainmaestro/composer-git-hooks` in `composer.lock`.** The dep was already declared in `require-dev` + `extra.hooks` config, but the lock file was never updated. `composer install --no-dev` (build path) short-circuits the post-install cghooks installer, so a regular `composer install` is the only path that wires `.git/hooks/pre-push`. Locking makes that one-shot setup deterministic.

## [0.1.16] - 2026-05-13

### Added

- **`dump_metadata` verb** — single JSON-encoded snapshot of every registered node's GUI-relevant state: `{ class, counter, sink, target, debug_state, arguments, lgst_msg, bytes_read, bytes_written }` per node. Designed for the topology console's per-tick poll (replaces the older `ls -als` + `ls -ct` pair); KEY-correlation through `Message::KEY` lets the controller distinguish auto-polls from user-typed commands silently. Inspired by Perl Tachikoma's `JSONvisualizer` node, but as a verb so it composes with the rest of the cli surface and skips the visualizer's caching layer (our poll cadence is already coarse).

- **`stats [-a] [<regex>]` verb** — Tachikoma-style tabular per-node counters with columns `NAME | COUNT | LGST_MSG | READ | WRITTEN`. Scope rules match `ls`: default shows siblings of this interpreter; `-a` shows every node; optional regex narrows by name. Dropped Tachikoma's `BUF_SIZE` and `HIGH_WATER` columns since we have no in-memory message buffers (Partition and Topic flush every fill into a per-node line buffer that drains synchronously).

- **`uptime` verb** — clock time on the left, time-since-`Core::reset()` on the right. Scale-aware compact format suited to our short-lived workers (~10 min lifespan): `up 42s` → `up 4m 07s` → `up 2h 35m` → `up 3d 04:05:06`. Trailing components zero-pad to two digits so the value width stays steady tick-to-tick.

- **`Core::$init_time`** — process start time, stamped at every `Core::reset()` (worker bootstrap, test setUp). `uptime` subtracts this from `Core::$now`.

- **Per-node observability counters on `Node` base.** `largest_msg_sent` (bytes, updated by `fill()`) plus `bytes_read` / `bytes_written` (populated by I/O nodes — Partition increments them in `loop_fwrite` and `read_at`; logic nodes leave them at 0). Tachikoma-equivalent of `$node->{largest_msg_sent}` / `bytes_read` / `bytes_written`. Surfaced by `stats` and `dump_metadata` alike.

- **`Message::value_size()`** — bytes of the VALUE field (strlen for strings, `wp_json_encode` length for arrays). Used by `Node::fill()` to track `largest_msg_sent` consistently across TM_BYTESTREAM and TM_STRUCT shapes.

- **`connect_node <node>` / `disconnect_node <node>` (no target) default to `$message[FROM]`.** Matches Perl Tachikoma: a `connect_node firehose:tee` from a cli/SSE session tees the node's output back to that session's Dumper without having to know the breadcrumb path. Stale targets self-clear when the worker recycles (~10 min in this deployment), so the lack of an explicit disconnect-on-exit signal isn't a real liability. Symmetric `disconnect_node <node>` (no target) removes the issuing message's FROM from a Tee's fan-out, exactly undoing a default `connect_node <tee>`.

### Fixed

- **`Tee::fill` was pruning path-shaped targets** (`_repl/_output/{pid}` and other slash-containing values). `connect_node firehose:tee` from a SSE session would report `ok`, the target would be added, then the very next `fill()` would drop it because `Core::node('_repl/_output/{pid}')` returned null. Now the path-shape check (`strpos === '/'`) skips the existence-lookup for path targets — they survive until the Router fails to deliver to the prefix, at which point normal error semantics apply.

## [0.1.15] - 2026-05-13

### Added

- **`CommandInterpreter` echoes `Message::KEY` from request onto its `TM_RESPONSE` / `TM_COMMAND|TM_ERROR`.** KEY is application-defined correlation metadata that now survives the round trip — a GUI client (the new event-logger-nodes Topology Console is the first consumer) can stamp `KEY='gui:auto'` on its own automated polls and recognize them on the way back without tracking IDs by hand or adding a TM_NOREPLY-style bitflag. Empty KEY (the cli's default) is unaffected.

### Fixed

- **Cli prompt no longer pollutes phpunit output.** `Cli_Stdin_Reader::show_prompt_fallback()` was writing directly to `\STDOUT` via `fwrite`, bypassing the Dumper's injectable stdout stream. Every CliCommandTest that constructed a `Cli_Stdin_Reader` in non-readline mode with the default `show_prompts=true` (a half-dozen cases) spat `newspack-nodes> ` straight at phpunit's real stdout, producing the `newspack-nodes> newspack-nodes> .test-prompt> ...` litter mid-progress-dots. Routed through a new `Dumper::write_prompt( string $prompt )` method instead — same `fwrite` semantics, but to the Dumper's owned `$stdout` resource which tests can swap for `php://memory`. The `mark_prompt_displayed()` side-effect folds into `write_prompt()` so the call site is one method instead of fwrite+mark.

- **`Core::emit_stderr()` is now re-entrant safe.** The default handler routes through a `_repl` Partition; if a fault inside that path (Partition write failure, Router throw, a node's `fill()` rate-limit-logging its own error) calls back into `print_less_often`, the dispatcher used to recurse straight through the handler — stack-overflowing or deadlocking depending on what the inner call touched. Custom handlers set via `set_stderr_handler()` could recurse the same way. Now guarded at the dispatcher: a re-entry falls back to PHP's `\error_log()` (the same last-resort sink the default handler already uses when `_repl` isn't wired up), the flag is reset in `finally` so a throwing handler doesn't permanently latch the diverter, and `Core::reset()` clears it for tests.

## [0.1.14] - 2026-05-13

### Fixed

- **Consumer was overwriting `Message::KEY` with `"{seg}:{abs_offset}"`, destroying the producer's routing key.** After v0.2.17 of `newspack-event-logger-nodes` moved `rid` from inside the entry to `Message::KEY` (so partitions co-locate by request), Consumer's overwrite turned every entry's KEY into a unique segment:offset string before it reached downstream nodes. RequestBuilder's BC fallback to KEY then returned `"12:35296133"` instead of the rid, and every entry's "rid" was different — the request cache never aggregated entries by rid, so no request ever assembled and `requests.log` stayed empty for any request that went through the firehose-workers pipeline. The same overwrite would have silently misrouted any multi-partition job queue keyed on `handler` whenever Consumer's output fed back into a partition-routing Topic.

  Position breadcrumb moves to `Message::ID` (matching Perl Tachikoma's convention — KEY is the producer's routing key, ID is per-message position / correlation). Consumer preserves the producer's KEY untouched. Offsetlog continues to checkpoint by `{seg, off}` struct in VALUE, unaffected.

## [0.1.13] - 2026-05-12

### Added

- **Substrate Node subclasses now emit `set_state` traces at natural state-transition points.** Combined with 0.1.11's per-node `debug_state` flag, this turns the substrate into a self-narrating instrument when tracing is enabled.

  - `Partition::do_rotate()` → `set_state('SEGMENT', $current_segment_id)` when a rotation lands.
  - `Partition::cleanup_segments()` → `set_state('CLEANUP', ['deleted'=>N,'alive'=>K])` only when retention actually removed segments.
  - `Consumer::poll()` → `set_state('SEGMENT', $cursor_seg)` when the cursor crosses into a new segment.
  - `Consumer::checkpoint()` → `set_state('CHECKPOINT', ['seg'=>X,'off'=>Y])` after a successful offsetlog commit (gated by the existing "skip if cursor hasn't advanced" check, so this only fires on real progress).
  - `Consumer::is_caught_up()` → `set_state('CAUGHT_UP', bool)` on transition only (tracks the last emitted boolean and fires only when it flips, so no churn from per-poll evaluations).
  - `Tail::poll()` → `set_state('ROTATED', ['inode'=>N])` on file-inode change, `set_state('TRUNCATED', ['size'=>N])` when the file shrinks.
  - `Tee::connect_node()` / `disconnect_node()` → `set_state('TARGETS', $list)` when the target set changes.
  - `Lock::acquire()` → `set_state('HELD', ['path'=>$p,'stolen'=>bool])` on successful acquire (stolen=true distinguishes orphan/stale takeover from a clean acquire). `Lock::release()` → `set_state('HELD', ['path'=>$p,'released'=>true])`.

  Each transition is selected to represent a genuine durable state change, not a high-frequency tick — `Timer::set_timer()` is NOT instrumented because `Consumer`/`Tail` re-arm via `set_timer(N, true)` on every poll cycle, which would make ARMED traces a hot path. Notify-only events (Router TIMER ticks, Timer FIRE) remain notify-only by design.

  All transitions ride the existing `Node::set_state()` → `emit_debug_state_trace()` path: a TM_STRUCT addressed to `TO=_repl`, payload `{k:'debug_state', node, class, event, value}`. Visible in any `wp nodes cli` session and the future SSE controller without further plumbing.

## [0.1.12] - 2026-05-12

### Added

- **`Core::$stderr_handler` defaults to routing through the worker's `_repl` conduit when one is registered.** Stderr-style diagnostics (`print_less_often`, `print_least_often`, `print_now_and_then`) build a TM_BYTESTREAM addressed `TO=_repl` and fill the worker-side `_repl` node directly. `_router` peels the prefix; downstream cli/SSE readers see the message with empty TO, which the Dumper always renders — unaddressed broadcast, no `show_sse` opt-in needed. Falls back to PHP's `error_log()` when there's no `_repl` (request scope, tests, CLI tools). Tests can override via `Core::set_stderr_handler()` as before.

### Changed

- **`Node::set_state()` traces and `Core::$stderr_handler` both address `TO=_repl`** (was `_repl/sse` in 0.1.11 for traces). Matches Perl Tachikoma exactly: stderr and state transitions are alarm-style broadcasts — always visible to cli sessions and the SSE controller, no opt-in gating. `show_sse` remains for genuinely opt-in observability streams (the upcoming periodic stats emitter etc.) where the user explicitly chooses to consume an additional channel.

  The `Node::emit_debug_state_trace()` routing path is unchanged otherwise — still routes via `Core::node('_router')->fill()`; still safe no-op when `_router` isn't registered.

## [0.1.11] - 2026-05-12

### Added

- **`Node::$debug_state` per-node state-tracing dial** + matching `Node::debug_state( ?int $level = null )` accessor. Mirrors Perl Tachikoma `Tachikoma::Node`'s `$self->{debug_state}`. When > 0, `set_state()` additionally emits a TM_STRUCT trace addressed to `TO=_repl/sse` so cli sessions (with `show_sse` on, from 0.1.8) and the SSE controller both see state transitions in real time. The trace doesn't replace the normal `notify()` — that still fires for registered listeners. Trace is purely additive observability.

  Trace payload shape:
  ```php
  [
    'k'     => 'debug_state',
    'node'  => '<this node name>',
    'class' => '<FQCN>',
    'event' => '<event name passed to set_state>',
    'value' => <payload>,
  ]
  ```

  Emission routes via `Core::node('_router')->fill()` so workers without wired sink chains still get the trace through. Safe no-op when `_router` isn't registered (e.g. unit tests constructing nodes in isolation).

- **`debug_state [ <node name> [ <level> ] ]` CommandInterpreter verb.** Mirrors Perl Tachikoma:
    - `debug_state` (no args) — toggle this CommandInterpreter's own debug_state.
    - `debug_state 1` (numeric arg only) — set this interpreter to level 1.
    - `debug_state foo` (name only) — toggle node `foo`'s debug_state.
    - `debug_state foo 2` (name + level) — set node `foo`'s debug_state to level 2.
- **`CommandInterpreter::make_node()` propagates the interpreter's `debug_state` to newly-created children.** Lets the operator turn tracing on for an entire topology in one command: `debug_state 1` then `make_node` for each node — every constructed node inherits level 1 from birth. Mirrors Perl Tachikoma CommandInterpreter.pm which assigns `$node->debug_state( $self->debug_state )` after every node creation.

  Combined with 0.1.8's `show_sse` and 0.1.10's `debug_level` cleanup, a cli session can now narrate the worker's internals at multiple levels of detail and addressing:

  ```
  firehose-workers.p0> show_sse
  show_sse: on
  firehose-workers.p0> debug_state job-router 1
  job-router debug_state: 1
  firehose-workers.p0>                                # idle...
  # then a state transition on job-router fires:
  {"k":"debug_state","node":"job-router","class":"…","event":"BACKPRESSURE","value":42}
  ```

## [0.1.10] - 2026-05-12

### Changed

- **`debug_level 1` now prepends the header and falls through to the normal renderer** instead of replacing it. The unwrapping that `TM_COMMAND|TM_RESPONSE` does (decode the JSON envelope, write just the inner `payload`) still happens — the user sees the type/from header followed by the friendly unwrapped output, not the raw JSON envelope. Mirrors Perl Tachikoma where `dump_response` runs BEFORE `dump_message`. Level 2 still replaces the render entirely with the structural envelope dump.

  Before:
  ```
  TM_COMMAND | TM_RESPONSE from _command_interpreter:
  {"name":"ls","payload":"_repl\nerrors:partition\n…"}
  ```

  After:
  ```
  TM_COMMAND | TM_RESPONSE from _command_interpreter:
  _repl
  errors:partition
  …
  ```

## [0.1.9] - 2026-05-12

### Changed

- **`debug_level >= 1` now REPLACES the normal render instead of stacking with it.** 0.1.8 emitted a one-line header to stderr in addition to the normal stdout render — left the user reading both copies of the value. Now mirrors Perl Tachikoma Dumper.pm exactly: the dump rewrites what gets rendered, no double output.
- **Level 2 is a structural multi-line envelope dump** instead of a flat key=value header. Each envelope field on its own line, type flags rendered by name with `' | '` separator, timestamp humanized (`1700000000 (2023-11-14 22:13:20 UTC)`), value either pretty-printed JSON (for TM_STRUCT arrays) or — for TM_COMMAND envelopes — the decoded inner command unwrapped as a nested JSON block. Matches the readability of Perl's `Data::Dumper` output of `$message->as_string`.

  ```
  Message {
      type:      TM_COMMAND | TM_RESPONSE
      from:      _command_interpreter
      to:        450
      id:        1778641673:0000000003
      key:
      timestamp: 1778641673 (2026-05-12 03:01:13 UTC)
      value:     {
                     "name": "ls",
                     "arguments": "",
                     "payload": "COUNT NAME                 TARGET\n…"
                 }
  }
  ```

  Field labelled `value:` (matches `Message::VALUE`). The inner Tachikoma::Command keys keep their canonical `name`/`arguments`/`payload` names — those describe the Command shape, not the envelope slot.

## [0.1.8] - 2026-05-12

### Added

- **`show_sse` Shell builtin** — toggles the local Dumper's broadcast-filter opt-in for `TO=sse` traffic. The worker side will fan stats / `debug_state` events out as TM_STRUCT addressed to `_repl/sse`; the worker-side `_router` peels `_repl`, so each cli/SSE reader sees bare `TO=sse` arriving at its Dumper. By default the Dumper drops it (not addressed to the session's `$pid`). After `show_sse`, those messages render alongside personal replies. Pure toggle — no arguments — mirroring Perl Tachikoma's builtin convention.

  Underlying API: `Dumper::toggle_broadcast_filter( $name, ?bool $explicit = null )` and `Dumper::broadcast_filter_enabled( $name )`. Set-of-strings storage so future broadcast addresses can opt in without redesign.

- **`debug_level [<n>]` Shell builtin** — set or toggle the local Dumper's render verbosity. With no args, toggles between 0 and 1 (matching Perl Tachikoma semantics). With a numeric arg, sets explicitly (clamped to 0..2). Levels:
    - 0 — default curated rendering
    - 1 — additionally emit a one-line debug header per Message to stderr: `<TM_FLAGS> from <FROM>: <stringified-payload>`. Every Message that reaches the Dumper, including control messages the normal renderer would silence
    - 2 — same as 1, but the header is the full envelope: `<TM_FLAGS> id=<ID> stream=<STREAM> from=<FROM> to=<TO> ts=<TIMESTAMP>` followed by the payload on the next line.

  The normal render still happens after the debug header — level 1/2 additively narrate without replacing user-friendly output. Header goes to stderr so `wp nodes cli ... | grep foo` on stdout is unaffected.

- **`show_parse` Shell builtin** — toggle dumping of the post-interpolation line and tokenized form to `$output_stream` for every subsequent `parse()` call. Mirrors Perl Tachikoma Shell3 `show_parse`; useful when interpolation or tokenization quirks need a microscope. Local-only — no IPC, no worker involvement. Pure toggle.

  Distinct from `debug_level`: `show_parse` is about the parser (what tokens did I see for this line); `debug_level` is about the Dumper (how verbosely should I render messages that arrive). The two stack — `show_parse` + `debug_level 1` shows both ends of the REPL pipeline at once.

## [0.1.7] - 2026-05-12

### Changed

- **Supervisor no longer runs when no topologies are registered.** `Bootstrap::run_supervisor_tick()` now returns early if `Bootstrap::expand_workers()` is empty (every topology gated off, no application registered any, etc.) — the supervisor's 595s tick loop, its heartbeat, the `supervisor_periodic` hook, and the self-respawn chain are all pointless work when there are no workers to spawn or to consume the periodic-hook output. `Supervisor::check_config()` also exits the loop when topologies disappear mid-run (e.g. operator flips a gate off), so a running supervisor winds down on its next 15s config window instead of finishing its full 595s.

  The cron stays scheduled — minute-cadence no-op ticks are cheap, and unscheduling would require plugin re-activation to re-arm once the operator flips a gate back on. The next tick after gates return picks up the new topology fleet automatically.

## [0.1.6] - 2026-05-12

### Added

- **`newspack_nodes/before_supervisor_run` / `newspack_nodes/after_supervisor_run` actions** wrap the call to `Supervisor::run()` from `Bootstrap::run_supervisor_tick()`, giving application layers a hook point to swap request context around the 595s tick. `run_supervisor_tick()` also now sets `$_SERVER['NEWSPACK_NODES_WORKER_TYPE']='supervisor'` (and `..._PARTITION='0'`) BEFORE firing the wrapping action, so the listener observes the env var when it inits its per-job LogManager. Without this, the cron-backstop path (WP-Cron fires `newspack_nodes/supervisor` inside a regular `/wp-cron.php` request, supervisor sets the env var late from inside `run()` after LogManager has already captured `process (start)`) logged a 595s `/wp-cron.php` request that was missing `worker_type` and counted toward global averages. The self-respawn path was unaffected (its REQUEST_URI matches `skip_urls`). The env-var assignment inside `Supervisor::run()` itself is preserved as a defensive baseline for callers that invoke `run()` outside the cron path.

## [0.1.5] - 2026-05-12

### Removed

- **`Node::$edge` and `edge()` getter/setter.** The field had no readers or writers anywhere in the substrate or any application Node subclass — pure dead infrastructure. Removed from `Node`'s declared properties, its remove_node cleanup, the CommandInterpreter's `ls -e` flag and `EDGE` column, the `dump` reflection's edge-to-name collapse, and the `ARCHITECTURE.md` Node-class snippet.

### Changed

- **`ls` flag rename: `-o owner` → `-t target`.** The column was labeled `OWNER` but `Node::$target` has always been called "target" in the field declaration and getter — the `ls` UI was the only place that called it "owner". Renamed for consistency. `-l` now expands to `-ct` (was `-co`). `OWNER` column header → `TARGET`.

## [0.1.4] - 2026-05-12

### Changed

- **`Core::print_least_often` now uses a real 60s window.** The docstring claimed "300s" but the implementation had no time gate at all — once it emitted at the 10th hit, `emitted=true` stuck for the rest of the process lifetime, giving at most one stderr line per worker (workers live ~10 min). The function now emits on the 10th occurrence within a window, then suppresses for 60s before re-arming. Matches `print_less_often`'s windowed pattern with the 10-hit threshold preserved.
- **ARCHITECTURE.md scrubbed of out-of-substrate references.** Removed mentions of the legacy inspiration framework, application-side class names (consuming-plugin territory), `TM_PERSIST` (a flag this codebase doesn't define), and a "Tee aggregating responses" reverse-routing case that Tee doesn't actually do. Substrate doc now uses substrate-only vocabulary.
- **ARCHITECTURE.md batching section accurate.** The stale "No batching in v1, LogManager handles it" lines replaced with a description of the actual in-Partition `$batch` accumulator + size-threshold flush + 0-delay timer-driven drain pattern. `Topic::flush()` documented as the request-scope drain entry point for callers handing off to a subprocess.

## [0.1.3] - 2026-05-11

### Removed

- **`newspack_nodes/base_dir` filter.** Bootstrap, the CLI commands, and `Config::load_config_defaults` all now read `base_directory` straight from the config file (with WP-option overlay where the schema applies). The filter was a stale extension point with no production consumers — its only callers were tests using it as an injection hook, and the production path through Bootstrap was silently picking up the filter default (`/tmp/newspack-nodes`) instead of the substrate config file's value, causing workers and dashboards to land on different on-disk paths. Tests switch to `TestCase::use_base_dir($dir)` (writes a per-test config file, sets `LOCAL_NEWSPACK_NODES_CONF`, resets Config), mirroring the legacy `newspack-event-logger-plugins` pattern.

### Added

- **Permanent test config baseline** at `tests/newspack-nodes-test-config.php`, wired via `LOCAL_NEWSPACK_NODES_CONF` in both `phpunit.xml` and `tests/bootstrap.php`. Matches legacy `tests/event-logger-test-config.php` shape.

### Changed

- **Consumer's memcache position key now includes the hostname.** Format is now `np:pos:{hostname}:{source_base_dir}:p{N}` (was `np:pos:{source_base_dir}:p{N}`). Shared-memcache deployments where multiple hosts have the same on-disk `{base_dir}` (render1/render2/hub all using `/volumes/pyrobase/tmp/newspack-nodes/...`) no longer overwrite each other's live cursor entries. Reader side updated in lockstep.

### Fixed

- **`_router` was never started, so the Router-hitchhike TIMER pattern was dead in workers.** `WorkerBase::build_scaffolding()` constructed `_router` (a `Timer` subclass) but never called `set_timer()` on it, leaving `active=false` and `fire_count=0`. Any node that did `$router->register('TIMER', $name)` got the registration recorded but no `notify('TIMER',...)` ever fired — the keepalive / housekeeping ticks they depended on silently never ran. WorkerBase now calls `$router->set_timer( Router::DEFAULT_TICK_MS )` right after naming it. (CLI command path in `class-cli-command.php` constructs its own router for the bare-mode REPL and has no hitchhikers, so left alone.)

## [0.1.2] - 2026-05-11

### Changed

- Plugin entry now uses a Composer classmap autoloader instead of a hand-maintained `require_once` chain. `composer.json` declares `"autoload": { "classmap": [ "includes/" ] }`; `composer install --no-dev --optimize-autoloader` (already run by `build-release.sh`) generates the FQCN → path map. Classes load on first reference; requests that don't touch worker / admin / CLI code don't pay for it.
- ARCHITECTURE.md: new dedicated `## Lock` section covering mkdir+heartbeat atomicity, PID stamping, stale takeover, and `should_restart()` / `request_restart_at()`.

### Fixed

- `Cli_Stdin_Reader::fire()`: suppress the companion `E_WARNING` PHP raises alongside the `ValueError` on un-selectable streams (e.g. `php://memory` in tests). The `catch` block already handles the failure path; the warning was just noise in `phpunit --display-warnings`.
- `SmokeTest`: version-constant assertion uses a regex match so version bumps don't require a test edit.

## [0.1.1] - 2026-05-11

### Fixed

- `Cli_Stdin_Reader`: gate `readline_callback_read_char()` with a zero-timeout `stream_select()` so the readline path doesn't block the drain loop on a TTY with no pending input. The legacy stream_select-driven loop gated this externally; after the FD-machinery removal in 0.1.0 every `fire()` tick called `readline_callback_read_char()` unconditionally, which blocked inside `read()` until the user typed again — stalling the loop and preventing Consumer/Tail timers from firing. Symptom in pivoted-cli mode: the worker's response to a command didn't render until the user pressed an extra key.
- Rearm cadence: any successful stream-select-ready tick now picks `BUSY_POLL_MS=0` so the kernel input buffer drains on consecutive zero-delay ticks. Without this, interactive typing crawled at 1 char per `IDLE_POLL_MS` (100ms).

## [0.1.0] - 2026-05-10

### Added

- Initial public release. Tachikoma-inspired message-passing runtime for PHP/WordPress.
  Provides the substrate that `newspack-event-logger-nodes` (and future applications) compose on top of.
  - `Node` base contract: every node honors `fill( array &$message ): void`.
  - 7-field positional `Message` (TYPE, TIMESTAMP, FROM, TO, ID, KEY, VALUE) with packed JSON wire format.
  - `Router` — path-based dispatch by TO.
  - `Topic` / `Partition` / `Consumer` — append-only log storage with CRC32-keyed partition routing; PIPE_BUF (4KB) atomic-append discipline with opt-in `allow_large_writes()` for >4KB payloads.
  - `Tail` / `Log` — segmented log rotation and tailing.
  - `WorkerBase` / `Supervisor` — long-lived workers spawned via HMAC-validated REST endpoint; two-tier safety net (worker self-respawn + supervisor force-spawn + WP-Cron supervisor recovery).
  - `Lock` — mkdir-based advisory locking with PID heartbeat and stale-takeover.
  - `Shell` / `CommandInterpreter` / `Dumper` — REPL primitives.
  - `wp nodes` CLI (`ls`, `cli`, `types`, `run`, `restart`, `status`).
  - `EventFramework` drain loop (timer + curl_multi_select); no FD-registration machinery — stdin is driven by a Timer-subclass reader.
  - `Tee` / `Echo` / `Callback` / `Hook` / `Timer` — generic node primitives.
