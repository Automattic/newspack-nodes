---
name: nodes-review
description: Code review checklist for substrate (newspack-nodes) changes. Use whenever reviewing a diff that touches Node, Message, Router, Topic, Partition, Tee, Tail, Consumer, Worker, Supervisor, or anything else under the newspack-nodes plugin's includes/.
argument-hint: "[file or class]"
---

# Newspack Nodes Review Checklist

Substrate-specific review pass. Read AGENTS.md decisions 1-11 for the rationale; this skill is the application of those rules to a diff.

## When to Use

After any code change inside `newspack-nodes/includes/`. Run BEFORE pushing or merging. The general WordPress / VIP Go review patterns are still relevant — this skill adds the substrate-specific gates on top.

## Gates (in order of catastrophic-bug potential)

### 1. PIPE_BUF discipline

If the diff touches `Partition_Node` (shell-name Partition) `fill()`, its batch logic, or anywhere else that writes packed Messages to disk:

- Default `MAX_LINE_SIZE` is 4096 bytes. Anything larger MUST be on an `allow_large_writes()` Partition (which auto-locks via `Lock_Node` at `{partition_dir}/write.lock.d/`).
- A diff that quietly raises the small-write cap is wrong — that breaks atomic-append for every concurrent producer.
- A diff that adds a producer of >4KB messages without making the Partition allow-large MUST silently drop the message; verify the drop path.

### 2. Lazy-init for Topic / Partition

These get instantiated in request scope (LogManager constructs a Topic per request whether the request logs anything or not). The constructor must NOT:

- Call `set_timer()` — there's no EventFramework draining yet, so the timer registers but never fires; silent leak
- Call `Core::node()` — likely returns null at construct time
- Call `scandir()` or any other I/O — wasted syscalls per request × N partitions

If you see any of those in a constructor, push the work to first-use (first `fill()`, first `read_at()`, etc.).

### 3. FROM stamping — two distinct operations

Two different things set FROM; don't conflate them:

- **Mint FROM (set FROM=own name).** A node that *mints* a brand-new message sets FROM to its own name. Done by the I/O-boundary minting sources (Timer, Tail, Consumer), by `Node::command()` (the command envelope is tagged with `$this->name`), and by interpreter responses. The Consumer offsetlog checkpoint record also carries the Consumer's name in FROM. None of these are bugs — a reviewer shouldn't flag them.
- **Breadcrumb-prepend `stamp_message()` (prepend own name to an existing FROM trail).** Used only at the Consumer and HTTP_In I/O boundaries. If the diff adds `stamp_message()` to a Tee, Hook, Callback, or any application-style forwarder, that's almost certainly a bug — it pollutes the breadcrumb trail and breaks reverse-direction routing. Pass-through forwarders relay the existing message untouched; they don't re-stamp.

The `MAX_FROM_SIZE = 1024` guard on `stamp_message` is load-bearing — don't remove it. Cycle scenarios will explode FROM otherwise.

### 4. CRC32 + 31-bit-mask routing

`Partition_Node::hash_to_partition()` is canonical. Any diff that introduces partition routing (Topic, JobIntake-keyed mode, anything else) MUST call this function — diverging hash families silently misroute the same key to different partitions across producers, which corrupts ordering.

The function strips query strings (`explode('?', $key, 2)[0]`) before hashing. Don't bypass that — `?cache=...` parameters were the bug that motivated it.

### 5. TO=FROM convention

Forward direction: `TO=$this->target` (Node::fill stamps it if empty).
Reverse direction (any response, error, ack): `TO=$message[FROM]`.

The `sink`/`target` distinction matters: `sink` is the physical next node `fill()` forwards to; `target` is the logical destination — a path string stamped into `message[TO]` only when TO is empty (Tachikoma's `owner`; there is no `edge` in this port). `_router` resolves a non-empty TO. A diff that conflates these — or invents an `edge` property — is a smell.

### 6. Worker lifecycle ordering

`WorkerBase::execute()`'s `finally` block does `release()` THEN `self_respawn()`. Reverse order means the new worker fails to acquire the lock the old one is still holding; the spawn rate-limit then keeps the slot empty for 15s. Don't reorder.

The HMAC spawn token validates against TWO accepted windows (current + previous, 10 seconds each). Don't tighten to one window — race tolerance for tokens generated near boundaries is intentional.

### 7. No TM_PERSIST / answer / cancel

These were deliberately removed (`-743` / `+83` line diff). If you see the removal getting reverted, push back hard — it's dead weight given the synchronous I/O model. The substrate is fire-and-forget; backpressure happens naturally because every step blocks on its downstream's I/O.

If a diff seems to need ack/cancel for a real reason, the right move is to build slot-tracking at the producer that needs it — not reintroduce a global persist contract.

### 8. Type flag semantics

- `TM_BYTESTREAM` (1): VALUE is a string (raw bytes / JSONL line / text)
- `TM_STRUCT` (16): VALUE is structured (array)
- They're mutually exclusive in our convention — pick one based on what VALUE actually is

Full type-flag bitmask from `includes/class-message.php`: `TM_BYTESTREAM=1`, `TM_EOF=2`, `TM_PING=4`, `TM_COMMAND=8`, `TM_STRUCT=16`, `TM_ERROR=32`, `TM_INFO=64`, `TM_REQUEST=128`, `TM_RESPONSE=256`, `TM_NOREPLY=512`. A consumer that reads `$entry = $message[Message::VALUE]` as an array MUST gate on `TM_STRUCT` (16). Don't conflate with `TM_RESPONSE` (256) — they're different bits.

`TM_NOREPLY` (512) is the only reply-control flag kept from Tachikoma: a Shell with `want_reply(false)` (topology load / script mode) ORs it onto commands, and the interpreter suppresses the reply. `LOCAL` (7) is not a type flag — it's the appended provenance taint that `packed()` strips at the process boundary (so it can't cross processes); the command-auth gate's default tier admits a command only when LOCAL is set or an HMAC verifies.

### 8b. `arguments()` Tachikoma-parity (v0.6.0)

- Ctor must be parameter-less for `make_node`-buildable nodes; positional config is declared in `node_schema()['arguments']` as `[{name, type, default?, required?}]`.
- Schema `default` must be a real typed value (real ints, floats, class constants). Placeholder strings (`'<config:foo>'`) against typed properties crash the schema walker.
- `arguments()` overrides MUST short-circuit on `'' === $args` — otherwise `make_node Foo` (no args) re-derives against declaration-default props and writes filesystem-root junk like `/p0`. `Partition_Node` is the reference template.
- Side effects (`set_timer`, `mkdir`, `fopen`, `Partition_Node` materialization) belong in the `arguments()` override gated on non-empty args, not in the constructor (AGENTS decision 5).
- Programmatic dependencies (objects, callables, streams) are public properties the caller sets after construction, NOT ctor params. `Workers_CI_Node::$cli` / `$cache` is the reference.
- Schema field names are `'arguments'` and `'commands'`. A diff that reads or writes `'ctor'` or `'verbs'` is a regression (renamed in v0.6.0).
- Schema `default`s are applied **only per-position when token list runs short**, NOT on `'' === $args` (the empty-args short-circuit returns before the schema walk). If you want a default that's visible both via `make_node Foo bar baz` *and* `make_node Foo` (no args), set it as the class property default too — not only on the schema entry.

### 8c. `dump_config` round-trip

- A Node with runtime-mutable config overrides `dump_config()` to emit replay verbs from its own state. Reference: `Partition_Node`'s emission of `allow_large_writes` + `with_index` formatter name.
- A diff that reintroduces `mark_verb_invoked()` / `$invoked_verbs` is wrong — the recorder was deleted in v0.6.0; config lives in the node, not a side-channel ledger.

### 8d. Tachikoma rule #2 — everything sinks into the interpreter

- JS dashboards mount onto `mountExospine()` (returns `{ interpreter, router, teardown }`); every node has `sink = interpreter`, and flow is steered via `target` / `TO` through `_router`.
- A diff that adds bespoke `nodeA.sink = nodeB` chains, `controlSink` side-channels, or skips the interpreter is a substrate-conformance regression.

### 9. Dumper rendering

If the diff changes how Dumper renders a TYPE flag, double-check that the cli output still makes sense for both interactive and piped invocations. The `set_readline_mode` flag gates on `posix_isatty(STDIN)`; piped sessions take the plain-write path, so any ANSI escapes you add must be guarded.

### 9b. Config System schema (single source of settings)

Settings are declared once in `Settings_Schema` via `Config_System\Field` / `Config_System\Schema` (v0.13.0); `Config` and `Admin` both derive their key-list, option names, reset list, and register/render loops from it. A diff that reintroduces a parallel hand-maintained option list (the old `Config::$option_schema`, `Admin::$option_names`, or `$delete_on_blank_options`) is a regression — add the new setting as a `Field` in the schema instead.

### 9c. Presence-based config overlay

`Config_System\Options_Overlay::apply()` is presence-based (v0.12.0): a *stored* option — even `''`, `[]`, `false`, `0` — overrides the file default; only an *absent* option falls back (it sentinels on `get_option(..., $missing)`, not truthiness). A diff that reverts to a truthiness-based overlay (so a blank stored option masks the file default — the `memcache_servers` bug) should be flagged.

### 9d. Substrate-owned `\Memcached` handle

`Core::$memd` is the one shared handle, built by `Bootstrap::init_memcached()` from the `memcache_servers` config. It is `null` on empty/invalid config **deliberately** — command-auth refuses, SSE slots fail closed, stats fail soft. A diff that installs a fallback handle instead of leaving `null` contradicts the design intent; don't add one.

### 9e. Job_Worker_Node contract

`Job_Worker_Node` is a substrate node (promoted in the 0.12–0.14 era). Review against its contract: local/remote handler maps come from `newspack_nodes/{job,remote_job}_handlers` filters; it runs a GC + cache-flush cadence and a memory-watermark self-restart; it answers `GET_HEALTH`; and it fires `newspack_nodes/job_worker/{before,after}_job` actions so apps hook per-job request context. A diff that bypasses the handler-map filters, drops the `after_job` cleanup action, or removes the memory-watermark restart is a smell.

### 9f. Admin access gate

`Admin::current_user_allowed()` is the single funnel for the settings UI: `manage_options` baseline plus the optional `allowed_users` whitelist (v0.12.0; empty list = all `manage_options` users). A diff that bypasses `current_user_allowed()` on an admin entry point, or weakens the whitelist check, is a security-relevant review item.

### 10. CommandInterpreter dispatch contract

Before any verb dispatch, `interpret()` runs the authorization gate (`Command_Interpreter_Node::$authorize ?? self::$default_authorize`). The default client tier requires the `LOCAL` provenance taint (in-process command); verifier processes (workers, `/command` request scope) swap in `Command_Auth::verifier()`, which admits a command only when LOCAL is set or a valid HMAC verifies. An unauthorized command replies `TM_COMMAND|TM_ERROR` (`unauthorized: <verb>`) without running the handler. A diff touching `interpret()` or the auth wiring MUST be reviewed against this gate — don't drop the authorize call or weaken the verifier tier.

interpreter handles a TM_COMMAND only when TO is empty. Non-empty TO means the message is mid-route toward a downstream node; interpreter forwards to its sink (Router). Don't relax that — every interpreter in a path-routed graph would otherwise consume commands intended for someone else.

Verb handlers may throw freely. `interpret()` catches `\Throwable` and turns the response into `TM_COMMAND|TM_ERROR` addressed back along FROM. Don't restore explicit `try/catch` inside individual `cmd_foo` methods — the central catch is the contract. Reserve `return 'error: ...'` for canonical-OK-shaped argument-validation paths (e.g. malformed args before any work happens).

Aliases share the same `cmd_foo`. When you add or remove a verb, audit `$C` for orphaned alias rows — leaving `'rm' => cmd_remove_node` after dropping `remove_node` is a silent zombie verb.

## Style gates (lighter-weight)

- WordPress VIP Go: snake_case, Yoda conditions, tabs, spaces inside `( $args )`. PHPCS catches most of these (`npm run lint:php`).
- Use `wp_json_encode`, not `json_encode`, for anything that might encode user-supplied UTF-8.
- PHPDoc on public methods. Internal helpers can skip it if the name + signature explains itself.
- Conventional commit messages (`feat:`, `fix:`, `refactor:`, `test:`, `docs:`).

## Tests

Substrate tests live in `tests/{unit,integration}/` (~87 test files, ~1800 test methods) — including the `tests/unit/ConfigSystem/` and `tests/unit/Admin/` subdirectories. When you add a Node subclass, add a test that exercises its `fill()` with a `Capture_Sink_Node` to assert what gets forwarded. When you add a CommandInterpreter verb, add a CommandInterpreterTest case.

The test bootstrap shims a few WP functions (`wp_json_encode`, `wp_remote_post`, etc.) — check `tests/bootstrap.php` before adding a new global function call.

## Common review nits that aren't bugs

- Tachikoma-isms in comments are fine; we're explicitly inspired by it. The comments help reviewers who know Tachikoma. Don't ask for them to be stripped.
- "Dead code" that's actually a `*_Node` class resolved dynamically by `make_node` (namespace-prefix + `_Node`) or scanned into the palette catalog, or a REST endpoint controller, is fine. A `*_Node` class has no explicit registration call to grep for — its only "caller" is `make_node`/the classmap scan. Don't flag a `Node` subclass as unused.

## Related Skills

- `nodes-workflow` — implementation workflow
- `nodes-debugging` — debugging at runtime
