---
name: nodes-review
description: Code review checklist for substrate (newspack-nodes) changes. Use whenever reviewing a diff that touches Node, Message, Router, Topic, Partition, Tee, Tail, Consumer, Worker, Supervisor, or anything else under the newspack-nodes plugin's includes/.
argument-hint: "[file or class]"
---

# Newspack Nodes Review Checklist

Substrate-specific review pass. The ADRs in `docs/architecture-decisions.md` (AGENTS.md decisions 1-14) carry the rationale; this skill applies them to a diff.

## When to Use

After any code change inside `newspack-nodes/includes/`, before pushing or merging. General WordPress / VIP Go review patterns still apply; this skill adds the substrate gates.

## Gates (in order of catastrophic-bug potential)

### 1. PIPE_BUF discipline

If the diff touches `Partition_Node` (shell-name Partition) `fill()`, its batch logic, or anything else writing packed Messages to disk:

- Default `MAX_LINE_SIZE` is 4096 bytes. Anything larger MUST be on an `allow_large_writes()` Partition, which auto-locks via `Lock_Node` at `{partition_dir}/write.lock.d/`.
- A diff that raises the small-write cap is wrong: it breaks atomic-append for every concurrent producer.
- A diff adding a >4KB producer without making the Partition allow-large MUST silently drop the message; verify the drop path.

### 2. Lazy-init for Topic / Partition

These instantiate in request scope — LogManager constructs a Topic per request whether or not the request logs. The constructor must NOT:

- Call `set_timer()` — no EventFramework is draining yet, so the timer registers but never fires; a silent leak.
- Call `Core::node()` — it likely returns null at construct time.
- Call `scandir()` or any other I/O — wasted syscalls per request × N partitions.

Push any of those to first use (first `fill()`, first `read_at()`).

### 3. FROM stamping — two distinct operations

Don't conflate them:

- **Mint FROM (set FROM=own name).** A node that *mints* a brand-new message sets FROM to its own name: the I/O-boundary minting sources (Timer, Tail, Consumer), `Node::command()` (the envelope is tagged with `$this->name`), and interpreter responses. The Consumer offsetlog checkpoint record also carries the Consumer's name in FROM. None are bugs; don't flag them.
- **Breadcrumb-prepend `stamp_message()` (prepend own name to an existing FROM trail).** Used only at the Consumer and HTTP_In I/O boundaries. `stamp_message()` on a Tee, Hook, Callback, or any application-style forwarder is almost certainly a bug — it pollutes the breadcrumb trail and breaks reverse-direction routing. Pass-through forwarders relay the message untouched.

The `MAX_FROM_SIZE = 1024` guard on `stamp_message` is essential — don't remove it. Cycles will otherwise explode FROM.

### 4. CRC32 + 31-bit-mask routing

`Partition_Node::hash_to_partition()` is canonical. Any diff introducing partition routing (Topic, JobIntake-keyed mode, anything else) MUST call it. Diverging hash families silently misroute the same key to different partitions across producers, corrupting ordering.

The function strips query strings (`explode('?', $key, 2)[0]`) before hashing. Don't bypass that — `?cache=...` parameters were the motivating bug.

### 5. TO=FROM convention

Forward direction: `TO=$this->target` (Node::fill stamps it if empty).
Reverse direction (any response, error, ack): `TO=$message[FROM]`.

`sink` is the physical next node `fill()` forwards to; `target` is the logical destination — a path string stamped into `message[TO]` only when TO is empty (Tachikoma's `owner`; this port has no `edge`). `_router` resolves a non-empty TO. A diff that conflates them, or invents an `edge` property, is a smell.

### 6. Worker lifecycle ordering

`WorkerBase::execute()`'s `finally` block does `release()` THEN `self_respawn()`. Reversed, the new worker fails to acquire the lock the old one still holds, and the spawn rate-limit keeps the slot empty for 15s. Don't reorder.

The HMAC spawn token validates against TWO windows (current + previous, 10 seconds each). Don't tighten to one — race tolerance for tokens generated near boundaries is intentional.

### 6b. `fill()` returns void (ADR-13)

Every node's entry point is `fill( array $message ): void`. A node emits into its sink and learns *nothing* about what happened downstream — delivered, dropped, queued, transformed. Flag any diff that:

- Drops the `: void` return type, or adds a non-void return type to a `fill()`.
- Uses `return <expr>;` inside a `fill()` body (bare `return;` for early exit is fine).
- Reads, assigns, or branches on a `fill()` call's result (`$x = $sink->fill(...)`). A node that must know an outcome receives it *as a message* — a `TO=FROM` reply (ADR-7) or a `TM_ERROR` (ADR-3) routed back — never a return value.

Testing stays "construct a message, call `fill()`, inspect the *sink*" (`Capture_Sink_Node`), never "inspect `fill()`'s return."

### 6c. Cooperative-stop propagates through broad catches (ADR-14)

`Event_Framework::pump()` raises `Worker_Should_Stop` (extends `\RuntimeException`) to unwind a long in-process job on timeout, memory, or shutdown. Any broad `catch ( \Throwable )` / `catch ( \Exception )` on the message/drain path MUST re-throw it **first**, before anything else:

```php
} catch ( Worker_Should_Stop $e ) {
	throw $e;   // cooperative-stop signalling, not an error
} catch ( \Throwable $e ) {
	// real error handling
}
```

A broad catch that logs, wraps `TM_ERROR`, or defers `Worker_Should_Stop` without that explicit-first re-throw swallows the stop, and the worker runs past its deadline — a live bug that guaranteed a mid-job stop only on the direct firehose path, because an intervening Tee / Command_Interpreter ate it. Three deliberate carve-outs, each documented at its site; don't flag them, but don't let a new broad catch omit the re-throw:

- **Tee / Tap fan-out** — attempt every target; a `Worker_Should_Stop` still overrides the deferred first-throwable slot, because a stop must re-play, not advance the cursor past poison.
- **Tap** swallows a regular target throw (a broken tap can't break the pipeline) but re-throws `Worker_Should_Stop`.
- **Post-success `finally` (`Job_Worker::after_job`)** swallows everything, WSS included — the handler already succeeded, so propagating from cleanup would false-poison a completed job (ADR-12).

### 7. No TM_PERSIST / answer / cancel

These were deliberately removed (`-743` / `+83` line diff). If the removal gets reverted, push back hard — it's dead weight given the synchronous I/O model. The substrate is fire-and-forget; backpressure happens naturally because every step blocks on its downstream's I/O.

If a diff seems to need ack/cancel for a real reason, build slot-tracking at the producer that needs it — don't reintroduce a global persist contract.

### 8. Type flag semantics

- `TM_BYTESTREAM` (1): VALUE is a string (raw bytes / JSONL line / text)
- `TM_STRUCT` (16): VALUE is structured (array)
- They are mutually exclusive by our convention — pick the one that matches VALUE

Full type-flag bitmask from `includes/class-message.php`: `TM_BYTESTREAM=1`, `TM_EOF=2`, `TM_PING=4`, `TM_COMMAND=8`, `TM_STRUCT=16`, `TM_ERROR=32`, `TM_INFO=64`, `TM_REQUEST=128`, `TM_RESPONSE=256`, `TM_NOREPLY=512`. A consumer reading `$entry = $message[Message::VALUE]` as an array MUST gate on `TM_STRUCT` (16). Don't conflate it with `TM_RESPONSE` (256) — different bits.

`TM_NOREPLY` (512) is the only reply-control flag kept from Tachikoma: a Shell with `want_reply(false)` (topology load / script mode) ORs it onto commands, and the interpreter suppresses the reply. `LOCAL` (7) is not a type flag but the appended provenance taint `packed()` strips at the process boundary, so it can't cross processes; the command-auth gate's default tier admits a command only when LOCAL is set or an HMAC verifies.

### 8b. `arguments()` Tachikoma-parity (v0.6.0)

- Ctor must be parameter-less for `make_node`-buildable nodes; positional config is declared in `node_schema()['arguments']` as `[{name, type, default?, required?}]`.
- Schema `default` is a real typed value (ints, floats, class constants) or a `<ns:key>` token string (e.g. `'<config:max_segments>'`), which `parse_schema_args`'s `resolve_default()` resolves through its namespace resolver and coerces to the declared type. A schema default lives in PHP and never passes through the TSL loader, so a token default resolves here rather than crashing the walker.
- `arguments( ?array $args )` overrides take a **token array** (`list<string>`), not a string. Follow the `Partition_Node` reference: `if ( null === $args ) return parent::arguments();` (pure getter), else `parse_schema_args( $args )` then derive. There is NO `'' === $args` short-circuit — `parse_schema_args` fills each missing token from its schema `default` or **throws** on a missing `required` arg, so a bare `make_node Foo` fails loud instead of writing filesystem-root junk like `/p0`.
- Per ADR-5, event-loop and filesystem work (`set_timer`, `mkdir`, `fopen`, `Partition_Node` materialization) stays OUT of both the constructor AND `arguments()` for request-scope nodes (Topic/Partition); file handles open lazily on first `fill()`/`read_at()`.
- Programmatic dependencies (objects, callables, streams) are public properties the caller sets after construction, NOT ctor params. `Workers_CI_Node::$cli` is the reference.
- Schema field names are `'arguments'` and `'commands'`. A diff reading or writing `'ctor'` or `'verbs'` is a regression (renamed in v0.6.0).
- Schema `default`s apply **per-position when the token list runs short** (`isset( $args[$i] )` is false for that position): `make_node Foo` (no args, empty token list) walks every position and each takes its schema `default`, or throws if `required`. The class property default and the schema `default` should agree, so the value is the same either way.

### 8c. `dump_config` round-trip

- A Node with runtime-mutable config overrides `dump_config()` to emit replay verbs from its own state. Reference: `Partition_Node`'s emission of `allow_large_writes` + `with_index` formatter name.
- A diff reintroducing `mark_verb_invoked()` / `$invoked_verbs` is wrong — the recorder was deleted in v0.6.0; config lives in the node, not a side-channel ledger.

### 8d. Tachikoma rule #2 — everything sinks into the interpreter

- JS dashboards mount onto `mountExospine()` (returns `{ interpreter, router, teardown }`); every node has `sink = interpreter`, and flow is steered via `target` / `TO` through `_router`.
- A diff that adds bespoke `nodeA.sink = nodeB` chains or `controlSink` side-channels, or skips the interpreter, is a substrate-conformance regression.

### 9. Dumper rendering

If the diff changes how Dumper renders a TYPE flag, check the cli output still reads correctly both interactive and piped. The `set_readline_mode` flag gates on `posix_isatty(STDIN)`; piped sessions take the plain-write path, so guard any ANSI escapes you add.

### 9b. Config System schema (single source of settings)

Settings are declared once in `Settings_Schema` via `Config_System\Field` / `Config_System\Schema` (v0.13.0); `Config` and `Admin` derive their key-list, option names, reset list, and register/render loops from it. A diff reintroducing a parallel hand-maintained option list (the old `Config::$option_schema`, `Admin::$option_names`, or `$delete_on_blank_options`) is a regression — add the new setting as a `Field` in the schema.

### 9c. Presence-based config overlay

`Config_System\Options_Overlay::apply()` is presence-based (v0.12.0): a *stored* option — even `''`, `[]`, `false`, `0` — overrides the file default, and only an *absent* option falls back, sentineling on `get_option(..., $missing)` rather than truthiness. Flag a diff reverting to a truthiness-based overlay, where a blank stored option masks the file default (the `memcache_servers` bug).

### 9d. Substrate-owned `\Memcached` handle

`Core::$memd` is the one shared handle, built by `Bootstrap::init_memcached()` from the `memcache_servers` config. It is `null` on empty or invalid config **deliberately** — command-auth refuses, SSE slots fail closed, stats fail soft. A diff installing a fallback handle instead of leaving `null` contradicts the design intent; don't add one.

### 9e. Job_Worker_Node contract

`Job_Worker_Node` is a substrate node (promoted in the 0.12–0.14 era). Its contract: local and remote handler maps come from the `newspack_nodes/{job,remote_job}_handlers` filters; it runs a GC + cache-flush cadence and a memory-watermark self-restart; it answers `GET_HEALTH`; and it fires `newspack_nodes/job_worker/{before,after}_job` so apps hook per-job request context. A diff bypassing the handler-map filters, dropping the `after_job` cleanup action, or removing the memory-watermark restart is a smell.

### 9f. Admin access gate

`Admin::current_user_allowed()` is the single funnel for the settings UI: a `manage_options` baseline plus the optional `allowed_users` whitelist (v0.12.0; empty list = all `manage_options` users). A diff bypassing `current_user_allowed()` on an admin entry point, or weakening the whitelist check, is security-relevant.

### 10. CommandInterpreter dispatch contract

Before any verb dispatch, `interpret()` runs the authorization gate (`Command_Interpreter_Node::$authorize ?? self::$default_authorize`). The default client tier requires the `LOCAL` provenance taint (in-process command); verifier processes (workers, `/command` request scope) swap in `Command_Auth::verifier()`, which admits a command only when LOCAL is set or a valid HMAC verifies. An unauthorized command replies `TM_COMMAND|TM_ERROR` (`unauthorized: <verb>`) without running the handler. Review any diff touching `interpret()` or the auth wiring against this gate — don't drop the authorize call or weaken the verifier tier.

interpreter handles a TM_COMMAND only when TO is empty. Non-empty TO means the message is mid-route toward a downstream node, so interpreter forwards to its sink (Router). Don't relax that — otherwise every interpreter in a path-routed graph consumes commands intended for someone else.

Verb handlers may throw freely; `interpret()` catches `\Throwable` and turns the response into `TM_COMMAND|TM_ERROR` addressed back along FROM. Don't restore explicit `try/catch` inside individual `cmd_foo` methods — the central catch is the contract. Reserve `return 'error: ...'` for canonical-OK-shaped argument validation, such as malformed args caught before any work happens.

Aliases share the same `cmd_foo`. When you add or remove a verb, audit `$C` for orphaned alias rows — leaving `'rm' => cmd_remove_node` after dropping `remove_node` is a silent zombie verb.

### 10b. Service-CI schema changes update `docs/API.md`

Adding, renaming, or removing a verb or its args on any `*_CI_Node` `node_schema()['commands']` — or changing a `dump_graph`/`dump_metadata` payload shape — MUST update the matching row or paragraph in `docs/API.md` in the same diff. API.md's Service-CI table is hand-kept, so a dropped verb leaves a ghost (the 0.47.1 `Aggregator_CI` `status`/`health`/`servers` removal is the case in point). `scripts/lint-docs.sh` guards the aggregator row alone; review the rest by hand.

### Reply correlation — the routing already did it

A node mints a command stamped `FROM = <its own name>`; the server replies
`TO = FROM`; the reply lands on that node and `fill()` handles it. REJECT any
diff that adds:

- an op-id minted into `message[ID]` so a reply can be matched (`makeOpId`)
- a `{ resolve, reject }` Map keyed by that id (`PendingReplies`)
- a transport method that returns a Promise the caller awaits
- `KEY` pressed into service as a demux discriminator

"Several verbs batch into one tick, so replies need telling apart" is one node
doing N jobs. The fix is N nodes, each with its own FROM — see
`addSliceFetcher`'s docblock ("an independent reply path per slice, nothing
crosses") and `RuntimeView`'s two pollers. Batching is orthogonal: `HTTP_Out`'s
lock/flush already puts the tick in one POST.

## Style gates (lighter-weight)

- WordPress VIP Go: snake_case, Yoda conditions, tabs, spaces inside `( $args )`. PHPCS catches most of these (`npm run lint:php`).
- Use `wp_json_encode`, not `json_encode`, for anything that might encode user-supplied UTF-8.
- PHPDoc on public methods. Internal helpers can skip it when name and signature explain themselves.
- Conventional commit messages (`feat:`, `fix:`, `refactor:`, `test:`, `docs:`).

## Tests

Substrate tests live in `tests/{unit,integration}/` (~116 test files, ~2300 test methods), including `tests/unit/ConfigSystem/` and `tests/unit/Admin/`. A new Node subclass needs a test exercising its `fill()` with a `Capture_Sink_Node` to assert what gets forwarded; a new CommandInterpreter verb needs a CommandInterpreterTest case.

The test bootstrap shims a few WP functions (`wp_json_encode`, `wp_remote_post`, etc.) — check `tests/bootstrap.php` before adding a new global function call.

## Common review nits that aren't bugs

- "Dead code" that is a `*_Node` class resolved dynamically by `make_node` (namespace-prefix + `_Node`), scanned into the palette catalog, or a REST endpoint controller, is fine. A `*_Node` class has no explicit registration call to grep for — its only "caller" is `make_node`/the classmap scan. Don't flag a `Node` subclass as unused.

## Related Skills

- `nodes-workflow` — implementation workflow
- `nodes-debugging` — debugging at runtime
