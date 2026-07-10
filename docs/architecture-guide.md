# Newspack Nodes Architecture

A WordPress-internal node-graph runtime — a message-passing node graph built on WordPress primitives (the options table, WP-Cron, the REST API, nonces, and memcache all do real work), not a standalone PHP bus. This document describes the substrate; application-level shape lives in the consuming plugin's own architecture guide.

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
- [Lock](#lock)
- [Worker Lifecycle](#worker-lifecycle)
- [Supervisor Lifecycle](#supervisor-lifecycle)
- [Job_Worker_Node](#job_worker_node)
- [REPL: wp nodes cli](#repl-wp-nodes-cli)
- [Config System (declarative settings)](#config-system-declarative-settings)
- [Substrate Lifecycle Events vs WordPress Hooks](#substrate-lifecycle-events-vs-wordpress-hooks)

## Overview

Three core ideas:

1. **Nodes** — processing units. Every node has `fill( array $message )` as its only entry point.
2. **Messages** — 7-field arrays carrying a type bitmask, a routable path (TO/FROM), an ID, a KEY, and a VALUE.
3. **Drain loop** — Event_Framework picks the soonest pending timer's deadline as its wait timeout, then sleeps on `curl_multi_select` (when cURL handles are registered) or `usleep` (otherwise), and fires expired timers.

```
┌───────────────────────────────────────────────────────────┐
│                      Event_Framework                      │
│  drain():                                                 │
│   - compute timeout = next-timer deadline                 │
│   - if cURL handles: curl_multi_select(timeout) ->        │
│       drain transfers                                     │
│   - else:           usleep(timeout)                       │
│   - handle signals                                        │
│   - fire expired timers                                   │
│   - loop check (should_continue)                          │
└─────────────────────────┬─────────────────────────────────┘
                          │ on each tick
                          ▼
┌───────────────────────────────────────────────────────────┐
│                         Router                            │
│  fill($message):                                          │
│   - if TO == '': drop_message (unaddressed) + return      │
│   - [head, rest] = Message::split_first(TO)               │
│   - target = Core::node(head)                             │
│   - if !target: send_error NOT_AVAILABLE (TM_ERROR) to    │
│        FROM (set_state NOT_AVAILABLE first)               │
│   - else: TO = rest; target->fill($message)               │
│   - fire_cb tick: notify_timer() + Core::prune_logs()     │
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

**Type-flag bitmask** (10 flags):

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
TM_NOREPLY    = 512;
```

`TM_NOREPLY` is the fire-and-forget command flag: a `Shell` run with `want_reply( false )` (script / topology-load mode) ORs it onto each command and `Command_Interpreter_Node` then suppresses the routed reply (surfacing only an error to stderr). Without it, a worker's boot-topology command reply routes to `_output/<pid>` — which has no node in a worker — and bounces a dropped `NOT_AVAILABLE` on every startup.

**Convention — `TM_COMMAND` vs. `TM_REQUEST` (which plane is this?).** Two control planes, two types, two destinations. **`TM_COMMAND` is startup & administration**: graph construction (`make_node`/`connect_node`), config verbs, topology load — dispatched by a `Command_Interpreter_Node` (the node's `node_schema()['commands']` verb table; `command_node` / `cmd` in the REPL). **`TM_REQUEST` is runtime triggers & live queries**: `TICK`, `FLUSH`, `GET_LAG`, `GET_OFFSET` — things that drive or interrogate an *already-running* graph. A request is handled in the addressed node's **own `fill()`** (branch on `$type & TM_REQUEST`, do the work, reply `TM_STRUCT | TM_RESPONSE` to `TO = $message[FROM]`), declared under `node_schema()['requests']`, and fired from the REPL with `request_node <node> <VERB>`. `Consumer_Node::handle_request` is the canonical substrate example. The rule of thumb: if it runs once at build time, it's a command; if it fires against a live graph, it's a request — so a *runtime trigger is never a `cmd_*` verb*.

Flags compose via bitwise OR: `TM_COMMAND | TM_RESPONSE` = a response to a command. Receivers check via `&`: `if ( $type & TM_COMMAND ) { ... }`. **Never use strict `===`** on combined flags — it misses every combination.

**ONE shape, everywhere**: the positional indexed array IS the message — in PHP, in JS (`src/runtime/message.js` exports the same indices/flags), in memory, and on the wire. There is **no** `{ type, ts, from, to, id, key, value }` object form anywhere; if you see one it's a bug.

**Wire format**: `Message::packed( array $message ): string` is `wp_json_encode` of the array; `Message::unpacked( string $data ): array` is `json_decode`. The in-memory indexed array is the wire representation, so there's no key-to-index translation per side. The two ports differ on malformed input — a documented divergence:

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

A node connects two ways: **`sink`** is the physical next node `fill()` forwards to; **`target`** is a logical path string stamped into `message[TO]` when TO is empty (the message's logical `owner`). **There is NO `edge`** — the second physical output some node graphs carry is intentionally absent here; don't look for one.

```php
class Node {
    protected string $name = '';
    protected ?Node  $sink = null;
    protected $target = '';      // string for single target; array for Tee fan-out
    protected int $counter = 0;
    protected array $registrations = [];   // pre-declared events

    public function fill( array $message ): void;
    public function sink( ?Node $node = null ): ?Node;
    public function target( $value = null );
    public function connect_node( string $target ): void;     // sets target (Tee appends)
    public function disconnect_node( string $target = '' ): void;
    public function name( ?string $name = null ): string;
    public function counter(): int;

    public function stamp_message( array &$message, string $name ): bool;
    public function drop_message( array $message, string $error ): void;

    public function dump_node(): array;       // state snapshot for `dump_node` verb
    public function dump_config(): string;    // round-trippable make_node line

    public function register( string $event, string $listener, ?callable $cb = null ): void;
    public function unregister( string $event, string $listener ): void;
    public function notify( string $event, mixed $payload = null ): void;
    protected function set_state( string $event, string $payload = '' ): void;
}
```

**Default `fill()`** stamps TO from `target` (only when TO is empty), counts, then forwards:

```php
public function fill( array $message ): void {
    if ( null === $this->sink ) {
        throw new \RuntimeException( 'fill requires a wired sink' );
    }
    if ( '' === $message[ Message::TO ] && \is_string( $this->target ) && '' !== $this->target ) {
        $message[ Message::TO ] = $this->target;
    }
    ++$this->counter;
    $this->sink->fill( $message );
}
```

Subclasses override with their actual behavior. (Several primitives — Shell, Hook, Callback, Dumper — count-and-forward without the TO stamp; only the base `Node::fill` and the subclasses that call `parent::fill` apply it, e.g. Tail's `forward_line` and Consumer's `drain_buffer`.)

**`stamp_message`** prepends `$name` to the message's FROM with a `/` separator:

```php
$message[ Message::FROM ] = $from === '' ? $name : ( $name . '/' . $from );
```

Returns false (drops) if FROM would exceed `MAX_FROM_SIZE = 1024` — prevents path explosion on cycles. Also drops if `$name` is empty (mid-construction or post-rename); logs via `print_less_often`.

**Name registration**: `$node->name('foo')` registers the node in `Core::$nodes_by_name`. Renaming throws on collision (catches duplicate-node bugs at construction time).

**Pre-declared events**: subclasses populate `$this->registrations[$event] = []` in their constructor for every event they intend to emit. `register()` throws on undeclared events — declared events are the publishing node's contract surface.

## Router

`Router` extends `Timer`. Both ports override `fire_cb` to run `notify_timer()` — a **DIRECT `fire_cb` dispatch** to every TIMER-registered node (`Router::fire_cb → notify_timer`) — then `Core::prune_logs()` on each tick. This is the **Router-hitchhike pattern** for cheap periodic work without per-node Event_Framework slots. The override is necessary because the Router has no sink, so it can't fall through `Timer_Node::fire_cb`'s no-sink guard. (The PHP worker scaffolding arms this via `$router->set_timer( Router::DEFAULT_TICK_MS )` = 1000ms; without that the TIMER channel never fires.) `notify_timer()` walks each name in `registrations['TIMER']`, looks up the live node, and calls its `fire_cb()` directly — no message, no `fill()`; a name with no live node is warned + dropped (forgot to unregister).

`Router::fill()` (PHP) drops an unaddressed message first, then peels the head segment and dispatches:

```php
public function fill( array $message ): void {
    ++$this->counter;
    if ( '' === $message[ Message::TO ] ) {
        $this->drop_message( $message, 'message not addressed' );
        return;
    }
    if ( strlen( $from ) > self::MAX_FROM_SIZE ) {
        $this->drop_message( $message, 'path exceeded ...' );
        return;
    }
    [ $node_name, $remaining ] = Message::split_first( $message[ Message::TO ] );
    $target = Core::node( $node_name );
    if ( null === $target ) {
        $this->send_error( $message, 'NOT_AVAILABLE' );  // set_state NOT_AVAILABLE + bounce TM_ERROR to FROM
        return;
    }
    $message[ Message::TO ] = $remaining;
    $target->fill( $message );
}
```

`send_error()` fires `set_state( 'NOT_AVAILABLE', … )` (so observers see the miss), and — unless the message already carries `TM_ERROR` — builds a TM_ERROR (VALUE `"NOT_AVAILABLE\n"`, TO=FROM, FROM=the failed TO — the unreachable destination) and re-fills it through this same Router so the error walks the FROM trail back. A `handling_error` guard breaks recursion (an error about an error is dropped via `drop_message`).

**Empty-TO drop, both ports.** Both PHP and JS drop an empty-TO message up front via `drop_message( $message, 'message not addressed' )` — there is no PHP-bounce-vs-JS-forward divergence here. The JS Router (`src/runtime/router-node.js`) does the identical thing; it also has no sink (the `set sink` setter throws on any non-null value, the getter always returns null).

Routing is path-based (`a/b/c` → "find node `a`, pass remaining path `b/c`"), not socket-based. Replies use the `TO=$message[FROM]` convention to walk back along the breadcrumb trail. Both ports increment `counter` on the recursive NOT_AVAILABLE re-fill, so one inbound miss bumps the counter by 2 (intentional, matched across ports).

**NOT_AVAILABLE drops log via `print_less_often` in `Node::drop_message`, not Router.** `Router::send_error` builds the NOT_AVAILABLE error inline; the logging happens wherever `drop_message` IS called. (A `Core::$now - Core::$init_time < 300.0` boot-window branch exists in `drop_message`, but both arms currently log identically via `print_less_often` — there is no `print_least_often` method.) NOT_AVAILABLE drops keep no `WARNING:` prefix (matches the `drop_message` rule).

**TIMER hitchhike, both ports.** PHP's Router fires its tick on the Event_Framework-driven `set_timer`. The JS Router (`src/runtime/router-node.js`) has no drain loop, so it **self-starts** its own slot in the constructor via `setTimer( 1000 )` (the Router IS timer-driven) and its `fireCb` brackets `notifyTimer()` with two console-injected hooks, `beforeTimerNotify` / `afterTimerNotify` — locking `HttpOut` before and flushing after — so every emission a tick produces (each subscriber's poll) batches into ONE `/command` POST. The hooks are null by default and live on the Router so the substrate stays decoupled from any console node; tests that don't want the slot running call `stopTimer()`.

**TIMER subscribers batch.** Both `_metadata` and `_uptime` register against the Router's TIMER channel rather than running their own intervals: `_metadata` emits a `dump_metadata` poll every tick; `_uptime` self-throttles to a 5s `uptime` poll. Because both fire inside the same locked tick, the 5s uptime poll always rides in the same POST as that tick's `dump_metadata`. The substrate Router stays decoupled from any console node — the lock/flush logic lives in the injected hooks, not the Router.

## Storage: Topic + Partition

### Partition

One file-segmented append-only log, with an optional `.idx` companion. Storage primitive AND Node. Lift-adapt of event-logger's `Firehose`.

```php
$p = new Partition_Node();                              // no-arg ctor; config is positional via arguments()
$p->arguments( "$partition_dir $segment_size $num_segments $max_lifespan" );
$p->fill( $message );                                   // ONLY ingress — no write()/produce()
$p->flush();                                            // land the in-memory batch now
$p->read_at( $segment_id, $offset, $length );           // read bytes
$p->scan_index( fn ( $line, $seg ) => ..., $newest_first );
$p->get_segments( $force_refresh );                     // [{id,size}, ...] sorted by id
$p->allow_large_writes();                               // 4KB -> 32MB; acquires a Lock
$p->with_index( $formatter );                           // opt in: JSONL .idx line formatter
```

**Indexing is opt-in via `with_index( $formatter )`.** Without a formatter no `.idx` file is created or written at all — the `.log` segments stand alone. `with_index()` installs a per-line formatter `fn(string $line, array $position, ?array &$data) => string|null`; each write whose formatter returns a non-empty string appends that string as one JSONL line to the segment's `.idx` (return `null`/`''` to skip the entry). `scan_index( fn ( $line, $seg ) => ..., $newest_first )` walks those JSONL entries (a no-op when no formatter is set), and `read_at( $seg, $off, $len )` seeks into the `.log` using positions the formatter recorded. There is no default binary index format — the previous `(segment_id, offset)` 8-byte sidecar was removed; indexing now always goes through `with_index`/JSONL.

**There is NO `Partition::write()` method** — the only way bytes enter a Partition is `fill()`. (The doc once claimed a `write( $line )` class API; it does not exist and never did.) `fill()` packs the whole message via `Message::packed()` (+ `"\n"`) and appends to the current segment. All TYPE flags pass through — Partition is a generic transport including control messages (TM_REQUEST, TM_ERROR, TM_EOF). The attached-cli IPC pattern relies on this: cli ↔ worker round-trips drain markers (TM_EOF), error responses (TM_COMMAND|TM_ERROR), and introspection requests (TM_REQUEST) through Partition-as-bus. Data partitions like firehose.log only ever see TM_BYTESTREAM / TM_STRUCT in practice, so the broader contract is a no-op for production paths.

**Class-API contract**:

`new Partition()` and `new Topic()` MUST be safe to call from request-scope code without an Event_Framework running. Specifically:

- No `set_timer` from constructor (silent leak: registers in Event_Framework, never fires).
- No `Core::node()` lookup during construct.
- No `scandir` in constructor (eager scandir × N partitions × every request burns syscalls).
- No `$this->name()` from constructor (`Command_Interpreter_Node::make_node` owns naming).
- File handles open lazily on first `fill()` / `read_at()`.

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

**`MAX_LINE_SIZE = 4096`** (PIPE_BUF) caps default writes; the size check is on the FINAL packed bytes (envelope + `"\n"`), not VALUE alone. `allow_large_writes( int $max_wait_ms = 65000, int $debounce_ms = 0 )` lifts to `MAX_LARGE_LINE_SIZE = 33554432` (32MB) AND takes a `Lock` at `{partition_dir}/write.lock.d/` (blocking up to `max_wait_ms`, default 65s, so a respawn race recovers once the predecessor's heartbeat ages out). The optional second arg picks the locking mode: **hold mode** (`$debounce_ms = 0`, the default) acquires the Lock up front and holds it for the partition's lifetime; **debounced mode** (`$debounce_ms > 0`) does NOT acquire up front — `fill()` grabs the lock at the start of a write burst and `fire()` frees it after `$debounce_ms` of quiet, so a partition that writes large lines only intermittently doesn't monopolize the lock between bursts. **There is NO `with_lock()` method** — the doc once claimed every large write "flows through `with_lock()`"; that wrapper does not exist. Instead a held Lock is kept fresh two ways: inside a running event loop a heartbeat `Timer` (`{name}:heartbeat`, KEY=`heartbeat`) sinks into the Lock and refreshes it; in request scope (no drain) `fill()` drives the heartbeat inline (at most once per `stale_timeout/3` s) and throws if `Lock::heartbeat()` reports the lock was stolen. Single-writer partitions writing >4KB payloads lose data silently (oversize drop) without the opt-out.

**Per-partition batching.** `fill()` packs the message and appends it to an in-memory `$batch` string. If adding the new packed bytes would push the batch over `MAX_LINE_SIZE` (4KB), the existing batch flushes FIRST and the new message starts a fresh batch — preserving PIPE_BUF atomicity per syswrite. Each batched `fill()` also arms a 0-delay one-shot timer via `set_timer(0, true)`; when the event-loop iteration finishes, `fire()` calls `flush()` to land whatever's still accumulated. `__destruct()` also flushes, so request-scope writes land before GC.

Messages larger than 4KB (only reachable on `allow_large_writes` partitions) bypass the batch entirely — they're already over PIPE_BUF so batching can't shrink them. The held write Lock serializes them with batched small-message flushes.

`Topic::flush()` walks every materialized Partition and calls `Partition::flush()` on each. Callers handing off to a subprocess that writes to the same partition path use this to land pending writes before forking, so the parent's accumulated messages land on disk in source-order with the child's appends.

### Topic

Multi-Partition wrapper. Hashes KEY to partition, falls back to round-robin when KEY is empty.

```php
$t = new Topic_Node();                                 // no-arg ctor; config is positional via arguments()
$t->arguments( "$dir_template $num_partitions $segment_size $num_segments $max_lifespan" );
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

Just another Partition under `offsets/{reader}/`. Each checkpoint is a `TM_STRUCT` Message whose VALUE is `{segment, offset, attempts, reason, first_crash_ts, name, target, targets, worker_type, source_log}` — plus, when applicable, `cache` (the snapshot node's co-committed state) and `quarantined` (the cursor sits on an already-dead-lettered message; drop it on re-encounter — see ADR-12) — routed through `Partition::fill` (so it lands as the canonical packed wire format, not raw JSONL) and `flush`ed immediately. On restart `load_offsetlog()` reads the newest segment's last line, `Message::unpacked`s it, and decodes VALUE to seed the cursor. An empty `$offsetlog_dir` disables the offsetlog entirely (ephemeral readers like the cli's `reply-in`). No special class.

## Consumer + Tail

**Consumer** generalizes existing `LogReader`. Tails a source Partition; commits cursor `{segment, offset, attempts, reason, first_crash_ts, ...}` to its offsetlog (itself a single-partition Partition). On restart, reads the newest offsetlog entry to seed the cursor.

```php
$c = new Consumer_Node();                              // no-arg ctor; config is positional via arguments()
$c->arguments( "$source_dir $offsetlog_dir $deadletter_dir" );
$c->next_offset( 'start' | 'recent' | 'end' | ['segment'=>, 'offset'=>] );  // seek
$c->poll();         // read new bytes, re-emit each line's Message, advance cursor
$c->checkpoint();   // append a {segment, offset, attempts, reason, first_crash_ts, ...} TM_STRUCT to offsetlog
```

`poll()` reads new bytes since the cursor, splits on `\n`, drops the trailing partial, and for each complete line `Message::unpacked`s it (Partition wrote a packed Message per line), stamps its own name onto FROM, and forwards via `parent::fill`. The position breadcrumb goes in **ID** as `"{segment}:{offset}:{length}"` — **NOT KEY**. The code comment is explicit: overwriting KEY would destroy the producer's partition-routing key (rid / handler) and silently break multi-partition queues and RequestBuilder's rid grouping. (Cursor management consumes only the crumb's START — advance-on-next; readers accept a two-part crumb — length is still stamped for SSE_In's eager reconnect.) Corrupt/unparseable lines are quarantined to the `:deadletter` sibling (raw bytes preserved; the cursor still advances) rather than aborting the poll — see ADR-12 for the full poison lifecycle.

**Tail** is a subclass of **Consumer** (`Tail extends Consumer`). It reads a **Log**'s `{file}.{seg}` segments (a file layout, via a `Log_Node` source) and emits one complete line per poll as raw `TM_BYTESTREAM` bytes (newline restored, FROM-stamped at this I/O boundary) — instead of unpacking packed Messages. Tail overrides only the single per-line emit seam, `forward_line()`; the buffer/cursor scan that hands it each line stays in Consumer's `drain_buffer()`, so Tail gets line_mode (one line per poll) for free. It **inherits** the durable offsetlog cursor, snapshot co-commit, live-position publish, behind/ETA, checkpoint cadence, and segment-roll follow. A fresh Tail with no durable cursor defaults to **end-of-file** (`default_offset` → `'end'`) — only bytes appended after start — and resumes from its offsetlog checkpoint on restart, which fixes the old every-restart full re-read. `make_node Tail <name> <source_file> [offsetlog_dir]`.

## Other Node Primitives

**Tee** is the fan-out node. Targets are an array; each `fill()` snapshots a live-target list, copies the message per target with `TO=target` (if TO was empty) or `TO=target/originalTO` (path-prepend if TO carried subpath), and forwards through `sink` (typically `_router`) under a per-target try/catch that isolates one failing target from the rest. Pruning is by a liveness check on every fill, not "after a failed dispatch": the liveness check applies to the FIRST path segment of every target, so a bare-name target is dropped when its node has disappeared, and a **path-shaped** target (has a `/`, e.g. `_repl/_output/12345`) is kept while its head node exists and dropped when the head is absent. Tee declares no registrations, commands, or requests of its own.

**Hook** is the WordPress-extensibility bridge. Action mode forwards the message unchanged after firing `do_action`; filter mode passes the message through `apply_filters` and forwards the result. Plugins observe completed requests, transform job payloads before routing, etc., without touching topology files.

**Callback** is the closure-as-Node adapter — a one-line `fill()` that invokes a stored closure. Useful for inline transforms in tests and small topology stitches without writing a whole subclass.

**Echo** is a routing helper that re-addresses messages on the way through. Both `target` and `TO` set → `TO = target/TO` (path-prepend). Both empty → `TO = FROM` (return-to-sender along the trail). Otherwise TO is unchanged. TM_ERROR with empty TO is dropped rather than bounced (the producer isn't expecting the error trail).

**Log** is the file-writer counterpart to Tail and a subclass of **Partition** (`Log extends Partition`). It differs from Partition at two seams only: it writes each fill()'d message's **VALUE** (the producer's payload, not the packed envelope) and lays its segments out as `{file}.{seg}` (`out.log.0`, `out.log.1`, …) rather than `{dir}/{seg}.log`. Constructor args: `(string $file, int $segment_size = …, int $num_segments = …)`. Rotation is monotonic and automatic when a segment passes `segment_size`; retention keeps the newest `num_segments` (AND-gated by `max_lifespan` like Partition). It inherits the rotate lock, `allow_large_writes()`/`void_warranty()`, and the 4KB PIPE_BUF cap — an oversize VALUE is dropped unless the cap is lifted. TM_ERROR/TM_EOF/TM_REQUEST are dropped (append-only; EOF never closes it; segmentation is size-driven, so there is no rotate request).

**Timer** (and its subclass **Router**) is the time-driven base. `set_timer( $interval_ms, $oneshot )` registers with Event_Framework; `fire_cb` is the Event_Framework-side hook; `fire()` is the override point for subclasses. Default `fire()` emits a TM_BYTESTREAM with the current timestamp at `target` and notifies `FIRE` listeners.

**Grep** is the payload filter (`Grep_Node`, a port of Tachikoma's `Grep.pm`): forwards a message only when its VALUE matches a bracket-delimited PCRE (`arguments()` sets the pattern; default matches everything), drops the rest. Category `Filtering`.

**Tap** is `Tee` with *hard* (non-pruned) targets plus passthrough — a `Tee_Node` subclass for observability fan-out: it copies the message to its taps AND forwards the original down `sink`. Unlike Tee, a tap target throwing is non-fatal — swallowed + logged — so a broken tap can't break the pipeline; `Worker_Should_Stop` still re-throws (see [ADR-14](architecture-decisions.md#adr-14-cooperative-stop-propagates-through-broad-catches)).

**Stderr** (`Stderr_Node`) is a bare diagnostic sink: it routes a TM_BYTESTREAM VALUE through the node's stderr chain (`Node::stderr` → `Core::stderr`: node-name midfix, dmesg ring, `error_log`, debug.log, real stderr) and writes nothing else. Splice one on the end of a debug tap (`Tee → Dumper → Grep → Stderr`) so rendered/filtered lines land in the diagnostic log without polluting the STDOUT data path. Only TM_BYTESTREAM is written — put a Dumper in front to render structured types first.

**Struct_To_JSON / JSON_To_Struct** are the round-trippable serialization pair (the Tachikoma `StorableToJSON` / `JSONtoStorable` analog). `Struct_To_JSON_Node` serializes a TM_STRUCT message's array VALUE into a TM_BYTESTREAM JSON line (splice in front of a Log or terminal so a struct producer's payload can be written as a line); `JSON_To_Struct_Node` is the inverse on the read side — decode a JSON line back into a TM_STRUCT array (a line that isn't a JSON array/object passes through as a plain bytestream).

**Remote reader family (SSE-pull aggregation).** `Remote_Source_Node` is a self-sufficient, topology-visible SSE-pull node: it extends `Remote_Link_Node` (the channel layer — `SSE_In_Node` + `HTTP_Out_Node` patrons, heartbeat, reconnect, status) and `use`s the `Buffered_Pump` trait (the durable message-path spine it shares with Consumer), so each raw SSE `msg` payload appends to the pump buffer and the tick drains it exactly like a Consumer — with the same durable offsetlog cursor and dead-letter/crash lifecycle ([ADR-12](architecture-decisions.md#adr-12-dead-letter-poison--crash-lifecycle)). `Remote_IPC_Node` is the IPC-partition variant of the same channel. These are the cURL-driven nodes that register handles with the drain loop (see [Event_Framework](#event_framework)).

**Topic_Probe** (`Topic_Probe_Node`) is a periodic Consumer-stats sweep (a port of Tachikoma's `TopicProbe`): each worker process runs one, sweeping ITS local Consumers (`Core::$nodes_by_name`) and emitting one snapshot record per tick (cursor + exact byte volumes) into the shared `topicprobe` log.

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

**FROM stamping at I/O boundaries only**: the substrate's source nodes — **Tail** (`forward_line` sets FROM directly, honoring `stamp_override`) and **Consumer** (`stamp_message`, using `stamp_override` when set — the worker IPC input Consumer stamps `_repl`) — stamp FROM as messages enter the graph. Internal nodes (Tee, Hook, and any application Node subclass) do NOT stamp. A message flowing `tail -> tee -> request-builder` carries `FROM=tail`, NOT `tee/tail`. (There are no `Job` / `Connector` node classes in this substrate; those node types aren't part of it.)

## Event_Framework

Per-process drain-loop singleton. Manages timers and cURL multi handles. There is no FD-registration path: local file polling (Tail, Consumer, the cli's stdin reader) is driven by `set_timer`, so the loop always has exactly one blocking waiter regardless of which I/O sources are active.

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
4. Refresh Core::$now.
5. Fire any timers whose next_fire <= Core::$now (oneshot timers unregister
   themselves; recurring timers re-schedule).
6. should_continue() check; break on false or on Core::$shutting_down.
```

There is no deferred-cleanup step in the loop (and no `Core::$closing` queue); teardown cleanup is `Core::cleanup_all_nodes()`, invoked by Worker_Base's shutdown handler / `finally` after `drain()` returns (so Partitions release their locks before the next spawn).

Registration API:

```php
// Timers: subclass Timer_Node and arm the timer FROM the node — never call
// Event_Framework's timer method directly. Timer_Node::set_timer() reads the
// node's own interval and hands $this to Event_Framework under the hood.
class My_Timer_Node extends Timer_Node {
    protected function fire(): void { /* periodic work */ }
}
$node->set_timer( $interval_ms, $oneshot = false );   // Timer_Node::set_timer
$node->stop_timer();                                  // Timer_Node::stop_timer

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

Verified against `includes/class-lock-node.php`:

```php
class Lock_Node extends Node {
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
    public function should_restart(): bool;       // restart flag present, OR heartbeat gone / PID-mismatch

    public static function force_release_at( string $lock_dir ): void;   // UNCONDITIONAL clear
    public static function request_restart_at( string $lock_dir ): bool;
    public static function is_restart_pending( string $lock_dir ): bool;
    public static function get_started_time( string $lock_dir ): ?int;
}
```

Release is unconditional via the static `force_release_at()` (unlinks heartbeat/started/restart, rmdir) — there is no instance `force_release()`. `Lock_Node` extends `Node`: its `fill()` refreshes the lock on a `KEY='heartbeat'` message and forwards anything else via `parent::fill`. The `restart` flag has no explicit `clear_restart()` — it is cleared on the next successful `acquire()` (`write_acquire_files()` unlinks it).

**Acquire**: atomic `mkdir`. If the dir already exists, `try_steal_orphan_or_stale()` decides whether to take over — an *orphan* dir (no heartbeat file → possible mid-acquire) is honored for `ORPHAN_GRACE_S` then stolen if still empty; a *stale* dir (heartbeat mtime older than `stale_timeout`) is stolen immediately; otherwise back off, and either return false or retry every 100ms until `$max_wait_ms`. On success it writes the `heartbeat` (PID) + `started` (timestamp) files and clears any inherited `restart` flag.

**Heartbeat**: workers touch their heartbeat every 10s during drain. `heartbeat()` calls `verify_ownership()` first; if the on-disk PID no longer matches `getmypid()` (someone stale-stole us), it flips local `is_held=false` and returns false so `release()` becomes a no-op and the displaced holder stops writing. `Partition::fill()` calls `heartbeat()` inline on the no-event-loop large-write path.

**Stale takeover**: once `STALE_TIMEOUT` elapses without a refresh, the next acquirer steals the dir and the displaced holder fails its next heartbeat and exits. This is the supervisor's main job for workers, and it's how concurrent `wp nodes restart` invocations don't fight over slots.

**`should_restart()` / `request_restart()`**: writes `$lock_path/restart` as a sentinel. Workers poll `should_restart()` on every drain tick and exit cleanly when the flag is present **or** the heartbeat file is gone / its PID no longer matches (PID-content theft). The flag is cleared on the next acquire (`write_acquire_files` unlinks it). Static `request_restart_at( $lock_dir )` lets a stranger (admin request, supervisor) signal restart into another process's lock dir without a `Lock_Node` instance.

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

## Job_Worker_Node

`Job_Worker_Node` (substrate since 0.12.0; was an application node) is the generic async-job dispatch Node. It keeps two handler maps — `local_handlers` and `remote_handlers` — eagerly loaded in the constructor from the `newspack_nodes/job_handlers` and `newspack_nodes/remote_job_handlers` filters (by topology-evaluation time `plugins_loaded` has fired, so every registered handler is in place; eager load saves a `load_handlers` line in every TSL). Each `fill()` runs the matching handler bracketed by `do_action( 'newspack_nodes/job_worker/before_job', $handler )` and `…/after_job` — the after-action always fires (even when the handler throws) so applications can hook per-job request context (logger suspend, synthetic `$_SERVER` rewrite) without that being a substrate concern.

After each job it bumps counters, `gc_collect_cycles()`, and — every `CACHE_FLUSH_INTERVAL = 50` jobs — `wp_cache_flush()` (object-cache flush extends per-process runtime by orders of magnitude). A per-job memory check latches `memory_pressure` once usage crosses `MEMORY_WATERMARK_PCT = 0.80` of the limit, so the worker requests its own restart before PHP's uncatchable fatal-on-OOM bypasses cleanup. A `GET_HEALTH` request (declared in `node_schema()['requests']`) reports counters/pressure. Ships with a stock `topologies/job-worker.tsl` in the substrate's built-in dir (`Topology_Registry::register_builtin_dir`, wired in `Bootstrap`; `register_stock_dir` is the per-plugin analog used by `register_plugin`).

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

**Attached mode** (`wp nodes cli firehose-workers.p0`) — the SAME local nodes, plus two additions and a `path` cd: a `Partition_Node` named after the worker (e.g. `firehose-workers.p0`) writes to the worker's input IPC dir (sink = `_command_interpreter`); an unnamed `Consumer_Node` (the `reply-in`) tails the worker's output IPC dir (sink = `_router`, `target = '_output'`, `next_offset('end')`). The Shell's sink stays `_command_interpreter`; the cd is purely `$shell->path = "{worker-id}"`, so a default command carries `TO={worker-id}` and `_router` dispatches it to the worker-id Partition (which writes it to disk) instead of running locally. The Shell signs every command it mints inline via `Command_Auth::sign()` — there is no separate signer Node — so locally-minted commands carry the HMAC envelope verifier CIs require.

```
local _shell  ->  _command_interpreter  ->  _router  ->  worker-id Partition (on-disk)  ->  worker input
worker output  ->  reply-in Consumer (on-disk)  ->  local _router  ->  _output (Dumper)
```

IPC layout (always single-partition):

```
{base_dir}/ipc/{reader}/input/{seg}.log     # shell -> worker
{base_dir}/ipc/{reader}/output/{seg}.log    # worker -> shell
```

Reader id form: `{type}.p{N}`, e.g. `firehose-workers.p3`. Dot-and-`p` keeps it a single path segment — `firehose-workers/3` would route as "find node `firehose-workers`, pass remaining path `3`," which is wrong.

**No cryptographic handshake** — filesystem permissions on `/tmp/newspack-nodes/ipc/` gate access. `CLI::attach_to_worker( $reader_id )` resolves the IPC paths: it parses `{type}.p{N}`, checks the worker is registered by `is_dir( {base}/locks/{reader_id}.lock.d )`, and throws `InvalidArgumentException` with `"no worker '{reader_id}' (run \`wp nodes ls\` to list active workers)"` if the lock dir is absent (staleness is NOT checked — a mid-restart worker still attaches). It returns `{input, output, type, partition}`. `build_repl_graph()` then constructs the IPC pair directly with `new Partition_Node()` (named after the worker id, e.g. `firehose-workers.p0`, configured via `arguments( "{$ipc['input']} 0 …" )` and sinking into `_command_interpreter`) and `new Consumer_Node()` (unnamed `reply-in`, configured against `$ipc['output']`) — not via `make_node`.

**Wire / dispatch specifics**:

- **IPC messages use TM_COMMAND**: replies route via the FROM/TO breadcrumb — Shell stamps FROM=`_output/$pid`, the worker's Command_Interpreter_Node sets TO=`$message[FROM]` when responding, and Router dispatches the reply by name. No ID-correlation table; the path itself is the addressing.
- **`Command` struct in VALUE is a LIVE PHP array, NOT JSON-encoded.** Inbound TM_COMMAND VALUE is `['name'=>, 'arguments'=>]` (plus an `'auth'` HMAC envelope when wire-issued — see command authorization); the response VALUE is `['name'=>, 'arguments'=>, 'payload'=>]`. The struct rides through `packed()`/`unpacked()` as a nested object inside the whole-message envelope — the envelope (and the SSE/REST body) is the ONLY place JSON serialization happens. Verb results are likewise live structures; the cli Dumper json-encodes array payloads only at the render boundary. No `signature` field — single-host filesystem-gated IPC; signing is dead weight.
- **TO at the root prompt is empty.** Command_Interpreter_Node dispatches a TM_COMMAND only when TO is empty; non-empty TO routes through Router as a normal addressed message.
- **`pwd` reply via the `prompt` intercept**: the Shell `pwd` builtin sends a TM_COMMAND `name=pwd`; `cd` is purely local (no message). When a response carries `name === 'prompt'`, Dumper sets `$shell->prompt` and renders nothing. (The Shell does not emit a `name=prompt` command itself; that path is a convention for a worker that wants to drive the cli's prompt.)

**Shell** supports quote-aware tokenization (single, double, backtick), single-tier `<varname>` interpolation, backslash line-continuation, and an `include` builtin. There are no conditionals, loops, function definitions, pipes, or `eval` — and no syntax-error rejection for them either: an unrecognized verb simply falls through as a TM_COMMAND (below). Quote-aware tokenization + line-continuation are *required* for `include topology.tch foo=bar` to parse topology files.

Shell also intercepts the **path-composing builtins** before they reach the message bus: `cd`/`chdir` updates `$this->path` (the cwd) and emits no message; `tell_node`/`tell` (TM_INFO), `send_node`/`send` (TM_BYTESTREAM, VALUE newline-terminated), `send_eof` (TM_EOF), `command_node`/`command`/`cmd` (TM_COMMAND), `request_node`/`request` (TM_REQUEST), `ping` (TM_PING, VALUE = now) all build TO via `prefix( <path> )`; `pwd` sends TM_COMMAND `name=pwd` with TO = `$this->path`. **A verb that matches no builtin falls through as a TM_COMMAND** with the verb as the command name and `TO = prefix('')` (i.e. the cwd itself). Every emitted message is stamped `FROM = _output/$pid`. `prefix($arg)` is just `join('/', filter([$this->path, $arg]))`, and `cd` resolves relative/absolute/`..` paths into `$this->path` with slashes trimmed.

**The cd to a remote/other worker is just `$this->path`** — a TO prefix, nothing hardwired. At the root prompt `path=''` so default commands carry empty TO and the local `_command_interpreter` handles them; after `cd firehose:partition` the same default command carries `TO=firehose:partition` and `_router` dispatches it. In attached mode the Shell's sink stays `_command_interpreter`; `build_repl_graph` sets `$shell->path` to the worker id, so default commands carry `TO={worker-id}` and `_router` routes them to the worker-id Partition that writes them to the worker's input IPC dir instead of running locally.

**`list_nodes` (alias `ls`) flags are `-a c l s t`** (matched by `^-([aclst]+)$`), NOT `-celos`: `-a` all-nodes (optional regex glob), `-c` counters, `-s` sinks, `-t` targets, `-l` = `-ct`. Without `-a`, a bare name lists nodes whose sink IS that node; no arg lists this interpreter's siblings.

**Event-loop introspection verbs (`list_timers` / `list_handles`).** Both are static Command_Interpreter_Node verbs (ported from Tachikoma's `CommandInterpreter` `list_ids`/`list_timers`) that tabulate the current `Event_Framework` state — useful for diagnosing a spinning drain loop without redeploying. `list_timers` lists all registered timers (ID, ACTIVE, INTERVAL ms, NEXT ms, ONESHOT, FIRES, TYPE, NAME); a `NEXT <= 0` with a climbing `FIRES` is a spinner. `list_handles` lists the registered cURL multi handles the drain loop selects on (ID, COUNT msgs, TYPE, NAME). Both are mirrored in the JS interpreter (`src/runtime/command-interpreter-node.js`), where `list_timers`'s MODE column distinguishes own-slot from Router-hitchhike timers and `list_handles` lists nodes holding an `EventSource`.

**Completion-query mode (`KEY='completion'`).** Both `help` and `ls` short-circuit when the inbound message carries `KEY='completion'`: they return a bare newline-separated candidate list (sorted verb names for `help`; bare node names for `ls`, honoring the same `-a`/glob/siblings selection but dropping all `-clst` columns) instead of the tabulated human output. This is the substrate's `TM_COMPLETION` protocol, implemented identically in PHP and JS (same set, same ordering) so tab-completion works against the browser-local graph and live workers alike. Tab-completion is built on top: `wp nodes cli` (readline-backed) and the browser REPL both fire a `help`/`ls` command with `KEY='completion'` through a `_completion` node, complete to the longest common prefix on the first Tab, and list the ambiguous candidates on a second consecutive Tab. The REPL also keeps a command history (up/down recall).

**`make_node` resolves by namespace prefix, not a class registry.** There is no `register_class` / `class_map`: plugins call `Command_Interpreter_Node::register_namespace( 'Newspack_Nodes\\' )` once at boot (the substrate also registers the `Newspack_Nodes\Rest\` sub-namespace so the service CIs resolve by short name). `make_node( $type, $name, ...$ctor_args )` loops the registered prefixes and constructs the first `{$prefix}{$type}_Node` that exists and is a concrete `Node` subclass — abstract subclasses (e.g. `Service_CI_Node`) are skipped (the loop continues to the next prefix), and unknown types resolve to `null` rather than fatal once every prefix has been tried. So `make_node('Tee')` → `Newspack_Nodes\Tee_Node`. The base `Node` class is a special case: `make_node('Node')` resolves to `{$prefix}Node` (no `_Node` suffix), used by routing/fan-in primitives like the SSE-stream `_default_route` whose `fill()` is just the base `target` stamp + sink forward. The inverse, `shell_name_for( $node )`, is the class short-name minus the `_Node` suffix (`Tee_Node` → `Tee`); a short name without `_Node` (the base `Node` itself, or an ad-hoc test class) is returned unchanged. `dump_metadata`'s `class` field and `dump_config`'s `make_node` line both emit this shell name, so the GUI/topology round-trip is stable across the rename.

**v0.6.0+ no-arg-ctor + arguments() convention.** Every substrate Node has a no-arg constructor; `make_node` instantiates with `new $fqcn()`, then calls `$node->name( $name )`, then `$node->arguments( implode( ' ', array_filter( $ctor_args, '\is_scalar' ) ) )`, then `$node->sink( $this )` — a uniform construction sequence. The default `arguments()` walks `node_schema()['arguments']` and assigns each declared positional arg to the matching `$this->{$name}` property. Programmatic object dependencies (e.g. `Workers_CI_Node::$cli`, a registry) are public properties the caller assigns AFTER `make_node` returns — they're silently dropped from the variadic spread by the `is_scalar` filter because they aren't round-trippable as `arguments` tokens.

**`parse_schema_args()` is the single source of truth for positional config.** As of 0.18.0 the base `arguments($args)` walks `node_schema()['arguments']` unconditionally via `parse_schema_args()` (the `trait-schema-reflection.php` half), assigning each declared positional to `$this->{$name}` coerced to its type. A missing token falls back to that arg's schema `default`, or **throws** if the arg is `required` — so an under-argged `make_node` (e.g. omitting a required `source_file`) now fails loudly at construction rather than silently deriving against declaration-default props. Tokens beyond the declared positions are ignored, and a node with no declared `arguments` is a no-op. There is no empty-string early-return to mirror anymore: a subclass that needs derived state (e.g. `Partition_Node` deriving `partition_dir`) does it after the schema assignment, and the `required`/`default` policy lives entirely in the schema declaration (cross-check [ADR-11](architecture-decisions.md#adr-11-make_node-construction-sequence)).

The palette catalog (`Classes_CI`'s `list` verb) no longer reads a registry — it scans the composer classmap (`\Composer\Autoload\ClassLoader::getRegisteredLoaders()`) for FQCNs under a registered prefix whose short name ends `_Node`, are concrete `Node` subclasses, and whose `node_schema()` declares a non-`Hidden`, non-empty category. (A class that inherits `Node`'s empty-category default — e.g. `SSE_Out_Node`, a pure HTTP response writer — is not a palette participant.) This requires `composer dump-autoload -o` after adding/renaming a class so the classmap is complete.

**Service CIs (the GUI/REST verb surface).** The substrate ships nine service interpreters — `Classes_CI_Node` (`classes`), `Layouts_CI_Node` (`layouts`), `Topologies_CI_Node` (`topologies`), `Raw_Logs_CI_Node` (`raw-logs`), `Workers_CI_Node` (`workers`), `Vault_CI_Node` (`vault`), `Aggregator_CI_Node` (`aggregator`), `Settings_CI_Node` (`settings`), `Status_CI_Node` (`status`) — that derive their verb table from `node_schema()` via the abstract base `Service_CI_Node`. They are mounted onto the request-scope interpreter by `newspack_nodes_mount_substrate_cis()`, hooked on `newspack_nodes/request_graph_ready` (the action a request graph fires once it's wired). `Workers_CI_Node` needs the substrate `CLI` assigned as a public property AFTER `make_node` returns (its `heartbeat` verb reads live positions from the shared `Core::$memd` directly, so there's no cache handle to inject). Because `Service_CI_Node` is abstract, `make_node` skips it during prefix resolution — only the concrete `*_CI_Node` subclasses construct.

**Command_Interpreter_Node** dispatches by verb. Aliases share the same `cmd_foo` static; e.g. `make` → `cmd_make_node`, `rm`/`remove` → `cmd_remove_node`, `dump` → `cmd_dump_node`, `ls` → `cmd_list_nodes`. A subclass that installs a custom verb table without a `help` verb gets a default `help` injected by `commands()` (returns the sorted verb names) — that's how the REST service CIs get a working `help`. CI dispatches a TM_COMMAND (not TM_RESPONSE) only when TO is empty — non-empty TO means the command is mid-route toward a downstream node, so CI forwards to its sink (Router). Verbs may throw freely; `interpret()` catches `\Throwable` and builds the response as `TM_COMMAND|TM_ERROR`. CI also bounces TM_PING and TM_EOF with empty TO back along FROM — the latter is the cli's stdin-close drain marker (cli emits TM_EOF when stdin EOFs, waits for the bounce so all preceding output has been drained off the reply partition before the cli exits).

The response envelope: `TYPE = TM_COMMAND|TM_RESPONSE` (or `|TM_ERROR` on throw), `TO = $message[FROM]`, `FROM = $this->name` (self), `ID`/`KEY` copied from the inbound message, and `VALUE = ['name' => $cmd_name, 'arguments' => $cmd_args, 'payload' => $result]` as a **live array** (never separately json-encoded). An empty-string result emits no response.

**`commands()` differs across ports — a real divergence.** PHP `commands($table)` **REPLACES** the instance verb table (`$this->commands = $table`); patron Node ctors install a fresh per-instance table this way. JS `commands(table)` **MERGES** via `{ ...this._commands, ...table }` so callers layer verbs. Don't assume one from the other.

Constructors of registered Node classes (Topic, Partition, Consumer, Tail, Log, etc.) populate `$this->arguments` — a string of space-joined ctor args — directly. `dump_config()` reads that to emit a round-trippable `make_node <type> <name> <args...>` line; `make_node` round-trips via the same ctor. No separate `dump_config()` override per class.

### Command authorization (two-tier)

The *same* `Command_Interpreter_Node` runs in two trust roles, so the gate is a per-instance `authorize` closure (`$this->authorize ?? self::$default_authorize`), checked for **every** command in `interpret()` — a failure returns `unauthorized: <verb>` rather than dispatching. Nothing legitimate is gated out: the `/command` controller and attached cli sign *all* commands they route, the browser only mints commands (all `LOCAL`) from a `Shell`, and the browser's SSE receive path delivers `TM_RESPONSE`s to `_output`/`_metadata`/`_uptime`. The SSE-stream *process* itself now runs a verifier CI (server tier, below) so a worker can drive it — but only a command addressed to `_command_interpreter` (TO=`_repl/_command_interpreter`, empty after the worker peels `_repl`) routes to it; broadcasts get a `_sse` target from the `_default_route` Node and go to the egress.

- **Client tier** (browser interpreter, bare `wp nodes cli`): commands are minted in-process by a `Shell_Node`, which sets `Message::LOCAL` (index 7, appended *after* the canonical 7 fields). The default `authorize` is simply `isset( $message[ Message::LOCAL ] )`. `packed()` / `pack()` slice to `LAST_VALUE_INDEX + 1`, so `LOCAL` is dropped at every wire/IPC boundary (HTTP POST, SSE, Partition IPC, the `HTTP_In_Node` echo) — an injected off-process command inherently lacks it.
- **Server tier** (worker CIs, the `/command` request-scope CI, the SSE-stream process CI): these legitimately receive commands over the wire, so they can't lean on `LOCAL`. Issuers — `HTTP_In_Node` (after WordPress auth) and the attached cli's `Shell` (which signs inline via `Command_Auth::sign()`, not via any separate signer Node) — stash an HMAC envelope in `VALUE['auth']` (it rides *inside* VALUE so it survives IPC, unlike the stripped `LOCAL`). Verifier CIs install `Command_Auth::verifier()` as their `authorize` — a closure that accepts an in-process (`LOCAL`) command OR one with a valid HMAC. `Command_Auth::sign()` / `verify()` decide "is this a command?" by the **message TYPE bit** — they require `TM_COMMAND` set, NOT `TM_RESPONSE`/`TM_ERROR`, and an array VALUE — not by sniffing a `name` key in VALUE (so a command whose VALUE lacks `name` is still signed/verified, and a non-command carrying a `name` key is left alone). A `TM_COMMAND | TM_NOREPLY` boot command is still signed/verified (the HMAC covers the combined TYPE). On any verification failure `verify()` logs the rejection via the interpreter's `drop_message` (`verification failed: …`) and returns false (fail closed). The HMAC reuses the spawn-token machinery: HMAC-SHA256 keyed on `NONCE_SALT`, two 10s windows of straddle tolerance plus a future-skew guard, and single-use replay protection via an atomic `Core::$memd->add()` of the nonce claimed at first verify. Ed25519 (hub↔spoke) is deferred until cross-server command authority exists.

**Dumper** dispatches by TYPE flag and renders payloads **plain — there is NO `ERROR:` or `INFO[from]:` prefix** (both were removed; the `debug_level 1` header already identifies the kind). Every rendered type goes out the same way: `emit()` mints a TM_BYTESTREAM and forwards to `$this->target` — there is no stderr branch:

- **TM_COMMAND|TM_RESPONSE** → unwrap the live `['name'=>,'arguments'=>,'payload'=>]` VALUE; if `name === 'prompt'`, set the Shell's prompt and render nothing; otherwise render the payload (array payloads pretty-printed JSON, at the render boundary only).
- **TM_COMMAND|TM_ERROR** → render the `payload` field, plain.
- **TM_ERROR** → render VALUE, plain.
- **TM_EOF** → fire the registered `on_eof` callback (the cli's drain-marker exit hook), render nothing.
- **TM_PING** → rewrite VALUE (original send timestamp) into `round trip time: %.2f ms` and write to stdout.
- **TM_STRUCT** → json-encode the array VALUE to stdout.
- **TM_INFO / default TM_BYTESTREAM** → write VALUE to stdout, plain.

Stdout writes go through a prompt-aware async path that wipes-and-redraws when a prompt is on screen and stdout is a TTY; non-TTY output is plain (no ANSI). `debug_level` 0/1/2 layers a per-message header (1) or a full structural envelope dump that replaces the normal render (2). The multi-session TO filter renders only when TO matches `_output/$pid`, bare `$pid`, or is empty.

**Multi-session via FROM-trail**: each cli stamps `FROM=_output/$pid` (its wp-cli process PID). The worker's input-Consumer prepends `_repl`, so by the time the interpreter sees the message, `FROM=_repl/_output/$pid`. Replies follow `TO=$message[FROM]`, carrying `TO=_repl/_output/$pid`. The worker's `_router` splits TO on `/`, looks up `_repl` (a Partition), updates TO to `_output/$pid` (the post-strip remainder) and writes the envelope to disk. The cli's local `_router` reads the entry, splits again, looks up `_output` (the cli's Dumper), and forwards with `TO=$pid`. All cli sessions read the output Partition; each cli's Dumper filters: render iff TO matches its own `$pid` (or the pre-peel form `_output/$pid`), OR TO is empty (async broadcasts). No lock, no EBUSY; concurrent shells just work.

### Browser topology-console (`src/topology-console/`, `src/runtime/`)

The same Shell + Command_Interpreter_Node + Router + Dumper graph runs in the browser, ported to JS (`src/runtime/`) with full Shell-builtin and interpreter-verb parity with PHP (same verbs, same `commands()`-merge-vs-replace caveat aside). On top of that the console adds:

- **`cd` navigation** across `/`, `/_sse`, and `/_sse/{worker}`. `cd /_sse/{worker}` mounts that worker exactly like picking it from the Path menu — it resolves the worker by longest worker-prefix match so a partial path still lands on the right reader. A single **Path menu** lists only the currently-active topologies. `cd` echoes into the transcript like the other builtins.
- **Tab-completion** identical to the cli: longest-common-prefix extend on the first Tab via a `_completion` node firing `KEY='completion'`, list the candidates on a second consecutive Tab. Plus command history (up/down recall).
- **Live-mode Inspector verb modals**: a node's `node_schema()` verbs are surfaced as forms in the Inspector so an operator can invoke a verb (with its declared arg fields) against a live node.
- **`dmesg` / `uptime` / per-node logging** in the browser interpreter (via `Core.recentLog()` + `Core.initTime()`), matching the cli surface.

The JS side has **no** `classMap` / `registerClass` / browser-`makeNode` registry — those were removed with the PHP `register_class` refactor. The browser `make_node` verb returns a "cd to a worker path" hint instead of constructing a node, because node construction is a server-side / worker concern.

**The JS runtime (`@newspack-nodes/runtime`) re-exports the substrate's node primitives for application dashboards to mount:** `Core`, `Node`, `RouterNode`, `TeeNode`, `HookNode`, `CallbackNode`, `EchoNode`, `TimerNode`, `HeartbeatNode`, `CommandInterpreterNode`, `SseInNode`, `RemoteLinkNode`, `RemoteIpcNode`, `HttpOutNode`, `CompletionNode`, `DumperNode`, `UptimeNode`, `CommandClient`, plus the `mountExospine` factory, the `formatCommandArgs` / `parseCommandArgs` command-arg helpers, and the `useNodeState` / `useNodeFill` / `useGraphGeneration` React hooks (all `Message::*` constants are re-exported via `export * from './message'`). The `MetadataNode` class and `parseMetadata` helper live in `src/runtime/metadata-node.js` but aren't re-exported from the package entry — consume them via the file path if an application needs them.

## Config System (declarative settings)

Substrate settings are declared once in a shared **Config System** (`includes/config-system/`, namespace `Config_System\`, since 0.13.0) instead of in parallel hand-maintained lists. One `Config_System\Field` per setting carries its key, type, label (a string or a `fn(): string` thunk, resolved lazily so building the schema never requires `__()` to be defined), section, sanitizer, renderer, blank-delete policy, worker-restart class, and an `overlay` flag. `Config_System\Schema` derives every consumer from those Fields: the per-request overlay key-list, option names, delete-on-blank set, reset list, worker-restart classification, and the register/render loops. `Settings_Schema` (`includes/class-settings-schema.php`) is the substrate's own `Schema` declaration; `Config` and `Admin` both derive from it (the old `Config::$option_schema`, `Admin::$option_names`, etc. are gone). `Config_System\Options_Overlay` applies the presence-based per-request config overlay; `Reset_Gate` + `Field_Reset_Assets` drive per-field reset; `Settings_Renderer` renders the settings page. Sibling plugins (event-logger-nodes, pyrobase) adopt this same `Config_System\` namespace.

**Shared `Core::$memd`.** The one process-wide `\Memcached` handle is built by the substrate itself (`Bootstrap::init_memcached`, run at plugin-file scope, since 0.12.0) from the substrate's own `memcache_servers` config — not by an application plugin. Empty/invalid config leaves `Core::$memd` null (deliberately not a fallback handle): command-auth refuses + logs, SSE slots fail closed, stats fail soft, all keying off null rather than an unreachable fake connection.

## Substrate Lifecycle Events vs WordPress Hooks

Two distinct extensibility mechanisms, both first-class:

| Mechanism | Scope | Use |
|-----------|-------|-----|
| `register` / `notify` / `set_state` on Node | Per-node-instance. Events are pre-declared in the subclass constructor (e.g., `$this->registrations['FIRE'] = []`); listeners can only register for declared events. Late subscribers get the cached `set_state` payload immediately at registration time. Two listener-dispatch modes (closure, or Node name -> fill TM_INFO). | Substrate-internal lifecycle: Topic `READY`, Timer `FIRE`, Router `TIMER` (the hitchhike channel Timer subclasses register against). Per-instance, events as a contract surface. |
| WordPress hooks via `Hook` node | Global by name. Anyone can `add_action` / `apply_filters`; no pre-declaration. No payload cache. | Plugin extensibility points. Transformation filters, observation listeners, "let other plugins react to this." |

Shipped substrate events (as of 0.14.0): Topic `READY` (set_state on first partition materialization), Timer `FIRE` (notify after each `fire()`), Router `TIMER` (the hitchhike channel — Router `fire_cb` dispatches each registrant's `fire_cb` directly so Timer subclasses avoid per-node Event_Framework slots). Subclasses pre-declare what they emit; listeners register against the declared channels. `register()` throws on undeclared events — that's the contract surface.

**Multi-modal listener dispatch.** A registered listener identity is one of two things:

1. **Function/closure ref** — invoked directly with payload. Falsy return removes the registration (single-shot pattern).
2. **Node name** — fill a TM_INFO message into the named node with KEY=event, VALUE=payload. Missing node -> log via `print_less_often` ("WARNING: <name> forgot to unregister") and remove the registration.

`Hook` node is the WordPress-side bridge: action mode forwards the message unchanged after firing `do_action`; filter mode passes the message through `apply_filters` and forwards the result. Plugins observe completed requests, transform job payloads before routing, etc., without touching topology files.

## See also

- [AGENTS.md](../AGENTS.md) — substrate contracts and invariants (anchored in real bugs).
- [API.md](API.md) — REST endpoint reference.
- `examples/example-ai-newsletter/` — bundled walkthrough example: a self-contained deterministic digest pipeline built from Nodes (its own `includes/`, `topologies/example-ai-newsletter.tsl`, and PHPUnit suite) to learn the substrate from.
