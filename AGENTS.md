# AGENTS.md — Newspack Nodes

A **WordPress-internal** runtime that borrows the node *vocabulary* of [Tachikoma](https://github.com/datapoke/tachikoma) (Node, Message, Router, `fill`/`sink`) — not a standalone message bus. Its lifecycle is WordPress: config in the **options table**, the supervisor safety net on **WP-Cron**, worker spawn / command / SSE over the **REST API** behind **HMAC + nonce** auth, live position and stats in **memcache**. This plugin owns that substrate (Node, Message, Router, Topic, Partition, Worker, Supervisor, REPL). It's independent of any *application* — it ships no event-logger logic, so applications (the first being `newspack-event-logger-nodes`) compose Nodes on top — but it does **not** run without WordPress.

Every node honors one contract: `fill( array &$message ): void`. Nodes connect two ways: **`sink`** — a node reference, the physical next hop `fill()` forwards to; and **`target`** — a string path stamped into `message[TO]` when TO is empty (this is Tachikoma's `owner`; we did not port `edge`). `_router` dispatches by peeling `message[TO]`. That uniformity is what lets any node compose with any other.

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
wp nodes ls
wp nodes cli firehose-workers.p0
```

The plugin is shipped as a standard WordPress plugin; deployment (containers, bind mounts, rsync, etc.) is environment-specific and lives outside this repo.

## Versioning & Release

The version appears in three places: the `Version:` header in `newspack-nodes.php`, the `NEWSPACK_NODES_VERSION` PHP constant in the same file, and the `"version"` field in `package.json`. Do NOT edit these by hand — `tools/bump-nodes-version.sh` (in `dndocker/`) rewrites all three atomically and refuses to bump to a version that's already current.

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

## Layout

| Path | What |
|------|------|
| `newspack-nodes.php` | Plugin entry point; registers the substrate namespace prefixes via `Command_Interpreter_Node::register_namespace()` so `make_node($type)` resolves `{$prefix}{$type}_Node`; registers the `<config:key>` TSL token namespace (`Config::register_token_namespace()`), the stock `topologies/` dir (`Topology_Registry::register_builtin_dir`), builds `Core::$memd` (`Bootstrap::init_memcached`), and mounts the substrate service CIs on `newspack_nodes/request_graph_ready` (`newspack_nodes_mount_substrate_cis`) |
| `includes/class-core.php` | Per-process registries, clock (`Core::$now`), shutdown flag, deferred-cleanup queue, rate-limited stderr |
| `includes/class-config.php` | Substrate option storage + per-request config overlay; derives its key-list and worker-restart classification from `Settings_Schema` (see `config-system/`) |
| `includes/class-message.php` | 7-field array constants, type flags, positional `packed()` / `unpacked()` JSON wire |
| `includes/class-node.php` | Base contract: `fill()`, `sink` (physical next node) + `target` (logical TO path), `stamp_message()`, `register()` / `notify()` / `set_state()` |
| `includes/class-router-node.php` | Path-based dispatch by TO; Timer-hitchhike on each tick |
| `includes/class-event-framework.php` | `Event_Framework` — drain loop singleton (`curl_multi_select` or `usleep` + timers; no FD machinery) |
| `includes/class-{tee,tail,log,echo,callback,hook,timer}-node.php` | Generic node primitives |
| `includes/class-{partition,topic,consumer}-node.php` | Storage + log-tailing primitives |
| `includes/class-job-worker-node.php` | `Job_Worker_Node` — generic async-job dispatch (local/remote handler maps via `newspack_nodes/{job,remote_job}_handlers`; GC + cache-flush cadence; memory-watermark self-restart; `GET_HEALTH`). Fires `newspack_nodes/job_worker/{before,after}_job` actions so apps hook per-job request context. Stock `topologies/job-worker.tsl` |
| `includes/class-lock-node.php`, `includes/class-{worker-base,supervisor,supervisor-base,bootstrap}.php` | Lifecycle (`Lock_Node` is a Node subclass; the rest are non-node helpers) |
| `includes/class-{shell,command-interpreter,dumper}-node.php` | REPL components |
| `includes/class-cli.php` | Worker-discovery + pivoted-cli IPC helpers (used by both `wp nodes ls` and `wp nodes cli`) |
| `includes/class-cli-command.php` | `wp nodes {ls,cli}` (bare + pivoted modes); wires the REPL graph — `_stdout` (`TTY_Out_Node`) writer, `_output` (`Dumper_Node`, `target=_stdout`) renderer, and a `TTY_In_Node` stdin reader — then drains via `Event_Framework` |
| `includes/class-{stdin,stdout,tty-in,tty-out}-node.php` | Terminal-I/O primitives: `Stdin_Node`/`Stdout_Node` (bare stream drain/sink; self-scheduling 0ms busy / 10ms post-EOF / 100ms idle re-arm) and their `TTY_In_Node`/`TTY_Out_Node` readline/completion/prompt-aware subclasses used by `wp nodes cli` |
| `includes/cli/class-worker-cli-command.php` | `wp nodes {types,run,restart,status}` |
| `includes/rest/class-spawn-controller.php` | `POST /newspack-nodes/v1/workers/spawn` (HMAC-validated) |
| `includes/rest/class-http-in-node.php` | `POST /newspack-nodes/v1/command` controller + the `_http` egress Node (double-duty) |
| `includes/rest/class-sse-out-node.php` | `GET /newspack-nodes/v1/messages/stream` controller + the `_sse` egress Node (double-duty); carries the inlined SSE wire helpers (headers, event framing, flush) |
| `includes/class-http-filter-node.php` | `_http` filter Node used inside SSE-stream processes (forwards `dump_metadata`/`uptime` replies back to the browser) |
| `includes/rest/class-{classes,layouts,topologies,raw-logs,workers,vault,aggregator,settings,status}-ci-node.php` | Substrate service `*_CI_Node`s mounted via `newspack_nodes/request_graph_ready` |
| `includes/class-service-ci-node.php` | `Service_CI_Node` — abstract base that builds an interpreter's verb table from its `node_schema()` |
| `includes/class-command-auth.php` | HMAC envelope sign/verify (`Command_Auth::sign()` / `Command_Auth::verifier()`); the server-tier `authorize` closure that gates wire-arrived commands. The Shell signs commands inline via `Command_Auth::sign()` (`class-shell-node.php`) — there is no separate signer Node |
| `includes/config-system/class-{field,schema,options-overlay,reset-gate,field-reset-assets,settings-renderer}.php` | `Config_System\*` — shared declarative-settings infrastructure (v0.13.0). One `Field` per setting; `Schema` derives every consumer (overlay key-list, option names, reset list, register/render loops); `Options_Overlay` is presence-based per-request config; `Reset_Gate` + `Field_Reset_Assets` drive per-field reset; `Settings_Renderer` renders the settings page. Sibling plugins adopt this same namespace |
| `includes/class-settings-schema.php` | `Settings_Schema` — the substrate's `Config_System\Schema` declaration (one `Field` per setting); replaces the parallel hand-maintained option/restart arrays `Config` + `Admin` used to keep in lockstep |
| `includes/class-command-args.php` | `Command_Args` — shared command-argument parsing helper |
| `includes/class-{topology-loader,topology-registry}.php` | Topology TSL parser + per-plugin `register_plugin()` entry-point |
| `includes/class-{log-cleaner,log-discovery,node-names,sse-slot-pool,config-utils,formatters}.php` | Internal helpers — log retention sweep, log-name discovery, reserved-name registry, SSE slot pool, config schema utils, formatter registry |
| `includes/admin/class-admin.php` | Substrate settings UI |
| `examples/example-ai-newsletter/` | Bundled walkthrough example plugin — a deterministic digest pipeline built from Nodes (its own `includes/`, `topologies/example-ai-newsletter.tsl`, and PHPUnit suite) |
| `tests/` | PHPUnit suite (`tests/unit/` incl. `ConfigSystem/`, `tests/integration/`, plus `Helpers/` — `CaptureSink` (the `Capture_Sink_Node` double), `TestCase`, `VerbHarness`, `BoundedTicks`, `FakeMemcached` / `InMemoryMemcached`, `WPCLIStub`) |

## Common Pitfalls

These are mistakes that have actually happened. Pay attention.

- **Messages are arrays, not hashes.** Use `Message::TYPE` etc. constants for indexing. `$message['type']` silently fails (PHP coerces string to int 0 → corrupted TYPE).
- **FROM stamping at sources and I/O boundaries.** A node that *mints* a brand-new message stamps FROM with its own name (Shell stamps `_output/<pid>`, interpreter responses stamp `$this->name`, Timer/Tail/Consumer stamp at the I/O boundary); *pass-through* forwarders (Tee, Hook, application nodes that relay an existing message) don't re-stamp. A message flowing `firehose-in → firehose-fanout → request-builder` carries `FROM=firehose-in`, NOT `firehose-fanout/firehose-in`.
- **`stamp_message` empty-name guard.** A node with no name (mid-construction or post-rename) emitting `/from` paths breaks Router. Drop with `print_less_often` instead.
- **Class-API must be event-loop-free.** Constructor for Topic / Partition runs in request scope where there's no `Event_Framework`. See [ADR-5](docs/architecture-decisions.md#adr-5-lazy-init-for-topic--partition).
- **`hash_to_partition` is canonical.** Diverging hash families silently misroute the same key. See [ADR-6](docs/architecture-decisions.md#adr-6-crc32--31-bit-mask-partition-routing).
- **`MAX_FROM_SIZE = 1024`.** `stamp_message` returns false and drops if FROM exceeds 1024 bytes. Prevents path explosion on cycles.
- **Worker lock release before spawn.** `Worker_Base::execute()`'s `finally` block does `release()` THEN `self_respawn()`. Don't reorder; the reverse leaves a 15-second slot gap.
- **HMAC spawn token has TWO accepted windows.** Validates current AND previous 10-second window. Don't tighten to one — race tolerance is intentional.
- **Partition and Topic pack ALL message types** — including TM_REQUEST, TM_ERROR, TM_EOF. The earlier "drop control messages" rule broke `request_node`, `send_eof`, pivoted-mode error responses (TM_COMMAND|TM_ERROR), and the cli's TM_EOF round-trip drain. Data partitions only see TM_BYTESTREAM / TM_STRUCT in practice; allowing other types through is a no-op there and makes IPC work.
- **TM_EOF round-trip drains the cli on stdin close.** Cli emits TM_EOF (FROM=`_output/$pid`); the interpreter it lands on (local in bare mode, the worker's in pivoted mode) bounces TO=FROM; the cli's Dumper sees the echo and flips the exit flag. Mirrors Tachikoma `FileHandle::handle_EOF` → `send_EOF`. There's a 5s deadline fallback so a dead worker doesn't hang the cli.
- **Don't reintroduce TM_PERSIST.** The removal is intentional. See [ADR-3](docs/architecture-decisions.md#adr-3-fire-and-forget-messaging).
- **Skip readline when STDIN isn't a TTY.** `readline_callback_read_char()` reads from the TTY layer, not the stream descriptor; piping into `wp nodes cli` without the gate burns 100% CPU. Already gated; don't remove.
- **Command_Interpreter_Node only handles TM_COMMAND with empty TO.** Non-empty TO means the message is in transit toward another node — interpreter forwards to Router. If you "fix" interpreter to also dispatch on non-empty TO, every interpreter in a path-routed graph eats commands intended for downstream peers.
- **Verb handlers throw freely; `interpret()` wraps as TM_COMMAND|TM_ERROR.** Don't add per-verb `try/catch` — the central catch is the contract. Keep `return 'error: ...'` only for canonical-OK-shaped argument-validation paths where you want to return without error semantics.
- **Constructors set `$this->arguments` directly.** No `dump_config()` override per class. `dump_config()` reads the field to emit a round-trippable `make_node <type> <name> <args>` line; if you forget to set it, `dump_config` emits without args and the round-trip silently produces a different node.
- **`Log` is a `Partition` subclass — append-only segmented `{file}.{seg}`.** It inherits Partition's segments, monotonic rotation (`segment_size`), count+age retention (`num_segments`/`max_lifespan`), rotate lock, and the 4KB PIPE_BUF cap — large VALUEs need `void_warranty()`/`allow_large_writes()`. The only differences from Partition are the two seams: it writes the message **VALUE** (not the packed envelope) and lays segments out as `{file}.0`, `{file}.1`, … (no bare `{file}`, no logrotate `.0` shift, no `mode`/`max_size`/`max_rotations`). Args: `make_node Log <name> <file> [segment_size] [num_segments]`.
- **`Echo` drops TM_ERROR with empty TO.** It would otherwise bounce to a producer that isn't expecting the error trail. If you change Echo's routing rules, preserve the drop.
- **Don't import a `.scss`/`.css` through the `@newspack-nodes/shared/*` alias.** In `jest.config.js` the `^@newspack-nodes/shared/(.*)$` mapper is listed BEFORE the `\.(css|scss)$` style-mock, and first-match wins — so an aliased style import (`@newspack-nodes/shared/styles/x.scss`) resolves to the real file and babel-jest tries to parse SCSS as JS (syntax error) instead of mocking it. Import shared component styles via a RELATIVE path inside the shared component (`./x.scss`), which the style-mock catches. No aliased style import exists today; the consumer (event-logger-nodes) has the identical mapper ordering.

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
