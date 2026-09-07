# Tachikoma Lineage

[Tachikoma](https://github.com/datapoke/tachikoma) is a Perl message-passing framework: a graph of Nodes, each with one `fill()` entry point, wired by `sink` and `owner` and dispatched by a Router that peels a slash-delimited path. **Newspack Nodes is a variant of it** — an independent implementation in PHP and JavaScript, inside WordPress, sharing Tachikoma's model and vocabulary and making its own choices where WordPress, two languages, or hindsight call for different ones.

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

Paths below are relative to `lib/Tachikoma/`, with one exception worth knowing: `Tachikoma.pm` is a sibling of that directory, not a file inside it. Citations below name the symbol, not the line: line numbers drift as upstream is edited, and a stale one sends the reader to the wrong code.

**You do not need this file to use the substrate.** [architecture-guide.md](architecture-guide.md) describes the runtime as it is, with no Perl in it. This file is for the maintainer resolving "what did this mean upstream?" and — the section that matters most — for anyone about to "fix" a difference that was chosen on purpose.

## What came from where

### Core model

| Here | Upstream |
|------|----------|
| `Node::fill()`, `sink`, `target` | `Node.pm`'s `fill`, `sink` and `owner` methods |
| `Node::arguments()` — store the tokens, parse nothing | `Node.pm`'s `arguments()`, a trivial getter/setter (`if (@_) { … = shift } return …`) |
| `Node::stderr()`, empty text a no-op | `Node.pm`'s `stderr` |
| `Node::stamp_message()` prepending the node's name to FROM, refused past `MAX_FROM_SIZE` (1024) | `Node.pm`'s `stamp_message` and its identical `MAX_FROM_SIZE` constant — but ours also refuses an empty name, where upstream warns and reports success |
| `Node::drop_message()`'s rate-limited audit line: type flags, FROM, TO, and the payload for the four control types | `Node.pm`'s `drop_message`, `NOT_AVAILABLE` printing unprefixed included; ours redacts secrets from the payload and has no `print_least_often` tier |
| `Node::register()` / `notify()`, and the `forgot to unregister` warning for a listener whose node is gone | `Node.pm`'s `register` and `notify`, and the warning inside `notify`'s `_notify_registered` helper — but the drop rule differs (see below) |
| `set_state()` caching the payload for late registrants, traced as `DEBUG: <event> <payload>` | `Node.pm`'s `set_state` and `debug_state` |
| `Core::right_now()` | `$Tachikoma::Right_Now` |
| `Core::$recent_log` capped at 100 lines | `@RECENT_LOG`'s 100-line cap in `../Tachikoma.pm` |
| `Core::print_less_often( $text, ...$extra )` — key on `$text` alone | `Node.pm`'s `print_less_often`, whose `$text, @extra` pair keys on `log_midfix($text)` |
| `Core::$nodes_by_name`, swept by `Probe_Node` | `%Tachikoma::Nodes`, swept the same way by `Nodes/TopicProbe.pm` |

### Router and the drain loop

| Here | Upstream |
|------|----------|
| `Router_Node::fire_cb → notify_timer()`, the hitchhike | `Nodes/Router.pm`'s `fire_cb`, which calls into `notify_timer` |
| Dispatch profiling: per-node self time, parent-subtracted | `Nodes/Router.pm`'s `$PROFILES` / `@STACK` package globals |
| `PROFILE_TTL_S = 900` idle trim | the same 900-second expiry inside `Nodes/Router.pm`'s `trim_profiles` |
| `Timer_Node`'s two modes, recurring and oneshot | `Nodes/Timer.pm` `set_timer( $time, $oneshot )`, plus Router's TIMER registrants |
| `Event_Framework::set_timer()` / `stop_timer()` | `EventFrameworks/Select.pm`'s `set_timer` and `stop_timer`, in a framework that also registers reader, writer and watcher nodes over descriptors (see below) |

### Storage and durable readers

| Here | Upstream |
|------|----------|
| `Partition_Node` — the durable unit: numbered `{seg}.log` segments, monotonic rotation at `segment_size`, and three retention rules — a hard segment cap, age, and count | `Nodes/Partition.pm`'s `make_node Partition` usage in `help()`, which takes `--filename --num_segments --segment_size --max_lifespan`; the replication half diverges (see below) |
| `Topic_Node` — one producer addressing N partitions, routed by pinned TO, then KEY hash, then round-robin | `Nodes/Topic.pm`'s `make_node Topic` usage in `help()`, which addresses a *broker* rather than local partitions (see below) |
| `Consumer_Node::READ_BLOCK_BYTES` — one block per poll, then yield | the `BUFSIZ` constant in `Nodes/Partition.pm`, read inside `process_get`; the pattern is the port, the number is not |
| `get_batch()` | `Nodes/Consumer.pm`'s `get_batch` |
| `SEEK_START` (0), `SEEK_END` (-1), `SEEK_RECENT` (-2) | `Nodes/Consumer.pm`'s "valid offsets: start (0), recent (-2), end (-1)" |
| `$buffer` (read-ahead + trailing partial) | `Nodes/Consumer.pm`'s buffer |
| `poll_cb` swapped from `poll_init` to `poll_active`, or to `poll_crawl` after a crash | the same function-pointer dispatch through `$self->{fill}`. Consumer does not use it; the pattern is `Nodes/FileHandle.pm`'s: `fill()` dispatches through it, `new()` sets it initially, and `remove_node()` swaps it to the null callback on teardown |
| `add_snapshot_node()` co-committing state with the cursor | `Nodes/Consumer.pm`'s `commit_offset`, whose snapshot branch calls its `edge`'s `on_save_snapshot`; the `{timestamp, offset, cache_type, cache}` record it builds is `commit_offset`'s own `$stored` hash, where ours is an offsetlog frame, and the operator wires that edge with the `connect_edge` verb in `Nodes/CommandInterpreter.pm` |
| `POLLING` state INIT → ACTIVE | `Nodes/Consumer.pm` status INIT → ACTIVE |
| `Log_Node` writing VALUEs, not envelopes | `Nodes/Log.pm` |
| `Tail_Node` — the durable reader of a `Log`'s `{file}.{seg}` segments | no upstream original; `Nodes/Tail.pm` is the single-file follower, which our `File_Tail_Node` subclass ports instead |
| `File_Tail_Node` dropping a dead generation's partial line | the `line_buffer` clear inside `Nodes/Tail.pm`'s `note_fh` |
| the cli's TM_EOF round trip on stdin close | `Nodes/FileHandle.pm`'s `handle_EOF`, which calls `send_EOF` |

### Node primitives

| Here | Upstream |
|------|----------|
| `Tee_Node` | `Nodes/Tee.pm`, minus its TM_PERSIST ledger and the `[ <timeout> ]` that expired it |
| `Grep_Node` | `Nodes/Grep.pm` |
| `Null_Node` | `Nodes/Null.pm` (the counting black hole; its load-generator half is absent — see below) |
| `Echo_Node` dropping a pathless TM_ERROR | `Nodes/Echo.pm`'s `fill()`, whose equality test on TYPE we widen to a bitwise one (see below) |
| `Age_Sieve_Node` | `Nodes/AgeSieve.pm` (v2.0.280) |
| `Value_Timeout_Node` | `Nodes/PayloadTimeout.pm` (v2.0.905), whose `payload` we spell `value` |
| `Table_Node` | `Nodes/Table.pm` — the vocabulary; the backing store diverges (see below) |
| `LRU_Cache` | `Nodes/Table.pm`'s bucket LRU, `lru_lookup`, lifted out as its own class |
| `Connect_Queue_Timer_Node`, on a 500 ms cadence | `Nodes/JobSpawnTimer.pm` and `Job.pm`'s `@SPAWN_QUEUE` — one process-wide timer popping one queued closure per fire and removing itself when the queue runs dry, at `Job.pm`'s `$SPAWN_QUEUE_TIMER` of 250 ms |
| `Struct_To_JSON_Node` / `JSON_To_Struct_Node` | the `Nodes/StorableToJSON.pm` / `Nodes/JSONtoStorable.pm` pair, minus the pretty-printing. Upstream encodes with `canonical(1)` and `pretty(1)`, so one record is sorted-key JSON spread over many lines; ours is compact, in PHP's own insertion order, with `JSON_UNESCAPED_SLASHES` and exactly one trailing newline, which is what lets a `Tail` hand `JSON_To_Struct` one record at a time. Upstream also ASSIGNS `TM_BYTESTREAM \| $persist`, keeping TM_PERSIST and nothing else; ours masks the STRUCT bit off and leaves every other flag standing |
| `Probe_To_Graphite_Node` | `Nodes/TopicProbeToGraphite.pm`; both the input shape and the accumulation diverge (see below) |
| `Graphite_Node` | no node of its own upstream — `TopicProbeToGraphite` sinks its lines into whatever egress the operator wired; the transport diverges (see below) |
| `Topic_Probe_Node` | `Nodes/TopicProbe.pm`, consumer branch |
| `Callback_Node` — a closure as a terminal, so a one-off consumer needs no subclass | `Nodes/Callback.pm`, which takes the closure in its constructor too and dies on `arguments()`. Ours needs no such refusal: a constructor with a required argument is one `make_node` cannot call ([ADR-11](architecture-decisions.md#adr-11-make_node-construction-sequence)) |
| `Dumper_Node` rendering any message to one human-readable line | `Nodes/Dumper.pm` |
| `Stdin_Node` / `Stdout_Node`, and the `TTY_In_Node` / `TTY_Out_Node` pair that adds readline and prompts | `Nodes/STDIO.pm` and its `Nodes/TTY.pm` subclass — but the prompt redraw moves from the reader to the writer. Upstream it is `Dumper.pm`'s `update_prompt`, which returns unless readline is driving and otherwise calls `prompt` on the `_stdin` node; here `TTY_Out_Node::write()` owns it, wiping and redrawing under both the readline and the `fgets` line editors with a different escape sequence for each. Only the trailing-newline gate deciding whether a prompt is due crossed over unchanged |
| `Stderr_Node` writing a TM_BYTESTREAM VALUE through the node stderr chain | `Nodes/StdErr.pm`, which forwards to its sink when `owner` is set and `cancel()`s the message otherwise, so upstream StdErr can sit mid-chain as a logging pass-through. Ours is a strict terminal: `fill()` never chains to `parent::fill()` and `node_schema()` declares `has_target => false`, so the canvas draws no out-port and a tap must END here. The counter placement, before the type test, does match upstream |
| `HTTP_Out_Node`'s wire-inbound clause | the FROM-stamping and owner-routing clause inside `Nodes/Socket.pm`'s `drain_buffer_normal` |

### Shell and TSL

Every `Shell3.pm` citation below is load-bearing: our tokenizer is meant to be the exact inverse of `Node::serialize_args()`, and the quote-type rules are what decide whether a `<token>` interpolates now or is deferred to a downstream binder. When a shell edge case is in doubt, this is the file to read.

| Here | Upstream |
|------|----------|
| `Shell_Node::fill()` — sink anything that isn't raw input | `Nodes/Shell.pm`'s `fill` |
| `want_reply()` | `Nodes/Shell.pm`'s `want_reply` |
| `stamp_noreply()` (JS `stampNoreply()`) — OR TM_NOREPLY onto a command when want_reply is off | the same OR inside `Nodes/Shell.pm`'s `send_command` |
| the BUILTINS switch: a builtin runs, anything else mints a command | `Nodes/Shell.pm`'s `parse_line`, which dispatches into `%BUILTINS` |
| `print` writes verbatim, and neither shell has an `echo` | `Shell3.pm`'s `$BUILTINS{'print'}` |
| `var` assignment operators (`= .= += -= *= /= //= \|\|=`, `++`, `--`) | `Shell3.pm` `var_assignment` / `$H{'var'}` / `operate()` / `operate_with_value()` |
| reading an unset var defines it empty | `Shell3.pm`'s `execute_var_assignment`, whose `//= q()` auto-vivifies it |
| `var <name> =` with no value deletes | the `delete` inside `Shell3.pm`'s `operate()`, in its no-value branch |
| junk where an operator belongs is refused — `var: unexpected token in assignment`, printed rather than fatal | the same junk raising `Shell3.pm`'s `fatal_parse_error( 'Unexpected token in assignment: ...' )` |
| the uninitialized-value warning printed RAW to stderr | `Shell3.pm`'s direct `print {*STDERR}`, and `get_shared`'s empty return |
| `message.*` vars stamped at the mint | `Shell3.pm`'s `tell_node` builtin does the same for FROM and STREAM |
| unquoted `#` comments to end of line, anywhere | `Shell3.pm`'s `tokenize`, stripping to end of line on an unescaped `#` |
| outside a quote, `\X` is a literal X | `Shell3.pm`'s `tokenize`, minting a `string4` token |
| double-quote escapes (`\e \n \r \t`, `\" \\ \< \>`) | `Shell3.pm` `string1` |
| single-quote / backtick escapes (`\'`, `` \` ``, `\\`) | `Shell3.pm` `string2` |
| an open quote continues the statement onto the next line | `Shell3.pm`'s quote continuation |
| `got EOF while waiting for tokens` on input that ends inside an open quote — thrown under `fatal_errors` so a mangled `.tsl` never half-loads, printed in a REPL | `Shell3.pm`'s `process_command`, which writes the same text to stderr and, off a TTY with errors accumulated, shuts every node down |
| `.tsl` topology files | the TSL format and extension |

### Command interpreter

| Here | Upstream |
|------|----------|
| `list_timers` | `Nodes/CommandInterpreter.pm`'s `list_ids`, aliased to `list_timers` |
| `list_handles` | `Nodes/CommandInterpreter.pm`'s `list_fds` |
| `list_profiles`, slowest average first with a `--total--` row | `Nodes/CommandInterpreter.pm`'s `list_profiles` |
| `dmesg` | `Nodes/CommandInterpreter.pm`'s `dmesg` |
| `set_sink` | `Nodes/CommandInterpreter.pm`'s `connect_sink` |
| `trace`, which sets `debug_state` | `Nodes/CommandInterpreter.pm`'s `debug_state` verb |
| `move_node` / `move` / `mv` | `Nodes/CommandInterpreter.pm`'s `move_node`, aliased as `move` and `mv` |
| `register` / `unregister` verbs | `Nodes/CommandInterpreter.pm`'s `register` and `unregister` verbs |
| `tabulate()` living on the interpreter | `Nodes/CommandInterpreter.pm`'s own `tabulate`, the same placement |
| naming an interpreter arms the secure level | `Nodes/CommandInterpreter.pm`'s own `name()` |
| `secure` / `insecure` | `Nodes/CommandInterpreter.pm`'s `$C{secure}` / `$C{insecure}` verbs and `Config.pm`'s `secure_level` |
| the disabled-verb ladder | `Nodes/CommandInterpreter.pm`'s `%DISABLED` |
| removing a node that threw during construction | the `remove_node` call inside `Nodes/CommandInterpreter.pm`'s `make_node`, once construction fails |
| the construction sequence: a no-arg constructor, then `name()`, `arguments()`, `sink()` | the same sequence inside `Nodes/CommandInterpreter.pm`'s `make_node` |
| a refusal raised rather than returned | every `die` in `Nodes/CommandInterpreter.pm`'s verb table |
| `Command_Args`' positional + `--key[=value]` grammar, parsed once and carried as tokens | `Getopt::Long`'s `GetOptionsFromString`, which `Nodes/CommandInterpreter.pm` imports and re-runs per verb over the raw argument string |
| signing the command SEMANTICS, not the envelope | `Command.pm`'s `sign`, over `id:timestamp:name:arguments:payload` |

### The JavaScript port

The browser runtime under `src/runtime/` is a second independent implementation of the same model, not a binding onto the PHP one. Fourteen of its 38 modules have Perl to consult: `core.js` and `node-registry.js` divide `../Tachikoma.pm` between them; `message.js`, `node.js`, `router-node.js`, `command-interpreter-node.js`, `shell-node.js`, `tee-node.js`, `timer-node.js`, `echo-node.js`, `dumper-node.js`, `callback-node.js` and `stdout-node.js` carry their namesakes; and `http-out-node.js` borrows the one `Nodes/Socket.pm` clause its PHP twin does. The rest — `tap-node.js`, the pollers, the SSE and IPC channels, the dashboard view nodes — answer to the browser alone. The pieces that must agree byte for byte with PHP are pinned by shared fixtures: `shell-node.js` `parseStatements` against `tests/fixtures/statements/`, and `probe-record.js` / `jobstats-record.js` against their PHP twins.

The command-argument grammar is the exception, and the one to watch. `command-args.js`'s `parseCommandArgs` / `formatCommandArgs` have to agree with `Command_Args::parse()` / `format()` exactly, because a dashboard mints the tokens with one and a PHP verb classifies them with the other — but no shared corpus pins them the way `tests/fixtures/statements/` pins the statement parser, `tests/fixtures/signatures.json` pins the signing string, or `secretPatternsParity.test.js` pins `Core::SECRET_NAME_PATTERNS`. `src/runtime/__tests__/command-args.test.js` mirrors `tests/unit/CommandArgsTest.php` case by case instead, so a grammar change has to be made in both files and mirrored into both suites by hand, and nothing fails when only one of the two moves.

Two pairings correspond to less than their names suggest. `hook-node.js`'s `HookNode` shares only its spelling with PHP `Hook_Node`: the browser has no WordPress hooks, so it is a predicate gate taking a closure, and it forwards straight to its sink without ever reading `target` or stamping TO — a `target` set on one in the expectation of the PHP node's addressing is ignored in silence. And `stdout-node.js`'s coercion is not byte-parity with its PHP twin: `Stdout_Node` reads VALUE through `Core::as_string()`, which answers the empty string for every non-scalar, where `coerceString()` writes the literal `Array` for an array and calls an object's `toString()`. The two agree on scalars alone, which is why a struct wants a Dumper in front of the sink on either side.

| Here | Upstream |
|------|----------|
| `NodeRegistry` as the name table, with the clock left on Core | `%Tachikoma::Nodes` is a table, `$Tachikoma::Now` is not; a second namespace upstream is a Job, hence a second process |
| `Core.msgCounter()` | `Tachikoma::counter()` |
| `RECENT_LOG_MAX = 100` behind the `dmesg` verb | the same 100-line `@RECENT_LOG` ring |
| `CommandInterpreterNode.includeNodes`, the flat name→class map | Tachikoma's `@INC` require, which a browser bundle has no autoloader to search ([ADR-16](architecture-decisions.md#adr-16-js-node-class-resolution--names-are-the-tsl-surface-classes-are-the-api)) |
| `Core.argv0()`, the fixed literal `browser` | `Node.pm`'s `log_prefix`, which stamps `$0` and the pid. A tab has neither, and a constant label is what tells a reader of a MIXED log — a dmesg ring, the firehose — that the line came from the page rather than from a worker |

## Deliberate divergences

A variant is expected to differ; what follows is **why** each difference was chosen. Read the reason before changing one back — every entry here exists because someone could reasonably mistake it for an oversight.

### The message is 7 fields, in a different order, with different names

Tachikoma's `Message.pm` constants are `TYPE=0, FROM=1, TO=2, ID=3, STREAM=4, TIMESTAMP=5, PAYLOAD=6, IS_UNTHAWED=7`. Ours is `TYPE=0, TIMESTAMP=1, FROM=2, TO=3, ID=4, KEY=5, VALUE=6`, with `LOCAL=7` appended past the canonical seven.

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

`TM_UNTYPED` (1024) has no upstream counterpart at all. It is the mint default and a free HIGH bit, so it matches no type gate: an untyped message is inert rather than every type at once, and one that reaches a sink still carrying it is a bug the drop audit names. Tachikoma's `Message.pm`'s constructor, `new`, starts TYPE at 0 instead.

### The wire is JSON, and there is no TM_STORABLE

`packed()` and `unpacked()` are a JSON encode and decode of the same positional array. Tachikoma carries `TM_STORABLE` and a freeze/thaw state (`IS_UNTHAWED`) for Perl `Storable` payloads.

**Why:** the wire shape has to be the memory shape in *two* languages. A Storable equivalent has no JavaScript peer, so it would reintroduce exactly the per-boundary translation layer ADR-2 exists to remove. Our `TM_STRUCT` marks an array VALUE and needs no thaw step, because JSON decoding already produced one. The two ports part company only on malformed input, where PHP throws and JS hands back a fresh message — so a reader off disk can quarantine the line.

### No TM_PERSIST, no `answer()` / `cancel()`, no `max_unanswered`

**Why:** Tachikoma's ack handshake earns its keep when producer and consumer are decoupled by a queue that can fill. Here every boundary is synchronous and the whole graph drains on one CPU, so the drain *is* the backpressure, and the reader owns its cursor entirely — "safe to resume" is local knowledge in the same synchronous drain that dispatched the message, so an ack has nothing to signal. `TM_NOREPLY` is the one reply-control flag we kept. Full reasoning, including the three conditions that would reopen it, in [ADR-3](architecture-decisions.md#adr-3-fire-and-forget-messaging).

This one cascades through five nodes. `Nodes/Null.pm` is also a load generator upstream, firing cached TM_PERSIST payloads at `max_unanswered`; that half of Null is absent here, because the window it paces against no longer exists. `Nodes/Tee.pm`'s TM_PERSIST ledger and the `[ <timeout> ]` that expired it are gone for the same reason. And where `Grep.pm`, `AgeSieve.pm` and `PayloadTimeout.pm` `cancel()` a message they refuse, ours drop it, so a producer cannot tell a filtered message from a delivered one ([ADR-13](architecture-decisions.md#adr-13-fill-returns-nothing)). `Nodes/MemorySieve.pm` has no counterpart at all: it reads a downstream node's `output_buffer` — or a Topic's pending batches — and `cancel()`s at the pipeline entry once that count reaches `max_size`, which is the very call this decision removed.

The browser is the one place that shape returns, in a sink rather than in the graph, because a rendering sink's cost is not paid inside the drain. `dumper-node.js` writes each frame into a bounded transcript ring in O(1) and coalesces the expensive publish — the React render and the `localStorage` persist — onto one `requestAnimationFrame` flush, announcing the frames it overwrote as a single rate-limited count. That degrades a console attached to a firehose Tee into a readable transcript instead of an OOM tab, which is what its own docblock calls a MemorySieve degrade. It needs no `cancel()`, because the drop happens inside the sink rather than at the entry to a queue that would otherwise fill.

### `fill()` returns nothing

Perl's `fill` returns values (`return $self->SUPER::fill(...)`, `return $self->cancel(...)`).

**Why:** those returns are an artifact of Perl having no `void` — every sub yields its last expression whether or not anyone reads it, and nothing downstream did. Making it explicit (`fill( array $message ): void`) keeps a node from coupling to its sink's *disposition* of a message. See [ADR-13](architecture-decisions.md#adr-13-fill-returns-nothing).

### There is no `edge`

`target` is Tachikoma's `owner`. The second physical output, `Node.pm`'s `edge` accessor, does not exist here.

**Why:** nothing here has needed a second physical output, and leaving it out keeps "physical vs logical" a two-concept distinction instead of three. Several upstream nodes carry one — `Table.pm` answers a lookup through its edge, `Lookup.pm` fills it, `Consumer.pm` co-commits its snapshot cache to it — and the last is the only one we needed. `add_snapshot_node()` takes its place: a list of NAMES the commit addresses through the Router. [ADR-7](architecture-decisions.md#adr-7-sink-vs-target-and-tofrom-replies) records what would justify introducing it — a genuine second *physical* output, not a routing convenience.

### There is no broker, and a partition has no replica

`Nodes/Partition.pm`'s `make_node` form takes `--replication_factor` and `--leader`, and `Nodes/Broker.pm` elects which host leads which partition, then rebalances when a broker falls behind its share. `Nodes/Topic.pm` addresses that broker, never a partition. Ours carries neither concept: `Topic_Node` writes to the `Partition_Node`s its own topology names, and a partition is one directory on one host's filesystem.

**Why:** an election needs long-lived peers that can see each other, and every worker here is a request that exits within 595 seconds and revives from a lock directory. The durable thing is the filesystem rather than the process, so partition ownership is settled by what a topology declares instead of by a vote, and losing that filesystem is the platform's problem rather than the substrate's. Crossing a host boundary is a PULL: `Remote_Source_Node` reads a spoke's partition over SSE under its own durable cursor — Tachikoma's followers-request-from-leaders, with the election removed.

### A read block is 64 KB, and an offset names a byte within a segment

`Consumer_Node::READ_BLOCK_BYTES` is 65536; `Partition.pm`'s `BUFSIZ` is 131072. And an exact resume here carries a `{segment, offset}` pair where Tachikoma's offset is absolute across the whole log.

**Why:** the pattern — one block per poll, then yield the loop — is the port; the number is a local tuning choice, not a value to keep in step. The pair is a consequence of the storage layout: our Partition addresses a byte within a numbered segment, so a single absolute number could not name a position without first summing every segment ahead of it. The sentinels stay Tachikoma's, and they are what travels on the wire, because a signed number expresses every seek — `0` is unambiguously the start of the log rather than doubling as "no position given".

### `Consumer_Node::drain()` has no upstream original

`drain()` polls the source until it is genuinely at EOF with no buffered complete line, then emits one terminal TM_EOF. Upstream `Nodes/Consumer.pm` has no such method; `../Tachikoma.pm`'s `drain` is the process event loop, a different thing entirely.

**Why:** it is the messaging interface a reader in request scope drives — event-logger-nodes' `wp nodes reqgrep` and its `Performance_CI_Node`, the substrate's own `Job_Delay` sweep — instead of hand-rolling `read_at()` and its own decode. The terminal marker follows `Nodes/FileHandle.pm`'s `handle_EOF`, which calls `send_EOF`, and the same TM_EOF bounce is what drains the attached `wp nodes cli` when stdin closes.

### The event loop waits on timers, and on cURL alone

`EventFrameworks/Select.pm` and `EventFrameworks/KQueue.pm` register reader, writer and watcher nodes and select over their descriptors. `Event_Framework` registers timers, and the only descriptors it waits on are the cURL easy handles `register_curl_easy()` adds to one shared multi handle.

**Why:** every local source here reads a file it can seek into — `Tail_Node`, `Consumer_Node`, the cli's stdin reader — so a `Timer_Node` expresses it, and the loop holds exactly one blocking waiter however many sources are active. cURL is the one source that cannot be expressed that way, because an easy handle keeps its socket behind cURL's own API; a registered handle moves the wait from `usleep` to `curl_multi_select`. `set_timer()` and `stop_timer()` keep upstream's names, and `register_curl_easy()` / `unregister_curl_easy()` stand in for the three `register_*_node` pairs.

### Secure level 0 means only "undeclared"

Upstream, level 0 also disables command signing: `Command.pm`'s `sign` returns before signing when `secure_level` is 0, which seals the network as a consequence. Upstream signs asymmetrically — `--scheme=<rsa,rsa-sha256,ed25519>` — so every command carries a public-key operation.

**Why ours differs:** our signature is HMAC-SHA256, which costs microseconds, so signing is never the thing a level buys you. That frees 0 to mean exactly one thing here: a command surface exists and nobody has declared a policy for it, which is why the Router tick keeps warning — rate-limited, one line per `Core::$log_timeout` window — for as long as it holds. `null` is the state below it — a graph-only script that never names an interpreter has no surface, so it is never warned.

Two smaller differences in the same ladder. Tachikoma's `%DISABLED` level 1 removes six verb names, `make_node slurp config env var func`; ours removes one verb CLASS, `make_node`, because four of those verbs have no counterpart here and `var` is a Shell-local builtin that never becomes a message — there is nothing at an interpreter to disable. A class is wider than the name it is spelled with: `move_node`, `remove_node` and their aliases go with it. That is the second difference — the ladder names classes rather than verbs, and a node declares which class its own verbs join through `node_schema()['verb_classes']`, so a consumer plugin's verb reaches the ladder without an edit to the substrate.

### A REPL session can forge ID and TIMESTAMP

The Shell reads `message.from`, `message.key`, `message.id` and `message.timestamp` from var scope and stamps them onto the outgoing message. Upstream exposes the first two — `Shell3.pm`'s `tell_node` builtin reads `message.from` and `message.stream` the same way — but not the second two: ID is shell-owned pipeline-correlation state with no var (that same builtin takes it from `$self->message_id`), and TIMESTAMP is whatever `Message.pm`'s `new` stamped from the clock.

**Why:** replaying a message with an arbitrary ID or timestamp is precisely what debugging a correlation-dependent or time-dependent node requires. The forgeability is the feature, and it reaches no further than a REPL: an unset `message.timestamp` leaves the mint clock alone. Overriding FROM earns its exposure differently — a reply is addressed TO=FROM, so setting it routes the answer somewhere other than the session's own Dumper.

### Backticks quote; they do not execute

Shell3's `string3` shells out. Ours treats a backtick as a third quote character with `string2` escape rules — deferring `<token>` interpolation, executing nothing.

**Why:** a WordPress-internal REPL reachable over REST has no business carrying a shell-execution surface. The omission is deliberate and should not be "completed".

### Table is cache-backed, and an absent key is an error

Tachikoma's `Table.pm` holds windowed in-memory buckets. Ours stores through to the shared cache tier — memcached, else APCu, resolved by `Cache_Backend::shared_first()` — with a TTL in place of the bucket window, and `Table_Node::table( $ns, $ttl )->lookup( $key )` reads it from any process. `make_node Table <name> <namespace> [ <ttl> ]` takes those two positionals and nothing more; the buckets come back through the `accumulator( $bucket_size, $num_buckets )` opt-in as an L1 tier in front of the cache, and `backed_by()` names the durable record a miss falls through to ([ADR-18](architecture-decisions.md#adr-18-a-table-can-front-a-durable-record-the-walk-that-finds-it-stays-in-the-app)).

**Why:** the dashboards, REST endpoints, and CLI here have no efficient way to query a live worker's memory, so a value that exists only inside one worker process is a value nothing can read. Two consequences follow deliberately: an absent key is an ERROR rather than the empty string upstream `Table.pm`'s `fill()` GET branch returns — the `lookup($key) // q()` fallback inside that branch — because an empty string cannot distinguish *absent* from *stored-empty*; and `KEYS` / `STATS` are absent entirely, because both enumerate in-memory buckets that a cache backing cannot enumerate.

### Graphite ships datagrams, not a reconnecting socket

Upstream has no Graphite node: `TopicProbeToGraphite.pm` formats the lines and sinks them, and reaching a collector is the operator's `connect_inet --io --reconnect` — a TCP socket the process holds open and re-dials. `Graphite_Node` opens and closes a connectionless socket per message instead.

**Why:** a datagram needs no handshake, keeps no reconnect state, and leaves no send buffer to back up behind a collector that is down. Losing a sweep beats stalling the graph that produced it, and `Probe_To_Graphite_Node` batching sixteen lines to a message — the same `splice @output, 0, 16` upstream uses — is what makes a socket per message affordable.

### The probe's delta fields sum; only the levels sample

`TopicProbeToGraphite.pm` parses TM_BYTESTREAM `key:value` lines, tracks partitions and consumers in two passes so it can derive `distance` from the difference between them, keeps the latest topic hash per consumer, and emits two fields — `distance` and `msg_sent`, the cumulative node counter. `Probe_To_Graphite_Node` reads a positional `Probe_Record` off a TM_STRUCT message with DISTANCE already computed, so it needs no second pass, and it emits four fields: `distance`, `msgs_delta`, `bytes_read_delta` and `cache_size`. Two of those four accumulate rather than replace.

**Why:** `msg_sent` upstream is a cumulative counter, so latest-wins loses nothing there. `msgs_delta` and `bytes_read_delta` are per-sweep work that `Consumer_Node::probe_stats()` has already re-baselined, so consecutive records PARTITION the emit window and the window's truth is their sum — keeping the latest would report one sweep out of however many the window held. The `SUMMED` constant names those two. `distance` (backlog bytes) and `cache_size` (offsetlog segment size) are levels rather than work done, and keep upstream's latest-wins sampling.

### Zero takes the default where Tachikoma keeps the zero

`Age_Sieve_Node` reads a `max_age` of zero or below as "not supplied" and falls back to 900 seconds. Upstream's `AgeSieve.pm` keeps the literal zero, through the `//` inside its `arguments()` setter.

**Why:** zero read literally drops everything older than the current tick, so a mistyped token empties the stream. `Value_Timeout_Node` follows the same rule through `PayloadTimeout.pm`'s own `||=`, which already treats zero that way upstream.

### Echo tests the error BIT, not the whole type

`Echo.pm` drops a pathless error on `$message->[TYPE] == TM_ERROR`, an exact equality. Ours tests `$type & Message::TM_ERROR`.

**Why:** `Command_Interpreter_Node` mints every refusal as `TM_COMMAND|TM_ERROR`, so under equality a bare Echo would bounce the substrate's commonest error shape straight back to a producer that never asked for the trail. The same drop reads TYPE through `Core::as_int()` rather than comparing it raw, so a producer whose JSON encoded TYPE as a numeric string cannot disable the drop by its typing alone. `EchoTest::test_composite_command_error_with_empty_TO_is_dropped` and `test_TM_ERROR_arriving_as_a_numeric_string_is_still_dropped` pin the two halves.

### A self-registration moves with its node's name

`Timer_Node::name()` re-keys the router's TIMER entry, and `Remote_Link_Node::name()` re-keys the fleet's RELOAD entry. Upstream, `Node.pm`'s `name()` re-keys `%Nodes` and nothing else, while `Timer.pm` registers `_router`'s TIMER by name — so a rename upstream strands the entry under the old spelling.

**Why ours differs:** this is a deliberate divergence rather than a port, because renaming is routine here — `make_node` names before `arguments()`, and a topology reload re-spells nodes — and the failure is silent. A stranded TIMER entry makes the router shout `forgot to unregister` and drop it, so the timer stops firing under either spelling; a stranded RELOAD entry does not even do that, since the listener is a closure and `notify()` keeps anything that does not return exactly false. The rule the two share is on `Node::register()`: a node that registers itself by name at another node owes that registration a move in `name()` and a drop in `remove_node()`.

### `profile` is one verb, not two

Upstream has `enable_profiling` / `disable_profiling`. Ours has `profile [ on | off ]`, where a bare `profile` toggles and an explicit `on`/`off` is an idempotent set. The four reply strings are preserved verbatim.

**Why:** a form or UI that knows the state it wants must not race a stale toggle.

## What has no upstream original

Tachikoma is a long-running daemon: the checkout's `bin/tachikoma-server` starts the Router process, and that process *is* the supervisor. Every worker here is a PHP request that exits within 595 seconds, so the whole lifecycle layer is new work with no Perl to consult.

- **A worker is an HTTP request that outlives its response.** `POST /newspack-nodes/v1/workers/spawn` is the one door every spawn enters; the handler calls `ignore_user_abort( true )` and `set_time_limit( 0 )`, fires `newspack_nodes/spawn_worker`, and runs the graph inline for its whole lifetime before the response is written. The caller POSTed fire-and-forget on a 250 ms budget and hung up long before.
- **There is no supervisor and no reaper.** `Cooperative_Stop::should_continue()` owns every stop trigger, `Worker_Base::execute()`'s `finally` releases the lock and then self-respawns, `Fleet_Node` revives peers every 15 seconds, and `Bootstrap::reconcile_fleet()` on WP-Cron is the minute-cadence cold-start tier ([ADR-8](architecture-decisions.md#adr-8-worker-zombie-pattern), [ADR-9](architecture-decisions.md#adr-9-two-tier-safety-net)). `Lock_Node` is what makes the missing reaper safe: a slot is claimed by `mkdir` and held by a heartbeat file, so a worker lost to an OOM kill or a SIGKILL is stolen from after `stale_timeout` and the next acquirer does the cleanup.
- **There is no Job.** Tachikoma isolates anything that can block in a forked process talking over a socketpair on FD 5, wired up across `Job.pm`'s `init_filehandles`, `connect_parent` and `connect_child`. Nothing here forks: `Job_Worker_Node` dispatches each job inside its own worker, and a second process means another spawned request. Crash isolation therefore comes from the dead-letter lifecycle ([ADR-12](architecture-decisions.md#adr-12-dead-letter-poison--crash-lifecycle)) rather than from a process boundary.

The lifecycle is not the only place with no Perl behind it. These carry Tachikoma's contract and none of its code, because what they talk to is WordPress:

- **WordPress is the sink.** `Hook_Node` fires `do_action` / `apply_filters` on each VALUE, so a plugin reaches somebody else's topology without editing it, and `Newspack_Log_Node` fires `newspack_log`.
- **A request owns the boundary, not the process.** `HTTP_In_Node`, `SSE_Out_Node`, `Log_Stream_Out_Node`, `SSE_In_Node`, `HTTP_Filter_Node` and the substrate's `*_CI_Node` service interpreters live and die with one REST request, where `Nodes/Socket.pm` and the `HTTP_*` family hold a descriptor for the process's whole life. That is why `HTTP_Out_Node` borrows one clause from `Socket.pm` and nothing else.
- **The async-job path.** `Job_Worker_Node`, `Job_Intake` and `Job_Delay` exist because there is no Job to fork into, and `Job_Probe_Node` sweeps them the way `Nodes/TopicProbe.pm` sweeps consumers.
- **Composition of our own.** `Tap_Node` (Tee plus hard targets and passthrough), `Tail_Node`, `Remote_Link_Node` / `Remote_Source_Node`, `Settings_Sync_Node`, and `Line_Fitter` — a static PIPE_BUF fitter rather than a node.
- **The snapshot seam on a ported node.** `PayloadTimeout.pm` persists nothing across a restart. `Value_Timeout_Node` adds `save_state()` / `restore_state()` over its two `value => deadline` maps, and is the only node under `includes/` implementing that pair — so it is the one stock node an operator can name in `add_snapshot_node` without writing a subclass of their own. `restore_state()` re-coerces every key to a string and every deadline through `Core::num_float()`, because the offsetlog's JSON round trip reads a key spelled `12345` back as an int, and a missing or malformed map restores empty: a duplicate forward on resume, never a fatal.

## Upstream that is not public

Four ancestors live in the DN tree (`services/tachikoma/sources/tachikoma-dn/`) rather than in [datapoke/tachikoma](https://github.com/datapoke/tachikoma), so no link here will resolve for you. They are described in reverse — by the public thing they resemble — because that is the half you can actually read.

| Not public | Read this instead |
|---|---|
| `InstrumentalityGrail.pm` | event-logger-nodes' `Request_Builder_Node`. Assembles a request's log lines into one record and validates the per-request `n` sequence, so a mid-stream orphan, a duplicate, a reordering, or a reused request id is caught rather than quietly assembled into a plausible-looking record. |
| `InstrumentalityFlight.pm` | event-logger-nodes' `Request_Flight_Node`. A hidden timer sibling that snapshots its patron's in-progress request map on each tick and emits the live in-flight set. |
| `ReqGrep.pm` | `LRU_Cache`, and event-logger-nodes' `Reqgrep_Core` behind `wp nodes reqgrep`. A `Table.pm` subclass that accumulates a request's lines under one key through `lru_lookup`, which is the shape `LRU_Cache` takes and the reason a hit promotes its entry. |
| `Gyroscope.pm` | event-logger-nodes' Gyroscope dashboard, fed by `Request_Flight_Node`. A `TopicTop.pm` subclass rendering the in-flight requests as a sortable live table, which is the view the dashboard draws in React. |

Naming them costs nothing and orients anyone who already knows the DN tree. Do not cite their line numbers in this repo: a citation nobody outside can follow reads as a door rather than a wall.

## See also

- [architecture-guide.md](architecture-guide.md) — the runtime as it is, without the Perl.
- [architecture-decisions.md](architecture-decisions.md) — the ADRs behind the divergences above.
- `AGENTS.md` — the contract summary, including the standing rule: match Tachikoma's model, don't blind-copy its field names.
