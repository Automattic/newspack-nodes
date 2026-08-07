# Upgrading

Breaking changes that affect a plugin built on the substrate — topology files, Node subclasses, job handlers, dashboards, the wire — with the fix beside each. Start at your installed version and apply everything above it. Internal refactors and fixes are not listed; [CHANGELOG.md](../CHANGELOG.md) has the full story per release.

**Maintenance rule:** a release that changes any consumer-facing contract adds its entry here in the same commit as its CHANGELOG entry. No entry means nothing to do.

## 2.12.0

- **`Bootstrap::supervisor()` is renamed to `Bootstrap::spawn_coordinator()`,
  and `Bootstrap::is_supervisor_enabled()` to `Bootstrap::is_fleet_enabled()`.**
  The test seams follow: `$supervisor_factory` → `$spawn_coordinator_factory`,
  `$supervisor_enabled_override` → `$fleet_enabled_override`. No aliases —
  rewrite each call. The methods never returned a supervisor; the first hands
  back a `Spawn_Coordinator`, and the second gates the whole fleet, including
  `Fleet_Node::fire()`.

- **`$_SERVER['NEWSPACK_NODES_WORKER_TYPE']` on the reconcile pass is now
  `reconcile`, not `supervisor`.** This reverses the 2.11.0 note below. Nothing
  in any plugin compares against the literal — it is a stats dimension, not a
  worker type — so the only effect is that event-logger rows filed under
  `supervisor` stop growing and a `reconcile` series starts beside them. Update
  any saved dashboard filter or query that pinned the old value.

- **The `'supervisor_only'` restart classification is gone; use `[]`.** The two
  were already identical — `Restart_Planner::topologies_for()` resolved both to
  "restart nothing" — while the settings UI printed a different sentence for
  each. A `Field` still carrying the string keeps working (an unknown string
  resolves to no restart), but it now renders under the same label as `[]`.

- **A `settings set` command that does not change the value is a no-op.**
  `Settings_CI`'s `set` verb now compares against the stored value first and
  skips the write, the `Config::reset()`, the restart request and the reload
  request when they match. It still returns the same post-set snapshot, so no
  caller changes. This is what a hub's `Settings_Sync` sweep needs: it re-pushes
  every registered option on its interval whether or not anything moved, and
  acting on those pushes recycled a spoke's whole fleet once per sweep.

- **`Lock_Node::should_restart(): bool` is replaced by
  `Lock_Node::restart_reason(): string`.** `''` means keep running; anything
  else is the reason, and goes verbatim into the worker's stop line. Rewrite
  `if ( $lock->should_restart() )` as `if ( '' !== $lock->restart_reason() )`.
  The three situations that share this channel — an operator's restart flag, a
  vanished heartbeat, a peer that stole the lock — all used to log `restart
  requested`, which sent operators looking for a restart nobody ran.

- **A failed SSE slot heartbeat now names the state it found.** The
  `workers heartbeat` verb still errors with `SSE slot lease not owned`, now
  suffixed with `: pointer_missing`, `: slot_released`,
  `: pointer_owner_mismatch`, `: liveness_missing`, `: backend_read_error` or
  `: recovered_during_inspection`. A client matching on the exact old string
  needs a prefix match instead. `slot_released` is the release tombstone
  (pointer 0) and means a normal reconnect race, not a takeover — a client of
  its own should treat it as routine, as `Remote_Link_Node` now does.

## 2.11.0

- **`/messages/stream` and `/log/stream` now END on their own.** A stream that
  carries no `msg` event for `sse_idle_timeout` seconds (default 15) closes,
  after advertising the SSE `retry:` field (`sse_retry_ms`, default 15000) at
  stream start. A browser `EventSource` needs no change — reopening on `retry:`
  is what it is for, and it echoes the `id:` below automatically. A hand-rolled
  client does: treat a clean EOF as a scheduled reconnect, not a failure, and
  resume from the last `id:` (or its own cursor). The close carries NO
  `disconnect` frame; that frame still means the lease was lost. A client that
  cannot be changed keeps the old behavior by setting `sse_idle_timeout` to 0.

- **Every `msg` now carries an SSE `id:`, and `Last-Event-ID` beats
  `positions`.** The id is the whole stream's resume state —
  `name=segment:offset` per live subscription — and a reconnect that presents it
  resumes each subscription exactly where it stopped, overriding the query
  parameter per subscription. Treat it as opaque: the offset is already the next
  read boundary, so adding a record length to it seeks into the middle of a
  record. A client that sends `positions` and no `Last-Event-ID` is unaffected.

- **The `aggregator` `summary` verb gained an `idle` count.** `connected` now
  means actively streaming, `idle` means closed at EOF and due back, and both
  are up — a dashboard that renders `connected / total` will under-report a
  healthy fleet. Add `idle` to the numerator. The per-partition snapshot gained
  `scheduled_reconnect_at` (unix second, null when not waiting on a schedule):
  that is the explicit idle reading, since a null `last_error` also means
  "never attempted".

- **`wp nodes restart supervisor` is gone, because the supervisor is gone.**
  There is no singleton process to restart. Workers revive each other through
  the `_fleet` scan every one of them runs, so restarting a worker is the only
  operation left: `wp nodes restart <type>`, or `wp nodes restart all`. Drop the
  `supervisor` target from any script — it is rejected, not ignored.
- **`wp nodes status` and `wp nodes types` no longer report a supervisor.**
  `status` drops the partition `-1` row that led its table; `types` drops the
  separate "singleton supervisor" line above the topology groups. Anything
  parsing `--format=json` for a row whose partition is `-1`, or for a
  `supervisor` key, finds neither. Every remaining row is an ordinary
  `type.p<N>` worker.
- **`POST /workers/spawn` with `type=supervisor` now returns 400.** The type is
  no longer valid; there is nothing to spawn. Cold start is WP-Cron's single
  pass, not a spawn request.
- **`wp nodes doctor` replaces the `supervisor-liveness` check with
  `housekeeping`.** The report was still seven results at that version. The new one is
  load-bearing in a way the old one was not: fleet housekeeping — retention,
  orphan partition and IPC reaping, the delayed-jobs sweep, alert emission and
  every `newspack_nodes/periodic` subscriber — now rides the minute cron pass
  alongside cold-start revival, so an install whose `newspack_nodes/reconcile`
  event was vetoed or cleared loses all of it silently. If doctor reports it
  CRITICAL, run
  `wp cron event schedule newspack_nodes/reconcile now newspack_nodes_minute`
  (visiting wp-admin also re-arms it, on `admin_init`).

- **The cron event, its handler and its lifecycle actions are renamed.**
  `newspack_nodes/supervisor` → `newspack_nodes/reconcile`,
  `Bootstrap::run_supervisor_tick()` → `Bootstrap::reconcile_fleet()`, and
  `newspack_nodes/before_supervisor_run` / `newspack_nodes/after_supervisor_run`
  → `newspack_nodes/before_reconcile` / `newspack_nodes/after_reconcile`. No
  aliases: rewrite each `add_action()` — the callback, priority and argument
  count all stay as they are. Two operator notes:
  - Plugin activation and the `admin_init` self-heal both schedule the new
    event, so nothing stops being revived. But nothing unschedules the OLD
    event either, so an install that carried it keeps firing a hook no code
    listens to, once a minute, forever. Clear it once with
    `wp cron event delete newspack_nodes/supervisor`.
  - `$_SERVER['NEWSPACK_NODES_WORKER_TYPE']` is deliberately UNCHANGED at
    `supervisor`. It is the label newspack-event-logger-nodes files this pass's
    per-URL stats row under, and renaming it would only split that row's
    history.

- **Delayed jobs are delivered on the minute, not every 15 seconds.**
  `Job_Delay::sweep_action()` moved to the cron pass with the rest of
  housekeeping, so a job enqueued with `not_before` / `delay` now fires within
  60s of becoming due rather than 15s. `not_before` means *not before*: firing
  late is correct, and firing early would be the bug. If you need tighter
  granularity, run the work on your own `Timer_Node` instead.

- **`Job_Intake::try_queue()` is removed.** It was added in this same release
  for the fleet-sweep enqueue, and that enqueue no longer exists — housekeeping
  runs in the cron pass, not as a job. `Job_Intake::queue()` is the one entry
  point again. If you were calling `try_queue()` from inside a worker's drain
  loop, do the work on a `Timer_Node` in that graph rather than writing to the
  intake from the drain loop.

- **The `TopicProbe` node type is renamed `Topic_Probe`.** The class is
  `Topic_Probe_Node`, matching its sibling `Job_Probe_Node` and ADR-10. There is
  no alias: a topology whose own file says `make_node TopicProbe <name> [interval]`
  fails to resolve a class at load. Rewrite it to `make_node Topic_Probe …`.
  Stock `topic-probe.tsl` is already updated, so an `include topic-probe` needs
  no change, and neither does the node name `topicprobe` or the `topicprobe.p0`
  log path.

- **The `topicprobe.p0` and `jobstats.p0` record layouts changed: counters are
  now per-interval deltas.** A worker recycles every ~595s, so a cumulative
  in-process counter resets six times an hour and any reader differencing
  consecutive records reported a rate of 0 at each reset. Each record now
  carries the work done since that reader's previous sweep plus an `ELAPSED_MS`
  covering it, so you divide ONE record: `rate = DELTA / (ELAPSED_MS / 1000)`,
  guarding `ELAPSED_MS === 0` (two sweeps can share a clock second). Drop any
  prior-record state, reset detection or negative clamping you kept.

  Renames, all at their existing indices — there is no alias, so a reader
  referencing an old constant fails at import:
  - `Probe_Record::MSGS` → `MSGS_DELTA` (index 7)
  - `Jobstats_Record::{RUNS, ERRORS, DURATION_MS, QUEUE_MS, ITEMS_OK,
    ITEMS_ERR}` → the same names with a `_DELTA` suffix (indices 2..7)

  New slots: `Probe_Record::BYTES_READ_DELTA` (10) and `ELAPSED_MS` (11);
  `Jobstats_Record::ELAPSED_MS` (12). If you derived a byte rate by
  differencing `Probe_Record::END_BYTES`, switch to `BYTES_READ_DELTA` —
  `END_BYTES` is the partition's on-disk size and drops when retention deletes
  a segment, which read as a second spurious reset. `END_BYTES` itself is
  unchanged and still the on-disk footprint.

  Backward compatibility was waived: records written before the upgrade decode
  with the new meanings until they age out, and both logs keep 24h.

- **`Consumer_Node::probe_stats()` and `Job_Worker_Node::probe_stats()` are
  DRAINING reads.** Each call returns the window since the last call and
  re-baselines, so calling one twice a tick halves your data. Mount at most one
  `Topic_Probe` and one `Job_Probe` per process — what a stock topology already
  does. If you call `probe_stats()` from your own code for a one-off reading,
  stop; read the log instead.

- **`wp nodes status` renames the consumer table's `Msgs` column to
  `Msgs/int`**, and `Probe_To_Graphite_Node` emits
  `<prefix>.<host>.nodes.topics.<reader>.msgs_delta` where it emitted `.msgs`.
  Both now report per-probe-interval counts rather than a cumulative; the
  renames are there so the change of meaning is visible instead of silent.
  Update any Graphite dashboard or `--format=json` consumer that names them.

- **`buildAlignedSeries`'s RATE aggregate is `agg: 'rate'`, not `agg: 'max'`,
  and its points carry a `weight`.** If you call it directly, pass points shaped
  `{ ts, value, weight }` — `weight` being the denominator `value` is a
  quotient of (seconds for a per-second rate). A point with no weight still
  counts, degrading to a plain mean. Passing `agg: 'max'` is no longer
  recognised and falls through to the rate aggregate.

- **`newspack_nodes/supervisor_periodic` is renamed to
  `newspack_nodes/periodic`.** There is no supervisor left to name, and the
  cadence is unchanged at 15s. There is no alias and no deprecation shim: a
  subscriber still on the old name is never called, silently. Rewrite each
  `add_action( 'newspack_nodes/supervisor_periodic', … )` to
  `add_action( 'newspack_nodes/periodic', … )` — the callback, priority and
  argument count all stay as they are.

## 2.3.5

- **`wp nodes restart <type>` restarts every partition; `--all-partitions` is
  gone.** Restarting one of six partitions left five running the old code, so
  the safe behaviour is now the default. Drop the flag from any script — it is
  rejected, not ignored. `--partition=<N>` still narrows to one.
- **`wp nodes scaffold node|topology` writes into the current directory**, not
  into `includes/` and `topologies/`. `scaffold plugin` still creates the full
  tree; cd to where you want the file, or move it after.
- **The `runtime_stats` verb is removed.** It bundled `list_timers`,
  `list_handles` and the Router profile table into one struct for the devtools
  views, and its profile third had silently fallen behind the text verb's
  columns. Each of those three verbs now takes `-s`, returning the same rows its
  table is built from: `list_timers -s`, `list_handles -s`, `list_profiles -s`.
- **Verb errors are newline-terminated.** `interpret()` appends `\n` to the
  TM_ERROR payload in both the PHP and JS interpreters, so a REPL that prints
  the payload verbatim does not run the message into the next prompt. Anything
  matching an error payload exactly needs the trailing newline.

## 2.2.4

- **SSE leases now carry an opaque owner token.** The `connected` envelope adds
  `OWNER <positive-decimal>`, and `workers heartbeat` now requires exactly
  `[ slot, owner ]`; the old client-supplied TTL argument is gone. Custom
  `SSE_Out_Node` slot seams must pass the complete `{slot, owner}` lease to
  check, release, and failure inspection. Custom clients must retain OWNER
  exactly as text and send it back with SLOT.
- **This cutover has no mixed-protocol compatibility mode.** A new client
  rejects an old ownerless handshake, while a new server reads an old
  heartbeat's TTL as a non-matching owner. Deploy Nodes 2.2.4 and every plugin
  bundle that inlines its runtime in the same maintenance window, then restart
  the affected workers and aggregators so every connection reconnects on the
  new protocol.
- **A deliberate lease-loss close now sends a terminal `disconnect` SSE
  event.** Its packed Message carries a non-empty machine key and a safe display
  reason; consume that frame and prefer its reason over the transport's later
  generic close event.

## 2.0.0

- **A command sent to `/command` must be signed; the REST boundary no longer
  signs on your behalf.** Before 2.0.0, `HTTP_In` signed whatever request
  passed `manage_options` — reaching the endpoint was enough. As of 2.0.0,
  ingress signs nothing: an unsigned command is refused
  (`verification failed: bad envelope`), and a batch with any refusal answers
  **401** instead of 202. Fix: mint a session first
  (`POST /wp-json/newspack-nodes/v1/auth`), then sign every command with the
  session key before sending it. The runtime's own Shell and dashboard hooks
  already do this via `Node.command()` (JS) or `Command_Auth::sign()` /
  `sign_for()` (PHP) — a hand-built `TM_COMMAND` message that skips this step
  is constructed but never delivered. See
  [API.md → Command Signing](API.md#command-signing).

## 0.51.0

- **`set_snapshot_node` deleted; `add_snapshot_node` replaces it.** A Consumer now
  snapshots a LIST of nodes; the offsetlog frame's `cache` is a map keyed by node name.
  Fix: rename the verb in your TSL (repeat the line per node). If you READ frames
  (`Partition_Node::read_latest_snapshot_cache()`), pass the new required `$node`
  argument and descend `cache[<node>]`. Frames written by 0.50.x skip their snapshot
  restore once on upgrade (state re-accumulates; cursors resume normally).
- **`Job_Router` (event-logger) sheds `stale_timeout`** — staleness is the new
  `Age_Sieve` node's job. Fix: drop Job_Router's positional argument and wire
  `make_node Age_Sieve jobs:sieve 60 1` between it and `jobs:partition`.

## 0.50.0

- **Consumer cursors re-keyed to `{topology}.{source}.pN`.** Offsetlog paths in the
  stock topologies flip from `{source}.{topology}.pN`; no migration shim — on upgrade
  every consumer starts from its `default_offset` (the firehose default is `recent`).
  Fix: nothing to do unless you pinned custom offsetlog paths; then re-key them to
  match and expect one cursor reset.

## 0.48.0

- **Profiling verbs collapsed into one `profile` toggle.** `enable_profiling` and `disable_profiling` are removed (no alias): bare `profile` toggles, `profile on` / `profile off` set idempotently. Anything invoking the old pair gets an unknown-command error. `list_profiles` is unchanged.

- **CommandInterpreter verb `debug_state` renamed to `trace`.** The per-node/interpreter trace toggle is now the `trace` verb (`trace [ <node> [ <level> ] ]`); the old `debug_state` name is gone (no alias). Anything invoking `debug_state` at the REPL or over the wire gets an unknown-command error — use `trace`. The `debug_state` node *property* and the `dump_metadata` `debug_state` field are unchanged.

## 0.47.1

- **Dashboards / hub verbs** — `Aggregator_CI` dropped its dead `status`, `health`, and `servers` verbs. Anything invoking them gets an unknown-verb error; read `summary` and `servers_status` instead.
- **JS runtime** — the `Core.reinit` global is retired; the overlay's Reset-Graph capability is now the `Core.rebuildable` boolean.
- **Node schemas** — a `node_schema()` argument whose `<config:…>` default resolves to no registered key (unknown namespace, unowned key, non-scalar) now throws instead of silently coercing to `''`. If a node stops constructing, its schema default names a key that no longer exists — check the retention keys in particular (`min_segments` / `max_segments` / `min_lifetime` / `max_lifetime`). Topology-line interpolation is unchanged (an unowned token still interpolates to `''`, Tachikoma parity).

## 0.47.0

- **Command envelopes and `arguments()`** — TM_COMMAND `arguments` and node-constructor `arguments` are a flat token array (`list<string>` argv) end to end, no longer a single space-joined string. Verb handlers receive `array $args` and index it; `Node::arguments()` / `parse_schema_args()` take and return token arrays; anything minting a command envelope by hand passes a token list. `Command_Args::parse()` / `format()` speak tokens on both sides; the only join-back-to-a-line lives in `Node::serialize_args()` / JS `serializeArg`. TM_INFO / TM_REQUEST / TM_BYTESTREAM VALUEs are unchanged.
