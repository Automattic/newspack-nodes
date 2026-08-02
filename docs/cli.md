# CLI Reference

Every substrate command lives under `wp nodes`. This page is the quick reference; each verb's `wp help nodes <verb>` has the authoritative options. Application plugins mount their own verbs under the same namespace (the event-logger adds `reqgrep` and `ruleset-bench`, for example) — those are documented by their plugins.

| Verb | What it does |
|---|---|
| `wp nodes status` (alias `ls`) | Fleet overview: supervisor + every active topology's per-partition state (live/stale/down, heartbeat age, uptime), then the consumer-lag table. `--format=table\|json\|csv\|yaml`. |
| `wp nodes types` | The singleton supervisor, reported separately, plus the active topology groups it will spawn — names, partition counts, stale timeouts, topology paths. The supervisor is a lifecycle target, not a runnable topology. |
| `wp nodes doctor` | Canonical seven-check health report: cache backend, filesystem, ownership, worker liveness, supervisor liveness, consumer lag, and dead letters. Cache is probed in the web runtime; recommendations warn and exit 0, while critical results exit 1. |
| `wp nodes gc [--force]` | Sweep orphan log and offsetlog dirs now, instead of waiting for the supervisor's next config-check tick. A dir is orphaned when no active topology declares it. Spares a dir written in the last hour unless `--force` drops the grace to zero. |
| `wp nodes run <type> [--partition=<N>]` | Run one worker in the foreground (no spawn endpoint) and block until it exits; prints the worker's own exit reason. The debugging tool for "spawns but immediately exits". |
| `wp nodes restart <type\|all> [--partition=<N>]` | Drop worker restart flags; the holders exit cleanly and the supervisor (or self-respawn) starts them fresh. Every partition of the matched type(s) restarts unless `--partition` narrows it. `restart all` means all worker topologies and does not restart the supervisor. |
| `wp nodes restart supervisor` | Request a clean restart of the singleton supervisor. It has no partitions, so partition flags are not accepted. |
| `wp nodes activate <topology>` / `deactivate <topology>` | Add/remove a catalog topology from the active set and spawn/drain its fleet now. Same primitive as the Topologies settings UI. |
| `wp nodes cli [<reader>.p<N>]` | The REPL. Bare (no arg) runs a local interpreter; with a worker id it pivots into that live worker over IPC. Refuses root. See [troubleshooting.md](troubleshooting.md) for the in-REPL verb table. |
| `wp nodes scaffold <plugin\|node\|topology> <name>` | Generate a working starting point: a whole consumer plugin directory, a single Node class, or a `.tsl` topology — the shapes from [writing-a-plugin.md](writing-a-plugin.md). Never overwrites. |
| `wp nodes ingest <topic> [<file>...]` | Replay packed partition-segment records (dead-letter segments included) back through a Topic — re-partitioned by KEY, appended to the destination segments. Omit the file list to read packed records from stdin instead. |

## The common flows

**Is the fleet healthy?**

```bash
wp nodes doctor        # canonical environment + fleet health report
wp nodes status        # detailed fleet and consumer tables
```

**Deploying new worker code** — workers are long-lived processes; the old class stays in memory until they restart:

```bash
wp nodes restart all   # all worker topologies, every partition
wp nodes restart supervisor             # singleton; no partition flags
```

Restarting the supervisor gives it a fresh WordPress bootstrap. Run that command
after all topology-provider plugins have been installed and activated so its
process-local catalog includes the complete plugin set.

**Debugging one worker** — foreground run shows boot errors and the exit reason; the REPL inspects a live graph without disturbing it:

```bash
wp nodes run <type> --partition=0
wp nodes cli <type>.p0
```

**Starting a new consumer plugin:**

```bash
wp nodes scaffold plugin my-pipeline
cd my-pipeline && composer dump-autoload -o
```

**Recovering quarantined messages** — after fixing the poison handler, replay the dead-letter segments (one flat dir per reader under `{base_dir}/deadletter/`, holding `.log` segments directly):

```bash
wp nodes ingest firehose {base_dir}/deadletter/<reader>/*.log
```

`<topic>` is either a bare log name (expanded to `<config:logs_dir>/<name>.p<partition>`) or a full dir-template carrying a `<partition>` token. Omit the file list to pipe packed records on stdin instead — useful with a filtered `wp nodes reqgrep` or `zcat` output. `--dry-run` samples record sizes first and tells you whether you need `--allow_large_writes`.

## Doctor health report

`wp nodes doctor` renders exactly seven canonical rows, in this order:

1. `cache-backend`
2. `filesystem`
3. `ownership`
4. `worker-liveness`
5. `supervisor-liveness`
6. `consumer-lag`
7. `dead-letters`

Each row starts with `ok`, `WARN`, or `FAIL`. A report containing only `ok`
rows exits 0. `WARN` is a recommendation and also exits 0; any `FAIL` is
critical and exits 1.

The cache row comes from a bounded, purpose-HMAC-authenticated loopback request
to the web runtime, not from WP-CLI's separate APCu lifetime. The response is
strictly validated before terminal output. If the loopback result cannot be
verified, doctor reports `WARN` because cache health is unknown; a proven
missing or failed selected backend reports `FAIL`. The other six rows are
evaluated locally from the same canonical evaluator Site Health uses.

WP-Cron configuration is not one of the seven Nodes checks. Nodes reports
actual worker and supervisor liveness instead of treating `DISABLE_WP_CRON` as
a proxy for failure.

## Run-as-user rule

`wp nodes cli` and `wp nodes run` refuse to run as root: workers run as the web user and create their IPC/lock dirs under that ownership, so a root invocation would seed dirs the fleet can't write. Run them as the web user; `wp nodes doctor`'s ownership check tells you if a past root run left bad ownership behind (recovery: `chown -R <webuser>` of the base dir).
