---
name: nodes-debugging
description: Debugging the newspack-nodes substrate live — REPL commands, log paths, worker health, and common failure modes. Use when something flowing through the node graph isn't behaving as expected, when workers are unhealthy, or when you need to inspect node state without redeploying.
argument-hint: "[symptom]"
---

# Newspack Nodes Debugging

Live-investigation reference for the substrate. Read `AGENTS.md` first for the conceptual model.

## When to Use

- A worker is supposed to be running but isn't
- A message you produced doesn't seem to be flowing through the graph
- The supervisor keeps respawning workers
- You want to introspect node state without restarting the process

## REPL: `wp nodes cli`

The cli refuses to run as root — workers run as the web user and create their IPC dirs (`{base_dir}/ipc/{type}.p{N}/input/p0/`) under that ownership. A root cli would seed `input/p0/` as root, leaving non-root clis unable to append. The guard prevents that. If you've previously hit this state, recover with `chown -R <web-user>:<web-user> {base_dir}/ipc/`.

Multiple concurrent clis against the same worker work fine — each cli's `cmd-out` Partition appends to the same input dir under PIPE_BUF (no lock; cli writes are tiny and never exceed 4KB).



Two modes:

**Bare** (`wp nodes cli`) — local-only. Builds Shell + CommandInterpreter + Router + Dumper(`_output`) and runs commands in the wp-cli process itself. Use for testing CommandInterpreter verbs without touching a worker.

**Pivoted** (`wp nodes cli <reader>.p<N>`) — attaches to a live worker via a pair of IPC Partitions. Commands you type get serialized to disk; the worker reads them, processes them in its own event loop, and writes responses back to a different Partition the cli tails. Lets you `dump_node`, `connect_node`, `disconnect_node` against a running graph without disturbing it.

The cli verifies the worker exists by checking for `{base}/locks/{reader}.lock.d/`. Typo'd reader ids fail fast with "no worker '<id>' (run `wp nodes ls` to list active workers)" instead of creating ghost IPC partitions. Staleness is not blocked at attach time — a stale worker is mid-restart and the cli will work once the supervisor respawns it.

Useful verbs (run from inside the cli prompt — see `help` for the full set):

```
make_node <type> <name> [<args>]    # construct a registered Node (alias: make)
remove_node <name> [<more>...]      # remove a node by name, also -a <regex> (aliases: remove, rm)
list_nodes [-clst] [<node>]         # nodes sinking INTO <node>; -c count -l count+target -s sink -t target (alias: ls)
list_nodes -a [-clst] [<glob>]      # all nodes filtered by anchored regex
dump_node <node> [<keys>]           # config + state of one node (alias: dump)
dump_config                         # full topology as round-trippable shell verbs
dump_metadata                       # JSON object keyed by node name; class/counter/sink/target/debug_state/arguments/lgst_msg/bytes_read/bytes_written — one round-trip gives a visualizer the graph. Patron-linked (`{node}:config`) CIs are filtered out. NOT the same verb as `Workers_CI`'s `dump_metadata` over REST (that returns `{workers[], supervisor, logs, num_partitions, num_segments, segment_size, timestamp}`).
debug_state [<node>] [<level>]      # toggle/set node's debug_state level (0/1/N). No args toggles the interpreter's own.
uptime                              # clock-time + days+HH:MM:SS since Core::reset() (worker spawn)
stats [-a] [<regex>]                # NAME COUNT LGST_MSG READ WRITTEN columns; default scope is siblings, -a all
reply_to <node path> <command>      # run <command> HERE but route reply to <node path> (inverse of command_node)
set_sink <node> <target>            # rewrite a node's sink at runtime
connect_node <node> [<target>]      # set or add a target on <node>; <target> defaults to issuer FROM (alias: connect)
disconnect_node <node> [<target>]   # remove a target; defaults to issuer FROM — undoes a self-connect (alias: disconnect)
cd [<path>]                         # change cwd; empty resets to local interpreter (alias: chdir)
status                              # print local cli mode summary (no message sent to worker)
pwd                                 # print cwd; reply shows ` <args> -> <from>`
tell_node <path> <info>             # TM_INFO at prefix(<path>) — fire-and-forget (alias: tell)
send_node <path> <bytes>            # TM_BYTESTREAM at prefix(<path>) (alias: send)
send_eof <path>                     # TM_EOF at prefix(<path>)
command_node <path> <verb> [<args>] # TM_COMMAND at prefix(<path>) without changing cwd (aliases: command, cmd)
request_node <path> [<value>]       # TM_REQUEST at prefix(<path>); receiver replies via TO=FROM (alias: request)
ping <path>                         # round-trip latency probe
include <file>                      # read commands from <file>, parse each line
log <message>                       # write <message> to the worker's stderr (server-side debug log)
dmesg                               # print the recent server-side stderr tail (last 100 lines)
help [<topic>]                      # full help; per-verb if <topic> given
```

The `<path>` arg to `tell_node` / `send_node` / `command_node` / `request_node` / `ping` composes with the shell's cwd via `prefix()` — so `cd firehose-workers.p0` then `command_node "" status` dispatches `status` to the worker without further typing.

`ping`, `tell`, and command responses use the FROM=`_output/$pid` stamp so replies walk back through `_router → _output`. `_output` is the Dumper instance; its TO filter matches `(?:_output/)?$pid` so other cli sessions' replies fall through silently.

CommandInterpreter only handles TM_COMMAND with empty TO. A non-empty TO means the message is in transit toward another node; interpreter forwards it to its sink (Router) and lets the addressed node decide. Any exception thrown by a verb is caught and returned as `TM_COMMAND|TM_ERROR` along the FROM trail — the cli's Dumper writes the payload to stderr (no `ERROR:` prefix).

### Piping into the REPL

If you redirect stdin (heredoc, file), readline gets skipped automatically (it'd otherwise busy-loop reading from a TTY layer that doesn't see the pipe). `posix_isatty(STDIN)` gates the choice — the same flag also suppresses prompt rendering and the pivoted-mode banner so scripted captures are clean. The mode summary is still available on demand via the `status` builtin.

```bash
# Drive the REPL non-interactively for scripted testing.
echo -e "ls\ndump my-node" | wp nodes cli
```

The non-readline path is fgets-based. On stdin EOF, the cli emits a TM_EOF Message through the Shell (FROM=`_output/$pid`); the receiving CommandInterpreter bounces TO=FROM, and the cli's Dumper sees the echo and flips the exit flag. In pivoted mode this round-trip rides through the cmd-out / reply-in IPC partitions, guaranteeing all preceding output has been read off disk before the cli exits — no `sleep` slack needed. The 5-second deadline is the fallback for a dead worker; the cli exits anyway after that.

For the round-trip to work, Partition and Topic pack ALL message types (TM_REQUEST, TM_ERROR, TM_EOF included). Earlier behavior dropped these as "control flow, not data" — that broke `request_node`, `send_eof`, and pivoted-mode TM_COMMAND|TM_ERROR responses (a verb that throws on the worker). Data partitions (firehose.log, jobs.log) still only see TM_BYTESTREAM / TM_STRUCT in practice; the broader contract is a no-op there.

## Worker health

```bash
# List worker types discoverable from topology files (no liveness info).
wp nodes types

# List active workers + last heartbeat age (live vs stale).
wp nodes ls

# Status (formats: table, json).
wp nodes status --format=json

# Force-restart by type (sends a restart flag-file via Lock). Run
# `wp nodes types` first to discover what's live — the substrate itself
# ships no topologies; topologies come from application plugins (ELN ships
# `firehose-workers-and-jobs`, `job-workers`, `request-workers`).
wp nodes restart all --all-partitions   # or a specific type from `wp nodes types`
```

A worker reports as `[live]` if its heartbeat file (under `{base}/locks/{type}.p{N}.lock.d/heartbeat`) was touched within `stale_timeout`. `[stale]` means the supervisor will respawn it on the next minute-cron tick.

## Log layout

Substrate-side layout under `{base_directory}/`:

- `locks/{worker-type}.p{N}.lock.d/heartbeat` — worker liveness; `restart` flag triggers shutdown
- `offsets/{reader}.p{N}/p0/{seg}.log` — Consumer checkpoint history (offsetlog)
- `ipc/{worker-type}.p{N}/{input,output}/p0/{seg}.log` — bidirectional IPC for `wp nodes cli`

Application-side log dirs (created by whatever Partition/Log a topology constructs):

- `logs/firehose.log/p{N}/{seg}.log` — packed Message envelopes from ELN's LogManager
- `logs/jobintake.log/p{N}/{seg}.log` — large jobs that bypass the firehose

`base_directory` is `/tmp/newspack-nodes` by default; override via `Newspack_Nodes\Config`. (Don't confuse with the legacy event-logger path under `/volumes/pyrobase/tmp/event-logger` — different runtime.)

## Common failure modes

**Worker spawns but immediately exits.** Check the heartbeat file and the supervisor log. Most common substrate-side cause: the spawn HTTP request hit a `/spawn` controller that couldn't acquire the Lock (another worker is already holding it; that's idempotent and harmless). Application-side: ELN's `LogManager` refuses to run as root to avoid leaving the web user unable to write later — so if you ran `wp-cron --allow-root`, the worker noisily aborts. Either way, run wp-cron as the web user.

**Messages enter Topic but don't reach the Consumer downstream.** The Consumer (or Tail, for a non-partitioned file) reads what Partition wrote. If the Partition didn't flush the batch, the reader won't see it on poll. Check the segment file's mtime/size with `ls -la`. If the segment is empty after a write, the Partition's batch is still pending — `set_timer(0, true)` flushes at the end of the event-loop iteration, so a synchronous write-then-read (no event loop tick between them) will see nothing.

**`wp nodes cli` runs at 100% CPU.** Means readline got installed in a non-TTY context. The fix is in place (gate on `posix_isatty(STDIN)`), so this should be impossible — but if it recurs, check that `cli-command.php`'s `$is_tty` flag is being computed before `set_readline_mode`.

**`Core::node('foo')` returns null inside a constructor.** Constructor ran during request scope before the EventFramework drain started. Either move the lookup to a `READY`-event listener, or rewrite the caller to be lazy.

**Tee has dead targets and the Router log fills with NOT_AVAILABLE.** Tee prunes dead bare-name targets at the top of every `fill()` (path-shaped targets with a `/` pass through to the sink), so a Tee with stale config self-heals as soon as it sees traffic. If you still see `NOT_AVAILABLE` after the first message flows, the target is path-shaped (it routes via Router) and Router itself is logging — fix the topology with `wp nodes cli ... disconnect_node tee dead-target`.

## Inspecting wire format on disk

The on-disk format is a 7-element positional JSON list per line: `[TYPE, TIMESTAMP, FROM, TO, ID, KEY, VALUE]`.

```bash
# First entry of partition 0's segment 0 of the firehose.
head -c 500 {base_dir}/logs/firehose.log/p0/0.log
```

For the application's reqgrep pretty-printer, see the event-logger-nodes plugin's debugging skill — it knows how to unwrap the envelope and render the inner entry.

## Related Skills

- `nodes-workflow` — workflow for landing changes
- `nodes-review` — substrate contract checklist
