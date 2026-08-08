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
- [Fleet Revival](#fleet-revival)
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
    public const LOCAL     = 7;   // in-process provenance taint; packed() never emits it
}
```

**Why arrays not hashes**: indexed access is faster than hash lookup in hot paths. Messages flow through every Node in the graph; this is one of the busiest data structures in the runtime.

**Field layout rationale**: TIMESTAMP sits at index 1 so [WHAT + WHEN] groups at the front of the array. KEY/VALUE naming matches Kafka's `ProducerRecord<K,V>`, SQS message attributes, Redis Streams' `XADD key value`.

**Type-flag bitmask** (11 flags):

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
TM_UNTYPED    = 1024;
```

`TM_UNTYPED` is the mint default `new_message()` stamps: a free high bit matching NO type gate, so a message reaching a sink still carrying it is an untyped-message bug the drop audit names — not a message that is every type at once (what a `-1` sentinel would be).

`TM_NOREPLY` is the fire-and-forget command flag: a `Shell` run with `want_reply( false )` (script / topology-load mode) ORs it onto each command and `Command_Interpreter_Node` then suppresses the routed reply (surfacing only an error to stderr). Without it, a worker's boot-topology command reply routes to `_output/<pid>` — which has no node in a worker — and bounces a dropped `NOT_AVAILABLE` on every startup.

**Convention — `TM_COMMAND` vs. `TM_REQUEST` (which plane is this?).** Two control planes, two types, two destinations. **`TM_COMMAND` is startup & administration**: graph construction (`make_node`/`connect_node`), config verbs, topology load — dispatched by a `Command_Interpreter_Node` (the node's `node_schema()['commands']` verb table; `command_node` / `cmd` in the REPL). **`TM_REQUEST` is runtime triggers & live queries** — things that drive or interrogate an *already-running* graph. The substrate ships two: `GET_LAG` (Consumer/Tail: bytes and segments behind the source tail) and `GET_HEALTH` (Job_Worker: memory, handler counts, cache-flush progress). A request is handled in the addressed node's **own `fill()`** (branch on `$type & TM_REQUEST`, do the work, reply `TM_STRUCT | TM_RESPONSE` to `TO = $message[FROM]`), declared under `node_schema()['requests']`, and fired from the REPL with `request_node <node> <VERB>`. `Consumer_Node::handle_request` is the canonical substrate example. The rule of thumb: if it runs once at build time, it's a command; if it fires against a live graph, it's a request — so a *runtime trigger is never a `cmd_*` verb*.

Flags compose via bitwise OR: `TM_COMMAND | TM_RESPONSE` = a response to a command. Receivers check via `&`: `if ( $type & TM_COMMAND ) { ... }`. **Never use strict `===`** on combined flags — it misses every combination.

**ONE shape, everywhere**: the positional indexed array IS the message — in PHP, in JS (`src/runtime/message.js` exports the same indices/flags), in memory, and on the wire. There is **no** `{ type, ts, from, to, id, key, value }` object form anywhere; if you see one it's a bug. `LOCAL` at index 7 is the single exception and proves the rule: it is appended *after* the canonical seven, and `packed()` / `pack()` slice it off, so it cannot cross a process boundary (see [Command authorization](#command-authorization-two-tier)).

**Wire format**: `Message::packed( array $message ): string` is `wp_json_encode` of the array; `Message::unpacked( string $data ): array` is `json_decode`. The in-memory indexed array is the wire representation, so there's no key-to-index translation per side. The two ports differ on malformed input — a documented divergence:

- **PHP** `unpacked()` accepts ONLY `count() === 7 && array_is_list()`. Anything else **throws** `InvalidArgumentException`. Callers that read off-disk lines catch it: `Durable_Reader::forward_line` quarantines the bad line to the `:deadletter` sibling and advances, `read_last_offsetlog_frame` logs it and resumes without a durable cursor.
- **JS** `unpack()` accepts `Array.isArray && length >= 7`, truncating to the canonical seven; anything else (including a JSON parse error) yields a fresh `newMessage()` — never a throw.

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
    protected array $registrations = [];   // events declared in node_schema()
    protected array $arguments = [];       // constructor tokens, list<string>
    protected ?Node $patron = null;        // set = plumbing; hidden from the canvas

    public function fill( array $message ): void;
    public function arguments( ?array $args = null ): array;
    public function sink( ?Node $node = null ): ?Node;
    public function target( $value = null );
    public function connect_node( string $target ): void;     // sets target (Tee appends)
    public function disconnect_node( string $target = '' ): void;
    public function name( ?string $name = null ): string;
    public function remove_node(): void;
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

**Name registration**: `$node->name('foo')` registers the node in `Core::$nodes_by_name`. Renaming throws on collision (catches duplicate-node bugs at construction time), and a node that owns siblings cascades the new name to them (`Consumer` renames its `:source`, `:offsetlog`, `:deadletter`, and `:config` nodes).

**Pre-declared events**: a subclass lists every event it emits under `node_schema()['registrations']`, and the base constructor's `seed_registrations()` turns that list into the runtime allow-list. `register()` throws on an undeclared event — the declared list is the publishing node's contract surface.

## Router

`Router` extends `Timer`. Both ports override `fire_cb` to run `notify_timer()` — a **DIRECT `fire_cb` dispatch** to every TIMER-registered node (`Router::fire_cb → notify_timer`) — then `Core::prune_logs()` on each tick. This is the **Router-hitchhike pattern** for cheap periodic work without per-node Event_Framework slots. The override is necessary because the Router has no sink, so it can't fall through `Timer_Node::fire_cb`'s no-sink guard. (The PHP worker scaffolding arms this via `$router->set_timer( Router::DEFAULT_TICK_MS )` = 1000ms; without that the TIMER channel never fires.) `notify_timer()` walks each name in `registrations['TIMER']`, looks up the live node, and calls its `fire_cb()` directly — no message, no `fill()`; a name with no live node is warned + dropped (forgot to unregister), and a registrant that isn't a `Timer_Node` is skipped rather than fataled. The PHP tick also warns once while `Core::$secure_level` is 0 — a command surface exists and nobody has declared a policy for it (see [Secure levels](#secure-levels)).

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

**Dispatch profiling** is off by default and costs nothing while off: `Router_Node::profiles()` is null, and `fill()` takes the plain dispatch branch. The `profile [ on | off ]` verb flips it; while on, each dispatch is bracketed by a stack frame whose elapsed time is subtracted from its parent, so the table reports **self** time per node. Read it with `list_profiles [-s] [ <regex glob> ]` (slowest average first, plus a `--total--` row); `-s` returns those same rows as a struct for a view that wants to sort them. Entries idle longer than `PROFILE_TTL_S = 900` are trimmed on each tick.

**NOT_AVAILABLE drops log via `print_less_often` in `Node::drop_message`, not Router.** `Router::send_error` builds the NOT_AVAILABLE error inline; the logging happens wherever `drop_message` IS called. The audit line names the type flags, FROM, TO, and — for TM_INFO / TM_REQUEST / TM_ERROR / TM_COMMAND — the payload, with credential-named keys and `--auth_password=…` tokens redacted. A NOT_AVAILABLE drop carries no `WARNING:` prefix (matches the `drop_message` rule).

**TIMER hitchhike, both ports.** PHP's Router fires its tick on the Event_Framework-driven `set_timer`. The JS Router (`src/runtime/router-node.js`) has no drain loop, so it **self-starts** its own slot in the constructor via `setTimer( 1000 )` (the Router IS timer-driven) and its `fireCb` brackets `notifyTimer()` with two console-injected hooks, `beforeTimerNotify` / `afterTimerNotify` — locking `HttpOut` before and flushing after — so every emission a tick produces (each subscriber's poll) batches into ONE `/command` POST. The hooks are null by default and live on the Router so the substrate stays decoupled from any console node; tests that don't want the slot running call `stopTimer()`.

**TIMER subscribers batch.** Both `_metadata` and `_uptime` register against the Router's TIMER channel rather than running their own intervals: `_metadata` emits a `dump_metadata` poll every tick; `_uptime` self-throttles to a 5s `uptime` poll. Because both fire inside the same locked tick, the 5s uptime poll always rides in the same POST as that tick's `dump_metadata`. The substrate Router stays decoupled from any console node — the lock/flush logic lives in the injected hooks, not the Router.

## Storage: Topic + Partition

### Partition

One file-segmented append-only log, with an optional `.idx` companion. Storage primitive AND Node. Lift-adapt of event-logger's `Firehose`.

```php
$p = new Partition_Node();                              // no-arg ctor; config is positional via arguments()
$p->arguments( [ $partition_dir, $segment_size, $min_segments, $num_segments, $min_lifetime, $lifetime, $max_segments ] );  // token array (list<string>)
$p->fill( $message );                                   // ONLY ingress — no write()/produce()
$p->flush();                                            // land the in-memory batch now
$p->read_at( $segment_id, $offset, $length );           // read bytes
$p->read_message_at( $segment_id, $offset, $length );   // …unpacked to a Message; null if torn
$p->scan_index( fn ( $line, $seg ) => ..., $newest_first );
$p->get_segments( $force_refresh );                     // [{id,size}, ...] sorted by id
$p->allow_large_writes();                               // 4KB -> 32MB; acquires a Lock
$p->void_warranty();                                    // 4KB -> 32MB; NO lock (caller asserts single-writer)
$p->with_index( $formatter );                           // opt in: JSONL .idx line formatter
```

**Indexing is opt-in via `with_index( $formatter )`.** Without a formatter no `.idx` file is created or written at all — the `.log` segments stand alone. `with_index()` installs a per-line formatter `fn(array $message, array $position) => string|null` — it receives the unpacked 7-field Message and `{segment, offset, length}`, never the serialized line; each write whose formatter returns a non-empty string appends that string as one JSONL line to the segment's `.idx` (return `null`/`''` to skip the entry). `with_index_named( $name )` is the round-trippable form: it resolves a registered `Formatters` name, which is what `dump_config()` emits and what a Topic propagates to every partition it materializes. `scan_index( fn ( $line, $seg ) => ..., $newest_first )` walks those JSONL entries (a no-op when no formatter is set), and `read_at( $seg, $off, $len )` seeks into the `.log` using positions the formatter recorded. There is no default binary index format — indexing always goes through `with_index`/JSONL.

**There is NO `Partition::write()` method** — the only way bytes enter a Partition is `fill()`, which packs the whole message via `Message::packed()` (+ `"\n"`) and appends to the current segment. All TYPE flags pass through — Partition is a generic transport including control messages (TM_REQUEST, TM_ERROR, TM_EOF). The attached-cli IPC pattern relies on this: cli ↔ worker round-trips drain markers (TM_EOF), error responses (TM_COMMAND|TM_ERROR), and introspection requests (TM_REQUEST) through Partition-as-bus. Data partitions like firehose only ever see TM_BYTESTREAM / TM_STRUCT in practice, so the broader contract is a no-op for production paths.

**Class-API contract**:

`new Partition_Node()` and `new Topic_Node()` MUST be safe to call from request-scope code without an Event_Framework running. Specifically:

- No `set_timer` from constructor (silent leak: registers in Event_Framework, never fires).
- No `Core::node()` lookup during construct.
- No `scandir` in constructor (eager scandir × N partitions × every request burns syscalls).
- No `$this->name()` from constructor (`Command_Interpreter_Node::make_node` owns naming).
- File handles open lazily on first `fill()` / `read_at()`.

The one thing the constructor DOES build is the sibling `{name}:config` interpreter, via `Schema_Reflection::auto_wire_interpreter()` — pure object construction from `node_schema()['commands']`, no registry lookup and no I/O. It stays unnamed until the node itself is named, and `name()` then cascades.

**`hash_to_partition`** is the canonical partition-routing function:

```php
public static function hash_to_partition( string $key, int $num_partitions ): int {
    [ $stripped ] = explode( '?', $key, 2 );             // strip query string
    return ( crc32( $stripped ) & 0x7FFFFFFF ) % $num_partitions;  // 31-bit mask
}
```

Topic and any other partition router MUST call this same function. Diverging hash families across producers means the same key routes to different partitions and breaks ordering.

**Three-rule retention**: `cleanup_segments` prunes oldest-first above a hard floor of 2 segments when ANY rule fires — the **age rule** (older than `lifetime`, keeping at least `min_segments`), the **count rule** (more than `num_segments`, keeping anything younger than `min_lifetime`), or the **hard cap** (more than `max_segments` — UNCONDITIONAL; `min_lifetime` does not protect, only the floor of 2 does, so a hot partition full of young segments can't grow past it; `0` derives to `2 × num_segments`). Low-traffic partitions may still retain segments for days under the age/count floors — documented behavior, not a bug.

**`SEGMENT_CACHE_TTL = 0.25` seconds**: segment-list cache so back-to-back reads don't `scandir` per call. Readers may see stale segment lists for up to 250ms after rotation. Consumer's checkpoint logic must tolerate this. A partition that lifted the write cap serves its cache warm without the TTL — no peer can change the directory behind a single writer. Cutting the other way, `maybe_rescan_segments()` re-reads the directory at most once per `DRIFT_RESCAN_INTERVAL_SECONDS = 1.0` and follows a peer's rotation, so a multi-writer log recovers from the TOCTOU window instead of appending to a superseded segment.

**`MAX_LINE_SIZE = 4096`** (PIPE_BUF) caps default writes; the size check is on the FINAL packed bytes (envelope + `"\n"`), not VALUE alone. `allow_large_writes( int $max_wait_ms = 65000, int $debounce_ms = 0 )` lifts to `MAX_LARGE_LINE_SIZE = 33554432` (32MB) AND takes a `Lock` at `{partition_dir}/write.lock.d/` (blocking up to `max_wait_ms`, default 65s, so a respawn race recovers once the predecessor's heartbeat ages out). The optional second arg picks the locking mode: **hold mode** (`$debounce_ms = 0`, the default) acquires the Lock up front and holds it for the partition's lifetime; **debounced mode** (`$debounce_ms > 0`) does NOT acquire up front — `fill()` grabs the lock at the start of a write burst and `fire()` frees it after `$debounce_ms` of quiet, so a partition that writes large lines only intermittently doesn't monopolize the lock between bursts. **There is NO `with_lock()` wrapper.** A held Lock is kept fresh two ways instead: inside a running event loop a heartbeat `Timer` (`{name}:heartbeat`, KEY=`heartbeat`) sinks into the Lock and refreshes it; in request scope (no drain) `fill()` drives the heartbeat inline (at most once per `stale_timeout/3` s) and throws if `Lock::heartbeat()` reports the lock was stolen. `void_warranty()` lifts the same cap with NO lock on the caller's assertion that it is the sole writer — see [ADR-4](architecture-decisions.md#adr-4-pipe_buf-atomic-writes) for which form to pick. Single-writer partitions writing >4KB payloads lose data silently (oversize drop) without one of the two opt-ins.

**A short write is quarantined, never swallowed.** `write_all()` fails loud, and `recover_write_stall()` truncates the partial record off the segment — a torn record would desync every reader after it — then dead-letters every message that didn't land in full to `{base}/deadletter/{dir-under-base,dotted}`, replayable via `wp nodes ingest`. A failed segment open takes the same path. Sidecars (offsetlogs, the quarantine partitions themselves) opt out via `without_write_deadletter()`: a quarantine that quarantines into a quarantine chains forever on a full disk.

**Per-partition batching.** `fill()` packs the message and appends it to an in-memory `$batch` string. If adding the new packed bytes would push the batch over `MAX_LINE_SIZE` (4KB), the existing batch flushes FIRST and the new message starts a fresh batch — preserving PIPE_BUF atomicity per syswrite. Each batched `fill()` also arms a 0-delay one-shot timer via `set_timer(0, true)`; when the event-loop iteration finishes, `fire()` calls `flush()` to land whatever's still accumulated. `__destruct()` also flushes, so request-scope writes land before GC.

Messages larger than 4KB (only reachable on `allow_large_writes` partitions) bypass the batch entirely — they're already over PIPE_BUF so batching can't shrink them. The held write Lock serializes them with batched small-message flushes.

`Topic::flush()` walks every materialized Partition and calls `Partition::flush()` on each. Callers handing off to a subprocess that writes to the same partition path use this to land pending writes before forking, so the parent's accumulated messages land on disk in source-order with the child's appends.

### Topic

Multi-Partition wrapper. Hashes KEY to partition, falls back to round-robin when KEY is empty.

```php
$t = new Topic_Node();                                 // no-arg ctor; config is positional via arguments()
$t->arguments( [ $dir_template, $num_partitions, $segment_size, $min_segments, $num_segments, $min_lifetime, $lifetime, $max_segments ] );  // token array
$t->fill( $message );    // ONLY ingress — KEY -> partition routing; no write()
$t->flush();             // flush every materialized partition's batch
```

**There is NO `Topic::write()` method** — `fill()` is the only ingress. Three precedences in `fill()`:

1. **TO field already set** — caller pre-pinned. Topic parses a leading `p\d+` out of TO and, if in range, routes there directly. Used by replay tools and any producer that needs a specific partition.
2. **KEY present** — `Partition::hash_to_partition($key, $num_partitions)`.
3. **No KEY** — round-robin via a static counter (`self::$rr_counter++ % $num_partitions`).

**`READY` event** is declared in `node_schema()` and fired (`set_state`) from `sink()` — wiring the sink is what materializes every partition, so that is the moment the Topic is usable. Late registrants get the cached payload immediately. `Partition::sink()` fires its own `READY` the same way.

**No `RESET` event** — our partitions are local directories that don't move at runtime, so there's no partition-map mutation to signal. Pre-declaring an event you'll never fire is a foot-gun for downstream registrants.

**Per-partition settings propagate, including to partitions built later.** `allow_large_writes()`, `void_warranty()`, and `with_index( $formatter_name )` record the mode on the Topic and apply it to every materialized Partition; `partition()` applies it again to each one it creates. Each is exposed as a `{name}:config` verb, and `dump_config()` re-emits it, so the round-trip preserves the mode.

**No Topic-level batching.** Per-partition batching happens INSIDE `Partition::fill()` itself — see the Partition section above. Topic is a pure router on top, so a single message routed to a partition lands in that partition's `$batch` and follows the partition's flush rules (size threshold + 0-delay one-shot timer).

### Offsetlog

Just another Partition, at the directory the reader's `offsetlog_dir` argument names (the stock topologies point it at `<config:offsets_dir>/<topology>.<log>.p<partition>`). Each checkpoint is a `TM_STRUCT` Message whose VALUE is `{segment, offset, attempts, reason, first_crash_ts, name, target, targets, worker_type, source_log}` — plus, when applicable, `cache` (the snapshot nodes' co-committed state, keyed by node name) and `quarantined` (the cursor sits on an already-dead-lettered message; drop it on re-encounter — see [ADR-12](architecture-decisions.md#adr-12-dead-letter-poison--crash-lifecycle)) — routed through `Partition::fill` (so it lands as the canonical packed wire format, not raw JSONL) and `flush`ed immediately. On restart `load_offsetlog()` reads the newest segment's last line, `Message::unpacked`s it, and decodes VALUE to seed the cursor. An empty `$offsetlog_dir` disables the offsetlog entirely (ephemeral readers like the cli's `reply-in`). No special class.

Its retention geometry is deliberate: `OFFSETLOG_SEGMENT_SIZE = 1` makes one checkpoint one segment one **keyframe**, which is what the time-travel debugger seeks by; the rest keep 10 keyframes minimum, target 30, hold anything younger than 5 minutes, prune past 15, and hard-cap at 60. A 1-byte threshold spams no empty segments, because `do_rotate()` adopts the still-empty newest segment on the first commit and only rotates once it has content.

## Consumer + Tail

**Consumer** tails a source Partition and commits its cursor `{segment, offset, attempts, reason, first_crash_ts, ...}` to its offsetlog (itself a single-partition Partition). On restart, it reads the newest offsetlog entry to seed the cursor. It is a `Timer_Node` that `use`s two traits: `Durable_Reader` (the offsetlog cursor, the timer-driven buffered pump, and the time-travel debugger) and `Dead_Letter_Queue` (quarantine + attempt accounting).

```php
$c = new Consumer_Node();                              // no-arg ctor; config is positional via arguments()
$c->arguments( [ $source_dir, $offsetlog_dir, $deadletter_dir ] );  // token array
$c->next_offset( 'start' | 'recent' | 'end' | ['segment'=>, 'offset'=>] );  // seek
$c->poll();         // read new bytes, re-emit each line's Message, advance cursor
$c->checkpoint();   // append a {segment, offset, attempts, reason, first_crash_ts, ...} TM_STRUCT to offsetlog
```

`poll()` reads at most one `READ_BLOCK_BYTES = 65536` block per tick, splits the buffer on `\n`, leaves the trailing partial, and for each complete line `Message::unpacked`s it (Partition wrote a packed Message per line), stamps its own name onto FROM, and forwards via `parent::fill`. The position breadcrumb goes in **ID** as `"{segment}:{offset}:{length}"` — **NOT KEY**. Overwriting KEY would destroy the producer's partition-routing key (rid / handler) and silently break multi-partition queues and RequestBuilder's rid grouping. (Cursor management consumes only the crumb's START — advance-on-next; readers accept a two-part crumb — length is still stamped for SSE_In's eager reconnect.) Corrupt/unparseable lines are quarantined to the `:deadletter` sibling (raw bytes preserved; the cursor still advances) rather than aborting the poll — see [ADR-12](architecture-decisions.md#adr-12-dead-letter-poison--crash-lifecycle) for the full poison lifecycle.

**Multi-writer seal-grace.** A log many processes append to (the firehose) needs `set_multi_writer( true )` — the `set_multi_writer` config verb, or `command_node <consumer>:config set_multi_writer true` in a topology. A peer can keep appending to segment N for up to `Partition::DRIFT_RESCAN_INTERVAL_SECONDS` after N+1 appears, so the reader refuses to advance off a superseded segment until its size has held steady for `SEAL_GRACE_SECONDS = 2.0`; without the opt-in a straggler's final line is orphaned. A single-writer log leaves the flag false and advances the instant the next segment exists, so it pays no latency.

**Time travel.** `Durable_Reader` turns the offsetlog's keyframes into a debugger: `PAUSE` stops the poll timer and holds the cursor, `STEP` emits exactly one message (forcing line granularity, restoring the production `line_mode` on resume), `SEEK_FRAME <segment>` jumps to a keyframe by its offsetlog segment id — restoring that frame's co-committed snapshot state and repositioning the read cursor — and `PLAY` truncates the offsetlog after a rewind point (so the re-written timeline stays monotonic) and re-arms. The verbs are hidden `{name}:config` commands driven by the Inspector's transport bar; `time_travel_metadata()` feeds it the frame list, live cursor, and polling state.

**Tail** is a subclass of **Consumer** (`Tail extends Consumer`) that emits each complete line's raw bytes as a `TM_BYTESTREAM` (newline restored, FROM-stamped at this I/O boundary) instead of unpacking a packed Message. It follows two source shapes, chosen by the explicit `source_mode` argument, and fails loud on any other token:

- **`segmented`** (the default) reads a **Log**'s `{file}.{seg}` segments through a `Log_Node` source, so the whole inherited Consumer read model applies. Here Tail overrides only the per-line emit seam, `forward_line()`; the buffer/cursor scan that hands it each line stays in `drain_buffer()`, so it gets line_mode for free.
- **`file`** follows a SINGLE filename with `tail -F` logrotate semantics: it holds the open handle, drains a rotated-away generation to EOF before reopening the path at offset 0, resets on in-place truncation, and tolerates a missing path. The inode occupies the same cursor slot a segment id does, so `<inode>:<offset>:<length>` rides the existing offsetlog frame and DLQ machinery with no new field. A resume validates the persisted cursor against the current file (inode match, size, and a newline at `cursor - 1`) and restarts from 0 on any mismatch — at-least-once, never cross-generation hunting.

Both shapes **inherit** the durable offsetlog cursor, snapshot co-commit, dead-letter lifecycle, checkpoint cadence, and time travel. A fresh Tail with no durable cursor defaults to **end-of-file** (`default_offset` → `'end'`) — only bytes appended after start — and resumes from its offsetlog checkpoint on restart. `make_node Tail <name> <source_file> [offsetlog_dir] [deadletter_dir] [source_mode]`.

## Other Node Primitives

**Tee** is the fan-out node. Its target LIST and the pruning live in the `Fanout_Targets` trait, which any node that fans out uses — `Core::class_fans_out()` asks about the trait, not descent from `Tee_Node`, because the command minters that sign one message per spoke are `Timer_Node` subclasses. Each `fill()` reads the live-target list, copies the message per target with `TO=target` (if TO was empty) or `TO=target/originalTO` (path-prepend if TO carried subpath), and forwards through `sink` (typically `_router`). Every target is attempted: a throw is caught, the one that `outranks()` is deferred, and it re-throws after the loop — completing the fan-out is what preserves at-least-once ([ADR-14](architecture-decisions.md#adr-14-cooperative-stop-propagates-through-broad-catches)). Pruning is a liveness check on every read of the list, not "after a failed dispatch": it tests the FIRST path segment of each target, so a bare-name target is dropped when its node has disappeared, and a **path-shaped** target (has a `/`, e.g. `_repl/_output/12345`) is kept while its head node exists and dropped when the head is absent. Tee declares no registrations, commands, or requests of its own.

**Hook** is the WordPress-extensibility bridge. Action mode fires `do_action( $hook_name, $value )` and forwards the message unchanged; filter mode forwards `apply_filters( $hook_name, $value )` as the new VALUE, restamping TYPE to TM_STRUCT for a list result and TM_BYTESTREAM otherwise. Plugins observe completed requests, transform job payloads before routing, etc., without touching topology files. `hook_name` is a required argument — a bare `make_node Hook` throws.

**Callback** is the closure-as-Node adapter — a one-line `fill()` that invokes a stored closure. Useful for inline transforms in tests and small topology stitches without writing a whole subclass.

**Echo** is a routing helper that re-addresses messages on the way through. Both `target` and `TO` set → `TO = target/TO` (path-prepend). Both empty → `TO = FROM` (return-to-sender along the trail). Otherwise TO is unchanged. TM_ERROR with empty TO is dropped rather than bounced (the producer isn't expecting the error trail).

**Log** is the file-writer counterpart to Tail and a subclass of **Partition** (`Log extends Partition`). It differs from Partition at two seams only: it writes each fill()'d message's **VALUE** (the producer's payload, not the packed envelope) and lays its segments out as `{file}.{seg}` (`out.log.0`, `out.log.1`, …) rather than `{dir}/{seg}.log`. Args: `make_node Log <name> <file> [segment_size] [min_segments] [num_segments] [max_segments] [min_lifetime] [lifetime]`. Rotation is monotonic and automatic when a segment passes `segment_size`; retention is Partition's three-rule scheme (`num_segments` count target / `lifetime` age / `max_segments` hard cap). It inherits the rotate lock, `allow_large_writes()`/`void_warranty()`, and the 4KB PIPE_BUF cap — an oversize VALUE is dropped unless the cap is lifted. TM_ERROR/TM_EOF/TM_REQUEST are dropped (append-only; EOF never closes it; segmentation is size-driven, so there is no rotate request).

**Timer** (and its subclass **Router**) is the time-driven base, with two scheduling modes. `set_timer( $ms, $oneshot )` below 1000ms takes its **own Event_Framework slot**; no interval or one of 1000ms or more takes the **Router hitchhike** instead — the node registers itself on `_router`'s TIMER channel by name, and `fire_cb()` throttles to `interval_ms` (a hitchhiker therefore needs a name, and needs `_router` to exist). Either way `fire_cb` is the framework-side hook and `fire()` is the override point for subclasses; `timer_mode()` reports which mode is live, and `list_timers` shows it in the MODE column. Default `fire()` emits a TM_BYTESTREAM carrying the current timestamp at `target` and notifies `FIRE` listeners — unless the node has no target and sinks straight into a Command_Interpreter, which would be pure spam.

**Grep** (`Grep_Node`) is the payload filter: it forwards a message only when its VALUE matches a bracket-delimited PCRE (`arguments()` sets the pattern; default matches everything), drops the rest. Category `Filtering`.

**Tap** is `Tee` with *hard* addressing plus passthrough — a `Tee_Node` subclass for observability fan-out: it copies the message to each tap with `TO=target` exactly (no remainder to route on) AND forwards the original down `sink`. Failure handling is Tee's: attempt every tap, defer the throwable that `outranks()`, then perform the passthrough and re-throw. The passthrough runs first because it IS the pipeline — a `Worker_Should_Stop_Clean` commits PAST the message, so aborting early would drop it from the main path entirely (see [ADR-14](architecture-decisions.md#adr-14-cooperative-stop-propagates-through-broad-catches)).

**Stderr** (`Stderr_Node`) is a bare diagnostic sink: it routes a TM_BYTESTREAM VALUE through the node's stderr chain (`Node::stderr` → `Core::stderr`: node-name midfix, dmesg ring, `error_log`, debug.log, real stderr) and writes nothing else. Splice one on the end of a debug tap (`Tee → Dumper → Grep → Stderr`) so rendered/filtered lines land in the diagnostic log without polluting the STDOUT data path. Only TM_BYTESTREAM is written — put a Dumper in front to render structured types first.

**Struct_To_JSON / JSON_To_Struct** are the round-trippable serialization pair. `Struct_To_JSON_Node` serializes a TM_STRUCT message's array VALUE into a TM_BYTESTREAM JSON line (splice in front of a Log or terminal so a struct producer's payload can be written as a line); `JSON_To_Struct_Node` is the inverse on the read side — decode a JSON line back into a TM_STRUCT array (a line that isn't a JSON array/object passes through as a plain bytestream).

**Remote reader family (SSE-pull aggregation).** `Remote_Source_Node` is a self-sufficient, topology-visible SSE-pull node: it extends `Remote_Link_Node` (the channel layer — `SSE_In_Node` + `HTTP_Out_Node` patrons, heartbeat, reconnect, status) and `use`s the same `Durable_Reader` trait Consumer does, so each raw SSE `msg` payload appends to the pump buffer and the tick drains it exactly like a Consumer — with the same durable offsetlog cursor, time travel, and dead-letter/crash lifecycle ([ADR-12](architecture-decisions.md#adr-12-dead-letter-poison--crash-lifecycle)). Only two seams differ from a disk reader: the refill arms an async cURL valve rather than reading a block, and the cursor comes from each message's own breadcrumb rather than the local buffer chop. Credentials and URL come from the `Vault` entry the node's `<vault-id>` argument names; a missing entry leaves it disconnected rather than building mis-configured patrons. These are the cURL-driven nodes that register handles with the drain loop (see [Event_Framework](#event_framework)).

**Topic_Probe** (`Topic_Probe_Node`) is a periodic Consumer-stats sweep: each worker process runs one, sweeping ITS local Consumers (`Core::$nodes_by_name`) and emitting one positional `Probe_Record` per tick — cursor, partition end, bytes behind, message count — into the shared `topicprobe.p0` log. The default cadence is 15s, and since that exceeds 1000ms it rides the Router hitchhike. That log is the ONE live-position source: `wp nodes status` and the dashboards read it, not memcache. **Job_Probe** (`Job_Probe_Node`) is its counterpart for `Job_Worker`s, sweeping per-identity job stats into `jobstats.p0` — one record per Consumer for the first, many per worker for the second.

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

**FROM stamping at I/O boundaries only**: the substrate's source nodes — **Tail** (`forward_line` sets FROM directly, honoring `stamp_override`) and **Consumer** (`stamp_message`, using `stamp_override` when set — the worker IPC input Consumer stamps `_repl`) — stamp FROM as messages enter the graph. Internal nodes (Tee, Hook, and any application Node subclass) do NOT stamp. A message flowing `tail -> tee -> request-builder` carries `FROM=tail`, NOT `tee/tail`. (There are no `Job` or `Connector` node classes here, so don't look for their stamping behavior either.)

## Event_Framework

Per-process drain-loop singleton. Manages timers and one shared cURL multi handle. There is no FD-registration path: local file polling (Tail, Consumer, the cli's stdin reader) is driven by `set_timer`, so the loop always has exactly one blocking waiter regardless of which I/O sources are active.

cURL handles (used for HTTP/SSE clients) hide their underlying socket FDs behind cURL's API and have to be driven by `curl_multi_select` and `curl_multi_exec`. Each node registers its own **easy** handle; they all attach to one lazily-created multi handle, and a completion is routed back to the owning node's `on_curl_message()`. When at least one easy handle is registered, the loop sleeps on `curl_multi_select` (timeout = next-fire deadline); otherwise it sleeps in `usleep` for the same duration. Either way a soon-firing timer wakes the wait promptly.

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

**`pump()` is the cooperative-stop seam.** A long in-process job starves the drain loop, so the worker's own deadline would pass unnoticed; `Event_Framework::pump()` re-runs the parked continue-predicate from inside that job (Partition calls it on every write) and raises `Worker_Should_Stop` when it says stop. It is throttled to once per `PUMP_INTERVAL_S = 1.0` against the live clock — `Core::$now` is frozen for the duration of a blocking job, so routing through `right_now()` also un-freezes message timestamps at pump cadence. It no-ops unless a cooperative-stop drain is active, which is why `drain()` takes the flag: only `Worker_Base` opts in, so cli and SSE drains can never be thrown out of. A stderr write is not a stop boundary (logging the stop would self-throw), so `pump()` returns early while `Core::in_stderr()`.

Registration API:

```php
// Timers: subclass Timer_Node and arm the timer FROM the node — never call
// Event_Framework's timer method directly. Timer_Node::set_timer() picks the
// mode (own slot vs Router hitchhike) and hands $this to Event_Framework.
class My_Timer_Node extends Timer_Node {
    protected function fire(): void { /* periodic work */ }
}
$node->set_timer( $interval_ms, $oneshot = false );   // Timer_Node::set_timer
$node->stop_timer();                                  // Timer_Node::stop_timer

$ef->drain( $should_continue, $cooperative_stop = false );
$ef->pump();                              // re-check the predicate mid-job
$ef->register_curl_easy( $node, $easy );  // \CurlHandle, attached to the shared multi
$ef->unregister_curl_easy( $easy );
$ef->curl_handles();              // per-node rows for `list_handles`
$ef->install_signal_handlers();   // SIGTERM/SIGINT -> Core::$shutting_down
$ef->is_running(): bool;          // true while inside drain()
```

PHP I/O quirks the implementation handles:

- `fseek($fp, 0, SEEK_CUR)` before `ftell` — PHP's stdio caches position; without the no-op seek, `ftell` returns stale values after external appends.
- `clearstatcache(true, $path)` before every stat in poll loops — PHP caches stat results aggressively per request.

## Lock

Mkdir-based advisory locking with a PID-stamped heartbeat file. Used by workers and `Partition::allow_large_writes()`. Atomic on every filesystem we ship on (NFS, tmpfs, ext4 — `mkdir(2)` is the POSIX-mandated atomic primitive). No `flock`, no daemon, no DB row.

The surface (`includes/class-lock-node.php`):

```php
class Lock_Node extends Node {
    public const STALE_TIMEOUT  = 60;          // seconds without heartbeat → stale
    public const ORPHAN_GRACE_S = 1;           // dir-but-no-heartbeat grace before stealing
    public const HEARTBEAT_FILE = 'heartbeat'; // contains the holder's PID
    public const STARTED_FILE   = 'started';   // acquire() timestamp
    public const RESTART_FLAG   = 'restart';   // restart sentinel

    public function __construct( string $lock_path, int $stale_timeout = self::STALE_TIMEOUT );

    public function acquire( int $max_wait_ms = 0 ): bool;
    public function acquire_failure(): string;    // 'lock_held' = contention; anything else is an I/O diagnosis
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

**Acquire**: atomic `mkdir`. If the dir already exists, `try_steal_orphan_or_stale()` decides whether to take over — an *orphan* dir (no heartbeat file → possible mid-acquire) is honored for `ORPHAN_GRACE_S` then stolen if still empty; a *stale* dir (heartbeat mtime older than `stale_timeout`) is stolen immediately; otherwise back off, and either return false or retry every 100ms until `$max_wait_ms`. On success it writes the `heartbeat` (PID) + `started` (timestamp) files and clears any inherited `restart` flag. The steal itself is a `rename()` of the dir aside, then a `mkdir` of the canonical path: of two racers exactly one rename succeeds, and the single-holder guarantee still rests on that final `mkdir` — a third process racing the brief absence hits the same path and one of them loses. `acquire_failure()` distinguishes contention (`lock_held`) from an I/O refusal, which is what lets a skipped spawn stay quiet while a broken directory gets logged. A symlink planted at `heartbeat` / `started` is refused rather than followed.

**Heartbeat**: workers touch their heartbeat every 10s during drain. `heartbeat()` calls `verify_ownership()` first; if the on-disk PID no longer matches `getmypid()` (someone stale-stole us), it flips local `is_held=false` and returns false so `release()` becomes a no-op and the displaced holder stops writing. `Partition::fill()` calls `heartbeat()` inline on the no-event-loop large-write path.

**Stale takeover**: once `STALE_TIMEOUT` elapses without a refresh, the next acquirer steals the dir and the displaced holder fails its next heartbeat and exits. This is what the peer scan relies on, and it's how concurrent `wp nodes restart` invocations don't fight over slots.

**`should_restart()` / `request_restart()`**: writes `$lock_path/restart` as a sentinel. Workers poll `should_restart()` on every drain tick and exit cleanly when the flag is present **or** the heartbeat file is gone / its PID no longer matches (PID-content theft). The flag is cleared on the next acquire (`write_acquire_files` unlinks it). Static `request_restart_at( $lock_dir )` lets a stranger (admin request, a peer's scan, the fleet sweep) signal restart into another process's lock dir without a `Lock_Node` instance.

## Worker Lifecycle

Each worker is a cron-style PHP process spawned via HTTP POST, going zombie via `ignore_user_abort(true) + fastcgi_finish_request()`. Lifetime ~595s (just under 10 min, sized for Atomic's 15-min cap with margin).

```php
// Worker_Base::execute( callable $topology, string $spawn_url, string $token )
if ( ! $this->acquire() ) return [ 'status' => 'skipped', 'reason' => $this->lock->acquire_failure() ];

register_shutdown_function( /* handoff + cleanup_all_nodes + release + self_respawn */ );
usleep( LOCK_CHECK_GRACE_S * 1e6 );             // 250ms grace: let predecessor exit

try {
    $ci = $this->build_scaffolding();
    $this->run_topology( $topology, $ci );      // a bad .tsl throws: log, release, NO respawn
    $this->baseline_memory = memory_get_usage( true );
    $ef = Event_Framework::instance();
    $ef->install_signal_handlers();
    $ef->drain( fn () => $this->should_continue(), cooperative_stop: true );
} finally {
    $this->shutdown_handoff();                  // graceful / fair-shot checkpoint per durable reader
    Core::cleanup_all_nodes();                  // tear down Partitions -> release write_locks
    $this->release();                           // release BEFORE spawn
    $this->self_respawn( $spawn_url, $token );  // POST /spawn (fire-and-forget)
}
```

Lock release happens **before** the spawn POST inside `finally`. Because the spawn handler is fire-and-forget, the new worker reaches `acquire()` before this process has even fully exited; the slot is immediately free. No retry loop, no waiting.

The `register_shutdown_function` + `finally` block both check `$this->shutdown_handled` so a clean `exit()` doesn't double-run the cleanup; whichever path fires first wins.

`should_continue` returns false when:

- max_runtime (~595s) reached — category `timeout`.
- memory ≥ `MEMORY_WATERMARK_PCT = 0.80` of `memory_limit` (PHP fatal-on-OOM bypasses `finally`; bail proactively) — category `memory`.
- the lock is no longer ours, its directory is gone, or `Lock::should_restart()` is set.
- DB connection failed `DB_CHECK_MAX_FAILURES = 3` times consecutively.

The predicate runs on every drain iteration, and again from `pump()` (at most once a second) while a long job is starving the loop. Two of its branches are throttled inside it: the heartbeat touch fires every `HEARTBEAT_INTERVAL_S = 10` seconds, the DB liveness probe every `DB_CHECK_INTERVAL_S = 30`. `LOCK_CHECK_GRACE_S = 0.25` is not one of them — it is the one-shot pre-drain pause that lets a predecessor finish exiting before this process starts work.

The first two categories are *cooperative* stops, and the shutdown handoff treats them differently from an operational one: `timeout` and `memory` route each durable reader through the fair-shot rule, which strikes an in-flight poison message and clears an innocent one; everything else is a clean graceful checkpoint ([ADR-12](architecture-decisions.md#adr-12-dead-letter-poison--crash-lifecycle)). A `memory` stop whose fresh post-reset baseline was already past `BASELINE_WATERMARK_PCT = 0.50` blames a leak or an undersized `memory_limit` instead — it alerts and strikes nothing. On a FATAL shutdown (`is_fatal_shutdown()`) the handoff is skipped entirely, which is what lets a deterministic poison message climb toward the crash threshold.

The shutdown handler catches `exit()` / `die()` calls that bypass `finally`, releases the lock, and lets a peer respawn it quickly.

**Memory watermark rationale**: `wp_generate_attachment_metadata` loads full-resolution images into GD; per-job residue accumulates; PHP's fatal-on-OOM is uncatchable and bypasses `finally` / `self_respawn` / offsetlog flush. 80% watermark lets workers exit cleanly before OOM.

## Fleet Revival

There is no supervisor process. Every worker revives its peers, and WP-Cron catches a fleet
with nothing left running.

`Worker_Base::build_scaffolding()` mounts `_fleet` (`Fleet_Node`, a `Timer_Node`) alongside
`_router` and `_command_interpreter`. It hitchhikes the router heartbeat but arms at
`SCAN_INTERVAL_MS = 15000`, so `Timer_Node` throttles it to one pass every 15 seconds:

```
every 15s:
    if a reload watermark landed in this worker's lock dir:
        Config::reset() + notify RELOAD
    re-read the active fleet, refuse a write-conflicting set,
    defer newly-appeared types NEW_TYPE_SPAWN_DELAY_SCANS = 1 scan,
    drain every worker if the last topology was deactivated
    for each active-fleet worker, at most MAX_SPAWNS_PER_TICK = 4 per pass:
        if !lock_dir OR heartbeat > worker.stale_timeout:
            if last_spawn for this worker > 15s ago, and past any new-type deferral:
                POST /spawn   (fire-and-forget)
```

A faster scan would only reach a MISSING lock dir sooner — the stale-heartbeat case is
dominated by `stale_timeout` (60s default) either way — and a crashed worker's queue is
durable, so that lag costs nothing. `Config::reset()` is gated on the watermark because it
fires `Config::RESET_ACTION`, whose subscribers drop the parsed-TSL cache: unconditionally,
every worker re-globs both topology directories and re-parses every `.tsl` each pass to reach
the value it already had. The watermark is the signal that makes the cache stale, so with no
watermark the cached fleet is current by definition.

The scan is revival and nothing else. Housekeeping runs in the cron pass below, so it depends
on no live worker — which is the point: retention and orphan reaping run even when the fleet
is down.

**Spawn endpoint auth**: an HMAC token rotating every `Internal_Request_Token::WINDOW_S = 10` seconds, accepted for the current AND previous window for race tolerance. `Internal_Request_Token` keeps the purposes apart — a spawn token is not a health-cache token, because the purpose string is inside the HMAC:

```php
$window = (int) floor( $now / 10 );
$token  = hash_hmac( 'sha256', "newspack_nodes_{$purpose}:{$window}", $salt );  // purpose: spawn | health-cache
```

`Spawn_Controller` also accepts an external request from a `manage_options` user with a valid WordPress nonce, behind a 2-second per-user rate limit, and validates the type and partition against the active fleet before spawning anything.

**Spawn rate limit**: `MIN_SPAWN_INTERVAL_S = 15` per `{type}|{partition}` key. Prevents thundering-herd respawns when locks flap, and it is what makes N peer scanners as safe as one scanner was. The **endpoint** is the one gate every spawn path crosses — self-respawns, peer scans, and cron alike — so it both checks the window and records the accepted spawn, persisted through `Cache_Backend::shared_first()` (transient fallback) at twice the interval. A throttled request answers 429. A scanner records its own POSTs in memory only: persisting there would make the endpoint reject the very POST the record announces.

**Worker-registry refresh**: plugin activation/deactivation changes which workers are registered via the `newspack_nodes/topologies` filter. Each `Fleet_Node` rebuilds worker descriptors from current filter values every 15s, so newly-registered workers get spawned and deactivated workers get their locks flagged within one window of the change. A type that has just appeared is deferred `NEW_TYPE_SPAWN_DELAY_SCANS = 1` scan interval so a still-exiting predecessor can flush; a cold start skips the deferral. The scan also refuses to spawn a set with a topology write-conflict (two fleets on one partition), and the cron pass's `Spawn_Coordinator::reconcile_lock_dirs()` reaps lock dirs outside the active fleet plus any `*.lock.d.stealing.*` scratch a killed steal leaked.

**WP-Cron reconciliation pass**: the `newspack_nodes/reconcile` action runs on a registered 60-second schedule (`newspack_nodes_minute`). `Bootstrap::reconcile_fleet()` runs five steps and returns; it takes no lock and enters no loop. Spawn (`Spawn_Coordinator::spawn_due_workers()`) is FIRST — it is the revival path and the only time-critical step — then lock-dir reconcile, log retention, orphan-IPC reaping, and `do_action( 'newspack_nodes/periodic' )` (which carries alert emission and the delayed-jobs sweep). Each step is wrapped alone, so a third-party `topologies` provider or `periodic` subscriber that throws costs only its own step. Steady state, every live worker's peer scan keeps the fleet up and the spawn step finds nothing due, while the four chores get the cadence they actually need. `wp nodes doctor`'s `housekeeping` result reports whether this event is scheduled, because a missing one stops all of it silently. Because a vetoed schedule is silent, `Bootstrap` logs any short-circuit of this event on `pre_schedule_event` / `pre_reschedule_event` / `schedule_event` with the callback chain that swallowed it, and `admin_init` re-arms the event if it went missing. On multisite only the main site runs the fleet: locks, IPC, and logs carry no blog namespace.

**On-demand workers**: a topology can scale to zero instead of staying resident, and
`var on_demand_idle = <seconds>` (default 5) sizes the window. The value rides the `stale_timeout`
path — `Topology_Registry::synthesize_entry()` into the catalog entry, `Bootstrap::expand_workers()`
onto each worker descriptor — and changes three places that otherwise read absence as death:

- `Spawn_Coordinator::worker_needs_spawn()` returns false for a cleanly MISSING lock dir. A
  *stale* one still spawns: staleness means a worker died holding it, which is a crash whether or
  not the type is on-demand.
- `Alerts::evaluate()` raises nothing for such a worker (`Workers_CI` derives the `idle` flag once,
  so alerting and the dashboards cannot disagree about what absence means).
- `wp nodes status` renders it `idle`, distinct from `live`, `stale` and `down`.

The worker exits when EVERY `Idle_Reporter` in its graph has been idle for the whole window, timed
from the LATEST reporter's `idle_since()` — the same fold `SSE_Out_Node::opened_at_eof_since()`
applies to its consumers. `Consumer_Node` already implemented that method and simply opts in.
Nodes report their own idleness so the substrate names no application class, and a graph with no
reporter has nothing to measure and never idle-exits. EOF alone would not do: a request that logs
its start and then goes quiet leaves a builder holding an envelope while its consumer sits at EOF,
and exiting there abandons a started span. An idle stop sets stop category `idle`, which is the one
category `Worker_Base::should_self_respawn()` refuses — respawning would undo the exit.

Bringing it back happens at the WRITE boundary. Every producer reaches disk through a
`Partition_Node` — `Job_Intake` writes one, a `Topic` fans into them, a `Log` extends one, a
worker's IPC is one — so `fill()` marks the resolved directory and a flush wakes whoever tails it.
Marking is deliberate cheap (no lookup, no I/O) because it runs per message; the flush runs on the
router tick inside a drain loop and at shutdown in request scope, so a web request never pays it on
the way out. Putting the wake in producer helpers instead covered only the FIRST hop — a job routed
firehose → jobs, or drained jobintake → jobs, landed where nothing woke its reader.

`Bootstrap::on_demand_wake_map()` answers which on-demand workers tail a directory. It is built by
substitution through `Core::resolve_partition_template()`, never by parsing a `.p<N>` out of a
path, so a TSL template that puts `<partition>` elsewhere still resolves; it is cached in APCu via
`Cache_Backend::local_first()`, keyed on the active-topology option with a 60s TTL for edited
`.tsl` files. IPC takes the one branch it needs — its path names its own worker, and that layout is
the substrate's rather than a user's template. A partition nothing tails is absent from the map, so
offsetlogs, deadletter dirs and scratch need no exclusion rule; a delayed job wakes nothing because
nothing consumes `jobdelay`.

**Two-tier safety net**:

- Workers self-respawn, and every live worker's `_fleet` scan catches a peer whose lock is missing or stale.
- WP-Cron catches a fleet with nothing left running (cold start, `kill -9`, host outage).

Supervision survives the loss of any single process; only total fleet death falls through to cron cadence.

## Job_Worker_Node

`Job_Worker_Node` (substrate since 0.12.0; was an application node) is the generic async-job dispatch Node. It keeps two handler maps — `local_handlers` and `remote_handlers` — eagerly loaded in the constructor from the `newspack_nodes/job_handlers` and `newspack_nodes/remote_job_handlers` filters (by topology-evaluation time `plugins_loaded` has fired, so every registered handler is in place; eager load saves a `load_handlers` line in every TSL). Each `fill()` invokes the matching handler as `( array $parameters, string $id )` — where `$id` is the entry's top-level `id` (`''` when absent) — bracketed by `do_action( 'newspack_nodes/job_worker/before_job', $handler, $id )` and `…/after_job` ( `$handler, $outcome, $id` ); the after-action always fires (even when the handler throws) so applications can hook per-job request context (logger suspend, synthetic `$_SERVER` rewrite) without that being a substrate concern. A shorter callable or listener ignores the extra args, so legacy one-arg handlers and `accepted_args=1` listeners keep working.

After each job it bumps counters, `gc_collect_cycles()`, and — every `cache_flush_interval` jobs (its one positional argument, `CACHE_FLUSH_INTERVAL = 50` by default, clamped to at least 1) — `wp_cache_flush()`, because an object-cache flush extends per-process runtime by orders of magnitude. Memory is the *worker's* business, not the node's: `Worker_Base::should_continue()` owns the 80% watermark that ends the process before PHP's uncatchable fatal-on-OOM bypasses cleanup. A `GET_HEALTH` request (declared in `node_schema()['requests']`) reports memory used and limit, handler counts, cache-flush progress, and the counter.

A throwing handler is poison by default — it propagates to the Consumer, which dead-letters the entry ([ADR-12](architecture-decisions.md#adr-12-dead-letter-poison--crash-lifecycle)) — unless the entry opted into retries. With `retries` set and attempts left, the job is re-parked in `jobdelay.p0` at `RETRY_BASE_S * 2^attempt` seconds, capped at `RETRY_MAX_S = 3600`; a failed requeue write falls back to the poison path, because a job must never vanish into a swallowed error. An entry carrying a `batch` id settles its fan-in counter on completion (a poisoned member deliberately does NOT settle — the crash lineage re-runs it, and double-settling would miscount), and the decrement that reaches zero fires `newspack_nodes/job_worker/batch_complete` plus one `alerts.p0` row. Per-identity counters (`handler:id`) accumulate in memory and are swept into `jobstats.p0` by a `Job_Probe`, exactly as `Topic_Probe` sweeps Consumers.

Ships with a stock `topologies/job-worker.tsl` in the substrate's built-in dir (`Topology_Registry::register_builtin_dir`, wired in `Bootstrap`; `register_stock_dir` is the per-plugin analog used by `register_plugin`).

## REPL: wp nodes cli

`wp nodes status` (alias `ls`) — fleet overview: every catalog topology with per-partition State (`live`/`stale`/`down` from the lock heartbeats), heartbeat age, uptime (the lock dir's `started` file), then the consumer-lag table from the Topic_Probe snapshot.

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
(anonymous Shell)  ->  _shell (Tap)  ->  _command_interpreter  ->  _router
                                                                     |
                                                    _output (Dumper) -> _stdout (TTY_Out)
```

`_router` is a `Router_Node` and `_command_interpreter` a `Command_Interpreter_Node` sinking into it. `_shell` is a `Tap_Node` — the console tap, there so a session can watch what the Shell sends — and the `Shell_Node` itself is **anonymous** (`Shell::name()` throws on any name; see [ADR-7](architecture-decisions.md#adr-7-sink-vs-target-and-tofrom-replies) on unaddressability as a security boundary) and sinks into it. `_output` is a `Dumper_Node` sinking into `_command_interpreter` with `target = _stdout`, so its rendered lines route to the `TTY_Out_Node` writer by path like everything else. Replies reach it because the Shell stamps `FROM = _output/<pid>`. (Topology lines and `make_node` refer to these by their *shell name* — the class short-name minus `_Node`: `Router`, `Command_Interpreter`, `Dumper`, `Tap`.)

**Attached mode** (`wp nodes cli firehose-workers.p0`) — the SAME local nodes, plus the IPC pair and a `path` cd. A `Partition_Node` named after the worker (e.g. `firehose-workers.p0`) writes to the worker's input IPC dir (sink = `_command_interpreter`). An unnamed `Consumer_Node` (the `reply-in`) tails the worker's output IPC dir with `next_offset('end')` and `set_stamp_as( '{worker-id}' )`, sinking into an anonymous relay `Node` whose `target` is `_output` and whose sink is `_router` — the relay is what turns each replayed line into an addressed message without giving the Consumer a name of its own. The Shell's sink stays `_shell`; the cd is purely `$shell->path = "{worker-id}"`, so a default command carries `TO={worker-id}` and `_router` dispatches it to the worker-id Partition (which writes it to disk) instead of running locally. The Shell signs every command it mints inline via `Command_Auth::sign()` — there is no separate signer Node — so locally-minted commands carry the HMAC envelope verifier CIs require.

```
local Shell -> _shell -> _command_interpreter -> _router -> worker-id Partition (on-disk) -> worker input
worker output -> reply-in Consumer (on-disk) -> relay -> local _router -> _output (Dumper) -> _stdout
```

IPC layout (always single-partition):

```
{base_dir}/ipc/{reader}/input/{seg}.log     # shell -> worker
{base_dir}/ipc/{reader}/output/{seg}.log    # worker -> shell
```

Reader id form: `{type}.p{N}`, e.g. `firehose-workers.p3`. Dot-and-`p` keeps it a single path segment — `firehose-workers/3` would route as "find node `firehose-workers`, pass remaining path `3`," which is wrong.

**No cryptographic handshake gates the IPC directory itself** — filesystem permissions on `/tmp/newspack-nodes/ipc/` do (which is why `wp nodes cli` refuses to run as root: root-owned IPC dirs lock the web-user fleet out). The commands written into it are still signed and verified like any other wire command. `CLI::attach_to_worker( $reader_id )` resolves the IPC paths: it parses `{type}.p{N}`, checks the worker is registered by `is_dir( {base}/locks/{reader_id}.lock.d )`, and throws `InvalidArgumentException` with `"no worker '{reader_id}' (run \`wp nodes status\` to list active workers)"` if the lock dir is absent (staleness is NOT checked — a mid-restart worker still attaches). It returns `{input, output, type, partition}`. `build_repl_graph()` then constructs the IPC pair directly — `new Partition_Node()` configured via `Worker_Base::ipc_partition_args( $ipc['input'] )` (the full seven-slot geometry, so a scratch partition is bounded by COUNT and never inherits an hour-long `min_lifetime` from config) and `new Consumer_Node()` against `$ipc['output']` — not via `make_node`.

**Wire / dispatch specifics**:

- **IPC messages use TM_COMMAND**: replies route via the FROM/TO breadcrumb — Shell stamps FROM=`_output/$pid`, the worker's Command_Interpreter_Node sets TO=`$message[FROM]` when responding, and Router dispatches the reply by name. No ID-correlation table; the path itself is the addressing.
- **`Command` struct in VALUE is a LIVE PHP array, NOT JSON-encoded.** Inbound TM_COMMAND VALUE is `['name'=>, 'arguments'=>]` — `arguments` a flat **token array** (`list<string>` argv), tokenized ONCE at the Shell/producer boundary and carried verbatim (plus an `'auth'` HMAC envelope when wire-issued — see command authorization); the response VALUE is `['name'=>, 'arguments'=>, 'payload'=>]`. The struct rides through `packed()`/`unpacked()` as a nested object inside the whole-message envelope — the envelope (and the SSE/REST body) is the ONLY place JSON serialization happens. Verb results are likewise live structures; the cli Dumper json-encodes array payloads only at the render boundary. The signature has no field of its own on the message: it rides inside VALUE as `auth`, so it survives the IPC round-trip that strips `LOCAL`.
- **TO at the root prompt is empty.** Command_Interpreter_Node dispatches a TM_COMMAND only when TO is empty; non-empty TO routes through Router as a normal addressed message.
- **`pwd` reply via the `prompt` intercept**: the Shell `pwd` builtin sends a TM_COMMAND `name=pwd`; `cd` is purely local (no message). When a response carries `name === 'prompt'`, Dumper sets `$shell->prompt` and renders nothing. (The Shell does not emit a `name=prompt` command itself; that path is a convention for a worker that wants to drive the cli's prompt.)

**Shell** supports quote-aware tokenization (single, double, backtick), single-tier interpolation of `<varname>` and namespaced `<ns:key>` tokens, backslash line-continuation, and an `include` builtin. Inside a quote, `\` escapes the next char, so the tokenizer is the exact inverse of `Node::serialize_args()`/JS `serializeArg` — a token bearing whitespace, a quote char, a backtick, a backslash, or emptiness round-trips losslessly (the JS `quoteToken` delegates to `serializeArg`; there is no "unrepresentable" token). `tokenize()` yields the flat token array the command envelope carries. There are no conditionals, loops, function definitions, pipes, or `eval` — and no syntax-error rejection for them either: an unrecognized verb simply falls through as a TM_COMMAND (below). Quote-aware tokenization and line-continuation are what let a topology file parse at all — `<config:logs_dir>/jobs.p<partition>` expands the dir now and defers `<partition>` only when the author quotes it.

`include <file>` reads a file and evals each line through this same shell, as though typed. The argument is resolved as a topology NAME through `Topology_Registry` first (`include topic-probe`), then as a literal path. A repeat within the current ancestor chain is a cycle, and a file already evaluated within the current top-level script is a no-op (`#pragma once`, scoped per top-level script so a long-lived REPL can re-run an edited file). `secure` / `insecure` lines inside an included file are ignored: the policy belongs to the topology being loaded, and an include that declared one would both decide on its parent's behalf and disable `make_node` mid-load. A REPL logs a cycle and continues; `fatal_errors( true )` — what `Topology_Loader` sets — throws instead, so a mangled `.tsl` never half-loads.

Shell also intercepts the **path-composing builtins** before they reach the message bus: `cd`/`chdir` updates `$this->path` (the cwd) and emits no message; `tell_node`/`tell` (TM_INFO), `send_node`/`send` (TM_BYTESTREAM, VALUE newline-terminated), `send_struct` (TM_STRUCT, VALUE decoded from JSON — a decode error prints and sends nothing), `send_eof` (TM_EOF), `command_node`/`command`/`cmd` (TM_COMMAND), `request_node`/`request` (TM_REQUEST), `ping` (TM_PING, VALUE = now) all build TO via `prefix( <path> )`; `pwd` sends TM_COMMAND `name=pwd` with TO = `$this->path`. **A verb that matches no builtin falls through as a TM_COMMAND** with the verb as the command name and `TO = prefix('')` (i.e. the cwd itself). Every emitted message is stamped `FROM = _output/$pid`. `prefix($arg)` is just `join('/', filter([$this->path, $arg]))`, and `cd` resolves relative/absolute/`..` paths into `$this->path` with slashes trimmed.

**`print` writes verbatim; there is no `echo`.** `print <message>` sends its argument to the REPL with nothing appended — the usage line is `print "<message>\n"`, because the newline belongs in the value. This is why a `var` read of a value lacking a trailing newline leaves the prompt on the same line.

**`var` is the shell's variable scope.** Bare `var` lists every var as `name=value` (sorted); `var <name>` prints the value and *defines* it as empty if it was unset; `var <name> =` with no value **deletes** it — the branch keys on whether a value TOKEN followed the operator, so `var foo = "\n"` SETS foo empty rather than deleting it; `= .= += -= *= /= //= ||=` and valueless `++` / `--` all apply. A name followed by junk where an operator belongs is an error (`unexpected token in assignment`). A read prints its value verbatim: an empty one prints nothing, and a value with no trailing newline leaves the prompt on the same line — put the newline in the value. Interpolating a var that was never defined prints `WARNING: use of uninitialized value <name>` RAW to stderr — no timestamp, hostname, or pid — and still yields `''`; a var defined as empty is silent, and `message.*` reads are silent by design.

**Comments and escapes are resolved by the tokenizer.** An unquoted `#` comments out the rest of the line wherever it appears, not just in column 0 — and because our pipeline interpolates a whole line before tokenizing it, the comment tail is recognized at all three stages: the `;` statement split, interpolation, and tokenizing. So a comment may contain a `;` or a `<token>` without either taking effect. Outside a quote, `\X` is a literal X, which is how `\#`, `\;`, `\<`, and an escaped space reach a token. A line continues only on an ODD run of trailing backslashes: `a\\` is one escaped backslash and a complete statement.

**Escapes are quote-typed, like interpolation.** Inside double quotes `\e` `\n` `\r` `\t` expand, and `\"` `\\` `\<` `\>` unescape. Inside single quotes and backticks only `\'` / `` \` `` and `\\` unescape, so a deferred `<token>` survives verbatim. An unlisted `\X` keeps both characters. `Node::serialize_args()` emits single quotes escaping only `\` and `'` — squarely inside those rules — so the tokenizer stays its exact inverse. Backticks do NOT execute anything; they are a third quote character.

**Four `message.*` vars stamp the fields no verb takes.** At the mint, the Shell reads `message.from`, `message.key`, `message.id`, and `message.timestamp` out of var scope (`var message.key = trace-77`) and stamps them onto the outgoing message. Unset leaves KEY and ID empty, FROM at `_output/$pid`, and TIMESTAMP at the mint clock; setting FROM re-routes the reply away from this session's Dumper, which is the point of exposing it. ID and TIMESTAMP are deliberately forgeable, because replaying a message with an arbitrary ID or timestamp is exactly what debugging time-dependent or correlation-dependent nodes requires. The browser composer writes the same four fields per-message (`applyComposeFields`) without touching session vars, laid out in Message field order — TYPE(0), TIMESTAMP(1), FROM(2), TO(3), ID(4), KEY(5), VALUE(6).

**The cd to a remote/other worker is just `$this->path`** — a TO prefix, nothing hardwired. At the root prompt `path=''` so default commands carry empty TO and the local `_command_interpreter` handles them; after `cd firehose:partition` the same default command carries `TO=firehose:partition` and `_router` dispatches it. In attached mode the Shell's sink is unchanged; `build_repl_graph` sets `$shell->path` to the worker id, so default commands carry `TO={worker-id}` and `_router` routes them to the worker-id Partition that writes them to the worker's input IPC dir instead of running locally.

**`list_nodes` (alias `ls`) flags are `-a c l s t`** (matched by `^-([aclst]+)$`), NOT `-celos`: `-a` all-nodes (optional regex glob), `-c` counters, `-s` sinks, `-t` targets, `-l` = `-ct`. Without `-a`, a bare name lists nodes whose sink IS that node; no arg lists this interpreter's siblings.

**Event-loop introspection verbs (`list_timers` / `list_handles`).** Both are static Command_Interpreter_Node verbs that tabulate current `Event_Framework` state — useful for diagnosing a spinning drain loop without redeploying. `list_timers` lists every registered timer (ID, ACTIVE, INTERVAL, MODE, NEXT, ONESHOT, FIRES, TYPE, NAME); a `NEXT <= 0` with a climbing `FIRES` is a spinner, and MODE distinguishes an own Event_Framework slot from a Router hitchhike (whose NEXT reads `-`, having no own `next_fire`). `list_handles` lists the registered cURL handles the drain loop selects on (ID, COUNT msgs, TYPE, NAME). Each takes `-s`, which returns the very rows the table is built from instead of the rendered text — one source of truth, two renderings, so a view sorts them without parsing a fixed-width table. Both are mirrored in the JS interpreter (`src/runtime/command-interpreter-node.js`), where `list_handles` lists nodes holding an `EventSource`.

**Completion-query mode (`KEY='completion'`).** Both `help` and `ls` short-circuit when the inbound message carries `KEY='completion'`: they return a bare newline-separated candidate list (sorted verb names for `help`; bare node names for `ls`, honoring the same `-a`/glob/siblings selection but dropping all `-clst` columns) instead of the tabulated human output. This is the substrate's `TM_COMPLETION` protocol, implemented identically in PHP and JS (same set, same ordering) so tab-completion works against the browser-local graph and live workers alike. Tab-completion is built on top: `wp nodes cli` (readline-backed) and the browser REPL both fire a `help`/`ls` command with `KEY='completion'` through a `_completion` node, complete to the longest common prefix on the first Tab, and list the ambiguous candidates on a second consecutive Tab. The REPL also keeps a command history (up/down recall).

**`make_node` resolves by namespace prefix, not a class registry.** There is no `register_class` / `class_map`: plugins call `Command_Interpreter_Node::register_namespace( 'Newspack_Nodes\\' )` once at boot (the substrate also registers the `Newspack_Nodes\Rest\` sub-namespace so the service CIs resolve by short name). `make_node( $type, $name, ...$ctor_args )` loops the registered prefixes and constructs the first `{$prefix}{$type}_Node` that exists and is a concrete `Node` subclass — abstract subclasses (e.g. `Service_CI_Node`) are skipped (the loop continues to the next prefix), and unknown types resolve to `null` rather than fatal once every prefix has been tried. So `make_node('Tee')` → `Newspack_Nodes\Tee_Node`. The base `Node` class is a special case: `make_node('Node')` resolves to `{$prefix}Node` (no `_Node` suffix), used by routing/fan-in primitives like the SSE-stream `_default_route` whose `fill()` is just the base `target` stamp + sink forward. The inverse, `shell_name_for( $node )`, is the class short-name minus the `_Node` suffix (`Tee_Node` → `Tee`); a short name without `_Node` (the base `Node` itself, or an ad-hoc test class) is returned unchanged. `dump_metadata`'s `class` field and `dump_config`'s `make_node` line both emit this shell name, so the GUI/topology round-trip is stable across the rename.

**v0.6.0+ no-arg-ctor + arguments() convention.** Every `make_node`-constructible Node has a no-arg constructor (the two exceptions — `Callback_Node` and `Lock_Node` — are `Hidden`-category primitives built directly in PHP, never from a topology line). `make_node` instantiates with `new $fqcn()`, then calls `$node->name( $name )`, then `$node->arguments( $arg_tokens )` — where `$arg_tokens` is `array_filter( $ctor_args, '\is_scalar' )` re-indexed and `array_map`ped to strings, a flat **token array** (`arguments()` takes and returns `list<string>` argv, NOT a space-joined string) — then `$node->sink( $this )`, a uniform construction sequence. If naming or configuring throws, the half-built node is removed rather than left orphaned in the registry under a name it never earned. The base `arguments()` just stores the token array; a node wanting its declared positional args assigned to props overrides `arguments()` and runs the tokens through `parse_schema_args()` (below). Programmatic object dependencies (e.g. `Workers_CI_Node::$cli`, a registry) are public properties the caller assigns AFTER `make_node` returns — the `is_scalar` filter drops them from the variadic spread (logging once that it did) because they aren't round-trippable as `arguments` tokens.

**Redeclaring a name collapses or throws — it never silently rebuilds.** `make_node` on an existing name returns the existing node when the class AND argument tokens match exactly (so a topology included twice is idempotent), and throws `make_node conflict: '<name>' already declared as …` when either differs. That is what turns a copy-paste name collision into a boot-time error instead of a graph whose second declaration quietly won.

**`parse_schema_args()` is the single source of truth for positional config.** A schema-consuming node overrides `arguments( ?array $args )` to run the token array through `parse_schema_args( array $args )` (the `trait-schema-reflection.php` half), which walks `node_schema()['arguments']` and assigns each declared positional to `$this->{$name}` coerced to its type, then records the token array into `$this->arguments` (so `dump_config()` round-trips). A missing token falls back to that arg's schema `default`, or **throws** if the arg is `required` — so an under-argged `make_node` (e.g. omitting a required `source_file`) fails loudly at construction rather than silently deriving against declaration-default props. Tokens beyond the declared positions are ignored, and a node with no declared `arguments` is a no-op. Args are a list, not a string, so there is no empty-string early return to mirror: a subclass that needs derived state (e.g. `Partition_Node` deriving `partition_dir`) computes it after the schema assignment, gating only on the pure-getter `null === $args` call, and the `required`/`default` policy lives entirely in the schema declaration (cross-check [ADR-11](architecture-decisions.md#adr-11-make_node-construction-sequence)).

The palette catalog (`Classes_CI`'s `list` verb) reads no registry — it scans the composer classmap (`\Composer\Autoload\ClassLoader::getRegisteredLoaders()`) for FQCNs under a registered prefix whose short name ends `_Node`, are concrete `Node` subclasses, and whose `node_schema()` declares a non-`Hidden`, non-empty category. (A class that inherits `Node`'s empty-category default — e.g. `SSE_Out_Node`, a pure HTTP response writer — is not a palette participant.) This requires `composer dump-autoload -o` after adding/renaming a class so the classmap is complete.

**Service CIs (the GUI/REST verb surface).** The substrate ships nine service interpreters — `Classes_CI_Node` (`classes`), `Layouts_CI_Node` (`layouts`), `Topologies_CI_Node` (`topologies`), `Raw_Logs_CI_Node` (`raw-logs`), `Workers_CI_Node` (`workers`), `Vault_CI_Node` (`vault`), `Aggregator_CI_Node` (`aggregator`), `Settings_CI_Node` (`settings`), `Status_CI_Node` (`status`) — that derive their verb table from `node_schema()` via the abstract base `Service_CI_Node`. They are mounted onto the request-scope interpreter by `newspack_nodes_mount_substrate_cis()`, hooked on `newspack_nodes/request_graph_ready` (the action a request graph fires once it's wired). `Workers_CI_Node` needs the substrate `CLI` assigned as a public property AFTER `make_node` returns. Its `heartbeat` verb validates the exact `[ slot, owner ]` lease and refreshes it through `SSE_Slot_Pool::touch()`, which selects `Cache_Backend::shared_first()`; there is no cache handle to inject. Because `Service_CI_Node` is abstract, `make_node` skips it during prefix resolution — only the concrete `*_CI_Node` subclasses construct.

**Command_Interpreter_Node** dispatches by verb. Aliases share the same `cmd_foo` static; e.g. `make` → `cmd_make_node`, `rm`/`remove` → `cmd_remove_node`, `dump` → `cmd_dump_node`, `ls` → `cmd_list_nodes`. A subclass that installs a custom verb table without a `help` verb gets a default `help` injected by `commands()` (returns the sorted verb names) — that's how the REST service CIs get a working `help`. After command topics, `help <NodeType>` resolves the same class registry as `make_node` and renders its schema (category, description, capability flags, arguments/defaults, commands, requests, and registrations); PHP and the browser-local JS interpreter use the same section order and table alignment. CI dispatches a TM_COMMAND (not TM_RESPONSE) only when TO is empty — non-empty TO means the command is mid-route toward a downstream node, so CI forwards to its sink (Router). Verbs may throw freely; `interpret()` catches `\Throwable` and builds the response as `TM_COMMAND|TM_ERROR`. CI also bounces TM_PING and TM_EOF with empty TO back along FROM — the latter is the cli's stdin-close drain marker (cli emits TM_EOF when stdin EOFs, waits for the bounce so all preceding output has been drained off the reply partition before the cli exits).

The response envelope: `TYPE = TM_COMMAND|TM_RESPONSE` (or `|TM_ERROR` on throw), `TO = $message[FROM]`, `FROM = $this->name` (self), `ID`/`KEY` copied from the inbound message, and `VALUE = ['name' => $cmd_name, 'arguments' => $cmd_args, 'payload' => $result]` as a **live array** (never separately json-encoded). An empty-string result emits no response.

**`commands()` differs across ports — a real divergence.** PHP `commands($table)` **REPLACES** the instance verb table (`$this->commands = $table`); patron Node ctors install a fresh per-instance table this way. JS `commands(table)` **MERGES** via `{ ...this._commands, ...table }` so callers layer verbs. Don't assume one from the other.

`make_node`/`arguments()` populate `$this->arguments` — a flat **token array** (`list<string>`), one element per ctor arg. `dump_config()` reads that and re-joins it with `Node::serialize_args()` (the ONE re-join anchor; it single-quotes any token bearing whitespace/quote/backtick/backslash/emptiness and escapes `\` and `'`, so the line re-tokenizes losslessly) to emit a round-trippable `make_node <type> <name> <args...>` line; `make_node` round-trips via the same `arguments()`. No separate `dump_config()` override per class.

### Secure levels

`Core::$secure_level` is this process's command-surface policy. It is a **ratchet**: it climbs and never descends, and each level removes a class of management verbs from every interpreter in the process **and keeps every class the levels below it removed**. The table below lists what each level adds; enforcement is the running union, so level 3 refuses all three classes.

| Level | Meaning | Verbs removed at and above this level |
|-------|---------|---------------------------------------|
| `null` | No command surface at all — a graph-only script (`wp nodes ingest`) that never names an interpreter. Nothing to declare, nothing warned about. | — |
| `0` | Armed but undeclared: naming an interpreter created a surface and nobody has said what policy it is under. The Router tick warns once. | — |
| `-1` | `insecure` — deliberately unratcheted. Refused once secured, so the declaration can't be walked back. | — |
| `1` | `secure` | `make_node` (with `move_node` / `remove_node` and their aliases — construction covers teardown and renaming) |
| `2` | `secure 2` | `command_node` |
| `3` | `secure 3` | `connect_node` (with `set_sink` / `disconnect_node` / `register` / `unregister`) |

A refused verb answers `<verb> is disabled at secure level <n>` instead of dispatching. The ladder freezes *definitions*; it never disables the machine — reads still read, wired flow still flows, and verbs already defined still run. That is why the stock topologies end with a bare `secure` line: once the graph is built, nothing should be able to rebuild it. A node classifies its own verbs into these classes through `node_schema()['verb_classes']`, so a consumer plugin joins a class without editing the substrate. Signing is not one of the things a level buys: HMAC costs microseconds, so every tier signs at every level.

### Command authorization (two-tier)

The *same* `Command_Interpreter_Node` runs in two trust roles, so the gate is a per-instance `authorize` closure (`$this->authorize ?? self::$default_authorize`), checked for **every** command in `interpret()` — a failure returns `unauthorized: <verb>` rather than dispatching. Nothing legitimate is gated out: the browser and the bare cli mint their commands in-process (all `LOCAL`) from a `Shell`, every wire command is signed by whoever minted it, and the browser's SSE receive path delivers `TM_RESPONSE`s to `_output`/`_metadata`/`_uptime`. The SSE-stream *process* itself runs a verifier CI (server tier, below) so a worker can drive it — but only a command addressed to `_command_interpreter` (TO=`_repl/_command_interpreter`, empty after the worker peels `_repl`) routes to it; broadcasts get a `_sse` target from the `_default_route` Node and go to the egress.

- **Client tier** (browser interpreter, bare `wp nodes cli`): commands are minted in-process by a `Shell_Node`, which sets `Message::LOCAL` (index 7, appended *after* the canonical 7 fields). The default `authorize` is simply `isset( $message[ Message::LOCAL ] )`. `packed()` / `pack()` slice to `LAST_VALUE_INDEX + 1`, so `LOCAL` is dropped at every wire/IPC boundary (HTTP POST, SSE, Partition IPC, the `HTTP_In_Node` echo) — an injected off-process command inherently lacks it.
- **Server tier** (worker CIs, the `/command` request-scope CI, the SSE-stream process CI): these legitimately receive commands over the wire, so they can't lean on `LOCAL`. They install `Command_Auth::verifier()` as their `authorize` — a closure that accepts an in-process (`LOCAL`) command OR one carrying a valid HMAC envelope in `VALUE['auth']` (it rides *inside* VALUE so it survives IPC, unlike the stripped `LOCAL`). `sign()` / `verify()` decide "is this a command?" by the **message TYPE bit** — they require `TM_COMMAND` set, NOT `TM_RESPONSE`/`TM_ERROR`, plus a numeric TIMESTAMP and an array VALUE — never by sniffing a `name` key (so a command whose VALUE lacks `name` is still signed and verified, and a non-command carrying a `name` key is left alone). TYPE only gates signability; it is not part of the canonical signature, so a `TM_COMMAND | TM_NOREPLY` boot command signs and verifies like any other. The canonical string is `JSON.stringify([ ts, name, arguments, nonce ])` — semantics, never routing, because Router peels TO and nodes stamp FROM in transit. PHP encodes it with `JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE` to match JS byte-for-byte; `tests/fixtures/signatures.json` pins that parity from both languages, since each port's own suite stays green through a drift neither can see. Freshness is an age/skew check (up to `MAX_PAST_S = 20` seconds old, `MAX_FUTURE_S = 10` seconds ahead), separate from the spawn and health purpose tokens' discrete current-and-previous 10-second windows. On any verification failure `verify()` logs the rejection through the *handling* interpreter's `drop_message` (`verification failed: …`) and returns false (fail closed). Single-use replay protection claims the nonce with an atomic `add()` through `Cache_Backend::local_first()` at `NONCE_TTL_S = 60`; a replay or an unavailable backend is refused.

**The minter signs, never the ingress.** A client establishes a session first: `POST /newspack-nodes/v1/auth` (`Auth_Controller`, gated on the fleet site and the `manage_options` capability) returns `{ handle, key, expires_in, now }` — a random 32-byte key under a random 16-byte handle, stored for `SESSION_TTL_S = 3600` seconds via `Cache_Backend::shared_first()->add()` under a site-namespaced address. `add()`, never `set()`, so a colliding handle fails rather than displacing a live session; the TTL is fixed and never slid, so a leaked handle expires on a bounded schedule; and the response is the only place the key is ever disclosed (`now` lets the client align its TIMESTAMP to the minter's clock). The client then signs each command it mints with that key, stamping `{ nonce, sig, handle }`, and the verifier resolves the key by handle. **`HTTP_In` does not sign** — it decodes the batch, routes it, and verifies: conferring authority at the ingress made the boundary an oracle, since anything that reached it acquired authority regardless of what put it there. An unsigned wire command is therefore refused, and `HTTP_In` latches the refusal so a batch containing one answers **401** rather than a reassuring 200/202. The browser signs synchronously with `@noble/hashes` rather than `crypto.subtle`: awaiting a promise would make the Shell's dispatch async and move every graph mutation a microtask later.

Two signing keys exist, and which one a signature uses is itself the destination binding. `Command_Auth::sign()` uses the per-site secret (`hash_hmac('sha256', 'nodes-command-v1', wp_salt('nonce'))`) and stamps no handle — that is what the attached cli's `Shell` uses inline, same-host over the IPC partition. `sign_for( $destination )` signs under the session key established with one remote and stamps its handle; a signature under one remote's key verifies only there, which pins a command to its destination without signing TO. No session means no signature and a refusal downstream — a minter waits for the session rather than emitting something that will rot before it can be believed. Re-credentialing or removing a Vault entry fires `newspack_nodes/vault/changed`, which forgets the session so the next command re-auths. There is no asymmetric (public-key) signing anywhere in the substrate; every tier is HMAC-SHA256.

**Dumper** dispatches by TYPE flag and renders payloads **plain — no `ERROR:` or `INFO[from]:` prefix**, because the `debug_level 1` header already identifies the kind. Every rendered type goes out the same way: `emit()` mints a TM_BYTESTREAM and forwards to `$this->target` — there is no stderr branch:

- **TM_COMMAND|TM_RESPONSE** → unwrap the live `['name'=>,'arguments'=>,'payload'=>]` VALUE; if `name === 'prompt'` *and the response is trusted*, set the Shell's prompt and render nothing; otherwise render the payload (array payloads pretty-printed JSON, at the render boundary only). `prompt` is the one response that mutates state instead of rendering, so it is the one worth spoofing — a peer that repoints the prompt makes an operator believe they are attached elsewhere and type the next command there. FROM is X-Forwarded-For: the IPC Consumer stamps the worker id at the HEAD and everything after it is whatever the worker wrote, so in attached mode only a head matching the attached worker is trusted. Bare mode has no remote peer feeding this Dumper and trusts it.
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

The JS side has **no** `classMap` / `registerClass` / browser-`makeNode` registry, matching the PHP side's prefix resolution. The browser `make_node` verb returns a "cd to a worker path" hint instead of constructing a node, because node construction is a server-side / worker concern.

**The JS runtime (`@newspack-nodes/runtime`) re-exports the substrate's node primitives for application dashboards to mount:** `Core`, `Node`, `RouterNode`, `TeeNode`, `HookNode`, `CallbackNode`, `EchoNode`, `TimerNode`, `HeartbeatNode`, `CommandInterpreterNode`, `SseInNode`, `RemoteLinkNode`, `RemoteIpcNode`, `HttpOutNode`, `CompletionNode`, `DumperNode`, `UptimeNode`, `CommandClient`, plus the `mountExospine` factory, the `formatCommandArgs` / `parseCommandArgs` command-arg helpers, the command-auth surface (`ensureSession`, `hasSession`, `readyToMint`, `renewSession`, `forgetSession`, `markLocal`, `signCommand`), and the `useNodeState` / `useNodeFill` / `useGraphGeneration` React hooks (all `Message::*` constants are re-exported via `export * from './message'`). The `MetadataNode` class and `parseMetadata` helper live in `src/runtime/metadata-node.js` but aren't re-exported from the package entry — consume them via the file path if an application needs them.

## Config System (declarative settings)

Substrate settings are declared once in a shared **Config System** (`includes/config-system/`, namespace `Config_System\`, since 0.13.0) instead of in parallel hand-maintained lists. One `Config_System\Field` per setting carries its key, type, label (a string or a `fn(): string` thunk, resolved lazily so building the schema never requires `__()` to be defined), section, sanitizer, renderer, blank-delete policy, worker-restart class, and an `overlay` flag. `Config_System\Schema` derives every consumer from those Fields: the per-request overlay key-list, option names, delete-on-blank set, reset list, worker-restart classification, and the register/render loops. `Settings_Schema` (`includes/class-settings-schema.php`) is the substrate's own `Schema` declaration, and `Config` and `Admin` both derive from it rather than keeping parallel option lists in lockstep. `Config_System\Options_Overlay` applies the presence-based per-request config overlay; `Reset_Gate` + `Field_Reset_Assets` drive per-field reset; `Settings_Renderer` renders the settings page. Sibling plugins (event-logger-nodes, pyrobase) adopt this same `Config_System\` namespace.

**Shared `Core::$memd` and cache policy.** The one process-wide `\Memcached` handle is built by the substrate itself (`Bootstrap::init_memcached`, reached lazily through diagnostic/runtime wiring) from the substrate's own `memcache_servers` config — not by an application plugin. Empty/invalid config leaves `Core::$memd` null rather than installing an unreachable fake connection. `Cache_Backend` then makes the policy explicit per caller: `local_first()` selects usable APCu then Memcached, while `shared_first()` selects Memcached then usable APCu. Command sessions, SSE slots, tables, batch counters, and stats use `shared_first()`: configured Memcached preserves shared scope, while APCu keeps a single host and one web cache domain functional when Memcached is absent.

Normal REST-spawned workers are long-running web requests, so they share that web APCu domain with the browser/hub authentication endpoints. APCu does not span another host or an independent PHP-FPM pool/cache domain; deployments that route related command-auth work across either boundary require Memcached. Command-session lookup misses, an unavailable backend, and failed single-use nonce claims remain fail closed. Other cache callers retain their documented fail-open, fail-closed, or fail-soft behavior.

## Substrate Lifecycle Events vs WordPress Hooks

Two distinct extensibility mechanisms, both first-class:

| Mechanism | Scope | Use |
|-----------|-------|-----|
| `register` / `notify` / `set_state` on Node | Per-node-instance. Events are declared in `node_schema()['registrations']` and seeded by the base constructor; listeners can only register for declared events. Late subscribers get the cached `set_state` payload immediately at registration time. Two listener-dispatch modes (closure, or Node name -> fill TM_INFO). | Substrate-internal lifecycle: Topic `READY`, Timer `FIRE`, Router `TIMER` (the hitchhike channel Timer subclasses register against). Per-instance, events as a contract surface. |
| WordPress hooks via `Hook` node | Global by name. Anyone can `add_action` / `apply_filters`; no pre-declaration. No payload cache. | Plugin extensibility points. Transformation filters, observation listeners, "let other plugins react to this." |

The full declared set: Router `FIRE` / `TIMER` / `NOT_AVAILABLE`, Timer `FIRE`, and `READY` on Partition, Topic, and Consumer (Tail included) — fired from `sink()`, since wiring the sink is what makes the node usable. Those are the channels `register()` accepts; every other name throws, and that refusal is the contract surface.

**Declared events and cached state are not the same list.** `set_state( $event, $payload )` caches under any name and notifies whoever registered, so several nodes publish state on channels nobody can subscribe to: Partition `SEGMENT` / `CLEANUP`, Consumer `POLLING` / `SEGMENT` / `CHECKPOINT` / `OVERFLOW`, Lock `HELD` / `STOLEN` / `RELEASED`. Those surface through `dump_node` and, with `trace` on, as a `DEBUG: <event> <payload>` line. A channel meant for subscribers must be declared in `node_schema()['registrations']`.

**Multi-modal listener dispatch.** A registered listener identity is one of two things:

1. **Function/closure ref** — invoked directly with payload. Falsy return removes the registration (single-shot pattern).
2. **Node name** — fill a TM_INFO message into the named node with KEY=event, VALUE=payload. Missing node -> log via `print_less_often` ("WARNING: <name> forgot to unregister") and remove the registration.

The `Hook` node is the WordPress-side bridge; see [Other Node Primitives](#other-node-primitives) for its two modes.

## See also

- [AGENTS.md](../AGENTS.md) — substrate contracts and invariants (anchored in real bugs).
- [API.md](API.md) — REST endpoint reference.
- [tachikoma-lineage.md](tachikoma-lineage.md) — this runtime is a variant of Tachikoma; that file carries the file-and-symbol map back to the Perl, and the reason behind every deliberate difference.
- `examples/example-ai-newsletter/` — bundled walkthrough example: a self-contained deterministic digest pipeline built from Nodes (its own `includes/`, `topologies/example-ai-newsletter.tsl`, and PHPUnit suite) to learn the substrate from.
