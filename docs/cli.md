# CLI Reference

Every substrate command lives under `wp nodes`. This page is the quick reference; `wp help nodes <verb>` carries each verb's authoritative options. Application plugins mount their own verbs in the same namespace — the event logger adds `reqgrep` and `ruleset-bench` — and those are documented by their plugins.

| Verb | What it does |
|---|---|
| `wp nodes status` (alias `ls`) | Reports the fleet: one row per partition of every active topology — `live`, `stale`, `down`, `held` while a deploy hold stands, or `idle` where the topology declares an on-demand idle window, each with heartbeat age and uptime — then one row per lock a deactivated type still holds, tagged `(inactive)`, then a parked `inactive` row for every catalog topology that is not active, and last the consumer-lag table. `--format=table\|json\|csv\|yaml`. |
| `wp nodes types` | Lists the active topology groups the fleet spawns — name, partition count, stale timeout (60s unless the topology sets one), and topology path. |
| `wp nodes doctor` | Renders the canonical health report: eight rows plus up to two conditional ones, each `ok` / `WARN` / `FAIL`. Recommendations warn and exit 0; any critical result exits 1. |
| `wp nodes gc [--force]` | Sweeps orphan log and offsetlog dirs now, instead of waiting for the next reconciliation pass. A dir is orphaned when no active topology declares it. Spares a dir written in the last hour unless `--force` drops that grace to zero. |
| `wp nodes run <type> [--partition=<N>]` | Runs one worker in the foreground, started directly rather than through the spawn endpoint, and blocks until it exits, then prints the worker's own exit reason. The debugging tool for "spawns but immediately exits". Partition 0 by default; refuses root. |
| `wp nodes restart <type\|all> [--partition=<N>]` | Writes a restart flag into each matched lock dir; the holders exit cleanly and their self-respawn starts them fresh. Every partition of the matched type restarts unless `--partition` narrows it. |
| `wp nodes stop [--timeout=<s>]` | Holds the fleet down for a deploy: refuses every spawn path, asks each worker to exit, then blocks until every lock dir is gone. Waits 90 seconds by default, and exits non-zero naming the workers still holding locks if that expires. The hold persists until `wp nodes start`. |
| `wp nodes start` | Releases the hold, clears any straggler's stop flag, and requests a spawn for every due slot. Each request is a fire-and-forget POST, so `wp nodes status` is what confirms the fleet came back. |
| `wp nodes activate <topology>` / `deactivate <topology>` | Adds or removes a catalog topology from the active set and spawns or drains its fleet now. The same primitive the Topologies settings UI calls. |
| `wp nodes cli [<type>.p<N>]` | Opens the REPL. Bare, it runs a local interpreter; with a worker id it pivots into that live worker over IPC. Refuses root. See [troubleshooting.md](troubleshooting.md) for the in-REPL verb table. |
| `wp nodes scaffold <plugin\|node\|topology> <name>` | Generates a working starting point: a whole consumer plugin directory, a single Node class, or a `.tsl` topology — the shapes from [writing-a-plugin.md](writing-a-plugin.md). Slugs are `[a-z0-9-]+`, class names `[A-Za-z_]+`. Never overwrites. |
| `wp nodes ingest <topic> [<file>...]` | Replays packed partition-segment records (dead-letter segments included) back through a Topic — re-partitioned against the destination's geometry, appended to its segments. Omit the file list to read packed records from stdin instead. |
| `wp nodes memcache get <logical> [--host] [--key] [--porcelain]` | Reads one cache entry by its LOGICAL name — the substrate rebuilds `newspack_nodes:{version}:{scope}:{logical}`, so you never type the version or the site hash. `--key` prints the resolved address without reading; `--host` resolves in the per-machine scope; `--porcelain` prints the value alone. |
| `wp nodes memcache flush` | Rotates the install's cache salt: every Newspack plugin key here is orphaned at once, every issued command session with them, and no co-tenant sharing the memcached is touched. Restarts the fleet after, because a live worker keeps writing the old prefix until it respawns; a restart that fails warns and leaves the new scope to the next spawn. The CLI half of the settings page's Flush Caches button. |
| `wp nodes caps [status\|install\|uninstall]` | Reports or changes the capability model: which WordPress capability each of the three roles resolves to, and the swap onto real capabilities. |
| `wp nodes hub-user <login>` | Creates the least-privilege aggregator user and issues it an application password, shown once. |

## The common flows

**Is the fleet healthy?**

```bash
wp nodes doctor        # environment and fleet health, in one report
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
runs against a live process. A spawn already in flight blocks it too: a worker
that released its lock just before the hold landed holds no lock while it
bootstraps, and its successor would come up against the half-swapped
directory. Without memcached that check cannot read the spawn timestamps, and
`stop` warns that it is blind to them. While the hold stands, every slot that
holds no lock reads `held` in `wp nodes status`, and `doctor` (and Site Health)
carry a `fleet-hold` warning with its age — a hold hours old is almost
certainly a forgotten `wp nodes start`.

Each restarted worker gets a fresh WordPress bootstrap. Restart only after
every topology-provider plugin is installed and activated, so each worker's
process-local catalog holds the complete plugin set.

**Debugging one worker** — a foreground run shows boot errors and the exit reason; the REPL inspects a live graph without disturbing it:

```bash
wp nodes run <type> --partition=0
wp nodes cli <type>.p0
```

Both `run` and `restart` take a type an ACTIVE topology declares, so a topology
you just deactivated is no longer a target even while its last workers wind
down.

**Starting a new consumer plugin:**

```bash
wp nodes scaffold plugin my-pipeline
cd my-pipeline && composer dump-autoload -o
```

**Recovering quarantined messages** — after fixing the poison handler, replay the dead-letter segments (one dir per reader under `{base_dir}/deadletter/` — the stock topologies name each `<topology>.<log>.p<N>` — holding numbered `{seg}.log` segments directly):

```bash
wp nodes ingest firehose {base_dir}/deadletter/<reader>/*.log
```

`<topic>` is either a bare log name, expanded to `<config:logs_dir>/<name>.p<partition>`, or a full dir-template carrying a `<partition>` (or `{partition}`) token, taken as written once its `<config:…>` tokens resolve. Each record then picks its destination partition the way any Topic write does: a TO already pinned to `p<N>` keeps that pin, a record carrying a KEY hashes by KEY, and one with neither lands round-robin. Omit the file list to pipe packed records on stdin instead — useful with a filtered `wp nodes reqgrep` or `zcat` output. A line that will not unpack is counted and skipped, so a torn record at a segment's tail cannot abandon the replay.

The destination's geometry defaults to the configured `num_partitions`, `segment_size` and `num_segments`; an explicit dir-template defaults to one partition instead, because the template names a layout already on disk. `--num_partitions=<n>`, `--segment_size=<bytes>` and `--num_segments=<n>` override each in turn, which is what makes re-segmenting an existing log the same operation as a replay. Records above the 4KB PIPE_BUF cap need `--allow_large_writes` (a held per-partition lock) or `--void_warranty` (no lock, caller asserts single-writer); either raises the cap to 32 MiB, and passing both is refused. `--dry-run` writes nothing, reports the largest record it saw, and says which of those flags you need.

## Capabilities and the hub user

The three substrate roles — `read` (dashboards, SSE, introspection), `tune` (settings and application data) and `manage` (fleet control and credentials) — all resolve to `manage_options` until you move them. `wp nodes caps` prints that map; `wp nodes caps install` swaps the three onto the real capabilities `newspack_nodes_{read,tune,manage}`, grants all three to every role that already held `manage_options`, and creates the `newspack_nodes_hub` role carrying read and tune alone. `wp nodes caps uninstall` reverses both. Every action ends by printing the resulting map, and any other word is refused rather than reported as status.

```bash
wp nodes caps install
wp nodes hub-user newspack-nodes-hub
```

`hub-user` creates — or re-roles, removing every other role — the least-privilege user a log aggregator authenticates as, then issues it an application password printed once and stored nowhere. `--email=<email>` sets the address for a newly created user (default `<login>@<site host>`), `--name=<name>` labels the password (default `newspack-nodes hub`), and `--no-password` creates the user without one.

Run these in this order. Until the swap lands, the hub role still resolves to `manage_options` and the credential would hold everything, so `hub-user` refuses while `caps install` has not run.

## Doctor health report

`wp nodes doctor` renders eight canonical rows, in this order:

1. `cache-backend`
2. `filesystem`
3. `ownership`
4. `housekeeping`
5. `config-keys`
6. `worker-liveness`
7. `consumer-lag`
8. `dead-letters`

Two more appear only when they apply: `fleet-hold` follows `config-keys` while a deploy hold stands, and `other-alerts` closes the report when an alert declares a family no bucket claims.

Each row starts with `ok`, `WARN` or `FAIL`. A report of `ok` rows alone exits 0. `WARN` is a recommendation and also exits 0; any `FAIL` is critical and exits 1.

The cache row comes from a loopback POST to `newspack-nodes/v1/health/cache`, bounded at five seconds and authenticated by a purpose-separated HMAC token, because a CLI process picks a different cache backend than the one serving requests. The reply is validated against the exact shape `Health_Checks` produces before any of it reaches the terminal. An unverifiable result reports `WARN`, since cache health is then unknown; a proven missing or failed backend reports `FAIL`. Every other row is evaluated locally through the same evaluator Site Health reads.

`housekeeping` asks one question, once any topology is active: is `newspack_nodes/reconcile` scheduled? That minute pass carries log retention, orphan partition and IPC reaping, alert emission, the delayed-jobs sweep, every `newspack_nodes/periodic` subscriber and cold-start worker revival, and it fails silently while every other check stays green. Doctor reads neither `DISABLE_WP_CRON` nor any other cron setting — a platform invoking `wp-cron.php` externally is healthy, and worker liveness is reported directly rather than inferred from a proxy.

`config-keys` names every key in `newspack-nodes-config.php` that the settings schema does not declare. The deploy copies the operator's own file over the shipped path, so a key renamed in the schema leaves a stale entry behind whose value is silently not in effect.

## Operator flags are validated, never cast

`--partition`, `--timeout`, `--num_partitions`, `--segment_size` and `--num_segments` are read through a refusing parse. A cast would answer 0 for `--partition=abc` and 2 for `--timeout=2m`, so the typo would restart a different fleet — or shorten a deadline — and the command would report success on it. A malformed value exits with an error naming the flag instead. The three geometry flags refuse zero as well, because a destination that stores nothing is nobody's intent.

## Run-as-user rule

`wp nodes cli` and `wp nodes run` refuse to run as root: workers run as the web user and create their IPC and lock dirs under that ownership, so a root invocation would seed dirs the fleet cannot write. Run them as the web user. `wp nodes doctor`'s ownership check tells you whether a past root run left bad ownership behind, and names the recovery: `chown -R <webuser>` of the base dir.
