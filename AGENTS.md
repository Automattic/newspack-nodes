# AGENTS.md — Newspack Nodes

Generic message-passing runtime for PHP/WordPress: a Tachikoma-style node graph. Independent of any application; this plugin owns the substrate (Node, Message, Router, Topic, Partition, Worker, Supervisor, REPL). Applications (the first being `newspack-event-logger-nodes`) compose Nodes on top.

Every node honors one contract: `fill( array &$message ): void`. That uniformity is what lets composition work — any node can sink into any other node.

## Code Style

WordPress VIP Go (enforced by `phpcs.xml.dist`):
- `snake_case` for functions and variables
- Yoda conditions: `if ( 'value' === $var )`
- `[]` arrays, arrow functions, spread operator allowed
- Tab indentation, spaces inside parentheses: `function_name( $param )`
- PHP 8.0+ typed properties; constructor property promotion where it shortens
- PHPDoc on public methods

Conventional commits (`feat:`, `fix:`, `refactor:`, `test:`, `docs:`).

## Build / Test

```bash
# Run unit + integration tests.
cd tests && phpunit

# Lint PHP.
npm run lint:php

# REPL against a live worker.
wp nodes ls
wp nodes cli firehose-workers.p0
```

The plugin is shipped as a standard WordPress plugin; deployment (containers, bind mounts, rsync, etc.) is environment-specific and lives outside this repo.

## Versioning & Release

The version appears in three places: the `Version:` header in `newspack-nodes.php`, the `NEWSPACK_NODES_VERSION` PHP constant in the same file, and the `"version"` field in `package.json`. Do NOT edit these by hand — `tools/bump-nodes-version.sh` (in `dndocker/`) rewrites all three atomically and refuses to bump to a version that's already current.

```bash
# Bump version (from dndocker root).
dndocker/tools/bump-nodes-version.sh <version>

# Release workflow:
# 1. Update CHANGELOG.md with new version and changes (use Keep-a-Changelog format).
# 2. Bump version across plugin header + constant + package.json:
dndocker/tools/bump-nodes-version.sh <version>
# 3. Commit the changelog entry + version bump together. Conventional message
#    referencing the new version (e.g. `chore: release v<version>`).
# 4. Build the release zip:
./build-release.sh           # outputs to release/newspack-nodes.zip
# 5. Tag, push, and create GitHub release with the zip:
git tag v<version>
git push origin main --tags
gh release create v<version> release/newspack-nodes.zip --title "v<version>" --notes "changelog here"
```

`build-release.sh` runs `composer install --no-dev --optimize-autoloader` before staging, then rsyncs the plugin into `release/newspack-nodes/` minus development artifacts (`src/`, `tests/`, `node_modules/`, `composer.{json,lock}`, `package*.json`, `phpcs.xml.dist`, `build-release.sh`, AppleDouble sidecars, etc.) and zips it. The zip contains the plugin directory at root so `wp plugin install --force --activate <url>.zip` works as-is.

**Why three locations?** Plugin header is what WordPress shows in the admin; the PHP constant is what the runtime asserts against; `package.json` is what npm tooling reads. The bump script is the single source of truth — drift between any two of them is a real bug we've shipped before.

## Architecture Decisions

These are intentional. Don't "fix" them.

1. **Uniform `fill()` contract.** Every node has exactly one entry point: `fill( array &$message )`. No parallel `write()` / `read()` / `process()` API. Callers build the Message inline and call `fill()` directly — no convenience wrappers.

2. **Messages are 7-field arrays, not hashes.** Indexed access is faster than hash lookup in hot paths. Field constants on `Message::TYPE` / `TIMESTAMP` / `FROM` / `TO` / `ID` / `KEY` / `VALUE`. `Message::TM_BYTESTREAM` (string VALUE) and `Message::TM_STRUCT` (array VALUE) are mutually exclusive in our convention; consumers reading array VALUE gate on TM_STRUCT.

3. **Fire-and-forget messaging.** No producer/consumer ack handshake. Tachikoma's TM_PERSIST / `answer()` / `cancel()` machinery was removed — synchronous I/O at every boundary serializes the whole graph onto one CPU, so there's no decoupled queue to backpressure. If you bring back slot-based flow control, do it at the producer that needs it; don't reintroduce a global persist contract.

4. **PIPE_BUF atomic writes.** Partition's default 4096-byte limit relies on the POSIX guarantee that small append-mode writes don't tear. Producers needing >4KB MUST opt into `Partition::allow_large_writes()`, which auto-locks via `Lock` at `{partition_dir}/write.lock.d/`. Concurrent large writes without the lock silently corrupt.

5. **Lazy init for Topic / Partition.** Constructors run in request scope with NO event loop. No `set_timer` (silent leak), no `Core::node()` lookup (NPE), no `scandir` (wasted syscalls × N partitions per request). File handles open lazily on first `fill()` / `read_at()`.

6. **CRC32 + 31-bit-mask partition routing.** `Partition::hash_to_partition()` is canonical: strip query string with `explode('?')`, CRC32 hash, `& 0x7FFFFFFF` for 32-bit-PHP safety. Topic, JobIntake-keyed mode, and any other partition routing MUST call this same function — divergent hash families silently misroute the same key across producers.

7. **TO=FROM convention for replies.** Forward direction sets `TO=$this->target`. Reverse direction (any response, ack, error) sets `TO=$message[FROM]` so it walks the breadcrumb trail back. One rule, applied uniformly; path-based routing via `_router` does the rest.

8. **Worker zombie pattern.** Workers spawn via HTTP POST to a HMAC-validated `/spawn` endpoint, then detach with `ignore_user_abort(true) + fastcgi_finish_request() + set_time_limit(0)`. Lifetime ~595s (sized for Atomic's 15-min cap with margin). Self-respawn fires inside `finally`; `release()` BEFORE `self_respawn()` so the new worker can acquire immediately.

9. **Two-tier safety net.** Workers self-respawn; supervisor catches stale-locked workers (heartbeat > stale_timeout) and force-spawns. Supervisor self-respawns; WP-Cron catches a dead supervisor at minute cadence.

## Layout

| Path | What |
|------|------|
| `newspack-nodes.php` | Plugin entry point + class registry for `make_node` |
| `includes/class-core.php` | Per-process registries, clock, shutdown flag, deferred-cleanup queue |
| `includes/class-message.php` | 7-field array constants, type flags, `packed()` / `unpacked()` JSON wire |
| `includes/class-node.php` | Base contract: `fill()`, sink/target/edge, `stamp_message()`, `register()` / `notify()` |
| `includes/class-router.php` | Path-based dispatch by TO; Timer-hitchhike on each tick |
| `includes/class-event-framework.php` | Drain loop singleton (`stream_select` + `curl_multi_select` + timers) |
| `includes/class-{tee,tail,log,echo,callback,hook,timer}.php` | Generic node primitives |
| `includes/class-{partition,topic,consumer}.php` | Storage + log-tailing primitives |
| `includes/class-{lock,worker-base,supervisor,supervisor-base,bootstrap}.php` | Lifecycle |
| `includes/class-{shell,command-interpreter,dumper}.php` | REPL components |
| `includes/class-cli-command.php` | `wp nodes cli` (bare + pivoted modes); `Cli_Stdin_Reader` is the readline-driven Node that drains stdin into the local Shell |
| `includes/cli/class-worker-cli-command.php` | `wp nodes {types,run,restart,status}` |
| `includes/rest/class-spawn-controller.php` | `POST /newspack-nodes/v1/workers/spawn` (HMAC-validated) |
| `includes/admin/class-admin.php` | Substrate settings UI |
| `tests/` | PHPUnit suite (unit + integration) |

## Common Pitfalls

These are mistakes that have actually happened. Pay attention.

- **Messages are arrays, not hashes.** Use `Message::TYPE` etc. constants for indexing. `$message['type']` silently fails (PHP coerces string to int 0 → corrupted TYPE).
- **FROM stamping at I/O boundaries only.** Tail and Consumer stamp; internal nodes (Tee, Hook, application nodes) don't. A message flowing `firehose-in → firehose-fanout → request-builder` carries `FROM=firehose-in`, NOT `firehose-fanout/firehose-in`.
- **`stamp_message` empty-name guard.** A node with no name (mid-construction or post-rename) emitting `/from` paths breaks Router. Drop with `print_less_often` instead.
- **Class-API must be event-loop-free.** Constructor for Topic / Partition runs in request scope where there's no EventFramework. See decision 5.
- **`hash_to_partition` is canonical.** Diverging hash families silently misroute the same key. See decision 6.
- **`MAX_FROM_SIZE = 1024`.** `stamp_message` returns false and drops if FROM exceeds 1024 bytes. Prevents path explosion on cycles.
- **Worker lock release before spawn.** `WorkerBase::execute()`'s `finally` block does `release()` THEN `self_respawn()`. Don't reorder; the reverse leaves a 15-second slot gap.
- **HMAC spawn token has TWO accepted windows.** Validates current AND previous 10-second window. Don't tighten to one — race tolerance is intentional.
- **Partition and Topic pack ALL message types** — including TM_REQUEST, TM_ERROR, TM_EOF. The earlier "drop control messages" rule broke `request_node`, `send_eof`, pivoted-mode error responses (TM_COMMAND|TM_ERROR), and the cli's TM_EOF round-trip drain. Data partitions only see TM_BYTESTREAM / TM_STRUCT in practice; allowing other types through is a no-op there and makes IPC work.
- **TM_EOF round-trip drains the cli on stdin close.** Cli emits TM_EOF (FROM=`_output/$pid`); the CI it lands on (local in bare mode, the worker's in pivoted mode) bounces TO=FROM; the cli's Dumper sees the echo and flips the exit flag. Mirrors Tachikoma `FileHandle::handle_EOF` → `send_EOF`. There's a 5s deadline fallback so a dead worker doesn't hang the cli.
- **Don't reintroduce TM_PERSIST.** The removal is intentional. See decision 3.
- **Skip readline when STDIN isn't a TTY.** `readline_callback_read_char()` reads from the TTY layer, not the stream descriptor; piping into `wp nodes cli` without the gate burns 100% CPU. Already gated; don't remove.
- **CommandInterpreter only handles TM_COMMAND with empty TO.** Non-empty TO means the message is in transit toward another node — CI forwards to Router. If you "fix" CI to also dispatch on non-empty TO, every CI in a path-routed graph eats commands intended for downstream peers.
- **Verb handlers throw freely; `interpret()` wraps as TM_COMMAND|TM_ERROR.** Don't add per-verb `try/catch` — the central catch is the contract. Keep `return 'error: ...'` only for canonical-OK-shaped argument-validation paths where you want to return without error semantics.
- **Constructors set `$this->arguments` directly.** No `dump_config()` override per class. `dump_config()` reads the field to emit a round-trippable `make_node <type> <name> <args>` line; if you forget to set it, `dump_config` emits without args and the round-trip silently produces a different node.
- **`Log`'s `prune_rotated()` reserves the `{filename}-` prefix.** Sibling discovery uses `glob({filename}-*)`; storing unrelated files under the same prefix (e.g. `out.log-keep_forever`) makes them eligible for pruning. Document and don't co-locate other artifacts.
- **`Echo` drops TM_ERROR with empty TO.** It would otherwise bounce to a producer that isn't expecting the error trail. If you change Echo's routing rules, preserve the drop.

## Local Skills

`.claude/skills/` has substrate-specific skills:
- `nodes-workflow` — implementation workflow (adding Node subclasses, deploying, verifying)
- `nodes-debugging` — REPL, log paths, common runtime failure modes
- `nodes-review` — substrate contract checklist for code review

## References

- **Architecture**: `ARCHITECTURE.md` (full substrate design — message format, node contracts, drain loop, REPL)
- **API**: `API.md` (REST endpoint reference)
- **Application example**: `../newspack-event-logger-nodes/` — first plugin built on this runtime
