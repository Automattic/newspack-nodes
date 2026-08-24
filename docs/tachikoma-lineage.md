# Tachikoma Lineage

[Tachikoma](https://github.com/datapoke/tachikoma) is a Perl message-passing framework: a graph of Nodes, each with one `fill()` entry point, wired by `sink` and `owner` and dispatched by a Router that peels a slash-delimited path. **Newspack Nodes is a variant of it** — an independent implementation in PHP and JavaScript, inside WordPress, sharing Tachikoma's model and vocabulary and making its own choices where WordPress, two languages, or fifteen years of hindsight call for different ones.

Variant, not translation. Tachikoma remains the reference for *semantics*: where the behavior of something here is ambiguous, the Perl is the fastest route to what the model intends. It is not the reference for field names, wire formats, or feature set — those are ours, and the differences below are deliberate.

In the dndocker checkout the Perl source sits at:

```
services/tachikoma/sources/tachikoma/lib/Tachikoma/
    Node.pm  Message.pm  Command.pm  Config.pm
    Nodes/   Router.pm  CommandInterpreter.pm  Shell3.pm  Grep.pm  …
```

Paths below are relative to that directory. Line numbers are from the checkout at the time of writing and drift with upstream — treat them as a starting offset, and search for the named symbol.

**You do not need this file to use the substrate.** [architecture-guide.md](architecture-guide.md) describes the runtime as it is, with no Perl in it. This file is for the maintainer resolving "what did this mean upstream?" and — the section that matters most — for anyone about to "fix" a difference that was chosen on purpose.

## What came from where

### Core model

| Here | Upstream |
|------|----------|
| `Node::fill()`, `sink`, `target` | `Node.pm` — `fill`, `sink`, `owner` |
| `Node::arguments()` — store the tokens, parse nothing | `Node.pm`'s trivial `arguments` getter/setter (`if (@_) { … = shift } return …`) |
| `Node::stderr()`, empty text a no-op | `Node.pm` `stderr` |
| `set_state()` tracing as `DEBUG: <event> <payload>` | `Node.pm` `debug_state` output shape |
| `Core::right_now()` | `$Tachikoma::Right_Now` |
| `Core::$recent_log` capped at 100 lines | `@RECENT_LOG` |
| `Core::print_less_often( $text, ...$extra )` — key on `$text` alone | the `$text, @extra` rate-limited logging pair |
| `Topic_Probe_Node` sweeping `Core::$nodes_by_name` | `%Tachikoma::Nodes` |

### Router and the drain loop

| Here | Upstream |
|------|----------|
| `Router_Node::fire_cb → notify_timer()`, the hitchhike | `Nodes/Router.pm` `fire_cb` → `notify_timer` |
| Dispatch profiling: per-node self time, parent-subtracted | follows `Nodes/Router.pm`'s `$PROFILES` / `@STACK` package globals (lines 20–21) |
| `PROFILE_TTL_S = 900` idle trim | the same 900-second profile expiry |
| `Timer_Node`'s two modes | `Nodes/Timer.pm` plus Router's TIMER registrants |

### Storage and durable readers

| Here | Upstream |
|------|----------|
| `Consumer_Node::READ_BLOCK_BYTES` — one block per poll, then yield | `BUFSIZ` in `Nodes/Partition.pm`'s `process_get` |
| `get_batch()` | `Nodes/Consumer.pm` `get_batch` |
| `Consumer_Node::drain()` — read to EOF, then one TM_EOF | Tachikoma v2.0's `drain()` |
| `$buffer` (read-ahead + trailing partial) | `Nodes/Consumer.pm`'s buffer |
| `poll_cb` swapped from `poll_init` to `poll_active` | `$self->{fill}` function-pointer dispatch |
| `POLLING` state INIT → ACTIVE | `Nodes/Consumer.pm` status INIT → ACTIVE |
| `add_snapshot_node()` co-committing state with the cursor | the snapshot cache — `connect_edge` + `cache_type=snapshot` |
| `Log_Node` writing VALUEs, not envelopes | `Nodes/Log.pm` |
| `Tail_Node` dropping a dead generation's partial line | `note_fh`'s `line_buffer` clear |

### Node primitives

| Here | Upstream |
|------|----------|
| `Grep_Node` | modeled on `Nodes/Grep.pm` |
| `Null_Node` | `Nodes/Null.pm` (the counting black hole; its load-generator half is absent — see below) |
| `Age_Sieve_Node` | `Nodes/AgeSieve.pm` (v2.0.280) |
| `Value_Timeout_Node` | `Nodes/PayloadTimeout.pm` (v2.0.905) |
| `Table_Node` | `Nodes/Table.pm` — the vocabulary; the backing store diverges (see below) |
| `Struct_To_JSON_Node` / `JSON_To_Struct_Node` | the `Nodes/StorableToJSON.pm` / `Nodes/JSONtoStorable.pm` pair |
| `Probe_To_Graphite_Node`, `Graphite_Node` | `Nodes/TopicProbeToGraphite.pm` and the Graphite egress behind it |
| `Topic_Probe_Node` | the counterpart of `Nodes/TopicProbe.pm`, consumer branch |
| `Echo_Node` dropping a pathless TM_ERROR | `Nodes/Echo.pm` |
| `HTTP_Out_Node`'s wire-inbound clause | `Nodes/Socket.pm:852-862` |

### Shell and TSL

Every `Shell3.pm` citation below is load-bearing: our tokenizer is meant to be the exact inverse of `Node::serialize_args()`, and the quote-type rules are what decide whether a `<token>` interpolates now or is deferred to a downstream binder. When a shell edge case is in doubt, this is the file to read.

| Here | Upstream |
|------|----------|
| `Shell_Node::fill()` — sink anything that isn't raw input | `Nodes/Shell.pm` `fill` |
| `want_reply()` | `Nodes/Shell.pm` `$self->{want_reply}` |
| `send_command` (JS `Shell_Node`) | `Nodes/Shell.pm` `send_command` |
| `print` writes verbatim; no `echo` | `Shell3.pm:1363` |
| `var` assignment operators (`= .= += -= *= /= //= ||=`, `++`, `--`) | `Shell3.pm` `var_assignment` / `$H{'var'}` / `operate()` / `operate_with_value()` |
| reading an unset var defines it empty | `Shell3.pm:2715` (`//= q()`) |
| `var <name> =` with no value deletes | `Shell3.pm:2839`, branch keyed at `:2825` |
| junk where an operator belongs is fatal | `Shell3.pm:630` — `Unexpected token in assignment` |
| the uninitialized-value warning printed RAW to stderr | `Shell3.pm:3303` — a direct `print {*STDERR}`, and `get_shared`'s empty return |
| `message.*` vars stamped at the mint | `Shell3.pm:2240-2242` does the same for STREAM (`local message.stream = foo`) |
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
| `list_timers` | `Nodes/CommandInterpreter.pm` `list_ids` / `list_timers` |
| `list_handles` | `Nodes/CommandInterpreter.pm` `list_fds` |
| `list_profiles`, slowest average first with a `--total--` row | `Nodes/CommandInterpreter.pm` `list_profiles` |
| `tabulate()` living on the interpreter | the same placement upstream |
| `register` / `unregister` verbs | `Nodes/CommandInterpreter.pm` `register` / `unregister` |
| naming an interpreter arms the secure level | `Nodes/CommandInterpreter.pm::name()` |
| `secure` / `insecure` | `$C{secure}` / `$C{insecure}` (`Nodes/CommandInterpreter.pm:2236`ff) and `Config.pm`'s `secure_level` |
| the disabled-verb ladder | `%DISABLED` (`Nodes/CommandInterpreter.pm:45`) |
| removing a node that threw during construction | `Nodes/CommandInterpreter.pm:2701` |
| the no-arg ctor → `name()` → `arguments()` → `sink()` sequence | Tachikoma's uniform construction order |
| `Command_Args`' positional + `--key[=value]` grammar | Tachikoma's argument grammar |
| signing the command SEMANTICS, not the envelope | `Command.pm`'s `sign` over `id:timestamp:name:arguments:payload` |

## Deliberate divergences

A variant is expected to differ; what follows is **why** each difference was chosen. Read the reason before changing one back — every entry here exists because someone could reasonably mistake it for an oversight.

### The message is 7 fields, in a different order, with different names

Tachikoma's `Message.pm` is `TYPE=0, FROM=1, TO=2, ID=3, STREAM=4, TIMESTAMP=5, PAYLOAD=6`. Ours is `TYPE=0, TIMESTAMP=1, FROM=2, TO=3, ID=4, KEY=5, VALUE=6`.

**Why:** TIMESTAMP moves to index 1 so that [WHAT + WHEN] sit together at the front of the array. STREAM becomes KEY and PAYLOAD becomes VALUE because KEY/VALUE is the vocabulary a reader already has from Kafka's `ProducerRecord<K,V>`, SQS message attributes, and Redis Streams' `XADD key value` — and because KEY is what `hash_to_partition()` routes on, which STREAM does not describe. This renaming is the *whole* divergence budget for the message: see [ADR-2](architecture-decisions.md#adr-2-one-message-format-the-7-field-positional-array). Anything further has to be justified separately.

`Timer_Node`'s per-message tag follows the same rename: it stamps KEY where Tachikoma stamps STREAM, because there is no STREAM slot to stamp.

### The wire is JSON, and there is no TM_STORABLE

`packed()` / `unpacked()` are `wp_json_encode` / `json_decode` of the same positional array. Tachikoma carries `TM_STORABLE` (256) and a freeze/thaw state (`IS_UNTHAWED`) for Perl `Storable` payloads.

**Why:** the wire shape has to be the memory shape in *two* languages. A Storable equivalent has no JavaScript peer, so it would reintroduce exactly the per-boundary translation layer ADR-2 exists to remove. Our `TM_STRUCT` (16) marks an array VALUE and needs no thaw step, because JSON decoding already produced one.

### No TM_PERSIST, no `answer()` / `cancel()`, no `max_unanswered`

**Why:** Tachikoma's ack handshake earns its keep when producer and consumer are decoupled by a queue that can fill. Here every boundary is synchronous and the whole graph drains on one CPU, so the drain *is* the backpressure, and the reader owns its cursor entirely — "safe to resume" is local knowledge in the same synchronous drain that dispatched the message, so an ack has nothing to signal. `TM_NOREPLY` is the one reply-control flag we kept. Full reasoning, including the three conditions that would reopen it, in [ADR-3](architecture-decisions.md#adr-3-fire-and-forget-messaging).

This one cascades: `Nodes/Null.pm` is also a load generator upstream, firing cached TM_PERSIST payloads at `max_unanswered`. That half of Null is absent here, because the window it paces against no longer exists.

### `fill()` returns nothing

Perl's `fill` returns values (`return $self->SUPER::fill(...)`, `return $self->cancel(...)`).

**Why:** those returns are an artifact of Perl having no `void` — every sub yields its last expression whether or not anyone reads it, and nothing downstream did. Making it explicit (`fill( array $message ): void`) keeps a node from coupling to its sink's *disposition* of a message. See [ADR-13](architecture-decisions.md#adr-13-fill-returns-nothing).

### There is no `edge`

`target` is Tachikoma's `owner`. The second physical output simply does not exist here.

**Why:** no node has needed one, and leaving it out keeps "physical vs logical" a two-concept distinction instead of three. [ADR-7](architecture-decisions.md#adr-7-sink-vs-target-and-tofrom-replies) records what would justify introducing it — a genuine second *physical* output, not a routing convenience.

### Secure level 0 means only "undeclared"

Upstream, level 0 also disables command signing — RSA over ~10,000 startup commands is slow — and seals the network as a consequence.

**Why ours differs:** our signature is HMAC-SHA256, which costs microseconds, so signing is never the thing a level buys you. That frees 0 to mean exactly one thing here: a command surface exists and nobody has declared a policy for it, which is why the Router tick warns once while it holds.

Two smaller differences in the same ladder. Tachikoma's `%DISABLED` level 1 removes `make_node slurp config env var func`; ours removes `make_node` alone, because four of those verbs have no counterpart here and `var` is a Shell-local builtin that never becomes a message — there is nothing at an interpreter to disable. And ours disables verb *classes* declared through `node_schema()['verb_classes']` rather than a fixed table of verb names, so a consumer plugin's verb can join a class without editing the substrate.

### A REPL session can forge ID and TIMESTAMP

The Shell reads `message.from`, `message.key`, `message.id`, and `message.timestamp` from var scope and stamps them onto the outgoing message. Upstream, only the STREAM analog is exposed that way: ID is shell-owned pipeline-correlation state with no var, and TIMESTAMP is always the real clock.

**Why:** replaying a message with an arbitrary ID or timestamp is precisely what debugging a correlation-dependent or time-dependent node requires. The forgeability is the feature. (Setting FROM likewise re-routes the reply away from the session's own Dumper, which is the point of exposing it.)

### Backticks quote; they do not execute

Shell3's `string3` shells out. Ours treats a backtick as a third quote character with `string2` escape rules — deferring `<token>` interpolation, executing nothing.

**Why:** a WordPress-internal REPL reachable over REST has no business carrying a shell-execution surface. The omission is deliberate and should not be "completed".

### Table is memcache-backed, and an absent key is an error

Tachikoma's `Table.pm` holds windowed in-memory buckets. Ours stores through to memcache with a TTL in place of the bucket window, and `Table_Node::table( $ns )->lookup( $key )` reads it from any process. The buckets come back as an OPTIONAL L1 in front of memcache (`arguments()`'s third argument), which is a tier rather than the store.

**Why:** the dashboards, REST endpoints, and CLI here have no efficient way to query a live worker's memory, so a value that exists only inside one worker process is a value nothing can read. Two consequences follow deliberately: a `GET` on an absent key replies `TM_ERROR` rather than the empty string Tachikoma returns — an empty string cannot distinguish *absent* from *stored-empty* — and `KEYS` / `STATS` are absent entirely, because both enumerate in-memory buckets that a memcache backing cannot enumerate.

### A self-registration moves with its node's name

`Timer_Node::name()` re-keys the router's TIMER entry, and `Remote_Link_Node::name()` re-keys the fleet's RELOAD entry. Upstream, `Node.pm::name()` re-keys `%Nodes` and nothing else, while `Timer.pm` registers `_router`'s TIMER by name — so a rename upstream strands the entry under the old spelling.

**Why ours differs:** this is a deliberate divergence rather than a port, because renaming is routine here — `make_node` names before `arguments()`, and a topology reload re-spells nodes — and the failure is silent. A stranded TIMER entry makes the router shout `forgot to unregister` and drop it, so the timer stops firing under either spelling; a stranded RELOAD entry does not even do that, since the listener is a closure and `notify()` keeps anything that does not return exactly false. The rule the two share is on `Node::register()`: a node that registers itself by name at another node owes that registration a move in `name()` and a drop in `remove_node()`.

### `profile` is one verb, not two

Upstream has `enable_profiling` / `disable_profiling`. Ours has `profile [ on | off ]`, where a bare `profile` toggles and an explicit `on`/`off` is an idempotent set. The reply strings are preserved.

**Why:** a form or UI that knows the state it wants must not race a stale toggle.

## Upstream that is not public

Two ancestors live in the DN tree rather than in
[datapoke/tachikoma](https://github.com/datapoke/tachikoma), so no link here will
resolve for you. They are described in reverse — by the public thing they
resemble — because that is the half you can actually read.

| Not public | Read this instead |
|---|---|
| `InstrumentalityGrail.pm` | event-logger-nodes' `Request_Builder_Node`. Assembles a request's log lines into one record and validates the per-request `n` sequence, so a mid-stream orphan, a duplicate, a reordering, or a reused request id is caught rather than quietly assembled into a plausible-looking record. |
| `InstrumentalityFlight.pm` | event-logger-nodes' `Request_Flight_Node`. A hidden timer sibling that snapshots its patron's in-progress request map on each tick and emits the live in-flight set, which is what the Gyroscope dashboard renders. |

Naming them costs nothing and orients anyone who already knows the DN tree. Do
not cite their line numbers in this repo: a citation nobody can follow reads as a
door rather than a wall.

## See also

- [architecture-guide.md](architecture-guide.md) — the runtime as it is, without the Perl.
- [architecture-decisions.md](architecture-decisions.md) — the ADRs behind the divergences above.
- `AGENTS.md` — the contract summary, including the standing rule: match Tachikoma's model, don't blind-copy its field names.
