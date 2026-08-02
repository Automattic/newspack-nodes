# AGENTS.md — Newspack Nodes

A **WordPress-internal** runtime that borrows the node *vocabulary* of [Tachikoma](https://github.com/datapoke/tachikoma) (Node, Message, Router, `fill`/`sink`) — not a standalone message bus. Its lifecycle is WordPress: config in the **options table**, the supervisor safety net on **WP-Cron**, worker spawn / command / SSE over the **REST API** behind **HMAC + nonce** auth, live position and stats in **memcache**. This plugin owns that substrate (Node, Message, Router, Topic, Partition, Worker, Supervisor, REPL) and ships no application logic, so applications — `newspack-event-logger-nodes` first — compose Nodes on top. It is independent of any *application*; it does **not** run without WordPress.

Every node honors one contract: `fill( array $message ): void`. Nodes connect two ways: **`sink`** — a node reference, the physical next hop `fill()` forwards to; and **`target`** — a string path stamped into `message[TO]` when TO is empty (this is Tachikoma's `owner`; we did not port `edge`). `_router` dispatches by peeling `message[TO]`. That uniformity lets any node compose with any other.

The ground truth for this model is **Perl Tachikoma** (`services/tachikoma/sources/tachikoma/lib/Tachikoma/`); newspack-nodes is a variant of it, sharing the semantics and keeping deliberate divergences (KEY/VALUE fields, JSON wire, no TM_PERSIST). Match Tachikoma's model; don't blind-copy its field names. `docs/tachikoma-lineage.md` records what came from where, and why each divergence was chosen.

## Workflow discipline (mandatory)

Every code-writing turn — main Claude AND every subagent dispatched via the Agent tool — MUST:

1. **Invoke `superpowers:test-driven-development` BEFORE writing any code.** No production code without a failing test first.
2. **Before every commit, main Claude runs `/code-review`** (replaces `superpowers:simplify`). It spawns its own review agents, so subagents CANNOT run it and do NOT commit; main Claude always runs it after a subagent finishes, then commits.
3. **Make regressions loud.** The failing test must use values distinct from every default and fallback — a test seeded with the default still passes when the change is ignored, so it proves nothing. At runtime, read required config through the fail-loud `Config::value()` accessor, never `$config['key'] ?? default`.

Subagent prompts MUST include the literal phrase:
> "Invoke `superpowers:test-driven-development` via the Skill tool BEFORE writing any code — mandatory, no exceptions; the failing test must use values distinct from every default/fallback. Do NOT commit: implement, run your tests, and report; main Claude runs `/code-review` and commits."

Subagents have no memory of conversation conventions; omission is a workflow violation. See `~/.claude/rules/workflow-discipline.md`.

## Code Style

WordPress VIP Go (enforced by `phpcs.xml.dist`):
- `snake_case` for functions and variables
- Yoda conditions: `if ( 'value' === $var )`
- `[]` arrays, arrow functions, spread operator allowed
- Tab indentation, spaces inside parentheses: `function_name( $param )`
- PHP 8.2+; constructor property promotion where it shortens
- PHPDoc on public methods
- Unused locals are an error (`VariableAnalysis`, re-raised over VIP-Go's silence — PHPStan cannot see them at any level, because it reasons about types and reachability rather than the liveness of locals)

Inline comments are ONE line, 80 visual columns or fewer — gated by
`scripts/lint-comment-length.{php,mjs}`, which `npm run lint:php` and
`npm run lint:js` both run. Docblocks are exempt, as are directive comments
(`phpcs:`, `translators:`, `eslint-`) and a comment whose first line carries the
greppable `@longform` marker, which is how a genuinely uncondensable footgun
comment earns its length.

Conventional commits (`feat:`, `fix:`, `refactor:`, `test:`, `docs:`).

## Build / Test

Fresh clone, once:

```bash
npm install                  # JS toolchain (esbuild, jest, eslint, lint-staged)
composer install             # PHP deps + the classmap autoloader
npm run build                # compile the dashboard bundles into build/
```

After adding/renaming a Node class, regenerate the classmap (`make_node` and
the console palette read it): `composer build:autoloaders` (= `composer
install --optimize-autoloader`) or `composer dump-autoload -o`. `composer
update` only when you mean to move dependency versions.

### Git hooks

Hooks are the tracked files in `scripts/` — `pre-commit`, `commit-msg`,
`pre-push` — reached via `core.hooksPath`, which `composer install` sets:

```bash
git config core.hooksPath scripts    # what composer's post-install-cmd runs
```

Git cannot track anything under `.git/`, so a tracked directory is what puts the
hooks under review with the code they gate. A clone that has never run
`composer install` has no hooks at all.

`pre-commit` syncs the shared tooling, then runs lint-staged. `commit-msg` runs
commitlint. `pre-push` runs the JS suite and `scripts/lint-docs.sh` on every push
— the latter is a grep gate over `docs/`, `README.md`, `AGENTS.md`, and
`.claude/skills`, catching prose that drifted from the runtime (retired config
tokens, removed verbs, the wrong sibling-plugin slug) — then scopes the rest by
what the push touched: PHP adds lint, a container deploy, the coverage suite, and
the per-class 90% gate; JS adds `lint:js` + `build`; SCSS adds `lint:scss` +
`build`. A docs-only push runs the JS suite and lint-docs alone.

This plugin is also the AUTHORITATIVE copy of the shared tooling. Every sibling
plugin carries a vendored copy of `scripts/{pre-commit,commit-msg,
reorder-node-methods.*,coverage-gate*,lint-comment-length.*,lint-docs.sh,
test-coverage-gate.sh,lib/*.sh}` so a standalone clone works without a sibling
checkout, and `scripts/sync-shared-scripts.sh` (run from each `pre-commit`)
refreshes them from here whenever `../newspack-nodes` exists. Edit the copy in
this repo; the next commit in a sibling picks it up and stages it. Its only path
assumption is that the substrate is a SIBLING checkout. Two files are
deliberately NOT vendored: `pre-push` (per-plugin config) and `build.mjs`.

```bash
# Run the unit, integration, and examples suites. Use the vendored binary,
# NOT the system `phpunit` — the container ships 11.x, composer pins 10.5.x,
# and mixing them dies on `DispatchingEmitter::exportsObjects()`. Always pass
# `--enforce-time-limit` so a test that accidentally blocks on stdin (readline
# mode without a TTY) or an infinite drain loop gets aborted at the per-test
# budget instead of hanging the whole suite. Class-level `#[Medium]` raises the
# limit from 1s to 10s for tests that legitimately sleep through production
# code (Lock orphan grace, supervisor tick_loop). `tests/run.sh` wraps this;
# `tests/run-coverage.sh` adds clover + HTML coverage.
cd tests && ../vendor/bin/phpunit --enforce-time-limit

# Run the JS suite; lint PHP, JS, SCSS, and the shell scripts.
npm run test:js
npm run lint:php
npm run lint:js
npm run lint:scss
npm run lint:shell

# Opt-in dead-code audit (NOT in the lint gate). Substrate caveat: most findings
# are public API / WP-CLI entrypoints / JS-PHP wire constants / test seams, not
# real dead code — verify every call path (incl siblings + JS + dynamic) first.
npm run lint:deadcode

# The JS half of the same audit (knip). Same caveat, plus two of its own: the
# `@newspack-nodes/*` surface is entry, so a dead export there needs a manual
# cross-repo sweep; and knip cannot parse JSX in a `.js` file, which drops that
# file's `import()` expressions — a `lazy( () => import( './X' ) )` target must
# be listed as `entry` in knip.json or it reads as an unused file.
npm run lint:deadcode:js

# REPL against a live worker.
wp nodes status
wp nodes cli firehose-workers.p0
```

It ships as a standard WordPress plugin; deployment (containers, bind mounts, rsync, etc.) is environment-specific and lives outside this repo.

## Versioning & Release

The version appears in four places: the `Version:` header in `newspack-nodes.php`, the `NEWSPACK_NODES_VERSION` PHP constant in the same file, the `"version"` field in `package.json`, and the `SUBSTRATE_VERSION` banner constant in `src/build-kit/index.mjs`. Do NOT edit these by hand — `scripts/bump-version.sh` rewrites all four atomically (and syncs `package-lock.json` via `npm version`) and refuses to bump to a version that's already current.

Releases are **automated by GitHub Actions** (`.github/workflows/release.yml`): pushing a `v<major>.<minor>.<patch>` tag builds the archive and publishes the GitHub Release. You only bump, changelog, commit, and tag:

```bash
# 1. Update CHANGELOG.md: rename `## [Unreleased]` → `## [<version>] - <date>`,
#    then add a fresh empty `## [Unreleased]` above it (Keep-a-Changelog format).
# 2. Bump plugin header + constant + package.json + build-kit banner:
./scripts/bump-version.sh <version>
# 3. Commit the changelog + bump together (e.g. `chore(release): <version>`).
# 4. Tag and push — the workflow does the rest:
git tag v<version>
git push origin main
git push origin v<version>
```

On the tag push, the **Release** workflow validates the tag shape (a non-strict
tag such as `v1.2.3-beta` exits as a silent no-op), runs `npm run
release:archive` (= `build-release.sh`: build assets, rsync via `.distignore`,
`composer install --no-dev`, zip), extracts the matching `CHANGELOG.md` section
as the release notes, and publishes the GitHub Release with every `release/*.zip`
attached. No manual `gh release create`.

`build-release.sh` remains the single source of truth for archive contents and
is what the workflow invokes; run `npm run release:archive` locally to build the
same zips for testing. It builds each `examples/*/` as its own installable
plugin zip first, then the runtime itself, rsyncing each minus development
artifacts (`src/`, `tests/`, `docs/`, `examples/`, `node_modules/`, `.github`,
`composer.{json,lock}`, `package*.json`, etc.) so a zip holds the plugin
directory at root — `wp plugin install --force --activate <url>.zip` works
as-is.

**Why four locations?** The plugin header is what WordPress shows in the admin; the PHP constant is what the runtime asserts against; `package.json` is what npm tooling reads; the build-kit banner is what a consumer's bundle stamps. The bump script is the single source of truth — drift between any two of them is a real bug we've shipped before.

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
| 15 | Command authorization — `Message::LOCAL` in-process, HMAC on the wire; the MINTER signs (never the ingress), session keys from `POST /v1/auth`, and the key choice is the destination binding | [ADR-15](docs/architecture-decisions.md#adr-15-command-authorization-local-taint--the-minter-signs) |

## Layout

| Path | What |
|------|------|
| `newspack-nodes.php` | Plugin entry point. Admin and WP-CLI first call base-dir-independent `Bootstrap::ensure_diagnostics_wired()` (Site Health, loopback TLS posture, selected cache); storage-backed commands and valid REST/admin runtime paths call `ensure_runtime_wired()` lazily, which registers the substrate namespace prefixes via `Command_Interpreter_Node::register_namespace()` so `make_node($type)` resolves `{$prefix}{$type}_Node`, the `<config:key>` TSL token namespace (`Config::register_token_namespace()`), the stock/user topology dirs, and the `newspack_nodes/supervisor_periodic` hooks for `Alerts::emit()` and `Job_Delay::sweep_action()`. The entry point itself defines `newspack_nodes_mount_substrate_cis` and hooks it to `newspack_nodes/request_graph_ready` to mount the substrate service CIs |
| `includes/class-core.php` | Per-process registries, clock (`Core::$now`), shutdown flag, `cleanup_all_nodes()` teardown, rate-limited stderr |
| `includes/class-config.php` | Substrate option storage + per-request config overlay; derives its key-list and worker-restart classification from `Settings_Schema` (see `config-system/`) |
| `includes/class-message.php` | 7-field array constants, type flags, positional `packed()` / `unpacked()` JSON wire |
| `includes/class-node.php` | Base contract: `fill()`, `sink` (physical next node) + `target` (logical TO path), `stamp_message()`, `register()` / `notify()` / `set_state()` |
| `includes/class-router-node.php` | Path-based dispatch by TO; Timer-hitchhike on each tick |
| `includes/class-event-framework.php` | `Event_Framework` — drain loop singleton (`curl_multi_select` or `usleep` + timers; no FD machinery) |
| `includes/class-{tee,tap,grep,tail,log,echo,callback,hook,timer,null}-node.php` | Generic node primitives (`Tap_Node` extends Tee with hard targets + passthrough; `Grep_Node` regex payload-VALUE filter, ported from Tachikoma's `Grep.pm`; `Null_Node` counts and discards, so a node that must declare a target has somewhere to point) |
| `includes/class-{age-sieve,value-timeout}-node.php` | Flow-control sieves ported from Tachikoma: `Age_Sieve_Node` drops any message older than `max_age` (`AgeSieve.pm`); `Value_Timeout_Node` is value-keyed dedup with a timeout window and a trailing re-emit (`PayloadTimeout.pm`) |
| `includes/class-table-node.php` | `Table_Node` — the keyed store (Tachikoma Table vocabulary) backed by memcache instead of in-memory buckets, so any process reads a value via `Table_Node::lookup()` and TTL replaces the bucket window; write-through, so it composes mid-graph |
| `includes/class-{graphite,newspack-log,probe-to-graphite}-node.php` | Metrics egress: `Probe_To_Graphite_Node` formats Probe_Record sweeps into plaintext `path value ts` lines (port of `TopicProbeToGraphite.pm`), `Graphite_Node` ships them over UDP, `Newspack_Log_Node` fires `do_action( 'newspack_log', … )` into the Newspack observability pipeline |
| `includes/class-{json-to-struct,struct-to-json}-node.php` | TM_STRUCT ⇄ JSON-line transforms (Tachikoma's `JSONtoStorable`/`StorableToJSON` pair) — splice around a Log or terminal so a struct producer's array VALUE round-trips through a bytestream line |
| `includes/class-{partition,topic,consumer}-node.php` | Storage + log-tailing primitives |
| `includes/class-topic-probe-node.php`, `includes/class-probe-record.php` | `TopicProbe_Node` — periodic per-worker Consumer-stats sweep (port of Tachikoma TopicProbe, consumer branch); `Probe_Record` fixes the positional layout of a `topicprobe.p0` VALUE (mirrors `src/runtime/probe-record.js`, parity-pinned). Stock `topologies/topic-probe.tsl` |
| `includes/class-job-probe-node.php`, `includes/class-jobstats-record.php` | `Job_Probe_Node` — the jobs analog of TopicProbe: one snapshot record per job IDENTITY per tick into the shared `jobstats` log (a Job_Worker owns many identities, so one worker yields many records). `Jobstats_Record` fixes that record's positional layout; fields 2..7 are cumulative counters, and readers derive rates by differencing consecutive records — a worker restart reads as a counter reset, so its rate falls to 0 (mirrors `src/runtime/jobstats-record.js`, parity-pinned) |
| `includes/class-job-worker-node.php` | `Job_Worker_Node` — generic async-job dispatch: two independently registered handler maps (`newspack_nodes/{job,remote_job}_handlers`, selected by the entry's `k`), a `gc_collect_cycles()` after every job, a `wp_cache_flush()` every `cache_flush_interval` jobs (default 50), and a `GET_HEALTH` request verb that REPORTS memory (`memory_used_mb` / `memory_limit_mb`) without acting on it — the memory-watermark stop belongs to `Worker_Base`, below. Fires `newspack_nodes/job_worker/{before,after}_job` actions so apps hook per-job request context. Stock `topologies/job-worker.tsl` |
| `includes/class-job-intake.php`, `includes/class-job-delay.php` | `Job_Intake` — the >PIPE_BUF job ingress import/cron processes write to (`jobintake.log`, drained into `jobs.log` by stock `topologies/job-intake.tsl`); `Job_Delay` circulates `not_before`/`delay` entries through the hardwired `jobdelay.p0` partition on the `newspack_nodes/supervisor_periodic` tick, so delayed jobs need no new storage and no new timers |
| `includes/class-lock-node.php`, `includes/class-{worker-base,supervisor,supervisor-base,bootstrap}.php`, `includes/class-worker-should-stop{,-clean}.php` | Lifecycle (`Lock_Node` is a Node subclass; the rest are non-node helpers). `Worker_Base::should_continue()` owns every cooperative-stop trigger for EVERY worker type — lock lost, restart requested, `max_runtime` timeout, and the memory watermark (`MEMORY_WATERMARK_PCT = 0.80` of `memory_limit`) — and the `finally` in `execute()` then releases and self-respawns. No node implements its own restart. `Worker_Should_Stop` is the cooperative-stop exception raised from inside a long job when the drain continue-predicate says stop — see [ADR-14](docs/architecture-decisions.md#adr-14-cooperative-stop-propagates-through-broad-catches). Its `Worker_Should_Stop_Clean` subclass means the in-flight message's downstream work already COMPLETED, which is the only signal that lets a Consumer commit past it instead of replaying it |
| `includes/class-{alerts,health-checks,health-probe-client}.php` | Fleet health: `Alerts::evaluate()` computes worker-down / consumer-lag / dead-letter-growth conditions from the snapshot `Workers_CI` already builds, and `emit()` journals them (rate-limited) into `alerts.p0`; `Health_Checks` is the canonical seven-result environment report behind Site Health and `wp nodes doctor`; `Health_Probe_Client` fetches the WEB runtime's cache result over the loopback, since a CLI process sees a different cache posture |
| `includes/class-cache-backend.php` | `Cache_Backend` — the tier resolver behind every non-durable shared-state surface. `local_first()` (APCu, else memcached) for same-host hot surfaces; `shared_first()` (memcached, else APCu) for cross-process sources of truth. A claim must never straddle tiers; null means nothing is available and the caller keeps its fail-closed behavior |
| `includes/class-capabilities.php` | `Capabilities` — two roles, `read` (dashboards, SSE, introspection) and `manage` (everything that mutates), resolved through the filterable `newspack_nodes/capability_map`. Both default to `manage_options`. Verbs declare their role in `node_schema()`; `Service_CI_Node` wraps every handler with it |
| `includes/class-internal-request-token.php` | `Internal_Request_Token` — purpose-separated HMACs for short-lived internal loopback requests (`spawn`, `health-cache`), each valid for the current or previous 10-second window |
| `includes/class-{shell,command-interpreter,dumper}-node.php` | REPL components; `Command_Interpreter_Node` also carries the introspection verbs (`list_timers` / `list_handles` tabulate the Event_Framework's registered timers and cURL-multi handles for spotting drain spinners), and its `tabulate()` text-table renderer is `public static` — shared by `Log_Sources` / `Node_Schema_Help` / Service CIs. `Shell_Node::parse_statements()` is the ONE static TSL front-end (mirrored in JS as `src/runtime/shell-node.js` `parseStatements`, parity-pinned via `tests/fixtures/statements/`) |
| `includes/class-node-schema-help.php` | `Node_Schema_Help::render()` — renders a `node_schema()` as the errors-as-docs `help <NodeType>` text block; extracted from the interpreter (presentation over a `Schema_Reflection`-owned schema) |
| `includes/class-log-sources.php` | `Log_Sources` — the fixed name→log-source registry that `Log_Stream_Out_Node` and the `taillog` verb (`Log_Sources::taillog()`, moved off the interpreter) both consume |
| `includes/class-cli.php` | Worker-discovery + attached-cli IPC helpers (used by both `wp nodes status` and `wp nodes cli`) |
| `includes/class-cli-command.php` | `wp nodes cli` (bare + attached modes); wires the REPL graph — `_stdout` (`TTY_Out_Node`) writer, `_output` (`Dumper_Node`, `target=_stdout`) renderer, and a `TTY_In_Node` stdin reader — then drains via `Event_Framework` |
| `includes/class-{stdin,stdout,stderr,tty-in,tty-out}-node.php` | Terminal-I/O primitives: `Stdin_Node`/`Stdout_Node` (bare stream drain/sink; self-scheduling 0ms busy / 10ms post-EOF / 100ms idle re-arm) and their `TTY_In_Node`/`TTY_Out_Node` readline/completion/prompt-aware subclasses used by `wp nodes cli`; `Stderr_Node` is a bare diagnostic sink that writes a TM_BYTESTREAM VALUE through the node stderr chain (splice on the end of a `Tee → Dumper → Grep` debug tap) |
| `includes/cli/class-worker-cli-command.php` | `wp nodes {types,run,restart,status,activate,deactivate,gc,doctor}` |
| `includes/cli/class-ingest-cli-command.php` | `wp nodes ingest` — replay packed partition-segment records back through a Topic onto disk |
| `includes/cli/class-scaffold-cli-command.php` | `wp nodes scaffold {plugin,node,topology}` — generate the first-contact starter files in the canonical shapes of `docs/writing-a-plugin.md`; never overwrites an existing target |
| `includes/rest/class-spawn-controller.php` | `POST /newspack-nodes/v1/workers/spawn` (HMAC nonce, or admin capability + WP nonce + rate limit) |
| `includes/rest/class-auth-controller.php` | `POST /newspack-nodes/v1/auth` — issues the command-signing session (key and handle both generated server-side). Signing belongs to the node that MINTS a command, not to the ingress boundary, which would otherwise confer authority on anything that reached it |
| `includes/rest/class-health-cache-controller.php` | `POST /newspack-nodes/v1/health/cache` — the internal loopback probe that reports the WEB runtime's cache posture to `wp nodes doctor`, gated by an `Internal_Request_Token` rather than a user capability. Registered FIRST so REST init completes even when the runtime base is refused |
| `includes/rest/class-http-in-node.php` | `POST /newspack-nodes/v1/command` controller + the `_output` response-writer Node (double-duty): as a controller it routes the decoded batch through Router; as a Node its `fill()` writes the `/command` response body, so an interpreter reply with TO=FROM walks the `_output` boundary back to it. (Outbound command egress is the separate `HTTP_Out_Node`; `_http` is the filter Node below.) |
| `includes/rest/class-sse-out-node.php` | `GET /newspack-nodes/v1/messages/stream` controller + the `_sse` egress Node (double-duty); carries the inlined SSE wire helpers (headers, event framing, flush) |
| `includes/rest/class-log-stream-out-node.php` | `GET /newspack-nodes/v1/log/stream` — an `SSE_Out_Node` subclass, identical on the wire, differing only in what a subscription resolves to: a fixed `Log_Sources` registry NAME opened as a `Tail`, never a caller-supplied path, so there is no traversal surface |
| `includes/class-http-filter-node.php` | `_http` filter Node used inside SSE-stream processes (forwards `dump_metadata`/`uptime` replies back to the browser) |
| `includes/class-http-out-node.php` | `HTTP_Out_Node` — non-blocking outbound command egress (push-side counterpart of `HTTP_In`): buffers TM_COMMAND envelopes, batches one JSONL POST per drain tick to a remote spoke's `/command` over the Event_Framework's cURL-multi |
| `includes/class-sse-in-node.php` | `SSE_In_Node` — generic inbound SSE *pull* source (hidden, programmatically configured): owns one cURL-multi handle registered with the Event_Framework, a `{segment, offset}` cursor, and SSE parser state; `fill()` is a no-op, it forwards pulled msgs to its sink with `TO=target` |
| `includes/class-{remote-link,remote-source}-node.php` | Remote "be the browser" SSE+HTTP channels: `Remote_Link_Node` patrons an `SSE_In` + `HTTP_Out` sibling pair (heartbeat/reconnect/status); `Remote_Source_Node` extends it + `use`s `Durable_Reader` for durable SSE-pull aggregation |
| `includes/class-settings-event-writer.php`, `includes/class-settings-sync-node.php` | Settings-sync graph: `Settings_Event_Writer` (a plain class, not a Node) appends an event to `settings.p0` on a watched-option change; the option NAME always rides, bounded old/new value excerpts only for options on the `newspack_nodes/settings_audit_values_allowlist`, and the encrypted vault option never. A name-only record is always ≤ PIPE_BUF, so the append is atomic and lockless; a values record that will not fit drops back to name-only rather than dropping the event. A worker Consumer tails it, and `Settings_Sync_Node` (a `Timer_Node`) pushes each option's CURRENT value to connected spokes |
| `includes/class-vault.php` | `Vault` — singleton encrypted credential store for remote-server configs (`newspack_nodes_vault` option, `wp_salt('auth')` key) |
| `includes/rest/class-{classes,layouts,topologies,raw-logs,workers,vault,aggregator,settings,status}-ci-node.php` | Substrate service `*_CI_Node`s mounted via `newspack_nodes/request_graph_ready` |
| `includes/class-service-ci-node.php` | `Service_CI_Node` — abstract base that builds an interpreter's verb table from its `node_schema()` |
| `includes/class-command-auth.php` | HMAC envelope sign/verify (`Command_Auth::sign()` / `Command_Auth::verifier()`); the server-tier `authorize` closure that gates wire-arrived commands. The Shell signs commands inline via `Command_Auth::sign()` (`class-shell-node.php`) — there is no separate signer Node |
| `includes/config-system/class-{field,schema,options-overlay,reset-gate,field-reset-assets,settings-renderer,restart-planner}.php` | `Config_System\*` — shared declarative-settings infrastructure (v0.13.0). One `Field` per setting; `Schema` derives every consumer (overlay key-list, option names, reset list, register/render loops); `Options_Overlay` is presence-based per-request config; `Reset_Gate` + `Field_Reset_Assets` drive per-field reset; `Settings_Renderer` renders the settings page. Sibling plugins adopt this same namespace |
| `includes/class-settings-schema.php` | `Settings_Schema` — the substrate's `Config_System\Schema` declaration (one `Field` per setting); replaces the parallel hand-maintained option/restart arrays `Config` + `Admin` used to keep in lockstep |
| `includes/class-command-args.php` | `Command_Args` — shared command-argument grammar helper: `parse( list<string> )` classifies a pre-split token array into positionals + `--key[=value]` options; `format(): list<string>` is its inverse. Command `arguments` are a flat token array end-to-end (tokenized once at the Shell/REST producer, carried verbatim through the envelope / interpreter / `make_node`, re-joined only by `Node::serialize_args()` at the `dump_config` serialization anchor) |
| `includes/class-{topology-loader,topology-registry}.php` | Topology TSL parser + per-plugin `register_plugin()` entry-point |
| `includes/class-{log-cleaner,log-discovery,node-names,sse-slot-pool,config-utils,formatters}.php` | Internal helpers — log retention sweep, log-name discovery, reserved-name registry, SSE slot pool, config schema utils, formatter registry |
| `includes/trait-{dead-letter-queue,deferred-clean-stop,durable-reader,fanout-targets,file-writer,schema-reflection,sidecar}.php` | Shared node-mixin traits split off the Node god-object: `Fanout_Targets` (the target LIST plus the shared failure contract for fan-out nodes — Tee, Tap via Tee, Settings_Sync. `live_targets()` prunes dead entries and writes back on every read, so there is no way to consume the list and skip the prune, which is what kept the command minters from signing for nodes that no longer exist. `outranks()` picks which of several per-target throwables escapes: neither Tee nor Tap swallows, both attempt EVERY target and defer, and a plain `Worker_Should_Stop` outranks a `Worker_Should_Stop_Clean` or a poison — because the winner moves the consumer cursor, and replaying a clean message is a duplicate at-least-once tolerates while advancing past one that needed a replay loses it. This reverses an earlier deliberate rule; `tests/unit/TeeStopPrecedenceTest.php` carries the named revert signal), `Durable_Reader` (the durable log-reader spine — offsetlog cursor + timer-driven buffered pump + pause/step/seek time-travel debugger, consumed by Consumer + Remote_Source; formerly the three co-required traits Offsetlog_Cursor/Buffered_Pump/Time_Travel), `Dead_Letter_Queue` (`:deadletter` quarantine + fair-shot accounting — [ADR-12](docs/architecture-decisions.md#adr-12-dead-letter-poison--crash-lifecycle) — also Partition's write-stall quarantine), `Deferred_Clean_Stop` (write-side of the clean cooperative-stop protocol — a snapshot node defers a `Worker_Should_Stop` around its downstream forwards, finishes the message, then re-raises `Worker_Should_Stop_Clean` so the pump commits past it; consumed by application snapshot nodes in sibling plugins), `File_Writer` (fail-loud `write_all()` + the `$fwrite` seam, Log/Partition only), `Schema_Reflection` (`parse_schema_args()` + `auto_wire_interpreter()` + declarative `toggle` verbs from `node_schema()` — [ADR-11](docs/architecture-decisions.md#adr-11-make_node-construction-sequence)), `Sidecar` (sibling-Partition builder) |
| `includes/uninstall-cleanup.php` | Option-cleanup helpers loaded only from `uninstall.php` (kept out of the autoloader; costs nothing at runtime) |
| `includes/admin/class-admin.php` | Substrate settings UI |
| `topologies/` | Stock TSL topologies — `job-worker.tsl` (the Job_Worker pool), `job-intake.tsl` (drains the large-write ingress on substrate-only installs; ELN keeps its own copy of this leg and the conflict gate refuses co-activation), `settings-sync.tsl` (single-instance hub control plane), `topic-probe.tsl` (the per-worker Consumer-stats sweep) |
| `src/` | JS sources compiled into `build/`: `runtime/` (the browser node graph, including the PHP-parity mirrors `shell-node.js` / `probe-record.js` / `jobstats-record.js`), `shared/` (the canonical `@newspack-nodes/shared` hooks and components every sibling plugin consumes), `build-kit/` (the shared esbuild + jest factories, and the `SUBSTRATE_VERSION` banner), `topology-console/`, `debug-overlay/`, `devtools-hub/`, `event-dashboards/`, `event-aggregator/`, `graph/`, `ui/`, `theme/`, `vault/`, `admin-field-reset/` |
| `scripts/` | Git hooks plus the shared tooling this repo is authoritative for (see "Git hooks" above) |
| `examples/example-ai-newsletter/` | Bundled walkthrough example plugin — a deterministic digest pipeline built from Nodes (its own `includes/`, `topologies/example-ai-newsletter.tsl`, and PHPUnit suite). `build-release.sh` ships it as its own installable zip |
| `tests/` | PHPUnit suites — `unit/` (incl. `Admin/`, `ConfigSystem/`, `Rest/`, `Supervisor/`), `integration/`, and `Examples` (the `../examples` suffix suite), plus `Helpers/` — `CaptureSink` (the `Capture_Sink_Node` double), `TestCase`, `VerbHarness`, `BoundedTicks`, `TopologyDurability`, `RedirectException`, `FakeMemcached` / `InMemoryMemcached`, `WPCLIStub`, and the WP shims |

## Common Pitfalls

These are mistakes that have actually happened. Pay attention.

- **The hermetic Config_System subset stays Core-free.** Consumer plugins load FIVE of these files in HERMETIC test harnesses without the substrate (pyrobase's `tests/load-config-system.php`: options-overlay, reset-gate, field-reset-assets, field, schema — documented there as dependency-free). Never add a `Core::`/substrate-class call to THOSE five (a coercion-helper sweep did once; pyrobase's mock suite fataled `Class "Newspack_Nodes\Core" not found`). `class-settings-renderer.php` / `class-restart-planner.php` are NOT in the hermetic set and legitimately use the substrate.
- **Messages are arrays, not hashes.** Use `Message::TYPE` etc. constants for indexing. `$message['type']` silently fails (PHP coerces string to int 0 → corrupted TYPE).
- **Pick the right `Core` coercion family — the guard is the name.** `as_string`/`as_int`/`as_float` = lenient cast (`is_scalar`; `as_int('42')`→42, `as_int(true)`→1). `num_int`/`num_float` = validated numeric cast (`is_numeric`; bools and `'12abc'` take the default — use on arithmetic paths). Bare `str`/`arr`/`int` = exact-type passthrough, NO conversion (`int('42')`→default, `str(42)`→default). All take an optional `$default`. The footgun is `int()` on a wire/JSON field that arrives as a numeric string — that wants `num_int()` or `as_int()`.
- **FROM stamping at sources and I/O boundaries.** A node that *mints* a brand-new message stamps FROM with its own name (Shell stamps `_output/<pid>`, interpreter responses stamp `$this->name`, Timer/Tail/Consumer stamp at the I/O boundary); *pass-through* forwarders (Tee, Hook, application nodes that relay an existing message) don't re-stamp. A message flowing `firehose-in → firehose-fanout → request-builder` carries `FROM=firehose-in`, NOT `firehose-fanout/firehose-in`.
- **A reply is already addressed — never correlate it.** A node mints a command
  stamped `FROM = <its own name>`; the server replies `TO = FROM`, so the reply
  lands on THAT node and its `fill()` handles it. The addressing IS the
  correlation. Do not mint an op-id into `message[ID]`, do not keep a Promise
  registry keyed by it, do not return a Promise from the transport, and do not
  press `KEY` into service as a demux discriminator. "I batch N verbs per tick,
  so I need to tell the replies apart" means you have ONE node doing N jobs —
  make it N nodes. Batching is orthogonal: `HTTP_Out`'s lock/flush puts the
  whole tick in one POST however many nodes minted into it. The shapes that are
  already right: `addSliceFetcher` ("an independent reply path per slice,
  nothing crosses"), RuntimeView's two pollers, `TopologyCatalogNode.fire()` →
  reply → `fill()`. See [ADR-7](docs/architecture-decisions.md#adr-7-sink-vs-target-and-tofrom-replies).
- **`stamp_message` empty-name guard.** A node with no name (mid-construction or post-rename) emitting `/from` paths breaks Router. Drop with `print_less_often` instead.
- **Class-API must be event-loop-free.** Topic and Partition constructors run in request scope, where there is no `Event_Framework`. See [ADR-5](docs/architecture-decisions.md#adr-5-lazy-init-for-topic--partition).
- **`hash_to_partition` is canonical.** Diverging hash families silently misroute the same key. See [ADR-6](docs/architecture-decisions.md#adr-6-crc32--31-bit-mask-partition-routing).
- **`MAX_FROM_SIZE = 1024`.** `stamp_message` returns false and drops when FROM would exceed 1024 bytes, which is what prevents path explosion on cycles.
- **Worker lock release before spawn.** `Worker_Base::execute()`'s `finally` block does `release()` THEN `self_respawn()`. Don't reorder; the reverse makes the successor's acquire hit the still-held lock and skip, idling the slot until the supervisor's rescue.
- **Internal HMAC tokens accept TWO windows.** `Internal_Request_Token::validate()` accepts the current AND the previous 10-second window, for both purposes (`spawn`, `health-cache`). Don't tighten to one — the race tolerance is intentional. Purposes are separated in the hash, so a token minted for one endpoint never validates at the other.
- **Partition and Topic pack ALL message types** — including TM_REQUEST, TM_ERROR, TM_EOF. The earlier "drop control messages" rule broke `request_node`, `send_eof`, attached-mode error responses (TM_COMMAND|TM_ERROR), and the cli's TM_EOF round-trip drain. Data partitions only see TM_BYTESTREAM / TM_STRUCT in practice; allowing other types through is a no-op there and makes IPC work.
- **TM_EOF round-trip drains the cli on stdin close.** Cli emits TM_EOF (FROM=`_output/$pid`); the interpreter it lands on (local in bare mode, the worker's in attached mode) bounces TO=FROM; the cli's Dumper sees the echo and flips the exit flag. Mirrors Tachikoma `FileHandle::handle_EOF` → `send_EOF`. There's a 5s deadline fallback so a dead worker doesn't hang the cli.
- **Don't reintroduce TM_PERSIST.** The removal is intentional. See [ADR-3](docs/architecture-decisions.md#adr-3-fire-and-forget-messaging).
- **Skip readline when STDIN isn't a TTY.** `readline_callback_read_char()` reads from the TTY layer, not the stream descriptor; piping into `wp nodes cli` without the gate burns 100% CPU. Already gated; don't remove.
- **Command_Interpreter_Node only handles TM_COMMAND with empty TO.** Non-empty TO means the message is in transit toward another node — interpreter forwards to Router. If you "fix" interpreter to also dispatch on non-empty TO, every interpreter in a path-routed graph eats commands intended for downstream peers.
- **Verb handlers throw freely; `interpret()` wraps as TM_COMMAND|TM_ERROR.** Don't add per-verb `try/catch` — the central catch is the contract. Keep `return 'error: ...'` only for canonical-OK-shaped argument-validation paths where you want to return without error semantics.
- **Constructors set `$this->arguments` directly.** No `dump_config()` override per class. `dump_config()` reads the field to emit a round-trippable `make_node <type> <name> <args>` line; if you forget to set it, `dump_config` emits without args and the round-trip silently produces a different node.
- **`Log` is a `Partition` subclass — append-only segmented `{file}.{seg}`.** It inherits Partition's segments, monotonic rotation (`segment_size`), three-rule retention (`num_segments` count target / `lifetime` age / `max_segments` hard cap), rotate lock, and the 4KB PIPE_BUF cap — large VALUEs need `void_warranty()`/`allow_large_writes()`. It differs from Partition in three ways: it writes the message **VALUE** (not the packed envelope), lays segments out as `{file}.0`, `{file}.1`, … (no bare `{file}`, no logrotate `.0` shift, no `mode`/`max_size`/`max_rotations`), and its `fill()` drops control messages (`TM_ERROR`/`TM_EOF`/`TM_REQUEST`) instead of packing them — unlike bare Partition/Topic, which pack ALL types. Args: `make_node Log <name> <file> [segment_size] [min_segments] [num_segments] [min_lifetime] [lifetime] [max_segments]`.
- **`Echo` drops TM_ERROR with empty TO.** It would otherwise bounce to a producer that isn't expecting the error trail. If you change Echo's routing rules, preserve the drop.
- **Don't import a `.scss`/`.css` through the `@newspack-nodes/shared/*` alias.** In the shared jest config (`src/build-kit/jest.cjs`, consumed via `createJestConfig` — `jest.config.js` itself has no `moduleNameMapper`) the `^@newspack-nodes/shared/(.*)$` mapper is listed BEFORE the `\.(css|scss)$` style-mock, and first-match wins — so an aliased style import (`@newspack-nodes/shared/styles/x.scss`) resolves to the real file and babel-jest tries to parse SCSS as JS (syntax error) instead of mocking it. Import shared component styles via a RELATIVE path inside the shared component (`./x.scss`), which the style-mock catches. No aliased style import exists today; the consumer (event-logger-nodes) has the identical mapper ordering.

## Local Skills

`.claude/skills/` has substrate-specific skills:
- `nodes-workflow` — implementation workflow (adding Node subclasses, deploying, verifying)
- `nodes-debugging` — REPL, log paths, common runtime failure modes
- `nodes-review` — substrate contract checklist for code review
- `nodes-dashboards` — building a dashboard, inspector, or panel on the substrate

## References

- **Doc map**: `docs/README.md` — the three-bucket reading-order index for the whole `docs/` set (start here, then production, then reference)
- **Architecture**: `docs/architecture-guide.md` (full substrate design — message format, node contracts, drain loop, REPL)
- **Architecture decisions**: `docs/architecture-decisions.md` (the load-bearing ADRs — context, alternatives, reopen conditions)
- **Tutorial track** (the flattened `docs/README.md` order — start-here bucket, then production): `docs/getting-started.md`, then `docs/writing-a-plugin.md`, `docs/writing-a-dashboard.md`, `docs/writing-a-real-plugin.md`, `docs/writing-a-real-dashboard.md`, and `docs/writing-a-view-node.md`
- **API**: `docs/API.md` (REST endpoint reference)
- **CLI**: `docs/cli.md` (every `wp nodes` subcommand and the common flows)
- **Troubleshooting**: `docs/troubleshooting.md` (the REPL, worker health, log paths, the failure modes we hit)
- **Stability**: `docs/stability.md` (the frozen 1.0 surfaces, the deprecation policy, what stays internal) and `docs/upgrading.md` (each breaking change with its fix)
- **Application example**: `../newspack-event-logger-nodes/` — first plugin built on this runtime
- **Walkthrough example (in-repo)**: `examples/example-ai-newsletter/` — a self-contained digest pipeline (`includes/`, `topologies/example-ai-newsletter.tsl`, PHPUnit suite) to learn the substrate from
