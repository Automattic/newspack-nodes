---
name: nodes-review
description: Code review checklist for substrate (newspack-nodes) changes. Use whenever reviewing a diff that touches Node, Message, Router, Topic, Partition, Tee, Tail, Consumer, Worker, Supervisor, or anything else under the newspack-nodes plugin's includes/.
argument-hint: "[file or class]"
---

# Newspack Nodes Review Checklist

Substrate-specific review pass. Read AGENTS.md decisions 1-9 for the rationale; this skill is the application of those rules to a diff.

## When to Use

After any code change inside `newspack-nodes/includes/`. Run BEFORE pushing or merging. The general WordPress / VIP Go review patterns are still relevant — this skill adds the substrate-specific gates on top.

## Gates (in order of catastrophic-bug potential)

### 1. PIPE_BUF discipline

If the diff touches Partition::fill, Partition's batch logic, or anywhere else that writes packed Messages to disk:

- Default `MAX_LINE_SIZE` is 4096 bytes. Anything larger MUST be on an `allow_large_writes()` Partition (which auto-locks via `Lock` at `{partition_dir}/write.lock.d/`).
- A diff that quietly raises the small-write cap is wrong — that breaks atomic-append for every concurrent producer.
- A diff that adds a producer of >4KB messages without making the Partition allow-large MUST silently drop the message; verify the drop path.

### 2. Lazy-init for Topic / Partition

These get instantiated in request scope (LogManager constructs a Topic per request whether the request logs anything or not). The constructor must NOT:

- Call `set_timer()` — there's no EventFramework draining yet, so the timer registers but never fires; silent leak
- Call `Core::node()` — likely returns null at construct time
- Call `scandir()` or any other I/O — wasted syscalls per request × N partitions

If you see any of those in a constructor, push the work to first-use (first `fill()`, first `read_at()`, etc.).

### 3. FROM stamping at I/O boundaries only

Tail and Consumer stamp FROM. Internal nodes don't. If the diff adds `stamp_message()` to a Tee, Hook, Callback, or any application-style forwarder, that's almost certainly a bug — it pollutes the breadcrumb trail and breaks reverse-direction routing.

The `MAX_FROM_SIZE = 1024` guard on `stamp_message` is load-bearing — don't remove it. Cycle scenarios will explode FROM otherwise.

### 4. CRC32 + 31-bit-mask routing

`Partition::hash_to_partition()` is canonical. Any diff that introduces partition routing (Topic, JobIntake-keyed mode, anything else) MUST call this function — diverging hash families silently misroute the same key to different partitions across producers, which corrupts ordering.

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
- `TM_STRUCT` (256): VALUE is structured (array)
- They're mutually exclusive in our convention — pick one based on what VALUE actually is

A consumer that reads `$entry = $message[Message::VALUE]` as an array MUST gate on `TM_STRUCT`. Mixing TM_BYTESTREAM with array VALUE is the bug we just fixed; don't regress.

### 9. Dumper rendering

If the diff changes how Dumper renders a TYPE flag, double-check that the cli output still makes sense for both interactive and piped invocations. The `set_readline_mode` flag gates on `posix_isatty(STDIN)`; piped sessions take the plain-write path, so any ANSI escapes you add must be guarded.

### 10. CommandInterpreter dispatch contract

CI handles a TM_COMMAND only when TO is empty. Non-empty TO means the message is mid-route toward a downstream node; CI forwards to its sink (Router). Don't relax that — every CI in a path-routed graph would otherwise consume commands intended for someone else.

Verb handlers may throw freely. `interpret()` catches `\Throwable` and turns the response into `TM_COMMAND|TM_ERROR` addressed back along FROM. Don't restore explicit `try/catch` inside individual `cmd_foo` methods — the central catch is the contract. Reserve `return 'error: ...'` for canonical-OK-shaped argument-validation paths (e.g. malformed args before any work happens).

Aliases share the same `cmd_foo`. When you add or remove a verb, audit `$C` for orphaned alias rows — leaving `'rm' => cmd_remove_node` after dropping `remove_node` is a silent zombie verb.

## Style gates (lighter-weight)

- WordPress VIP Go: snake_case, Yoda conditions, tabs, spaces inside `( $args )`. PHPCS catches most of these (`npm run lint:php`).
- Use `wp_json_encode`, not `json_encode`, for anything that might encode user-supplied UTF-8.
- PHPDoc on public methods. Internal helpers can skip it if the name + signature explains itself.
- Conventional commit messages (`feat:`, `fix:`, `refactor:`, `test:`, `docs:`).

## Tests

Substrate tests live in `tests/{unit,integration}/`. Coverage is good (~466 tests). When you add a Node subclass, add a test that exercises its `fill()` with a CaptureSink to assert what gets forwarded. When you add a CommandInterpreter verb, add a CommandInterpreterTest case.

The test bootstrap shims a few WP functions (`wp_json_encode`, `wp_remote_post`, etc.) — check `tests/bootstrap.php` before adding a new global function call.

## Common review nits that aren't bugs

- Tachikoma-isms in comments are fine; we're explicitly inspired by it. The comments help reviewers who know Tachikoma. Don't ask for them to be stripped.
- "Dead code" that's actually a `*_Node` class resolved dynamically by `make_node` (namespace-prefix + `_Node`) or scanned into the palette catalog, or a REST endpoint controller, is fine. A `*_Node` class has no explicit registration call to grep for — its only "caller" is `make_node`/the classmap scan. Don't flag a `Node` subclass as unused.

## Related Skills

- `nodes-workflow` — implementation workflow
- `nodes-debugging` — debugging at runtime
