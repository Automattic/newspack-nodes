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
| A worker spawns and immediately exits | `wp nodes run <type>` — the foreground process prints its exit status, and whatever it wrote to stderr on the way out |
| A message enters a Topic and never reaches its Consumer | `wp nodes status`'s consumer table, then `ls -la` the segment dir |
| A worker pegs a CPU with no traffic | `wp nodes cli <type>.p<N>`, then `list_timers` and `list_handles` |
| A node behaves wrongly but the process is healthy | `wp nodes cli <type>.p<N>`, then `dump_node` and `trace` |
| Records are being quarantined | `dl_list` on the reader's `{name}:config` interpreter |
| A dashboard renders nothing | The browser debug overlay (`?nodes-debug=1`); no overlay button means no bundle enqueued |
| A request's lifecycle is wrong | `wp nodes reqgrep` — the event logger's verb, not the substrate's |

## Fleet health

```bash
wp nodes doctor        # canonical health report; WARN exits 0, FAIL exits 1
wp nodes status        # fleet table + consumer table (alias: ls); --format=table|json|csv|yaml
wp nodes types         # active topology groups, each with its partition count and stale timeout
wp nodes run <type> --partition=<N>            # foreground worker; boot errors hit your terminal
wp nodes restart <type|all> [--partition=<N>]  # write the restart flag; every partition by default
wp nodes gc [--force]                          # sweep orphan log and offsetlog dirs now
wp nodes memcache get <logical> [<flags>]      # read one entry; --key prints the resolved address
                                               #   instead of reading, --host takes the per-machine
                                               #   SSE-slot scope, --porcelain prints the value alone
wp nodes ingest <topic> [<file>...]            # replay packed records through a Topic; naming no
                                               #   file reads stdin, and --dry-run only sizes them
```

`doctor` renders one evaluator, `Health_Checks::evaluate()`, which also backs the Site Health test — so neither surface can carry a check the other lacks. Eight rows in fixed order: `cache-backend`, `filesystem`, `ownership`, `housekeeping`, `config-keys`, `worker-liveness`, `consumer-lag`, `dead-letters`. Two more appear only when they apply: `fleet-hold` while a deploy hold stands, and `other-alerts` when an alert declares a family the report does not bucket.

`cache-backend` is the one row `doctor` does not evaluate in its own process. It POSTs `newspack-nodes/v1/health/cache` over the loopback and reports the backend serving requests, because a WP-CLI process picks a backend no visitor ever sees. A loopback it cannot verify comes back as a locally authored warning naming what failed — the HTTP status, or the transport — never as remote text.

Read three of the rest carefully, because each fails silently everywhere else:

- **`housekeeping`** asks only whether `newspack_nodes/reconcile` is scheduled. That minute pass carries retention, orphan reaping, alert emission, the delayed-jobs sweep, every `newspack_nodes/periodic` subscriber and cold-start worker revival. Lose it and every other check stays green.
- **`ownership`** compares the base directory's owner against this process's effective uid. A mismatch is almost always a past root run; the recovery is `chown -R <web-user> {base_dir}`.
- **`config-keys`** names keys in `newspack-nodes-config.php` that `Settings_Schema` no longer declares. The value you set is not in effect, and nothing else says so.

No row reads `DISABLE_WP_CRON` or any other cron setting. A platform invoking `wp-cron.php` externally is healthy, and `worker-liveness` measures the lock heartbeats themselves rather than a proxy for them.

Two conditions reshape the fleet rows. A standing hold suppresses `worker-liveness` and `consumer-lag`, never `dead-letters`, which predate the hold. A base directory that will not resolve skips the alert evaluator entirely, so all three fleet rows say only that fleet state is unknown and `filesystem` and `ownership` carry the real failure.

`doctor` reports the present; `{base}/logs/alerts.p0` carries the history. The minute pass journals a row when a condition raises or changes severity and a `resolved:` row when it clears, never one that merely persists. A transient gate holds it to one batch per `alert_emit_interval`, 300 seconds by default, so a fresh condition can wait five minutes for its row. While a hold stands the pass journals nothing at all, so a deploy leaves no trail of the workers it took down.

`wp nodes status` gives each `{topology}.p{N}` slot one row and one state: `live` (heartbeat inside `stale_timeout`), `stale` (a peer's `_fleet` scan or the minute cron will respawn it), `down` (an active topology holding no lock), `held` (a `wp nodes stop` hold stands), `idle` (an on-demand worker sleeping without a lock) and `inactive` (a catalog topology nobody activated). A lock no active slot claims still gets a row, its state tagged `(inactive)` — a deactivated topology winding down. The second table is the consumer positions the topic probe sweeps: reader, source, partition, bytes behind, messages per probe interval. The Worker Status dashboard paints that same distance segment by segment — green for what the reader consumed, amber for a backlog still inside the cursor's own segment, red once the recorded end has crossed into a later one, and gray for whatever the writer appended past the last probe — so a bar going red is the eye's version of the `consumer-lag` row. A log nobody reads is gray end to end.

## The REPL: `wp nodes cli`

**Run it as the web user, never root.** It refuses otherwise, and the refusal is load-bearing: workers create their IPC dirs under their own ownership, so a root cli seeding `input/` root-owned locks every later cli out. Recover a tree already in that state with `chown -R <web-user> {base_dir}/ipc/`.

Two modes. **Bare** (`wp nodes cli`) builds the session graph in the WP-CLI process itself — the anonymous Shell, the `_shell` Tap that watches what it sends, `_command_interpreter`, `_router`, the `_output` Dumper and the `_stdout` writer it targets — the way to exercise interpreter verbs without touching a worker. **Attached** (`wp nodes cli <type>.p<N>`) reaches a live worker over its two IPC directories: a Partition writes commands into `input/`, the worker's own event loop handles them, and a Consumer tails `output/` for the replies. Run `wp nodes status` for the live reader ids; an `idle` on-demand slot is woken rather than refused, and a typo fails fast with `no worker '<id>'` rather than creating ghost IPC partitions.

Concurrent clis against one worker are fine — each writes tiny sub-PIPE_BUF appends into the same input dir, and `_output`'s TO filter matches `(?:_output/)?$pid`, so another session's replies fall through silently.

Every Tab press mints two real commands at the current cwd, `help` for verbs and `ls` for node names, then answers from the candidate cache those replies fill — so the cache serves the NEXT press, not this one. Bare mode hides the lag, because the round trip completes inside the same synchronous `fill()` chain. Attached, the two queries ride the IPC partitions like any other command, so a node made or removed since the last Tab appears only on the second press, and leaning on Tab is real write traffic into the worker's input dir. The first token on the line completes against verbs and every later one against node names, which is what makes `cd <Tab>` list the graph.

### The verb map

Run `help` for the full table, `help <verb>` for one, and `help <NodeType>` for a node class's own arguments and verbs, rendered from its `node_schema()`.

```
ls [-clst] [<node>]         # alias of list_nodes: nodes sinking INTO <node>; bare lists
                            #   this interpreter's siblings. -c counters -l counters+targets
ls -a [-clst] [<regex>]     #   -s sinks -t targets; -a every node matching an UNANCHORED
                            #   regex — remove_node -a anchors its own, this one does not
dump_node <node> [<keys>]   # one node's config and state (alias: dump)
dump_config [<glob>]        # the graph as round-trippable config lines, minus the session
                            #   scaffolding and patron sidecars a replay rebuilds anyway
dump_metadata [<node>]      # JSON keyed by node name: class, counter, sink, target(s),
                            #   debug_state, arguments and the stats counters — one
                            #   round-trip draws the graph, and a full snapshot adds a
                            #   `_header` row. Naming a node returns that one; sidecars
                            #   and nodes whose schema declares `hidden` never appear
stats [<node>]              # NAME COUNT LGST_MSG READ WRITTEN for the nodes sinking INTO
stats -a [<regex>]          #   <node>, matched as an exact name; bare scopes to this
                            #   interpreter's siblings. -a widens to every node matching an
                            #   UNANCHORED regex — the pattern form needs it
uptime                      # UTC clock, plus time since this worker spawned at the
                            #   coarsest scale that fits: 07s, 3m 04s, 2h 09m, 4d 01:12:33
list_timers [-s]            # ID ACTIVE INTERVAL MODE NEXT ONESHOT FIRES TYPE NAME
list_handles [-s]           # ID COUNT TYPE NAME — the cURL-multi handles the loop selects on
profile [on|off]            # toggle _router dispatch profiling (per-node self time)
list_profiles [-s] [<glob>] # that profile table, slowest average first; `total` for the total row
trace [<node>] [<level>]    # set a node's debug_state; `*` hits every node, bare toggles this
                            #   interpreter's, and make_node inherits the level. A traced node
                            #   writes a flat `<node>: DEBUG: <event> <payload>` line on its
                            #   stderr chain at every set_state(), but only while a _router is
                            #   mounted — a hand-built test graph without one caches the state
                            #   and prints nothing. Read it back with dmesg, or watch the
                            #   Console's Event Timeline parse it
dmesg                       # the last 100 lines of this process's stderr ring
log <message>               # write into that ring from here
taillog [<source>] [max_kb] # tail a registry-NAMED log file (php | debug | config
                            #   log_sources entries | active-topology Log nodes), the last
                            #   16KB by default and 64KB at most. Bare lists the registry,
                            #   `sources` returns it as a struct, and
                            #   `read <source> <seg>:<off>` returns the one line at a position
```

The half that changes the graph:

```
make_node <type> <name> [<args>]  # alias: make
remove_node <name> [<more>...]    # also -a <anchored regex>; refuses this interpreter and
                                  #   the reserved scaffolding; aliases: remove, rm
move_node <name> <new name>       # aliases: move, mv
set_sink <node> <target>
connect_node <node> [<target>]    # target defaults to the issuer's FROM — tails a node's
                                  #   flow back into your own session (alias: connect)
disconnect_node <node> [<target>] # undoes that (alias: disconnect)
register / unregister <source> <target> <event>
```

Reach for `connect_node <node>` with no target first: it wires that node's output to your session, and `disconnect_node <node>` takes it back. Mind which kind of node you point at, though. A fan-out node — Tee or Tap — APPENDS your session to its target list and keeps delivering everywhere else; every other node REPLACES its single target, so connecting to one steers its production traffic at you until you disconnect. Settings_Sync appends like the other two and then skips you: it pushes only to a target whose head resolves to an `HTTP_Out_Node` carrying a live signing session, and a REPL session's head is no such node, so your target earns the rate-limited `no session for <target>; skipping this push` and nothing else. Watch its pushes on the spoke, not from here.

The `Tee → Dumper → Grep → Stderr` debug tap the substrate is designed around ships in no topology; build it in the REPL. `make_node` sinks each new node into the interpreter, so the wiring is a target chain and nothing else:

```
make_node Dumper tap-render           # renders any message to one text line
make_node Grep   tap-grep <pattern>   # the PCRE BODY: no delimiters, no trailing modifiers
make_node Stderr tap-out              # terminal: writes that line to the stderr chain
connect_node tap-render tap-grep
connect_node tap-grep tap-out
connect_node <tee> tap-render
```

Order is not free. Stderr writes TM_BYTESTREAM alone, so the Dumper has to render ahead of it, and Grep drops every message that misses the pattern, TM_COMMAND and TM_EOF included — fine on a tap, ruinous on a production edge. Take the tap back out with `disconnect_node <tee> tap-render` and three `remove_node`s.

The shell builtins compose a path with the current cwd. After `cd <type>.p0`, a bare `uptime` runs on that worker with no further typing, and `command_node <path> <verb>` reaches somewhere else without moving. `cd`, `status`, `debug_level`, `var`, `print`, `clear`, `show_parse` and `include` are LOCAL — the Shell answers them itself, and sending one over the wire raises `unknown command: <verb>`:

```
cd [<path>]                          # empty resets to the local interpreter (alias: chdir)
pwd                                  # reply shows ` <cwd> -> <from>`
command_node <path> <verb> [<args>]  # TM_COMMAND without changing cwd (aliases: command, cmd)
request_node <path> [<value>]        # TM_REQUEST; the receiver replies TO=FROM (alias: request)
tell_node <path> <info>              # TM_INFO, fire-and-forget (alias: tell)
send_node <path> <bytes>             # TM_BYTESTREAM (alias: send)
send_struct <path> <json>            # TM_STRUCT
send_eof <path>                      # TM_EOF
ping <path>                          # round-trip latency probe
reply_to <node path> <command>       # run the command HERE, route its reply THERE
include <topology>                   # eval a REGISTERED topology's lines through this shell;
                                     #   the name resolves through Topology_Registry, and one
                                     #   carrying a path separator or a bare `..` is refused
                                     #   with `Shell: include: file not found`
status                               # local cli mode summary; sends nothing
var <name> [<op> [<value>]]          # read or set a shell variable, the TSL `<var>` surface
print <text> / clear                 # write a line locally; clear the screen
debug_level [0|1|2]                  # local Dumper verbosity; bare toggles 0 and 1
show_parse                           # dump the parse of every command
```

`secure [<level>]` is the one ratchet, dispatched by the interpreter rather than the Shell. It climbs to at most 3 and never descends: level 1 disables the `make_node` class of verbs, 2 also `command_node`, 3 also `connect_node`. `insecure` declares a process deliberately unratcheted and is refused once it has been secured. So a verb answering `<verb> is disabled at secure level <n>` is not missing — the process ratcheted past it, and only a restart lowers the level.

### Per-node verbs live on `{name}:config`

A node that calls `auto_wire_interpreter()` in its constructor publishes a sibling interpreter named `{name}:config`, built from the dispatching verbs in its `node_schema()`; `dump_metadata`'s `has_config` says which nodes have one. Reach them with `cd <node>:config` or `command_node <node>:config <verb>`. Every verb in both families below is declared `hidden`, which suppresses the dashboard's generic verb button and nothing else — typing them in the REPL works.

A durable reader — `Consumer_Node` with its `Tail` and `File_Tail` subclasses, and `Remote_Source_Node` — carries two families:

- **Dead letters.** `dl_list [limit]` lists quarantined records newest first, fifty at a time by default, each with its reason, attempt count, first-crash and quarantine timestamps, source breadcrumb and `segment:offset:length` locator. `dl_show <locator>` decodes one read-only. `dl_requeue <locator>` redelivers it to the node's sink, leaving the queued copy in place. `dl_purge` deletes every dead-letter segment and its `.idx`. A reader constructed with an empty `deadletter_dir` has no queue at all: `dl_list` answers with an empty page, and the other three with `error: no dead-letter queue configured`. `total` counts the INDEXED records alone. A segment quarantined by a writer that wrote no `.idx` reaches neither `rows` nor `total`, and surfaces only as `unindexed_segments`, the third field on every page — the count the console's Triage panel renders as `N older records predate indexing`. Nothing addresses those records, so `dl_show` and `dl_requeue` cannot reach them: replay the whole segment through `wp nodes ingest`, or let the count rotation age it out.
- **Time travel.** `PAUSE` stops the poll timer and holds the cursor; `STEP` emits at most one message and replies with the `{seg, off, at_eof}` cursor; `PLAY` restores the pre-STEP line mode and resumes; `SEEK_FRAME <segment>` jumps to an offsetlog keyframe and restores the state co-committed there, staying paused. `Remote_Source_Node` answers the same four differently, because its `SSE_In` patron is pushed by the event loop rather than pulled a message at a time: `STEP` emits nothing and always reports `at_eof: true` at the current cursor, so it reads a position rather than advancing one; `PAUSE` disconnects the live stream as well as stopping the timer; and `PLAY` re-arms the channel tick, which reconnects from the committed cursor. A seek splits two ways — an explicit `{segment, offset}` reseeds `SSE_In` here, while a bare `start`, `recent` or `end` sentinel is FORWARDED to the spoke, which holds the segments those words name — and either path drops the undrained pump buffer along with the position it belonged to.

Lag is the exception to the pattern. `GET_LAG` is a REQUEST verb on the reader itself, not a `:config` command, so ask for it with `request_node <reader> GET_LAG` and read the TO=FROM reply's `data`. It carries more than the three fields the schema advertises: `bytes_behind`, `segments_behind` and `caught_up`, then `end_segment` and `end_size` for the newest segment, `end_bytes` for the partition footprint summed over every live segment — which FALLS when retention deletes one — and the `cursor_segment` and `cursor_offset` the distance was measured from, so a distance never travels without its cursor. `GET_LAG` is also the only verb on that path: a typo comes back as an ordinary TM_STRUCT|TM_RESPONSE whose `data` is `{ error: "unknown request verb: X" }` rather than a TM_ERROR, because no interpreter sits there to turn a throw into one.

### Piping into the REPL

Redirected stdin skips readline — `posix_isatty(STDIN)` gates it, and the same flag suppresses the prompt and the trailing newline, so a scripted capture carries only what the script asked for. Neither mode prints its own banner: the `status` builtin renders the mode summary on demand.

```bash
echo -e "ls\ndump my-node" | wp nodes cli
```

On stdin EOF the reader emits a TM_EOF, the Shell restamps it `FROM=_output/$pid` and `TO=<cwd>`, the interpreter it lands on bounces `TO=FROM`, and the Dumper seeing that echo flips the exit flag. In attached mode the round trip rides through the IPC partitions, which is what guarantees every preceding reply has been read off disk before the process exits — no `sleep` slack needed. A 5-second deadline covers a dead worker.

## Hunting a spinner

A worker burning a CPU with no traffic is a timer re-arming every tick or a cURL handle that never completes. Attach and read `list_timers`: `NEXT <= 0` with a `FIRES` count that climbs between runs is the spinner. `MODE` disambiguates a legitimate Router hitchhike (`router`, which has no own next fire, so `NEXT` reads `-`) from an own Event_Framework slot (`event_framework`) and from a disarmed timer (`inactive`). `list_handles` does the same for egress: a handle whose `COUNT` never advances is stuck. `list_timers` walks the node registry for every `Timer_Node` and `list_handles` reads the Event_Framework's own handle table, so neither is a cached snapshot. The Inspector's Runtime modal runs the same two verbs with `-s` and flags the condition for you, tinting a spinning row and leading it with a ⚠ — but only in a PHP scope, since the browser scope reports every timer's next fire as null and is never flagged.

For a worker that is busy rather than spinning, `profile on` makes `_router` time each dispatch and `list_profiles` ranks nodes by average self time. Turn it off when you are done: two `microtime()` reads bracket every dispatch while it stands.

## On-disk layout

Everything hangs off `base_directory`, `/tmp/newspack-nodes` by default and one path per install in dndocker: `/volumes/pyrobase/tmp/newspack-nodes` on `eve-pyrobase1-1`, `/volumes/gyropyro/tmp/newspack-nodes` on `eve-gyrobase1-1`. `doctor`'s `filesystem` and `ownership` rows both print the path that resolved.

```
{base}/
  locks/       {type}.p{N}.lock.d/   heartbeat  started  restart  stop  reload
               {type}.p{N}.lock.d.stealing.{pid}.{uniqid}/   leaked steal scratch
  ipc/         {type}.p{N}/   input/   input.offsets/   output/
  logs/        {name}.p{N}/   {seg}.log  {seg}.idx   .rotate.lock.d/  write.lock.d/
  offsets/     {topology}.{log}.p{N}/   {seg}.log
  deadletter/  {topology}.{log}.p{N}/   {seg}.log  {seg}.idx
  topologies/  {name}.tsl
  layouts/     {name}.layout
```

The offsetlog and dead-letter directory names are not fixed by the substrate: they are the Consumer's second and third `make_node` arguments. The stock topologies spell them `<config:offsets_dir>/<topology>.<log>.p<partition>` and `<config:deadletter_dir>/<topology>.<log>.p<partition>`, and both stay sole-writer — which is what the topology conflict gate checks.

`heartbeat` holds the owner's pid and its mtime is the liveness signal `status` reads; `started` is the acquisition time behind Uptime. Three flag files steer a holder from a process holding no instance: `restart` recycles it, `stop` empties the slot, `reload` re-reads config without exiting. `Lock_Node` claims a directory with `mkdir` rather than `flock`, because `mkdir` is POSIX-atomic on the NFS, tmpfs and bind mounts this runs on; a stale steal renames the old directory aside first, and a `.stealing.` leftover is scratch from an interrupted steal that the reconcile pass reaps.

The IPC tree is the substrate's own: `input/` is a Partition the cli writes commands into, `input.offsets/` is that consumer's durable offsetlog so a respawned worker resumes rather than replaying, and `output/` is the `_repl` Partition the attached cli tails. The IPC-input Consumer stamps `FROM = _repl`, which is the whole reply path — the interpreter answers `TO = FROM` and Router hands the answer to `_repl`. Addressing is the correlation (ADR-7); nothing else pairs a reply with its command.

A `{seg}.idx` sidecar appears only when a Partition has a `with_index()` formatter set. A dead-letter queue always installs one — it is the triage metadata `dl_list` pages through — and a data partition usually has none, so its absence under `logs/` is normal rather than corruption.

On-disk records are 7-element positional JSON lists — `[TYPE, TIMESTAMP, FROM, TO, ID, KEY, VALUE]` — so `head -c 500` on the newest `{base}/logs/firehose.p0/{seg}.log` is a legitimate first look. Segment numbers only climb, and retention deletes the oldest, so segment 0 is usually gone.

## The browser side

`DebugOverlay` (`src/debug-overlay/`) puts the page's own live `Core.nodes` graph on top of whatever dashboard is running. `?nodes-debug=1` opens the gate and sticks it in `localStorage` under `newspack-nodes:debug`; `?nodes-debug=0` clears it. Ctrl+` then toggles the panel. It carries two tabs: Overview, this browser's I/O rates, sampled whether the panel is open or shut; and Console, the graph in the shared GraphView plus a REPL driving the page's own Command_Interpreter. The gate is a dev affordance, not access control — the REST command endpoint authorizes whatever the REPL sends.

No overlay at all under `?nodes-debug=1` means the page never loaded a bundle to carry it. `Admin::enqueue_react_page()` gates on the build directory holding an `index.js` and returns null without enqueueing when it does not, so an unbuilt plugin renders its empty mount div and says nothing — check `build/<tree>/index.js` at the `dir` the page passed in before reading anything else as a graph failure.

The panel is a floating `position: fixed` window: drag it by the header, resize it from eight edge and corner handles down to a 200×120 floor, and double-click the header to maximize or restore. Its frame persists under one global key, `newspack-nodes:debug:frame`, independent of the per-dashboard key the canvas layout uses, so a panel comes back where the last visit left it.

Overview stacks its rate cards over `Messages (this browser)`: the lines `Core.stderr()` classified on this page load, newest first, behind err, warn and dbg chips. Those are the browser runtime's own traces and never a worker's — the always-open counterpart to the Console's `dmesg`. The ring holds 200 lines and is never persisted, so a warning that scrolled off is gone; only the hour-long rate series survives a reload. `Reset stats` zeroes the counters, the ring and that series and drops its stored copy, but deliberately leaves the SSE connect stamp alone, so Uptime keeps reading the real connection age instead of reporting a reconnect that never happened.

The Console's REPL mounts its own nodes on the page's exospine backbone, the way `wp nodes cli` builds a session graph: `_output`, the Dumper owning the transcript and `debug_level`; `_stdout`, where the Shell's builtins print; `_completion`; and `_metadata` targeting `_cwd`, the canvas poll, re-pointed after every `cd`. Outgoing statements pass an unnamed gate between the Shell and its sink that stamps the Compose modal's per-send fields — unaddressable by design, because nothing a message can reach should stamp them. The browser Shell answers two builtins the PHP one has no use for, `list_skins` and `set_skin <name>`, which restyle the host and reach no node. Transcript, verbosity and the interpreter's `trace` level all reload from `localStorage`, so an old transcript or an unexpectedly loud trace after a refresh is that persistence, not a stale render. At the prompt, Ctrl/Cmd+L clears the transcript; `/` focuses it from anywhere else on the page that is not itself editable; Esc minimizes the transcript and blurs the input, leaving `/` ready again.

The Console's rail opens four wider views. Runtime and Profiler each build their own poller; Event Timeline re-renders the `_output` transcript, parsing the `DEBUG:` lines `trace` produces; and Triage, reached from a selected node, pages that node's dead letters through the same `dl_*` verbs.

The overlay is inlined into each consumer's bundle rather than built here, so a change to it means rebuilding **both** newspack-nodes and every consumer; otherwise the consumer ships the old copy. A dashboard node sitting at counter 0 in the console is dead, not composed — see the `nodes-dashboards` skill. Two more things mislead. `_router` outlives every teardown by design — it is the page's one heartbeat, so it and its 1-second timer are still registered after the last dashboard unmounts, which is expected rather than a leak to chase. And the `Debug` button on a log-stream dashboard's toolbar is not this overlay: it swaps the row renderer for the shared ID · KEY · VALUE view and pretty-prints a struct row's raw JSON, which is the faster way to read a row's ring content when the graph is not what you are questioning.

## Reading the application firehose

`wp nodes reqgrep` belongs to `newspack-event-logger-nodes`, not the substrate, and exists only where that plugin is active (it is, in dndocker). It reads the firehose partitions, groups lines by request id, and prints each request as an indented lifecycle tree.

Three read paths share one graph shape. Cat mode, the default, drives one Consumer per firehose partition to EOF — from the start, or from the second-to-last segment under `--recent`. `--follow` seeds the same Consumers at the tail and runs them under the event loop until SIGINT. Piped stdin wins over both, and silently ignores `--follow` and `--recent`.

```bash
wp nodes reqgrep <pattern>         # match request id, URL, or any text; everything if omitted
wp nodes reqgrep --recent          # seed at the second-to-last segment, drain to EOF
wp nodes reqgrep --follow          # tail under the event loop until SIGINT
wp nodes reqgrep --incomplete      # only requests that reached neither complete nor aborted
wp nodes reqgrep --raw             # the matching JSONL, unformatted
wp nodes reqgrep --firehose=<dir>  # read another firehose dir, inside the configured logs dir
wp nodes reqgrep --bucket-size=<n> --num-buckets=<n>   # history geometry; 250 and 10 by default
```

For the pretty-printer's envelope unwrapping and the rest of the application surface, use the `event-logger-nodes-debugging` skill.

## Failure modes

**A worker spawns and immediately exits.** Run it in the foreground: `wp nodes run <type> --partition=<N>` ends on `Worker exited with status: <status>` — `skipped` carrying the acquire failure, `load_failed` carrying the `.tsl` error, or `ok`. The common substrate cause is `skipped (lock_held)`, which is benign: the spawn found the lock already taken, and a spawn is idempotent. Every other stop reason prints `stopping — <reason>` to stderr as it fires — `lock lost`, `lock dir gone`, `stop requested`, `restart requested`, `lock heartbeat gone`, `lock stolen by pid <n>`, the memory watermark, or three consecutive failed DB checks — so read the whole output, not the last line. The routine `max_runtime` recycle and the on-demand idle exit deliberately print nothing.

**No firehose lines for a request that certainly ran.** The event logger's `Log_Manager` bails inert — never starting — on two conditions its constructor checks in order: `enable_logging` off, and a root euid, whose writes would leave root-owned segments the web user could never append to. Neither says anything. Check the config key, then run wp-cron and every by-hand `wp` command as the web user.

**Messages enter a Topic but the Consumer never sees them.** Check the segment file's size and mtime. Partition batches its writes and flushes at the end of the event-loop iteration, so a synchronous write-then-read with no tick between them sees an empty segment. That is the batch, not a loss.

**`Core::node('foo')` returns null in a constructor.** The constructor ran in request scope, before the Event_Framework drained anything. Move the lookup to a READY listener or make the caller lazy (ADR-5).

**A Tee's targets are dead and Router logs `NOT_AVAILABLE`.** Tee drops every target whose HEAD segment names no live node, on each `fill()`, so stale config self-heals as soon as traffic arrives. A `NOT_AVAILABLE` that survives the first message means the head still resolves and the rest of the path does not — Router itself is complaining: `disconnect_node <tee> <dead-target>`.

**`wp nodes cli` burns 100% CPU.** Readline is installed on a pipe, where `readline_callback_read_char()` reads the TTY layer rather than the descriptor and spins. `CLI_Command::terminal()` derives `is_tty` from `posix_isatty(STDIN)` once and installs readline only on a real TTY, so seeing this means that derivation was bypassed.

**Replacing plugin files under a running worker.** `restart` is not enough: a worker that released its lock and asked for its own respawn holds no lock dir while it boots, so a deploy that starts there hands the successor a half-swapped `includes/`. Take the fleet down first — `wp nodes stop`, then deploy, then `wp nodes start`. `stop` holds the fleet, flags every held lock, and waits up to 90 seconds (`--timeout`) for both the lock dirs and the in-flight spawns the coordinator's throttle records; it exits non-zero naming the stragglers if any outlasts that, so a `&&` chain never runs the deploy against a live process. `status` reads `held` until `start` clears the hold.

## Related skills

- `nodes-workflow` — landing a change and riding it through deploy, restart and verify
- `nodes-review` — the substrate contract checklist
- `nodes-dashboards` — building the graph a dashboard inspects
- `event-logger-nodes-debugging` — the application layer above this one
