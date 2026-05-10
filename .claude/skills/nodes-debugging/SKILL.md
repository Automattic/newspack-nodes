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

Useful verbs (run from inside the cli prompt):

```
ls                                  # nodes whose sink is _command_interpreter
ls -a [<glob>]                      # all nodes, optionally filtered by regex
ls -ceolos <node>                   # nodes sinking INTO <node>; flags add c/e/l/o/s columns
dump_node <node>                    # config + state of one node (alias: dump)
dump_config                         # full topology as round-trippable shell verbs
connect / connect_node <a> <b>      # add b as target of a
disconnect / disconnect_node <a> [<b>]
                                    # remove b from a's targets (b required for Tee)
ping <path>                         # round-trip latency probe
```

`ping` and `tell` use the FROM=`_output/$pid` stamp so the reply walks back through `_router → _output`. `_output` is the Dumper instance; its TO filter matches `(?:_output/)?$pid` so other cli sessions' replies fall through silently.

### Piping into the REPL

If you redirect stdin (heredoc, file), readline gets skipped automatically (it'd otherwise busy-loop reading from a TTY layer that doesn't see the pipe). `posix_isatty(STDIN)` gates the choice. The non-readline path is fgets-based and exits cleanly on EOF.

```bash
# Drive the REPL non-interactively for scripted testing.
echo -e "ls\ndump my-node\nquit" | docker exec -i eve-pyrobase1-1 wp nodes cli \
    --allow-root --path=/var/www/html
```

(`quit` isn't a real verb; the loop exits when stdin closes.)

## Worker health

```bash
# List all worker types + last heartbeat age.
docker exec eve-pyrobase1-1 wp nodes ls --allow-root --path=/var/www/html

# Status (formats: table, json).
docker exec eve-pyrobase1-1 wp nodes status \
    --format=json --allow-root --path=/var/www/html

# Force-restart by type (sends a restart flag-file via Lock).
docker exec eve-pyrobase1-1 wp nodes restart firehose-workers --all-partitions \
    --allow-root --path=/var/www/html
```

A worker reports as `[live]` if its heartbeat file (under `{base}/locks/{type}.p{N}.lock.d/heartbeat`) was touched within `stale_timeout`. `[stale]` means the supervisor will respawn it on the next minute-cron tick.

## Log layout

Per the topology under `{base_directory}/`:

- `logs/firehose.log/p{N}/{seg}.log` — packed Message envelopes from LogManager
- `logs/jobintake.log/p{N}/{seg}.log` — large jobs that bypass the firehose
- `locks/{worker-type}.p{N}.lock.d/heartbeat` — worker liveness; `restart` flag triggers shutdown
- `offsets/{reader}.p{N}/p0/{seg}.log` — Consumer checkpoint history
- `ipc/{worker-type}.p{N}/{input,output}/p0/{seg}.log` — bidirectional IPC for `wp nodes cli`

`base_directory` is `/tmp/newspack-nodes` by default; override via `Newspack_Nodes\Config`. (Don't confuse with the legacy event-logger path under `/volumes/pyrobase/tmp/event-logger` — different runtime.)

## Common failure modes

**Worker spawns but immediately exits.** Check the heartbeat file and the supervisor log. Most common cause: spawning as root via `--allow-root` + `LogManager` short-circuiting (it refuses root to avoid leaving www-data unable to write later). The fix is to run wp-cron as the web user.

**Messages enter Topic but don't reach the Tail downstream.** The Tail reads what Partition wrote. If the Partition didn't fsync the segment, the Tail won't see it on poll. Check the segment file's mtime/size with `ls -la`. If the segment is empty after a write, the Partition's batch is still pending — `set_timer(0, true)` flushes at the end of the event-loop iteration, so a synchronous write-then-read (no event loop tick between them) will see nothing.

**`wp nodes cli` runs at 100% CPU.** Means readline got installed in a non-TTY context. The fix is in place (gate on `posix_isatty(STDIN)`), so this should be impossible — but if it recurs, check that `cli-command.php`'s `$is_tty` flag is being computed before `set_readline_mode`.

**`Core::node('foo')` returns null inside a constructor.** Constructor ran during request scope before the EventFramework drain started. Either move the lookup to a `READY`-event listener, or rewrite the caller to be lazy.

**Tee has dead targets and the Router log fills with NOT_AVAILABLE.** Tee prunes dead targets at fill time, but only after the first failed dispatch. Either restart the worker after a topology change, or use `wp nodes cli ... disconnect_node tee dead-target`.

## Inspecting wire format on disk

The on-disk format is a 7-element positional JSON list per line: `[TYPE, TIMESTAMP, FROM, TO, ID, KEY, VALUE]`.

```bash
# First entry of partition 0's segment 0 of the firehose.
docker exec eve-pyrobase1-1 head -c 500 \
    /tmp/newspack-nodes/logs/firehose.log/p0/0.log
```

For the application's reqgrep pretty-printer, see the event-logger-nodes plugin's debugging skill — it knows how to unwrap the envelope and render the inner entry.

## Related Skills

- `nodes-workflow` — workflow for landing changes
- `nodes-review` — substrate contract checklist
