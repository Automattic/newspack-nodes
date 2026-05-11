# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
