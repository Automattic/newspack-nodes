# Tachikoma Lineage

[Tachikoma](https://github.com/datapoke/tachikoma) is a Perl message-passing framework: a graph of Nodes, each with one `fill()` entry point, wired by `sink` and `owner` and dispatched by a Router that peels a slash-delimited path. **Newspack Nodes is a variant of it** — an independent implementation in PHP and JavaScript, inside WordPress, sharing Tachikoma's model and vocabulary and making its own choices where WordPress, two languages, or fifteen years of hindsight call for different ones.

Variant, not translation. Tachikoma remains the reference for *semantics*: where the behavior of something here is ambiguous, the Perl is the fastest route to what the model intends. It is not the reference for field names, wire formats, or feature set — those are ours, and the differences below are deliberate.

In the dndocker checkout the Perl source sits at:

```
services/tachikoma/sources/tachikoma/     # Tachikoma 2.1, per its `version` file
    lib/Tachikoma.pm                      # the process: drain, @RECENT_LOG, counter
    lib/Tachikoma/
        Node.pm  Message.pm  Command.pm  Config.pm  Job.pm
        Nodes/
            Router.pm  CommandInterpreter.pm  Shell.pm  Shell3.pm
            Partition.pm  Topic.pm  Consumer.pm  Table.pm  Tee.pm  …
```

Paths below are relative to `lib/Tachikoma/`, with one exception worth knowing: `Tachikoma.pm` is a sibling of that directory, not a file inside it. Line numbers are this checkout's and they drift with upstream, so treat a number as a starting offset and search for the named symbol.

**You do not need this file to use the substrate.** [architecture-guide.md](architecture-guide.md) describes the runtime as it is, with no Perl in it. This file is for the maintainer resolving "what did this mean upstream?" and — the section that matters most — for anyone about to "fix" a difference that was chosen on purpose.

## What came from where

### Core model

| Here | Upstream |
|------|----------|
| `Node::fill()`, `sink`, `target` | `Node.pm` — `fill` (`:67`), `sink` (`:496`), `owner` (`:515`) |
| `Node::arguments()` — store the tokens, parse nothing | `Node.pm:59`'s trivial getter/setter (`if (@_) { … = shift } return …`) |
| `Node::stderr()`, empty text a no-op | `Node.pm:438` `stderr` |
| `Node::register()` / `notify()`, and the `forgot to unregister` warning for a listener whose node is gone | `Node.pm:110` `register`, `:247` `notify`, `:283`'s warning — but the drop rule differs (see below) |
| `set_state()` caching the payload for late registrants, traced as `DEBUG: <event> <payload>` | `Node.pm:229` `set_state`, `:239` `debug_state` |
| `Core::right_now()` | `$Tachikoma::Right_Now` |
| `Core::$recent_log` capped at 100 lines | `@RECENT_LOG` (`../Tachikoma.pm:514`) |
| `Core::print_less_often( $text, ...$extra )` — key on `$text` alone | `Node.pm:424`'s `$text, @extra` pair, which keys on `log_midfix($text)` |
| `Core::$nodes_by_name`, swept by `Probe_Node` | `%Tachikoma::Nodes`, swept the same way by `Nodes/TopicProbe.pm` |

### Router and the drain loop

| Here | Upstream |
|------|----------|
| `Router_Node::fire_cb → notify_timer()`, the hitchhike | `Nodes/Router.pm:126` `fire_cb` → `:245` `notify_timer` |
| Dispatch profiling: per-node self time, parent-subtracted | `Nodes/Router.pm`'s `$PROFILES` / `@STACK` package globals (lines 20–21) |
| `PROFILE_TTL_S = 900` idle trim | the same 900-second expiry (`Nodes/Router.pm:288`) |
| `Timer_Node`'s two modes, recurring and oneshot | `Nodes/Timer.pm` `set_timer( $time, $oneshot )`, plus Router's TIMER registrants |

### Storage and durable readers

| Here | Upstream |
|------|----------|
| `Partition_Node` — the durable unit: numbered `{seg}.log` segments, monotonic rotation at `segment_size`, retention by count and age | `Nodes/Partition.pm`, whose `make_node` form (`:44`) takes `--filename --num_segments --segment_size --max_lifespan`; the replication half diverges (see below) |
| `Topic_Node` — one producer addressing N partitions, routed by pinned TO, then KEY hash, then round-robin | `Nodes/Topic.pm` (`:70`), which addresses a *broker* rather than local partitions (see below) |
| `Consumer_Node::READ_BLOCK_BYTES` — one block per poll, then yield | `BUFSIZ` in `Nodes/Partition.pm` (`:27`, read at `:416` inside `process_get`); the pattern is the port, the number is not |
| `get_batch()` | `Nodes/Consumer.pm:435` `get_batch` |
| `SEEK_START` (0), `SEEK_END` (-1), `SEEK_RECENT` (-2) | `Nodes/Consumer.pm`'s "valid offsets: start (0), recent (-2), end (-1)" |
| `$buffer` (read-ahead + trailing partial) | `Nodes/Consumer.pm`'s buffer |
| `poll_cb` swapped from `poll_init` to `poll_active`, or to `poll_crawl` after a crash | `$self->{fill}` function-pointer dispatch |
| `POLLING` state INIT → ACTIVE | `Nodes/Consumer.pm` status INIT → ACTIVE |
| `add_snapshot_node()` co-committing state with the cursor | the snapshot cache — `connect_edge` + `cache_type=snapshot` |
| `Log_Node` writing VALUEs, not envelopes | `Nodes/Log.pm` |
| `File_Tail_Node` dropping a dead generation's partial line | `Nodes/Tail.pm:418`, the `line_buffer` clear in `note_fh` |
| the cli's TM_EOF round trip on stdin close | `Nodes/FileHandle.pm:260` `handle_EOF` → `:285` `send_EOF` |

### Node primitives

| Here | Upstream |
|------|----------|
| `Tee_Node` | `Nodes/Tee.pm`, minus its TM_PERSIST ledger and the `[ <timeout> ]` that expired it |
| `Grep_Node` | `Nodes/Grep.pm` |
| `Null_Node` | `Nodes/Null.pm` (the counting black hole; its load-generator half is absent — see below) |
| `Echo_Node` dropping a pathless TM_ERROR | `Nodes/Echo.pm:28` |
| `Age_Sieve_Node` | `Nodes/AgeSieve.pm` (v2.0.280) |
| `Value_Timeout_Node` | `Nodes/PayloadTimeout.pm` (v2.0.905), whose `payload` we spell `value` |
| `Table_Node` | `Nodes/Table.pm` — the vocabulary; the backing store diverges (see below) |
| `LRU_Cache` | `Nodes/Table.pm`'s bucket LRU (`lru_lookup`, `:197`), lifted out as its own class |
| `Connect_Queue_Timer_Node` | `Nodes/JobSpawnTimer.pm` and `Job.pm`'s `@SPAWN_QUEUE` — one process-wide timer popping one queued closure per fire |
| `Struct_To_JSON_Node` / `JSON_To_Struct_Node` | the `Nodes/StorableToJSON.pm` / `Nodes/JSONtoStorable.pm` pair |
| `Probe_To_Graphite_Node` | `Nodes/TopicProbeToGraphite.pm` |
| `Graphite_Node` | no node of its own upstream — `TopicProbeToGraphite` sinks its lines into whatever egress the operator wired; the transport diverges (see below) |
| `Topic_Probe_Node` | `Nodes/TopicProbe.pm`, consumer branch |
| `Callback_Node` — a closure as a terminal, so a one-off consumer needs no subclass | `Nodes/Callback.pm`, which likewise takes the closure in its constructor and refuses `arguments()` |
| `Dumper_Node` rendering any message to one human-readable line | `Nodes/Dumper.pm` |
| `Stdin_Node` / `Stdout_Node`, and the `TTY_In_Node` / `TTY_Out_Node` pair that adds readline and prompts | `Nodes/STDIO.pm` and its `Nodes/TTY.pm` subclass |
| `Stderr_Node` writing a TM_BYTESTREAM VALUE through the node stderr chain | `Nodes/StdErr.pm` |
| `HTTP_Out_Node`'s wire-inbound clause | `Nodes/Socket.pm:852-862` |

### Shell and TSL

Every `Shell3.pm` citation below is load-bearing: our tokenizer is meant to be the exact inverse of `Node::serialize_args()`, and the quote-type rules are what decide whether a `<token>` interpolates now or is deferred to a downstream binder. When a shell edge case is in doubt, this is the file to read.

| Here | Upstream |
|------|----------|
| `Shell_Node::fill()` — sink anything that isn't raw input | `Nodes/Shell.pm:38` `fill` |
| `want_reply()` | `Nodes/Shell.pm:392` `$self->{want_reply}` |
| `stamp_noreply()` (JS `stampNoreply()`) — OR TM_NOREPLY onto a command when want_reply is off | `Nodes/Shell.pm:252`, inside `send_command` |
| the BUILTINS switch: a builtin runs, anything else mints a command | `Nodes/Shell.pm:94`'s dispatch into `%BUILTINS` (`:106`ff) |
| `print` writes verbatim; no `echo` | `Shell3.pm:1363` |
| `var` assignment operators (`= .= += -= *= /= //= \|\|=`, `++`, `--`) | `Shell3.pm` `var_assignment` / `$H{'var'}` / `operate()` / `operate_with_value()` |
| reading an unset var defines it empty | `Shell3.pm:2715` (`//= q()`) |
| `var <name> =` with no value deletes | `Shell3.pm:2838`, inside `operate()`'s no-value branch at `:2834` |
| junk where an operator belongs is fatal | `Shell3.pm:632` — `Unexpected token in assignment` |
| the uninitialized-value warning printed RAW to stderr | `Shell3.pm:3303` — a direct `print {*STDERR}`, and `get_shared`'s empty return |
| `message.*` vars stamped at the mint | `Shell3.pm:2240-2241` does the same for FROM and STREAM |
| unquoted `#` comments to end of line, anywhere | `Shell3.pm:303` |
| outside a quote, `\X` is a literal X | `Shell3.pm:411` — `string4` |
| double-quote escapes (`\e \n \r \t`, `\" \\ \< \>`) | `Shell3.pm` `string1` |
| single-quote / backtick escapes (`\'`, `` \` ``, `\\`) | `Shell3.pm` `string2` |
| an open quote continues the statement onto the next line | `Shell3.pm`'s quote continuation |
| `got EOF while waiting for tokens` | the same fatal upstream |
| `.tsl` topology files | the TSL format and extension |

### Command interpreter

| Here | Upstream |
|------|----------|
| `list_timers` | `Nodes/CommandInterpreter.pm:465` `list_ids`, aliased to `list_timers` at `:502` |
| `list_handles` | `Nodes/CommandInterpreter.pm:443` `list_fds` |
| `list_profiles`, slowest average first with a `--total--` row | `Nodes/CommandInterpreter.pm:2145` `list_profiles` |
| `dmesg` | `Nodes/CommandInterpreter.pm:2040` `dmesg` |
| `set_sink` | `Nodes/CommandInterpreter.pm:1289` `connect_sink` |
| `trace`, which sets `debug_state` | `Nodes/CommandInterpreter.pm`'s `debug_state` verb |
| `move_node` / `move` / `mv` | `Nodes/CommandInterpreter.pm:645` `move_node`, aliased at `:663` and `:667` |
| `register` / `unregister` verbs | `Nodes/CommandInterpreter.pm` `register` / `unregister` |
| `tabulate()` living on the interpreter | `Nodes/CommandInterpreter.pm:2958`, the same placement |
| naming an interpreter arms the secure level | `Nodes/CommandInterpreter.pm:3033` `name()` |
| `secure` / `insecure` | `$C{secure}` (`:2221`) / `$C{insecure}` (`:2264`) and `Config.pm:231`'s `secure_level` |
| the disabled-verb ladder | `%DISABLED` (`Nodes/CommandInterpreter.pm:45`) |
| removing a node that threw during construction | `Nodes/CommandInterpreter.pm:2701` |
| the no-arg ctor → `name()` → `arguments()` → `sink()` sequence | `Nodes/CommandInterpreter.pm:2692-2698` |
| a refusal raised rather than returned | every `die` in `Nodes/CommandInterpreter.pm`'s verb table |
| `Command_Args`' positional + `--key[=value]` grammar | Tachikoma's argument grammar |
| signing the command SEMANTICS, not the envelope | `Command.pm:82-86`'s `sign` over `id:timestamp:name:arguments:payload` |

### The JavaScript port

The browser runtime under `src/runtime/` is a second independent implementation of the same model, not a binding onto the PHP one. Of its 38 modules the shared core is `Message`, `Node`, `Router`, `CommandInterpreter`, `Shell`, `Tee`, `Tap`, `Timer`, `Echo`, `Dumper` and `Callback`; the rest — pollers, the SSE and IPC channels, the dashboard view nodes — are browser-only and have no Perl to consult. The pieces that must agree byte for byte with PHP are pinned by shared fixtures: `shell-node.js` `parseStatements` against `tests/fixtures/statements/`, and `probe-record.js` / `jobstats-record.js` against their PHP twins.

| Here | Upstream |
|------|----------|
| `NodeRegistry` as the name table, with the clock left on Core | `%Tachikoma::Nodes` is a table, `$Tachikoma::Now` is not; a second namespace upstream is a Job, hence a second process |
| `Core.msgCounter()` | `Tachikoma::counter()` |
| `RECENT_LOG_MAX = 100` behind the `dmesg` verb | the same 100-line `@RECENT_LOG` ring |
| `CommandInterpreterNode.includeNodes`, the flat name→class map | Tachikoma's `@INC` require, which a browser bundle has no autoloader to search ([ADR-16](architecture-decisions.md#adr-16-js-node-class-resolution--names-are-the-tsl-surface-classes-are-the-api)) |

## Deliberate divergences

A variant is expected to differ; what follows is **why** each difference was chosen. Read the reason before changing one back — every entry here exists because someone could reasonably mistake it for an oversight.

### The message is 7 fields, in a different order, with different names

Tachikoma's `Message.pm:33-41` is `TYPE=0, FROM=1, TO=2, ID=3, STREAM=4, TIMESTAMP=5, PAYLOAD=6, IS_UNTHAWED=7`. Ours is `TYPE=0, TIMESTAMP=1, FROM=2, TO=3, ID=4, KEY=5, VALUE=6`, with `LOCAL=7` appended past the canonical seven.

**Why:** TIMESTAMP moves to index 1 so that WHAT and WHEN sit together at the front of the array. STREAM becomes KEY and PAYLOAD becomes VALUE because KEY/VALUE is the vocabulary a reader already has from Kafka's `ProducerRecord<K,V>`, SQS message attributes, and Redis Streams' `XADD key value` — and because KEY is what `hash_to_partition()` routes on, which STREAM does not describe. Renaming those two and moving TIMESTAMP is the *whole* divergence budget for the field layout: see [ADR-2](architecture-decisions.md#adr-2-one-message-format-the-7-field-positional-array). Anything further has to be justified separately.

The eighth slot differs in kind rather than in spelling. Upstream `IS_UNTHAWED` tracks whether a Storable payload has been thawed; ours is `LOCAL`, a provenance taint a Shell sets on a command it minted in-process. `packed()` never emits it and `unpacked()` rejects an 8-field line, so it cannot cross a process boundary — which is exactly what makes its presence worth trusting ([ADR-15](architecture-decisions.md#adr-15-command-authorization-local-taint--the-minter-signs)).

`Timer_Node`'s per-message tag follows the same rename: it stamps KEY where `Nodes/Timer.pm` stamps STREAM, because there is no STREAM slot to stamp.

### The type flags are a different set, so five bit values differ

Six flags agree in name and value: TM_BYTESTREAM 1, TM_EOF 2, TM_PING 4, TM_COMMAND 8, TM_ERROR 32, TM_INFO 64. The rest do not.

| Bit | Here | Upstream |
|-----|------|----------|
| 16 | `TM_STRUCT` | `TM_RESPONSE` |
| 128 | `TM_REQUEST` | `TM_PERSIST` |
| 256 | `TM_RESPONSE` | `TM_STORABLE` |
| 512 | `TM_NOREPLY` | `TM_COMPLETION` |
| 1024 | `TM_UNTYPED` | `TM_BATCH` |
| 2048, 4096, 8192, 16384 | — | `TM_KILLME`, `TM_NOREPLY`, `TM_HEARTBEAT`, `TM_REQUEST` |

**Why:** the flag SET differs first — TM_PERSIST, TM_STORABLE, TM_COMPLETION, TM_BATCH, TM_KILLME and TM_HEARTBEAT are all absent here, and TM_STRUCT and TM_UNTYPED are ours — so packing what remains into the low bits is what keeps a composite readable. Nothing is lost by it: our wire is JSON of a named-constant array rather than Tachikoma's binary `pack`, so a frame was never interchangeable between the two runtimes and a shared numbering would buy nothing.

`TM_UNTYPED` (1024) has no upstream counterpart at all. It is the mint default and a free HIGH bit, so it matches no type gate: an untyped message is inert rather than every type at once, and one that reaches a sink still carrying it is a bug the drop audit names. Tachikoma's `Message.pm:63` `new` starts TYPE at 0 instead.

### The wire is JSON, and there is no TM_STORABLE

`packed()` / `unpacked()` are `wp_json_encode` / `json_decode` of the same positional array. Tachikoma carries `TM_STORABLE` and a freeze/thaw state (`IS_UNTHAWED`) for Perl `Storable` payloads.

**Why:** the wire shape has to be the memory shape in *two* languages. A Storable equivalent has no JavaScript peer, so it would reintroduce exactly the per-boundary translation layer ADR-2 exists to remove. Our `TM_STRUCT` marks an array VALUE and needs no thaw step, because JSON decoding already produced one. The two ports part company only on malformed input, where PHP throws and JS hands back a fresh message — so a reader off disk can quarantine the line.

### No TM_PERSIST, no `answer()` / `cancel()`, no `max_unanswered`

**Why:** Tachikoma's ack handshake earns its keep when producer and consumer are decoupled by a queue that can fill. Here every boundary is synchronous and the whole graph drains on one CPU, so the drain *is* the backpressure, and the reader owns its cursor entirely — "safe to resume" is local knowledge in the same synchronous drain that dispatched the message, so an ack has nothing to signal. `TM_NOREPLY` is the one reply-control flag we kept. Full reasoning, including the three conditions that would reopen it, in [ADR-3](architecture-decisions.md#adr-3-fire-and-forget-messaging).

This one cascades through three nodes. `Nodes/Null.pm` is also a load generator upstream, firing cached TM_PERSIST payloads at `max_unanswered`; that half of Null is absent here, because the window it paces against no longer exists. `Nodes/Tee.pm`'s TM_PERSIST ledger and the `[ <timeout> ]` that expired it are gone for the same reason. And where `AgeSieve.pm` and `PayloadTimeout.pm` `cancel()` a message they refuse, ours drop it. Tachikoma's `MemorySieve` has no counterpart at all.

### `fill()` returns nothing

Perl's `fill` returns values (`return $self->SUPER::fill(...)`, `return $self->cancel(...)`).

**Why:** those returns are an artifact of Perl having no `void` — every sub yields its last expression whether or not anyone reads it, and nothing downstream did. Making it explicit (`fill( array $message ): void`) keeps a node from coupling to its sink's *disposition* of a message. See [ADR-13](architecture-decisions.md#adr-13-fill-returns-nothing).

### There is no `edge`

`target` is Tachikoma's `owner`. The second physical output (`Node.pm:507`) simply does not exist here.

**Why:** no node has needed one, and leaving it out keeps "physical vs logical" a two-concept distinction instead of three. [ADR-7](architecture-decisions.md#adr-7-sink-vs-target-and-tofrom-replies) records what would justify introducing it — a genuine second *physical* output, not a routing convenience.

### A read block is 64 KB, and an offset names a byte within a segment

`Consumer_Node::READ_BLOCK_BYTES` is 65536; `Partition.pm`'s `BUFSIZ` is 131072. And an exact resume here carries a `{segment, offset}` pair where Tachikoma's offset is absolute across the whole log.

**Why:** the pattern — one block per poll, then yield the loop — is the port; the number is a local tuning choice, not a value to keep in step. The pair is a consequence of the storage layout: our Partition addresses a byte within a numbered segment, so a single absolute number could not name a position without first summing every segment ahead of it. The sentinels stay Tachikoma's, and they are what travels on the wire, because a signed number expresses every seek — `0` is unambiguously the start of the log rather than doubling as "no position given".

### `Consumer_Node::drain()` has no upstream original

`drain()` polls the source until it is genuinely at EOF with no buffered complete line, then emits one terminal TM_EOF. Upstream `Nodes/Consumer.pm` has no such method; `Tachikoma.pm:96` `drain` is the process event loop, a different thing entirely.

**Why:** it is the messaging interface a CLI drives — event-logger-nodes' `wp nodes reqgrep` — instead of hand-rolling `read_at()` and its own decode. The terminal marker follows `Nodes/FileHandle.pm:260` `handle_EOF` → `:285` `send_EOF`, and the same TM_EOF bounce is what drains the attached `wp nodes cli` when stdin closes.

### Secure level 0 means only "undeclared"

Upstream, level 0 also disables command signing — `Command.pm:87-89` returns before signing when `secure_level` is 0, and RSA over ~10,000 startup commands is slow — which seals the network as a consequence.

**Why ours differs:** our signature is HMAC-SHA256, which costs microseconds, so signing is never the thing a level buys you. That frees 0 to mean exactly one thing here: a command surface exists and nobody has declared a policy for it, which is why the Router tick warns once while it holds. `null` is the state below it — a graph-only script that never names an interpreter has no surface, so it is never warned.

Two smaller differences in the same ladder. Tachikoma's `%DISABLED` level 1 removes `make_node slurp config env var func`; ours removes `make_node` alone, because four of those verbs have no counterpart here and `var` is a Shell-local builtin that never becomes a message — there is nothing at an interpreter to disable. And ours disables verb *classes* declared through `node_schema()['verb_classes']` rather than a fixed table of verb names, so a consumer plugin's verb can join a class without editing the substrate.

### A REPL session can forge ID and TIMESTAMP

The Shell reads `message.from`, `message.key`, `message.id` and `message.timestamp` from var scope and stamps them onto the outgoing message. Upstream exposes the first two — `Shell3.pm:2240-2241` reads `message.from` and `message.stream` the same way — but not the second two: ID is shell-owned pipeline-correlation state with no var, and TIMESTAMP is always the real clock.

**Why:** replaying a message with an arbitrary ID or timestamp is precisely what debugging a correlation-dependent or time-dependent node requires. The forgeability is the feature, and it reaches no further than a REPL: an unset `message.timestamp` leaves the mint clock alone.

### Backticks quote; they do not execute

Shell3's `string3` shells out. Ours treats a backtick as a third quote character with `string2` escape rules — deferring `<token>` interpolation, executing nothing.

**Why:** a WordPress-internal REPL reachable over REST has no business carrying a shell-execution surface. The omission is deliberate and should not be "completed".

### Table is cache-backed, and an absent key is an error

Tachikoma's `Table.pm` holds windowed in-memory buckets. Ours stores through to the shared cache tier — memcached, else APCu, resolved by `Cache_Backend::shared_first()` — with a TTL in place of the bucket window, and `Table_Node::table( $ns, $ttl )->lookup( $key )` reads it from any process. `make_node Table <name> <namespace> [ <ttl> ]` takes those two positionals and nothing more; the buckets come back through the `accumulator( $bucket_size, $num_buckets )` opt-in as an L1 tier in front of the cache, and `backed_by()` names the durable record a miss falls through to ([ADR-18](architecture-decisions.md#adr-18-a-table-can-front-a-durable-record-the-walk-that-finds-it-stays-in-the-app)).

**Why:** the dashboards, REST endpoints, and CLI here have no efficient way to query a live worker's memory, so a value that exists only inside one worker process is a value nothing can read. Two consequences follow deliberately: a `GET` request on an absent key replies `TM_ERROR` carrying `NOT_FOUND` rather than the empty string `Table.pm:106` returns — an empty string cannot distinguish *absent* from *stored-empty* — and `KEYS` / `STATS` are absent entirely, because both enumerate in-memory buckets that a cache backing cannot enumerate.

### Graphite ships datagrams, not a reconnecting socket

Upstream has no Graphite node: `TopicProbeToGraphite.pm` formats the lines and sinks them, and reaching a collector is the operator's `connect_inet --io --reconnect` — a TCP socket the process holds open and re-dials. `Graphite_Node` opens and closes a connectionless socket per message instead.

**Why:** a datagram needs no handshake, keeps no reconnect state, and leaves no send buffer to back up behind a collector that is down. Losing a sweep beats stalling the graph that produced it, and `Probe_To_Graphite_Node` batching sixteen lines to a message — the same `splice @output, 0, 16` upstream uses — is what makes a socket per message affordable.

### Zero takes the default where Tachikoma keeps the zero

`Age_Sieve_Node` reads a `max_age` of zero or below as "not supplied" and falls back to 900 seconds. `AgeSieve.pm:37`'s `//` keeps the literal zero.

**Why:** zero read literally drops everything older than the current tick, so a mistyped token empties the stream. `Value_Timeout_Node` follows the same rule through `PayloadTimeout.pm`'s own `||=`, which already treats zero that way upstream.

### A self-registration moves with its node's name

`Timer_Node::name()` re-keys the router's TIMER entry, and `Remote_Link_Node::name()` re-keys the fleet's RELOAD entry. Upstream, `Node.pm:43` `name()` re-keys `%Nodes` and nothing else, while `Timer.pm` registers `_router`'s TIMER by name — so a rename upstream strands the entry under the old spelling.

**Why ours differs:** this is a deliberate divergence rather than a port, because renaming is routine here — `make_node` names before `arguments()`, and a topology reload re-spells nodes — and the failure is silent. A stranded TIMER entry makes the router shout `forgot to unregister` and drop it, so the timer stops firing under either spelling; a stranded RELOAD entry does not even do that, since the listener is a closure and `notify()` keeps anything that does not return exactly false. The rule the two share is on `Node::register()`: a node that registers itself by name at another node owes that registration a move in `name()` and a drop in `remove_node()`.

### `profile` is one verb, not two

Upstream has `enable_profiling` / `disable_profiling`. Ours has `profile [ on | off ]`, where a bare `profile` toggles and an explicit `on`/`off` is an idempotent set. The four reply strings are preserved verbatim.

**Why:** a form or UI that knows the state it wants must not race a stale toggle.

## What has no upstream original

Tachikoma is a long-running daemon: `bin/tachikoma-server` starts the Router process, and that process *is* the supervisor. Every worker here is a PHP request that exits within 595 seconds, so the whole lifecycle layer is new work with no Perl to consult.

- **A worker is an HTTP request that outlives its response.** `POST /newspack-nodes/v1/workers/spawn` is the one door every spawn enters; the handler calls `ignore_user_abort( true )` and `set_time_limit( 0 )`, fires `newspack_nodes/spawn_worker`, and runs the graph inline for its whole lifetime before the response is written. The caller POSTed fire-and-forget on a 250 ms budget and hung up long before.
- **There is no supervisor and no reaper.** `Cooperative_Stop::should_continue()` owns every stop trigger, `Worker_Base::execute()`'s `finally` releases the lock and then self-respawns, `Fleet_Node` revives peers every 15 seconds, and `Bootstrap::reconcile_fleet()` on WP-Cron is the minute-cadence cold-start tier ([ADR-8](architecture-decisions.md#adr-8-worker-zombie-pattern), [ADR-9](architecture-decisions.md#adr-9-two-tier-safety-net)).
- **There is no Job.** Tachikoma isolates anything that can block in a forked process talking over a socketpair. Nothing here forks: `Job_Worker_Node` dispatches each job inside its own worker, and a second process means another spawned request. Crash isolation therefore comes from the dead-letter lifecycle ([ADR-12](architecture-decisions.md#adr-12-dead-letter-poison--crash-lifecycle)) rather than from a process boundary.

## Upstream that is not public

Four ancestors live in the DN tree (`services/tachikoma/sources/tachikoma-dn/`) rather than in [datapoke/tachikoma](https://github.com/datapoke/tachikoma), so no link here will resolve for you. They are described in reverse — by the public thing they resemble — because that is the half you can actually read.

| Not public | Read this instead |
|---|---|
| `InstrumentalityGrail.pm` | event-logger-nodes' `Request_Builder_Node`. Assembles a request's log lines into one record and validates the per-request `n` sequence, so a mid-stream orphan, a duplicate, a reordering, or a reused request id is caught rather than quietly assembled into a plausible-looking record. |
| `InstrumentalityFlight.pm` | event-logger-nodes' `Request_Flight_Node`. A hidden timer sibling that snapshots its patron's in-progress request map on each tick and emits the live in-flight set. |
| `ReqGrep.pm` | `LRU_Cache`, and event-logger-nodes' `Reqgrep_Core` behind `wp nodes reqgrep`. A `Table.pm` subclass that accumulates a request's lines under one key through `lru_lookup`, which is the shape `LRU_Cache` takes and the reason a hit promotes its entry. |
| `Gyroscope.pm` | event-logger-nodes' Gyroscope dashboard, fed by `Request_Flight_Node`. A `TopicTop.pm` subclass rendering the in-flight requests as a sortable live table, which is the view the dashboard draws in React. |

Naming them costs nothing and orients anyone who already knows the DN tree. Do
not cite their line numbers in this repo: a citation nobody outside can follow
reads as a door rather than a wall.

## See also

- [architecture-guide.md](architecture-guide.md) — the runtime as it is, without the Perl.
- [architecture-decisions.md](architecture-decisions.md) — the ADRs behind the divergences above.
- `AGENTS.md` — the contract summary, including the standing rule: match Tachikoma's model, don't blind-copy its field names.
