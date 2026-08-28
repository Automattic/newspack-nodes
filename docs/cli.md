# CLI Reference

Every substrate command lives under `wp nodes`. This page is the quick reference; each verb's `wp help nodes <verb>` has the authoritative options. Application plugins mount their own verbs under the same namespace (the event-logger adds `reqgrep` and `ruleset-bench`, for example) — those are documented by their plugins.

| Verb | What it does |
|---|---|
| `wp nodes status` (alias `ls`) | Fleet overview: every active topology's per-partition state (live/stale/down, heartbeat age, uptime), then the consumer-lag table. `--format=table\|json\|csv\|yaml`. |
| `wp nodes types` | The active topology groups the fleet spawns — names, partition counts, stale timeouts, topology paths. |
| `wp nodes doctor` | Canonical seven-check health report: cache backend, filesystem, ownership, housekeeping, worker liveness, consumer lag, and dead letters. Cache is probed in the web runtime; recommendations warn and exit 0, while critical results exit 1. |
| `wp nodes gc [--force]` | Sweep orphan log and offsetlog dirs now, instead of waiting for the next reconciliation pass. A dir is orphaned when no active topology declares it. Spares a dir written in the last hour unless `--force` drops the grace to zero. |
| `wp nodes run <type> [--partition=<N>]` | Run one worker in the foreground (no spawn endpoint) and block until it exits; prints the worker's own exit reason. The debugging tool for "spawns but immediately exits". |
| `wp nodes restart <type\|all> [--partition=<N>]` | Drop worker restart flags; the holders exit cleanly and their self-respawn starts them fresh. Every partition of the matched type(s) restarts unless `--partition` narrows it. |
| `wp nodes stop [--timeout=<s>]` | Hold the fleet down for a deploy: refuse every spawn path, ask each worker to exit, then block until every lock dir is gone. Exits non-zero naming the workers still holding locks if the wait expires. The hold persists until `wp nodes start`. |
| `wp nodes start` | Release the hold and spawn the fleet. |
| `wp nodes activate <topology>` / `deactivate <topology>` | Add/remove a catalog topology from the active set and spawn/drain its fleet now. Same primitive as the Topologies settings UI. |
| `wp nodes cli [<reader>.p<N>]` | The REPL. Bare (no arg) runs a local interpreter; with a worker id it pivots into that live worker over IPC. Refuses root. See [troubleshooting.md](troubleshooting.md) for the in-REPL verb table. |
| `wp nodes scaffold <plugin\|node\|topology> <name>` | Generate a working starting point: a whole consumer plugin directory, a single Node class, or a `.tsl` topology — the shapes from [writing-a-plugin.md](writing-a-plugin.md). Never overwrites. |
| `wp nodes ingest <topic> [<file>...]` | Replay packed partition-segment records (dead-letter segments included) back through a Topic — re-partitioned by KEY, appended to the destination segments. Omit the file list to read packed records from stdin instead. |
| `wp nodes memcache get <logical> [--host] [--key] [--porcelain]` | Read one cache entry by its LOGICAL name — the substrate rebuilds `newspack_nodes:{version}:{scope}:{logical}`, so you never type the version or the site hash. `--key` prints the resolved address without reading; `--host` resolves in the per-machine scope. |
| `wp nodes memcache flush` | Rotate the install's cache salt: every Newspack plugin key here is orphaned at once, and no co-tenant sharing the memcached is touched. Restarts the fleet after, because a live worker keeps writing the old prefix until it respawns. The CLI half of the settings page's Flush Caches button. |

## The common flows

**Is the fleet healthy?**

```bash
wp nodes doctor        # canonical environment + fleet health report
wp nodes status        # detailed fleet and consumer tables
```

**Deploying new worker code** — workers are long-lived processes; the old class stays in memory until they restart:

```bash
wp nodes restart all   # all worker topologies, every partition
```

**Replacing plugin files** — `restart` is not enough. Swapping `includes/`
under a running worker makes its autoloader fail on its own classes, and the
consumer quarantines whatever was in flight as poison. Take the fleet down
first and branch on the exit status:

```bash
wp nodes stop && ./deploy.sh && wp nodes start
```

`stop` exits non-zero if any worker still holds its lock, so the deploy never
runs against a live process. While held, `wp nodes status` reads `held`, and
`doctor` (and Site Health) carry a `fleet-hold` warning with its age — a hold
hours old is almost certainly a forgotten `wp nodes start`.

Each restarted worker gets a fresh WordPress bootstrap. Run that command after
all topology-provider plugins have been installed and activated, so each
worker's process-local catalog includes the complete plugin set.

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

`wp nodes doctor` renders exactly six canonical rows, in this order:

1. `cache-backend`
2. `filesystem`
3. `ownership`
4. `worker-liveness`
5. `consumer-lag`
6. `dead-letters`

Each row starts with `ok`, `WARN`, or `FAIL`. A report containing only `ok`
rows exits 0. `WARN` is a recommendation and also exits 0; any `FAIL` is
critical and exits 1.

The cache row comes from a bounded, purpose-HMAC-authenticated loopback request
to the web runtime, not from WP-CLI's separate APCu lifetime. The response is
strictly validated before terminal output. If the loopback result cannot be
verified, doctor reports `WARN` because cache health is unknown; a proven
missing or failed selected backend reports `FAIL`. The other five rows are
evaluated locally from the same canonical evaluator Site Health uses.

WP-Cron configuration is not one of the six Nodes checks. Nodes reports
actual worker liveness instead of treating `DISABLE_WP_CRON` as a proxy for
failure.

## Run-as-user rule

`wp nodes cli` and `wp nodes run` refuse to run as root: workers run as the web user and create their IPC/lock dirs under that ownership, so a root invocation would seed dirs the fleet can't write. Run them as the web user; `wp nodes doctor`'s ownership check tells you if a past root run left bad ownership behind (recovery: `chown -R <webuser>` of the base dir).
