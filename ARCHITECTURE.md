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
- [Event_Framework](#event_framework)
- [Worker Lifecycle](#worker-lifecycle)
- [Supervisor Lifecycle](#supervisor-lifecycle)
- [Lock](#lock)
- [REPL: wp nodes cli](#repl-wp-nodes-cli)
- [Substrate Lifecycle Events vs WordPress Hooks](#substrate-lifecycle-events-vs-wordpress-hooks)

## Overview

Three core ideas:

1. **Nodes** — processing units. Every node has `fill( array &$message )` as its only entry point.
2. **Messages** — 7-field arrays carrying a type bitmask, a routable path (TO/FROM), an ID, a KEY, and a VALUE.
3. **Drain loop** — Event_Framework picks the soonest pending timer's deadline as its wait timeout, then sleeps on `curl_multi_select` (when cURL handles are registered) or `usleep` (otherwise), fires expired timers, and runs deferred cleanup.

```
┌───────────────────────────────────────────────────────────┐
│                      Event_Framework                       │
│  drain():                                                 │
│   - compute timeout = next-timer deadline                 │
│   - if cURL handles: curl_multi_select(timeout) ->        │
│       drain transfers                                     │
│   - else:           usleep(timeout)                       │
│   - handle signals                                        │
│   - run Core::$closing deferred-cleanup queue             │
│   - fire expired timers                                   │
│   - loop check (should_continue)                          │
└─────────────────────────┬─────────────────────────────────┘
                          │ on each tick
                          ▼
┌───────────────────────────────────────────────────────────┐
│                         Router                            │
│  fill($message):  (PHP — there is NO empty-TO short-cut)  │
│   - [head, rest] = explode("/", TO, 2)                    │
│   - TO = rest                                             │
│   - target = Core::node(head)                             │
│   - if !target: bounce NOT_AVAILABLE (TM_ERROR) to FROM   │
│   - else:        target->fill($message)                   │
│   - fire() tick: notify("TIMER", now) + Core::prune_logs()│
└─────────────────────────┬─────────────────────────────────┘
                          │ fill($message)
                          ▼
┌───────────────────────────────────────────────────────────┐
│                       Node graph                          │
│   ┌────┐    ┌────┐    ┌────┐                              │
│   │ A  │ ──>│ B  │ ──>│ C  │ ──> [terminal]               │
│   └────┘    └────┘    └────┘                              │
│              fan─out via Tee:                             │
│             ┌────┐    ┌────┐                              │
│             │Tee │ ──>│ X  │                              │
│             └────┘    └────┘                              │
│                 │     ┌────┐                              │
│                 └────>│ Y  │                              │
│                       └────┘                              │
└───────────────────────────────────────────────────────────┘
```
─

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
TM_BYTESTREAM = 1;
TM_EOF        = 2;
TM_PING       = 4;
TM_COMMAND    = 8;
TM_STRUCT     = 16;
TM_ERROR      = 32;
TM_INFO       = 64;
TM_REQUEST    = 128;
TM_RESPONSE   = 256;
```

Flags compose via bitwise OR: `TM_COMMAND | TM_RESPONSE` = a response to a command. Receivers check via `&`: `if ( $type & TM_COMMAND ) { ... }`. **Never use strict `===`** on combined flags — it misses every combination.

**ONE shape, everywhere**: the positional indexed array IS the message — in PHP, in JS (`src/runtime/message.js` exports the same indices/flags), in memory, and on the wire. There is **no** `{ type, ts, from, to, id, key, value }` object form anywhere; if you see one it's a bug.

**Wire format**: `Message::packed( array $msg ): string` is `wp_json_encode` of the array; `Message::unpacked( string $data ): array` is `json_decode`. The in-memory indexed array is the wire representation, so there's no key-to-index translation per side. The two ports differ on malformed input — a documented divergence:

- **PHP** `unpacked()` accepts ONLY `count() === 7 && array_is_list()`. Anything else **throws** `InvalidArgumentException`. Callers that read off-disk lines (`Consumer::poll`, `Consumer::load_offsetlog`) catch it and skip the bad line.
- **JS** `unpack()` accepts `Array.isArray && length >= 7` and otherwise (including a JSON parse error) falls back to a fresh `newMessage()` — never throws.

**Message constructors**:

```php
$m = Message::new_message();
$m[ Message::TYPE ]  = Message::TM_BYTESTREAM;
$m[ Message::KEY ]   = '/some-url';
$m[ Message::VALUE ] = $line;
$node->fill( $m );
```

There is no parallel `write()` / `produce()` / `query()` API on any node — `fill()` is the only way a message enters a node.

## Node Base Contract

A node connects two ways: **`sink`** is the physical next node `fill()` forwards to; **`target`** is a logical path string stamped into `message[TO]` when TO is empty (this is Tachikoma's `owner`). **There is NO `edge`** — Tachikoma's second physical output was not ported; don't look for one.

```php
class Node {
    protected string $name = '';
    protected ?Node  $sink = null;
    protected $target = '';      // string for single target; array for Tee fan-out
    protected int $counter = 0;
    protected array $registrations = [];   // pre-declared events

    public function fill( array &$message ): void;
    public function sink( ?Node $node = null ): ?Node;
    public function target( $value = null );
    public function connect_node( string $target ): void;     // sets target (Tee appends)
    public function disconnect_node( string $target = '' ): void;
    public function name( ?string $name = null ): string;
    public function counter(): int;

    public function stamp_message( array &$message, string $name ): bool;
    public function drop_message( array &$message, string $error ): void;

    public function dump_node(): array;       // state snapshot for `dump_node` verb
    public function dump_config(): string;    // round-trippable make_node line

    public function register( string $event, string $listener, ?callable $cb = null ): void;
    public function unregister( string $event, string $listener ): void;
    public function notify( string $event, mixed $payload = null ): void;
    public function set_state( string $event, mixed $payload = null ): void;
}
```

**Default `fill()`** stamps TO from `target` (only when TO is empty), counts, then forwards:

```php
public function fill( array &$message ): void {
    if ( '' === $message[ Message::TO ] && \is_string( $this->target ) && '' !== $this->target ) {
        $message[ Message::TO ] = $this->target;
    }
    ++$this->counter;
    $this->sink?->fill( $message );
}
```

Subclasses override with their actual behavior. (Several primitives — Shell, Hook, Callback, Dumper, Tail's `emit_message` path — count-and-forward without the TO stamp; only the base `Node::fill` and the subclasses that call `parent::fill` apply it.)

**`stamp_message`** prepends `$name` to the message's FROM with a `/` separator:

```php
$message[ Message::FROM ] = $from === '' ? $name : ( $name . '/' . $from );
```

Returns false (drops) if FROM would exceed `MAX_FROM_SIZE = 1024` — prevents path explosion on cycles. Also drops if `$name` is empty (mid-construction or post-rename); logs via `print_less_often`.

**Name registration**: `$node->name('foo')` registers the node in `Core::$nodes_by_name`. Renaming throws on collision (catches duplicate-node bugs at construction time).

**Pre-declared events**: subclasses populate `$this->registrations[$event] = []` in their constructor for every event they intend to emit. `register()` throws on undeclared events — declared events are the publishing node's contract surface.

## Router

`Router` extends `Timer`. PHP's `fire()` notifies all TIMER registrants and calls `Core::prune_logs()` on each tick (default 5s) — the **Router-hitchhike pattern** for cheap periodic work without per-node Event_Framework slots. (The worker scaffolding arms this via `$router->set_timer( Router::DEFAULT_TICK_MS )`; without that the TIMER channel never fires.)

`Router::fill()` (PHP) peels the head segment unconditionally and dispatches:

```php
public function fill( array &$message ): void {
    ++$this->counter;
    [ $head, $rest ] = array_pad( explode( '/', $message[ Message::TO ], 2 ), 2, '' );
    $message[ Message::TO ] = $rest;
    if ( strlen( $message[ Message::FROM ] ?? '' ) > self::MAX_FROM_SIZE ) {
        $this->drop_message( $message, 'path exceeded ...' );
        return;
    }
    $target = Core::node( $head );
    if ( null === $target ) {
        $this->set_state( 'NOT_AVAILABLE', [ 'node' => $head, 'from' => $message[ Message::FROM ] ] );
        if ( $message[ Message::TYPE ] & Message::TM_ERROR ) {
            return;                       // don't bounce an error about an error
        }
        // build TM_ERROR (VALUE "NOT_AVAILABLE\n", TO=FROM, FROM=self) and re-fill via this Router
        return;
    }
    $target->fill( $message );
}
```

**Empty-TO divergence (PHP vs JS).** PHP has **no** empty-TO short-cut: `explode('/', '', 2)` yields `['', '']`, so `Core::node('')` returns null and an empty-TO message becomes a NOT_AVAILABLE bounce. **JS (`src/runtime/router.js`)** does the opposite — an empty TO forwards straight to `sink` and returns before any lookup. The JS behavior is arguably drift from the port's model; treat PHP as authoritative for routing semantics.

Routing is path-based (`a/b/c` → "find node `a`, pass remaining path `b/c`"), not socket-based. Replies use the `TO=$message[FROM]` convention to walk back along the breadcrumb trail. Both ports increment `counter` on the recursive NOT_AVAILABLE re-fill, so one inbound miss bumps the counter by 2 (intentional, matched across ports).

**First-300s NOT_AVAILABLE rule lives in `Node::drop_message`, not Router.** Router builds the NOT_AVAILABLE error inline (it does NOT call `drop_message` for that path; it only calls `drop_message` for the FROM-too-long case). The 300s rule applies wherever `drop_message` IS called: a NOT_AVAILABLE drop while `Core::$now < 300.0` logs via `print_least_often` (silences boot-race noise); otherwise `print_less_often`.

**TIMER hitchhike, both ports.** PHP's Router fires TIMER on its Event_Framework-driven tick. The JS Router (`src/runtime/router.js`) has no drain loop, so it fires TIMER from a `setInterval`: `startTimer( ms )` fires once immediately then every `ms`, and each `_tick()` calls `notify('TIMER', { now })`. The console arms it at one-second cadence and injects `beforeTimerNotify` / `afterTimerNotify` hooks that bracket the notify — locking `HttpOut` before and flushing after — so every emission a tick produces (each subscriber's poll) batches into ONE `/command` POST. `stopTimer()` clears the interval on teardown / edit-mode. This replaces the two independent `setInterval` polls the console used to run, eliminating the drift between the metadata and uptime polls.

**TIMER subscribers batch.** Both `_metadata` and `_uptime` register against the Router's TIMER channel rather than running their own intervals: `_metadata` emits a `dump_metadata` poll every tick; `_uptime` self-throttles to a 5s `uptime` poll. Because both fire inside the same locked tick, the 5s uptime poll always rides in the same POST as that tick's `dump_metadata`. The substrate Router stays decoupled from any console node — the lock/flush logic lives in the injected hooks, not the Router.

## Storage: Topic + Partition

### Partition

One file-segmented append-only log, plus a `.idx` companion. Storage primitive AND Node. Lift-adapt of event-logger's `Firehose`.

```php
$p = new Partition( $base_dir, $partition_id, $segment_size, $num_segments, $max_lifespan );
$p->fill( $message );                                   // ONLY ingress — no write()/produce()
$p->flush();                                            // land the in-memory batch now
$p->read_at( $segment_id, $offset, $length );           // read bytes
$p->scan_index( fn ( $line, $seg ) => ..., $newest_first );
$p->get_segments( $force_refresh );                     // [{id,size}, ...] sorted by id
$p->get_current_position();                             // ['segment_id'=>, 'offset'=>]
$p->allow_large_writes();                               // 4KB -> 10MB; acquires a Lock
$p->with_index( $formatter );                           // custom .idx line formatter
```

**There is NO `Partition::write()` method** — the only way bytes enter a Partition is `fill()`. (The doc once claimed a `write( $line )` class API; it does not exist and never did.) `fill()` packs the whole message via `Message::packed()` (+ `"\n"`) and appends to the current segment. All TYPE flags pass through — Partition is a generic transport including control messages (TM_REQUEST, TM_ERROR, TM_EOF). The pivoted-cli IPC pattern relies on this: cli ↔ worker round-trips drain markers (TM_EOF), error responses (TM_COMMAND|TM_ERROR), and introspection requests (TM_REQUEST) through Partition-as-bus. Data partitions like firehose.log only ever see TM_BYTESTREAM / TM_STRUCT in practice, so the broader contract is a no-op for production paths.

**Class-API contract**:

`new Partition()` and `new Topic()` MUST be safe to call from request-scope code without an Event_Framework running. Specifically:

- No `set_timer` from constructor (silent leak: registers in Event_Framework, never fires).
- No `Core::node()` lookup during construct.
- No `scandir` in constructor (eager scandir × N partitions × every request burns syscalls).
- No `$this->name()` from constructor (`Command_Interpreter_Node::make_node` owns naming).
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

**`MAX_LINE_SIZE = 4096`** (PIPE_BUF) caps default writes; the size check is on the FINAL packed bytes (envelope + `"\n"`), not VALUE alone. `allow_large_writes()` lifts to `MAX_LARGE_LINE_SIZE = 10485760` (10MB) AND acquires a `Lock` at `{partition_dir}/write.lock.d/` (blocking up to `max_wait_ms`, default 65s, so a respawn race recovers once the predecessor's heartbeat ages out). **There is NO `with_lock()` method** — the doc once claimed every large write "flows through `with_lock()`"; that wrapper does not exist. Instead the held Lock is kept fresh two ways: inside a running event loop a heartbeat `Timer` (`{name}:heartbeat`, KEY=`heartbeat`) sinks into the Lock and refreshes it; in request scope (no drain) `fill()` drives the heartbeat inline (at most once per `stale_timeout/3` s) and throws if `Lock::heartbeat()` reports the lock was stolen. Single-writer partitions writing >4KB payloads lose data silently (oversize drop) without the opt-out.

**Per-partition batching.** `fill()` packs the message and appends it to an in-memory `$batch` string. If adding the new packed bytes would push the batch over `MAX_LINE_SIZE` (4KB), the existing batch flushes FIRST and the new message starts a fresh batch — preserving PIPE_BUF atomicity per syswrite. Each batched `fill()` also arms a 0-delay one-shot timer via `set_timer(0, true)`; when the event-loop iteration finishes, `fire()` calls `flush()` to land whatever's still accumulated. `__destruct()` also flushes, so request-scope writes land before GC.

Messages larger than 4KB (only reachable on `allow_large_writes` partitions) bypass the batch entirely — they're already over PIPE_BUF so batching can't shrink them. The held write Lock serializes them with batched small-message flushes.

`Topic::flush()` walks every materialized Partition and calls `Partition::flush()` on each. Callers handing off to a subprocess that writes to the same partition path use this to land pending writes before forking, so the parent's accumulated messages land on disk in source-order with the child's appends.

### Topic

Multi-Partition wrapper. Hashes KEY to partition, falls back to round-robin when KEY is empty.

```php
$t = new Topic( $base_dir, $num_partitions, $segment_size, $num_segments, $max_lifespan );
$t->fill( $message );    // ONLY ingress — KEY -> partition routing; no write()
$t->flush();             // flush every materialized partition's batch
```

**There is NO `Topic::write()` method** — `fill()` is the only ingress (the old `write( $key, $value )` claim was fiction). Three precedences in `fill()`:

1. **TO field already set** — caller pre-pinned. Topic parses a leading `p\d+` out of TO and, if in range, routes there directly. Used by replay tools and any producer that needs a specific partition.
2. **KEY present** — `Partition::hash_to_partition($key, $num_partitions)`.
3. **No KEY** — round-robin via a static counter (`self::$rr_counter++ % $num_partitions`).

**`READY` event** is pre-declared and fired (`set_state`) after the first Partition is materialized. Late registrants get the cached payload immediately.

**No `RESET` event** — our partitions are local directories that don't move at runtime, so there's no partition-map mutation to signal. Pre-declaring an event you'll never fire is a foot-gun for downstream registrants.

**No Topic-level batching.** Per-partition batching happens INSIDE `Partition::fill()` itself — see the Partition section above. Topic is a pure router on top, so a single message routed to a partition lands in that partition's `$batch` and follows the partition's flush rules (size threshold + 0-delay one-shot timer).

### Offsetlog

Just another Partition under `offsets/{reader}/p0/`. Each checkpoint is a `TM_STRUCT` Message whose VALUE is `{seg, off, ts, name, target, targets, worker_type}`, routed through `Partition::fill` (so it lands as the canonical packed wire format, not raw JSONL) and `flush`ed immediately. On restart `load_offsetlog()` reads the newest segment's last line, `Message::unpacked`s it, and decodes VALUE to seed the cursor. An empty `$offsetlog_base_dir` disables the offsetlog entirely (ephemeral readers like the cli's `reply-in`). No special class.

## Consumer + Tail

**Consumer** generalizes existing `LogReader`. Tails a source Partition; commits cursor `{seg, off, ts, ...}` to its offsetlog (itself a single-partition Partition). On restart, reads the newest offsetlog entry to seed the cursor.

```php
$c = new Consumer( $source_base_dir, $source_partition, $offsetlog_base_dir = '' );
$c->next_offset( 'start' | 'recent' | 'end' | ['seg'=>, 'off'=>] );  // seek
$c->poll();         // read new bytes, re-emit each line's Message, advance cursor
$c->checkpoint();   // append a {seg, off, ts, ...} TM_STRUCT to offsetlog
```

`poll()` reads new bytes since the cursor, splits on `\n`, drops the trailing partial, and for each complete line `Message::unpacked`s it (Partition wrote a packed Message per line), stamps its own name onto FROM, and forwards via `parent::fill`. The position breadcrumb goes in **ID** as `"{seg}:{offset}"` — **NOT KEY**. The code comment is explicit: overwriting KEY would destroy the producer's partition-routing key (rid / handler) and silently break multi-partition queues and RequestBuilder's rid grouping. Corrupt/unparseable lines are skipped (cursor already advanced) rather than aborting the poll.

**Tail** is the file-following primitive (no offsetlog, no Partition awareness — just a plain file). Three buffer modes:

- `binary` — chunk per message (one TM_BYTESTREAM per `fread`).
- `block-buffered` — newline-delimited contiguous block as one message (throughput optimization).
- `line-buffered` (default) — one message per line. Plugs straight into JSONL parsers.

`READ_CHUNK = 65536` per `fread`; lines >65KB accumulate in `line_remainder` across reads. PIPE_BUF (4096) only matters for *writers*.

Inode + size-shrink rotation detection on every poll (`clearstatcache(true, $path)` first). On rotation: reset position to 0, clear remainder.

**Single timer-driven poll**: Tail extends Timer; each `fire()` polls the file, emits per buffer mode, and re-arms with `set_timer(0, true)` when there are still bytes to drain or `set_timer(100, true)` at EOF (idle backoff). A missing file just no-ops the poll and re-arms on the idle cadence.

## Other Node Primitives

**Tee** is the fan-out node. Targets are an array; each `fill()` snapshots a live-target list, copies the message per target with `TO=target`, and forwards through `sink` (typically `_router`) under a per-target try/catch that isolates one failing target from the rest. Pruning is by a liveness check on every fill, not "after a failed dispatch": a **bare-name** target (no `/`) whose node has disappeared is dropped; a **path-shaped** target (has a `/`, e.g. `_repl/_output/12345`) is always kept and handed to the sink to route. A `request <tee> GET_TARGETS` (TM_REQUEST) replies with the current list inline.

**Hook** is the WordPress-extensibility bridge. Action mode forwards the message unchanged after firing `do_action`; filter mode passes the message through `apply_filters` and forwards the result. Plugins observe completed requests, transform job payloads before routing, etc., without touching topology files.

**Callback** is the closure-as-Node adapter — a one-line `fill()` that invokes a stored closure. Useful for inline transforms in tests and small topology stitches without writing a whole subclass.

**Echo** is a routing helper that re-addresses messages on the way through. Both `target` and `TO` set → `TO = target/TO` (path-prepend). Both empty → `TO = FROM` (return-to-sender along the trail). Otherwise TO is unchanged. TM_ERROR with empty TO is dropped rather than bounced (the producer isn't expecting the error trail).

**Log** is the file-writer counterpart to Tail. Constructor: `(string $filename, string $mode = 'append', int $max_size = 0, int $max_rotations = 0)`. `fill()` writes the message VALUE (not the packed envelope) to the file — designed for human-readable structured-text logs (audit trails, application logs) where the on-disk shape is the producer's payload. `max_size > 0` triggers auto-rotation after the write that crossed the threshold; `max_rotations > 0` mtime-prunes older rotated siblings (sibling discovery uses `glob({filename}-*)`, so the prefix is reserved). Overwrite mode is single-shot: the node `remove_node`s itself on TM_EOF; append mode keeps the FD open for additional data. A TM_REQUEST with VALUE starting `rotate` triggers rotation on demand.

**Timer** (and its subclass **Router**) is the time-driven base. `set_timer( $interval_ms, $oneshot )` registers with Event_Framework; `fire_cb` is the Event_Framework-side hook; `fire()` is the override point for subclasses. Default `fire()` emits a TM_BYTESTREAM with the current timestamp at `target` and notifies `FIRE` listeners.

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
| Reverse | Command_Interpreter_Node responding to TM_COMMAND | `$message[FROM]` |

Path-based routing via `_router` does the rest. Nodes don't track sockets or addresses; they just stamp FROM at I/O boundaries on the way in, and reverse direction follows the trail back out.

**FROM stamping at I/O boundaries only**: the substrate's source nodes — **Tail** (`emit_message` sets FROM directly) and **Consumer** (`stamp_message`, using `stamp_override` when set — the worker IPC input Consumer stamps `_repl`) — stamp FROM as messages enter the graph. Internal nodes (Tee, Hook, and any application Node subclass) do NOT stamp. A message flowing `tail -> tee -> request-builder` carries `FROM=tail`, NOT `tee/tail`. (There are no `Job` / `Connector` node classes in this substrate; those Tachikoma concepts were not ported.)

## Event_Framework

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

Verified against `includes/class-lock.php`:

```php
class Lock extends Node {
    public const STALE_TIMEOUT  = 60;          // seconds without heartbeat → stale
    public const ORPHAN_GRACE_S = 1;           // dir-but-no-heartbeat grace before stealing
    public const HEARTBEAT_FILE = 'heartbeat'; // contains the holder's PID
    public const STARTED_FILE   = 'started';   // acquire() timestamp
    public const RESTART_FLAG   = 'restart';   // restart sentinel

    public function acquire( int $max_wait_ms = 0 ): bool;
    public function release(): void;
    public function heartbeat(): bool;            // verify_ownership() then touch
    public function verify_ownership(): bool;     // read PID, compare to getmypid(); flips is_held on mismatch
    public function is_held(): bool;
    public function force_release(): bool;        // INSTANCE: releases ONLY if heartbeat is stale/missing
    public function should_restart(): bool;       // restart flag present, OR heartbeat gone / PID-mismatch
    public function request_restart(): bool;      // drop the restart flag (caller need not hold the lock)
    public function clear_restart(): void;
    public function path(): string;

    public static function force_release_at( string $lock_dir ): void;   // UNCONDITIONAL clear
    public static function request_restart_at( string $lock_dir ): bool;
    public static function is_restart_pending( string $lock_dir ): bool;
    public static function get_started_time( string $lock_dir ): ?int;
}
```

Note the two distinct releases: instance `force_release()` is **conditional** (returns false and leaves the dir alone if the holder is still within `stale_timeout`); static `force_release_at()` is **unconditional** (unlinks heartbeat/started/restart, rmdir). PHP forbids same-name instance+static methods, hence the `_at` suffix on the statics.

**Acquire**: atomic `mkdir`. If the dir already exists, `try_steal_orphan_or_stale()` decides whether to take over — an *orphan* dir (no heartbeat file → possible mid-acquire) is honored for `ORPHAN_GRACE_S` then stolen if still empty; a *stale* dir (heartbeat mtime older than `stale_timeout`) is stolen immediately; otherwise back off, and either return false or retry every 100ms until `$max_wait_ms`. On success it writes the `heartbeat` (PID) + `started` (timestamp) files and clears any inherited `restart` flag.

**Heartbeat**: workers touch their heartbeat every 10s during drain. `heartbeat()` calls `verify_ownership()` first; if the on-disk PID no longer matches `getmypid()` (someone stale-stole us), it flips local `is_held=false` and returns false so `release()` becomes a no-op and the displaced holder stops writing. `Partition::fill()` calls `heartbeat()` inline on the no-event-loop large-write path.

**Stale takeover**: once `STALE_TIMEOUT` elapses without a refresh, the next acquirer steals the dir and the displaced holder fails its next heartbeat and exits. This is the supervisor's main job for workers, and it's how concurrent `wp nodes restart` invocations don't fight over slots.

**`should_restart()` / `request_restart()`**: writes `$lock_path/restart` as a sentinel. Workers poll `should_restart()` on every drain tick and exit cleanly when the flag is present **or** the heartbeat file is gone / its PID no longer matches (PID-content theft). The flag is cleared on the next acquire (`write_acquire_files` unlinks it) or via `clear_restart()`. Static `request_restart_at( $lock_dir )` lets a stranger (admin request, supervisor) signal restart into another process's lock dir without a `Lock` instance.

## Worker Lifecycle

Each worker is a cron-style PHP process spawned via HTTP POST, going zombie via `ignore_user_abort(true) + fastcgi_finish_request()`. Lifetime ~595s (just under 10 min, sized for Atomic's 15-min cap with margin).

```php
// Worker_Base::execute( callable $topology, string $spawn_url, string $token )
if ( ! $this->acquire() ) return [ 'status' => 'skipped', 'reason' => 'lock_held' ];

register_shutdown_function( /* cleanup_all_nodes + release + self_respawn */ );
usleep( LOCK_CHECK_GRACE_S * 1e6 );             // 250ms grace: let predecessor exit

try {
    $ci = $this->build_scaffolding();
    $this->run_topology( $topology, $ci );
    $ef = Event_Framework::instance();
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

`build_repl_graph()` builds the local graph at REPL start (bare):

```
_shell  ->  _command_interpreter  ->  _router  ->  _output (Dumper)
```

`_router` is a `Router_Node`, `_command_interpreter` a `Command_Interpreter_Node` sinking into it, `_output` a `Dumper_Node`. The `Shell_Node` is anonymous (Shell refuses a name) and sinks into `_command_interpreter`. (Topology lines and `make_node` refer to these by their *shell name* — the class short-name minus `_Node`: `Router`, `Command_Interpreter`, `Dumper`, `Shell`.)

**Pivoted mode** (`wp nodes cli firehose-workers.p0`) — the SAME local nodes, but with two additions and one re-wire: a `cmd-out` Partition (at the worker's input IPC dir, sink = `_command_interpreter`), a `reply-in` Consumer (at the worker's output IPC dir, sink = `_router`, `target = '_output'`, `next_offset('end')`), and crucially **`$shell->sink` is re-pointed from `_command_interpreter` to `cmd-out`** so typed lines cross the IPC boundary instead of running locally.

```
local _shell  ->  cmd-out (Partition, on-disk)  ->  worker input
worker output  ->  reply-in (Consumer, on-disk)  ->  local _router  ->  _output (Dumper)
```

IPC layout (always single-partition):

```
{base_dir}/ipc/{reader}/input/p0/{seg}.log     # shell -> worker
{base_dir}/ipc/{reader}/output/p0/{seg}.log    # worker -> shell
```

Reader id form: `{type}.p{N}`, e.g. `firehose-workers.p3`. Dot-and-`p` keeps it a single path segment — `firehose-workers/3` would route as "find node `firehose-workers`, pass remaining path `3`," which is wrong.

**No cryptographic handshake** — filesystem permissions on `/tmp/newspack-nodes/ipc/` gate access. `CLI::attach_to_worker( $reader_id )` resolves the IPC paths: it parses `{type}.p{N}`, checks the worker is registered by `is_dir( {base}/locks/{reader_id}.lock.d )`, and throws `InvalidArgumentException` with `"no worker '{reader_id}' (run \`wp nodes ls\` to list active workers)"` if the lock dir is absent (staleness is NOT checked — a mid-restart worker still attaches). It returns `{input, output, type, partition}`. `build_repl_graph()` then constructs the IPC pair directly with `new Partition( $ipc['input'], 0 )` (named `cmd-out`) and `new Consumer( $ipc['output'], 0 )` (unnamed `reply-in`) — not via `make_node`.

**Wire / dispatch specifics**:

- **IPC messages use TM_COMMAND**: replies route via the FROM/TO breadcrumb — Shell stamps FROM=`_output/$pid`, the worker's Command_Interpreter_Node sets TO=`$message[FROM]` when responding, and Router dispatches the reply by name. No ID-correlation table; the path itself is the addressing.
- **`Command` struct in VALUE is a LIVE PHP array, NOT JSON-encoded.** Inbound TM_COMMAND VALUE is `['name'=>, 'arguments'=>, 'payload'=>]`; the response VALUE is `['name'=>, 'payload'=>]`. The struct rides through `packed()`/`unpacked()` as a nested object inside the whole-message envelope — the envelope (and the SSE/REST body) is the ONLY place JSON serialization happens. Verb results are likewise live structures; the cli Dumper json-encodes array payloads only at the render boundary. No `signature` field — single-host filesystem-gated IPC; signing is dead weight.
- **TO at the root prompt is empty.** Command_Interpreter_Node dispatches a TM_COMMAND only when TO is empty; non-empty TO routes through Router as a normal addressed message.
- **`pwd` reply via the `prompt` intercept**: the Shell `pwd` builtin sends a TM_COMMAND `name=pwd`; `cd` is purely local (no message). When a response carries `name === 'prompt'`, Dumper sets `$shell->prompt` and renders nothing. (The Shell does not emit a `name=prompt` command itself; that path is a convention for a worker that wants to drive the cli's prompt.)

**Shell** supports quote-aware tokenization (single, double, backtick), single-tier `<varname>` interpolation, backslash line-continuation, and an `include` builtin. Conditionals, loops, function definitions, pipes, and `eval` all reject with "syntax not supported in v1". Quote-aware tokenization + line-continuation are *required* for `include topology.tch foo=bar` to parse topology files.

Shell also intercepts the **path-composing builtins** before they reach the message bus: `cd`/`chdir` updates `$this->path` (the cwd) and emits no message; `tell_node`/`tell` (TM_INFO), `send_node`/`send` (TM_BYTESTREAM, VALUE newline-terminated), `send_eof` (TM_EOF), `command_node`/`command`/`cmd` (TM_COMMAND), `request_node`/`request` (TM_REQUEST), `ping` (TM_PING, VALUE = now) all build TO via `prefix( <path> )`; `pwd` sends TM_COMMAND `name=pwd` with TO = `$this->path`. **A verb that matches no builtin falls through as a TM_COMMAND** with the verb as the command name and `TO = prefix('')` (i.e. the cwd itself). Every emitted message is stamped `FROM = _output/$pid`. `prefix($arg)` is just `join('/', filter([$this->path, $arg]))`, and `cd` resolves relative/absolute/`..` paths into `$this->path` with slashes trimmed.

**The pivot to a remote/other worker is just `$this->path`** — a TO prefix, nothing hardwired. At the root prompt `path=''` so default commands carry empty TO and the local `_command_interpreter` handles them; after `cd firehose:partition` the same default command carries `TO=firehose:partition` and `_router` dispatches it. In pivoted mode the Shell's sink is `cmd-out` (set by `build_repl_graph`), so those same messages are written to the worker's input partition instead of run locally.

**`list_nodes` (alias `ls`) flags are `-a c l s t`** (matched by `^-([aclst]+)$`), NOT `-celos`: `-a` all-nodes (optional regex glob), `-c` counters, `-s` sinks, `-t` targets, `-l` = `-ct`. Without `-a`, a bare name lists nodes whose sink IS that node; no arg lists this CI's siblings.

**Completion-query mode (`KEY='completion'`).** Both `help` and `ls` short-circuit when the inbound message carries `KEY='completion'`: they return a bare newline-separated candidate list (sorted verb names for `help`; bare node names for `ls`, honoring the same `-a`/glob/siblings selection but dropping all `-clst` columns) instead of the tabulated human output. This is the substrate's analogue of Tachikoma's `TM_COMPLETION`, implemented identically in PHP and JS (same set, same ordering) so tab-completion works against the browser-local graph and live workers alike. Tab-completion is built on top: `wp nodes cli` (readline-backed) and the browser REPL both fire a `help`/`ls` command with `KEY='completion'` through a `_completion` node, complete to the longest common prefix on the first Tab, and list the ambiguous candidates on a second consecutive Tab. The REPL also keeps a command history (up/down recall).

**`make_node` resolves by namespace prefix, not a class registry.** There is no `register_class` / `class_map`: plugins call `Command_Interpreter_Node::register_namespace( 'Newspack_Nodes\\' )` once at boot (the substrate also registers the `Newspack_Nodes\Rest\` sub-namespace so the service CIs resolve by short name). `make_node( $type, $name, ...$ctor_args )` loops the registered prefixes and constructs the first `{$prefix}{$type}_Node` that exists and is a concrete `Node` subclass — abstract subclasses (e.g. `Service_CI_Node`) and unknown types resolve to `null` rather than fatal. So `make_node('Tee')` → `Newspack_Nodes\Tee_Node`. The inverse, `shell_name_for( $node )`, is just the class short-name minus the `_Node` suffix (`Tee_Node` → `Tee`); a short name without `_Node` (ad-hoc test classes) is returned unchanged. `dump_metadata`'s `class` field and `dump_config`'s `make_node` line both emit this shell name, so the GUI/topology round-trip is stable across the rename.

The palette catalog (`Classes_CI`'s `list` verb) no longer reads a registry — it scans the composer classmap (`\Composer\Autoload\ClassLoader::getRegisteredLoaders()`) for FQCNs under a registered prefix whose short name ends `_Node`, are concrete `Node` subclasses, and whose `node_schema()` declares a non-`Hidden`, non-empty category. (A class that inherits `Node`'s empty-category default — e.g. `SSE_Out_Node`, a pure HTTP response writer — is not a palette participant.) This requires `composer dump-autoload -o` after adding/renaming a class so the classmap is complete.

**Command_Interpreter_Node** dispatches by verb. Aliases share the same `cmd_foo` static; e.g. `make` → `cmd_make_node`, `rm`/`remove` → `cmd_remove_node`, `dump` → `cmd_dump_node`, `ls` → `cmd_list_nodes`. A subclass that installs a custom verb table without a `help` verb gets a default `help` injected by `commands()` (returns the sorted verb names) — that's how the REST service CIs get a working `help`. CI dispatches a TM_COMMAND (not TM_RESPONSE) only when TO is empty — non-empty TO means the command is mid-route toward a downstream node, so CI forwards to its sink (Router). Verbs may throw freely; `interpret()` catches `\Throwable` and builds the response as `TM_COMMAND|TM_ERROR`. CI also bounces TM_PING and TM_EOF with empty TO back along FROM — the latter is the cli's stdin-close drain marker (cli emits TM_EOF when stdin EOFs, waits for the bounce so all preceding output has been drained off the reply partition before the cli exits).

The response envelope: `TYPE = TM_COMMAND|TM_RESPONSE` (or `|TM_ERROR` on throw), `TO = $message[FROM]`, `FROM = $this->name` (self), `ID`/`KEY` copied from the inbound message, and `VALUE = ['name' => $cmd_name, 'payload' => $result]` as a **live array** (never separately json-encoded). An empty-string result emits no response.

**`commands()` differs across ports — a real divergence.** PHP `commands($table)` **REPLACES** the instance verb table (`$this->commands = $table`); patron Node ctors install a fresh per-instance table this way. JS `commands(table)` **MERGES** via `{ ...this._commands, ...table }` so callers layer verbs. Don't assume one from the other.

Constructors of registered Node classes (Topic, Partition, Consumer, Tail, Log, etc.) populate `$this->arguments` — a string of space-joined ctor args — directly. `dump_config()` reads that to emit a round-trippable `make_node <type> <name> <args...>` line; `make_node` round-trips via the same ctor. No separate `dump_config()` override per class.

### Command authorization (two-tier)

The *same* `Command_Interpreter_Node` runs in two trust roles, so the gate is a per-instance `authorize` closure (`$this->authorize ?? self::$default_authorize`), checked for **every** command in `interpret()` — a failure returns `unauthorized: <verb>` rather than dispatching. Nothing legitimate is gated out: the `/command` controller and pivoted cli sign *all* commands they route, the browser only mints commands (all `LOCAL`) from a `Shell`, and the SSE receive path delivers `TM_RESPONSE`s to `_output`/`_metadata`/`_uptime`, never commands to a CI.

- **Client tier** (browser CI, bare `wp nodes cli`): commands are minted in-process by a `Shell_Node`, which sets `Message::LOCAL` (index 7, appended *after* the canonical 7 fields). The default `authorize` is simply `isset( $message[ Message::LOCAL ] )`. `packed()` / `pack()` slice to `LAST_VALUE_INDEX + 1`, so `LOCAL` is dropped at every wire/IPC boundary (HTTP POST, SSE, Partition IPC, the `HTTP_In_Node` echo) — an injected off-process command inherently lacks it.
- **Server tier** (worker CIs, the `/command` request-scope CI): these legitimately receive commands over the wire, so they can't lean on `LOCAL`. Issuers — `HTTP_In_Node` (after WordPress auth) and the pivoted cli's `Command_Signer_Node` — call `Command_Auth::sign()`, stashing an HMAC envelope in `VALUE['auth']` (it rides *inside* VALUE so it survives IPC, unlike the stripped `LOCAL`). Verifier CIs install `Command_Auth::verifier()` as their `authorize`. The HMAC reuses the spawn-token machinery: HMAC-SHA256 keyed on `NONCE_SALT`, two 10s windows of straddle tolerance plus a future-skew guard, and single-use replay protection via an atomic `Core::$memd->add()` of the nonce claimed at first verify. Ed25519 (hub↔spoke) is deferred until cross-server command authority exists.

**Dumper** dispatches by TYPE flag and writes payloads **plain — there is NO `ERROR:` or `INFO[from]:` prefix** (both were removed; the `debug_level 1` header and the stderr stream already identify the kind):

- **TM_COMMAND|TM_RESPONSE** → unwrap the live `['name'=>,'payload'=>]` VALUE; if `name === 'prompt'`, set the Shell's prompt and render nothing; otherwise write the payload to stdout (array payloads pretty-printed JSON, at the render boundary only).
- **TM_COMMAND|TM_ERROR** → write the `payload` field to stderr, plain.
- **TM_ERROR** → write VALUE to stderr, plain.
- **TM_EOF** → fire the registered `on_eof` callback (the cli's drain-marker exit hook), render nothing.
- **TM_PING** → rewrite VALUE (original send timestamp) into `round trip time: %.2f ms` and write to stdout.
- **TM_STRUCT** → json-encode the array VALUE to stdout.
- **TM_INFO / default TM_BYTESTREAM** → write VALUE to stdout, plain.

Stdout writes go through a prompt-aware async path that wipes-and-redraws when a prompt is on screen and stdout is a TTY; non-TTY output is plain (no ANSI). `debug_level` 0/1/2 layers a per-message header (1) or a full structural envelope dump that replaces the normal render (2). The multi-session TO filter renders only when TO matches `_output/$pid`, bare `$pid`, or is empty.

**Multi-session via FROM-trail**: each cli stamps `FROM=_output/$pid` (its wp-cli process PID). The worker's input-Consumer prepends `_repl`, so by the time the interpreter sees the message, `FROM=_repl/_output/$pid`. Replies follow `TO=$message[FROM]`, carrying `TO=_repl/_output/$pid`. The worker's `_router` splits TO on `/`, looks up `_repl` (a Partition), updates TO to `_output/$pid` (the post-strip remainder) and writes the envelope to disk. The cli's local `_router` reads the entry, splits again, looks up `_output` (the cli's Dumper), and forwards with `TO=$pid`. All cli sessions read the output Partition; each cli's Dumper filters: render iff TO matches its own `$pid` (or the pre-peel form `_output/$pid`), OR TO is empty (async broadcasts). No lock, no EBUSY; concurrent shells just work.

### Browser topology-console (`src/topology-console/`, `src/runtime/`)

The same Shell + Command_Interpreter_Node + Router + Dumper graph runs in the browser, ported to JS (`src/runtime/`) with full Shell-builtin and CI-verb parity with PHP (same verbs, same `commands()`-merge-vs-replace caveat aside). On top of that the console adds:

- **`cd` navigation** across `/`, `/_sse`, and `/_sse/{worker}`. `cd /_sse/{worker}` mounts that worker exactly like picking it from the Path menu — it resolves the worker by longest worker-prefix match so a partial path still lands on the right reader. A single **Path menu** lists only the currently-active topologies. `cd` echoes into the transcript like the other builtins.
- **Tab-completion** identical to the cli: longest-common-prefix extend on the first Tab via a `_completion` node firing `KEY='completion'`, list the candidates on a second consecutive Tab. Plus command history (up/down recall).
- **Live-mode Inspector verb modals**: a node's `node_schema()` verbs are surfaced as forms in the Inspector so an operator can invoke a verb (with its declared arg fields) against a live node.
- **`dmesg` / `uptime` / per-node logging** in the browser CI (via `Core.recentLog()` + `Core.initTime()`), matching the cli surface.

The JS side has **no** `classMap` / `registerClass` / browser-`makeNode` registry — those were removed with the PHP `register_class` refactor. The browser `make_node` verb returns a "cd to a worker path" hint instead of constructing a node, because node construction is a server-side / worker concern.

## Substrate Lifecycle Events vs WordPress Hooks

Two distinct extensibility mechanisms, both first-class:

| Mechanism | Scope | Use |
|-----------|-------|-----|
| `register` / `notify` / `set_state` on Node | Per-node-instance. Events are pre-declared in the subclass constructor (e.g., `$this->registrations['FIRE'] = []`); listeners can only register for declared events. Late subscribers get the cached `set_state` payload immediately at registration time. Two listener-dispatch modes (closure, or Node name -> fill TM_INFO). | Substrate-internal lifecycle: Topic `READY`, Timer `FIRE`, Router `TIMER` (the hitchhike channel Timer subclasses register against). Per-instance, events as a contract surface. |
| WordPress hooks via `Hook` node | Global by name. Anyone can `add_action` / `apply_filters`; no pre-declaration. No payload cache. | Plugin extensibility points. Transformation filters, observation listeners, "let other plugins react to this." |

Shipped substrate events in v0.1.0: Topic `READY` (set_state on first partition materialization), Timer `FIRE` (notify after each `fire()`), Router `TIMER` (notify on every Router tick — Timer subclasses hitchhike here to avoid per-node Event_Framework slots). Subclasses pre-declare what they emit; listeners register against the declared channels. `register()` throws on undeclared events — that's the contract surface.

**Multi-modal listener dispatch.** A registered listener identity is one of two things:

1. **Function/closure ref** — invoked directly with payload. Falsy return removes the registration (single-shot pattern).
2. **Node name** — fill a TM_INFO message into the named node with KEY=event, VALUE=payload. Missing node -> log via `print_less_often` ("WARNING: <name> forgot to unregister") and remove the registration.

`Hook` node is the WordPress-side bridge: action mode forwards the message unchanged after firing `do_action`; filter mode passes the message through `apply_filters` and forwards the result. Plugins observe completed requests, transform job payloads before routing, etc., without touching topology files.

## See also

- [AGENTS.md](AGENTS.md) — substrate contracts and invariants (anchored in real bugs).
- [API.md](API.md) — REST endpoint reference.
