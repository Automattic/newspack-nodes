---
name: nodes-debugging
description: Debugging the newspack-nodes substrate live — the REPL and its introspection verbs, fleet health, the on-disk layout, the browser debug overlay, and the failure modes we actually hit. Use when something flowing through the node graph isn't behaving as expected, when workers are unhealthy, or when you need to inspect node state without redeploying.
argument-hint: "[symptom]"
---

# Newspack Nodes Debugging

Every tool here reads a running system. Nothing below requires a redeploy or a restart, and nothing below changes the graph unless you type a verb that does.

Two companion documents carry the long form: `docs/troubleshooting.md` is the human-facing walkthrough, and `docs/cli.md` documents every `wp nodes` verb with its flags. This skill is the triage order, the verb map, and the traps.

## Triage order

| Symptom | First move |
|---|---|
| Anything at all, on an environment you do not trust | `wp nodes doctor` — eight rows, each naming its own degradation |
| A worker should be running and isn't | `wp nodes status`, then `wp nodes run <type> --partition=<N>` |
| A worker spawns and immediately exits | `wp nodes run <type>` — the foreground process prints its own exit reason |
| A message enters a Topic and never reaches its Consumer | `wp nodes status`'s consumer table, then `ls -la` the segment dir |
| A worker pegs a CPU with no traffic | `wp nodes cli <type>.p<N>`, then `list_timers` and `list_handles` |
| A node behaves wrongly but the process is healthy | `wp nodes cli <type>.p<N>`, then `dump_node` and `trace` |
| Records are being quarantined | `dl_list` on the reader's `{name}:config` interpreter |
| A dashboard renders nothing | The browser debug overlay (`?nodes-debug=1`) |
| A request's lifecycle is wrong | `wp nodes reqgrep` — the event logger's verb, not the substrate's |

## Fleet health

```bash
wp nodes doctor        # canonical health report; WARN exits 0, FAIL exits 1
wp nodes status        # fleet table + consumer-lag table (alias: ls)
wp nodes types         # active topology groups, partition counts, stale timeouts
wp nodes run <type> --partition=<N>   # foreground worker; boot errors hit your terminal
```

`doctor` renders one evaluator, `Health_Checks::evaluate()`, which also backs the Site Health test — so neither surface can carry a check the other lacks. Eight rows in fixed order: `cache-backend`, `filesystem`, `ownership`, `housekeeping`, `config-keys`, `worker-liveness`, `consumer-lag`, `dead-letters`. Two more appear only when they apply: `fleet-hold` while a deploy hold stands, and `other-alerts` when an alert declares a family the report does not bucket.

Read three of those rows carefully, because each fails silently everywhere else:

- **`housekeeping`** asks only whether `newspack_nodes/reconcile` is scheduled. That minute pass carries retention, orphan reaping, alert emission, the delayed-jobs sweep, every `newspack_nodes/periodic` subscriber and cold-start worker revival. Lose it and every other check stays green.
- **`ownership`** compares the base directory's owner against this process's effective uid. A mismatch is almost always a past root run; the recovery is `chown -R <web-user> {base_dir}`.
- **`config-keys`** names keys in `newspack-nodes-config.php` that `Settings_Schema` no longer declares. The value you set is not in effect, and nothing else says so.

`doctor` reads neither `DISABLE_WP_CRON` nor any other cron setting: a platform invoking `wp-cron.php` externally is healthy, and worker liveness is reported directly rather than inferred from a proxy.

`wp nodes status` gives each `{topology}.p{N}` slot one row and one state: `live` (heartbeat inside `stale_timeout`), `stale` (a peer's `_fleet` scan or the minute cron will respawn it), `down` (an active topology holding no lock), `held` (a `wp nodes stop` hold stands), `idle` (an on-demand worker sleeping without a lock) and `inactive` (a catalog topology nobody activated). Uptime reads the lock dir's `started` file. The second table is the consumer positions the topic probe sweeps: reader, source, partition, bytes behind, messages per probe interval.

## The REPL: `wp nodes cli`

**Run it as the web user, never root.** It refuses otherwise, and the refusal is load-bearing: workers create their IPC dirs under their own ownership, so a root cli seeding `input/` root-owned locks every later cli out. Recover a tree already in that state with `chown -R <web-user> {base_dir}/ipc/`.

Two modes. **Bare** (`wp nodes cli`) builds Shell, Command_Interpreter, Router and a `_output` Dumper in the WP-CLI process itself — the way to exercise interpreter verbs without touching a worker. **Pivoted** (`wp nodes cli <type>.p<N>`) attaches to a live worker over a pair of IPC Partitions: commands serialize to `input/`, the worker's own event loop handles them, and replies come back through `output/`, which the cli tails. Run `wp nodes status` for the live reader ids; a typo fails fast with `no worker '<id>'` rather than creating ghost IPC partitions.

Concurrent clis against one worker are fine — each writes tiny sub-PIPE_BUF appends into the same input dir, and `_output`'s TO filter matches `(?:_output/)?$pid`, so another session's replies fall through silently.

### Verbs by what you are diagnosing

Run `help` for the full table and `help <verb>` for one. The introspection half:

```
ls [-clst] [<node>]         # nodes sinking INTO <node>; -c counters -l counters+targets
ls -a [-clst] [<glob>]      #   -s sinks -t targets; -a all nodes by anchored regex
dump_node <node> [<keys>]   # one node's config and state (alias: dump)
dump_config [<glob>]        # the whole topology as round-trippable shell verbs
dump_metadata               # JSON keyed by node name: class, counter, sink, target,
                            #   debug_state, arguments — one round-trip draws the graph
stats [-a] [<regex>]        # NAME COUNT LGST_MSG READ WRITTEN; default scope is siblings
uptime                      # clock time, plus days+HH:MM:SS since this worker spawned
list_timers [-s]            # ID ACTIVE INTERVAL MODE NEXT ONESHOT FIRES TYPE NAME
list_handles [-s]           # ID COUNT TYPE NAME — the cURL-multi handles the loop selects on
profile [on|off]            # toggle _router dispatch profiling (per-node self time)
list_profiles [-s] [<glob>] # that profile table, slowest average first; `total` for the total row
trace [<node>] [<level>]    # set a node's debug_state; `*` hits every node, bare toggles this
                            #   interpreter's. A traced node emits a TM_STRUCT to _repl on
                            #   every set_state(), which cli and SSE sessions see live
dmesg                       # the last 100 lines of this process's stderr ring
log <message>               # write into that ring from here
taillog [<source>] [max_kb] # tail a registry-NAMED log file (php | debug | config entries |
                            #   active-topology Log nodes); bare lists the registry
```

The half that changes the graph:

```
make_node <type> <name> [<args>]  # alias: make
remove_node <name> [<more>...]    # also -a <regex>; aliases: remove, rm
move_node <name> <new name>       # aliases: move, mv
set_sink <node> <target>
connect_node <node> [<target>]    # target defaults to the issuer's FROM — tails a node's
                                  #   flow back into your own session (alias: connect)
disconnect_node <node> [<target>] # undoes that (alias: disconnect)
register / unregister <source> <target> <event>
```

`connect_node <node>` with no target is the single highest-value verb here: it wires the node's output to your session for as long as you are attached, and `disconnect_node <node>` takes it back.

The shell builtins compose a path with the current cwd, so `cd <type>.p0` then `command_node "" status` addresses the worker with no further typing:

```
cd [<path>]                          # empty resets to the local interpreter (alias: chdir)
pwd                                  # reply shows ` <args> -> <from>`
command_node <path> <verb> [<args>]  # TM_COMMAND without changing cwd (aliases: command, cmd)
request_node <path> [<value>]        # TM_REQUEST; the receiver replies TO=FROM (alias: request)
tell_node <path> <info>              # TM_INFO, fire-and-forget (alias: tell)
send_node <path> <bytes>             # TM_BYTESTREAM (alias: send)
send_struct <path> <json>            # TM_STRUCT
send_eof <path>                      # TM_EOF
ping <path>                          # round-trip latency probe
reply_to <node path> <command>       # run the command HERE, route its reply THERE
include <file>                       # eval each line of <file> through this shell
status                               # local cli mode summary; sends nothing
debug_level [0|1|2]                  # local Dumper verbosity
show_parse                           # dump the parse of every command
secure [<level>] / insecure          # ratchet management verbs away; never descends
```

### Per-node verbs live on `{name}:config`

Every node carrying declared verbs publishes an auto-wired interpreter sibling named `{name}:config`. Reach them with `cd <node>:config` or `command_node <node>:config <verb>`.

A durable reader — `Consumer_Node`, `Remote_Source_Node` — carries two families worth knowing:

- **Dead letters.** `dl_list [limit]` lists quarantined records newest first, with each one's reason, attempt count and `segment:offset:length` locator. `dl_show <locator>` decodes one read-only. `dl_requeue <locator>` redelivers it to the node's sink, leaving the queued copy in place. `dl_purge` deletes every dead-letter segment.
- **Time travel.** `PAUSE` stops the poll timer and holds the cursor; `STEP` emits at most one message and replies with the `{seg, off, at_eof}` cursor; `PLAY` resumes; `SEEK_FRAME <segment>` jumps to an offsetlog keyframe and restores the state co-committed there. `GET_LAG` answers how far behind the reader is.

### Piping into the REPL

Redirected stdin skips readline automatically — `posix_isatty(STDIN)` gates it, and the same flag suppresses the prompt and the pivoted-mode banner, so a scripted capture is clean.

```bash
echo -e "ls\ndump my-node" | wp nodes cli
```

On stdin EOF the cli emits a TM_EOF stamped `FROM=_output/$pid`; the interpreter it lands on bounces `TO=FROM`, and the Dumper seeing that echo flips the exit flag. In pivoted mode the round trip rides through the IPC partitions, which is what guarantees every preceding reply has been read off disk before the process exits — no `sleep` slack needed. A 5-second deadline covers a dead worker.

## Hunting a spinner

A worker burning a CPU with no traffic is a timer re-arming every tick or a cURL handle that never completes. Pivot in and read `list_timers`: `NEXT <= 0` with a `FIRES` count that climbs between runs is the spinner. `MODE` disambiguates a legitimate Router hitchhike (`router`, which has no own next fire, so `NEXT` reads `-`) from an own Event_Framework slot (`event_framework`) and from a disarmed timer (`inactive`). `list_handles` does the same for egress: a handle whose `COUNT` never advances is stuck. Both verbs read the live `Event_Framework` registries, not a cached snapshot.

For a worker that is busy rather than spinning, `profile on` makes `_router` time each dispatch and `list_profiles` ranks nodes by average self time. Turn it off when you are done: two `microtime()` reads bracket every dispatch while it stands.

## On-disk layout

Everything hangs off `base_directory`, `/tmp/newspack-nodes` by default and `/volumes/pyrobase/tmp/newspack-nodes` in the dndocker containers.

```
{base}/
  locks/       {type}.p{N}.lock.d/   heartbeat  started  restart  stop  reload
  ipc/         {type}.p{N}/   input/   input.offsets/   output/
  logs/        {name}.p{N}/   {seg}.log  {seg}.idx   .rotate.lock.d/  write.lock.d/
  offsets/     {topology}.{source}.p{N}/   {seg}.log
  deadletter/  {topology}.{source}.p{N}/   {seg}.log
  topologies/  {name}.tsl
  layouts/     {name}.layout
```

The offsetlog and dead-letter directory names are not fixed by the substrate: they are the Consumer's second and third `make_node` arguments. The stock topologies spell them `<config:offsets_dir>/<topology>.<log>.p<partition>` and `<config:deadletter_dir>/<topology>.<log>.p<partition>`, and both stay sole-writer — which is what the topology conflict gate checks.

`heartbeat` holds the owner's pid and its mtime is the liveness signal `status` reads; `started` is the acquisition time behind Uptime. Three flag files steer a holder from a process holding no instance: `restart` recycles it, `stop` empties the slot, `reload` re-reads config without exiting. `Lock_Node` claims a directory with `mkdir` rather than `flock`, because `mkdir` is POSIX-atomic on the NFS, tmpfs and bind mounts this runs on.

The IPC tree is the substrate's own: `input/` is a Partition the cli writes commands into, `input.offsets/` is that consumer's durable offsetlog so a respawned worker resumes rather than replaying, and `output/` is the `_repl` Partition the attached cli tails. The IPC-input Consumer stamps `FROM = _repl`, which is the whole reply path — the interpreter answers `TO = FROM` and Router hands the answer to `_repl`. Addressing is the correlation (ADR-7); nothing else pairs a reply with its command.

A `{seg}.idx` sidecar appears only when a Partition has a `with_index()` formatter set. Its absence is normal, not corruption.

On-disk records are 7-element positional JSON lists — `[TYPE, TIMESTAMP, FROM, TO, ID, KEY, VALUE]` — so `head -c 500 {base}/logs/firehose.p0/0.log` is a legitimate first look.

## The browser side

`DebugOverlay` (`src/debug-overlay/`) puts the page's own live `Core.nodes` graph on top of whatever dashboard is running. `?nodes-debug=1` opens the gate and sticks it in `localStorage` under `newspack-nodes:debug`; `?nodes-debug=0` clears it. Ctrl+` then toggles the panel. It carries two tabs: Overview, this browser's I/O rates, sampled whether the panel is open or shut; and Console, the graph in the shared GraphView plus a REPL driving the page's own Command_Interpreter. The gate is a dev affordance, not access control — the REST command endpoint authorizes whatever the REPL sends.

The overlay is inlined into each consumer's bundle rather than built here, so a change to it means rebuilding **both** newspack-nodes and every consumer; otherwise the consumer ships the old copy. A dashboard node sitting at counter 0 in the console is dead, not composed — see the `nodes-dashboards` skill.

## Reading the application firehose

`wp nodes reqgrep` belongs to `newspack-event-logger-nodes`, not the substrate, and exists only where that plugin is active (it is, in dndocker). It reads the firehose partitions, groups lines by request id, and prints each request as an indented lifecycle tree.

```bash
wp nodes reqgrep --recent          # seed at the second-to-last segment, drain to EOF
wp nodes reqgrep --follow          # tail under the event loop until SIGINT
wp nodes reqgrep <pattern>         # match request id, URL, or any text
```

For the pretty-printer's envelope unwrapping and the rest of the application surface, use the `event-logger-nodes-debugging` skill.

## Failure modes

**A worker spawns and immediately exits.** Run it in the foreground: `wp nodes run <type> --partition=<N>` prints the worker's own reason (`restart flag`, `max_runtime`, memory watermark, lock lost). The common substrate cause is benign — the spawn request found the Lock already held, which is idempotent. Application-side, the event logger's `Log_Manager` refuses to run as root, so a wp-cron run as root aborts noisily. Run wp-cron as the web user.

**Messages enter a Topic but the Consumer never sees them.** Check the segment file's size and mtime. Partition batches its writes and flushes at the end of the event-loop iteration, so a synchronous write-then-read with no tick between them sees an empty segment. That is the batch, not a loss.

**`Core::node('foo')` returns null in a constructor.** The constructor ran in request scope, before the Event_Framework drained anything. Move the lookup to a READY listener or make the caller lazy (ADR-5).

**A Tee's targets are dead and Router logs `NOT_AVAILABLE`.** Tee prunes dead bare-name targets on every `fill()`, so stale config self-heals as soon as traffic arrives. A `NOT_AVAILABLE` that survives the first message means the target is path-shaped and Router itself is complaining: `disconnect_node <tee> <dead-target>`.

**`wp nodes cli` burns 100% CPU.** Readline was installed without a TTY. The `posix_isatty(STDIN)` gate makes this impossible today; if it recurs, check that the cli computes `$is_tty` before setting readline mode.

**Replacing plugin files under a running worker.** `restart` is not enough — swapping `includes/` makes the running autoloader fail on its own classes and the consumer quarantines whatever was in flight as poison. Take the fleet down first: `wp nodes stop && ./deploy.sh && wp nodes start`. `stop` exits non-zero while any worker still holds its lock, so the deploy never runs against a live process, and `status` reads `held` until `start`.

## Related skills

- `nodes-workflow` — landing a change and riding it through deploy, restart and verify
- `nodes-review` — the substrate contract checklist
- `nodes-dashboards` — building the graph a dashboard inspects
- `event-logger-nodes-debugging` — the application layer above this one
