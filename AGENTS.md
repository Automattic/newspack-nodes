# Newspack Nodes

Generic message-passing runtime — a Tachikoma-style node graph implemented in PHP/WordPress. Independent of any application; this plugin owns the substrate (Node, Message, Router, Topic, Partition, Worker, Supervisor, REPL) and nothing application-specific.

Applications (the first being `newspack-event-logger-nodes`) compose Nodes on top.

## Architecture at a Glance

```
                    ┌─────────────────────────────────────┐
                    │         EventFramework              │
                    │  (drain loop: stream_select +       │
                    │   curl_multi_select + timers)       │
                    └─────────────────┬───────────────────┘
                                      │
                                      ▼
                    ┌─────────────────────────────────────┐
                    │             Router                  │
                    │  (path-based dispatch by TO;        │
                    │   hitchhike Timer for free coarse   │
                    │   periodic work)                    │
                    └─────────────────┬───────────────────┘
                                      │ fill($message)
                                      ▼
   ┌──────────────────────────────────────────────────────────┐
   │                       Node graph                         │
   │   Tail ─→ Tee ─┬─→ <app-node-1> ─→ Partition (terminal) │
   │                └─→ <app-node-2> ─→ Topic (KEY-routed)   │
   │   Consumer ────────→ <app-node-3> ─→ Hook ─→ ...        │
   └──────────────────────────────────────────────────────────┘

   Worker process (~595s) ─ self-respawn via HMAC-validated POST ─→ Supervisor
                                                                       │
                                                              cron backstop (60s)
```

Every node honors one contract: `fill( array &$message ): void`. That uniformity is what lets composition work — any node can sink into any other node.

## Commands

```bash
# Deploy to dndocker container (after editing source).
docker exec eve-pyrobase1-1 /services/pyrobase/setup/newspack-nodes.sh

# Run unit + integration tests inside the container.
docker exec -u bend eve-pyrobase1-1 bash -c 'cd /usr/src/newspack-nodes/tests && phpunit'

# Lint PHP (VIP Go).
npm run lint:php

# REPL against a live worker (after deploy).
docker exec -it eve-pyrobase1-1 wp nodes ls --allow-root --path=/var/www/html
docker exec -it eve-pyrobase1-1 wp nodes cli firehose-workers.p0 --allow-root --path=/var/www/html
```

## Code Style

WordPress VIP Go Coding Standards (enforced by `phpcs.xml.dist`):

- `snake_case` for functions and variables.
- Yoda conditions: `if ( 'value' === $var )`.
- `[]` arrays (not `array()`), arrow functions, spread operator: allowed.
- Tab indentation, spaces inside parentheses: `function_name( $param )`.
- PHP 8.0+ typed properties; constructor property promotion where it shortens.
- PHPDoc blocks for public methods.

Conventional commits (`feat:`, `fix:`, `refactor:`, `test:`, `docs:`). Subject line short and imperative.

## Architecture Decisions

These are intentional. Don't "fix" them.

1. **Uniform `fill()` contract.** Every node has exactly one entry point: `fill( array &$message )`. There is no parallel `write()` / `read()` / `process()` API. Callers that want fire-and-forget or synchronous request/response build the Message inline and call `fill()` directly — no convenience wrappers.

2. **Messages are 7-field arrays, not hashes.** Indexed access is faster than hash lookup in hot paths. Field constants live on `Message::TYPE`/`TIMESTAMP`/`FROM`/`TO`/`ID`/`KEY`/`VALUE`. Use `array_slice( 0, Message::LAST_VALUE_INDEX + 1 )` to copy without internal bookkeeping.

3. **TM_PERSIST contract.** True terminals (Partition, Topic) acknowledge via `answer()` after a successful durable write or `cancel()` when the write was dropped. Forwarders don't ack — they let downstream handle the persist. Forwarders that *drop* a message MUST `cancel()` it so the producer's `max_unanswered` slot is released. `_responder` is the convenience cancel-sink for chainable nodes that end without an explicit terminal (cancels by default; messages flagged TM_ERROR get an `answer` instead, since an error response IS the answer the persist contract was waiting for). Tee tracks `answer` and `cancel` counts separately per message ID; the first counter to reach the fan-out count rolls that verdict up to the producer. Mixed responses forward nothing — the producer's own timeout handles that case.

4. **PIPE_BUF atomic writes.** Partition's default 4096-byte limit relies on POSIX guarantee that small append-mode writes don't tear. Producers that need >4KB MUST opt into `Partition::allow_large_writes()`, which auto-locks via a Lock at `{partition_dir}/write.lock.d/`. Without the lock, concurrent large writes silently corrupt.

5. **Lazy init in Topic / Partition.** Constructors must be safe in request-scope code with NO event loop running. No `set_timer` from constructor (silent leak), no `Core::node()` lookup, no `scandir`. File handles open lazily on first `write()` / `fill()` / `read_at()`. `LogManager` instantiates Topic per request whether or not the request logs — eager scandir per partition × N partitions per request would burn syscalls for nothing.

6. **CRC32 + 31-bit-mask partition routing.** `Partition::hash_to_partition()` is the canonical routing function: `explode('?')` to strip query strings, CRC32 hash, `& 0x7FFFFFFF` to make 32-bit-PHP-safe. Topic, JobIntake-keyed mode, and any other partition routing MUST call this same function — divergent hash families across producers means same key routes to different partitions, breaking ordering.

7. **TO=FROM convention for replies.** Forward direction sets `TO=$this->target` (the path `connect_node` put there). Reverse direction (any kind of response, ack, or error) sets `TO=$message[FROM]` so it walks the breadcrumb trail back. One rule, applied uniformly; path-based routing via `_router` does the rest.

8. **Worker zombie pattern.** Workers spawn via HTTP POST to a HMAC-validated `/spawn` endpoint, then detach with `ignore_user_abort(true) + fastcgi_finish_request() + set_time_limit(0)`. Lifetime ~595s (sized for Atomic's 15-min cap with margin). Self-respawn via fire-and-forget POST inside `finally`; lock release happens BEFORE spawn so the new worker can acquire immediately.

9. **Two-tier safety net.** Workers self-respawn; supervisor catches stale-locked workers (heartbeat > stale_timeout) and force-spawns. Supervisor self-respawns; WP-Cron catches a dead supervisor at minute cadence. Each tier knows only the level immediately below.

## Key Files

### Core substrate

| File | Purpose |
|------|---------|
| `includes/class-core.php` | Per-process registries (`$nodes_by_name`, `$nodes_by_fd`, `$nodes_by_id`), clock (`now()` / `right_now`), shutdown flag, deferred-cleanup queue, rate-limited stderr. |
| `includes/class-message.php` | 7-field array constants, type-flag bitmask, `new_message()`, `packed()` / `unpacked()` JSON wire format. |
| `includes/class-node.php` | Base contract: `fill()`, `sink()`, `target()`, `name()`, `answer()` / `cancel()`, `stamp_message()`, `drop_message()`, `dump_config()`, `register()` / `notify()` / `set_state()`. |
| `includes/class-router.php` | Extends Timer. Path-based dispatch by TO; on each tick fires `notify('TIMER', ...)` for hitchhiking nodes. NOT_AVAILABLE error path on missing target. |
| `includes/class-event-framework.php` | Per-process drain-loop singleton. Merges `stream_select` for local FDs with `curl_multi_select` for cURL handles. Manages timers and deferred cleanup. |

### Node primitives

| File | Purpose |
|------|---------|
| `includes/class-timer.php` | Periodic / one-shot fire. EventFramework slot for sub-second precision; Router-hitchhike for coarse cadences. Pre-declares `FIRE` event. |
| `includes/class-tee.php` | Fan-out to multiple targets. TM_PERSIST aggregation with cancel-dominates; dead-target pruning at fill; per-target try/catch isolates failures. |
| `includes/class-tail.php` | File follower. Three buffer modes (binary / block-buffered / line-buffered, default line). 65KB read chunk with line-buffer accumulation. Inode + size-shrink rotation detection. |
| `includes/class-callback.php` | Inline closure as a node. ~10 lines. |
| `includes/class-hook.php` | WordPress action / filter as a node. Action mode forwards unchanged; filter mode passes message through `apply_filters` and forwards result. |
| `includes/class-command-interpreter.php` | Shell-vocabulary dispatch (`make_node`, `set_sink`, `connect_node`, `disconnect_node`, `ls`, `dump_config`). Auto-sink default for every `make_node`. Same method invoked by shell verb and by topology PHP code. |
| `includes/class-shell.php` | Subset of real Tachikoma's Shell3.pm. Quote-aware tokenization, single-tier `<var>` interpolation, backslash continuation, `include` builtin. Conditionals/loops/pipes/eval rejected with warning. |
| `includes/class-responder.php` | Convenience cancel-sink for terminal consumers of TM_PERSIST. Secondary path: ID-correlation against shell callbacks. |
| `includes/class-dumper.php` | Terminal output node. Dispatches by TYPE flag (TM_RESPONSE / TM_ERROR / TM_INFO / TM_COMMAND); unwraps Command JSON; intercepts `name=='prompt'` for prompt updates. ANSI prompt-aware async writes. |

### Storage primitives

| File | Purpose |
|------|---------|
| `includes/class-partition.php` | File-segmented append-only log + companion `.idx`. Class API and Node API. Lazy init (no scandir in constructor). `allow_large_writes()` for >4KB payloads (auto-locks). Lift-adapt from event-logger's Firehose. |
| `includes/class-topic.php` | Multi-Partition wrapper. Hashes KEY to partition via `Partition::hash_to_partition()`. Net-new (Tachikoma's Topic.pm minus broker/replication). Pre-declares `READY`. |
| `includes/class-consumer.php` | Tails one or more Partitions; commits checkpoints `{seg, off, ts}` to its offsetlog (also a Partition). Generalizes existing `LogReader`. |

### Lifecycle

| File | Purpose |
|------|---------|
| `includes/class-lock.php` | mkdir-based exclusive lock + heartbeat + `with_lock(callable)` + restart channel via `restart` flag file. Lift from event-logger. |
| `includes/class-worker-base.php` | Zombie-process worker lifecycle. `acquire()` / `release()` / `should_continue()`. Memory watermark (80%), DB-check ladder (3× failures over 30s), max_runtime (~595s). |
| `includes/class-supervisor-base.php` | Pure-data spawn-coordination logic so tests can drive without forking. `worker_needs_spawn()`, `record_spawn()`, `is_recently_spawned()`. |
| `includes/class-supervisor.php` | Concrete Supervisor with HMAC spawn token rotation. 10s window, accepts current and previous for race tolerance. |
| `includes/class-bootstrap.php` | Plugin glue: reads `newspack_nodes/topologies` filter, expands to worker descriptors, registers minute cron, hooks `newspack_nodes/supervisor` action. |

### REPL / WP-CLI

| File | Purpose |
|------|---------|
| `includes/class-cli.php` | `wp nodes ls` (read lock dirs) and `wp nodes cli` IPC-attach machinery. |
| `includes/class-cli-command.php` | WP-CLI command wrapper. Builds bare-mode Shell+CommandInterpreter+Router+Responder+Dumper graph, or pivoted-mode with cmd-out Partition + reply-in Consumer. |

### REST

| File | Purpose |
|------|---------|
| `includes/rest/class-spawn-controller.php` | POST `/newspack-nodes/v1/workers/spawn` — HMAC-validated zombie-process spawn. Detaches via fastcgi_finish_request, fires `newspack_nodes/spawn_worker` action. |

## Common Pitfalls

These are mistakes that have actually happened. Pay attention.

- **Messages are arrays, not hashes.** Use `Message::TYPE` etc. constants for indexing. `$message['type']` will silently fail (PHP coerces string to int 0 → corrupted TYPE). Always `$message[ Message::TYPE ]`.

- **TM_PERSIST forwarder vs terminal.** Forwarders sink to the next node (don't ack). True terminals (Partition, Topic, Log) ack on durable write. Forwarders that *drop* a message MUST `cancel($message)` it, otherwise the producer's `max_unanswered` slot leaks forever. Silent ack-drop is the #1 stall cause.

- **FROM stamping at I/O boundaries only.** Tail, Consumer, Job, Connector stamp FROM. Internal nodes (Tee, Hook, application nodes) DO NOT stamp. A message flowing `firehose-in → firehose-fanout → request-builder` carries `FROM=firehose-in` when it reaches RequestBuilder, NOT `firehose-fanout/firehose-in`. Matches real Tachikoma.

- **`answer/cancel` silent-when-no-FROM.** Empty FROM → return without sending. Do NOT fall through to TO=`''` (the prototype's old behavior); that flood-fills the root path with unrouteable acks at shutdown.

- **`stamp_message` empty-name guard.** A node with no name (mid-construction or post-rename) emitting `/from` paths breaks Router. Drop with `print_less_often` instead.

- **Class-API must be event-loop-free.** Constructor for Topic/Partition runs in request scope. `set_timer` from constructor → silent no-op leak (registers with EventFramework that will never run). `Core::node()` lookup → NPE. `scandir` on partition dir × N partitions per request → wasted syscalls. Lazy first-write/first-read.

- **`hash_to_partition` is canonical.** Topic, JobIntake-keyed mode, and any other partition routing MUST call `Partition::hash_to_partition()`. Diverging hash families across producers means same key routes to different partitions; ordering breaks silently.

- **Don't put TM_PERSIST in IPC.** REPL uses TM_COMMAND/TM_RESPONSE which already has request/response shape via ID correlation through Responder. Layering persist on top adds cancel/answer semantics that don't apply (input Partition provides durability; cli isn't running max_unanswered).

- **`MAX_FROM_SIZE = 1024`.** `stamp_message` returns false and drops if FROM exceeds 1024 bytes. Prevents path explosion on cycles.

- **Worker lock release before spawn.** `WorkerBase::execute()` does `release()` THEN `self_respawn()` inside `finally`. Reverse order lets the new worker fail-to-acquire while the old one is still draining; spawn rate-limit then keeps the slot empty for 15s. Don't reorder.

- **HMAC spawn token has TWO accepted windows.** `validate_spawn_token` accepts the current 10-second window AND the previous one. Race tolerance for tokens generated near a window boundary. Don't tighten to single window.

## References

- **Architecture**: `ARCHITECTURE.md` (substrate design, message format, node contracts, drain loop, REPL).
- **API**: `API.md` (REST endpoint reference).
- **Spec**: `services/pyrobase/sources/.specs/2026-05-06-newspack-nodes-design.md` in dndocker (canonical design doc).
- **Application example**: `services/pyrobase/sources/newspack-event-logger-nodes/` — the first plugin built on this runtime.
