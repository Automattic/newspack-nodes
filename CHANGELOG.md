# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.28] - 2026-05-15

### Fixed

- **Operator-selected topologies that aren't in the app's catalog now inherit the substrate's `num_partitions`.** `Bootstrap::get_topologies()` was synthesizing entries for these names with a hardcoded `default_num_partitions=1`, so e.g. a user with `newspack_nodes_num_partitions=2` who checks `aggregator` (commented out of the application's file-default `topologies` list) got `aggregator.p0` only — every other fleet ran p0+p1, but the aggregator's StreamMerger silently dropped partition-1-keyed firehose data. Synthesis now reads `Config::load_config()['num_partitions']` and passes it as the default, so an operator-checked topology sizes to match the rest of the stack.
- **Topology console partition dropdown sizes correctly for non-catalog topologies.** Same fix applied in `Admin::enqueue_topology_console()` — the partition dropdown for TSL files the operator could pick (but the app didn't ship in its catalog) was capped at p0 instead of inheriting the substrate's `num_partitions`.
- **Supervisor stops orphaned workers state-free, in one disk-driven sweep.** Previously: `kill_readers()` flagged workers of removed topology types (driven by an `$active_types` diff in `check_config`), and `cleanup_stale_partitions()` walked `[num_partitions, MAX_PARTITIONS)` for cold-stale dirs only — live workers in dropped partitions / unchecked topologies kept heartbeating forever, and a 2→1 transition that straddled a supervisor respawn boundary was invisible to the diff. Now `reconcile_lock_dirs()` runs every `check_config()` tick: one `glob()` over `{base}/locks/*.lock.d`, then for any dir that doesn't belong in the live fleet (`{type}.p{N}` where N >= per-type partition count, OR type isn't in `$active_types` at all, OR standalone-worker exception) it first attempts cold-removal, then drops a restart flag if the dir is still there. Replaces `cleanup_stale_partitions()` + `cleanup_orphan_type_locks()` + the `kill_readers()` call from `check_config()`; `Supervisor::kill_readers()` remains as a public deactivation-path API.
- **`reconcile_lock_dirs()` skips rewriting an in-flight `restart` flag.** Without the guard, every 15s tick stomped the file in orphan partitions until the worker actually exited — no behavioral impact, just wasted disk churn.

### Changed

- **`wp nodes types` reports the active topology set, not the app's published catalog.** Previously read `apply_filters( 'newspack_nodes/topologies', [] )` directly — so an operator-selected topology not in the app's catalog (e.g. `aggregator` for event-logger-nodes) would appear in `wp nodes ls` as a running worker but be denied by `wp nodes types`. Now reads `Bootstrap::get_topologies()`, matching what the supervisor actually spawns.
- **`Supervisor::fire_and_forget_post()` bypasses `wp_remote_post` for spawn POSTs.** WP's Requests library clamps the timeout at `max($timeout, 1)` second (`Requests/src/Transport/Curl.php:427` — a SIGALRM-resolver guard against curl's synchronous DNS) so a 4-spawn per-tick sweep used to serialize into 4+ seconds of blocked supervisor. The new helper uses raw curl with `CURLOPT_NOSIGNAL=1 + CURLOPT_TIMEOUT_MS=10`, returning in ~10ms regardless of how the spawn endpoint hangs. Tests inject a closure via `Supervisor::$curl_exec` so the existing `$_test_outbound_posts` capture keeps working — production never references that seam.
- **`Cli_Stdin_Reader::install_handler()` / `fire()` route libreadline through a swappable seam.** `Cli_Stdin_Reader::$readline_handler_install` and `$readline_read_char` default to the real libreadline calls; `tests/bootstrap.php` reassigns to no-ops so phpunit-in-a-terminal (where stdin/stdout ARE a tty, so `posix_isatty` gating is useless) doesn't get the prompt written to fd 1 and `readline_callback_read_char` doesn't block on real stdin. Production gates `$has_readline` on `posix_isatty(STDIN)` at the construction site — workers without a real tty never reach the seam at all.

### Removed

- **Substrate `Config` mode dispatching deleted.** `$option_schema_extended` was an empty placeholder after `memcache_servers` moved into core; the per-mode `$config` / `$config_full` cache pair, the `$mode` parameter on `load_config()`, and the `'full'`-only branch in `load_config()` are all gone. Single `$option_schema` array, single cache, single signature. Callers passing `'full'` cleaned up in 4 sites (`Admin`, `Cli_Worker_Command`, `Consumer`, and the app plugin's substrate calls).

### Added

- **`Config::RESET_ACTION` constant + broadcast.** `Config::reset()` now fires `do_action( self::RESET_ACTION )` so dependent Configs (e.g. `Newspack_Event_Logger_Nodes\Config`, which layers app overrides on top of substrate config and maintains its own merged-result static cache) can invalidate alongside us. Without that fan-out, the supervisor's per-tick `check_config()` only cleared the substrate cache, leaving the app's static cache showing stale `num_partitions` — the actual root cause behind the "only aggregator spawns when num_partitions changes" symptom this release fixes upstream.

### Tests

- **`phpunit --enforce-time-limit` is the documented default invocation.** AGENTS.md and the repository's test conventions now flag the flag explicitly. Tests that legitimately sleep through production code (`Lock` orphan grace, `Supervisor` tick_loop) carry class-level `#[Medium]` to raise the limit from 1s to 10s.
- **`$_wp_test_remote_posts` renamed to `$_test_outbound_posts`** — the old name implied the captures came only from `wp_remote_post`, but `Supervisor::$curl_exec`'s capture also writes to it now.

## [0.1.27] - 2026-05-14

### Removed

- **`Config::get_option_schema_core/extended()` filter hooks.** No plugin used `apply_filters( 'newspack_nodes_option_schema_core' )` or `…_extended` to extend the substrate's option schema; both methods are now inline `private static $option_schema_core/extended` arrays. Plugins still extend the application surface via the application's own Config class, just not by filtering the substrate's schema.
- **`Config::invalidate_cache()` and `Config::register_cache_invalidation()`.** The supervisor's `wp_cache_delete( 'alloptions', 'options' )` + `Config::reset()` pair (added in v0.1.25/0.1.26 at the top of every `check_config()` tick) handles option-snapshot staleness for the only consumer that actually needed the one-shot-on-`plugins_loaded` reset. Per-request callers don't have a long enough lifetime to need it.
- **`tests/unit/ConfigTest.php` tests for the removed filters and methods** (−60 lines).

## [0.1.26] - 2026-05-14

### Changed

- **`Core::emit_stderr()` promoted to public `Core::stderr()`.** Same body (re-entry guard + handler dispatch); now callable from anywhere a single line should be visible to the operator without going through the rate-limited `print_less_often` / `print_least_often` paths. Use this instead of bare `\error_log()` so the message routes through `Core::$stderr_handler` (worker → `_repl` conduit → cli session; tests → captured handler).
- **`cmd_log` (the REPL `log <msg>` builtin) routes through `Core::stderr()`.** Previously called `\error_log()` directly, which bypassed the stderr_handler entirely — operators typing `log foo` in a pivoted-cli session got nothing in their terminal because the message landed in PHP's error log, not the `_repl` Partition the cli was tailing. Now visible in the cli where it was issued.
- **`Supervisor` spawn-failure messages route through `Core::stderr()`.** Spawn POST failures (`spawn failed for <type>|<partition>`) and supervisor-respawn failures (`spawn_next_supervisor failed`) previously went to `\error_log()` and disappeared. Now they surface through the same handler chain as every other stderr message.
- **`Config_Utils` validation failures route through `Core::stderr()`.** Path-validation rejections (null byte, non-`.php`, outside allowed dirs) and config-file shape rejections now go through the handler instead of bare `\error_log()` — consistent with the rest of the substrate.

### Fixed

- **`wp nodes cli` (bare mode) now wires up a `_repl` echo node so `Core::stderr()` calls land in the cli session.** Previously the bare cli had no `_repl` registered, so the default stderr handler fell through to `\error_log()` and the operator saw nothing — defeated the purpose of `Core::stderr()` for any in-process diagnostic.

## [0.1.25] - 2026-05-14

### Fixed

- **Supervisor now sees operator option changes within 15s, not 595s.** The supervisor is a long-running PHP process — `wp_load_alloptions()` caches into a static `$alloptions` on first call and never re-reads, so option toggles in admin (`newspack_nodes_topologies`, `enable_logging`, partition counts) had no effect until the supervisor's natural respawn boundary. `check_config()` now drops `wp_cache_delete( 'alloptions', 'options' )` and calls `Config::reset()` at the top of every 15s tick, mirroring the legacy event-logger supervisor's preamble. Topology changes now propagate end-to-end in ≤ 15s (add) / ≤ 75s (remove + ghost cleanup).
- **Orphan-type lock dirs are reaped once the worker exits.** When `kill_readers()` flags a removed-topology worker to exit, the lock dir was lingering on disk forever — `wp nodes ls` and the topology console kept surfacing it as a stale ghost. New `cleanup_orphan_type_locks()` runs on every `check_config()` tick: scans `{base}/locks/*.lock.d`, skips standalone runtime workers and dirs whose type is still in the active set, then `remove_stale_directory()`s any whose heartbeat is older than `Lock::STALE_TIMEOUT` (60s). Live workers are never touched — the heartbeat-cold gate ensures we only collect corpses.

## [0.1.24] - 2026-05-14

### Added

- **DELETE button in the topology console header.** Appears in edit mode only when the currently-edited topology has a user-saved copy (`source: user` or `both` per `/topologies` list). New `DELETE /newspack-nodes/v1/topologies/{name}` endpoint removes the operator-saved file from `{user_dir}/{name}.tsl`; stock copies shipped by plugins are protected (the endpoint returns 404 if asked to delete a stock-only topology). After delete, if a stock fallback exists the topology automatically reverts to it; the success toast says which case happened. Same `save_nonce` permission gate as save.
- **Active topologies sort to the top of the console dropdown.** The supervisor's currently-spawned set (the merged `newspack_nodes/topologies` catalog + `newspack_nodes_topologies` operator overlay) is now grouped first, followed by the rest of `Topology_Registry::list()` alphabetically. New `activeTopologies` field on `window.NewspackNodesData` drives the order.

### Fixed

- **Edit mode renders class labels on node cards.** Live mode reads `n.class` from `dump_metadata` via `parseMetadata`; edit mode reads it from `parseTsl` / `draftGraph`. Both shapes write the same `class` field, but the canvas was reading `n.klass` — which `parseMetadata` had renamed to dodge nothing in particular. Normalized everywhere to `node.class`.
- **`Bootstrap::get_topology_catalog()` is no longer guarded by `class_exists()` from inside the substrate.** Same pattern as the earlier same-plugin guard cleanups: with the classmap autoloader, defending against load-order races for own-plugin classes is dead branch.

### Changed

- **Topology-console partition dropdown enumerates `Topology_Registry::list()`.** Previously sourced from `Bootstrap::get_topology_catalog()`, which only surfaced the app's file-default catalog — operators couldn't select TSL files they hadn't yet checked in the admin UI. Partition counts now come from the catalog when present, else synthesized from each TSL file's frontmatter via `Topology_Registry::synthesize_entry()`.
- **`/topologies` REST endpoint's `active` flag reads `Bootstrap::get_topologies()`.** Previously checked only the app-published catalog filter, so a topology the operator had checked but the app didn't ship in its catalog (e.g. `aggregator`) reported `active: false` despite the supervisor spawning it.

## [0.1.23] - 2026-05-14

### Fixed

- **`Bootstrap::get_topologies()` honors admin-UI topology selections that aren't in the app catalog.** The admin Topologies form renders every TSL file found by `Topology_Registry::list()`, but the bootstrap was intersecting the operator's selections against the app-published catalog from the `newspack_nodes/topologies` filter — silently dropping any name the app hadn't shipped as a file-default. Checking e.g. `aggregator` in the admin UI saved the option but the supervisor never spawned a worker for it. The bootstrap now falls back to `Topology_Registry` for selections not in the catalog, synthesizing an entry from the TSL frontmatter. Names that don't resolve to a TSL file are still dropped (typos / stale option values can't crash the supervisor).

### Added

- **`Topology_Registry::synthesize_entry( $name, $default_num_partitions, $default_stale_timeout )` helper.** Public, returns the same `{topology, num_partitions, stale_timeout}` shape the application's `newspack_nodes/topologies` filter callback was building inline. Applications can now call this from their filter instead of duplicating the frontmatter-read + shape-build logic.

### Changed

- Drops three `class_exists()` guards on same-plugin classes (`Topology_Registry` in admin × 2, `Config` in worker-cli-command). With the classmap autoloader, these defended against load-order races that can't happen.

## [0.1.22] - 2026-05-14

### Fixed

- **`build-release.sh` now runs `npm run build` before staging.** v0.1.21 shipped without `build/topology-console/` because the release script only ran `composer install` and rsynced whatever happened to be on disk — so if the developer hadn't built bundles locally before tagging, the zip carried no React tree. The substrate's admin enqueue then silently bails on the missing `index.asset.php` and the topology console renders an empty mount div. The release script now always builds bundles before rsync.

## [0.1.21] - 2026-05-14

### Fixed

- **Inspector renders `bool` ctor/verb args as text inputs.** Bool args were native checkboxes, which couldn't hold a substitution token like `<config:enable_aggregator>` — forcing operators to hand-edit TSL whenever a bool needed to come from config. Now they're text inputs with a `true | false | <config:...>` placeholder hint; the TSL loader / verb handler does the string→bool coercion at runtime, exactly as int and string args already do. Legacy stored boolean values (from the old checkbox UI) are stringified to `"true"`/`"false"` on render so existing layouts round-trip cleanly.

## [0.1.20] - 2026-05-14

### Changed

- **Substrate owns the `newspack_nodes_topologies` operator overlay.** `Bootstrap::get_topologies()` reads the `newspack_nodes/topologies` filter as a file-default catalog (what the application publishes), then applies the `newspack_nodes_topologies` WP-option overlay itself: `false` (never saved) → full catalog, `[]` → empty, array → intersection. New `Bootstrap::get_topology_catalog()` returns the unfiltered catalog for admin UI rendering. Previously, applications duplicated `get_option` logic inside their `newspack_nodes/topologies` filter callback — the substrate is the right place for substrate options.
- **Admin Topologies checkbox list + `↺` Load Defaults chip both read `Bootstrap::get_topology_catalog()`.** Single source of truth for what the application ships in its config file. Removes the parallel `newspack_nodes/topologies_defaults` filter that briefly existed for the chip.

## [0.1.19] - 2026-05-14

### Added

- **Topology console: save / reset layout.** Layouts decouple from topologies — TSL describes graph structure; the `.layout` file describes node positions, stored server-side at `{base_directory}/layouts/{name}.layout` via a new `LayoutsController` (GET/POST `/newspack-nodes/v1/layouts/{name}`) with a dedicated `newspack_nodes_save_layout` nonce. Save Layout (edit-mode only) persists the current pinned positions; Reset Layout shows when current ≠ default for the mode — in edit it clears overrides to `autoLayout` (with confirm modal), in live it reverts to the saved layout. Mode-transition auto-fit fires when re-entering live mode from a different topology or from a fresh reset, batching positionOverrides + viewport=null so the canvas's autofit-commit hook fires on the rebuilt bbox in one render.
- **Node schemas exposed for the Inspector.** `Topic`, `Log`, `Tail`, `Consumer`, `Hook` now declare their constructor arguments via `node_schema()`, so the topology console renders an editable form for each. `Log` adds the `rotate` verb. `Callback` and `Lock` flip to `category: 'Hidden'` — Callback wraps a PHP closure that can't be expressed in TSL or constructed from the GUI; Lock is an internal primitive used by `Partition::allow_large_writes()` and Worker lifecycle, not meaningful as a standalone graph node.
- **Topology admin UI mirrors the resolved fleet.** When `newspack_nodes_topologies` is unset (`get_option` returns `false`), the checkboxes pre-check the resolved `newspack_nodes/topologies` filter so an operator visiting a fresh install sees what's actually running. Once they save once, the option becomes authoritative (including `[]` = explicit "spawn nothing").
- **`<config:offsets_dir>` helper.** `WorkerCliCommand` now derives `offsets_dir` alongside `logs_dir` from `base_directory`, so TSL can reference `<config:offsets_dir>` directly instead of building `<config:base_directory>/offsets/...` inline.

### Changed

- **`Newspack_Nodes\Config_Utils` owns the sanitize / validate / path-guard primitives** every plugin's Config previously duplicated. Methods are public + static so tests call them directly. Substrate `Config` shrinks from 691 → 478 lines by delegating; the moved methods (`sanitize_option`, `sanitize_string`, `is_within`, `validate_config_values`, `load_config_file`) are gone from Config itself. `validate_config_path` stays on Config as a thin wrapper that injects its allowed-dirs list before delegating to Config_Utils.
- **`newspack-nodes-config.php` declares `base_directory` explicitly** instead of relying on the hardcoded `/tmp/newspack-nodes` fallback inside `Config::load_config_defaults()`. The fallback is gone — the config file is now the only source of the default.

## [0.1.18] - 2026-05-13

### Added

- **More `set_state()` coverage** so `debug_state <node> 1` produces a meaningful trace of failure modes and lifecycle moments instead of being effectively silent:
  - **`Router::fill`** — `NOT_AVAILABLE` set_state when a routed path's leading segment doesn't resolve to a node. `debug_state _router 1` turns "why isn't my message landing?" debugging from a guessing game into a per-failure trace.
  - **`Partition::fill`** — `DROPPED` set_state with `reason=oversize`, size, and max when a packed message exceeds `MAX_LINE_SIZE`/`MAX_LARGE_LINE_SIZE`. The most common "where did my message go?" mystery — the silent drop — is now visible.
  - **`Consumer::poll`** — `OVERFLOW` set_state with seg/off/limit when the DoS line-buffer guard fires. Mirrors the existing `print_less_often` stderr emission so debug_state observers see the same event.
  - **`Log::rotate`** — `ROTATED` set_state with the new rotated filename.
  - **`Log::prune_rotated`** — `PRUNED` set_state with the count of rotated files unlinked (only when something was actually pruned).
  - **`Echo::fill`** — `DROPPED_ERROR` set_state with the originating FROM when a TM_ERROR with empty TO is dropped (avoids bouncing the error trail to an unsuspecting producer).

## [0.1.17] - 2026-05-13

### Fixed

- **Partition was missing `largest_msg_sent` tracking.** Its `fill()` override (writes the packed message to disk) skipped the base `Node::fill()`'s `largest_msg_sent` update, so `stats` and `dump_metadata` reported 0 for every Partition. Now mirrors Node's tracking — measures `Message::value_size()` and updates `$largest_msg_sent` if the new size exceeds the previous max.

- **Consumer was missing `bytes_read` tracking.** Consumer's `poll()` reads bytes via `$this->source->read_at()`, which incremented the source Partition's `bytes_read` but not the Consumer's. Stats showed `read=0` for every Consumer despite Consumers being the user-facing read nodes. Now both increment in parallel: the Partition tracks file-system read volume; the Consumer tracks what surfaces in `stats`.

- **`cmd_uptime` was using `\date()`** for the clock segment, which the `WordPress.DateTime.RestrictedFunctions.date_date` PHPCS rule rightly flags as runtime-timezone-dependent. Switched to `\gmdate()` — UTC is more predictable across worker environments anyway, and the test suite doesn't assert on the clock portion so semantics are preserved.

### Chores

- **Locked `brainmaestro/composer-git-hooks` in `composer.lock`.** The dep was already declared in `require-dev` + `extra.hooks` config, but the lock file was never updated. `composer install --no-dev` (build path) short-circuits the post-install cghooks installer, so a regular `composer install` is the only path that wires `.git/hooks/pre-push`. Locking makes that one-shot setup deterministic.

## [0.1.16] - 2026-05-13

### Added

- **`dump_metadata` verb** — single JSON-encoded snapshot of every registered node's GUI-relevant state: `{ class, counter, sink, target, debug_state, arguments, lgst_msg, bytes_read, bytes_written }` per node. Designed for the topology console's per-tick poll (replaces the older `ls -als` + `ls -ct` pair); KEY-correlation through `Message::KEY` lets the controller distinguish auto-polls from user-typed commands silently. Inspired by Perl Tachikoma's `JSONvisualizer` node, but as a verb so it composes with the rest of the cli surface and skips the visualizer's caching layer (our poll cadence is already coarse).

- **`stats [-a] [<regex>]` verb** — Tachikoma-style tabular per-node counters with columns `NAME | COUNT | LGST_MSG | READ | WRITTEN`. Scope rules match `ls`: default shows siblings of this CI; `-a` shows every node; optional regex narrows by name. Dropped Tachikoma's `BUF_SIZE` and `HIGH_WATER` columns since we have no in-memory message buffers (Partition and Topic flush every fill into a per-node line buffer that drains synchronously).

- **`uptime` verb** — clock time on the left, time-since-`Core::reset()` on the right. Scale-aware compact format suited to our short-lived workers (~10 min lifespan): `up 42s` → `up 4m 07s` → `up 2h 35m` → `up 3d 04:05:06`. Trailing components zero-pad to two digits so the value width stays steady tick-to-tick.

- **`Core::$init_time`** — process start time, stamped at every `Core::reset()` (worker bootstrap, test setUp). `uptime` subtracts this from `Core::$now`.

- **Per-node observability counters on `Node` base.** `largest_msg_sent` (bytes, updated by `fill()`) plus `bytes_read` / `bytes_written` (populated by I/O nodes — Partition increments them in `loop_fwrite` and `read_at`; logic nodes leave them at 0). Tachikoma-equivalent of `$node->{largest_msg_sent}` / `bytes_read` / `bytes_written`. Surfaced by `stats` and `dump_metadata` alike.

- **`Message::value_size()`** — bytes of the VALUE field (strlen for strings, `wp_json_encode` length for arrays). Used by `Node::fill()` to track `largest_msg_sent` consistently across TM_BYTESTREAM and TM_STRUCT shapes.

- **`connect_node <node>` / `disconnect_node <node>` (no target) default to `$message[FROM]`.** Matches Perl Tachikoma: a `connect_node firehose:tee` from a cli/SSE session tees the node's output back to that session's Dumper without having to know the breadcrumb path. Stale targets self-clear when the worker recycles (~10 min in this deployment), so the lack of an explicit disconnect-on-exit signal isn't a real liability. Symmetric `disconnect_node <node>` (no target) removes the issuing message's FROM from a Tee's fan-out, exactly undoing a default `connect_node <tee>`.

### Fixed

- **`Tee::fill` was pruning path-shaped targets** (`_repl/_output/{pid}` and other slash-containing values). `connect_node firehose:tee` from a SSE session would report `ok`, the target would be added, then the very next `fill()` would drop it because `Core::node('_repl/_output/{pid}')` returned null. Now the path-shape check (`strpos === '/'`) skips the existence-lookup for path targets — they survive until the Router fails to deliver to the prefix, at which point normal error semantics apply.

## [0.1.15] - 2026-05-13

### Added

- **`CommandInterpreter` echoes `Message::KEY` from request onto its `TM_RESPONSE` / `TM_COMMAND|TM_ERROR`.** KEY is application-defined correlation metadata that now survives the round trip — a GUI client (the new event-logger-nodes Topology Console is the first consumer) can stamp `KEY='gui:auto'` on its own automated polls and recognize them on the way back without tracking IDs by hand or adding a TM_NOREPLY-style bitflag. Empty KEY (the cli's default) is unaffected.

### Fixed

- **Cli prompt no longer pollutes phpunit output.** `Cli_Stdin_Reader::show_prompt_fallback()` was writing directly to `\STDOUT` via `fwrite`, bypassing the Dumper's injectable stdout stream. Every CliCommandTest that constructed a `Cli_Stdin_Reader` in non-readline mode with the default `show_prompts=true` (a half-dozen cases) spat `newspack-nodes> ` straight at phpunit's real stdout, producing the `newspack-nodes> newspack-nodes> .test-prompt> ...` litter mid-progress-dots. Routed through a new `Dumper::write_prompt( string $prompt )` method instead — same `fwrite` semantics, but to the Dumper's owned `$stdout` resource which tests can swap for `php://memory`. The `mark_prompt_displayed()` side-effect folds into `write_prompt()` so the call site is one method instead of fwrite+mark.

- **`Core::emit_stderr()` is now re-entrant safe.** The default handler routes through a `_repl` Partition; if a fault inside that path (Partition write failure, Router throw, a node's `fill()` rate-limit-logging its own error) calls back into `print_less_often`, the dispatcher used to recurse straight through the handler — stack-overflowing or deadlocking depending on what the inner call touched. Custom handlers set via `set_stderr_handler()` could recurse the same way. Now guarded at the dispatcher: a re-entry falls back to PHP's `\error_log()` (the same last-resort sink the default handler already uses when `_repl` isn't wired up), the flag is reset in `finally` so a throwing handler doesn't permanently latch the diverter, and `Core::reset()` clears it for tests.

## [0.1.14] - 2026-05-13

### Fixed

- **Consumer was overwriting `Message::KEY` with `"{seg}:{abs_offset}"`, destroying the producer's routing key.** After v0.2.17 of `newspack-event-logger-nodes` moved `rid` from inside the entry to `Message::KEY` (so partitions co-locate by request), Consumer's overwrite turned every entry's KEY into a unique segment:offset string before it reached downstream nodes. RequestBuilder's BC fallback to KEY then returned `"12:35296133"` instead of the rid, and every entry's "rid" was different — the request cache never aggregated entries by rid, so no request ever assembled and `requests.log` stayed empty for any request that went through the firehose-workers pipeline. The same overwrite would have silently misrouted any multi-partition job queue keyed on `handler` whenever Consumer's output fed back into a partition-routing Topic.

  Position breadcrumb moves to `Message::ID` (matching Perl Tachikoma's convention — KEY is the producer's routing key, ID is per-message position / correlation). Consumer preserves the producer's KEY untouched. Offsetlog continues to checkpoint by `{seg, off}` struct in VALUE, unaffected.

## [0.1.13] - 2026-05-12

### Added

- **Substrate Node subclasses now emit `set_state` traces at natural state-transition points.** Combined with 0.1.11's per-node `debug_state` flag, this turns the substrate into a self-narrating instrument when tracing is enabled.

  - `Partition::do_rotate()` → `set_state('SEGMENT', $current_segment_id)` when a rotation lands.
  - `Partition::cleanup_segments()` → `set_state('CLEANUP', ['deleted'=>N,'alive'=>K])` only when retention actually removed segments.
  - `Consumer::poll()` → `set_state('SEGMENT', $cursor_seg)` when the cursor crosses into a new segment.
  - `Consumer::checkpoint()` → `set_state('CHECKPOINT', ['seg'=>X,'off'=>Y])` after a successful offsetlog commit (gated by the existing "skip if cursor hasn't advanced" check, so this only fires on real progress).
  - `Consumer::is_caught_up()` → `set_state('CAUGHT_UP', bool)` on transition only (tracks the last emitted boolean and fires only when it flips, so no churn from per-poll evaluations).
  - `Tail::poll()` → `set_state('ROTATED', ['inode'=>N])` on file-inode change, `set_state('TRUNCATED', ['size'=>N])` when the file shrinks.
  - `Tee::connect_node()` / `disconnect_node()` → `set_state('TARGETS', $list)` when the target set changes.
  - `Lock::acquire()` → `set_state('HELD', ['path'=>$p,'stolen'=>bool])` on successful acquire (stolen=true distinguishes orphan/stale takeover from a clean acquire). `Lock::release()` → `set_state('HELD', ['path'=>$p,'released'=>true])`.

  Each transition is selected to represent a genuine durable state change, not a high-frequency tick — `Timer::set_timer()` is NOT instrumented because `Consumer`/`Tail` re-arm via `set_timer(N, true)` on every poll cycle, which would make ARMED traces a hot path. Notify-only events (Router TIMER ticks, Timer FIRE) remain notify-only by design.

  All transitions ride the existing `Node::set_state()` → `emit_debug_state_trace()` path: a TM_STRUCT addressed to `TO=_repl`, payload `{k:'debug_state', node, class, event, value}`. Visible in any `wp nodes cli` session and the future SSE controller without further plumbing.

## [0.1.12] - 2026-05-12

### Added

- **`Core::$stderr_handler` defaults to routing through the worker's `_repl` conduit when one is registered.** Stderr-style diagnostics (`print_less_often`, `print_least_often`, `print_now_and_then`) build a TM_BYTESTREAM addressed `TO=_repl` and fill the worker-side `_repl` node directly. `_router` peels the prefix; downstream cli/SSE readers see the message with empty TO, which the Dumper always renders — unaddressed broadcast, no `show_sse` opt-in needed. Falls back to PHP's `error_log()` when there's no `_repl` (request scope, tests, CLI tools). Tests can override via `Core::set_stderr_handler()` as before.

### Changed

- **`Node::set_state()` traces and `Core::$stderr_handler` both address `TO=_repl`** (was `_repl/sse` in 0.1.11 for traces). Matches Perl Tachikoma exactly: stderr and state transitions are alarm-style broadcasts — always visible to cli sessions and the SSE controller, no opt-in gating. `show_sse` remains for genuinely opt-in observability streams (the upcoming periodic stats emitter etc.) where the user explicitly chooses to consume an additional channel.

  The `Node::emit_debug_state_trace()` routing path is unchanged otherwise — still routes via `Core::node('_router')->fill()`; still safe no-op when `_router` isn't registered.

## [0.1.11] - 2026-05-12

### Added

- **`Node::$debug_state` per-node state-tracing dial** + matching `Node::debug_state( ?int $level = null )` accessor. Mirrors Perl Tachikoma `Tachikoma::Node`'s `$self->{debug_state}`. When > 0, `set_state()` additionally emits a TM_STRUCT trace addressed to `TO=_repl/sse` so cli sessions (with `show_sse` on, from 0.1.8) and the SSE controller both see state transitions in real time. The trace doesn't replace the normal `notify()` — that still fires for registered listeners. Trace is purely additive observability.

  Trace payload shape:
  ```php
  [
    'k'     => 'debug_state',
    'node'  => '<this node name>',
    'class' => '<FQCN>',
    'event' => '<event name passed to set_state>',
    'value' => <payload>,
  ]
  ```

  Emission routes via `Core::node('_router')->fill()` so workers without wired sink chains still get the trace through. Safe no-op when `_router` isn't registered (e.g. unit tests constructing nodes in isolation).

- **`debug_state [ <node name> [ <level> ] ]` CommandInterpreter verb.** Mirrors Perl Tachikoma:
    - `debug_state` (no args) — toggle this CommandInterpreter's own debug_state.
    - `debug_state 1` (numeric arg only) — set this CI to level 1.
    - `debug_state foo` (name only) — toggle node `foo`'s debug_state.
    - `debug_state foo 2` (name + level) — set node `foo`'s debug_state to level 2.
- **`CommandInterpreter::make_node()` propagates the CI's `debug_state` to newly-created children.** Lets the operator turn tracing on for an entire topology in one command: `debug_state 1` then `make_node` for each node — every constructed node inherits level 1 from birth. Mirrors Perl Tachikoma CommandInterpreter.pm which assigns `$node->debug_state( $self->debug_state )` after every node creation.

  Combined with 0.1.8's `show_sse` and 0.1.10's `debug_level` cleanup, a cli session can now narrate the worker's internals at multiple levels of detail and addressing:

  ```
  firehose-workers.p0> show_sse
  show_sse: on
  firehose-workers.p0> debug_state job-router 1
  job-router debug_state: 1
  firehose-workers.p0>                                # idle...
  # then a state transition on job-router fires:
  {"k":"debug_state","node":"job-router","class":"…","event":"BACKPRESSURE","value":42}
  ```

## [0.1.10] - 2026-05-12

### Changed

- **`debug_level 1` now prepends the header and falls through to the normal renderer** instead of replacing it. The unwrapping that `TM_COMMAND|TM_RESPONSE` does (decode the JSON envelope, write just the inner `payload`) still happens — the user sees the type/from header followed by the friendly unwrapped output, not the raw JSON envelope. Mirrors Perl Tachikoma where `dump_response` runs BEFORE `dump_message`. Level 2 still replaces the render entirely with the structural envelope dump.

  Before:
  ```
  TM_COMMAND | TM_RESPONSE from _command_interpreter:
  {"name":"ls","payload":"_repl\nerrors:partition\n…"}
  ```

  After:
  ```
  TM_COMMAND | TM_RESPONSE from _command_interpreter:
  _repl
  errors:partition
  …
  ```

## [0.1.9] - 2026-05-12

### Changed

- **`debug_level >= 1` now REPLACES the normal render instead of stacking with it.** 0.1.8 emitted a one-line header to stderr in addition to the normal stdout render — left the user reading both copies of the value. Now mirrors Perl Tachikoma Dumper.pm exactly: the dump rewrites what gets rendered, no double output.
- **Level 2 is a structural multi-line envelope dump** instead of a flat key=value header. Each envelope field on its own line, type flags rendered by name with `' | '` separator, timestamp humanized (`1700000000 (2023-11-14 22:13:20 UTC)`), value either pretty-printed JSON (for TM_STRUCT arrays) or — for TM_COMMAND envelopes — the decoded inner command unwrapped as a nested JSON block. Matches the readability of Perl's `Data::Dumper` output of `$message->as_string`.

  ```
  Message {
      type:      TM_COMMAND | TM_RESPONSE
      from:      _command_interpreter
      to:        450
      id:        1778641673:0000000003
      key:
      timestamp: 1778641673 (2026-05-12 03:01:13 UTC)
      value:     {
                     "name": "ls",
                     "arguments": "",
                     "payload": "COUNT NAME                 TARGET\n…"
                 }
  }
  ```

  Field labelled `value:` (matches `Message::VALUE`). The inner Tachikoma::Command keys keep their canonical `name`/`arguments`/`payload` names — those describe the Command shape, not the envelope slot.

## [0.1.8] - 2026-05-12

### Added

- **`show_sse` Shell builtin** — toggles the local Dumper's broadcast-filter opt-in for `TO=sse` traffic. The worker side will fan stats / `debug_state` events out as TM_STRUCT addressed to `_repl/sse`; the worker-side `_router` peels `_repl`, so each cli/SSE reader sees bare `TO=sse` arriving at its Dumper. By default the Dumper drops it (not addressed to the session's `$pid`). After `show_sse`, those messages render alongside personal replies. Pure toggle — no arguments — mirroring Perl Tachikoma's builtin convention.

  Underlying API: `Dumper::toggle_broadcast_filter( $name, ?bool $explicit = null )` and `Dumper::broadcast_filter_enabled( $name )`. Set-of-strings storage so future broadcast addresses can opt in without redesign.

- **`debug_level [<n>]` Shell builtin** — set or toggle the local Dumper's render verbosity. With no args, toggles between 0 and 1 (matching Perl Tachikoma semantics). With a numeric arg, sets explicitly (clamped to 0..2). Levels:
    - 0 — default curated rendering
    - 1 — additionally emit a one-line debug header per Message to stderr: `<TM_FLAGS> from <FROM>: <stringified-payload>`. Every Message that reaches the Dumper, including control messages the normal renderer would silence
    - 2 — same as 1, but the header is the full envelope: `<TM_FLAGS> id=<ID> stream=<STREAM> from=<FROM> to=<TO> ts=<TIMESTAMP>` followed by the payload on the next line.

  The normal render still happens after the debug header — level 1/2 additively narrate without replacing user-friendly output. Header goes to stderr so `wp nodes cli ... | grep foo` on stdout is unaffected.

- **`show_parse` Shell builtin** — toggle dumping of the post-interpolation line and tokenized form to `$output_stream` for every subsequent `parse()` call. Mirrors Perl Tachikoma Shell3 `show_parse`; useful when interpolation or tokenization quirks need a microscope. Local-only — no IPC, no worker involvement. Pure toggle.

  Distinct from `debug_level`: `show_parse` is about the parser (what tokens did I see for this line); `debug_level` is about the Dumper (how verbosely should I render messages that arrive). The two stack — `show_parse` + `debug_level 1` shows both ends of the REPL pipeline at once.

## [0.1.7] - 2026-05-12

### Changed

- **Supervisor no longer runs when no topologies are registered.** `Bootstrap::run_supervisor_tick()` now returns early if `Bootstrap::expand_workers()` is empty (every topology gated off, no application registered any, etc.) — the supervisor's 595s tick loop, its heartbeat, the `supervisor_periodic` hook, and the self-respawn chain are all pointless work when there are no workers to spawn or to consume the periodic-hook output. `Supervisor::check_config()` also exits the loop when topologies disappear mid-run (e.g. operator flips a gate off), so a running supervisor winds down on its next 15s config window instead of finishing its full 595s.

  The cron stays scheduled — minute-cadence no-op ticks are cheap, and unscheduling would require plugin re-activation to re-arm once the operator flips a gate back on. The next tick after gates return picks up the new topology fleet automatically.

## [0.1.6] - 2026-05-12

### Added

- **`newspack_nodes/before_supervisor_run` / `newspack_nodes/after_supervisor_run` actions** wrap the call to `Supervisor::run()` from `Bootstrap::run_supervisor_tick()`, giving application layers a hook point to swap request context around the 595s tick. `run_supervisor_tick()` also now sets `$_SERVER['NEWSPACK_NODES_WORKER_TYPE']='supervisor'` (and `..._PARTITION='0'`) BEFORE firing the wrapping action, so the listener observes the env var when it inits its per-job LogManager. Without this, the cron-backstop path (WP-Cron fires `newspack_nodes/supervisor` inside a regular `/wp-cron.php` request, supervisor sets the env var late from inside `run()` after LogManager has already captured `process (start)`) logged a 595s `/wp-cron.php` request that was missing `worker_type` and counted toward global averages. The self-respawn path was unaffected (its REQUEST_URI matches `skip_urls`). The env-var assignment inside `Supervisor::run()` itself is preserved as a defensive baseline for callers that invoke `run()` outside the cron path.

## [0.1.5] - 2026-05-12

### Removed

- **`Node::$edge` and `edge()` getter/setter.** The field had no readers or writers anywhere in the substrate or any application Node subclass — pure dead infrastructure. Removed from `Node`'s declared properties, its remove_node cleanup, the CommandInterpreter's `ls -e` flag and `EDGE` column, the `dump` reflection's edge-to-name collapse, and the `ARCHITECTURE.md` Node-class snippet.

### Changed

- **`ls` flag rename: `-o owner` → `-t target`.** The column was labeled `OWNER` but `Node::$target` has always been called "target" in the field declaration and getter — the `ls` UI was the only place that called it "owner". Renamed for consistency. `-l` now expands to `-ct` (was `-co`). `OWNER` column header → `TARGET`.

## [0.1.4] - 2026-05-12

### Changed

- **`Core::print_least_often` now uses a real 60s window.** The docstring claimed "300s" but the implementation had no time gate at all — once it emitted at the 10th hit, `emitted=true` stuck for the rest of the process lifetime, giving at most one stderr line per worker (workers live ~10 min). The function now emits on the 10th occurrence within a window, then suppresses for 60s before re-arming. Matches `print_less_often`'s windowed pattern with the 10-hit threshold preserved.
- **ARCHITECTURE.md scrubbed of out-of-substrate references.** Removed mentions of the legacy inspiration framework, application-side class names (consuming-plugin territory), `TM_PERSIST` (a flag this codebase doesn't define), and a "Tee aggregating responses" reverse-routing case that Tee doesn't actually do. Substrate doc now uses substrate-only vocabulary.
- **ARCHITECTURE.md batching section accurate.** The stale "No batching in v1, LogManager handles it" lines replaced with a description of the actual in-Partition `$batch` accumulator + size-threshold flush + 0-delay timer-driven drain pattern. `Topic::flush()` documented as the request-scope drain entry point for callers handing off to a subprocess.

## [0.1.3] - 2026-05-11

### Removed

- **`newspack_nodes/base_dir` filter.** Bootstrap, the CLI commands, and `Config::load_config_defaults` all now read `base_directory` straight from the config file (with WP-option overlay where the schema applies). The filter was a stale extension point with no production consumers — its only callers were tests using it as an injection hook, and the production path through Bootstrap was silently picking up the filter default (`/tmp/newspack-nodes`) instead of the substrate config file's value, causing workers and dashboards to land on different on-disk paths. Tests switch to `TestCase::use_base_dir($dir)` (writes a per-test config file, sets `LOCAL_NEWSPACK_NODES_CONF`, resets Config), mirroring the legacy `newspack-event-logger-plugins` pattern.

### Added

- **Permanent test config baseline** at `tests/newspack-nodes-test-config.php`, wired via `LOCAL_NEWSPACK_NODES_CONF` in both `phpunit.xml` and `tests/bootstrap.php`. Matches legacy `tests/event-logger-test-config.php` shape.

### Changed

- **Consumer's memcache position key now includes the hostname.** Format is now `np:pos:{hostname}:{source_base_dir}:p{N}` (was `np:pos:{source_base_dir}:p{N}`). Shared-memcache deployments where multiple hosts have the same on-disk `{base_dir}` (render1/render2/hub all using `/volumes/pyrobase/tmp/newspack-nodes/...`) no longer overwrite each other's live cursor entries. Reader side updated in lockstep.

### Fixed

- **`_router` was never started, so the Router-hitchhike TIMER pattern was dead in workers.** `WorkerBase::build_scaffolding()` constructed `_router` (a `Timer` subclass) but never called `set_timer()` on it, leaving `active=false` and `fire_count=0`. Any node that did `$router->register('TIMER', $name)` got the registration recorded but no `notify('TIMER',...)` ever fired — the keepalive / housekeeping ticks they depended on silently never ran. WorkerBase now calls `$router->set_timer( Router::DEFAULT_TICK_MS )` right after naming it. (CLI command path in `class-cli-command.php` constructs its own router for the bare-mode REPL and has no hitchhikers, so left alone.)

## [0.1.2] - 2026-05-11

### Changed

- Plugin entry now uses a Composer classmap autoloader instead of a hand-maintained `require_once` chain. `composer.json` declares `"autoload": { "classmap": [ "includes/" ] }`; `composer install --no-dev --optimize-autoloader` (already run by `build-release.sh`) generates the FQCN → path map. Classes load on first reference; requests that don't touch worker / admin / CLI code don't pay for it.
- ARCHITECTURE.md: new dedicated `## Lock` section covering mkdir+heartbeat atomicity, PID stamping, stale takeover, and `should_restart()` / `request_restart_at()`.

### Fixed

- `Cli_Stdin_Reader::fire()`: suppress the companion `E_WARNING` PHP raises alongside the `ValueError` on un-selectable streams (e.g. `php://memory` in tests). The `catch` block already handles the failure path; the warning was just noise in `phpunit --display-warnings`.
- `SmokeTest`: version-constant assertion uses a regex match so version bumps don't require a test edit.

## [0.1.1] - 2026-05-11

### Fixed

- `Cli_Stdin_Reader`: gate `readline_callback_read_char()` with a zero-timeout `stream_select()` so the readline path doesn't block the drain loop on a TTY with no pending input. The legacy stream_select-driven loop gated this externally; after the FD-machinery removal in 0.1.0 every `fire()` tick called `readline_callback_read_char()` unconditionally, which blocked inside `read()` until the user typed again — stalling the loop and preventing Consumer/Tail timers from firing. Symptom in pivoted-cli mode: the worker's response to a command didn't render until the user pressed an extra key.
- Rearm cadence: any successful stream-select-ready tick now picks `BUSY_POLL_MS=0` so the kernel input buffer drains on consecutive zero-delay ticks. Without this, interactive typing crawled at 1 char per `IDLE_POLL_MS` (100ms).

## [0.1.0] - 2026-05-10

### Added

- Initial public release. Tachikoma-inspired message-passing runtime for PHP/WordPress.
  Provides the substrate that `newspack-event-logger-nodes` (and future applications) compose on top of.
  - `Node` base contract: every node honors `fill( array &$message ): void`.
  - 7-field positional `Message` (TYPE, TIMESTAMP, FROM, TO, ID, KEY, VALUE) with packed JSON wire format.
  - `Router` — path-based dispatch by TO.
  - `Topic` / `Partition` / `Consumer` — append-only log storage with CRC32-keyed partition routing; PIPE_BUF (4KB) atomic-append discipline with opt-in `allow_large_writes()` for >4KB payloads.
  - `Tail` / `Log` — segmented log rotation and tailing.
  - `WorkerBase` / `Supervisor` — long-lived workers spawned via HMAC-validated REST endpoint; two-tier safety net (worker self-respawn + supervisor force-spawn + WP-Cron supervisor recovery).
  - `Lock` — mkdir-based advisory locking with PID heartbeat and stale-takeover.
  - `Shell` / `CommandInterpreter` / `Dumper` — REPL primitives.
  - `wp nodes` CLI (`ls`, `cli`, `types`, `run`, `restart`, `status`).
  - `EventFramework` drain loop (timer + curl_multi_select); no FD-registration machinery — stdin is driven by a Timer-subclass reader.
  - `Tee` / `Echo` / `Callback` / `Hook` / `Timer` — generic node primitives.
