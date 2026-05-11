# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
