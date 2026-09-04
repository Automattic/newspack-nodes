# Troubleshooting

Live-investigation reference for the substrate: the REPL, worker health, log paths, and the failure modes we actually hit. For the conceptual model behind all of it, read [architecture-guide.md](architecture-guide.md); for every `wp nodes` verb, its flags and what each `doctor` row means, read [cli.md](cli.md).

Reach for this page when:

- a worker is supposed to be running but isn't,
- a message you produced doesn't seem to be flowing through the graph,
- workers keep getting respawned, or
- you want to inspect node state without restarting anything.

## REPL: `wp nodes cli`

The cli refuses to run as root — workers run as the web user and create their lock and IPC directories under that ownership. A root cli would seed `{base}/ipc/{type}.p{N}/input/` as root, leaving the workers unable to append to their own IPC. The guard prevents that. If you've already hit this state, recover with `chown -R <web-user>:<web-user> {base}`.

Multiple concurrent clis against one worker work fine. Each session's outbound Partition — named for the worker it attached to — appends to that worker's `input/` directory with no lock, because a cli command is far under PIPE_BUF and every append is therefore atomic.

Two modes:

**Bare** (`wp nodes cli`) — local only. Behind an anonymous Shell it builds `_router`, `_command_interpreter`, the `_shell` console tap, `_output` (a Dumper) and `_stdout`, then runs commands in the wp-cli process itself. Use it to exercise interpreter verbs without touching a worker.

**Pivoted** (`wp nodes cli <type>.p<N>`) — attached to a live worker through a pair of IPC Partitions. Commands you type serialize to the worker's `input/` directory; the worker reads them, processes them in its own event loop, and writes replies to `output/`, which the cli tails. `dump_node`, `connect_node` and `disconnect_node` all work against the running graph without disturbing it. The worker ids in the examples below are placeholders — run `wp nodes status` for the live ones.

Attaching resolves the worker in two steps: the lock directory `{base}/locks/{type}.p{N}.lock.d/`, and failing that a wake through `Spawn_Coordinator::wake_sleeping_worker()`, since an on-demand worker sleeps holding no lock. A typo'd id fails fast with ``no worker '<id>' (run `wp nodes status` to list active workers)`` rather than creating ghost IPC partitions. Staleness is not blocked at attach time: a stale worker is mid-restart, and the cli works once a peer respawns it.

### Verbs

`help` prints the whole set and `help <verb>` prints one. These are dispatched by the interpreter the cwd points at:

```
make_node <type> <name> [<args>]      construct a registered Node (alias: make)
move_node <name> <new name>           rename a node (aliases: move, mv)
remove_node <name> [<more>...]        remove by name, or -a <regex> for a batch (aliases: remove, rm)
set_sink <node> <target>              rewrite a node's sink at runtime
connect_node <node> [<target>]        add a target; <target> defaults to the issuer's FROM (alias: connect)
disconnect_node <node> [<target>]     remove a target; undoes a self-connect (alias: disconnect)
register <source> <target> <event>    subscribe <target> to <source>'s <event>
unregister <source> <target> <event>  drop that subscription
reply_to <node path> <command>        run <command> HERE, route its reply to <node path>
list_nodes [-clst] [<node>]           nodes sinking INTO <node>; -c counters -l counters+targets -s sinks -t targets (alias: ls)
list_nodes -a [-clst] [<regex>]       every node matching an anchored regex
dump_node <node> [<keys>]             config + state of one node (alias: dump)
dump_config [<regex>]                 the running topology as round-trippable shell verbs
dump_metadata                         JSON keyed by node name — one round trip draws the whole graph
stats [-a] [<regex>]                  NAME COUNT LGST_MSG READ WRITTEN; siblings by default, -a for every node
uptime                                clock time, plus days+HH:MM:SS since this worker spawned
pwd                                   the cwd and the reply's FROM trail, as ` <cwd> -> <from>`
list_timers [-s]                      ID ACTIVE INTERVAL MODE NEXT ONESHOT FIRES TYPE NAME
list_handles [-s]                     ID COUNT TYPE NAME — the cURL-multi handles the drain loop selects on
profile [on|off]                      toggle or set _router's per-node self-time profiling
list_profiles [-s] [<regex>]          the profile table, slowest average first
trace [<node>] [<level>]              set a node's debug_state, tracing set_state() to _repl; bare toggles this interpreter
log <message>                         write <message> to the worker's stderr
dmesg                                 this process's last 100 stderr lines
taillog [<source>] [<max_kb>]         tail a registered log FILE by name; no args lists the registry
secure [<level>]                      climb the ratchet 1..3; bare climbs one level, and it never descends
insecure                              declare this process deliberately unratcheted; refused once secured
help [<topic>]                        the full help, or one verb
```

`-s` on `list_timers`, `list_handles` and `list_profiles` returns the same rows as a struct, for a view that wants to sort them. Secure levels freeze definitions without stopping the flow, and they enforce cumulatively: level 1 disables the `make_node` class (`make_node`, `move_node`, `remove_node`), level 2 adds the `command_node` class (`reply_to`), and level 3 adds the `connect_node` class (`connect_node`, `disconnect_node`, `set_sink`, `register`, `unregister`) — aliases included throughout. A node classifies its own verbs into those classes through `node_schema()['verb_classes']`.

These mint an addressed message. The Shell composes `<path>` with the cwd through `prefix()`, so `cd graphite.p0` then `command_node "" status` dispatches `status` to that worker without further typing:

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
include <file>                        read commands from <file> and eval each line through this shell
var [<name> [<op> [<value>]]]         list every shell variable, read one, set it, or delete it
print <text>                          echo to the terminal
clear                                 clear the screen
debug_level [0|1|2]                   the local Dumper's verbosity
show_parse                            toggle a parsed-command dump before every command
```

### Reaching a node's own verbs

A node that declares commands in `node_schema()` gets a sibling interpreter named `{node}:config`, and `command_node` addresses it. That is how the dead-letter triage verbs are reached, for instance:

```bash
echo 'command_node topicprobe:consumer:config dl_list' | wp nodes cli graphite.p0
# {"rows":[],"total":0,"unindexed_segments":0}
```

`dl_list` lists quarantined records newest-first with a `segment:offset:length` locator; `dl_show <locator>` decodes one; `dl_requeue <locator>` redelivers it to the node's sink and leaves the queued copy in place; `dl_purge` deletes every dead-letter segment.

### How replies find you

The Shell stamps `FROM=_output/<pid>` on everything it mints. A reply comes back with TO=FROM, so `_router` walks it to `_output`, whose TO filter matches `(?:_output/)?<pid>` — every other session's replies fall through silently, and an empty TO renders as an unaddressed broadcast. `_output` then carries the rendered line to `_stdout` by `target`, never down a sink chain (ADR-7).

`Command_Interpreter_Node` handles only TM_COMMAND with an empty TO. A non-empty TO means the message is in transit toward another node, so the interpreter forwards it to its sink and lets the addressed node decide. Any exception a verb throws is caught and returned as `TM_COMMAND|TM_ERROR` along the FROM trail, and the cli's Dumper renders that payload on **stdout** like any other reply — an error carries no prefix and no separate stream, so `wp nodes cli ... | grep` sees it too.

### Piping into the REPL

Redirect stdin and readline is skipped automatically: `readline_callback_read_char()` reads a TTY layer that never sees the pipe, and polling it burns 100% CPU. `posix_isatty( STDIN )` gates the choice, resolved once per session, and the same flag suppresses the prompt, the pivoted-mode banner and the trailing newline so scripted captures stay clean. The `status` builtin prints the mode summary on demand.

```bash
# Drive the REPL non-interactively for scripted testing.
printf 'ls\ndump my-node\n' | wp nodes cli
```

The non-readline path is `fgets`-based. On stdin EOF the cli emits a TM_EOF Message through the Shell; the receiving interpreter bounces it TO=FROM, and the cli's Dumper sees the echo and flips the exit flag. In pivoted mode that round trip rides the IPC partitions, which guarantees every preceding reply has been read off disk before the cli exits — no `sleep` slack needed. The 5-second deadline is the fallback for a dead worker; the cli exits anyway once it passes.

## Worker health

```bash
wp nodes doctor                            # the environment and fleet report; WARN exits 0, FAIL exits 1
wp nodes types                             # catalog topologies (no liveness)
wp nodes status                            # per-partition state, heartbeat age, uptime and lag; --format=json for scripts
wp nodes run <type> [--partition=<N>]      # run a worker in the foreground — boot errors hit your terminal
wp nodes restart all                       # flag every worker to recycle
wp nodes restart <type> [--partition=<N>]  # one type; every partition of it unless you name one
wp nodes stop [--timeout=<s>]              # hold the fleet and wait for every lock to clear (default 90s)
wp nodes start                             # release the hold and spawn
```

`wp nodes doctor` prints eight rows — cache backend, filesystem, ownership, housekeeping, config keys, and one per alert family — plus a `fleet-hold` row while a deploy hold stands and an `other-alerts` row when an alert declares a family no bucket claims. The cache row comes from a loopback probe of the WEB runtime, because a CLI process sees a different cache posture than the one serving requests.

`wp nodes run` is the tool for "the worker spawns but exits immediately". The process stays attached, so its stderr reaches your terminal, and it closes with `Worker exited with status:` — `ok`, `skipped (<reason>)`, or `load_failed (<message>)`. A cooperative stop names itself on stderr first: `lock lost`, `lock dir gone`, `stop requested`, `restart requested`, `lock heartbeat gone`, `lock stolen by pid <n>`, `memory watermark (<used>MB / <limit>MB, <pct>%)` or `db check failed 3 times`. The routine `max_runtime` recycle and an on-demand idle exit stay silent by design.

`wp nodes status` reports one state per `{topology, partition}` slot, read from evidence the fleet writes rather than inferred:

| State | Meaning |
|---|---|
| `live` | The heartbeat under `{base}/locks/{type}.p{N}.lock.d/heartbeat` is younger than the topology's `stale_timeout` (60s by default). |
| `stale` | The heartbeat has aged past it; a peer's `_fleet` scan, or the minute cron when none is left, will steal the lock and respawn. |
| `down` | An active resident topology holds no lock at all — the rescue case. |
| `idle` | An on-demand topology (`on_demand_idle > 0`) has scaled to zero and holds no lock. Not a fault. |
| `held` | A deploy hold stands, so nothing will spawn until `wp nodes start`. |
| `inactive` | The topology is in the catalog but not in the `topologies` config key. |

Uptime comes from the lock directory's `started` file. Alongside `heartbeat` and `started`, three flag files let any other process steer the holder: `restart` (exit and hand the slot straight to a successor), `stop` (exit and leave the slot empty for the length of a deploy) and `reload` (re-read config without exiting).

## Log layout

Substrate-side, under the runtime tree `{base}`:

- `locks/{type}.p{N}.lock.d/` — `heartbeat`, `started`, and the `restart` / `stop` / `reload` flags
- `ipc/{type}.p{N}/{input,output}/{seg}.log` — bidirectional IPC for `wp nodes cli`, with the input consumer's cursor in `input.offsets/`
- `offsets/{reader-id}/{seg}.log` — durable reader checkpoints (the offsetlog); the reader id already carries its own `.p{N}`, as in `job-spoke.jobs.p0`
- `deadletter/{reader-id}/{seg}.log` — quarantined poison records and their `.idx` sidecars
- `topologies/{name}.tsl` — the writable user topology directory
- `layouts/{name}.layout` — saved dashboard node positions

Application-side directories are created by whatever Partition or Log a topology constructs, for example the event logger's:

- `logs/firehose.p{N}/{seg}.log` — packed Message envelopes
- `logs/jobintake.p{N}/{seg}.log` — large jobs that bypass the firehose

The `base_directory` setting names that tree and defaults to `/tmp/newspack-nodes`. Override it under Settings → Nodes Runtime, in `newspack-nodes-config.php`, or in the file named by `LOCAL_NEWSPACK_NODES_CONF`; a stored option beats both files, by presence rather than truthiness.

Listing a partition directory you will also see `{seg}.idx` sidecars beside some `{seg}.log` files. Partition writes one only when a `with_index()` formatter is installed — the default mode writes none — and the `.idx` holds a JSONL index for offset lookups. A missing `.idx` is normal, not corruption. A `Log` node lays its segments out flat instead, as `{file}.0`, `{file}.1`, … at the first level.

## Common failure modes

**A worker spawns but exits immediately.** Run `wp nodes run <type> --partition=<N>` and read the status it prints. `skipped (lock_held)` means another process already holds the slot, which is idempotent and harmless. `load_failed` means the `.tsl` would not parse; the worker deliberately does not self-respawn, because respawning would hot-loop the same bad file. A held fleet answers HTTP 409 `fleet_held` at the spawn endpoint, so check `wp nodes doctor` for a `fleet-hold` row. On the application side, the event logger's `Log_Manager` bails inert under root rather than leaving root-owned segments the web user could never append to — so a wp-cron run with `--allow-root` produces a worker that runs and logs nothing. Run wp-cron as the web user.

**Every storage-backed command throws "Runtime directory … is owned by uid N" or "… is writable by group or other".** `Config::get_base_directory()` refuses a tree this process does not privately own, because whoever owns the base path owns every log, lock, offset and topology beneath it, and a planted `.tsl` runs with full interpreter authority on the next spawn. Root is exempt from the refusal and warned instead, since a root-owned file is what the web user cannot append to. Recover with `chown -R <web-user>:<web-user> {base}` and `chmod -R go-w {base}`. `wp nodes doctor` survives the refusal and shows it: the `filesystem` row carries the message verbatim, and the `ownership` row repeats the uid comparison advisorily.

**No worker spawns, and stderr repeats "refusing to spawn — topology write-conflict".** Two active topologies write the same partition log, which would corrupt it, so `spawn_each()` refuses the whole set rather than half of it. The message names both topologies and the path they share, as `a ↔ b (<path>)`. Deactivate one with `wp nodes deactivate <topology>`; activation consults the same analyzer, so it refuses to persist the conflicting set in the first place.

**Every slot reads `held`.** `wp nodes stop` wrote the `newspack_nodes_hold` option and nothing cleared it. `wp nodes doctor` reports `fleet-hold` with its age; `wp nodes start` releases it and spawns. The hold is an option rather than a file under the base directory precisely so it survives a deactivate/reinstall cycle that wipes `/tmp/newspack-nodes`.

**Nothing runs on a fresh install.** The `topologies` config key defaults to empty, so an install activates nothing. `wp nodes types` lists the catalog; `wp nodes activate <topology>` opts one in and spawns its fleet immediately.

**Retention, alerts and cold-start revival all stopped, while every other check stays green.** The `newspack_nodes/reconcile` cron event is gone. That minute pass carries log retention, orphan partition and IPC reaping, alert emission, the delayed-jobs sweep, every `newspack_nodes/periodic` subscriber and cold-start worker revival. `wp nodes doctor` fails its `housekeeping` row and names the recovery: `wp cron event schedule newspack_nodes/reconcile now newspack_nodes_minute`.

**A setting you changed has no effect.** `wp nodes doctor`'s `config-keys` row lists every key in `newspack-nodes-config.php` that the settings schema does not declare. A deploy copies the operator's own file over the shipped path, so a key renamed in the schema leaves a stale entry behind whose value is silently ignored while the real key sits on its default.

**Messages enter Topic but never reach the Consumer downstream.** The Consumer (or Tail, for a non-partitioned file) reads what Partition wrote. If the batch has not flushed, the reader sees nothing on poll — check the segment's mtime and size with `ls -la`. `set_timer( 0, true )` drains the batch at the end of the current event-loop iteration, so a synchronous write-then-read with no tick between them will always come up empty.

**Records vanish between producer and log.** Partition measures the **packed** bytes and drops anything over the cap in force with a loud, rate-limited stderr line, because half a record desyncs every reader after it. The default cap is PIPE_BUF, 4096 bytes. A producer that legitimately needs more opts in with `allow_large_writes()` (a held write lock, enforced) or `void_warranty()` (the caller asserts single-writer), both of which lift it to 32 MiB.

**Dead letters are accumulating.** `wp nodes doctor` warns on the `dead-letters` row once a reader passes `alert_deadletter_threshold`, which defaults to 0 — the first quarantined record. Inspect them with `dl_list` / `dl_show` on the reader's `:config` interpreter, redeliver one with `dl_requeue`, or replay a whole segment back through its topic with `wp nodes ingest <topic> {base}/deadletter/<reader-id>/*.log`. `dl_purge` clears them; the queue is count-rotated, so purging is a convenience rather than a correctness requirement.

**Disk fills with directories nothing writes any more.** Deactivating a topology orphans its log and offsetlog directories — stopping its workers does not, because a dir is an orphan only when no ACTIVE topology declares it. The reconcile pass sweeps them each window but spares anything written in the last hour (`Log_Cleaner::DELETE_GRACE_S`, 3600s), so a mid-deploy blip cannot eat live data. `wp nodes gc` sweeps now, and `wp nodes gc --force` drops that grace to zero for a topology you just tore down.

**An on-demand worker reads `idle` and never wakes.** A producer inside the substrate marks the partition directory and wakes the reader on flush. A producer outside it — gyrobase appending to a segment in Perl — is noticed only by the minute pass's `wake_readers_with_backlog()`, which wakes on backlog and never on presence. If the minute cron is not running, nothing wakes it; see the housekeeping entry above.

**A verb comes back "`make_node` is disabled at secure level 1".** Every stock topology ends with `secure`, so a worker built from one runs at level 1 and refuses the whole `make_node` class. Reads, dumps, wiring and every other verb still work — the ladder freezes definitions, it does not disable the machine. The ratchet never descends, so there is no unlock from the REPL: add the node to the `.tsl` and `wp nodes restart <type>`, or reproduce the graph in a bare `wp nodes cli`, which starts at level 0.

**`wp nodes cli` runs at 100% CPU.** Readline was installed in a non-TTY context. The `posix_isatty( STDIN )` gate makes that unreachable, so treat a recurrence as a regression in `CLI_Command::terminal()`, which resolves the stdin stream and the readline policy once for the whole session.

**A worker pegs 100% CPU with no traffic.** Some node re-arms a timer every tick, or a cURL-multi handle never completes. Pivot in and run `list_timers`: the spinner is a row whose `NEXT` is at or below zero while `FIRES` climbs on every re-run. A Timer hitchhiking the Router tick is not one — it shows `MODE` `router` and `NEXT` `-`, because it has no next fire of its own. `list_handles` does the same for a stuck SSE or HTTP egress node, whose `COUNT` never advances. Both verbs read straight off the `Event_Framework`'s registered timers and handles, so they reflect the live drain loop.

**A worker is slow and you don't know where.** `profile on` turns on `_router`'s per-node self-time accounting, `list_profiles` prints the table slowest average first, and `profile off` turns it back off. Times are parent-subtracted, so a node's row is its own work rather than its subtree's.

**Workers recycle about every ten minutes.** That is `DEFAULT_MAX_RUNTIME`, 595 seconds, and it is by design: a worker is an HTTP request that outlives its response, and it releases its lock before self-respawning. Uptime resetting on that cadence is health, not a fault.

**A long job runs twice, and its worker's uptime resets underneath it.** A peer stole the lock: a handler heartbeats only where it reaches `should_continue()` — `Event_Framework::pump()` at a fetch point, or the drain loop between messages — and one that reaches neither for a whole `stale_timeout` looks dead. `topologies/job-worker.tsl` carries `var stale_timeout = 600` for exactly that, against the `Lock_Node::STALE_TIMEOUT` default of 60. A topology whose handlers block longer than its own `stale_timeout` needs a larger one, or a `pump()` call inside the handler.

**`Core::node( 'foo' )` returns null inside a constructor.** A node built earlier in the topology cannot see one built later, and a constructor in request scope has no event loop at all (ADR-5). Register for the peer's `READY` state, or make the lookup lazy at first use.

**Tee has dead targets and the Router log fills with NOT_AVAILABLE.** `live_targets()` prunes on every read, so a Tee heals itself as soon as it sees traffic. A target survives when the HEAD segment of its path names a live node — `spoke/settings` lives as long as `spoke` does — which is exactly the case that still produces NOT_AVAILABLE: the head resolves, Router peels it, and a later segment names nothing. Fix the topology rather than the Tee, or drop the target with `disconnect_node <tee> <target>`.

**A message goes nowhere and stderr says `WARNING: message not addressed`.** `_router` drops any message whose TO is empty, so the minting node stamped no `target` and nothing filled TO on the way in. Give the node a `target`, or sink it straight into the node that should receive it. Two sibling drops read the same way: `path exceeded 1024 bytes` is a routing cycle growing FROM past `MAX_FROM_SIZE`, and `breaking recursion` is a `NOT_AVAILABLE` bounce whose own return path is missing too.

**An SSE stream is refused with HTTP 429.** The slot pool is full, or it fails closed because no cache backend answered — `wp nodes doctor`'s `cache-backend` row settles which. Slots are pooled per `{machine}:{site}`, and the bounds are `sse_max_streams` (6) for the whole host, `sse_max_slots` (3) for one identity's share of it, and `sse_reserved_slots` (0) held back from browsers. Read [sse-host-budget.md](sse-host-budget.md) before raising any of them; a stream holds a php-fpm child for its whole life.

**`wp nodes stop` times out.** It exits non-zero naming the stragglers, and the fleet stays held. Its blocker list includes any slot with a spawn already in flight, read off the shared throttle, because a worker that released and POSTed its own respawn moments before the hold landed holds no lock while it bootstraps. Without memcached it warns that it cannot see PHP-FPM's timestamps, since APCu does not span SAPIs.

## Inspecting wire format on disk

The on-disk format is one packed Message per line: a 7-element positional JSON list, `[TYPE, TIMESTAMP, FROM, TO, ID, KEY, VALUE]`.

```bash
# Segment ids are monotonic and rotate, so the live one is rarely 0.
head -c 300 "$( ls -t {base}/logs/topicprobe.p0/*.log | head -1 )"
```

```
[16,1788357700.338393,"topicprobe","","","",["ingest.p0","ingest.p0",0,421267,0,0,0,0,0,292,0,15046]]
```

`16` is `TM_STRUCT`, so the VALUE is a decoded array rather than a string — here a `Probe_Record`. Beware that the type bits are renumbered against Tachikoma's: ours are `TM_BYTESTREAM 1, TM_EOF 2, TM_PING 4, TM_COMMAND 8, TM_STRUCT 16, TM_ERROR 32, TM_INFO 64, TM_REQUEST 128, TM_RESPONSE 256, TM_NOREPLY 512, TM_UNTYPED 1024`. See [tachikoma-lineage.md](tachikoma-lineage.md) for the full comparison.
