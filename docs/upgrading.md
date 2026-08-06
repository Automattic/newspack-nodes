# Upgrading

Breaking changes that affect a plugin built on the substrate — topology files, Node subclasses, job handlers, dashboards, the wire — with the fix beside each. Start at your installed version and apply everything above it. Internal refactors and fixes are not listed; [CHANGELOG.md](../CHANGELOG.md) has the full story per release.

**Maintenance rule:** a release that changes any consumer-facing contract adds its entry here in the same commit as its CHANGELOG entry. No entry means nothing to do.

## 2.11.0

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
  `housekeeping`.** The report is still seven results. The new one is
  load-bearing in a way the old one was not: fleet housekeeping — retention,
  orphan partition and IPC reaping, the delayed-jobs sweep, alert emission and
  every `newspack_nodes/periodic` subscriber — now runs as a job, so an active
  fleet with no `Job_Worker` topology loses all of it silently. If doctor
  reports it CRITICAL, run `wp nodes activate job-worker`.

- **The `TopicProbe` node type is renamed `Topic_Probe`.** The class is
  `Topic_Probe_Node`, matching its sibling `Job_Probe_Node` and ADR-10. There is
  no alias: a topology whose own file says `make_node TopicProbe <name> [interval]`
  fails to resolve a class at load. Rewrite it to `make_node Topic_Probe …`.
  Stock `topic-probe.tsl` is already updated, so an `include topic-probe` needs
  no change, and neither does the node name `topicprobe` or the `topicprobe.p0`
  log path.

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
