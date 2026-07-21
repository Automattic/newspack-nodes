# Upgrading

Breaking changes that affect a plugin built on the substrate — topology files, Node subclasses, job handlers, dashboards, the wire — with the fix beside each. Start at your installed version and apply everything above it. Internal refactors and fixes are not listed; [CHANGELOG.md](../CHANGELOG.md) has the full story per release.

**Maintenance rule:** a release that changes any consumer-facing contract adds its entry here in the same commit as its CHANGELOG entry. No entry means nothing to do.

## 0.48.0

- **Profiling verbs collapsed into one `profile` toggle.** `enable_profiling` and `disable_profiling` are removed (no alias): bare `profile` toggles, `profile on` / `profile off` set idempotently. Anything invoking the old pair gets an unknown-command error. `list_profiles` is unchanged.

- **CommandInterpreter verb `debug_state` renamed to `trace`.** The per-node/interpreter trace toggle is now the `trace` verb (`trace [ <node> [ <level> ] ]`); the old `debug_state` name is gone (no alias). Anything invoking `debug_state` at the REPL or over the wire gets an unknown-command error — use `trace`. The `debug_state` node *property* and the `dump_metadata` `debug_state` field are unchanged.

## 0.47.1

- **Dashboards / hub verbs** — `Aggregator_CI` dropped its dead `status`, `health`, and `servers` verbs. Anything invoking them gets an unknown-verb error; read `summary` and `servers_status` instead.
- **JS runtime** — the `Core.reinit` global is retired; the overlay's Reset-Graph capability is now the `Core.rebuildable` boolean.
- **Node schemas** — a `node_schema()` argument whose `<config:…>` default resolves to no registered key (unknown namespace, unowned key, non-scalar) now throws instead of silently coercing to `''`. If a node stops constructing, its schema default names a key that no longer exists — check the retention keys in particular (`min_segments` / `max_segments` / `min_lifetime` / `max_lifetime`). Topology-line interpolation is unchanged (an unowned token still interpolates to `''`, Tachikoma parity).

## 0.47.0

- **Command envelopes and `arguments()`** — TM_COMMAND `arguments` and node-constructor `arguments` are a flat token array (`list<string>` argv) end to end, no longer a single space-joined string. Verb handlers receive `array $args` and index it; `Node::arguments()` / `parse_schema_args()` take and return token arrays; anything minting a command envelope by hand passes a token list. `Command_Args::parse()` / `format()` speak tokens on both sides; the only join-back-to-a-line lives in `Node::serialize_args()` / JS `serializeArg`. TM_INFO / TM_REQUEST / TM_BYTESTREAM VALUEs are unchanged.
