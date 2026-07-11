# AGENTS.md — Newspack Nodes

A **WordPress-internal** runtime that borrows the node *vocabulary* of [Tachikoma](https://github.com/datapoke/tachikoma) (Node, Message, Router, `fill`/`sink`) — not a standalone message bus. Its lifecycle is WordPress: config in the **options table**, the supervisor safety net on **WP-Cron**, worker spawn / command / SSE over the **REST API** behind **HMAC + nonce** auth, live position and stats in **memcache**. This plugin owns that substrate (Node, Message, Router, Topic, Partition, Worker, Supervisor, REPL). It's independent of any *application* — it ships no event-logger logic, so applications (the first being `newspack-event-logger-nodes`) compose Nodes on top — but it does **not** run without WordPress.

Every node honors one contract: `fill( array $message ): void`. Nodes connect two ways: **`sink`** — a node reference, the physical next hop `fill()` forwards to; and **`target`** — a string path stamped into `message[TO]` when TO is empty (this is Tachikoma's `owner`; we did not port `edge`). `_router` dispatches by peeling `message[TO]`. That uniformity is what lets any node compose with any other.

The ground truth for this model is **Perl Tachikoma** (`services/tachikoma/sources/tachikoma/lib/Tachikoma/`); newspack-nodes ports its semantics but keeps deliberate improvements (KEY/VALUE fields, JSON wire, no TM_PERSIST). Match Tachikoma's model; don't blind-copy its field names.

## Workflow discipline (mandatory)

Every code-writing turn — main Claude AND every subagent dispatched via the Agent tool — MUST:

1. **Invoke `superpowers:test-driven-development` BEFORE writing any code.** No production code without a failing test first.
2. **Before every commit, main Claude runs `/code-review`** (replaces `superpowers:simplify`). It spawns its own review agents, so subagents CANNOT run it and do NOT commit; main Claude always runs it after a subagent finishes, then commits.

Subagent prompts MUST include the literal phrase:
> "Invoke `superpowers:test-driven-development` via the Skill tool BEFORE writing any code — mandatory, no exceptions. Do NOT commit: implement, run your tests, and report; main Claude runs `/code-review` and commits."

Subagents have no memory of conversation conventions; omission is a workflow violation. See `~/.claude/rules/workflow-discipline.md`.

## Code Style

WordPress VIP Go (enforced by `phpcs.xml.dist`):
- `snake_case` for functions and variables
- Yoda conditions: `if ( 'value' === $var )`
- `[]` arrays, arrow functions, spread operator allowed
- Tab indentation, spaces inside parentheses: `function_name( $param )`
- PHP 8.2+; constructor property promotion where it shortens
- PHPDoc on public methods

Conventional commits (`feat:`, `fix:`, `refactor:`, `test:`, `docs:`).

## Build / Test

```bash
# Run unit + integration tests. Always pass `--enforce-time-limit` so a
# test that accidentally blocks on stdin (readline mode without a TTY)
# or an infinite drain loop gets aborted at the per-test budget instead
# of hanging the whole suite. Class-level `#[Medium]` raises the limit
# from 1s to 10s for tests that legitimately sleep through production
# code (Lock orphan grace, supervisor tick_loop).
cd tests && phpunit --enforce-time-limit

# Lint PHP.
npm run lint:php

# Opt-in dead-code audit (NOT in the lint gate). Substrate caveat: most findings
# are public API / WP-CLI entrypoints / JS-PHP wire constants / test seams, not
# real dead code — verify every call path (incl siblings + JS + dynamic) first.
npm run lint:deadcode

# REPL against a live worker.
wp nodes status
wp nodes cli firehose-workers.p0
```

The plugin is shipped as a standard WordPress plugin; deployment (containers, bind mounts, rsync, etc.) is environment-specific and lives outside this repo.

## Versioning & Release

The version appears in three places: the `Version:` header in `newspack-nodes.php`, the `NEWSPACK_NODES_VERSION` PHP constant in the same file, and the `"version"` field in `package.json`. Do NOT edit these by hand — `tools/bump-nodes-version.sh` (in `dndocker/`) rewrites all three atomically (and syncs `package-lock.json` via `npm version`) and refuses to bump to a version that's already current.

Releases are **automated by GitHub Actions** (`.github/workflows/release.yml`): pushing a `v<major>.<minor>.<patch>` tag builds the archive and publishes the GitHub Release. You only bump, changelog, commit, and tag:

```bash
# 1. Update CHANGELOG.md: rename `## [Unreleased]` → `## [<version>] - <date>`,
#    then add a fresh empty `## [Unreleased]` above it (Keep-a-Changelog format).
# 2. Bump version across plugin header + constant + package.json (from dndocker root):
dndocker/tools/bump-nodes-version.sh <version>
# 3. Commit the changelog + bump together (e.g. `chore(release): <version>`).
# 4. Tag and push — the workflow does the rest:
git tag v<version>
git push origin main
git push origin v<version>
```

On the tag push, the **Release** workflow validates the tag shape, runs
`npm run release:archive` (= `build-release.sh`: build assets, rsync via
`.distignore`, `composer install --no-dev`, zip), extracts the matching
`CHANGELOG.md` section as the release notes, and publishes the GitHub Release
with `release/newspack-nodes.zip` attached. No manual `gh release create`.

`build-release.sh` remains the single source of truth for archive contents and
is what the workflow invokes; run `npm run release:archive` locally to build the
same zip for testing. It rsyncs the plugin minus development artifacts (`src/`,
`tests/`, `node_modules/`, `.github`, `composer.{json,lock}`, `package*.json`,
etc.) so the zip holds the plugin directory at root — `wp plugin install
--force --activate <url>.zip` works as-is.

**Why three locations?** Plugin header is what WordPress shows in the admin; the PHP constant is what the runtime asserts against; `package.json` is what npm tooling reads. The bump script is the single source of truth — drift between any two of them is a real bug we've shipped before.

## Architecture Decisions

These are intentional, load-bearing design choices — "fixing" one usually reintroduces a
bug we already paid for. Each is written up as a rationale-ADR (context, alternatives weighed,
consequences, and the concrete condition that would reopen it) in
**[`docs/architecture-decisions.md`](docs/architecture-decisions.md)**. "Decision N" in this
file and in code comments means **ADR-N** there. The numbers are stable — supersede, don't
renumber.

| # | Decision | ADR |
|---|----------|-----|
| 1 | Uniform `fill()` contract — one entry point per node, no `write()`/`read()`/`process()` | [ADR-1](docs/architecture-decisions.md#adr-1-uniform-fill-contract) |
| 2 | ONE message format: the 7-field positional array (`Message::*` constants; no object form) | [ADR-2](docs/architecture-decisions.md#adr-2-one-message-format-the-7-field-positional-array) |
| 3 | Fire-and-forget messaging — no TM_PERSIST ack; the single-threaded drain is the backpressure (keep `TM_NOREPLY`) | [ADR-3](docs/architecture-decisions.md#adr-3-fire-and-forget-messaging) |
| 4 | PIPE_BUF atomic writes — 4 KB default; >4 KB opts into `allow_large_writes()` + lock | [ADR-4](docs/architecture-decisions.md#adr-4-pipe_buf-atomic-writes) |
| 5 | Lazy init for Topic / Partition — constructors do no event-loop / filesystem work | [ADR-5](docs/architecture-decisions.md#adr-5-lazy-init-for-topic--partition) |
| 6 | CRC32 + 31-bit-mask partition routing — `hash_to_partition()` is canonical | [ADR-6](docs/architecture-decisions.md#adr-6-crc32--31-bit-mask-partition-routing) |
| 7 | `sink` (physical) vs `target` (logical TO path); TO=FROM replies; no `edge` | [ADR-7](docs/architecture-decisions.md#adr-7-sink-vs-target-and-tofrom-replies) |
| 8 | Worker zombie pattern — detached ~595s requests, release before self-respawn | [ADR-8](docs/architecture-decisions.md#adr-8-worker-zombie-pattern) |
| 9 | Two-tier safety net — worker → supervisor → WP-Cron | [ADR-9](docs/architecture-decisions.md#adr-9-two-tier-safety-net) |
| 10 | `Word_Word` / `_Node` naming + `register_namespace` resolution (no `class_map`) | [ADR-10](docs/architecture-decisions.md#adr-10-class-naming--make_node-namespace-resolution) |
| 11 | `make_node` construction sequence; `arguments()` defaults/required centralized in `parse_schema_args()` | [ADR-11](docs/architecture-decisions.md#adr-11-make_node-construction-sequence) |
| 12 | Dead-letter poison / crash lifecycle — bounded-retry then `:deadletter` quarantine on caught-throw poison; crawl-checkpoint on uncatchable death | [ADR-12](docs/architecture-decisions.md#adr-12-dead-letter-poison--crash-lifecycle) |
| 13 | `fill()` returns void — a node can't observe its sink's disposition; outcomes come back as messages (TO=FROM reply / TM_ERROR), never a return value | [ADR-13](docs/architecture-decisions.md#adr-13-fill-returns-nothing) |
| 14 | Cooperative-stop propagates — a broad `catch` on the drain path re-throws `Worker_Should_Stop` first; carve-outs: Tee/Tap fan-out + post-success `finally` | [ADR-14](docs/architecture-decisions.md#adr-14-cooperative-stop-propagates-through-broad-catches) |

## Layout

| Path | What |
|------|------|
| `newspack-nodes.php` | Plugin entry point. Calls `Bootstrap::ensure_runtime_wired()` (idempotent), which registers the substrate namespace prefixes via `Command_Interpreter_Node::register_namespace()` so `make_node($type)` resolves `{$prefix}{$type}_Node`, registers the `<config:key>` TSL token namespace (`Config::register_token_namespace()`), the stock `topologies/` dir (`Topology_Registry::register_builtin_dir`), and builds `Core::$memd` (`Bootstrap::init_memcached`). The entry point itself defines `newspack_nodes_mount_substrate_cis` and hooks it to `newspack_nodes/request_graph_ready` to mount the substrate service CIs |
| `includes/class-core.php` | Per-process registries, clock (`Core::$now`), shutdown flag, `cleanup_all_nodes()` teardown, rate-limited stderr |
| `includes/class-config.php` | Substrate option storage + per-request config overlay; derives its key-list and worker-restart classification from `Settings_Schema` (see `config-system/`) |
| `includes/class-message.php` | 7-field array constants, type flags, positional `packed()` / `unpacked()` JSON wire |
| `includes/class-node.php` | Base contract: `fill()`, `sink` (physical next node) + `target` (logical TO path), `stamp_message()`, `register()` / `notify()` / `set_state()` |
| `includes/class-router-node.php` | Path-based dispatch by TO; Timer-hitchhike on each tick |
| `includes/class-event-framework.php` | `Event_Framework` — drain loop singleton (`curl_multi_select` or `usleep` + timers; no FD machinery) |
| `includes/class-{tee,tap,grep,tail,log,echo,callback,hook,timer}-node.php` | Generic node primitives (`Tap_Node` extends Tee with hard targets + passthrough; `Grep_Node` regex payload-VALUE filter, ported from Tachikoma's `Grep.pm`) |
| `includes/class-{json-to-struct,struct-to-json}-node.php` | TM_STRUCT ⇄ JSON-line transforms (Tachikoma's `JSONtoStorable`/`StorableToJSON` pair) — splice around a Log or terminal so a struct producer's array VALUE round-trips through a bytestream line |
| `includes/class-{partition,topic,consumer}-node.php` | Storage + log-tailing primitives |
| `includes/class-topic-probe-node.php`, `includes/class-probe-record.php` | `TopicProbe_Node` — periodic per-worker Consumer-stats sweep (port of Tachikoma TopicProbe, consumer branch); `Probe_Record` fixes the positional layout of a `topicprobe.p0` VALUE (mirrors `src/runtime/probe-record.js`, parity-pinned) |
| `includes/class-job-worker-node.php` | `Job_Worker_Node` — generic async-job dispatch (local/remote handler maps via `newspack_nodes/{job,remote_job}_handlers`; GC + cache-flush cadence; memory-watermark self-restart; `GET_HEALTH`). Fires `newspack_nodes/job_worker/{before,after}_job` actions so apps hook per-job request context. Stock `topologies/job-worker.tsl` |
| `includes/class-lock-node.php`, `includes/class-{worker-base,supervisor,supervisor-base,bootstrap}.php`, `includes/class-worker-should-stop.php` | Lifecycle (`Lock_Node` is a Node subclass; the rest are non-node helpers). `Worker_Should_Stop` is the cooperative-stop exception raised from inside a long job when the drain continue-predicate says stop — see [ADR-14](docs/architecture-decisions.md#adr-14-cooperative-stop-propagates-through-broad-catches) |
| `includes/class-{shell,command-interpreter,dumper}-node.php` | REPL components; `Command_Interpreter_Node` also carries the introspection verbs (`list_timers` / `list_handles` tabulate the Event_Framework's registered timers and cURL-multi handles for spotting drain spinners) |
| `includes/class-cli.php` | Worker-discovery + attached-cli IPC helpers (used by both `wp nodes status` and `wp nodes cli`) |
| `includes/class-cli-command.php` | `wp nodes cli` (bare + attached modes); wires the REPL graph — `_stdout` (`TTY_Out_Node`) writer, `_output` (`Dumper_Node`, `target=_stdout`) renderer, and a `TTY_In_Node` stdin reader — then drains via `Event_Framework` |
| `includes/class-{stdin,stdout,stderr,tty-in,tty-out}-node.php` | Terminal-I/O primitives: `Stdin_Node`/`Stdout_Node` (bare stream drain/sink; self-scheduling 0ms busy / 10ms post-EOF / 100ms idle re-arm) and their `TTY_In_Node`/`TTY_Out_Node` readline/completion/prompt-aware subclasses used by `wp nodes cli`; `Stderr_Node` is a bare diagnostic sink that writes a TM_BYTESTREAM VALUE through the node stderr chain (splice on the end of a `Tee → Dumper → Grep` debug tap) |
| `includes/cli/class-worker-cli-command.php` | `wp nodes {types,run,restart,status,activate,deactivate}` |
| `includes/cli/class-ingest-cli-command.php` | `wp nodes ingest` — replay packed partition-segment records back through a Topic onto disk |
| `includes/rest/class-spawn-controller.php` | `POST /newspack-nodes/v1/workers/spawn` (HMAC-validated) |
| `includes/rest/class-http-in-node.php` | `POST /newspack-nodes/v1/command` controller + the `_output` response-writer Node (double-duty): as a controller it routes the decoded batch through Router; as a Node its `fill()` writes the `/command` response body, so an interpreter reply with TO=FROM walks the `_output` boundary back to it. (Outbound command egress is the separate `HTTP_Out_Node`; `_http` is the filter Node below.) |
| `includes/rest/class-sse-out-node.php` | `GET /newspack-nodes/v1/messages/stream` controller + the `_sse` egress Node (double-duty); carries the inlined SSE wire helpers (headers, event framing, flush) |
| `includes/class-http-filter-node.php` | `_http` filter Node used inside SSE-stream processes (forwards `dump_metadata`/`uptime` replies back to the browser) |
| `includes/class-http-out-node.php` | `HTTP_Out_Node` — non-blocking outbound command egress (push-side counterpart of `HTTP_In`): buffers TM_COMMAND envelopes, batches one JSONL POST per drain tick to a remote spoke's `/command` over the Event_Framework's cURL-multi |
| `includes/class-sse-in-node.php` | `SSE_In_Node` — generic inbound SSE *pull* source (hidden, programmatically configured): owns one cURL-multi handle registered with the Event_Framework, a `{segment, offset}` cursor, and SSE parser state; `fill()` is a no-op, it forwards pulled msgs to its sink with `TO=target` |
| `includes/class-{remote-link,remote-source,remote-ipc}-node.php`, `includes/class-remote-settings-migration.php` | Remote "be the browser" SSE+HTTP channels: `Remote_Link_Node` patrons an `SSE_In` + `HTTP_Out` sibling pair (heartbeat/reconnect/status); `Remote_Source_Node` extends it + `use`s `Buffered_Pump` for durable SSE-pull aggregation; `Remote_IPC_Node` extends it for per-worker interactive `cd /{worker}` command routing. `Remote_Settings_Migration` is a one-time option-rename guard |
| `includes/class-{settings-event-writer,settings-sync}-node.php` | Settings-sync graph: `Settings_Event_Writer` appends option-NAME-only events to `settings.p0` on a watched-option change (always ≤ PIPE_BUF → atomic lockless append); a worker Consumer tails it and `Settings_Sync_Node` (a `Timer_Node`) pushes each option's CURRENT value to connected spokes |
| `includes/class-vault.php`, `includes/class-vault-migration.php` | `Vault` — singleton encrypted credential store for remote-server configs (`newspack_nodes_vault` option, `wp_salt('auth')` key); `Vault_Migration` one-time copies the legacy event-logger aggregator-servers option in |
| `includes/rest/class-{classes,layouts,topologies,raw-logs,workers,vault,aggregator,settings,status}-ci-node.php` | Substrate service `*_CI_Node`s mounted via `newspack_nodes/request_graph_ready` |
| `includes/class-service-ci-node.php` | `Service_CI_Node` — abstract base that builds an interpreter's verb table from its `node_schema()` |
| `includes/class-command-auth.php` | HMAC envelope sign/verify (`Command_Auth::sign()` / `Command_Auth::verifier()`); the server-tier `authorize` closure that gates wire-arrived commands. The Shell signs commands inline via `Command_Auth::sign()` (`class-shell-node.php`) — there is no separate signer Node |
| `includes/config-system/class-{field,schema,options-overlay,reset-gate,field-reset-assets,settings-renderer,restart-planner}.php` | `Config_System\*` — shared declarative-settings infrastructure (v0.13.0). One `Field` per setting; `Schema` derives every consumer (overlay key-list, option names, reset list, register/render loops); `Options_Overlay` is presence-based per-request config; `Reset_Gate` + `Field_Reset_Assets` drive per-field reset; `Settings_Renderer` renders the settings page. Sibling plugins adopt this same namespace |
| `includes/class-settings-schema.php` | `Settings_Schema` — the substrate's `Config_System\Schema` declaration (one `Field` per setting); replaces the parallel hand-maintained option/restart arrays `Config` + `Admin` used to keep in lockstep |
| `includes/class-command-args.php` | `Command_Args` — shared command-argument parsing helper |
| `includes/class-{topology-loader,topology-registry}.php` | Topology TSL parser + per-plugin `register_plugin()` entry-point |
| `includes/class-{log-cleaner,log-discovery,node-names,sse-slot-pool,config-utils,formatters}.php` | Internal helpers — log retention sweep, log-name discovery, reserved-name registry, SSE slot pool, config schema utils, formatter registry |
| `includes/trait-{buffered-pump,dead-letter-queue,deferred-clean-stop,file-writer,offsetlog-cursor,schema-reflection,time-travel}.php` | Shared node-mixin traits split off the Node god-object: `Buffered_Pump` (timer-driven durable-reader message spine, shared by Consumer + Remote_Source), `Dead_Letter_Queue` (`:deadletter` quarantine + fair-shot accounting — [ADR-12](docs/architecture-decisions.md#adr-12-dead-letter-poison--crash-lifecycle)), `Deferred_Clean_Stop` (write-side of the clean cooperative-stop protocol — a snapshot node defers a `Worker_Should_Stop` around its downstream forwards, finishes the message, then re-raises `Worker_Should_Stop_Clean` so `Buffered_Pump` commits past it; consumed by application snapshot nodes in sibling plugins), `File_Writer` (fail-loud `write_all()`, Log/Partition only), `Offsetlog_Cursor` (durable per-node offsetlog cursor), `Schema_Reflection` (`parse_schema_args()` + `auto_wire_interpreter()` from `node_schema()` — [ADR-11](docs/architecture-decisions.md#adr-11-make_node-construction-sequence)), `Time_Travel` (pause/step/seek debugger over an Offsetlog_Cursor) |
| `includes/uninstall-cleanup.php` | Option-cleanup helpers loaded only from `uninstall.php` (kept out of the autoloader; costs nothing at runtime) |
| `includes/admin/class-admin.php` | Substrate settings UI |
| `examples/example-ai-newsletter/` | Bundled walkthrough example plugin — a deterministic digest pipeline built from Nodes (its own `includes/`, `topologies/example-ai-newsletter.tsl`, and PHPUnit suite) |
| `tests/` | PHPUnit suite (`tests/unit/` incl. `ConfigSystem/`, `tests/integration/`, plus `Helpers/` — `CaptureSink` (the `Capture_Sink_Node` double), `TestCase`, `VerbHarness`, `BoundedTicks`, `FakeMemcached` / `InMemoryMemcached`, `WPCLIStub`) |

## Common Pitfalls

These are mistakes that have actually happened. Pay attention.

- **The hermetic Config_System subset stays Core-free.** Consumer plugins load FIVE of these files in HERMETIC test harnesses without the substrate (pyrobase's `tests/load-config-system.php`: options-overlay, reset-gate, field-reset-assets, field, schema — documented there as dependency-free). Never add a `Core::`/substrate-class call to THOSE five (a coercion-helper sweep did once; pyrobase's mock suite fataled `Class "Newspack_Nodes\Core" not found`). `class-settings-renderer.php` / `class-restart-planner.php` are NOT in the hermetic set and legitimately use the substrate.
- **Messages are arrays, not hashes.** Use `Message::TYPE` etc. constants for indexing. `$message['type']` silently fails (PHP coerces string to int 0 → corrupted TYPE).
- **Pick the right `Core` coercion family — the guard is the name.** `as_string`/`as_int`/`as_float` = lenient cast (`is_scalar`; `as_int('42')`→42, `as_int(true)`→1). `num_int`/`num_float` = validated numeric cast (`is_numeric`; bools and `'12abc'` take the default — use on arithmetic paths). Bare `str`/`arr`/`int` = exact-type passthrough, NO conversion (`int('42')`→default, `str(42)`→default). All take an optional `$default`. The footgun is `int()` on a wire/JSON field that arrives as a numeric string — that wants `num_int()` or `as_int()`.
- **FROM stamping at sources and I/O boundaries.** A node that *mints* a brand-new message stamps FROM with its own name (Shell stamps `_output/<pid>`, interpreter responses stamp `$this->name`, Timer/Tail/Consumer stamp at the I/O boundary); *pass-through* forwarders (Tee, Hook, application nodes that relay an existing message) don't re-stamp. A message flowing `firehose-in → firehose-fanout → request-builder` carries `FROM=firehose-in`, NOT `firehose-fanout/firehose-in`.
- **`stamp_message` empty-name guard.** A node with no name (mid-construction or post-rename) emitting `/from` paths breaks Router. Drop with `print_less_often` instead.
- **Class-API must be event-loop-free.** Constructor for Topic / Partition runs in request scope where there's no `Event_Framework`. See [ADR-5](docs/architecture-decisions.md#adr-5-lazy-init-for-topic--partition).
- **`hash_to_partition` is canonical.** Diverging hash families silently misroute the same key. See [ADR-6](docs/architecture-decisions.md#adr-6-crc32--31-bit-mask-partition-routing).
- **`MAX_FROM_SIZE = 1024`.** `stamp_message` returns false and drops if FROM exceeds 1024 bytes. Prevents path explosion on cycles.
- **Worker lock release before spawn.** `Worker_Base::execute()`'s `finally` block does `release()` THEN `self_respawn()`. Don't reorder; the reverse makes the successor's acquire hit the still-held lock and skip, idling the slot until the supervisor's rescue.
- **HMAC spawn token has TWO accepted windows.** Validates current AND previous 10-second window. Don't tighten to one — race tolerance is intentional.
- **Partition and Topic pack ALL message types** — including TM_REQUEST, TM_ERROR, TM_EOF. The earlier "drop control messages" rule broke `request_node`, `send_eof`, attached-mode error responses (TM_COMMAND|TM_ERROR), and the cli's TM_EOF round-trip drain. Data partitions only see TM_BYTESTREAM / TM_STRUCT in practice; allowing other types through is a no-op there and makes IPC work.
- **TM_EOF round-trip drains the cli on stdin close.** Cli emits TM_EOF (FROM=`_output/$pid`); the interpreter it lands on (local in bare mode, the worker's in attached mode) bounces TO=FROM; the cli's Dumper sees the echo and flips the exit flag. Mirrors Tachikoma `FileHandle::handle_EOF` → `send_EOF`. There's a 5s deadline fallback so a dead worker doesn't hang the cli.
- **Don't reintroduce TM_PERSIST.** The removal is intentional. See [ADR-3](docs/architecture-decisions.md#adr-3-fire-and-forget-messaging).
- **Skip readline when STDIN isn't a TTY.** `readline_callback_read_char()` reads from the TTY layer, not the stream descriptor; piping into `wp nodes cli` without the gate burns 100% CPU. Already gated; don't remove.
- **Command_Interpreter_Node only handles TM_COMMAND with empty TO.** Non-empty TO means the message is in transit toward another node — interpreter forwards to Router. If you "fix" interpreter to also dispatch on non-empty TO, every interpreter in a path-routed graph eats commands intended for downstream peers.
- **Verb handlers throw freely; `interpret()` wraps as TM_COMMAND|TM_ERROR.** Don't add per-verb `try/catch` — the central catch is the contract. Keep `return 'error: ...'` only for canonical-OK-shaped argument-validation paths where you want to return without error semantics.
- **Constructors set `$this->arguments` directly.** No `dump_config()` override per class. `dump_config()` reads the field to emit a round-trippable `make_node <type> <name> <args>` line; if you forget to set it, `dump_config` emits without args and the round-trip silently produces a different node.
- **`Log` is a `Partition` subclass — append-only segmented `{file}.{seg}`.** It inherits Partition's segments, monotonic rotation (`segment_size`), count+age retention (`num_segments`/`max_lifespan`), rotate lock, and the 4KB PIPE_BUF cap — large VALUEs need `void_warranty()`/`allow_large_writes()`. It differs from Partition in three ways: it writes the message **VALUE** (not the packed envelope), lays segments out as `{file}.0`, `{file}.1`, … (no bare `{file}`, no logrotate `.0` shift, no `mode`/`max_size`/`max_rotations`), and its `fill()` drops control messages (`TM_ERROR`/`TM_EOF`/`TM_REQUEST`) instead of packing them — unlike bare Partition/Topic, which pack ALL types. Args: `make_node Log <name> <file> [segment_size] [num_segments]`.
- **`Echo` drops TM_ERROR with empty TO.** It would otherwise bounce to a producer that isn't expecting the error trail. If you change Echo's routing rules, preserve the drop.
- **Don't import a `.scss`/`.css` through the `@newspack-nodes/shared/*` alias.** In the shared jest config (`src/build-kit/jest.cjs`, consumed via `createJestConfig` — `jest.config.js` itself has no `moduleNameMapper`) the `^@newspack-nodes/shared/(.*)$` mapper is listed BEFORE the `\.(css|scss)$` style-mock, and first-match wins — so an aliased style import (`@newspack-nodes/shared/styles/x.scss`) resolves to the real file and babel-jest tries to parse SCSS as JS (syntax error) instead of mocking it. Import shared component styles via a RELATIVE path inside the shared component (`./x.scss`), which the style-mock catches. No aliased style import exists today; the consumer (event-logger-nodes) has the identical mapper ordering.

## Local Skills

`.claude/skills/` has substrate-specific skills:
- `nodes-workflow` — implementation workflow (adding Node subclasses, deploying, verifying)
- `nodes-debugging` — REPL, log paths, common runtime failure modes
- `nodes-review` — substrate contract checklist for code review

## References

- **Doc map**: `docs/README.md` — the 3-bucket reading-order index for the whole `docs/` set (start here → production → reference)
- **Architecture**: `docs/architecture-guide.md` (full substrate design — message format, node contracts, drain loop, REPL)
- **Architecture decisions**: `docs/architecture-decisions.md` (the load-bearing ADRs — context, alternatives, reopen conditions)
- **Tutorial track**: `docs/getting-started.md` → `docs/writing-a-plugin.md` → `docs/writing-a-real-plugin.md` → `docs/writing-a-dashboard.md` → `docs/writing-a-real-dashboard.md` → `docs/writing-a-view-node.md`
- **API**: `docs/API.md` (REST endpoint reference)
- **Application example**: `../newspack-event-logger-nodes/` — first plugin built on this runtime
- **Walkthrough example (in-repo)**: `examples/example-ai-newsletter/` — a self-contained digest pipeline (`includes/`, `topologies/example-ai-newsletter.tsl`, PHPUnit suite) to learn the substrate from
