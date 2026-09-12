# Troubleshooting

Live-investigation reference for the substrate: the REPL, worker health, log paths, and the failure modes we actually hit. For the conceptual model behind all of it, read [architecture-guide.md](architecture-guide.md); for every `wp nodes` verb, its flags and what each `doctor` row means, read [cli.md](cli.md).

Reach for this page when:

- a worker is supposed to be running but isn't,
- a message you produced isn't flowing through the graph,
- workers keep respawning, or
- you want to inspect node state without restarting anything.

## REPL: `wp nodes cli`

![Four lanes, terminal, the cli's own graph, the worker's ipc directory on disk and the live worker, with six numbered hops: a typed line becomes a signed TM_COMMAND stamped FROM=_output/<pid>, is appended lock-free to input/ under the 4096-byte cap, is tailed by the worker's input Consumer which prepends _repl, is answered TO=FROM into output/ under void_warranty, is tailed back and rendered only when the Dumper's pid filter matches, and a TM_EOF echo ends the session. A panel above the hops shows the two-step attach resolution and its two refusals; three cards below cover bare mode, the root refusal and concurrent sessions.](img/ts-repl-modes.png)

Bare (`wp nodes cli`) runs commands in the wp-cli process itself and starts at secure level 0; use it to exercise interpreter verbs without touching a worker. Pivoted (`wp nodes cli <type>.p<N>`) attaches to a live worker through the IPC pair, and `dump_node`, `connect_node` and `disconnect_node` act on the running graph with no restart. The worker ids in the examples below are placeholders — run `wp nodes status` for the live ones. A root cli would seed `{base}/ipc/{type}.p{N}/input/` as root; if that has already happened, recover with `chown -R <web-user>:<web-user> {base}`.

The 4096-byte cap on hop 2 is [`Partition_Node::MAX_LINE_SIZE`](../includes/class-partition-node.php), and only the outbound leg carries it; the reply leg's `_repl` Partition calls `void_warranty()` precisely so a whole `dump_metadata` can return.

### Verbs

These verbs are dispatched by the interpreter the cwd points at:

```
make_node <type> <name> [<args>]      construct a registered Node (alias: make)
move_node <name> <new name>           rename a node (aliases: move, mv)
remove_node <name> [<more>...]        remove by name, or -a <regex> — anchored — for a batch (aliases: remove, rm)
set_sink <node> <target>              rewrite a node's sink at runtime
connect_node <node> [<target>]        add a target; <target> defaults to the issuer's FROM (alias: connect)
disconnect_node <node> [<target>]     remove a target; undoes a self-connect (alias: disconnect)
register <source> <target> <event>    subscribe <target> to <source>'s <event>
unregister <source> <target> <event>  drop that subscription
reply_to <node path> <command>        run <command> HERE, route its reply to <node path>
list_nodes [-clst] [<node>]           nodes sinking INTO <node>; -c counters -l counters+targets -s sinks -t targets (alias: ls)
list_nodes -a [-clst] [<regex>]       every node whose name matches <regex>
dump_node <node> [<keys>]             config + state of one node (alias: dump)
dump_config [<regex>]                 the running topology as round-trippable shell verbs
dump_metadata [<node>]                JSON keyed by node name; bare, one round trip draws the whole graph
stats [-a] [<node>|<regex>]           NAME COUNT LGST_MSG READ WRITTEN; nodes sinking INTO <node>, -a for every name matching <regex>
uptime                                UTC clock, then elapsed at the coarsest scale that fits: 07s, 3m 04s, 2h 09m, 4d 01:12:33
pwd                                   the cwd and the reply's FROM trail, as ` <cwd> -> <from>`
list_timers [-s]                      ID ACTIVE INTERVAL MODE NEXT ONESHOT FIRES TYPE NAME
list_handles [-s]                     ID COUNT TYPE NAME — the cURL-multi handles the drain loop selects on
profile [on|off]                      toggle or set _router's per-node self-time profiling
list_profiles [-s] [<regex>]          the profile table, slowest average first
trace [<node>|*] [<level>]            set a node's debug_state, tracing set_state() to _repl; bare toggles this interpreter, * reaches every node
log <message>                         write <message> to the worker's stderr
dmesg                                 this process's last 100 stderr lines
taillog [<source>] [<max_kb>]         tail a registered log FILE by name; no args lists the registry
secure [<level>]                      climb the ratchet 1..3; bare climbs one level, and it never descends
insecure                              declare this process deliberately unratcheted; refused once secured
help [<topic>]                        the full help, or one verb
```

`-s` on `list_timers`, `list_handles` and `list_profiles` returns the same rows as a struct, for a view that wants to sort them. Secure levels freeze definitions without stopping the flow, and they enforce cumulatively: level 1 disables the `make_node` class (`make_node`, `move_node`, `remove_node`), level 2 adds the `command_node` class (`reply_to`), and level 3 adds the `connect_node` class (`connect_node`, `disconnect_node`, `set_sink`, `register`, `unregister`) — aliases included throughout. A node classifies its own verbs into those classes through `node_schema()['verb_classes']`.

These mint an addressed message. The Shell composes `<path>` with the cwd through `prefix()`, so inside `wp nodes cli job-worker.p0` — or after `cd job-worker.p0` — `command_node jobs:consumer:config dl_list` addresses `job-worker.p0/jobs:consumer:config`. All but `ping` need a non-empty `<path>` and answer `usage: …` without one, so `command_node "" <verb>` does NOT address the cwd; to reach the cwd itself, type the verb bare, since any verb the Shell does not intercept becomes a TM_COMMAND addressed there. Bare `ping` measures the round trip to the cwd.

```
command_node <path> <verb> [<args>]   TM_COMMAND, without changing cwd (aliases: command, cmd)
request_node <path> [<value>]         TM_REQUEST; the receiver replies TO=FROM (alias: request)
tell_node <path> <info>               TM_INFO, fire-and-forget (alias: tell)
send_node <path> <bytes>              TM_BYTESTREAM (alias: send)
send_struct <path> <json>             TM_STRUCT (alias: send_struct_node)
send_eof <path>                       TM_EOF
ping <path>                           round-trip latency probe
```

These are Shell builtins. They act on session state and mint nothing:

```
cd [<path>]                           change cwd; an empty path resets to the local interpreter (alias: chdir)
status                                the local cli mode summary
include <topology>                    eval a REGISTERED topology's lines through this shell; never a path
var [<name> [<op> [<value>]]]         list every shell variable, read one, set it, or delete it
print <text>                          echo to the terminal
clear                                 clear the screen
debug_level [0|1|2]                   the local Dumper's verbosity
show_parse                            toggle a parsed-command dump before every command
```

### Reaching a node's own verbs

A node that declares commands in `node_schema()` gets a sibling interpreter named `{node}:config`, and `command_node` addresses it. That is how the [dead-letter triage verbs](../includes/trait-dead-letter-queue.php) are reached, for instance:

```bash
echo 'command_node jobs:consumer:config dl_list' | wp nodes cli job-worker.p0
# {"rows":[],"total":0,"unindexed_segments":0}
```

`dl_list` lists quarantined records newest-first with a `segment:offset:length` locator; `dl_show <locator>` decodes one; `dl_requeue <locator>` redelivers it to the node's sink and leaves the queued copy in place; `dl_purge` deletes every dead-letter segment.

### How replies find you

Hops 4 and 5 above: the Shell stamps `FROM=_output/<pid>`, a reply comes back with TO=FROM, and `_output` renders it or drops it on its pid filter. [`Command_Interpreter_Node`](../includes/class-command-interpreter-node.php) handles only TM_COMMAND with an empty TO; a non-empty TO means the message is in transit toward another node, so the interpreter forwards it to its sink and lets the addressed node decide. Any exception a verb throws is caught and returned as `TM_COMMAND|TM_ERROR` along the FROM trail, rendered on **stdout** with no prefix and no separate stream.

### Piping into the REPL

Redirect stdin and readline is skipped: `readline_callback_read_char()` reads a TTY layer that never sees the pipe, and polling it burns 100% CPU. Neither mode announces itself: the summary is stashed at startup and printed only by the `status` builtin.

Prompts and readline are two flags rather than one, and [`CLI_Command::terminal()`](../includes/class-cli-command.php) resolves them apart: prompts follow `posix_isatty( STDIN )` alone, while readline needs that AND a `readline_callback_handler_install` to call. Missing completion on a real terminal is a PHP build without ext/readline, not a broken completion path.

```bash
# Drive the REPL non-interactively for scripted testing.
printf 'ls\ndump my-node\n' | wp nodes cli
```

## Worker health

```bash
wp nodes doctor                            # the environment and fleet report; WARN exits 0, FAIL exits 1
wp nodes types                             # the active topology groups, with partition count and stale timeout
wp nodes status                            # per-partition state, heartbeat age, uptime and lag; --format=json for scripts
wp nodes run <type> [--partition=<N>]      # run a worker in the foreground — boot errors hit your terminal
wp nodes restart all                       # flag every worker to recycle
wp nodes restart <type> [--partition=<N>]  # one type; every partition of it unless you name one
wp nodes stop [--timeout=<s>]              # hold the fleet and wait for every lock to clear (default 90s)
wp nodes start                             # release the hold and spawn
```

`doctor`'s three alert rows come from [`Alerts::evaluate()`](../includes/class-alerts.php), which reads its thresholds live on every run, so the report never trails a setting you just changed. `alert_emit_interval` throttles the journal alone: `Alerts::emit()` writes at most one batch of alert transitions into `alerts.p0` per that many seconds, 300 by default.

![A decision tree in two tiers. Tier one branches wp nodes status into its seven slot states, live, stale, down, idle, held, inactive and live (inactive), each with what wrote it and what to do; tier two branches wp nodes run's exit status into ok with its eight named cooperative stops, skipped (lock_held), the two I/O skips and load_failed with its exactly three causes. A bottom row names six faults whose cause no status row names: the 409 fleet_held hold, the multisite 403, the write-conflict refusal, the missing reconcile cron, a graph holding only scaffolding, and a swallowed fleet scan.](img/ts-worker-not-running.png)

`wp nodes run` keeps the process attached, so its stderr reaches your terminal, and closes with `Worker exited with status:`. `wp nodes status` reads each state from evidence the fleet writes rather than inferring it: the heartbeat under `{base}/locks/{type}.p{N}.lock.d/heartbeat` against the topology's `stale_timeout`, the lock's presence, the hold option and the active set.

Uptime comes from the lock directory's `started` file. Alongside `heartbeat` and `started`, three flag files let any other process steer the holder: `restart` (exit and hand the slot straight to a successor), `stop` (exit and leave the slot empty for the length of a deploy) and `reload` (re-read config without exiting).

## Log layout

Under the runtime tree `{base}`:

- `logs/{name}.p{N}/{seg}.log` — the durable partitions, holding packed Message envelopes
- `locks/{type}.p{N}.lock.d/` — `heartbeat`, `started`, and the `restart` / `stop` / `reload` flags
- `ipc/{type}.p{N}/{input,output}/{seg}.log` — bidirectional IPC for `wp nodes cli`, with the input consumer's cursor in `input.offsets/`
- `offsets/{reader-id}/{seg}.log` — durable reader checkpoints (the offsetlog); the reader id already carries its own `.p{N}`, as in `job-spoke.jobs.p0`
- `deadletter/{reader-id}/{seg}.log` — a reader's quarantined poison records and their `.idx` sidecars
- `deadletter/{dotted-path}/{seg}.log` — a Partition's write-stall quarantine, named for its own directory under the base with the slashes dotted, as in `logs.firehose.p0`
- `topologies/{name}.tsl` — operator-written topologies, resolved only for names no plugin's stock dir already owns
- `layouts/{name}.layout` — saved dashboard node positions

Eight of those partitions are the substrate's own: `topicprobe.p0` (the consumer-stats sweep), `jobstats.p0` (per-job-identity stats), `alerts.p0` (the alert journal), `settings.p0` (watched-option changes), `jobs.p{N}` (the job queue the worker pool drains), and Job_Intake's three ingresses `jobintake.p{N}`, `jobfeed.p{N}` and `jobdelay.p0`. Everything else under `logs/` is whatever Partition or Log an application's topology constructs — the event logger's `firehose.p{N}`, for one.

`settings.p0` is the one whose geometry ignores the retention settings. [`Settings_Event_Writer::partition_args()`](../includes/class-settings-event-writer.php) pins it at 5 MiB segments, a count target and floor of two segments and a one-day age rule, so raising `num_segments` or `lifetime` does not lengthen the Config Audit history. Because the count target equals the floor, every rotation prunes straight back to two segments and the day-long age rule never removes anything the count rule has not already taken: the retained history is the previous full 5 MiB segment plus the current one, which on a quiet install reaches a very long way back.

The `base_directory` setting names that tree and defaults to `/tmp/newspack-nodes`. Override it under Settings → Nodes Runtime, in `newspack-nodes-config.php`, or in the file named by `LOCAL_NEWSPACK_NODES_CONF`; a stored option beats both files, by presence rather than truthiness.

A partition directory also holds `{seg}.idx` sidecars beside some of its `{seg}.log` files. Partition writes one only when a `with_index()` formatter is installed — the default mode writes none — and the `.idx` holds a JSONL index for offset lookups. A missing `.idx` is normal, not corruption. A `Log` node lays its segments out flat instead, as `{file}.0`, `{file}.1`, … at the first level.

Every companion a `Log` writes is keyed by the FILE rather than the directory: `{file}.{seg}.idx` when a formatter is installed, and the two mkdir locks `{file}.rotate.lock.d` and `{file}.write.lock.d`, where a Partition puts `.rotate.lock.d` and `write.lock.d` inside its own directory. A directory holds exactly one Partition but any number of Logs, so a directory-named lock would make unrelated Logs wait out each other's rotations. The same rule reaches the quarantine bullet above: `write_quarantine_key()` is the directory for a Partition and the file for a Log, so a stalled Log quarantines into `deadletter/{dotted-path-including-the-filename}/`, as in `logs.digest.md`. Look for a stalled Log's lock beside its segments, never inside a directory named for it.

`layouts/{name}.layout` is not the only copy of a canvas layout. The topology console keeps a second, browser-only map of node positions and viewport in `localStorage`, one key per scope — the edit draft, view mode, and each debug-overlay cwd — and a drag or a drop writes only there until an operator saves. Once a person has moved anything, [`useCanvasLayout()`](../src/topology-console/hooks/useCanvasLayout.js) lets that browser copy outrank the saved file until the two maps agree entry for entry, at which point it clears the flag silently. So a dragged card can look as though it did not persist across a reload before a save, and a stale browser copy can go on showing positions a teammate's saved layout no longer holds. The Reset Layout chip is the cure: it removes the `localStorage` entry and lays the graph out again.

## Common failure modes

**A worker spawns but exits immediately.** Read the status `wp nodes run` prints against the tree above. One application-side cause hides from it: the event logger's `Log_Manager` bails inert under root rather than leaving root-owned segments the web user could never append to, so a wp-cron run with `--allow-root` produces a worker that runs and logs nothing. Run wp-cron as the web user.

**A worker boots healthy and a whole subgraph is missing.** Everything the loader does not treat as fatal prints one line and carries on, so the statement's effect is simply absent from a running worker. An `include` naming an unregistered topology, or one carrying a `/` — `resolve_include()` takes a registered NAME, never a path — reports `Shell: include: file not found:`; a minting verb without its path answers `usage: send <path> <bytes>`; a malformed `var` assignment answers `var: invalid operator:`; a `send_struct` whose JSON will not decode answers `send_struct:` and the decoder's own complaint. A node whose constructor refuses is the same shape, since `make_node` is dispatched by the interpreter rather than the Shell: a Partition whose `segment_size` token resolves empty throws `segment_size must be a positive byte count, got 0`, which surfaces as `error from TM_NOREPLY command:` and leaves the graph one node short. Every one of those lines is rate-limited and takes the node stderr chain into `error_log()`, because a booting worker mounts no `_stdout` for the Shell to write to — so read the PHP error log rather than waiting for a failed spawn. When the refusal names a `<config:…>` token, check `wp nodes doctor`'s `config-keys` row before suspecting the `.tsl` line.

**Every storage-backed command throws "Runtime directory … is owned by uid N" or "… is writable by group or other".** [`Config::get_base_directory()`](../includes/class-config.php) refuses a tree this process does not privately own, because whoever owns the base path owns every log, lock, offset and topology beneath it, and a planted `.tsl` runs with full interpreter authority on the next spawn. Root is exempt from the OWNERSHIP half and warned instead, since a root-owned file is what the web user cannot append to; the group-or-other-writable half refuses every uid, root included. Recover with `chown -R <web-user>:<web-user> {base}` and `chmod -R go-w {base}`. `wp nodes doctor` survives the refusal and shows it: the `filesystem` row carries the message verbatim, and the `ownership` row repeats the uid comparison advisorily.

**A Table reads empty while its records are on disk.** [`Table_Node::lookup()`](../includes/class-table-node.php) answers from the cache only on a `Cache_Backend::READ_HIT`. A miss, an expiry and a backend READ_ERROR all take the same branch — through the durable backing when `backed_by()` installed one, and back as null when it did not — so a flapping memcached degrades a table to its system of record silently, and a table with no backing simply reads empty. The one signal is a rate-limited `Table: backend read error for <namespace>:<key>` on the worker's stderr; grep for it before concluding nothing ever wrote the key. A miss is never remembered as a miss, so a caller polling for a key it expects sees it as soon as the cache does.

**No worker spawns, and stderr repeats "refusing to spawn — topology write-conflict".** Two active topologies claim one write path — a data log, a Consumer's offsetlog or its dead-letter dir — and the line names both and the first path they share, still in its `<config:…>` token form. Deactivate one of the two named topologies; activation consults the same analyzer, so it refuses to persist the conflicting set in the first place.

**A topology saved clean and the next worker spawned from it dies.** `cmd_save` on the `topologies` CI runs a dry run rather than a build: `Shell_Node::parse_statements()` for syntax, then [`Topology_Analyzer::expand()`](../includes/class-topology-analyzer.php) for an unknown include, a cycle, and a body `make_node` conflicting with one an include provides. Nothing instantiates a node, so a body naming an unknown class — or handing a real one the wrong argument shape — saves without complaint and fails only at the next spawn. Restart the fleet, or run `wp nodes run <type>` in the foreground, to read the constructor's own refusal.

**`wp nodes doctor`'s `cache-backend` row says "Could not verify…" instead of naming a backend.** Read the message [`Health_Probe_Client`](../includes/class-health-probe-client.php) chose against the table below; the two red rows mean worker respawn is impaired too.

![The loopback probe to newspack-nodes/v1/health/cache, bounded at 5 seconds, following no redirect and reading at most 2,048 bytes, then two tables. When the loopback answered: 301 through 399 is a declined redirect, 401 is HTTP authentication fronting the site, 403 is a refused token from a wp_salt('nonce') mismatch or clock drift past the ten-second window, 404 is an absent route from mismatched plugin versions, any other non-200 reports its number, and a 200 of the wrong shape reports it malformed. When the transport failed: a timeout, classified first and silent about respawn; a DNS, connection or TLS failure by cURL code; and an unclassified failure. The 401 and DNS rows are red: Spawn_Coordinator posts across the same loopback through Core::fire_and_forget_post(), which reads no status, so nothing spawns and nothing logs. A note says every result is recommended, so doctor exits 0.](img/ts-cache-probe-verdicts.png)

**Every slot reads `held`.** The hold is an option rather than a file under the base directory precisely so it survives a deactivate/reinstall cycle that wipes `/tmp/newspack-nodes`.

**Retention, alerts and cold-start revival all stopped, while every other check stays green.** The `newspack_nodes/reconcile` cron event is gone. That minute pass carries log retention, orphan partition and IPC reaping, alert emission, the delayed-jobs sweep, every `newspack_nodes/periodic` subscriber and cold-start worker revival; `doctor`'s `housekeeping` row names the recovery.

Check first whether something is vetoing the event, or the one you schedule vanishes again immediately. The substrate registers a diagnostic on `pre_schedule_event` and `pre_reschedule_event`, plus a `schedule_event` pair that catches the late veto which erases the hook name along with the event object. Grep the error log for `reconcile cron vetoed:` — the line carries `filter=<hook> value=<false|code: message> callbacks=[<priority> <Class::method>, …]`, and the culprit is in that list by definition. A `wp_schedule_event()` that refuses logs `reconcile cron schedule failed:` with the WP_Error code and message instead. Both ride `Core::print_less_often()`, so they are rate-limited rather than one line per attempt.

**A setting you changed has no effect.** `wp nodes doctor`'s `config-keys` row lists every key in `newspack-nodes-config.php` that the settings schema does not declare. A deploy copies the operator's own file over the shipped path, so a key renamed in the schema leaves a stale entry behind whose value is silently ignored while the real key sits on its default.

The settings page itself is the other cause, and it says nothing either. [`Admin::sanitize_base_directory()`](../includes/admin/class-admin.php) reduces a relative path, one containing `..`, or one holding a NUL byte to `''`; `Admin::sanitize_memcache_servers()` drops any line failing `host:port`; `Admin::sanitize_log_sources()` drops any line `Log_Sources::parse_entry()` rejects. Every non-boolean field is delete-on-blank, so `Reset_Gate::resolve()` reads that empty result as a reset, deletes the option row and returns the OLD value — the field snaps back to its config-file or schema default with no error rendered. Confirm what actually resolved with `wp nodes doctor`, whose `filesystem` and `ownership` rows both print the resolved base directory, rather than by re-reading the form.

**Every request fatals, wp-admin included, and the log names `Config::load_config_file()`.** A config file that returns anything but a tree of scalars, nulls and arrays is refused: [`Config_Utils::load_config_file()`](../includes/class-config-utils.php) throws `RuntimeException`, and config is read before anything renders, so the site is recoverable only over SSH. The usual cause is an operator file missing its `return`, since `require` then yields int `1`. Two messages come out of this — `Newspack_Nodes\Config::load_config_file() rejected: config must return array of scalar/array values only` for the file itself, and `Newspack_Nodes\Config::validate_config_path() failed: …` on stderr for a bad `LOCAL_NEWSPACK_NODES_CONF` — and both name a method that does not exist on `Newspack_Nodes\Config`, because each caller passes its own class name as the message prefix and `Config_Utils` interpolates it in front of its own method name. Grep for `Config_Utils`, not `Config`. Recover by ending the file in `return [ … ];`, or by unsetting `LOCAL_NEWSPACK_NODES_CONF`. The shipped-config path is guarded by `file_exists()` alone, so a file that exists but is unreadable fatals inside `require` before any of this validation runs.

**A settings change never reaches Config Audit or the spokes.** [`Settings_Event_Writer::default_append()`](../includes/class-settings-event-writer.php) runs on every watched option change, in whatever request made it, so it must never fatal the caller it observes: it catches `\Throwable` and reports through `Core::print_less_often( 'settings-writer: ' … )`. An unusable logs directory — a symlinked `logs` leaf, a foreign owner — therefore loses the event with no symptom past that rate-limited line, which the limiter can suppress outright. Grep the error log for `settings-writer:` before suspecting the consumer or the topology. `Worker_Should_Stop` is the one exception, re-thrown ahead of the broad catch ([ADR-14](architecture-decisions.md#adr-14-cooperative-stop-propagates-through-broad-catches)), so a command handler calling `update_option` inside a worker drain does not have its stop swallowed.

**A message you produced is not flowing.**

![Six stations across the top, producer, _router, Tee or Grep, Partition, Durable_Reader and Job_Worker, and four columns of cases beneath them: the Router's four stderr drops, the Tee terminus and no-sink throw and the filter counter reading, the oversize drop with its two 32 MiB opt-ins, the unflushed batch and the write-stall quarantine, the DEAD-LETTER [throw] of a mid-deploy swap and the OVERFLOW state at 32 MiB, then a full-width case for Job_Worker's silent drops. A red case header is the stderr line to grep for; a grey one is a counter or state reading that has no line.](img/ts-message-not-flowing.png)

**A reader is falling behind, and `wp nodes doctor` warns on the `consumer-lag` row.** A reader warns once its distance from the head of its source passes `alert_lag_threshold`, which counts BYTES and defaults to 67108864 — one segment at the default `segment_size`. `wp nodes status` prints the same distances reader by reader. Both read the `Topic_Probe` sweep, which appends one record per READY Consumer at the cadence `topic-probe.tsl` declares, 15 seconds as shipped. A row whose record has aged past two sweeps is re-measured off disk, so a reader that died caught up reports the backlog piling up behind it rather than its parting snapshot. Lag that climbs under a live reader means the producer outruns it: widen the topic across more partitions, one Consumer each.

The table lists readers that reported recently, not every reader on disk. `read_probe_frames()` indexes only the newest topicprobe segment's last 128 KiB, so a reader whose last record has scrolled out of that window is absent from the map entirely — it drops out of the table rather than being re-measured, and a vanished lag row is therefore no evidence that the reader caught up. Inside the window, a re-measured row reports `Msgs/int` 0 deliberately, since nobody is reading and the rate is zero rather than the last one seen, and the re-measure is abandoned — the stale numbers stand — when either directory cannot be rebuilt from the record's basenames or the cursor is uncommitted, because reading a missing offsetlog as "no cursor" would report the whole partition as backlog.

Every reader reporting `Msgs/int` 0 at once, under a fleet that is plainly live, is that re-measure firing on all of them: the sweep now runs further apart than the staleness threshold allows. [`Topic_Probe_Node::stale_after_s()`](../includes/class-topic-probe-node.php) is twice the interval declared in the topology named `topic-probe`, and reads no other topology, so declaring `Topic_Probe` with a longer cadence in an application topology leaves the threshold at the shipped 30 seconds while the records arrive further apart than that. Retune the interval in the resolved `topic-probe.tsl` instead. Nothing warns — the threshold and the sweep disagree in silence.

**The Overview board and `wp nodes doctor` disagree about a topology's health.** They measure different things on different cadences. The board's per-topology badge rolls up in the browser from [`useTopologyManager`](../src/event-dashboards/hooks/useTopologyManager.js): `stalled` means at least one partition's worker heartbeat came back `stale`, the same state `wp nodes status` reports, and `behind` means some consumer's catch-up ETA reaches 60 seconds, derived from that consumer's backlog and its read rate. `doctor`'s `consumer-lag` row counts BYTES against `alert_lag_threshold` instead. So a topology can read `ok` on the board while `doctor` warns on it, and the reverse, with neither reading wrong.

**A reader is missing from the consumer table although it is polling.** [`Probe_Record`](../includes/class-probe-record.php)'s READER slot is the basename of the consumer's offsetlog directory, and an ephemeral reader — one constructed with an empty `offsetlog_dir`, such as the cli's own reply leg — writes it blank. Every consumer of `topicprobe.p0` keys on that slot: `CLI::consumer_rows()` skips any id not ending `.p{N}`, and `Probe_To_Graphite_Node::fill()` drops a blank-READER record outright. Such a reader therefore appears in no `wp nodes status` row, no Overview series and no Graphite path while working normally. That is deliberate — admitting a blank id would merge every ephemeral reader in the process into one series — and not a fault to chase.

**Dead letters are accumulating.** `wp nodes doctor` warns on the `dead-letters` row once a reader passes `alert_deadletter_threshold`, which counts quarantined SEGMENTS and defaults to 0, so the first one warns. Inspect them with `dl_list` / `dl_show` on the reader's `:config` interpreter, redeliver one with `dl_requeue`, or replay a whole segment back through its topic with `wp nodes ingest <topic> {base}/deadletter/<reader-id>/*.log`. `dl_purge` clears them, which is a convenience rather than a correctness requirement: the queue rotates 1 MiB segments, prunes back to sixteen of them by count, and is capped at thirty-two however small they are. The age rule is deliberately off — a record that sat all weekend is exactly the one an operator comes back for — so quarantine ends by COUNT alone, and thirty-two segments is the whole history there will ever be.

**Disk fills with directories nothing writes any more, or `wp nodes gc` reports no orphans while they pile up.** Deactivating a topology orphans its log and offsetlog directories for [`Log_Cleaner`](../includes/class-log-cleaner.php) to sweep; stopping its workers does not. Grep stderr for `Log_Cleaner: skipping sweep:` before trusting any orphan list, and reserve `wp nodes gc --force` for a topology you just tore down.

![The sweep as five gates down the left: build the declared set from every active topology, capped at 16 partitions, plus the registered log producers; sweep logs/ only on a non-empty set and offsets/ even on an empty one; consider directories alone, so a Log's flat segments are never reclaimed; keep any basename in the declared set; keep anything written within DELETE_GRACE_S, 3600 seconds, which --force drops to zero; then delete, jailed to the base. Three red cards on the right: the three degraded inputs that skip both sweeps while gc still reports success, --force deleting the delayed-jobs cursor so every retained entry is re-delivered, and a Topic wider than 16 partitions losing p16 and up to the sweep.](img/ts-orphan-sweep.png)

**An on-demand worker reads `idle` and never wakes.** A producer inside the substrate marks the partition directory and wakes the reader on flush. A producer outside it — gyrobase appending to a segment in Perl — is noticed only by the minute pass's `wake_readers_with_backlog()`, which wakes on backlog and never on presence. If the minute cron is not running, nothing wakes it; see the housekeeping entry above.

That pass considers only readers whose descriptor carries a non-empty `offsetlog_dir` and whose cursor [`Consumer_Node::lag_from_disk()`](../includes/class-consumer-node.php) reports as known. A reader with an ephemeral cursor, or one that has not yet checkpointed, is skipped outright: reading "no cursor" as "the whole partition is behind" would respawn it every minute forever, keeping resident by another route a worker on-demand exists to scale away. So an on-demand topology whose consumer keeps no offsetlog has NO revival tier at all when its only producer sits outside the substrate, since `worker_needs_spawn()` also declines to resurrect a cleanly absent on-demand worker. The pass spawns the specific backlogged worker rather than the whole group, so a behind job-router does not drag a drained request-builder up with it.

**An on-demand topology never scales to zero although `on_demand_idle` is set.** The exit fires only once EVERY [`Idle_Reporter`](../includes/interface-idle-reporter.php) in the graph has stayed idle for the whole window, and the substrate implements that interface on `Consumer_Node` alone, which `Tail_Node` and `File_Tail_Node` inherit. A graph built entirely from nodes that implement none has nothing to measure and stays resident forever, recycling on `max_runtime` like a resident topology. Nothing flags it — a worker that keeps running earns no `doctor` row and no alert — so the fix is to implement `Idle_Reporter::idle_since()` on whichever node should count toward the window.

**A verb comes back "`make_node` is disabled at secure level 1".** Every stock topology ends with `secure`, so a worker built from one runs at level 1 and refuses the whole `make_node` class. Reads, dumps, wiring and every other verb still work — the ladder freezes definitions, it does not disable the machine. The ratchet never descends, so there is no unlock from the REPL: add the node to the `.tsl` and `wp nodes restart <type>`, or reproduce the graph in a bare `wp nodes cli`, which starts at level 0.

**`wp nodes cli` runs at 100% CPU.** Readline was installed in a non-TTY context. The `posix_isatty( STDIN )` gate makes that unreachable, so treat a recurrence as a regression in `CLI_Command::terminal()`, which resolves the stdin stream and the readline policy once for the whole session.

**A command typed in the browser console answers `[no sse_pid yet] retry once CONNECTED`.** The statement addressed a worker-scoped TO while no SSE session was attached, so [`OutgoingGateNode`](../src/topology-console/core/outgoingGate.js)'s guard refused it in the browser and nothing left the page. The guard runs before the send stamps anything, which is why the identical statement can simply be resent once the stream reads CONNECTED — this is neither a network failure nor a refusal from the worker.

**A worker pegs 100% CPU with no traffic, or is slow, or recycles.**

![Two mock REPL tables and their readings. In list_timers a spinner row shows NEXT at or below zero with FIRES climbing, a hitchhiker row shows MODE router and NEXT dash, and a dashed ghost row marks the never-named timer that gets no row. In list_handles a stuck row persists with a COUNT that never moves, beside the routine zero of a node that just re-registered or closed its 512 KB / 256 KB backpressure valve. A third card gives the profile on, list_profiles, profile off sequence and the 595-second recycle; two bottom cards contrast Worker_Should_Stop, which replays the in-flight message, with Worker_Should_Stop_Clean, which commits past it, and explain a long job running twice as a lock stolen after stale_timeout.](img/ts-pegged-worker.png)

**Delayed and retried jobs never fire.** [`Job_Delay::sweep_action()`](../includes/class-job-delay.php) wraps the whole pass and writes `Job_Delay::sweep failed: <message>` to stderr, deliberately, so a throw does not cost the other `newspack_nodes/periodic` subscribers their turn. Nothing else surfaces it — no `alerts.p0` row, no `doctor` check, no verb reporting delay-log depth — so a sweep failing every minute is invisible outside the PHP error log while `not_before` jobs and every `Job_Worker_Node` retry backoff quietly stop firing. Confirm the reconcile event is scheduled from `doctor`'s `housekeeping` row, then grep stderr for BOTH prefixes: `Job_Delay::sweep failed` for a whole aborted pass, and `[Nodes] JobDelay:` for the per-entry `dropped undeliverable due entry`, `delivery deferred` and `failed to circulate`. One grep finds half the evidence.

**A handler is missing from the Jobs tab although it ran recently.** [`Job_Probe_Node::probe()`](../includes/class-job-probe-node.php) publishes whatever `Job_Worker_Node::probe_stats()` holds, and that accumulator lives in the worker PROCESS: it is empty until the identity's first run there. A drained identity keeps reporting zero-delta records with live last-run detail for as long as the process lives, but the ~595s recycle wipes it, so a handler firing less often than that publishes nothing between runs and the dashboard evicts its key after five minutes. An empty Jobs tab on a freshly spawned fleet is that, not a fault; the durable evidence is `jobstats.p0` itself, never the live view.

**The Jobs tab does not go back a full day.** Jobstats volume is identities times job-worker processes times sweeps per day — 5760 at the shipped 15-second cadence — and three caps bite it. The durable log is the first: `job-worker.tsl` builds `jobstats:log` at 1 MiB segments with `num_segments` 8 and `max_segments` 0, and a zero derives a hard cap at twice the target, so above 16 MiB the oldest segments are pruned unconditionally whatever the declared lifetimes say. The browser ring is the second: [`ProbeStreamViewNode`](../src/event-dashboards/nodes/probe-stream-view-node.js) sizes it at one slot per identity per 15 seconds over 24 hours, and the key is the identity alone, so a wide pool contributes one sample per partition per sweep and overruns the ring at the default cadence. The cadence itself is the third: nothing reads Job_Probe's declared `interval_s` back — Topic_Probe has `declared_interval_s()`, Job_Probe has no analog — while the ring size and the chart's bucket base both hardcode 15, so declaring a shorter cadence on the `make_node Job_Probe` line shortens the retained window and misaligns the buckets, with no error anywhere. Widening partitions is what the `consumer-lag` entry recommends, so this is the cost of taking that advice.

**`Core::node( 'foo' )` returns null inside a constructor.** A node built earlier in the topology cannot see one built later, and a constructor in request scope has no event loop at all ([ADR-5](architecture-decisions.md#adr-5-lazy-init-for-topic--partition)). Register for the peer's `READY` state, or make the lookup lazy at first use.

**A Remote_Source never connects and the lag table has no row for it.** [`ensure_patrons()`](../includes/class-remote-source-node.php) returns null when the Vault resolves nothing for the node's `<vault_id>`, or when the entry carries an empty `url`, and reports only through a rate-limited `no Vault entry; staying disconnected` or `Vault entry has no url; staying disconnected`. No patrons are built, so the node has no `sse-in` sibling, no cURL handle in `list_handles` and no health row — `doctor` and `wp nodes status` both show a live worker. Renaming a server in the Vault tab produces the same silence from the other end: the credential moves to a new key while every node holding the old id in its `vault_id` argument keeps pointing at an id that no longer resolves. Check the spelling against the Vault tab, and read the worker's stderr; the tick retries forever, so fixing the entry reconnects with no restart. The Vault tab's Test button (`vault test <id>`) is no substitute for either check: it probes the spoke's `status` node and answers whether the host replied under the stored credential, which a spoke whose `Remote_Source` resolves nothing does just as readily.

**A `vault_id` argument offers a dropdown in the topology console and a bare text box in the debug overlay.** Both surfaces mount a [`CatalogProvider`](../src/topology-console/CatalogContext.js), but they hand it different catalogs: the overlay's Inspector tab supplies classes and formatters and no `vaults`, so `CtorField` falls back to the free-text input it renders whenever the vault list is empty, placeholdered `(no vault entries)`. Typing the id there works. Only the offer is missing, and only in the overlay.

**Settings never reach a spoke although `hub-control` is live and the canvas shows the wire.** [`Settings_Sync_Node::send_set()`](../includes/class-settings-sync-node.php) keeps a target only when `Core::node()` on its HEAD segment returns an `HTTP_Out_Node` and that node's `vault_id()` has a live `Command_Auth` session. Any other node type, or an `HTTP_Out` with no Vault entry, is skipped with `no session for <target>; skipping this push` — one line per node per rate-limit window, so several unhealthy spokes collapse into a single line naming one of them. That line is suppressed entirely for the worker's first 30 seconds, since a session still being established is not worth reporting, so a just-spawned worker looks silent even when nothing is wired. The node asks for the handshake on the same branch, so a genuinely configured spoke converges on a later sweep.

**A log source you registered never shows up in `taillog`.** [`Log_Sources::config_entries()`](../includes/class-log-sources.php) skips an invalid `log_sources` line rather than failing, so one typo cannot blank the whole registry — and produces no error either. A line is accepted only when the name matches `/^[a-z0-9_-][a-z0-9_.-]*$/D`, is neither of the two words `taillog` reserves for its sub-verbs (`sources` and `read`), and carries a path that is absolute and free of `..` and NUL. The same rule silently drops a topology `Log` node whose lowercased `writes` basename does not qualify. Even a valid line loses to an earlier family — built-ins first, then config lines, then topology `Log` nodes, first name winning — and a realpath dedupe then drops any entry resolving to a file an earlier one already named, which is why `debug` vanishes on a host where the `error_log` ini IS `wp-content/debug.log`. Run bare `taillog`, or `taillog sources`, to see what made it in. The admin textarea validates through the same parser, so a rejected line is refused at save too.

**An SSE stream is refused with HTTP 429.** The slot pool is full, or it fails closed because no cache backend answered — [`wp nodes doctor`](cli.md#doctor-health-report)'s `cache-backend` row settles which. Slots are pooled per `{machine}:{site}`, and the bounds are `sse_max_streams` (6) for the whole host, `sse_max_slots` (3) for one identity's share of it, and `sse_reserved_slots` (0) held back from browsers. Read [sse-host-budget.md](sse-host-budget.md) before raising any of them; a stream holds a php-fpm child for its whole life.

A stream that took a slot and then LOST it reports differently. It sends a `disconnect` frame and writes one `SSE stream closed {…}` line, JSON, down the node stderr chain: reason `slot_lease_lost`, plus `pid`, `slot`, `partition`, `subscriptions`, `backend` and `lease_state`, and whatever memcached result or APCu memory detail the backend inspection supplied. An unhandled throw writes the same shape under reason `unexpected_exception` with `exception_class` and `exception_message` beside it. A clean idle close writes nothing at all, so silence there is the healthy case rather than a lost line.

**`wp nodes stop` times out.** It exits non-zero naming the stragglers, and the fleet stays held. Its blocker list includes any slot with a spawn already in flight, read off the shared throttle, because a worker that released and POSTed its own respawn moments before the hold landed holds no lock while it bootstraps. That record is one cache entry per slot under the logical name `last_spawn:{type}|{partition}`, written only when the spawn endpoint ACCEPTS a spawn, at a TTL of twice the 15-second minimum interval so it outlives the window it guards and expires with nothing to sweep. `wp nodes memcache get 'last_spawn:job-worker|0'` reads it, which is how you tell a spawn genuinely in flight from a stale blocker. A scanner's own POSTs are recorded in memory only, and are recorded even where the transport call returned an error. A `could not write the stop flag for: <slots>` warning is the ownership footgun again — the workers own their lock dirs and this command does not — and every one of those slots will still be up when the timeout expires. Without memcached it warns that it cannot see PHP-FPM's timestamps, since APCu does not span SAPIs.

## Inspecting wire format on disk

The on-disk format is one packed Message per line: a 7-element positional JSON list, `[TYPE, TIMESTAMP, FROM, TO, ID, KEY, VALUE]`.

```bash
# Segment ids are monotonic and rotate, so the live one is rarely 0.
head -c 300 "$( ls -t {base}/logs/topicprobe.p0/*.log | head -1 )"
```

```
[16,1788357700.338393,"topicprobe","","","",["ingest.p0","ingest.p0",0,421267,0,0,0,0,0,292,0,15046]]
```

`16` is `TM_STRUCT`, so the VALUE is a decoded array rather than a string. Beware that the type bits are renumbered against Tachikoma's: ours are `TM_BYTESTREAM 1, TM_EOF 2, TM_PING 4, TM_COMMAND 8, TM_STRUCT 16, TM_ERROR 32, TM_INFO 64, TM_REQUEST 128, TM_RESPONSE 256, TM_NOREPLY 512, TM_UNTYPED 1024`. See [tachikoma-lineage.md](tachikoma-lineage.md) for the full comparison.

The VALUE here is a [`Probe_Record`](../includes/class-probe-record.php), whose twelve slots run SOURCE, READER, cursor segment, cursor offset, the partition's last segment and its size, DISTANCE, MSGS_DELTA, END_BYTES, CACHE_SIZE, BYTES_READ_DELTA and ELAPSED_MS. So this reader tails `ingest.p0` and is itself named for it, holds a cursor at byte 421267 of segment 0, and forwarded no messages and read no bytes across the 15046 ms the deltas cover, with 292 bytes in its newest offsetlog segment.
