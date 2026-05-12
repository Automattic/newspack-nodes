# Newspack Nodes Architecture

Node-graph runtime for PHP. This document describes the substrate; application-level shape lives in the consuming plugin's own ARCHITECTURE.md.

## Table of Contents

- [Overview](#overview)
- [Message Format](#message-format)
- [Node Base Contract](#node-base-contract)
- [Router](#router)
- [Storage: Topic + Partition](#storage-topic--partition)
- [Consumer + Tail](#consumer--tail)
- [Other Node Primitives](#other-node-primitives)
- [Backpressure (none)](#backpressure-none)
- [TO=FROM Convention](#tofrom-convention)
- [EventFramework](#eventframework)
- [Worker Lifecycle](#worker-lifecycle)
- [Supervisor Lifecycle](#supervisor-lifecycle)
- [Lock](#lock)
- [REPL: wp nodes cli](#repl-wp-nodes-cli)
- [Substrate Lifecycle Events vs WordPress Hooks](#substrate-lifecycle-events-vs-wordpress-hooks)

## Overview

Three core ideas:

1. **Nodes** — processing units. Every node has `fill( array &$message )` as its only entry point.
2. **Messages** — 7-field arrays carrying a type bitmask, a routable path (TO/FROM), an ID, a KEY, and a VALUE.
3. **Drain loop** — EventFramework picks the soonest pending timer's deadline as its wait timeout, then sleeps on `curl_multi_select` (when cURL handles are registered) or `usleep` (otherwise), fires expired timers, and runs deferred cleanup.

```
+-----------------------------------------------------------+
|                      EventFramework                       |
|  drain():                                                 |
|   - compute timeout = next-timer deadline                 |
|   - if cURL handles: curl_multi_select(timeout) ->        |
|       drain transfers                                     |
|   - else:           usleep(timeout)                       |
|   - handle signals                                        |
|   - run Core::$closing deferred-cleanup queue             |
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

**Field layout rationale**: TIMESTAMP sits at index 1 so [WHAT + WHEN] groups at the front of the array. KEY/VALUE naming matches Kafka's `ProducerRecord<K,V>`, SQS message attributes, Redis Streams' `XADD key value`.

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

**Wire format**: `Message::packed( array $msg ): string` and `Message::unpacked( string $data ): array` round-trip via positional JSON — the in-memory indexed array is the wire representation, so there's no key-to-index translation per side. `unpacked` validates `array_is_list` + length ≥ 7 before returning; malformed input falls back to a fresh `new_message()`.

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
    protected $target;          // string for single target; array for Tee fan-out
    protected int $counter = 0;
    protected array $registrations = [];   // pre-declared events

    public function fill( array &$message ): void;
    public function sink( ?Node $node = null ): ?Node;
    public function target( $value = null );
    public function name( ?string $name = null ): string;
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

`Router` extends `Timer`. On each tick (default 5s), it fires `notify('TIMER', now)` — the **Router-hitchhike pattern** for cheap periodic work without per-node EventFramework slots.

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

`fill()` packs the whole message via `Message::packed()` and appends to the current segment. All TYPE flags pass through — Partition is a generic transport including for control messages (TM_REQUEST, TM_ERROR, TM_EOF). The pivoted-cli IPC pattern relies on this: cli ↔ worker round-trips drain markers (TM_EOF), error responses (TM_COMMAND|TM_ERROR), and introspection requests (TM_REQUEST) through Partition-as-bus. Data partitions like firehose.log only ever see TM_BYTESTREAM / TM_STRUCT in practice, so the broader contract is a no-op for production paths.

**Class-API contract**:

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

Topic and any other partition router MUST call this same function. Diverging hash families across producers means the same key routes to different partitions and breaks ordering.

**AND-gated retention**: `cleanup_segments` deletes a segment only when BOTH `count > num_segments` AND `(now - mtime) >= max_lifespan`. Low-traffic partitions may retain segments for days — documented behavior, not a bug.

**`SEGMENT_CACHE_TTL = 0.25` seconds**: segment-list cache so back-to-back reads don't `scandir` per call. Readers may see stale segment lists for up to 250ms after rotation. Consumer's checkpoint logic must tolerate this.

**`MAX_LINE_SIZE = 4096`** (PIPE_BUF) for default writes. `allow_large_writes()` lifts to `MAX_LARGE_LINE_SIZE = 10485760` (10MB) AND constructs a Lock at `{partition_dir}/write.lock.d/`. Every write under `allow_large_writes` flows through `with_lock()`. Single-writer partitions and >4KB payloads lose data silently without the opt-out.

**Per-partition batching.** `fill()` packs the message and appends it to an in-memory `$batch` string. If adding the new packed bytes would push the batch over `MAX_LINE_SIZE` (4KB), the existing batch flushes FIRST and the new message starts a fresh batch — preserving PIPE_BUF atomicity per syswrite. Each batched `fill()` also arms a 0-delay one-shot timer via `set_timer(0, oneshot)`; when the event loop finishes the current iteration, `fire_cb()` calls `flush()` to land whatever's still accumulated.

Messages larger than 4KB (only reachable on `allow_large_writes` partitions) bypass the batch entirely — they're already over PIPE_BUF so batching can't shrink them, and the lock around large writes serializes them with batched small-message flushes.

`Topic::flush()` walks every materialized Partition and calls `Partition::flush()` on each. Callers handing off to a subprocess that writes to the same partition path use this to land pending writes before forking, so the parent's accumulated messages land on disk in source-order with the child's appends.

### Topic

Multi-Partition wrapper. Hashes KEY to partition, falls back to round-robin when KEY is empty.

```php
$t = new Topic( $base_dir, $num_partitions, $segment_size, $num_segments, $max_lifespan );
$t->write( $key, $value );
$t->fill( $message );    // KEY -> partition routing
```

Three precedences in `fill()`:

1. **TO field already set** — caller pre-pinned. Topic parses `p\d+` from TO and uses it directly. Used by replay tools and any producer that needs to write a specific partition.
2. **KEY present** — `Partition::hash_to_partition($key, $num_partitions)`.
3. **No KEY** — round-robin via static counter modulo `PHP_INT_MAX`.

**`READY` event** is pre-declared and fired (`set_state`) after the first Partition is materialized. Late registrants get the cached payload immediately.

**No `RESET` event** — our partitions are local directories that don't move at runtime, so there's no partition-map mutation to signal. Pre-declaring an event you'll never fire is a foot-gun for downstream registrants.

**No Topic-level batching.** Per-partition batching happens INSIDE `Partition::fill()` itself — see the Partition section above. Topic is a pure router on top, so a single message routed to a partition lands in that partition's `$batch` and follows the partition's flush rules (size threshold + 0-delay one-shot timer).

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

**Single timer-driven poll**: Tail extends Timer; each `fire()` polls the file, emits per buffer mode, and re-arms with `set_timer(0, true)` when there are still bytes to drain or `set_timer(100, true)` at EOF (idle backoff). A missing file just no-ops the poll and re-arms on the idle cadence.

## Other Node Primitives

**Tee** is the fan-out node. Targets are an array; per-target try/catch isolates a failing target from the rest of the broadcast, and dead targets are pruned at fill-time after the first failed dispatch.

**Hook** is the WordPress-extensibility bridge. Action mode forwards the message unchanged after firing `do_action`; filter mode passes the message through `apply_filters` and forwards the result. Plugins observe completed requests, transform job payloads before routing, etc., without touching topology files.

**Callback** is the closure-as-Node adapter — a one-line `fill()` that invokes a stored closure. Useful for inline transforms in tests and small topology stitches without writing a whole subclass.

**Echo** is a routing helper that re-addresses messages on the way through. Both `target` and `TO` set → `TO = target/TO` (path-prepend). Both empty → `TO = FROM` (return-to-sender along the trail). Otherwise TO is unchanged. TM_ERROR with empty TO is dropped rather than bounced (the producer isn't expecting the error trail).

**Log** is the file-writer counterpart to Tail. Constructor: `(string $filename, string $mode = 'append', int $max_size = 0, int $max_rotations = 0)`. `fill()` writes the message VALUE (not the packed envelope) to the file — designed for human-readable structured-text logs (audit trails, application logs) where the on-disk shape is the producer's payload. `max_size > 0` triggers auto-rotation after the write that crossed the threshold; `max_rotations > 0` mtime-prunes older rotated siblings (sibling discovery uses `glob({filename}-*)`, so the prefix is reserved). Overwrite mode is single-shot: the node `remove_node`s itself on TM_EOF; append mode keeps the FD open for additional data. A TM_REQUEST with VALUE starting `rotate` triggers rotation on demand.

**Timer** (and its subclass **Router**) is the time-driven base. `set_timer( $interval_ms, $oneshot )` registers with EventFramework; `fire_cb` is the EventFramework-side hook; `fire()` is the override point for subclasses. Default `fire()` emits a TM_BYTESTREAM with the current timestamp at `target` and notifies `FIRE` listeners.

## Backpressure (none)

There's no graph-wide ack/retry machinery. Synchronous I/O at every boundary serializes the whole graph onto one CPU: `Topic::fill` blocks on `Partition`'s `fwrite`; `Consumer::fire_cb` blocks on `read_at`; network-driven nodes pace at the network's speed. There's no decoupled queue between producer and consumer that could grow — each step finishes (commits to disk or returns) before the next message is accepted. All substrate-provided producers are fire-and-forget.

If an application needs slot-based flow control somewhere specific, build it at that producer. Don't add a graph-wide ack contract at the substrate — given how the I/O model works, it'd be dead weight.

## TO=FROM Convention

Forward direction uses `TO=$this->target` (the path `connect_node` put there). Reverse direction (any kind of response, ack, or error) uses `TO=$message[FROM]`. One rule, applied uniformly:

| Direction | Sender | TO field |
|-----------|--------|----------|
| Forward | Producer / forwarder pass-through | `$this->target` |
| Reverse | Forwarder dropping / terminal acking | `$message[FROM]` |
| Reverse | TM_REQUEST handler responding | `$message[FROM]` |
| Reverse | CommandInterpreter responding to TM_COMMAND | `$message[FROM]` |

Path-based routing via `_router` does the rest. Nodes don't track sockets or addresses; they just stamp FROM at I/O boundaries on the way in, and reverse direction follows the trail back out.

**FROM stamping at I/O boundaries only**: Tail, Consumer, Job, Connector stamp FROM on the way in. Internal nodes (Tee, Hook, and any application Node subclass) do NOT stamp. A message flowing `tail -> tee -> consumer` carries `FROM=tail` at consumer, NOT `tee/tail`.

## EventFramework

Per-process drain-loop singleton. Manages timers, cURL multi handles, and deferred-cleanup integration. There is no FD-registration path: local file polling (Tail, Consumer, the cli's stdin reader) is driven by `set_timer`, so the loop always has exactly one blocking waiter regardless of which I/O sources are active.

cURL handles (used for HTTP/SSE clients) hide their underlying socket FDs behind cURL's API and have to be driven by `curl_multi_select` and `curl_multi_exec`. When at least one is registered, the loop sleeps on `curl_multi_select` (timeout = next-fire deadline); otherwise it sleeps in `usleep` for the same duration. Either way a soon-firing timer wakes the wait promptly.

Drain iteration:

```
1. Compute timeout_us = microseconds until soonest pending timer (or
   IDLE_TIMEOUT_US = 100_000 if no timers).
2. If any cURL multi handles registered:
     curl_multi_select($mh, $timeout_us / 1e6)  # sleeps on cURL's internal sockets
     drain_curl_multi()                         # curl_multi_exec + curl_multi_info_read
   Else if $timeout_us > 0:
     usleep($timeout_us)
3. pcntl_signal_dispatch() if pcntl available (SIGTERM/SIGINT -> Core::$shutting_down).
4. Drain Core::$closing deferred-cleanup queue.
5. Refresh Core::$now.
6. Fire any timers whose next_fire <= Core::$now (oneshot timers unregister
   themselves; recurring timers re-schedule).
7. should_continue() check; break on false or on Core::$shutting_down.
```

Deferred cleanup runs **inside** the loop (so node-removal callbacks fire while the loop is alive) AND **once more** after the loop terminates (because shutdown pushes additional cleanup callbacks during teardown that the now-stopped loop won't process).

Registration API:

```php
$ef->set_timer( $node, $interval_ms, $oneshot = false );
$ef->stop_timer( $node );
$ef->register_curl_handle( $node, $multi_handle );
$ef->unregister_curl_handle( $node );
$ef->install_signal_handlers();   // SIGTERM/SIGINT -> Core::$shutting_down
$ef->is_running(): bool;           // true while inside drain()
```

PHP I/O quirks the implementation handles:

- `fseek($fp, 0, SEEK_CUR)` before `ftell` — PHP's stdio caches position; without the no-op seek, `ftell` returns stale values after external appends.
- `clearstatcache(true, $path)` before every stat in poll loops — PHP caches stat results aggressively per request.

## Lock

Mkdir-based advisory locking with a PID-stamped heartbeat file. Used by workers, the supervisor, and `Partition::allow_large_writes()`. Atomic on every filesystem we ship on (NFS, tmpfs, ext4 — `mkdir(2)` is the POSIX-mandated atomic primitive). No `flock`, no daemon, no DB row.

```php
class Lock extends Node {
    public const STALE_TIMEOUT  = 60;          // seconds without heartbeat → stale, eligible for takeover
    public const HEARTBEAT_FILE = 'heartbeat';

    public function acquire( int $max_wait_ms = 0 ): bool;
    public function release(): void;
    public function heartbeat(): bool;          // verify_ownership() + touch
    public function verify_ownership(): bool;   // read PID from heartbeat, compare to getmypid()
    public function is_held(): bool;
    public function force_release(): bool;
}
```

**Acquire**:

```
mkdir $lock_path/   // atomic; returns false if already exists
  └─ if false:
      stat $lock_path/heartbeat
      if mtime > STALE_TIMEOUT seconds old:
          force_release()  // unlink heartbeat, rmdir
          retry mkdir
      else:
          give up (return false) or wait if $max_wait_ms > 0

file_put_contents $lock_path/heartbeat ← getmypid()
```

**Heartbeat**: workers touch their lock's heartbeat file every 10s during drain. The supervisor's stale-takeover check reads `mtime` only — never the file's contents during normal scans, so a busy supervisor doesn't pay PID-comparison costs on every tick. PID comparison happens on `verify_ownership()` (called from `heartbeat()` before the touch, and from `Partition::fill()` before every large write under `allow_large_writes`).

**Stale takeover**: if `STALE_TIMEOUT` (60s default) elapses without a heartbeat refresh, the lock is considered stale and another acquirer is free to `force_release()` it and take over. The previous holder's `getmypid()` no longer matches the heartbeat file → `verify_ownership()` flips local `is_held=false` → the displaced holder fails its next heartbeat and exits. This is the supervisor's main job for workers (catching crashed or wedged workers and respawning their replacement); it's also how multiple `wp nodes restart` invocations don't fight over slots.

**`should_restart()` / `request_restart()`**: writes `$lock_path/restart` as a sentinel. Workers check `Lock::should_restart()` on every drain tick and exit cleanly when set. Used by the admin `wp nodes restart` verb, by application code after a config change requiring a worker bounce, and by the supervisor's deactivation cleanup. The sentinel file is consumed (unlinked) by the next acquirer. Static form `Lock::request_restart_at( $lock_dir )` lets callers signal restart without holding a `Lock` instance — useful from admin request scope where the worker's `Lock` object lives in a different process.

## Worker Lifecycle

Each worker is a cron-style PHP process spawned via HTTP POST, going zombie via `ignore_user_abort(true) + fastcgi_finish_request()`. Lifetime ~595s (just under 10 min, sized for Atomic's 15-min cap with margin).

```php
// WorkerBase::execute( callable $topology, string $spawn_url, string $token )
if ( ! $this->acquire() ) return [ 'status' => 'skipped', 'reason' => 'lock_held' ];

register_shutdown_function( /* cleanup_all_nodes + release + self_respawn */ );
usleep( LOCK_CHECK_GRACE_S * 1e6 );             // 250ms grace: let predecessor exit

try {
    $ci = $this->build_scaffolding();
    $this->run_topology( $topology, $ci );
    $ef = EventFramework::instance();
    $ef->install_signal_handlers();
    $ef->drain( fn () => $this->should_continue() );
} finally {
    Core::cleanup_all_nodes();                  // tear down Partitions -> release write_locks
    $this->release();                           // release BEFORE spawn
    $this->self_respawn( $spawn_url, $token );  // POST /spawn (fire-and-forget)
}
```

Lock release happens **before** the spawn POST inside `finally`. Because the spawn handler is fire-and-forget, the new worker reaches `acquire()` before this process has even fully exited; the slot is immediately free. No retry loop, no waiting.

The `register_shutdown_function` + `finally` block both check `$this->shutdown_handled` so a clean `exit()` doesn't double-run the cleanup; whichever path fires first wins.

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

**Bare mode** (no `<reader>` arg) — runs a self-contained graph in the current process:

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

**No cryptographic handshake** — filesystem permissions on `/tmp/newspack-nodes/ipc/` gate access. The cli `make_node`s the IPC pair (`cmd-out` Partition + `reply-in` Consumer) directly at startup and passes the worker name; no in-flight graph rewrite is needed.

**Wire / dispatch specifics**:

- **IPC messages use TM_COMMAND**: replies route via the FROM/TO breadcrumb — Shell stamps FROM=`_output/$pid`, the worker's CommandInterpreter sets TO=$message[FROM] when responding, and Router dispatches the reply by name. No ID-correlation table; the path itself is the addressing.
- **`Command` struct in VALUE for TM_COMMAND**: JSON-encoded `{name, arguments, payload}`. No `signature` field — single-host filesystem-gated IPC; signing is dead weight.
- **TO at root prompt is empty.** CommandInterpreter's `interpret` branch requires empty TO; non-empty TO routes through Router as a normal addressed message.
- **`prompt` reply intercept**: `cd` / `pwd` send a TM_COMMAND with `name=prompt`; Dumper's `dump_response` checks `name === 'prompt'` BEFORE the print path and stores the payload in `$shell->prompt` for the next readline turn.

**Shell** supports quote-aware tokenization (single, double, backtick), single-tier `<varname>` interpolation, backslash line-continuation, and an `include` builtin. Conditionals, loops, function definitions, pipes, and `eval` all reject with "syntax not supported in v1". Quote-aware tokenization + line-continuation are *required* for `include topology.tch foo=bar` to parse topology files.

Shell also intercepts the **path-composing builtins** before they reach the message bus: `cd`/`chdir` updates `$this->path` (the cwd that prepends to any subsequent `<path>` arg via `prefix()`); `tell_node`/`tell` (TM_INFO), `send_node`/`send` (TM_BYTESTREAM), `send_eof` (TM_EOF), `command_node`/`command`/`cmd` (TM_COMMAND), `request_node`/`request` (TM_REQUEST), `pwd`, and `ping` all build their TO via `prefix( <path> )` so the cwd composes uniformly. Verbs that don't match a builtin fall through as TM_COMMAND with the verb as the command name and TO = `prefix('')` (i.e., the cwd itself).

**CommandInterpreter** dispatches by verb. Aliases share the same `cmd_foo` static; e.g. `make` → `cmd_make_node`, `rm`/`remove` → `cmd_remove_node`, `dump` → `cmd_dump_node`, `ls` → `cmd_list_nodes`. CI handles a TM_COMMAND only when TO is empty — non-empty TO means the command is mid-route toward a downstream node, so CI forwards to its sink (Router). Verbs may throw freely; `interpret()` catches `\Throwable` and turns the response into `TM_COMMAND|TM_ERROR` addressed back along FROM. CI also bounces TM_PING and TM_EOF with empty TO back along FROM — the latter is the cli's stdin-close drain marker (cli emits TM_EOF when stdin EOFs, waits for the bounce so all preceding output has been drained off the reply partition before the cli exits).

Constructors of registered Node classes (Topic, Partition, Consumer, Tail, Log, etc.) populate `$this->arguments` — a string of space-joined ctor args — directly. `dump_config()` reads that to emit a round-trippable `make_node <type> <name> <args...>` line; `make_node` round-trips via the same ctor. No separate `dump_config()` override per class.

**Dumper** dispatches by TYPE flag: TM_COMMAND|TM_RESPONSE -> unwrap Command JSON, print payload; TM_COMMAND|TM_ERROR -> "ERROR: ..." to stderr (the wrapped exception path); TM_ERROR -> "ERROR: ..." to stderr; TM_INFO -> "INFO[from]: ..." to stdout (with prompt-aware async write that wipes-and-redraws if a prompt is on screen and stdout is a TTY).

**Multi-session via FROM-trail**: each cli stamps `FROM=_output/$pid` (its wp-cli process PID). The worker's input-Consumer prepends `_repl`, so by the time the interpreter sees the message, `FROM=_repl/_output/$pid`. Replies follow `TO=$message[FROM]`, carrying `TO=_repl/_output/$pid`. The worker's `_router` splits TO on `/`, looks up `_repl` (a Partition), updates TO to `_output/$pid` (the post-strip remainder) and writes the envelope to disk. The cli's local `_router` reads the entry, splits again, looks up `_output` (the cli's Dumper), and forwards with `TO=$pid`. All cli sessions read the output Partition; each cli's Dumper filters: render iff TO matches its own `$pid` (or the pre-peel form `_output/$pid`), OR TO is empty (async broadcasts). No lock, no EBUSY; concurrent shells just work.

## Substrate Lifecycle Events vs WordPress Hooks

Two distinct extensibility mechanisms, both first-class:

| Mechanism | Scope | Use |
|-----------|-------|-----|
| `register` / `notify` / `set_state` on Node | Per-node-instance. Events are pre-declared in the subclass constructor (e.g., `$this->registrations['FIRE'] = []`); listeners can only register for declared events. Late subscribers get the cached `set_state` payload immediately at registration time. Multi-modal listener dispatch (closure / shell callback / Node name -> fill TM_INFO). | Substrate-internal lifecycle: Topic `READY`, Timer `FIRE`, Router `TIMER` (the hitchhike channel Timer subclasses register against). Per-instance, events as a contract surface. |
| WordPress hooks via `Hook` node | Global by name. Anyone can `add_action` / `apply_filters`; no pre-declaration. No payload cache. | Plugin extensibility points. Transformation filters, observation listeners, "let other plugins react to this." |

Shipped substrate events in v0.1.0: Topic `READY` (set_state on first partition materialization), Timer `FIRE` (notify after each `fire()`), Router `TIMER` (notify on every Router tick — Timer subclasses hitchhike here to avoid per-node EventFramework slots). Subclasses pre-declare what they emit; listeners register against the declared channels. `register()` throws on undeclared events — that's the contract surface.

**Multi-modal listener dispatch.** A registered listener identity is one of two things:

1. **Function/closure ref** — invoked directly with payload. Falsy return removes the registration (single-shot pattern).
2. **Node name** — fill a TM_INFO message into the named node with KEY=event, VALUE=payload. Missing node -> log via `print_less_often` ("WARNING: <name> forgot to unregister") and remove the registration.

`Hook` node is the WordPress-side bridge: action mode forwards the message unchanged after firing `do_action`; filter mode passes the message through `apply_filters` and forwards the result. Plugins observe completed requests, transform job payloads before routing, etc., without touching topology files.

## See also

- [AGENTS.md](AGENTS.md) — substrate contracts and invariants (anchored in real bugs).
- [API.md](API.md) — REST endpoint reference.
