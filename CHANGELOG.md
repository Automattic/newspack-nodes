# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
