# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed

- **Live-mode Inspector verb buttons targeted the bare node, not its `{name}:config`
  sibling CI.** Command verbs (`node_schema` `verbs` — e.g. `tick`/`flush`/`set_*`) live on
  the node's sibling CommandInterpreter (`Node::dump_config()` emits `cmd {node}:config
  {verb}`; `.tsl` topologies use the same form), but the topology-console Inspector sent
  `TM_COMMAND` to the bare node — a no-op, since a plain Node doesn't interpret commands.
  So clicking a verb did nothing. Command verbs now route to `prefix({node}:config)`;
  requests (`TM_REQUEST`) still target the node, which answers them.

### Changed

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

### Added

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
- **Every CommandInterpreter answers `help` by default.** A CI that installs a
  custom verb table (the REST service CIs) previously had no `help`; the base now
  injects one that lists the CI's own verb names (sorted, newline-separated). CIs
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
- **`dmesg`/`uptime` work in the browser CI.** Added the JS `Core` `recentLog`
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
  routes to that worker's PHP CI). The palette already comes from the server
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
  polling the worker CI. Non-worker cwds (local, `_sse`, `_http`) poll themselves.
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
  graph. The browser CI gained local `ls`/`list_nodes`/`dump_metadata` verbs.
- **`_sse` is the bidirectional session node; replies are per-session private.** A
  console command's reply pivots through `_sse:{pid}` (`HTTP_Filter` matches that
  head) so only the originating session sees it; the synchronous `/command`
  response is fed back into the receive graph (`HttpOut` → `_sse`, which strips its
  own `_sse:{pid}` head). Routed-onward commands return a bare `202` (no body).
- **The Router has no sink.** It routes solely by peeling `TO` and drops what it
  cannot peel (empty/unknown head → `NOT_AVAILABLE`); setting a sink on it now
  throws. `HTTP_In` routes incoming `/command` messages through the base
  `_command_interpreter` (which interprets an empty-`TO` command and forwards the
  rest to `_router`), mirroring the client's `Shell → CI → _router` spine.

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

- **`stats [-a] [<regex>]` verb** — Tachikoma-style tabular per-node counters with columns `NAME | COUNT | LGST_MSG | READ | WRITTEN`. Scope rules match `ls`: default shows siblings of this CI; `-a` shows every node; optional regex narrows by name. Dropped Tachikoma's `BUF_SIZE` and `HIGH_WATER` columns since we have no in-memory message buffers (Partition and Topic flush every fill into a per-node line buffer that drains synchronously).

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
    - `debug_state 1` (numeric arg only) — set this CI to level 1.
    - `debug_state foo` (name only) — toggle node `foo`'s debug_state.
    - `debug_state foo 2` (name + level) — set node `foo`'s debug_state to level 2.
- **`CommandInterpreter::make_node()` propagates the CI's `debug_state` to newly-created children.** Lets the operator turn tracing on for an entire topology in one command: `debug_state 1` then `make_node` for each node — every constructed node inherits level 1 from birth. Mirrors Perl Tachikoma CommandInterpreter.pm which assigns `$node->debug_state( $self->debug_state )` after every node creation.

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
