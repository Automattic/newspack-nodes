# AGENTS.md — Newspack Nodes

A **WordPress-internal** runtime borrowing the node *vocabulary* of [Tachikoma](https://github.com/datapoke/tachikoma) (Node, Message, Router, `fill`/`sink`) — not a standalone message bus. Its lifecycle is WordPress: config in the **options table**, the reconcile safety net on **WP-Cron**, worker spawn / command / SSE over the **REST API** behind **HMAC + nonce** auth, live position and stats in **memcache**. It owns the substrate (Node, Message, Router, Topic, Partition, Worker, Fleet, REPL) and ships no application logic, so applications — `newspack-event-logger-nodes` first — compose Nodes on top. It does not run without WordPress.

Every node honors one contract: `fill( array $message ): void`. Nodes connect two ways: **`sink`**, a node reference and the physical next hop `fill()` forwards to; and **`target`**, a string path stamped into `message[TO]` when TO is empty (Tachikoma's `owner`; we did not port `edge`). `_router` dispatches by peeling `message[TO]`. That uniformity lets any node compose with any other.

Ground truth for the model is **Perl Tachikoma** (`services/tachikoma/sources/tachikoma/lib/Tachikoma/`). Newspack-nodes is a variant sharing its semantics with deliberate divergences (KEY/VALUE fields, JSON wire, no TM_PERSIST). Match Tachikoma's model; don't blind-copy its field names. `docs/tachikoma-lineage.md` records what came from where and why.

## Workflow discipline (mandatory)

Every code-writing turn — main Claude AND every subagent — MUST:

1. **Invoke `superpowers:test-driven-development` BEFORE writing any code.** No production code without a failing test first.
2. **Main Claude runs `/code-review` before every commit** (it replaced `superpowers:simplify`). It spawns its own review agents, so subagents cannot run it and do NOT commit. Run it after every subagent finishes, then commit.
3. **Make regressions loud.** The failing test must use values distinct from every default and fallback — one seeded with the default still passes when the change is ignored, so it proves nothing. At runtime read required config through the fail-loud `Config::value()`, never `$config['key'] ?? default`.

Subagent prompts MUST carry this literal phrase; subagents have no memory of conventions, and omitting it is a workflow violation:

> "Invoke `superpowers:test-driven-development` via the Skill tool BEFORE writing any code — mandatory, no exceptions; the failing test must use values distinct from every default/fallback. Do NOT commit: implement, run your tests, and report; main Claude runs `/code-review` and commits."

Full rule: `~/.claude/rules/workflow-discipline.md`.

## Code Style

WordPress VIP Go, enforced by `phpcs.xml.dist`:
- `snake_case`; Yoda conditions (`if ( 'value' === $var )`); `[]` arrays, arrow functions and spread allowed
- Tab indent, spaces inside parens: `function_name( $param )`
- PHP 8.2+; constructor property promotion where it shortens; PHPDoc on public methods
- Unused locals are an error (`VariableAnalysis`, re-raised over VIP-Go's silence — PHPStan cannot see them at any level, because it reasons about types and reachability rather than the liveness of locals)

Inline comments are ONE line, 80 visual columns or fewer, gated by `scripts/lint-comments.{php,mjs}` inside `npm run lint:php` and `lint:js`. The PHP gate also rejects a comment that sits outside a function body without documenting anything: at class-body level the only comment allowed is a docblock immediately preceding its declaration, which catches section headers, `//` notes where a docblock belongs, and docblocks whose method was deleted. Comments inside a class-level initializer annotate their entry and are exempt. Exempt: docblocks, directive comments (`phpcs:`, `translators:`, `eslint-`), and a comment whose FIRST line carries the greppable `@longform` marker — how a genuinely uncondensable footgun earns its length.

Conventional commits (`feat:`, `fix:`, `refactor:`, `test:`, `docs:`).

## Build / Test

Fresh clone, once:

```bash
npm install                  # JS toolchain (esbuild, jest, eslint, lint-staged)
composer install             # PHP deps + the classmap autoloader
npm run build                # compile the dashboard bundles into build/
```

After adding or renaming a Node class, regenerate the classmap that `make_node` and the console palette read: `composer build:autoloaders` (= `composer install --optimize-autoloader`) or `composer dump-autoload -o`. Use `composer update` only when you mean to move dependency versions.

### Git hooks

Hooks are the tracked files in `scripts/` — `pre-commit`, `commit-msg`, `pre-push` — reached via `core.hooksPath`, which `composer install` sets:

```bash
git config core.hooksPath scripts    # what composer's post-install-cmd runs
```

Git cannot track anything under `.git/`, so a tracked directory is what puts the hooks under review with the code they gate. A clone that never ran `composer install` has no hooks at all.

`pre-commit` syncs the shared tooling then runs lint-staged. `commit-msg` runs commitlint. `pre-push` always runs the JS suite and `scripts/lint-docs.sh` — a grep gate over `docs/`, `README.md`, `AGENTS.md` and `.claude/skills` catching prose that drifted from the runtime (retired config tokens, removed verbs, the wrong sibling slug) — then scopes the rest by what the push touched: PHP adds lint, a container deploy, the coverage suite and the per-class 90% gate; JS adds `lint:js` + `build`; SCSS adds `lint:scss` + `build`. A docs-only push runs the JS suite and lint-docs alone.

This plugin is the AUTHORITATIVE copy of the shared tooling. Every sibling vendors `scripts/{pre-commit,commit-msg,reorder-node-methods.*,coverage-gate*,lint-comments.*,lint-docs.sh,test-coverage-gate.sh,test-lint-comments.sh,lib/*.sh}` so a standalone clone works, and `scripts/sync-shared-scripts.sh` (run from each `pre-commit`) refreshes them from here whenever `../newspack-nodes` exists. **Edit the copy in this repo**; the next sibling commit picks it up and stages it. Its only path assumption is a SIBLING substrate checkout. Two files are deliberately NOT vendored: `pre-push` (per-plugin config) and `build.mjs`.

```bash
# Unit, integration and examples suites. Use the vendored binary, NOT the system
# `phpunit` — the container ships 11.x, composer pins 10.5.x, and mixing them dies on
# `DispatchingEmitter::exportsObjects()`. Always pass `--enforce-time-limit` so a test
# blocking on stdin (readline without a TTY) or an infinite drain loop aborts at the
# per-test budget instead of hanging the suite; class-level `#[Medium]` raises it from
# 1s to 10s for tests that legitimately sleep through production code (Lock orphan
# grace, Job_Delay sweeps). `tests/run.sh` wraps this; `tests/run-coverage.sh` adds clover.
cd tests && ../vendor/bin/phpunit --enforce-time-limit

npm run test:js
npm run lint:php
npm run lint:js
npm run lint:scss
npm run lint:shell

# PHP dead-code audit (phpstan-deadcode). GATED on any staged .php. Substrate caveat:
# most findings are public API / WP-CLI entrypoints / JS-PHP wire constants / test
# seams, not real dead code — verify every call path (siblings, JS, dynamic) first.
npm run lint:deadcode

# The JS half (knip). GATED on any staged .js/.jsx. Tests are excluded as consumers, so
# an export only its test imports reads as unused — mark those `@testonly` in the
# docblock (knip `tags`, eslint's definedTags). Two blind spots: the
# `@newspack-nodes/*` surface is entry, so a dead export there is NOT caught and needs a
# manual cross-repo sweep; and knip cannot parse JSX in a `.js` file, which drops that
# file's `import()` expressions — a `lazy( () => import( './X' ) )` target must be
# listed as `entry` in knip.json or it reads as an unused file.
npm run lint:deadcode:js

# REPL against a live worker.
wp nodes status
wp nodes cli firehose-workers.p0
```

It ships as a standard WordPress plugin; deployment (containers, bind mounts, rsync) is environment-specific and lives outside this repo.

## Versioning & Release

The version lives in four places: the `Version:` header and the `NEWSPACK_NODES_VERSION` constant in `newspack-nodes.php`, `"version"` in `package.json`, and the `SUBSTRATE_VERSION` banner in `src/build-kit/index.mjs`. Never edit them by hand — `scripts/bump-version.sh` rewrites all four atomically, syncs `package-lock.json` via `npm version`, and refuses a version that's already current.

Each location has a distinct consumer: the header is what WordPress shows in the admin, the constant is what the runtime asserts against, `package.json` is what npm tooling reads, and the banner is what a consumer's bundle stamps. Drift between any two is a real bug we have shipped.

Releases are automated by GitHub Actions (`.github/workflows/release.yml`): pushing a `v<major>.<minor>.<patch>` tag builds the archive and publishes the Release. You only bump, changelog, commit and tag:

```bash
# 1. CHANGELOG.md: rename `## [Unreleased]` -> `## [<version>] - <date>`,
#    then add a fresh empty `## [Unreleased]` above it (Keep-a-Changelog).
# 2. Bump header + constant + package.json + build-kit banner:
./scripts/bump-version.sh <version>
# 3. Commit changelog + bump together (`chore(release): <version>`).
# 4. Tag and push — the workflow does the rest:
git tag v<version>
git push origin main
git push origin v<version>
```

On the tag push the workflow validates the tag shape (a non-strict tag like `v1.2.3-beta` exits as a silent no-op), runs `npm run release:archive` (= `build-release.sh`: build assets, rsync via `.distignore`, `composer install --no-dev`, zip), extracts the matching `CHANGELOG.md` section as the notes, and publishes with every `release/*.zip` attached. No manual `gh release create`.

`build-release.sh` is the single source of truth for archive contents and what the workflow invokes; run `npm run release:archive` locally to build the same zips. It builds each `examples/*/` as its own installable plugin zip first, then the runtime, rsyncing each minus development artifacts (`src/`, `tests/`, `docs/`, `examples/`, `node_modules/`, `.github`, `composer.{json,lock}`, `package*.json`) so a zip holds the plugin directory at root — `wp plugin install --force --activate <url>.zip` works as-is.

## Architecture Decisions

Intentional, load-bearing choices — "fixing" one usually reintroduces a bug we already paid for. Each is a rationale-ADR (context, alternatives, consequences, and the concrete condition that would reopen it) in **[`docs/architecture-decisions.md`](docs/architecture-decisions.md)**. "Decision N" here and in code comments means **ADR-N**. Numbers are stable — supersede, don't renumber.

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
| 9 | Two-tier safety net — worker self-respawn + peer `_fleet` scan → WP-Cron cold start | [ADR-9](docs/architecture-decisions.md#adr-9-two-tier-safety-net) |
| 10 | `Word_Word` / `_Node` naming + `register_namespace` resolution (no `class_map`) | [ADR-10](docs/architecture-decisions.md#adr-10-class-naming--make_node-namespace-resolution) |
| 11 | `make_node` construction sequence; `arguments()` defaults/required centralized in `parse_schema_args()` | [ADR-11](docs/architecture-decisions.md#adr-11-make_node-construction-sequence) |
| 12 | Dead-letter poison / crash lifecycle — bounded-retry then `:deadletter` quarantine on caught-throw poison; crawl-checkpoint on uncatchable death | [ADR-12](docs/architecture-decisions.md#adr-12-dead-letter-poison--crash-lifecycle) |
| 13 | `fill()` returns void — a node can't observe its sink's disposition; outcomes come back as messages (TO=FROM reply / TM_ERROR), never a return value | [ADR-13](docs/architecture-decisions.md#adr-13-fill-returns-nothing) |
| 14 | Cooperative-stop propagates — a broad `catch` on the drain path re-throws `Worker_Should_Stop` first; carve-outs: Tee/Tap fan-out + post-success `finally` | [ADR-14](docs/architecture-decisions.md#adr-14-cooperative-stop-propagates-through-broad-catches) |
| 15 | Command authorization — `Message::LOCAL` in-process, HMAC on the wire; the MINTER signs (never the ingress), session keys from `POST /v1/auth`, and the key choice is the destination binding | [ADR-15](docs/architecture-decisions.md#adr-15-command-authorization-local-taint--the-minter-signs) |
| 16 | JS node-class resolution — a NAME is the TSL/palette surface; a programmatic builder hands `makeNode` the CLASS, because `includeNodes` is a per-bundle static | [ADR-16](docs/architecture-decisions.md#adr-16-js-node-class-resolution--names-are-the-tsl-surface-classes-are-the-api) |
| 17 | Timers fire on a shared wall-clock GRID — ONE phase for every cadence, so harmonic intervals meet and batch | [ADR-17](docs/architecture-decisions.md#adr-17-timers-fire-on-a-shared-wall-clock-grid) |
| 18 | A Table can front a durable record (`backed_by`); the walk that finds it (`locate_by` / `read_many`) stays in the app | [ADR-18](docs/architecture-decisions.md#adr-18-a-table-can-front-a-durable-record-the-walk-that-finds-it-stays-in-the-app) |

## Layout

| Path | What |
|------|------|
| `newspack-nodes.php` | Entry point. Admin and WP-CLI first call base-dir-independent `Bootstrap::ensure_diagnostics_wired()` (Site Health, loopback TLS posture, selected cache); storage-backed commands and valid REST/admin runtime paths call `ensure_runtime_wired()` lazily, registering the substrate namespace prefixes via `Command_Interpreter_Node::register_namespace()` so `make_node($type)` resolves `{$prefix}{$type}_Node`, the `<config:key>` TSL token namespace (`Config::register_token_namespace()`), the stock/user topology dirs, and the `newspack_nodes/periodic` hooks for `Alerts::emit()` and `Job_Delay::sweep_action()`. It defines `newspack_nodes_mount_substrate_cis` on `newspack_nodes/request_graph_ready` to mount the substrate service CIs |
| `includes/class-core.php` | Per-process registries, clock (`Core::$now`), shutdown flag, `cleanup_all_nodes()` teardown, rate-limited stderr |
| `includes/class-config.php` | Substrate option storage + per-request overlay; derives its key-list and worker-restart classification from `Settings_Schema` |
| `includes/class-message.php` | 7-field array constants, type flags, positional `packed()` / `unpacked()` JSON wire |
| `includes/class-node.php` | Base contract: `fill()`, `sink` + `target`, `stamp_message()`, `register()` / `notify()` / `set_state()` |
| `includes/class-router-node.php` | Path dispatch by TO; Timer-hitchhike each tick |
| `includes/class-event-framework.php` | Drain-loop singleton (`curl_multi_select` or `usleep` + timers; no FD machinery) |
| `includes/class-{tee,tap,grep,tail,log,echo,callback,hook,timer,null}-node.php` | Generic primitives. `Tap_Node` extends Tee with hard targets + passthrough; `Grep_Node` is a regex payload-VALUE filter ported from `Grep.pm`; `Null_Node` counts and discards, so a node that must declare a target has somewhere to point |
| `includes/class-{age-sieve,value-timeout}-node.php` | Flow-control sieves from Tachikoma: `Age_Sieve_Node` drops messages older than `max_age` (`AgeSieve.pm`); `Value_Timeout_Node` is value-keyed dedup with a timeout window and trailing re-emit (`PayloadTimeout.pm`) |
| `includes/class-table-node.php` | The keyed store (Tachikoma Table vocabulary) backed by memcache instead of in-memory buckets, so any process reads or writes via `Table_Node::table( $ns, $ttl, $l1_ttl )` and then `lookup()` / `store()` / `forget()` / `lookup_multi()`; TTL replaces the bucket window, and a non-zero `$l1_ttl` puts a promotion-free `LRU_Cache` in front as an L1 whose entries are at most that stale. Write-through, so it composes mid-graph |
| `includes/class-{graphite,newspack-log,probe-to-graphite}-node.php` | Metrics egress: `Probe_To_Graphite_Node` formats Probe_Record sweeps into plaintext `path value ts` lines (port of `TopicProbeToGraphite.pm`), `Graphite_Node` ships them over UDP, `Newspack_Log_Node` fires `do_action( 'newspack_log', … )` |
| `includes/class-{json-to-struct,struct-to-json}-node.php` | TM_STRUCT ⇄ JSON-line transforms (Tachikoma's `JSONtoStorable`/`StorableToJSON`) — splice around a Log or terminal so a struct producer's array VALUE round-trips through a bytestream line |
| `includes/class-{partition,topic,consumer}-node.php` | Storage + log-tailing primitives |
| `includes/class-probe-node.php` | The periodic per-worker stats sweep, one mechanism with two filters. `Probe_Node` owns the cadence argument, the Router-hitchhike default, the sweep loop and the `Shutdown_Sweeper` flush; a subclass declares only `probe()` (which nodes it claims, and how many records each yields) and, when its record carries a free-text field, `fit_to_line()`. `Topic_Probe_Node` sweeps READY Consumers, one `Probe_Record` each, into `topicprobe.p0`, and carries the static `stale_after_s()` / `interval_s()` readers of the declared cadence. `Job_Probe_Node` sweeps `Job_Worker`s, MANY `Jobstats_Record`s each (one per job IDENTITY) into `jobstats.p0`, and is the only one that fits records through `Line_Fitter` — a Probe_Record has no trimmable field, and halving an identity would corrupt what readers key on. Stock `topologies/topic-probe.tsl` |
| `includes/class-probe-record.php`, `includes/class-jobstats-record.php` | The two positional VALUE layouts, parity-pinned to `src/runtime/probe-record.js` and `src/runtime/jobstats-record.js`. `Jobstats_Record` fields 2..7 are the work done since that identity's previous sweep, with an `ELAPSED_MS` covering it, so a reader divides ONE record and a ~595s worker recycle is just another window rather than a counter reset |
| `includes/class-job-worker-node.php` | `Job_Worker_Node` — generic async-job dispatch: two independently registered handler maps (`newspack_nodes/{job,remote_job}_handlers`, selected by the entry's `k`), a `gc_collect_cycles()` after every job, a `wp_cache_flush()` every `cache_flush_interval` jobs (default 50), and a `GET_HEALTH` verb that REPORTS memory (`memory_used_mb` / `memory_limit_mb`) without acting on it — the watermark stop belongs to `Worker_Base`. Fires `newspack_nodes/job_worker/{before,after}_job` so apps hook per-job request context. Stock `topologies/job-worker.tsl` |
| `includes/class-job-intake.php`, `includes/class-job-delay.php` | `Job_Intake` is the >PIPE_BUF ingress import/cron processes write to (`jobintake.log`, drained into `jobs.log` by `topologies/job-intake.tsl`); `Job_Delay` circulates `not_before`/`delay` entries through the hardwired `jobdelay.p0` partition on the minute-cadence reconciliation pass, so delayed jobs need no new storage and no new timers |
| `includes/class-lock-node.php`, `includes/class-{worker-base,spawn-coordinator,bootstrap,fleet-node}.php`, `includes/trait-cooperative-stop.php`, `includes/class-worker-should-stop{,-clean}.php` | Lifecycle (`Lock_Node` and `Fleet_Node` are Node subclasses; the rest are helpers). `Spawn_Coordinator` is what every spawner shares, in request scope — lock paths, staleness, the 15s throttle, the HMAC spawn token, `spawn_due_workers()`, `spawn_fleet()`, `kill_readers()`, plus the janitorial `reconcile_lock_dirs()` / `cleanup_orphan_ipc()`. `Fleet_Node` is mounted as `_fleet` in every worker and revives peers every 15s; `Bootstrap::reconcile_fleet()` is the minute-cadence WP-Cron pass that spawns FIRST and then keeps house (lock reconcile, retention, orphan IPC, `newspack_nodes/periodic`), each step alone behind its own catch ([ADR-9](docs/architecture-decisions.md#adr-9-two-tier-safety-net)). `Worker_Base::should_continue()` owns every cooperative-stop trigger for EVERY worker type — lock lost, restart requested, `max_runtime` timeout, memory watermark (`MEMORY_WATERMARK_PCT = 0.80` of `memory_limit`) — and `execute()`'s `finally` releases then self-respawns. No node implements its own restart. `Worker_Should_Stop` is raised from inside a long job when the continue-predicate says stop ([ADR-14](docs/architecture-decisions.md#adr-14-cooperative-stop-propagates-through-broad-catches)); its `Worker_Should_Stop_Clean` subclass means the in-flight message's downstream work already COMPLETED, the only signal that lets a Consumer commit past it instead of replaying |
| `includes/class-{alerts,health-checks,health-probe-client}.php` | Fleet health. `Alerts::evaluate()` computes worker-down / consumer-lag / dead-letter-growth from the snapshot `Workers_CI` already builds; `emit()` journals them rate-limited into `alerts.p0`. `Health_Checks` is the environment report behind Site Health and `wp nodes doctor` — seven results, plus `fleet-hold` while a deploy hold stands; declaring a check there is what keeps the two surfaces in sync. `Health_Probe_Client` fetches the WEB runtime's cache result over the loopback, since a CLI process sees a different posture |
| `includes/class-lru-cache.php` | `LRU_Cache` — the bucket LRU from Tachikoma's `Table.pm`, rotating on capacity AND on an absolute wall-clock grid so a restarted process keeps its predecessor's phase. A hit promotes its entry to the newest bucket, which is what a working set wants and what `Table_Node`'s L1 relies on |
| `includes/class-cache-backend.php` | `Cache_Backend` — tier resolver behind every non-durable shared-state surface. `local_first()` (APCu, else memcached) for same-host hot surfaces; `shared_first()` (memcached, else APCu) for cross-process sources of truth. A claim must never straddle tiers; null means nothing is available and the caller keeps its fail-closed behavior |
| `includes/class-capabilities.php` | `Capabilities` — three roles cut by BLAST RADIUS — `read` (dashboards, SSE, introspection), `tune` (declared configuration and application data: settings, the ELN ruleset) and `manage` (fleet control and credentials) — resolved through the filterable `newspack_nodes/capability_map`, all three defaulting to `manage_options`. Verbs declare their role in `node_schema()`; `Service_CI_Node` wraps every handler with it. `$session_scope` is the second half: a scoped command session lowers the CEILING for one command, and can only ever subtract |
| `includes/class-roles.php` | `Roles` — the opt-in migration off `manage_options` onto three real capabilities (`newspack_nodes_{read,tune,manage}`), granting all three to every role that already held `manage_options` in the same step, plus the `newspack_nodes_hub` role (read + tune, nothing else) the log aggregator's dedicated user wears. Reversible; `uninstall.php` calls it |
| `includes/class-sessions.php` | `Sessions` — the durable directory of command sessions this site ISSUES (Vault's mirror: Vault holds what goes OUT). Cache stores don't enumerate, so an option holds the directory and the cache stays the authority on liveness — the same pointer-versus-lease split as `SSE_Slot_Pool`. Never stores the key |
| `includes/class-internal-request-token.php` | `Internal_Request_Token` — purpose-separated HMACs for short-lived internal loopback requests (`spawn`, `health-cache`), each valid for the current or previous 10-second window |
| `includes/class-{shell,command-interpreter,dumper}-node.php` | REPL components. `Command_Interpreter_Node` carries the introspection verbs (`list_timers` / `list_handles` tabulate registered Event_Framework timers and cURL-multi handles for spotting drain spinners), and its `tabulate()` renderer is `public static`, shared by `Log_Sources` / `Node_Schema_Help` / Service CIs. `Shell_Node::parse_statements()` is the ONE static TSL front-end, mirrored in JS as `src/runtime/shell-node.js` `parseStatements` and parity-pinned via `tests/fixtures/statements/` |
| `includes/class-node-schema-help.php` | `Node_Schema_Help::render()` — a `node_schema()` as the errors-as-docs `help <NodeType>` block; presentation over a `Schema_Reflection`-owned schema |
| `includes/class-log-sources.php` | `Log_Sources` — the fixed name→log-source registry `Log_Stream_Out_Node` and the `taillog` verb (`Log_Sources::taillog()`) both consume |
| `includes/class-cli.php` | Worker-discovery + attached-cli IPC helpers, used by `wp nodes status` and `wp nodes cli` |
| `includes/class-cli-command.php` | `wp nodes cli` (bare + attached); wires the REPL graph — `_stdout` (`TTY_Out_Node`), `_output` (`Dumper_Node`, `target=_stdout`), a `TTY_In_Node` reader — then drains via `Event_Framework` |
| `includes/class-{stdin,stdout,stderr,tty-in,tty-out}-node.php` | Terminal I/O. `Stdin_Node`/`Stdout_Node` are bare stream drain/sink (self-scheduling 0ms busy / 10ms post-EOF / 100ms idle re-arm); `TTY_In_Node`/`TTY_Out_Node` add readline, completion and prompts for `wp nodes cli`. `Stderr_Node` writes a TM_BYTESTREAM VALUE through the node stderr chain — splice on the end of a `Tee → Dumper → Grep` debug tap |
| `includes/cli/class-worker-cli-command.php` | `wp nodes {types,run,restart,status,activate,deactivate,gc,doctor}` |
| `includes/cli/class-caps-cli-command.php` | `wp nodes caps <status\|install\|uninstall>` and `wp nodes hub-user <login>` — the operator half of `Roles`: install the granular capabilities, then create the least-privilege aggregator user and issue it an application password (shown once) |
| `includes/cli/class-ingest-cli-command.php` | `wp nodes ingest` — replay packed partition-segment records back through a Topic onto disk |
| `includes/cli/class-scaffold-cli-command.php` | `wp nodes scaffold {plugin,node,topology}` — starter files in the canonical shapes of `docs/writing-a-plugin.md`; never overwrites |
| `includes/rest/class-spawn-controller.php` | `POST /newspack-nodes/v1/workers/spawn` (HMAC nonce, or admin capability + WP nonce + rate limit) |
| `includes/rest/class-auth-controller.php` | `POST /newspack-nodes/v1/auth` — issues the command-signing session, key and handle both generated server-side. Signing belongs to the node that MINTS a command, not the ingress, which would confer authority on anything that reached it |
| `includes/rest/class-health-cache-controller.php` | `POST /newspack-nodes/v1/health/cache` — internal loopback probe reporting the WEB runtime's cache posture to `wp nodes doctor`, gated by an `Internal_Request_Token` rather than a capability. Registered FIRST so REST init completes even when the runtime base is refused |
| `includes/rest/class-http-in-node.php` | `POST /newspack-nodes/v1/command` controller + the `_output` response-writer Node. As a controller it routes the decoded batch through Router; as a Node its `fill()` writes the response body, so an interpreter reply with TO=FROM walks the `_output` boundary back to it. Outbound egress is the separate `HTTP_Out_Node` |
| `includes/rest/class-sse-out-node.php` | `GET /newspack-nodes/v1/messages/stream` controller + the `_sse` egress Node; carries the inlined SSE wire helpers (headers, framing, flush) |
| `includes/rest/class-log-stream-out-node.php` | `GET /newspack-nodes/v1/log/stream` — an `SSE_Out_Node` subclass, identical on the wire, differing only in what a subscription resolves to: a fixed `Log_Sources` NAME opened as a `Tail`, never a caller-supplied path, so there is no traversal surface |
| `includes/class-http-filter-node.php` | `_http` filter Node inside SSE-stream processes (forwards `dump_metadata`/`uptime` replies to the browser) |
| `includes/class-http-out-node.php` | Non-blocking outbound command egress, push-side counterpart of `HTTP_In`: buffers TM_COMMAND envelopes and batches one JSONL POST per drain tick to a remote spoke's `/command` over the cURL-multi |
| `includes/class-sse-in-node.php` | `SSE_In_Node` — generic inbound SSE *pull* source (hidden, programmatically configured): one cURL-multi handle registered with the Event_Framework, a `{segment, offset}` cursor, SSE parser state. `fill()` is a no-op; delivery is the `on_message` seam, which hands each raw `data:` payload to the patron — the patron unpacks, stamps FROM, applies target and fills the sink |
| `includes/class-{remote-link,remote-source}-node.php` | Remote "be the browser" channels: `Remote_Link_Node` patrons an `SSE_In` + `HTTP_Out` pair (heartbeat/reconnect/status); `Remote_Source_Node` extends it and `use`s `Durable_Reader` for durable SSE-pull aggregation |
| `includes/class-settings-event-writer.php`, `includes/class-settings-sync-node.php` | Settings-sync graph. `Settings_Event_Writer` (a plain class) appends to `settings.p0` on a watched-option change: the NAME always rides, bounded old/new excerpts only for options on `newspack_nodes/settings_audit_values_allowlist`, the encrypted vault option never. A name-only record is always ≤ PIPE_BUF so the append is atomic and lockless; a values record that won't fit drops back to name-only rather than dropping the event. A worker Consumer tails it, and `Settings_Sync_Node` (a `Timer_Node`) pushes each option's CURRENT value to connected spokes |
| `includes/class-vault.php` | `Vault` — singleton encrypted credential store for remote-server configs (`newspack_nodes_vault` option, `wp_salt('auth')` key) |
| `includes/rest/class-{classes,layouts,topologies,raw-logs,workers,vault,aggregator,settings,status,sessions}-ci-node.php` | Substrate service `*_CI_Node`s mounted via `newspack_nodes/request_graph_ready`. `Sessions_CI` lists / issues / revokes the command sessions this site hands out; every one of its verbs is `manage`, because issuing one hands out access |
| `includes/class-service-ci-node.php` | `Service_CI_Node` — abstract base building an interpreter's verb table from its `node_schema()` |
| `includes/class-command-auth.php` | HMAC envelope sign/verify (`Command_Auth::sign()` / `Command_Auth::verifier()`) + the server-tier `authorize` closure gating wire-arrived commands. The Shell signs inline via `Command_Auth::sign()` (`class-shell-node.php`) — there is no separate signer Node. A session carries a SCOPE: `verify()` installs it as `Capabilities::$session_scope` for the command being handled, fails CLOSED on every refusal, and `Command_Interpreter_Node::interpret()` restores what stood before |
| `includes/config-system/class-{field,schema,options-overlay,reset-gate,field-reset-assets,settings-renderer,restart-planner}.php` | `Config_System\*` — shared declarative-settings infrastructure. One `Field` per setting; `Schema` derives every consumer (overlay key-list, option names, reset list, register/render loops); `Options_Overlay` is presence-based per-request config; `Reset_Gate` + `Field_Reset_Assets` drive per-field reset; `Settings_Renderer` renders the page. Siblings adopt this namespace |
| `includes/class-settings-schema.php` | The substrate's `Config_System\Schema` declaration, one `Field` per setting; replaced the parallel hand-maintained option/restart arrays `Config` + `Admin` kept in lockstep |
| `includes/class-command-args.php` | `Command_Args` — `parse( list<string> )` classifies a pre-split token array into positionals + `--key[=value]`; `format(): list<string>` is its inverse. Command `arguments` are a flat token array end-to-end — tokenized once at the Shell/REST producer, carried verbatim through envelope / interpreter / `make_node`, re-joined only by `Node::serialize_args()` at the `dump_config` anchor |
| `includes/class-{topology-loader,topology-registry}.php` | TSL parser + per-plugin `register_plugin()` entry point |
| `includes/class-{log-cleaner,log-discovery,node-names,sse-slot-pool,config-utils,formatters}.php` | Helpers — retention sweep, log-name discovery, reserved-name registry, SSE slot pool, config schema utils, formatter registry |
| `includes/interface-shutdown-sweeper.php` | `Shutdown_Sweeper` — a node with unreported state to flush before teardown. `Worker_Base::shutdown_handoff()` calls `shutdown_sweep()` on every implementor on a CLEAN stop, while the graph is intact, never on a fatal. Opt-in, so `Worker_Base` names no class; the probes use it to emit the partial interval a ~595s recycle would drop |
| `includes/trait-{dead-letter-queue,deferred-clean-stop,durable-reader,fanout-targets,file-writer,schema-reflection,sidecar}.php` | Node-mixin traits split off the Node god-object. **`Fanout_Targets`** — the target LIST plus the shared failure contract for Tee, Tap and Settings_Sync. `live_targets()` prunes dead entries and writes back on every read, so there is no way to consume the list and skip the prune; that is what kept the command minters from signing for nodes that no longer exist. `outranks()` picks which per-target throwable escapes: neither Tee nor Tap swallows, both attempt EVERY target and defer, and a plain `Worker_Should_Stop` outranks a `Worker_Should_Stop_Clean` or a poison — the winner moves the consumer cursor, and replaying a clean message is a duplicate at-least-once tolerates, while advancing past one that needed a replay loses it. This reverses an earlier deliberate rule; `tests/unit/TeeStopPrecedenceTest.php` carries the revert signal. **`Durable_Reader`** — the durable log-reader spine (offsetlog cursor + timer-driven buffered pump + pause/step/seek time travel), consumed by Consumer and Remote_Source; formerly three co-required traits. **`Dead_Letter_Queue`** — `:deadletter` quarantine + fair-shot accounting ([ADR-12](docs/architecture-decisions.md#adr-12-dead-letter-poison--crash-lifecycle)), also Partition's write-stall quarantine. **`Deferred_Clean_Stop`** — write side of the clean-stop protocol: a snapshot node defers a `Worker_Should_Stop` around its forwards, finishes the message, then re-raises `Worker_Should_Stop_Clean` so the pump commits past it. **`File_Writer`** — fail-loud `write_all()` + the `$fwrite` seam, Log/Partition only. **`Schema_Reflection`** — `parse_schema_args()`, `auto_wire_interpreter()`, declarative `toggle` verbs ([ADR-11](docs/architecture-decisions.md#adr-11-make_node-construction-sequence)). **`Sidecar`** — sibling-Partition builder |
| `includes/uninstall-cleanup.php` | Option-cleanup helpers loaded only from `uninstall.php`, kept out of the autoloader |
| `includes/admin/class-admin.php` | Substrate settings UI |
| `topologies/` | Stock TSL — `job-worker.tsl` (the pool), `job-intake.tsl` (drains large-write ingress on substrate-only installs; ELN keeps its own copy of this leg and the conflict gate refuses co-activation), `settings-sync.tsl` (single-instance hub control plane), `topic-probe.tsl` |
| `src/` | JS compiled into `build/`: `runtime/` (the browser node graph, including the PHP-parity mirrors `shell-node.js` / `probe-record.js` / `jobstats-record.js`), `shared/` (the canonical `@newspack-nodes/shared` surface every sibling consumes), `build-kit/` (shared esbuild + jest factories, `SUBSTRATE_VERSION` banner), `topology-console/`, `debug-overlay/`, `devtools-hub/`, `event-dashboards/`, `event-aggregator/`, `graph/`, `ui/`, `theme/`, `vault/`, `sessions/`, `admin-field-reset/` |
| `scripts/` | Git hooks plus the shared tooling this repo is authoritative for |
| `examples/example-ai-newsletter/` | Bundled walkthrough plugin — a deterministic digest pipeline built from Nodes (own `includes/`, `topologies/example-ai-newsletter.tsl`, PHPUnit suite). `build-release.sh` ships it as its own zip |
| `tests/` | PHPUnit — `unit/` (incl. `Admin/`, `ConfigSystem/`, `Rest/`, `SpawnCoordinator/`), `integration/`, `Examples` (the `../examples` suffix suite), plus `Helpers/`: `CaptureSink` (the `Capture_Sink_Node` double), `TestCase`, `VerbHarness`, `BoundedTicks`, `TopologyDurability`, `RedirectException`, `FakeMemcached` / `InMemoryMemcached`, `WPCLIStub`, WP shims |

## Common Pitfalls

Mistakes that have actually happened.

- **`@wordpress/*` is pinned to the `wp-7.0` dist tag — never bump it to close an advisory.** Every declared runtime version IS its `wp-7.0` tag (`element 6.40.1`, `i18n 6.13.1`, `api-fetch 7.40.1`; consumers add `components 32.2.1`, `icons 11.7.1`). The build externalises them to the `wp.*` globals, so npm's copy never ships — raising it delivers no new code, it moves the API you compile, lint and type-check against AHEAD of the one the browser is handed. A component changed or removed between majors then builds clean, passes eslint and jest, and breaks at runtime, with nothing mechanical to catch it. Check `npm view @wordpress/<pkg> dist-tags --json` against `wp core version` before proposing any bump, and move the whole family together only when the WordPress target itself moves. A Dependabot advisory reachable only PAST the pin gets dismissed, not bumped: 2026-08-17, uuid GHSA-w5hq-g745-h8pq needed `components >= 33.1.0`, one major past `wp-7.0`, for a package absent from `build/` entirely — dismissed `not_used`. npm `overrides` cannot rescue that, because npm matches an override by package NAME anywhere in the tree: both `{uuid: …}` and the nested `{"@wordpress/components": {uuid: …}}` downgraded the fourteen `@wordpress/*` packages that legitimately require `uuid@^14`. Tooling deps (`eslint-plugin`, `prettier-config`, `stylelint-config`) are not externalised and are not part of the pin.
- **The hermetic Config_System subset stays Core-free.** Consumers load FIVE of these files in hermetic test harnesses without the substrate (pyrobase's `tests/load-config-system.php`: options-overlay, reset-gate, field-reset-assets, field, schema — documented there as dependency-free). Never add a `Core::` or substrate-class call to THOSE five; a coercion-helper sweep did once and pyrobase's mock suite fataled on `Class "Newspack_Nodes\Core" not found`. `class-settings-renderer.php` and `class-restart-planner.php` are NOT hermetic and legitimately use the substrate.
- **Messages are arrays, not hashes.** Index with `Message::TYPE` etc. `$message['type']` silently fails — PHP coerces the string to int 0 and corrupts TYPE.
- **Pick the right `Core` coercion family — the guard is the name.** `as_string`/`as_int`/`as_float` are lenient casts (`is_scalar`; `as_int('42')`→42, `as_int(true)`→1). `num_int`/`num_float` are validated numeric casts (`is_numeric`; bools and `'12abc'` take the default — use these on arithmetic paths). Bare `str`/`arr`/`int` are exact-type passthrough with NO conversion (`int('42')`→default, `str(42)`→default). All take an optional `$default`. The footgun is `int()` on a wire/JSON field arriving as a numeric string; that wants `num_int()` or `as_int()`. An OPERATOR-supplied value (a `--flag`, a verb option) wants none of them: every family resolves to a number, so `--partition=abc` picks p0 and restarts the wrong fleet. `canonical_decimal()` is the refusing read — an int, or a canonical non-negative decimal string in PHP's range, else **null**. Read an OPTION through `Command_Args::option_int( $options, $key, $fallback, $allow_zero )` (absent takes the fallback; the map is `parse()`'s options half, and WP-CLI's `$assoc_args` has the same shape), then report the null in your layer's voice: `CLI::require_flag_int()` for a WP-CLI flag, `Service_CI_Node::require_option_int()` for a verb. A POSITIONAL `make_node` token needs none of that — declare its `type` in `node_schema()['arguments']` and let `parse_schema_args()` walk it: `int` reads through `canonical_decimal()` and `float` through `is_numeric()`, both REFUSING with the node's name and the argument's, and a blank numeric token means "not supplied" (schema default). Don't hand-parse a positional beside the schema that already declares it — that is how five Timer subclasses each grew their own cadence parse.
- **FROM stamping happens at sources and I/O boundaries.** A node that *mints* a new message stamps FROM with its own name (Shell stamps `_output/<pid>`, interpreter responses stamp `$this->name`, Timer/Tail/Consumer stamp at the boundary); *pass-through* forwarders (Tee, Hook, application relays) don't re-stamp. A message flowing `firehose-in → firehose-fanout → request-builder` carries `FROM=firehose-in`, not `firehose-fanout/firehose-in`.
- **A reply is already addressed — never correlate it.** A node mints a command stamped `FROM = <its own name>`; the server replies `TO = FROM`, so the reply lands on THAT node and its `fill()` handles it. The addressing IS the correlation. Do not mint an op-id into `message[ID]`, keep a Promise registry keyed by it, return a Promise from the transport, or press `KEY` into service as a demux discriminator. "I batch N verbs per tick, so I need to tell the replies apart" means ONE node is doing N jobs — make it N nodes. Split by JOB, never by SUBJECT: a table of ten servers is one node per verb, because the subject rides in the ADDRESS — mint FROM `vault:test:in/spoke-01` and the echoed reply arrives at `vault:test:in` carrying `spoke-01` as its remaining TO. Batching is orthogonal: `HTTP_Out`'s lock/flush puts the whole tick in one POST however many nodes minted into it. Already-right shapes: `addSliceFetcher`, RuntimeView's two pollers, `TopologyCatalogNode.fire()` → reply → `fill()`. See [ADR-7](docs/architecture-decisions.md#adr-7-sink-vs-target-and-tofrom-replies).
- **`stamp_message` empty-name guard.** A node with no name (mid-construction or post-rename) emitting `/from` paths breaks Router. Drop with `print_less_often` instead.
- **Class-API must be event-loop-free.** Topic and Partition constructors run in request scope, where there is no `Event_Framework`. See [ADR-5](docs/architecture-decisions.md#adr-5-lazy-init-for-topic--partition).
- **`hash_to_partition` is canonical.** Diverging hash families silently misroute the same key. See [ADR-6](docs/architecture-decisions.md#adr-6-crc32--31-bit-mask-partition-routing).
- **`MAX_FROM_SIZE = 1024`.** `stamp_message` returns false and drops when FROM would exceed it — that is what prevents path explosion on cycles.
- **A self-pacing node holds a RECURRING timer; `oneshot` is for one-time wakeups only.** `fire_cb()` disarms a oneshot BEFORE dispatching (`stop_timer()`, which also zeroes `interval_ms`), so a node that re-arms a fresh oneshot at the bottom of its own `fire()` stays in the event loop only as long as it reaches that last line every tick — one early return, one throw, one refactor and it silently leaves the loop for good. Compute the interval you want and call `set_timer( $next_ms )` only when it differs from `interval_ms`, leaving the recurring timer armed in between; a stop becomes explicit (`Stdin_Node` calls `stop_timer()` on its exit paths). The guard reads true state only while the node's OTHER arming sites (boot, PLAY) are recurring too — a oneshot boot arm leaves `interval_ms` at 0, which a busy branch wanting 0 reads as "no change". `Durable_Reader::fire()`, `Remote_Source_Node::fire()` and `Stdin_Node::fire()` are the live examples — and the arming site that starts each of them (Consumer's and File_Tail's boot arm, Consumer's PLAY, the cli's `$reader->set_timer( 0 )`) is recurring for exactly that reason. `Partition`'s debounce, `HTTP_Out`'s flush and `Request`'s reply deadline are the legitimate one-shots: one wakeup, then nothing. The JS `TimerNode` mirrors all of this — `setInterval` is no protection, since the first fire clears it.
- **Release the worker lock before spawn.** `Worker_Base::execute()`'s `finally` does `release()` THEN `self_respawn()`. Reversed, the successor's acquire hits the still-held lock and skips, idling the slot until a peer's rescue.
- **Internal HMAC tokens accept TWO windows.** `Internal_Request_Token::validate()` accepts the current AND previous 10-second window for both purposes. Don't tighten to one — the race tolerance is intentional. Purposes are separated in the hash, so a token minted for one endpoint never validates at the other.
- **Partition and Topic pack ALL message types**, including TM_REQUEST, TM_ERROR and TM_EOF. The earlier "drop control messages" rule broke `request_node`, `send_eof`, attached-mode error responses, and the cli's TM_EOF drain. Data partitions only see TM_BYTESTREAM / TM_STRUCT in practice, so allowing the rest through is a no-op there and makes IPC work.
- **TM_EOF round-trip drains the cli on stdin close.** Cli emits TM_EOF (FROM=`_output/$pid`); the interpreter it lands on bounces TO=FROM; the cli's Dumper sees the echo and flips the exit flag. Mirrors Tachikoma `FileHandle::handle_EOF` → `send_EOF`. A 5s deadline fallback keeps a dead worker from hanging the cli.
- **Don't reintroduce TM_PERSIST.** The removal is intentional. See [ADR-3](docs/architecture-decisions.md#adr-3-fire-and-forget-messaging).
- **Skip readline when STDIN isn't a TTY.** `readline_callback_read_char()` reads the TTY layer, not the stream descriptor; piping into `wp nodes cli` without the gate burns 100% CPU. Already gated — don't remove it.
- **`Command_Interpreter_Node` only handles TM_COMMAND with empty TO.** Non-empty TO means the message is in transit toward another node, so the interpreter forwards to Router. "Fixing" it to dispatch on non-empty TO makes every interpreter in a path-routed graph eat commands meant for downstream peers.
- **A refusal THROWS; a `return` is a result.** Verb handlers throw freely and `interpret()` wraps as TM_COMMAND|TM_ERROR — don't add per-verb `try/catch`, the central catch is the contract. Every refusal raises: `usage: …`, `unknown node/class/formatter`, `no such topic`, and a secure-level denial. Returning the refusal as a string is what forced `DraftInterpreterNode` to regex the reply text to notice failure, and it left a caller unable to tell refusal from success. Tachikoma's `CommandInterpreter.pm` dies for all of these. The `error:`-shaped returns that remain (`trait-dead-letter-queue.php`, `class-settings-sync-node.php`) are values a caller consumes, not refusals.
- **Constructors set `$this->arguments` directly**, with no per-class `dump_config()` override. `dump_config()` reads that field to emit a round-trippable `make_node <type> <name> <args>`; forget it and the round trip silently produces a different node.
- **`Log` is a `Partition` subclass — append-only segmented `{file}.{seg}`.** It inherits segments, monotonic rotation (`segment_size`), three-rule retention (`num_segments` / `lifetime` / `max_segments`), the rotate lock and the 4KB cap (large VALUEs need `void_warranty()`/`allow_large_writes()`). It differs three ways: it writes the message **VALUE**, not the packed envelope; it lays segments out as `{file}.0`, `{file}.1`, … with no bare `{file}`, no logrotate `.0` shift, no `mode`/`max_size`/`max_rotations`; and its `fill()` DROPS control messages instead of packing them. Args: `make_node Log <name> <file> [segment_size] [min_segments] [num_segments] [max_segments] [min_lifetime] [lifetime]`.
- **`Echo` drops TM_ERROR with empty TO**, which would otherwise bounce to a producer not expecting the error trail. Preserve the drop if you change Echo's routing.
- **Don't import a `.scss`/`.css` through the `@newspack-nodes/shared/*` alias.** In the shared jest config (`src/build-kit/jest.cjs`, consumed via `createJestConfig` — `jest.config.js` has no `moduleNameMapper` of its own) the `^@newspack-nodes/shared/(.*)$` mapper precedes the `\.(css|scss)$` style-mock, and first match wins, so an aliased style import (`@newspack-nodes/shared/styles/x.scss`) resolves to the real file and babel-jest parses SCSS as JS. Import shared component styles by RELATIVE path inside the shared component (`./x.scss`), which the style-mock catches. No aliased style import exists today; event-logger-nodes has the identical ordering.

## Local Skills

`.claude/skills/`:
- `nodes-workflow` — adding Node subclasses, deploying, verifying
- `nodes-debugging` — REPL, log paths, runtime failure modes
- `nodes-review` — substrate contract checklist
- `nodes-dashboards` — building a dashboard, inspector or panel

## References

- **Doc map**: `docs/README.md` — the three-bucket reading order for the whole `docs/` set
- **Architecture**: `docs/architecture-guide.md` (message format, node contracts, drain loop, REPL)
- **Architecture decisions**: `docs/architecture-decisions.md` (the ADRs, with reopen conditions)
- **Tutorial track**, in `docs/README.md` order: `docs/getting-started.md`, `docs/writing-a-plugin.md`, `docs/writing-a-dashboard.md`, `docs/writing-a-real-plugin.md`, `docs/writing-a-real-dashboard.md`, `docs/writing-a-view-node.md`
- **API**: `docs/API.md` — REST endpoints
- **CLI**: `docs/cli.md` — every `wp nodes` subcommand and the common flows
- **Troubleshooting**: `docs/troubleshooting.md` — REPL, worker health, log paths, failure modes
- **Stability**: `docs/stability.md` (frozen 1.0 surfaces, deprecation policy) and `docs/upgrading.md` (each breaking change with its fix)
- **Application example**: `../newspack-event-logger-nodes/` — first plugin built on this runtime
- **Walkthrough example**: `examples/example-ai-newsletter/`
