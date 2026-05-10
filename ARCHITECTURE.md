# Newspack Nodes Architecture

Tachikoma-inspired node-graph runtime for PHP. This document describes the substrate. Application-level shape lives in the consuming plugin (e.g., `newspack-event-logger-nodes/ARCHITECTURE.md`).

The canonical design document is [`services/pyrobase/sources/.specs/2026-05-06-newspack-nodes-design.md`](../../../.specs/2026-05-06-newspack-nodes-design.md) in dndocker. This file summarizes the substrate; for rationale and decision history, read the spec.

## Table of Contents

- [Overview](#overview)
- [Message Format](#message-format)
- [Node Base Contract](#node-base-contract)
- [Router](#router)
- [Storage: Topic + Partition](#storage-topic--partition)
- [Consumer + Tail](#consumer--tail)
- [Backpressure (none)](#backpressure-none)
- [TO=FROM Convention](#tofrom-convention)
- [EventFramework](#eventframework)
- [Worker Lifecycle](#worker-lifecycle)
- [Supervisor Lifecycle](#supervisor-lifecycle)
- [REPL: wp nodes cli](#repl-wp-nodes-cli)
- [Substrate Lifecycle Events vs WordPress Hooks](#substrate-lifecycle-events-vs-wordpress-hooks)

## Overview

Three core ideas:

1. **Nodes** — processing units. Every node has `fill( array &$message )` as its only entry point.
2. **Messages** — 7-field arrays carrying a type bitmask, a routable path (TO/FROM), an ID, a KEY, and a VALUE.
3. **Drain loop** — EventFramework merges `stream_select` and `curl_multi_select`, fires timers, runs deferred cleanup.

```
+-----------------------------------------------------------+
|                      EventFramework                       |
|  drain():                                                 |
|   - if cURL handles: curl_multi_select(timeout) ->        |
|       drain transfers -> non-blocking stream_select       |
|   - else:           stream_select(timeout)                |
|   - handle signals                                        |
|   - run Core::run_closing()                               |
|   - fire expired timers                                   |
|   - loop check (should_continue)                          |
+-------------------------+---------------------------------+
                          | on each tick
                          v
+-----------------------------------------------------------+
|                         Router                            |
|  fill($message):                                          |
|   - if TO == "":   sink->fill($message)                   |
|   - else:          [head, rest] = explode("/", TO, 2)     |
|                    target = Core::node(head)              |
|                    if !target: send NOT_AVAILABLE error   |
|                    else:        target->fill($message)    |
|   - on TIMER tick: notify("TIMER", now)  (hitchhike)      |
+-------------------------+---------------------------------+
                          | fill($message)
                          v
+-----------------------------------------------------------+
|                       Node graph                          |
|   +----+    +----+    +----+                              |
|   | A  | -->| B  | -->| C  | --> [terminal]               |
|   +----+    +----+    +----+                              |
|              fan-out via Tee:                             |
|              +----+ -> +----+                             |
|              |Tee | -> | X  |                             |
|              +----+ -> +----+                             |
|                       | Y  |                              |
|                       +----+                              |
+-----------------------------------------------------------+
```

## Message Format

```php
namespace Newspack_Nodes;

class Message {
    public const TYPE      = 0;   // bitmask of message types
    public const TIMESTAMP = 1;   // float, microsecond unix timestamp
    public const FROM      = 2;   // path message came from (trace/reply)
    public const TO        = 3;   // path message is going to
    public const ID        = 4;   // unique identifier (ack/correlation)
    public const KEY       = 5;   // routing/partition/grouping key
    public const VALUE     = 6;   // the data
    public const LAST_VALUE_INDEX = self::VALUE;
}
```

**Why arrays not hashes**: indexed access is faster than hash lookup in hot paths. Messages flow through every Node in the graph; this is one of the busiest data structures in the runtime.

**Field reordering vs Tachikoma**: TIMESTAMP at index 1 (was index 5) so [WHAT + WHEN] groups at the front. STREAM/PAYLOAD renamed to KEY/VALUE — matches Kafka's `ProducerRecord<K,V>`, SQS message attributes, Redis Streams' `XADD key value`.

**Type-flag bitmask** (9 flags):

```
TM_BYTESTREAM = 1     TM_INFO    = 64
TM_EOF        = 2     TM_STRUCT  = 256
TM_PING       = 4     TM_REQUEST = 512
TM_COMMAND    = 8
TM_RESPONSE   = 16
TM_ERROR      = 32
```

Flags compose via bitwise OR: `TM_COMMAND | TM_RESPONSE` = a response to a command. Receivers check via `&`: `if ( $type & TM_COMMAND ) { ... }`. **Never use strict `===`** on combined flags — it misses every combination.

**Wire format**: `Message::packed( array $msg ): string` and `Message::unpacked( string $data ): array` round-trip via JSON with named keys (`type` / `timestamp` / `from` / `to` / `id` / `key` / `value`). The positional in-memory representation is internal; nothing serialized depends on it.

**Message constructors**:

```php
$m = Message::new_message();
$m[ Message::TYPE ]  = Message::TM_BYTESTREAM;
$m[ Message::KEY ]   = '/some-url';
$m[ Message::VALUE ] = $line;
$node->fill( $m );
```

There is no parallel `write()` API and no `produce()` / `query()` helpers — `fill()` is the only way bytes enter a node.

## Node Base Contract

```php
class Node {
    protected string $name = '';
    protected ?Node  $sink = null;
    protected $target;          // string for single owner; array for Tee fan-out
    protected ?Node  $edge = null;
    protected int $counter = 0;
    protected array $registrations = [];   // pre-declared events

    public function fill( array &$message ): void;
    public function sink( ?Node $node = null ): ?Node;
    public function target( $value = null );
    public function name( ?string $name = null ): string;
    public function edge( ?Node $node = null ): ?Node;
    public function counter(): int;

    public function stamp_message( array &$message, string $name ): bool;
    public function drop_message( array &$message, string $error ): void;

    public function dump_config(): string;

    public function register( string $event, string $listener, ?callable $cb = null ): void;
    public function unregister( string $event, string $listener ): void;
    public function notify( string $event, mixed $payload = null ): void;
    public function set_state( string $event, mixed $payload = null ): void;
}
```

**Default `fill()`**:

```php
public function fill( array &$message ): void {
    ++$this->counter;
    $this->sink?->fill( $message );
}
```

The base just forwards. Subclasses override with their actual behavior.

**`stamp_message`** prepends `$name` to the message's FROM with a `/` separator:

```php
$message[ Message::FROM ] = $from === '' ? $name : ( $name . '/' . $from );
```

Returns false (drops) if FROM would exceed `MAX_FROM_SIZE = 1024` — prevents path explosion on cycles. Also drops if `$name` is empty (mid-construction or post-rename); logs via `print_less_often`.

**Name registration**: `$node->name('foo')` registers the node in `Core::$nodes_by_name`. Renaming throws on collision (catches duplicate-node bugs at construction time).

**Pre-declared events**: subclasses populate `$this->registrations[$event] = []` in their constructor for every event they intend to emit. `register()` throws on undeclared events — declared events are the publishing node's contract surface.

## Router

`Router` extends `Timer` (matches real Tachikoma's `Router.pm`). On each tick (default 5s, sized to FlameBuilder/StatsAggregator's flush cadence), it fires `notify('TIMER', now)` — the **Router-hitchhike pattern** for cheap periodic work without per-node EventFramework slots.

`Router::fill()` does path-based dispatch:

```php
public function fill( array &$message ): void {
    $to = $message[ Message::TO ];
    if ( $to === '' ) {
        $this->sink?->fill( $message );    // empty TO -> forward to default sink
        return;
    }
    [ $head, $rest ] = explode( '/', $to, 2 );
    $message[ Message::TO ] = $rest ?? '';
    $target = Core::node( $head );
    if ( $target === null ) {
        // NOT_AVAILABLE error path - sends a TM_ERROR with TO=$message[FROM] back along
        // the breadcrumb trail, so the originator (or some upstream that handles errors)
        // sees it. Re-fills via this Router; the error walks the path. If the FROM head
        // does not resolve either, the recursive call drops on the TM_ERROR-on-error
        // branch (no infinite bounce).
        return;
    }
    $target->fill( $message );
}
```

Routing is path-based (`a/b/c` → "find node a, pass remaining path `b/c`"), not socket-based. Replies use the `TO=$message[FROM]` convention to walk back along the breadcrumb trail.

**First-300s NOT_AVAILABLE rule**: `drop_message` on a NOT_AVAILABLE error AND process uptime < 300s logs via `print_least_often` (silences boot-time race noise). Otherwise `print_less_often`.

## Storage: Topic + Partition

### Partition

One file-segmented append-only log, plus a `.idx` companion. Storage primitive AND Node. Lift-adapt of event-logger's `Firehose`.

```php
$p = new Partition( $base_dir, $partition_id, $segment_size, $num_segments, $max_lifespan );
$p->write( $line );                                     // class API
$p->fill( $message );                                   // Node API
$p->read_at( $segment_id, $offset, $length );           // class API
$p->scan_index( fn ( $line, $seg ) => ..., $newest_first );
$p->allow_large_writes();                               // 4KB -> 10MB; auto-locks
```

`fill()` dispatches by message type:

- **TM_BYTESTREAM** / **TM_STRUCT**: pack the whole message via `Message::packed()` and append to the current segment.
- **TM_REQUEST** with VALUE = `"GET <seg> <offset> <length>"`: read synchronously, build TM_RESPONSE with `TO=$message[FROM]`, fill into sink.

**Class-API contract** (net-new constraint vs Tachikoma):

`new Partition()` and `new Topic()` MUST be safe to call from request-scope code without an EventFramework running. Specifically:

- No `set_timer` from constructor (silent leak: registers in EventFramework, never fires).
- No `Core::node()` lookup during construct.
- No `scandir` in constructor (eager scandir × N partitions × every request burns syscalls).
- No `$this->name()` from constructor (CommandInterpreter's `make_node` owns naming).
- File handles open lazily on first `write()` / `fill()` / `read_at()`.

**`hash_to_partition`** is the canonical partition-routing function:

```php
public static function hash_to_partition( string $key, int $num_partitions ): int {
    [ $stripped ] = explode( '?', $key, 2 );             // strip query string
    return ( crc32( $stripped ) & 0x7FFFFFFF ) % $num_partitions;  // 31-bit mask
}
```

Topic, JobIntake-keyed mode, and any other partition routing MUST call this same function. Diverging hash families across producers means the same key routes to different partitions and breaks ordering.

**AND-gated retention**: `cleanup_segments` deletes a segment only when BOTH `count > num_segments` AND `(now - mtime) >= max_lifespan`. Low-traffic partitions may retain segments for days — documented behavior, not a bug.

**`SEGMENT_CACHE_TTL = 0.25` seconds**: segment-list cache so back-to-back reads don't `scandir` per call. Readers may see stale segment lists for up to 250ms after rotation. Consumer's checkpoint logic must tolerate this.

**`MAX_LINE_SIZE = 4096`** (PIPE_BUF) for default writes. `allow_large_writes()` lifts to `MAX_LARGE_LINE_SIZE = 10485760` (10MB) AND constructs a Lock at `{partition_dir}/write.lock.d/`. Every write under `allow_large_writes` flows through `with_lock()`. Single-writer logs (jobs.log, requests.log) and >4KB payloads (SettingsSync, large job payloads) lose data silently without the opt-out.

### Topic

Multi-Partition wrapper. Hashes KEY to partition, falls back to round-robin when KEY is empty.

```php
$t = new Topic( $base_dir, $num_partitions, $segment_size, $num_segments, $max_lifespan );
$t->write( $key, $value );
$t->fill( $message );    // KEY -> partition; TM_REQUEST GET_PARTITIONS supported
```

Three precedences in `fill()`:

1. **TO field already set** — caller pre-pinned. Topic parses `p\d+` from TO and uses it directly. Used by replay tools and JobIntake's "pinned" mode.
2. **KEY present** — `Partition::hash_to_partition($key, $num_partitions)`.
3. **No KEY** — round-robin via static counter modulo `PHP_INT_MAX`.

**`READY` event** is pre-declared and fired (`set_state`) after the first Partition is materialized. Late registrants get the cached payload immediately.

**No `RESET` event** — real Tachikoma fires RESET when the broker's partition map changes; our partitions are local directories that don't move. Pre-declaring an event you'll never fire is a foot-gun for downstream registrants.

**No batching in v1.** LogManager already batches at PIPE_BUF granularity (one `flush_buffer()` per ~4KB of accumulated output). Tachikoma's 64KB/250ms Topic batching would be redundant and adds ~917 lines of state-machine code we don't need yet.

### Offsetlog

Just another Partition under `offsets/{reader_name}/p0/`. Consumer writes JSONL commits on each checkpoint; on restart, Consumer reads the last commit. No special class.

## Consumer + Tail

**Consumer** generalizes existing `LogReader`. Tails a Partition; commits cursor `{seg, off, ts}` to its offsetlog (which is itself a single-partition Partition). On restart, reads the newest offsetlog entry to seed the cursor.

```php
$c = new Consumer( $source_base_dir, $source_partition, $offsetlog_base_dir );
$c->poll();         // read new bytes, emit TM_BYTESTREAM per line, advance cursor
$c->checkpoint();   // append {seg, off, ts} JSONL to offsetlog
```

`poll()` reads new bytes since the last cursor position, splits by `\n`, drops the trailing partial, emits one TM_BYTESTREAM per complete line. KEY = `"{seg}:{offset}"` so the offsetlog can checkpoint by segment+offset.

**Tail** is the file-following primitive (no offsetlog, no Partition awareness — just a plain file). Three buffer modes:

- `binary` — chunk per message (one TM_BYTESTREAM per `fread`).
- `block-buffered` — newline-delimited contiguous block as one message (throughput optimization).
- `line-buffered` (default) — one message per line. Plugs straight into JSONL parsers.

`READ_CHUNK = 65536` per `fread`; lines >65KB accumulate in `line_remainder` across reads. PIPE_BUF (4096) only matters for *writers*.

Inode + size-shrink rotation detection on every poll (`clearstatcache(true, $path)` first). On rotation: reset position to 0, clear remainder.

**Two internal Timers** in the v1-final version: `poll_timer` (file polling, 10ms) and `reattempt_timer` (on_ENOENT retry). Currently the prototype runs both inline in `fire_cb`; splitting them is on the polish list.

## Backpressure (none)

Tachikoma's TM_PERSIST / `answer()` / `cancel()` / `max_unanswered` machinery was removed early on. Synchronous I/O at every boundary serializes the whole graph onto one CPU: LogManager's `Topic::fill` blocks on Partition's `fwrite`; Consumer's `fire_cb` blocks on `read_at`; StreamMerger's curl reads come in at network pace. There's no decoupled queue between producer and consumer that could grow — each step finishes (commits to disk or returns) before the next message is accepted. The producers we care about (LogManager, RequestBuilder, FlameBuilder, JobIntake) are all fire-and-forget.

If you need slot-based flow control somewhere specific in the future, build it at that producer. Don't reintroduce a global persist contract — it's all dead weight given how the I/O model works.

## TO=FROM Convention

Forward direction uses `TO=$this->target` (the path `connect_node` put there). Reverse direction (any kind of response, ack, or error) uses `TO=$message[FROM]`. One rule, applied uniformly:

| Direction | Sender | TO field |
|-----------|--------|----------|
| Forward | Producer / forwarder pass-through | `$this->target` |
| Reverse | Forwarder dropping / terminal acking | `$message[FROM]` |
| Reverse | TM_REQUEST handler responding | `$message[FROM]` |
| Reverse | CommandInterpreter responding to TM_COMMAND | `$message[FROM]` |
| Reverse | Tee aggregating persist responses | original sender's FROM |

Path-based routing via `_router` does the rest. Nodes don't track sockets or addresses; they just stamp FROM at I/O boundaries on the way in, and reverse direction follows the trail back out.

**FROM stamping at I/O boundaries**: Tail, Consumer, Job, Connector stamp FROM on the way in. Internal nodes (Tee, Hook, application Node subclasses) DO NOT stamp. A message flowing `firehose-in -> firehose-fanout -> request-builder` carries `FROM=firehose-in` at RequestBuilder, NOT `firehose-fanout/firehose-in`. Matches real Tachikoma exactly.

## EventFramework

Per-process drain-loop singleton. Manages reader/writer file descriptors, timers, cURL multi handles, and deferred-cleanup integration.

The merge layer is the most concrete net-new piece of the runtime design. Local file descriptors (Tail-style file polls, stdin, Partition file handles) are stream resources; `stream_select` works on them. cURL handles (used for HTTP/SSE clients in `StreamMerger`) hide their underlying socket FDs behind cURL's API; they have to be driven by `curl_multi_select` and `curl_multi_exec`.

Drain iteration:

```
1. Compute single timeout (next-fire time of soonest timer).
2. If any cURL multi handles registered:
     curl_multi_select($mh, $timeout)         # sleeps on cURL's internal sockets
     curl_multi_exec(...) until done           # drain ready transfers
     stream_select(timeout=0, non-blocking)    # poll local FDs that became ready
   Else:
     stream_select($timeout)                   # pure stream_select with timer-derived timeout
3. Process readable / writable FDs.
4. Process curl_multi_info_read events (CURLMSG_DONE for done handles).
5. Handle signals (SIGTERM / SIGINT -> Core::$shutting_down = true).
6. Run Core::run_closing() deferred-cleanup queue.
7. Fire expired timers.
8. Loop check (should_continue callback).
```

Deferred cleanup runs **inside** the loop (so node-removal callbacks fire while the loop is alive) AND **once more** after the loop terminates (because shutdown pushes additional cleanup callbacks during teardown that the now-stopped loop won't process). Mirrors real Tachikoma's `Router::drain` post-loop sweep.

Registration API:

```php
$ef->register_reader_node( $node );    // requires $node->stream resource
$ef->register_writer_node( $node );
$ef->set_timer( $node, $interval_ms, $oneshot = false );
$ef->stop_timer( $node );
$ef->register_curl_handle( $node, $multi_handle );
$ef->unregister_curl_handle( $node );
```

PHP I/O quirks the implementation handles:

- `fseek($fp, 0, SEEK_CUR)` before `ftell` — PHP's stdio caches position; without the no-op seek, `ftell` returns stale values after external appends.
- `clearstatcache(true, $path)` before every stat in poll loops — PHP caches stat results aggressively per request.
- `@stream_select` for EINTR — PHP emits "Interrupted system call" warnings; `@` suppresses; function returns false; re-loop.
- `stream_set_blocking($fh, false)` on every async filehandle — required for non-blocking reads/writes; forgetting silently blocks the loop.

## Worker Lifecycle

Each worker is a cron-style PHP process spawned via HTTP POST, going zombie via `ignore_user_abort(true) + fastcgi_finish_request()`. Lifetime ~595s (just under 10 min, sized for Atomic's 15-min cap with margin).

```php
// WorkerBase::execute()
if ( ! $this->acquire() ) return [ 'status' => 'skipped' ];
usleep( 250_000 );                              // grace: let predecessor exit
@set_time_limit( 0 );
register_shutdown_function( ... );              // catch exit() / die() bypass

try {
    $this->build_admin_scaffolding();
    $this->run_topology();
    EventFramework::drain( $this->should_continue );
} finally {
    $this->release();                           // release BEFORE spawn
    $this->self_respawn();                      // POST /spawn (fire-and-forget)
}
```

Lock release happens **before** the spawn POST inside `finally`. Because the spawn handler is fire-and-forget, the new worker reaches `acquire()` before this process has even fully exited; the slot is immediately free. No retry loop, no waiting.

`should_continue` returns false when:

- max_runtime (~595s) reached.
- memory ≥ 80% of `memory_limit` (PHP fatal-on-OOM bypasses `finally`; bail proactively).
- lock no longer ours OR `Lock::should_restart()` set.
- DB connection failed 3× consecutively (every 30s).

Periodic checks during drain:

- Every 250ms: lock check.
- Every 10s: heartbeat touch + DB ping.
- Every 30s: DB connection sanity (3 consecutive failures triggers restart).

The shutdown handler catches `exit()` / `die()` calls that bypass `finally`, releases the lock, and lets the supervisor respawn quickly.

**Memory watermark rationale**: `wp_generate_attachment_metadata` loads full-resolution images into GD; per-job residue accumulates; PHP's fatal-on-OOM is uncatchable and bypasses `finally` / `self_respawn` / offsetlog flush. 80% watermark lets workers exit cleanly before OOM.

## Supervisor Lifecycle

Long-running, ~595s. Same lifecycle pattern as workers, with `run()` doing supervisor-specific work:

```
loop every 1s for ~595s:
    refresh HMAC spawn token (10s window)
    every 15s: check_config (reload config, rebuild worker_locks from filters)
    for each registered worker:
        if !lock_dir OR heartbeat > worker.stale_timeout:
            if last_spawn for this worker > 15s ago:
                POST /spawn   (fire-and-forget)
    should_restart() check
release supervisor lock
POST /spawn supervisor   (fire-and-forget)
exit
```

**Spawn endpoint auth**: HMAC-protected token rotates every 10s, accepts current AND previous window for race tolerance.

```php
$window = (int) floor( $now / 10 );
$token  = hash_hmac( 'sha256', "newspack_nodes_spawn:{$window}", NONCE_SALT );
```

**Spawn rate limit**: `MIN_SPAWN_INTERVAL_S = 15` per `{type}|{partition}` key. Prevents thundering-herd respawns when locks flap. Updated after every spawn attempt — success or failure — so a failing-to-acquire worker doesn't get hammered.

**Worker-registry refresh**: plugin activation/deactivation changes which workers are registered via the `newspack_nodes/topologies` filter. The supervisor rebuilds worker descriptors from current filter values on every `check_config()` tick (every 15s), so newly-registered workers get spawned and deactivated workers get their locks released within one tick of the change.

**WP-Cron backstop**: `newspack_nodes/supervisor` action runs every minute. The handler instantiates and runs the supervisor only if topologies are registered. WP-Cron's only job: cold-start the supervisor when the self-respawn chain breaks. Steady state, the supervisor's own self-respawn keeps the chain alive — WP-Cron's tick finds a healthy supervisor lock and returns immediately.

**Two-tier safety net**:

- Workers self-respawn -> supervisor catches stale-locked workers (heartbeat > per-worker `stale_timeout`, force-releases, spawns fresh).
- Supervisor self-respawns -> WP-Cron catches a dead supervisor (cold start, `kill -9`, host outage).

Each tier only knows about the level immediately below. Clean separation; no cross-tier coupling.

## REPL: wp nodes cli

`wp nodes ls` — list live workers (group/partition, age, freshness) by reading lock directories.

`wp nodes cli` — open an interactive REPL. Two modes:

**Bare mode** (no `<reader>` arg) — local Tachikoma standalone, same shape as `bin/tachikoma`:

```
wp nodes cli
newspack-nodes> ls
newspack-nodes> dump_config
newspack-nodes> ^D
```

The local graph is built at REPL start:

```
_shell  ->  _command_interpreter  ->  _router  ->  _output
```

**Pivoted mode** (`wp nodes cli firehose-workers.p0`) — same local graph PLUS a `cmd-out` Partition writing to the worker's input IPC dir, and a `reply-in` Consumer reading from the worker's output IPC dir.

```
local _shell  ->  cmd-out (Partition, on-disk)  ->  worker input
worker output  ->  reply-in (Consumer, on-disk)  ->  local _output
```

IPC layout (always single-partition):

```
{base_dir}/ipc/{reader}/input/p0/{seg}.log     # shell -> worker
{base_dir}/ipc/{reader}/output/p0/{seg}.log    # worker -> shell
```

Reader id form: `{type}.p{N}`, e.g. `firehose-workers.p3`. Dot-and-`p` keeps it a single path segment — `firehose-workers/3` would route as "find node `firehose-workers`, pass remaining path `3`," which is wrong.

**No cryptographic handshake** — filesystem permissions on `/tmp/newspack-nodes/ipc/` gate access. Real Tachikoma's `pivot_client` is a CommandInterpreter builtin doing in-flight graph rewrites; we just `make_node` the IPC pair directly and pass the worker name.

**Wire / dispatch specifics**:

- **IPC messages use TM_COMMAND**: replies route via the FROM/TO breadcrumb — Shell stamps FROM=`_output/$pid`, the worker's CommandInterpreter sets TO=$message[FROM] when responding, and Router dispatches the reply by name. No ID-correlation table; the path itself is the addressing.
- **`Command` struct in VALUE for TM_COMMAND**: JSON-encoded `{name, arguments, payload}`. No `signature` field — single-host filesystem-gated IPC; signing is dead weight.
- **TO at root prompt is empty.** CommandInterpreter's `interpret` branch requires empty TO; non-empty TO routes through Router as a normal addressed message.
- **`prompt` reply intercept**: `cd` / `pwd` send a TM_COMMAND with `name=prompt`; Dumper's `dump_response` checks `name === 'prompt'` BEFORE the print path and stores the payload in `$shell->prompt` for the next readline turn.

**Shell** is a subset of real Tachikoma's `Shell3.pm`: quote-aware tokenization (single, double, backtick), single-tier `<varname>` interpolation, backslash line-continuation, and an `include` builtin. Conditionals, loops, function definitions, pipes, and `eval` all reject with "syntax not supported in v1". Quote-aware tokenization + line-continuation are *required* for `include topology.tch foo=bar` to parse real topology files.

**Dumper** dispatches by TYPE flag: TM_COMMAND|TM_RESPONSE -> unwrap Command JSON, print payload; TM_ERROR -> "ERROR: ..." to stderr; TM_INFO -> "INFO[from]: ..." to stdout (with prompt-aware async write that wipes-and-redraws if a prompt is on screen and stdout is a TTY).

**Multi-session via FROM-trail**: each cli stamps `FROM=$pid` (its wp-cli process PID). The worker's input-Consumer prepends `_repl`, so by the time the interpreter sees the message, `FROM=_repl/$pid`. Replies follow `TO=$message[FROM]`, carrying `TO=_repl/$pid`. The worker's `_router` splits TO on `/`, looks up `_repl` (a Partition), updates TO to `$pid` (the post-strip remainder). All cli sessions read the output Partition; each cli's Dumper filters: render iff TO matches its own `$pid`, OR TO is empty (async broadcasts). No lock, no EBUSY; concurrent shells just work.

## Substrate Lifecycle Events vs WordPress Hooks

Two distinct extensibility mechanisms, both first-class:

| Mechanism | Scope | Use |
|-----------|-------|-----|
| `register` / `notify` / `set_state` on Node | Per-node-instance. Events are pre-declared in the subclass constructor (e.g., `$this->registrations['FIRE'] = []`); listeners can only register for declared events. Late subscribers get the cached `set_state` payload immediately at registration time. Multi-modal listener dispatch (closure / shell callback / Node name -> fill TM_INFO). | Substrate-internal lifecycle: Topic `READY`, FileHandle `EOF`, Timer `FIRE`, Consumer position notifications. Per-instance, events as a contract surface. |
| WordPress hooks via `Hook` node | Global by name. Anyone can `add_action` / `apply_filters`; no pre-declaration. No payload cache. | Plugin extensibility points. Transformation filters, observation listeners, "let other plugins react to this." |

Common substrate events: Topic `READY`, FileHandle/Tail `EOF`, Timer `FIRE`, Consumer position notifications. Subclasses pre-declare what they emit; listeners register against the declared channels. `register()` throws on undeclared events — that's the contract surface.

**Multi-modal listener dispatch.** A registered listener identity is one of two things:

1. **Function/closure ref** — invoked directly with payload. Falsy return removes the registration (single-shot pattern).
2. **Node name** — fill a TM_INFO message into the named node with KEY=event, VALUE=payload. Missing node -> log via `print_less_often` ("WARNING: <name> forgot to unregister") and remove the registration.

`Hook` node is the WordPress-side bridge: action mode forwards the message unchanged after firing `do_action`; filter mode passes the message through `apply_filters` and forwards the result. Plugins observe completed requests, transform job payloads before routing, etc., without touching topology files.

## See also

- [AGENTS.md](AGENTS.md) — substrate contracts and invariants (anchored in real bugs).
- [API.md](API.md) — REST endpoint reference.
- [Spec](../../../.specs/2026-05-06-newspack-nodes-design.md) — canonical design document with full rationale.
