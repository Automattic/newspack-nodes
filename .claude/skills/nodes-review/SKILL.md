---
name: nodes-review
description: Code review checklist for substrate (newspack-nodes) changes. Use whenever reviewing a diff that touches Node, Message, Router, Topic, Partition, Tee, Tail, Consumer, Worker, Fleet, or anything else under the newspack-nodes plugin's includes/.
argument-hint: "[file or class]"
---

# Newspack Nodes Review Checklist

Substrate-specific review pass. The twenty ADRs in `docs/architecture-decisions.md` carry the rationale; this skill applies them to a diff. "Decision N" in AGENTS.md and in code comments means ADR-N.

Some of this is mechanized already — `scripts/lint-contract.mjs` (the JS shapes of ADR-7, ADR-16 and ADR-17), `scripts/lint-docs.sh`, `scripts/lint-comments.{php,mjs}`, `scripts/lint-styles.mjs`, `scripts/reorder-node-methods.{php,js} --check` over every staged file, PHPStan level 10 under the shipmonk dead-code overlay, knip and `tsc` on the JS side, and the 90% per-class and per-file statement-coverage gates. Spend the review on what no gate reads: whether the change conforms to the contract, and whether it degrades safely for a consumer running the previous release.

## When to Use

After any code change inside `newspack-nodes/includes/` or `newspack-nodes/src/`, before pushing or merging. General WordPress / VIP Go review patterns still apply; this skill adds the substrate gates.

## Gates (in order of catastrophic-bug potential)

### 1. PIPE_BUF discipline (ADR-4)

If the diff touches `Partition_Node` (shell name Partition) `fill()`, its batch logic, or anything else writing packed Messages to disk:

- `Partition_Node::MAX_LINE_SIZE` is 4096 bytes, measured on the PACKED record plus its newline. Two opt-ins lift it to `MAX_LARGE_LINE_SIZE` (32 MiB): `allow_large_writes()`, which ENFORCES a single writer with a `Lock_Node` at `{segment_dir}/write.lock.d`, and `void_warranty()`, which takes the caller's single-writer assertion with no lock.
- A diff that raises the small-write cap is wrong: it breaks atomic append for every concurrent producer.
- An oversize record is DROPPED whole, never truncated — half a record desyncs every reader after it. The drop goes through `Node::drop_message()`, which leaves a rate-limited audit line naming the type flags, FROM and TO — plus the redacted payload for the four control types (`TM_INFO`, `TM_REQUEST`, `TM_ERROR`, `TM_COMMAND`), so a dropped data record names its address and nothing else. Verify a new >4 KB producer either lifts the cap or fits under it; do not let a diff make that drop quiet.
- A record that must survive rather than be dropped goes through `Line_Fitter::fit( $message, $fields )` immediately before the sink, which halves each named trimmable VALUE field until the packed line fits. `$fields` is a sacrifice order — most expendable first — and a field outside the list is never touched. `fit()` returns null once every listed field is spent, and the caller drops that loud through `print_less_often()` rather than emit oversize. `Job_Probe_Node` is the reference. `Probe_Record` carries no trimmable field and is emitted unfitted on purpose. The sweep behind both, `Probe_Node::fire()`, mints one TM_STRUCT message per record and never packs several records into one: that is what keeps every append to `topicprobe.p0` and `jobstats.p0` under the small cap, so both stay lockless logs every worker in the fleet appends to at once. A diff batching records to save sink calls is a regression, not an optimization. `Probe_To_Graphite_Node`'s sixteen lines per message is egress, downstream of the cap, and is no precedent for it.

### 2. Lazy init for Topic / Partition (ADR-5)

These instantiate in request scope — `Log_Manager` (newspack-event-logger-nodes) constructs a `Topic_Node` on every request its URL filter admits, where no worker and no `Event_Framework` exist. Neither the constructor nor `arguments()` may:

- Call `set_timer()` — no `Event_Framework` is draining yet, so the timer registers but never fires; a silent leak.
- Call `Core::node()` — it likely returns null at construct time.
- Call `scandir()`, `mkdir()`, `fopen()` or any other I/O — wasted syscalls per request × N partitions.

Push all of it to first use (first `fill()`, first `read_at()`). Derived scalar state computed from the parsed tokens is fine, and is what `Partition_Node::arguments()` does after `parse_schema_args()` returns.

### 3. FROM stamping — two distinct operations

Don't conflate them:

- **Mint FROM (set FROM outright, normally to the node's own name).** A node that *mints* a brand-new message sets FROM to its own name: `Timer_Node::fire()` and `Probe_Node`'s sweep, `Node::notify()`, `Shell_Node` (through `reply_from()`), `Tail_Node`, which assigns FROM directly at its I/O boundary rather than through the helper, and every node minting a reply — the interpreter's responses, `Table_Node`, `Job_Worker_Node`'s `GET_HEALTH`, `Consumer_Node`'s `GET_LAG`. `Durable_Reader::commit_offsetlog_frame()` stamps the reader's own name on every offsetlog checkpoint, in Consumer and Remote_Source alike. Two mints stamp a name that is not the node's own. `Router_Node::send_error()` puts the unreachable destination in FROM and the sender in TO, so the bounce reads as coming from the address that failed; `Stdin_Node` stamps the reserved `Node_Names::STDIN`, because a session leaves its reader unnamed and `stamp_message()` refuses an empty name — "correcting" it to `$this->name` yields a node that stamps nothing. None are bugs; don't flag them.
- **Breadcrumb-prepend `stamp_message()` (prepend own name to an existing FROM trail).** It belongs at a boundary where a message ENTERS this graph from outside: `Durable_Reader::forward_line()` (Consumer and Remote_Source), `HTTP_In_Node`, `HTTP_Out_Node::accept_inbound()` on the reply leg, and `Remote_Link_Node::deliver_downstream()`. A node minting a fresh message into an empty FROM may also reach for it — `Value_Timeout_Node`, `Probe_To_Graphite_Node` and `Consumer_Node::drain()`'s terminal TM_EOF do — which is minting, not breadcrumbing. `stamp_message()` on a Tee, Tap, Hook, Callback or any application forwarder is almost certainly a bug: it pollutes the trail and breaks reverse-direction routing. Pass-through forwarders relay the message untouched.

`stamp_message()` refuses two ways and returns false — an empty `$name`, which would compose a `/from` path Router cannot resolve, and a trail past `Node::MAX_FROM_SIZE` (1024), which means a cycle is growing it. Both guards are essential; the CALLER must drop the message on a false.

### 4. CRC32 + 31-bit-mask routing (ADR-6)

`Partition_Node::hash_to_partition()` is canonical. Any diff introducing partition routing (Topic, a keyed Job_Intake mode, anything else) MUST call it. One partition has one consumer, so the hash IS the concurrency control: a key's messages are processed serially by one process, and per-key mutexes never have to exist. Diverging hash families split a key across partitions silently — no error, just wrong colocation — and take that guarantee with them.

The function strips the query string (`explode( '?', $key, 2 )[0]`) before hashing, so one URL's variants share a partition, then masks with `& 0x7FFFFFFF` for 32-bit-PHP safety. Don't bypass either step. A site needing different behaviour is a new, named routing function, never a quiet second hash.

### 5. sink vs target, and TO=FROM replies (ADR-7)

Forward direction: `TO = $this->target` (`Node::fill()` stamps it only when TO is empty).
Reverse direction (any response, error, ack): `TO = $message[FROM]`.

`sink` is the physical next node `fill()` forwards to; `target` is the logical destination — a path string stamped into `message[TO]`, Tachikoma's `owner`. This port has no `edge`. `_router` resolves a non-empty TO by peeling its head segment. A diff that conflates the two, or invents an `edge` property, is a smell.

A fan-out node's `target` is a LIST, and `Fanout_Targets::live_targets()` is the only read of it: it drops every entry whose head segment no longer resolves and writes the pruned list back, in connect order, so consuming the list and skipping the prune is impossible. Tee and Tap therefore never fan into a dead name, and `Settings_Sync_Node` — the one user that mints and signs one command per spoke — never signs for a node that no longer exists. A diff reading `$this->target` directly on any of the three loses the prune.

### 6. Worker lifecycle and the two-tier safety net (ADR-8, ADR-9)

`Worker_Base::execute()`'s `finally` does `release()` THEN `self_respawn()`. Reversed, the successor's acquire hits the lock the old process still holds and skips, and `Spawn_Coordinator::MIN_SPAWN_INTERVAL_S` (15) keeps the slot empty until a peer's rescue. Don't reorder.

`Internal_Request_Token::validate()` accepts TWO windows — the current and the previous `WINDOW_S` (10 seconds each), so a token lives 10 to 20 seconds. Don't tighten to one: the tolerance absorbs clock skew and request latency across a boundary. The purpose string is inside the hash, so a `spawn` token never validates at `health-cache`.

Revival has two tiers and no supervisor process. Every worker mounts `_fleet` (`Fleet_Node`), which every 15 seconds (`SCAN_INTERVAL_MS`) spawns any fleet worker whose lock dir is missing or whose heartbeat exceeds its `stale_timeout`, at most `MAX_SPAWNS_PER_TICK` (4) a pass — each POST is a blocking cURL inside the drain loop, so a cold fleet spreads its spawns over consecutive passes instead of stalling one. `Bootstrap::reconcile_fleet()` on WP-Cron is the cold-start tier, for a fleet with nothing left to scan. Its `run_reconcile_steps()` runs seven steps in a fixed order, each alone behind its own catch: revival first (`newspack_nodes/before_reconcile`, `spawn_due_workers()`, `wake_readers_with_backlog()`), then housekeeping (lock-dir reconcile, retention, orphan IPC, `newspack_nodes/periodic`). A diff reordering revival behind housekeeping, folding the steps into one `try`, or adding a spawner that reaches past the endpoint enforcing the 15s throttle is a regression.

### 6b. One entry point, returning void (ADR-1, ADR-13)

Every node's entry point is `fill( array $message ): void`. A node emits into its sink and learns *nothing* about what happened downstream — delivered, dropped, queued, transformed. Flag any diff that:

- Opens a second way in — a `write()`, a `process()`, or a `parse()`/`dispatch()` pair the caller sequences, which is the same parallel API with its pieces renamed. Helpers are fine as `fill()`'s own internals; nothing outside the node calls one to get a message in. A node whose natural input is not a Message does not widen its signature either: the producer wraps the line as a `TM_BYTESTREAM` VALUE and `fill()` unwraps it.
- Drops the `: void` return type, or adds a non-void return type to a `fill()`.
- Uses `return <expr>;` inside a `fill()` body (bare `return;` for early exit is fine).
- Reads, assigns, or branches on a `fill()` call's result (`$x = $sink->fill( … )`). A node that must know an outcome receives it *as a message* — a TO=FROM reply (ADR-7) or a `TM_ERROR` (ADR-3) routed back — never as a return value.

Testing stays "construct a message, call `fill()`, inspect the *sink*" (`Capture_Sink_Node`, in `tests/Helpers/CaptureSink.php`), never "inspect `fill()`'s return."

### 6c. Cooperative-stop propagates through broad catches (ADR-14)

`Event_Framework::stop_check()` raises `Worker_Should_Stop` (which extends `\RuntimeException`) to unwind a long in-process job on timeout, memory or shutdown; `pump()` is its throttled form, which firehose writers reach per write. Any broad `catch ( \Throwable )` / `catch ( \Exception )` on the message or drain path MUST re-throw it **first**, before anything else:

```php
} catch ( Worker_Should_Stop $e ) {
	throw $e;   // cooperative-stop signalling, not an error
} catch ( \Throwable $e ) {
	// real error handling
}
```

A broad catch that logs, wraps `TM_ERROR`, or defers `Worker_Should_Stop` without that explicit-first re-throw swallows the stop, and the worker runs past its deadline. The symptom sits far from the cause: an intervening Tee or Command_Interpreter eats the stop, and the guarantee then holds on the direct firehose path alone. Three deliberate carve-outs, each documented at its site — don't flag them, and don't let a new broad catch omit the re-throw:

- **Fan-out (Tee and Tap, through `Fanout_Targets`).** Both attempt EVERY target and defer one throwable; neither swallows, because a target skipped by an early throw never receives the message once the poison path advances the cursor. `outranks()` decides which escapes: a plain `Worker_Should_Stop` (replay) beats both a `Worker_Should_Stop_Clean` (commit past) and a poison (dead-letter, cursor advances), in either arrival order, because advancing past a message that needed a replay loses it while replaying a clean one is a duplicate at-least-once tolerates. `tests/unit/TeeStopPrecedenceTest.php` pins it and names the revert signal: duplicate deliveries in request-builder. Tap additionally performs its passthrough BEFORE re-throwing — the passthrough IS the pipeline, and a `Worker_Should_Stop_Clean` commits past the message. A diff that makes Tap swallow an ordinary target throw and re-throw the stop immediately is a regression. All of that is PHP. The JS `TeeNode` and `TapNode` in `src/runtime/` have no cursor, no replay and no `outranks()`: each logs a per-target throw through `printLessOften` and carries on, and `tap-node.test.js` pins that swallow-and-continue as the correct behaviour. Judge a JS fan-out diff against the JS shape.
- **Post-success `finally` — `Job_Worker_Node`'s `newspack_nodes/job_worker/after_job` action.** It swallows everything, `Worker_Should_Stop` included: the handler already ran, so propagating out of cleanup would false-poison a settled job (ADR-12). Its `before_job` counterpart is NOT a carve-out — it follows the rule, and swallows only a listener's own error.
- **`Log_Manager::finish()`, in newspack-event-logger-nodes.** It marks the request aborted, writes the terminal, then re-raises, because terminal-LAST is a wire contract: `Reqgrep_Core` finalizes and evicts the rid on the terminal, so anything written after it arrives at a request that no longer exists.

Deferring a stop is legitimate in one more place, and there it is a named trait rather than a bare catch: `Deferred_Clean_Stop`, the write side of the clean stop. A snapshot node catches the stop its own forward raised — the Partition flushed the record before honoring it, so the write is already durable — finishes its bookkeeping, and re-raises `Worker_Should_Stop_Clean`, on which `Durable_Reader::drain_buffer()` commits PAST the record instead of replaying it.

That commit inspects nothing but the exception's subtype, so the subtype IS the whole promise, and both conversion sites do their guarding at the raise: `Durable_Reader::forward_line()` converts a plain stop only under `assume_clean_shutdown` and outside crawl, `Remote_Source_Node::forward_line()` only on a crumb-carrying record outside crawl. Never `throw new Worker_Should_Stop_Clean()` from a node. The one sanctioned raise is `raise_pending_stop()`, reached after `Partition_Node::maybe_stop()` has already flushed the forward to disk; a hand-rolled raise makes the promise with no write behind it.

A using `fill()` owes the trait `clear_pending_stop()` at entry and `raise_pending_stop()` at every exit, and the two omissions fail differently. Drop the raise and `guarded()` swallows the stop outright — an ADR-14 breach, with nothing left to re-raise it, so the worker runs past its deadline until the next drain tick re-checks the predicate. Drop the clear and a stop deferred at message N raises at message N+1's exit, committing the reader past a record whose downstream write never happened: a lost record, not the duplicate at-least-once tolerates. Replaying a message the restored snapshot has already counted is the failure with no trait at all.

### 6d. Poison and crash lifecycle (ADR-12)

`Dead_Letter_Queue` and `Durable_Reader` share this between `Consumer_Node` and `Remote_Source_Node`, and `Partition_Node` reuses the same trait for a short write with no cursor at all. The cursor names the NEXT UNREAD position: a record disposed of rather than forwarded — dead-lettered or dropped — advances the cursor past itself and commits there gracefully, so no boot re-encounters it and no quarantine marker has to exist.

- A caught throw is quarantined ON SIGHT to the `:deadletter` sibling, replayable through `wp nodes ingest`. A diff adding automatic retry is wrong: a caught throw is deterministic per message, so retrying only wedges the stream, and the transient failures retries would target are upstream.
- Attempt accounting lives in the offsetlog frame (`attempts`, `reason`, `first_crash_ts`), and a graceful shutdown stamps `attempts=0`. The handoff is deliberately SKIPPED on a fatal, because a count left climbing is what carries a deterministic fatal-poison to `CRASH_MAX_ATTEMPTS` (5) and into crawl. A diff stamping on every exit path disarms the crash detector; one dropping the stamp makes a clean ~10-minute recycle read as a crash, so an idle cursor climbs to the threshold and quarantines an innocent message.
- Crawl checkpoints after EVERY message so a re-crash pins the culprit, and exits to the healthy baseline after `CHECKPOINT_INTERVAL_S` (30) crash-free — but never while the boot-pinned suspect is still armed. The cooperative-stop path is separate and bounded by `COOP_MAX_ATTEMPTS` (2).
- The four triage verbs — `dl_list`, `dl_show`, `dl_requeue`, `dl_purge` — merge into the using node's `node_schema()['commands']`, so both readers expose them on their `{name}:config` interpreter with no CI edit. A fifth belongs there too, never hand-added to a service CI.

### 7. No TM_PERSIST, answer or cancel (ADR-3)

The substrate ports none of the three. If a diff reintroduces one, push back: the substrate is fire-and-forget, and the single-threaded drain IS the backpressure, because every step blocks on its downstream's I/O.

If a change seems to need ack or cancel for a real reason, build slot tracking at the producer that needs it — never a global persist contract.

### 8. Message shape and type flags (ADR-2)

One shape everywhere: the 7-field positional array (`TYPE=0`, `TIMESTAMP=1`, `FROM=2`, `TO=3`, `ID=4`, `KEY=5`, `VALUE=6`), indexed through the `Message::*` constants. `packed()` / `unpacked()` are JSON of that same array, so the wire shape IS the memory shape and no boundary needs a translation layer. There is no object form, and a string subscript is a silent-corruption footgun: `$message['type'] = …` lands under a key beside the seven, `packed()` emits the seven positional fields and drops it, and TYPE keeps the value the write meant to replace.

- `TM_BYTESTREAM` (1): VALUE is a string — one raw line or frame.
- `TM_STRUCT` (16): VALUE is an array.
- They are mutually exclusive by convention — pick the one that matches VALUE.

The full bitmask from `includes/class-message.php`: `TM_BYTESTREAM=1`, `TM_EOF=2`, `TM_PING=4`, `TM_COMMAND=8`, `TM_STRUCT=16`, `TM_ERROR=32`, `TM_INFO=64`, `TM_REQUEST=128`, `TM_RESPONSE=256`, `TM_NOREPLY=512`, `TM_UNTYPED=1024`. A consumer reading `$message[ Message::VALUE ]` as an array MUST gate on `TM_STRUCT`, never on `is_array()`, and never on `TM_RESPONSE` (256) — different bits. `TM_UNTYPED` is the mint default: a free high bit matching no type gate, so an untyped message is inert rather than every type at once. A message reaching a sink still carrying it is a bug the drop audit names.

`Partition_Node` and `Topic_Node` pack EVERY type, control traffic included: `request_node`, `send_eof`, attached-mode error responses and the cli's TM_EOF drain all ride an IPC partition, and a diff filtering control types out of a partition write breaks each of them. `Log_Node` is the one exception — it writes the VALUE rather than the envelope, so its `fill()` drops `TM_ERROR`, `TM_EOF` and `TM_REQUEST`.

`TM_NOREPLY` is the one reply-control flag kept from Tachikoma: a Shell with `want_reply( false )` (topology load, script mode) ORs it onto commands and the interpreter suppresses the routed reply, surfacing an error on stderr instead. `Message::LOCAL` (index 7) is not a type flag but the appended provenance taint; `packed()` never emits it and `unpacked()` rejects an eight-field line, so it cannot cross a process boundary — which is exactly what makes its presence trustworthy (ADR-15).

Flag NAMES come from `Message::TYPE_NAMES` through `Message::type_labels()`, mirrored in `src/runtime/message.js`. A renderer holding a private copy is how a flag goes unnamed; both ports move together.

### 8b. `make_node` construction and class naming (ADR-10, ADR-11)

- Every class is `Word_Word`, acronyms all-caps (`HTTP`, `SSE`, `CLI`, `LRU`, `CI`, `JSON`, `TTY`). A Node subclass ends `_Node`, a helper does not, and the shell name is the short name minus that suffix (`Tee_Node` → `Tee`). `make_node( $type )` constructs the first `{$prefix}{$type}_Node` that is a concrete Node subclass, across the prefixes plugins register through `Command_Interpreter_Node::register_namespace()`. Resolution rides on the suffix and the prefix, so there is no `class_map` to add a row to; a diff proposing one is a regression.
- The constructor must be parameter-less for `make_node`-buildable nodes; positional config is declared in `node_schema()['arguments']` as `[ { name, type, default?, required? } ]`.
- A schema `default` is a real typed value (ints, floats, class constants) or a `<ns:key>` token string such as `'<config:max_segments>'`, which `Schema_Reflection::resolve_default()` resolves through its namespace resolver and coerces to the declared type. A schema default lives in PHP and never passes through the TSL loader, so a token default resolves here rather than crashing the walker.
- `arguments( ?array $args )` takes a **token array** (`list<string>`), never a joined string. Follow the `Partition_Node` reference: `if ( null === $args ) { return parent::arguments(); }` (pure getter), else `parse_schema_args( $args )` and then derive. There is NO `'' === $args` short-circuit — `parse_schema_args()` fills each missing position from its schema `default` or throws `Missing required argument: <name>`, so a bare `make_node Partition foo` fails loud instead of writing filesystem-root junk like `/p0`. `Timer_Node::arguments()` is the sanctioned exception and correct code, so don't flag it: a blank token 0 there means "no interval — ride the Router tick", and it calls `set_timer()` with no argument rather than parsing. The parse cannot express that: `parse_schema_args()` nulls a blank `int` token, and the `interval_ms` spec declares neither a `default` nor `required`, so it would stay 0 and `set_timer( 0 )` would take an own slot firing every 0 ms. The general form is that a positional whose ABSENCE selects a different MODE, rather than a different value, earns its branch ahead of the parse. The rest of the rule still holds — fail loud on a missing required token, and never invent a placeholder.
- A lazily-built child graph must be invalidated wherever its configuration can move. `ensure_patrons()` is idempotent on a nullable property, so a replayed `arguments()` would go on serving children built from superseded config; `Remote_Link_Node::arguments()` therefore snapshots `[ vault_id, remote_partition ]` before `parse_schema_args()` and calls `drop_patrons()` when the pair moved. The comparison is PAIRWISE on purpose: joining the two tokens on a space makes `("a", "b c")` and `("a b", "c")` one key, so two different spokes read as no change. Read any `ensure_*()` guarded on "the property is not null" for the same hole whenever its inputs are schema arguments a topology can replay.
- Defaults apply **per position when the token list runs short**. The class property default and the schema `default` should agree, so the value is the same either way.
- Per ADR-5, event-loop and filesystem work stays out of both the constructor AND `arguments()` for request-scope nodes.
- Programmatic dependencies (objects, callables, streams) are public properties the caller assigns after construction, never constructor parameters — `make_node` filters non-scalar args because they cannot round-trip. `Workers_CI_Node::$cli` is the reference.
- The schema keys are `'arguments'` and `'commands'`. A diff reading or writing a `'ctor'` or `'verbs'` key on a `node_schema()` is a regression. (`Topology_Analyzer`'s graph payload has its own unrelated `verbs` key; that one is fine.)

### 8c. `dump_config` round-trip

- Constructors and `arguments()` set `$this->arguments` directly; `Node::dump_config()` reads it to emit a round-trippable `make_node <type> <name> <args>` line through `Node::serialize_args()`. Forget it and the round trip silently builds a different node.
- A node with runtime-mutable config overrides `dump_config()` to emit replay verbs from its own STATE. `Partition_Node` is the reference: it emits `allow_large_writes` or `void_warranty`, plus the `with_index` formatter name.
- `Schema_Reflection`'s declarative `toggle` and `setter` kinds synthesize both the handler and the `dump_config` fragment from one declaration. Prefer a declaration over a hand-rolled handler-plus-fragment pair.
- A diff reintroducing a side-channel invocation ledger (`mark_verb_invoked()`, `$invoked_verbs`) is wrong: config lives in the node.

### 8d. Tachikoma rule #2 — everything sinks into the interpreter

- JS dashboards mount onto `mountExospine()`, which returns the five backbone nodes — `interpreter`, `router`, `shell`, `http`, `heartbeat` — plus `reinit` and `teardown`. `_command_interpreter` sinks into `_router`; everything else sinks into the interpreter, and the router stays bare with no sink and no target.
- Flow is steered by each node's `target` and by TO through `_router`. A diff adding bespoke `nodeA.sink = nodeB` chains or a `controlSink` side channel, or skipping the interpreter, is a conformance regression.

### 8e. JS node-class resolution and the timer grid (ADR-16, ADR-17)

- A NAME is the TEXT surface: TSL, the console palette, `make_node` typed at the REPL. A programmatic builder hands `makeNode` the **class**, imported from the `register.js` that owns it, because `CommandInterpreterNode.includeNodes` is a per-bundle static and a hub tab building its graph through another bundle's interpreter cannot resolve a name that bundle never registered. `lint-contract.mjs` rules `name-lookup-in-hook` and `name-lookup-in-option` enforce it, waving through the runtime's own classes.
- The wall-clock grid lives in `TimerNode` and nowhere else. A subclass picks a harmonic interval and never computes a boundary; the `grid-math` rule keeps `nextBoundary` and `GRID_PHASE_MS` inside that file. ONE phase serves every cadence, so 5s/10s/15s/30s polls converge and batch into one POST. A per-interval phase destroys exactly the alignment the grid exists for.
- The grid is deliberately JS-only. PHP's `Timer_Node` paces from its own last fire, because a worker pays no per-tick cost the alignment would save.
- A JS interpreter verb that alters the canvas-visible graph must join `MUTATING_VERBS` in `src/debug-overlay/useGraphReset.js`, or its edit stays invisible to the Reset Graph chip on both the debug overlay and the Topology Console. The set is deliberately narrow — `make_node`/`make`, `remove_node`/`remove`/`rm`, `connect_node`/`connect`, `disconnect_node`/`disconnect` — because the canvas draws edges from the `target`/`targets` union `dumpMetadataPayload()` builds (ADR-19), never from `sink`. That is why `set_sink` is absent though it rewires the physical pipe, and it is the right call rather than an oversight: a sink rewire changes nothing drawn. Ask a new verb the same question — does it change a node's presence, or its drawn targets?

### 9. Dumper and terminal rendering

`Dumper_Node` renders TYPE through `Message::type_labels()`; a diff changing what it prints must keep the JS mirror in step. The `debug_level 2` envelope block is the larger parity surface: `Dumper_Node::format_envelope_dump()` and `formatMessageEnvelope()` in `src/runtime/dumper-node.js` emit the same `Message { … }` lines in the same field order — type, timestamp, from, to, id, key, value — with the same 15-space continuation indent and the same trailing-newline trim on the value. Two more surfaces ride on that shape: the topology console's Triage view imports `formatMessageEnvelope` to display one captured message, and its Timeline view scans the block line by line for a `DEBUG:` trace, which stays findable only while the trace rides its own `value:` line.

The `help <NodeType>` block is a third mirror and the one nothing pins. `Node_Schema_Help::render()` and `CommandInterpreterNode._renderNodeSchema()` must move together section for section and column for column, down to `_renderDefault` / `_schemaList` / `_schemaText` against the PHP privates. `Shell_Node::parse_statements()` has `tests/fixtures/statements/` and the signing string has `tests/fixtures/signatures.json`, but here `NodeSchemaHelpTest` asserts substrings while the JS test asserts the exact block, so a PHP-only formatting change passes both suites and breaks parity in silence. Read that one by hand.

`Stdout_Node::write()` — the plain parent path `TTY_Out_Node` falls back to — `fwrite`s verbatim and appends nothing, so anything whose text reaches a terminal carries its own terminator. That is why `Command_Interpreter_Node::tabulate()` ends each row with a newline and no closing `rtrim`, why usage lines and verb returns end in `\n`, and why ELN's `Reqgrep_Command::emit()` does `rtrim( $text, "\n" ) . "\n"` before filling. A new verb or CI handler returning an unterminated string runs its output into the next prompt.

ANSI redraw belongs to `TTY_Out_Node`, which settles `posix_isatty( STDOUT )` once at construction and sends every write down that plain path when the stream is a pipe or a file. It carries two redraw shapes, chosen by `set_readline_mode()` off the same `CLI_Command::terminal()` decision that installs readline: in readline mode it writes carriage-return, erase-line, the text and a hand-reprinted prompt; in the `fgets` fallback it wraps that in save-cursor and restore-cursor so the operator's typing position survives. Collapsing the two `fwrite` calls means reaching for `readline_redisplay()`, which flips the display into incremental search — readline keeps its own model of what is on screen. Leave them apart.

Readline is separate, and three things hold it. `CLI_Command::terminal()` enables it only when `posix_isatty( STDIN )` is true AND the extension is loaded, because `readline_callback_read_char()` reads the TTY layer and burns 100% CPU on a pipe. `TTY_In_Node::drain_once()` then gates each read behind a zero-timeout `stream_select` on the reader's own stream, because `rl_getc` blocks on an idle TTY and one blocking read holds the entire drain loop — every timer, the IPC Consumer, every cURL handle — until the operator types; its `\ValueError` catch falls through to reading anyway, since PHP drops an unselectable stream from the read array and then throws on the empty one, and reading that as "not ready" would wedge the reader permanently. The third is an ORDER rather than a test: `TTY_In_Node::__construct()` registers the completion callback and seeds no candidates, and `CLI_Command::run_repl()` fires the first `send_completion_queries()` only after `Dumper_Node::set_completion_sink()` is wired. Move the seed into the constructor and the reply has nothing to consume it, so the Dumper renders both raw candidate lists onto the operator's terminal at startup. Don't drop a gate, don't reorder construct-then-wire-then-seed, and guard any ANSI escape you add.

### 9b. Config defaults live in code (ADR-20)

- Every substrate setting is declared once in `Settings_Schema` as a `Config_System\Field`, carrying its DEFAULT along with its bounds and restart class. `Config`, `Admin` and `newspack-nodes-config.php` all derive from it. A diff reintroducing a parallel hand-maintained option list in `Config` or `Admin` is a regression — add the setting as a `Field`. Every config read in the process builds that schema, in workers and WP-CLI runs rather than admin requests alone, which makes two things inside `Settings_Schema::get()` load-bearing while they read as cleanup opportunities: the `'newspack_nodes_'` option prefix is spelled as a literal instead of `Admin::OPTION_PREFIX`, and each label is a `static fn(): string` thunk resolved only at render time. The render and sanitize callables name `[ Admin::class, '…' ]` and are never invoked here. Swap the literal for the constant, or resolve a label eagerly, and every worker's boot pulls in the admin class or `__()`.
- The config files are override surfaces and nothing more. The declared key set derives from the SCHEMA, never from a file; `Config::value()` refuses an undeclared key. An unrecognized key IN a config file is REPORTED through `unrecognized_keys()` and the `config-keys` health check, never thrown — the first read happens at `plugins_loaded:-10001`, and the operator owns that file, so a throw would take wp-admin down the day a key is renamed.
- `newspack-nodes-config.php` ships every key commented out beside its default, and `ConfigSchemaTest` parses those lines back and compares them to `Settings_Schema::defaults()` key for key. A new setting means touching both.
- A `Field`'s restart classification names CONSUMER NODE TYPES, never topology names. `Restart_Planner` matches each declared type against every active topology's parsed graph by ancestry, so `Log` matches a `Partition` declaration and `Tap` matches `Tee`. A topology name is deployment config — renamable, and shadowable from the user dir — so a name-keyed classification signals a lock dir that does not exist and no-ops in silence.
- Five `Config_System` files are loaded by consumers in hermetic harnesses without the substrate — `class-{field,schema,options-overlay,reset-gate,field-reset-assets}.php`. Never add a `Core::` or other substrate call to those five; pyrobase's mock suite fatals on it. `class-settings-renderer.php` and `class-restart-planner.php` are not hermetic and legitimately use the substrate.

### 9c. Presence-based config overlay

`Config_System\Options_Overlay::apply()` is presence-based: a *stored* option — even `''`, `[]`, `false` or `0` — overrides the file default, and only an *absent* row falls back. The test is `get_option( $prefixed, self::ABSENT )`, never truthiness. Flag a diff reverting to a truthiness test, where a blank stored option masks the file default (the `memcache_servers` bug).

### 9d. Substrate-owned cache handles

`Core::$memd` is the one shared `\Memcached` handle, built by `Bootstrap::init_memcached()` from the `memcache_servers` config. It is `null` on empty or invalid config **deliberately** — command auth refuses, SSE slots fail closed, stats fail soft. A diff installing a fallback handle instead of leaving `null` contradicts the design; don't add one.

`Cache_Backend` is the tier resolver above it: `local_first()` (APCu, else memcached) for same-host hot surfaces, `shared_first()` (memcached, else APCu) for cross-process sources of truth. A claim must never straddle tiers — a nonce claimed locally and checked shared is no claim at all. Null means nothing is available and the caller keeps its fail-closed behavior.

It also owns the key grammar, and every key composes through `Cache_Backend::key( $scope, $logical )`: `site_key()` scopes what one INSTALL owns, `host_key()` the per-MACHINE SSE slot budget. One install-wide salt sits inside every scope, which is why `rotate_salt()` orphans the whole install's keys at once. A key concatenated by hand is unreachable from `wp nodes memcache get`, which rebuilds the address from the logical name alone.

### 9e. `Job_Worker_Node` contract

Local and remote handler maps come from the `newspack_nodes/{job,remote_job}_handlers` filters, selected by the entry's `k`. The node runs `gc_collect_cycles()` after every job and `wp_cache_flush()` every `cache_flush_interval` jobs (`CACHE_FLUSH_INTERVAL = 50`, clamped to a minimum of 1). It fires `newspack_nodes/job_worker/before_job` as a FILTER a listener may decline with an explicit `false`, `…/after_job` as an action in a `finally`, and `…/job_worker/batch_complete` when a batch's outstanding count reaches zero. It answers one TM_REQUEST verb, `GET_HEALTH`, which REPORTS memory (`memory_used_mb` / `memory_limit_mb`) without acting on it — the watermark stop belongs to `Cooperative_Stop` (`MEMORY_WATERMARK_PCT = 0.80`), and re-implementing any of that in a node is how a process ends up with no watermark at all. Per-identity run stats leave through the `probe_stats()` seam a `Job_Probe` sweeps. A diff bypassing the handler-map filters, dropping the `after_job` cleanup, or growing a second restart mechanism is a smell.

### 9f. Capability roles and the admin gate

Three roles cut by blast radius — `read` (dashboards, SSE, introspection), `tune` (declared configuration and application data) and `manage` (fleet control and credentials) — resolve through the filterable `newspack_nodes/capability_map`, all three defaulting to `manage_options`. Know what `read` grants before widening it: its live surface is the RAW log firehose over SSE, not shaped dashboards alone.

A verb declares its role in `node_schema()['commands']`, and `Service_CI_Node::commands()` runs every table through `gate_table()` on INSTALL, wrapping each handler in `Capabilities::require()` for the role the schema names that verb. A hand-built table is gated too — the lookup is by verb NAME — and a name the schema does not declare gets MANAGE, the strictest role rather than the loosest. What escapes is a table that never passes through `commands()` at all: an assignment straight to the inherited `protected $commands`, or a `commands()` override that skips the gate. Flag the reverse case as well, because the role is keyed by name rather than by handler: a table installed after construction under a schema-declared name inherits that declaration's role while the handler beneath it is a different callable, so the role on file no longer describes what runs.

`Admin::current_user_allowed()` is the single funnel for the settings UI: `Capabilities::can( MANAGE )` first, then the optional `allowed_users` login whitelist (empty means every user holding MANAGE). A diff bypassing it on an admin entry point, or weakening the whitelist, is security-relevant.

### 10. Command interpreter dispatch and authorization (ADR-15)

Before any verb dispatch, `interpret()` runs the authorization gate (`$this->authorize ?? self::$default_authorize`, falling back to a bare LOCAL test). The client tier requires the `Message::LOCAL` provenance taint; verifier processes — workers and the `/command` request scope — install `Command_Auth::verifier()`, which admits a command only when LOCAL is set or a valid HMAC envelope at `VALUE['auth']` verifies. An unauthorized command replies `TM_COMMAND|TM_ERROR` (`unauthorized: <verb>`) without running the handler. Don't drop the authorize call or weaken the verifier tier.

**The minter signs; the ingress only verifies.** `Command_Auth::sign()` uses the per-site secret for same-host IPC; `sign_for( $destination, $message )` signs under the session established with that remote and stamps its handle, so which key signs IS the destination binding — a signature verifies only where its session lives. Re-addressing a signed command after the mint makes it verify nowhere. A diff that signs on arrival turns the boundary into an oracle: anything reaching it would acquire authority. No session means no signature; a minter waits rather than emitting a refusal.

The canonical signing string covers semantics only — `[ ts, name, arguments, nonce ]` — never TO, FROM or TYPE, which Router peels and nodes stamp in transit. `tests/fixtures/signatures.json` pins that parity across both ports; a change to the string is a change to both.

A verified session's SCOPE is a ceiling that can only subtract. `verify()` installs it as `Capabilities::$session_scope`, slams it to `Capabilities::NONE` on every refusal, and `interpret()` restores whatever stood before in a `finally` — without that restore a worker sits at its first caller's ceiling for its whole ~595s life.

`Command_Interpreter_Node` handles a TM_COMMAND only when TO is empty and TM_RESPONSE is clear. A non-empty TO means the message is mid-route toward a downstream node, so the interpreter forwards to its sink. Don't relax that, or every interpreter in a path-routed graph consumes commands meant for someone else.

Verb handlers throw freely; `interpret()` catches `\Throwable` and turns the response into `TM_COMMAND|TM_ERROR` addressed back along FROM. Don't restore a per-verb `try/catch` — the central catch is the contract. A refusal THROWS; a `return` is a result. Reserve `return 'error: …'` for values a caller consumes — the five files that do are `trait-{dead-letter-queue,durable-reader}.php` and `class-{partition,table,settings-sync}-node.php`.

Aliases share one `cmd_foo`, and `init_C()` builds two tables that must stay in lockstep: `self::$C`, the dispatch table completion reads, and `self::$H`, the help topics `cmd_help()` lists. A third map, `$alias_to_canonical` inside `cmd_help()`, resolves an alias to its `$H` key. Adding or removing a verb means auditing all three. Leaving `'rm' => cmd_remove_node` after dropping `remove_node` is a silent zombie verb.

### 10b. Service-CI schema changes update `docs/API.md`

Adding, renaming or removing a verb or its arguments on any `*_CI_Node` `node_schema()['commands']` — or changing a `dump_graph` / `dump_metadata` payload shape, or adding a `newspack_nodes/*` action or filter — MUST update the matching row or paragraph in `docs/API.md` in the same diff. Its Service-CI and hooks tables are hand-kept, so a dropped verb leaves a ghost. `scripts/lint-docs.sh` guards the `Aggregator_CI_Node` row alone, greping it for three verbs that class does not declare — `status`, `health` and `servers`. Review the rest by hand.

### 11. A declared destination is not a route (ADR-19)

`Node::extra_targets()` declares the destinations a node writes WITHOUT going through `target` — a partition filled directly at flush, a conditional per-message TO. `Node::display_targets()` unions them with `target_list( target() )`, primary first, de-duplicated, empties dropped, and the union is consumed by PRESENTATION only: `ls`'s TARGET column and `dump_metadata`'s `targets` key. `fill()` continues to read `$this->target` alone, and a caller appearing for `display_targets()` on the routing path means ADR-7 is the decision in play.

The union is POSITIONAL, and index 0 is the routing target only when a routing target is SET: a node with an empty `target` and one declared extra puts the EXTRA at index 0. A consumer that needs the routing value reads `target`; one that must split the union splits by the routing COUNT, never at a fixed index.

### 12. A Table may front a durable record; the walk stays in the app (ADR-18)

`Table_Node::backed_by( \Closure $backing )` lets `lookup()` and `lookup_multi()` fall through on a miss, store what comes back, and serve it; `lookup_multi()` hands the WHOLE miss set to the backing in one call, so a per-key backing defeats the round trip it exists for. A restored entry may carry its own remaining `ttl`, because handing it a fresh full TTL would extend the life it is being restored into. A backing must never write through `store()`, which applies the table's own TTL. Warming is best-effort: a cache failure must not become a data failure.

The complement is the boundary. Finding WHICH record answers a key is the app's business: `Partition_Node::locate_by( \Closure $extract, array $wanted = [] )` takes the caller's line parser and the key set, and returns key → position for those keys ONLY — the key set is what bounds the walk and the memo, because a whole-index table grows with the partition rather than the query and exhausted a 512 MB request. `read_many()` then reads one file handle per SEGMENT. A diff pushing the line format down into Partition, or dropping the key set to "resolve everything", reopens both bugs. `locate_by()` resolves a key to its NEWEST record in one newest-first pass; `tests/unit/PartitionTest.php::test_locate_by_resolves_a_repeated_key_to_its_newest_record` pins it, and the remaining-TTL rule above is why resolving to an older write would make a live entry vanish silently.

### 13. Owned siblings

A node that constructs another node it owns publishes it with `publish_sibling( $kind, $sibling )`; publishing IS declaring, so there is nothing to forget. `set_sibling_names()` is the ONE namer — reached from the publish and from every rename — and `sibling_name( $kind )` the ONE reader anything addressing a sibling composes through, so the key and the name cannot drift. `retract_sibling( $kind )` is publishing's exact inverse: it tears the sibling down AND empties the slot, because a slot the cascades still reach re-registers a dead node, and a name the registry still holds refuses the slot's next occupant.

Two hooks are protected and overridable — `set_sibling_names()` and `check_name_availability()` — and an override MUST call `parent::`. `Remote_Link_Node` overrides the namer to re-address HTTP_Out at the renamed Null; one that forgot the `parent::` call would stop naming every sibling, with no other symptom. **No gate catches that** — `lint-contract.mjs` reads JavaScript only. Reading the closing brace for a `parent::` call is the whole check.

A node that registers ITSELF by name at another node owes that registration a move in its own `name()` and a drop in `remove_node()`: the entry lives in the EMITTER's table, so nothing follows a rename. `Timer_Node` (the Router's TIMER list) and `Remote_Link_Node` (the fleet's RELOAD) are both that shape. A closure listener has no self-heal at all, because `notify()` keeps anything that does not return exactly false.

`patron()` must be set BEFORE `name()` and refuses otherwise: it is the interpreter's drop as well as the canvas-visibility flag.

### 14. A self-pacing node holds a RECURRING timer

`fire_cb()` disarms a oneshot BEFORE dispatching (`stop_timer()`, which also zeroes `interval_ms`), so a node re-arming a fresh oneshot at the bottom of its own `fire()` stays in the event loop only as long as it reaches that last line every tick. One early return, one throw, one refactor, and it leaves the loop silently and for good. The shape to look for: compute the interval you want, call `set_timer( $next_ms )` only when it differs from `interval_ms`, leave the recurring timer armed in between, and make a stop explicit. `Durable_Reader::fire()`, `Remote_Source_Node::fire()` and `Stdin_Node::fire()` are the live examples, and every arming site that starts them is recurring for that reason. The runtime arms a one-shot in two classes only: `Partition`, for its debounce-lock window and for the 0-delay flush that drains its batch at the end of the event-loop iteration, and `HTTP_Out`, for the 0-delay flush of its POST batch. Each is the legitimate shape — one wakeup, then nothing. The JS `TimerNode` mirrors all of it — `setInterval` is no protection, since the first fire clears it.

`Shutdown_Sweeper` and `Idle_Reporter` both scan `Core::$nodes_by_name`, so an implementor that never takes a NAME reports nothing and flushes nothing. One node escapes that scan by design, and it is hand-wired: `Cooperative_Stop` merges the deliberately anonymous IPC-input Consumer into the idle fold through `$ipc_reporter`, because an attached REPL is someone using the worker and a scan that could not see the reader would exit under them.

### 15. A signature change must degrade for a stale consumer

The substrate ships before its consumers by necessity — a consumer pins the substrate tag, so that tag exists first — which makes the window where a host runs the new substrate against an older consumer guaranteed rather than hypothetical. Adding a REQUIRED parameter to a method on the frozen surface (`docs/stability.md`) closes that window with a fatal: `Partition_Node::locate_by()` briefly required its key set, and an older `Flame_Builder_Node` reaching it through `Table_Node::lookup_multi()` raised `ArgumentCountError` — an uncaught 500 on every dashboard request, worse than the OOM it was fixing. Give a new parameter a default whose behaviour is safe but useless (there, `[]`, which reads nothing). A change to a frozen surface also earns an entry in `docs/upgrading.md` with the rewrite beside it.

### Reply correlation — the routing already did it

A node mints a command stamped `FROM = <its own name>`; the server replies `TO = FROM`; the reply lands on that node and its `fill()` handles it. The addressing IS the correlation. REJECT any diff that adds:

- an op-id minted into `message[ID]` so a reply can be matched;
- a `{ resolve, reject }` map keyed by that id, or any registry of pending replies;
- a transport method returning a Promise the caller awaits;
- `KEY` pressed into service as a demux discriminator.

"Several verbs batch into one tick, so replies need telling apart" is one node doing N jobs. The fix is N nodes, each with its own FROM — split by JOB, never by SUBJECT, because the subject rides in the ADDRESS. See `addSliceFetcher`'s docblock ("an independent reply path per slice, nothing crossing") and `RuntimeView`'s two pollers. Batching is orthogonal: `HTTP_Out`'s lock and flush already put the whole tick in one POST. `lint-contract.mjs` catches them in JavaScript across five rules; PHP has no such gate, so read for them.

## Style gates (lighter-weight)

- WordPress VIP Go: snake_case, Yoda conditions, tabs, spaces inside `( $args )`. PHPCS catches most of it (`npm run lint:php`).
- Inline comments are ONE line, 80 visual columns or fewer, gated by `scripts/lint-comments.{php,mjs}`. Both halves also read two or more adjacent bare comment lines as a run wanting a docblock, a single line or an `@longform` first line, so a short-lined paragraph fails as surely as one long line does. PLACEMENT is the PHP half's alone, because it tracks scope and the `.mjs` does not: at class-body level PHP allows only a docblock immediately preceding its declaration, while the same stray `//` inside a JS class body passes the gate and needs a reader to catch it. A genuinely uncondensable footgun opens its FIRST line with `@longform`; a docblock is exempt from the length gate already, so the tag there is an error.
- Use `wp_json_encode()`, not `json_encode()`, for anything that might encode user-supplied UTF-8.
- Pick the right `Core` coercion family — the guard is in the name. `as_string`/`as_int`/`as_float` are lenient casts; `num_int`/`num_float` are validated numeric casts for arithmetic paths; bare `str`/`arr`/`int` are exact-type passthrough with no conversion. None of them suits an OPERATOR-supplied value, because every numeric family answers with a number, so `--partition=abc` picks p0 and restarts the wrong fleet: read an option through `Command_Args::option_int()` and report the null in your layer's voice (`CLI::require_flag_int()`, `Service_CI_Node::require_option_int()`). A positional `make_node` token needs none of it — declare its `type` in the schema and let `parse_schema_args()` refuse.
- PHPDoc on public methods. Internal helpers can skip it when the name and signature explain themselves.
- `@wordpress/*` stays pinned to the `wp-7.0` dist tag. The build externalises the family to the `wp.*` globals, so npm's copy never ships: a bump delivers no new code, and it moves the API the diff compiles, lints and type-checks against AHEAD of the one the browser is handed, with nothing mechanical to catch the mismatch. An advisory reachable only past the pin is dismissed, not bumped.
- Conventional commit messages (`feat:`, `fix:`, `refactor:`, `test:`, `docs:`).

## Tests

Substrate tests live in `tests/{unit,integration}/` — 206 unit files (with `Admin/`, `ConfigSystem/`, `Rest/` and `SpawnCoordinator/` beneath), 14 integration files, and the 9-file `examples/` suite. A new Node subclass needs a test exercising its `fill()` against a `Capture_Sink_Node` to assert what gets forwarded; a new verb needs a case in its interpreter's test — `CommandInterpreterTest` for the shared table, the CI's own test for a `Service_CI_Node` verb — covering both the authorized and the refused path.

Each test must fail on the OLD code and be seeded with values distinct from every default and fallback — one seeded with the default still passes when the change is ignored. `tests/bootstrap.php` shims WordPress rather than loading it; check it before adding a new global function call. Run the suite with `--enforce-time-limit`, so a test blocking on stdin or spinning in a drain loop aborts at its budget instead of hanging.

`Topology_Registry::$spawn_runner` is the worker-spawn seam: a public static `?\Closure` standing in for the one real `Worker_Base` construction and `execute()` inside `spawn_worker()`, taking the whole `expand_workers()` descriptor (`function ( array $descriptor ): void`) so the active-set guard and the descriptor lookup keep running as production code. `Topology_Registry::reset()` clears the stock dirs, the user dir, the `register_plugin` guard and the parsed-TSL caches, but NOT that closure, so a case assigning it must null it in `tearDown` — otherwise every later spawn in the same process is captured instead of executed, and silently, since `spawn_worker()` reports nothing either way.

The push gate holds every `includes/` class and every `src/` file at 90% statement coverage. A file landing below that fails the push, not the review.

## Common review nits that aren't bugs

- "Dead code" that is a `*_Node` class is usually alive. `make_node` resolves a type against the registered namespace prefixes (`{$prefix}{$type}_Node`), and the palette catalog scans the composer classmap; neither leaves an explicit registration call to grep for. Don't flag a Node subclass as unused. REST controllers are the same shape.
- Most PHPStan dead-code findings on this plugin are public API, WP-CLI entry points, JS-PHP wire constants or test seams. Verify every call path — siblings, JavaScript, dynamic — before deleting.
- After adding or renaming a Node class, the diff needs a `composer dump-autoload -o`. Autoloading here is classmap-only, so until the map is regenerated neither `make_node`'s `class_exists()` nor the palette catalog can see the class.

## Related Skills

- `nodes-workflow` — implementation workflow
- `nodes-debugging` — debugging at runtime
- `nodes-dashboards` — building a dashboard, inspector or panel
