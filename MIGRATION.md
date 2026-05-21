# Newspack Nodes Migration Guide

Reference for in-flight migrations within the `newspack-nodes` substrate. Each section documents one milestone: what changed, the new surface, the legacy surface it replaces, and the deletion deadline.

## M3 substrate service CIs — verb reference

### Overview

M3 introduces three substrate-side `CommandInterpreter` (CI) subclasses that replace the legacy per-controller REST endpoints with a uniform command-dispatch surface:

| CI | Verbs | Replaces |
|----|-------|----------|
| `Classes_CI` | 1 (`list`) | `class-classes-controller.php` |
| `Layouts_CI` | 2 (`get`, `save`) | `class-layouts-controller.php` |
| `Topologies_CI` | 4 (`list`, `get`, `save`, `delete`) | `class-topologies-controller.php` |

**Total: 7 verbs across 3 CIs.**

Browsers reach every CI through the same endpoint:

```
POST /wp-json/newspack-nodes/v1/command
```

with a `{type, to, from, id, value}` envelope where `to` is the CI shell-name (`classes`, `layouts`, `topologies`) and `value` is the JSON-encoded inner command `{name, arguments, payload}`. The substrate's `Router` peels `to`'s head, delivers the message to the named CI, and the CI's reply walks back via `TO=FROM` to `_http` (the per-request `HTTP_Out` node) which writes the packed Message directly to the HTTP response body.

This mirrors the M2 pattern used by `newspack-event-logger-nodes` for its nine application-side service CIs. Same endpoint, same envelope, same routing — only the `to` field differs.

### Mounting

All three substrate CIs mount via the existing `newspack_nodes/request_graph_ready` action — the same hook applications use for their own service CIs (see [API.md → Extensibility hooks](API.md#extensibility-hooks) and the `M2 service CIs` reference in `newspack-event-logger-nodes/MIGRATION.md`).

The substrate registers exactly one mount callback in `newspack-nodes.php`:

```php
function newspack_nodes_mount_substrate_cis( \Newspack_Nodes\CommandInterpreter $base_ci ): void {
    $base_ci->make_node( 'Classes_CI',    'classes' );
    $base_ci->make_node( 'Layouts_CI',    'layouts' );
    $base_ci->make_node( 'Topologies_CI', 'topologies' );
}
\add_action( 'newspack_nodes/request_graph_ready', 'newspack_nodes_mount_substrate_cis' );
```

`make_node( $shell_name, $node_name, ...$ctor_args )` does three things atomically: instantiate the FQCN registered under `$shell_name`, name the node, and sink it back into the base CI so verb responses route through `_router → _http`. Skipping the sink leaves the CI unwired and replies silently drop on the floor.

### Verb reference

Every verb takes its arguments as a JSON-encoded object in the request's `value.arguments` field. Every successful response is a JSON-encoded object in the response Message's `VALUE` field, wrapped in the standard CI envelope `{name, payload}` where `payload` is the verb's return string. Errors throw `\RuntimeException`; the substrate's `CommandInterpreter::interpret()` catches the throw and returns a `TM_COMMAND | TM_ERROR` Message with the exception message in `VALUE`'s `payload` slot (see [Error contract](#error-contract) below).

#### `classes.list`

Enumerate every Node class registered via `CommandInterpreter::register_class()`. Inlines each class's `node_schema()`, filters out the `Hidden` category (plumbing: `CommandInterpreter`, `Router`, `Shell`, `Dumper`, `Callback`, `Lock`), and bundles the `Formatters` registry alongside so the topology-editor palette can populate both its class catalog and its `formatter_name` arg dropdown in one round-trip.

| | |
|---|---|
| **Args** | `{}` |
| **Returns** | `{classes: [{shell_name, fqcn, category, description, ctor, verbs, requests, accepts_fill, has_target}], formatters: [string]}` |
| **Auth** | `manage_options` (namespace-level, via `Command_Controller`) |
| **Sort** | `classes` sorted by `[category, shell_name]`; `formatters` sorted alphabetically |
| **Source** | `includes/rest/class-classes-ci.php` |

#### `layouts.get`

Read a saved `.layout` file from `<base_directory>/layouts/<name>.layout`. Layouts are decoupled from topologies: the TSL file describes graph structure; the `.layout` file describes node positions. The supervisor never reads layouts — only the topology console does, as a default for the canvas's "Reset Layout" affordance.

| | |
|---|---|
| **Args** | `{name}` where `name` matches `[a-zA-Z0-9_-]+` |
| **Returns** | `{name, positions: object\|null}` — `positions` shape is `{node_id: [x, y], ...}` |
| **Auth** | `manage_options` (namespace-level + per-verb `current_user_can` check) |
| **Missing file / unparseable JSON** | Returns `positions: null` (not an error) |
| **Source** | `includes/rest/class-layouts-ci.php` |

The response **never** surfaces non-`positions` top-level keys from the saved file — the contract is strict to that one field. The per-verb capability check matches `layouts.save`'s; layouts are operator-only material even on read.

#### `layouts.save`

Persist a layout to `<base_directory>/layouts/<name>.layout`. Sanitizes positions (numeric pairs only; node-id matches `[a-zA-Z0-9_:.-]+`; x/y must be finite floats); silently drops invalid entries.

| | |
|---|---|
| **Args** | `{name, positions: {node_id: [x, y], ...}}` |
| **Returns** | `{name, path, positions}` — `positions` is the sanitized version actually written |
| **Auth** | `manage_options` (namespace-level + per-verb `current_user_can` check) |
| **Body cap** | 64 KiB on raw `arguments` blob; exceeding throws `"body too large: layout payload exceeds 64 KiB"` |
| **Source** | `includes/rest/class-layouts-ci.php` |

#### `topologies.list`

Enumerate every topology resolvable by `Topology_Registry::describe()`. Each entry's `active` flag reflects what the supervisor would actually spawn (via `Bootstrap::get_topologies()`) — including operator-overlay selections that aren't in the application's filter catalog. Results are sorted alphabetically by `name`.

| | |
|---|---|
| **Args** | `{}` |
| **Returns** | `{topologies: [{name, source, active, frontmatter}], user_dir}` |
| **`source` values** | `'user'`, `'stock'`, or `'both'` (per `Topology_Registry::describe()` entry shape) |
| **Auth** | `manage_options` (namespace-level) |
| **Source** | `includes/rest/class-topologies-ci.php` |

#### `topologies.get`

Read the canonical TSL for a topology. Resolves through `Topology_Registry::resolve()`, which honors user-over-stock shadowing.

| | |
|---|---|
| **Args** | `{name}` where `name` matches `[a-zA-Z0-9_-]+` |
| **Returns** | `{name, source, tsl: string}` |
| **Errors** | Throws `"no topology named: <name>"` if `resolve()` returns `null` |
| **Auth** | `manage_options` (namespace-level) |
| **Source** | `includes/rest/class-topologies-ci.php` |

#### `topologies.save`

Write a topology to `{user_dir}/{name}.tsl`. Runs dry-run validation through `Shell::validate_line()` on every statement (rejects forbidden verbs `if`/`while`/`for`/`func`/`eval`/`unless`/`until` and malformed continuations). After writing, if `$name` is present in `apply_filters('newspack_nodes/topologies', [])` — the raw catalog filter the supervisor walks — the verb fires `do_action('newspack_nodes/restart_fleet', $name)` so the worker fleet picks up the new graph.

| | |
|---|---|
| **Args** | `{name, tsl: string}` |
| **Returns** | `{name, path, shadows_stock, restarted_fleets: [string]}` |
| **Auth** | `manage_options` (namespace-level + per-verb `current_user_can` check) |
| **Body cap** | 64 KiB on raw `arguments` blob; exceeding throws `"body too large: topology payload exceeds 64 KiB"` |
| **Validation errors** | Throws `"validation failed at line N: <reason>"` (N is 1-based) |
| **`shadows_stock`** | Computed BEFORE writing so it reflects pre-existing stock state, not "we just made a user copy" |
| **Source** | `includes/rest/class-topologies-ci.php` |

#### `topologies.delete`

Remove a topology's user-saved copy from `{user_dir}/{name}.tsl`. Stock copies shipped by plugins are immutable; this verb refuses to touch them. After unlink, `stock_fallback` is `true` iff a stock copy remains (signalling to the UI that the topology reverts to its shipped default rather than disappearing).

| | |
|---|---|
| **Args** | `{name}` where `name` matches `[a-zA-Z0-9_-]+` |
| **Returns** | `{name, deleted: <path>, stock_fallback: bool}` |
| **Errors** | Throws `"no user-saved topology named: <name> (stock copies are protected)"` when no user file exists |
| **Auth** | `manage_options` (namespace-level + per-verb `current_user_can` check) |
| **Source** | `includes/rest/class-topologies-ci.php` |

### Error contract

Verbs signal failure by throwing `\RuntimeException` with a human-readable message. The substrate's `CommandInterpreter::interpret()` (see `includes/class-command-interpreter.php`) wraps the throw uniformly:

```php
try {
    $result    = $this->execute( ... );
    $resp_type = Message::TM_COMMAND | Message::TM_RESPONSE;
} catch ( \Throwable $e ) {
    $result    = $e->getMessage();
    $resp_type = Message::TM_COMMAND | Message::TM_ERROR;
}
```

The browser receives a packed Message with `TYPE = TM_COMMAND | TM_ERROR` and the exception message in the response envelope's `payload` field. JS callers should treat the type-flag bit as the success/failure discriminator and read `payload` for the error string.

Application-level CIs (M2) follow the same contract — do not add per-verb `try/catch` blocks. The central catch in `interpret()` is the contract.

### Auth gating

There are two layers:

1. **Namespace-level** (`Command_Controller::register_routes()`): `permission_callback` requires `current_user_can( 'manage_options' )`. Applied uniformly to every `/command` request before any CI dispatch. No way around it from the substrate side.
2. **Per-verb** (verb-handler closures): four verbs — both `layouts.*` and the two mutating `topologies.*` — also call `self::require_manage_options()` inside the handler. This is defense-in-depth: the namespace gate already rejects unauthenticated callers, but per-verb checks ensure a future relaxation of the namespace gate (e.g. a read-only role) still keeps these surfaces locked down.

Per-verb gating, by verb:

| Verb | Namespace gate | Per-verb gate |
|------|----------------|---------------|
| `classes.list` | yes | — |
| `layouts.get` | yes | yes |
| `layouts.save` | yes | yes |
| `topologies.list` | yes | — |
| `topologies.get` | yes | — |
| `topologies.save` | yes | yes |
| `topologies.delete` | yes | yes |

### Substrate-CI vs application-CI split

The substrate-side CIs deal with **stored objects and filesystem paths** — the classes registry (process-global static), `.layout` files, and `.tsl` files. The application-side CIs (the nine in `newspack-event-logger-nodes`) deal with **the running fleet** — workers, dashboards, performance counters, request lifecycle, etc.

When adding a new service CI, choose the side that owns the data:

- **Substrate-side** if it's a global registry, an immutable artifact (TSL frontmatter, schemas), or a filesystem object the substrate's `base_directory` owns.
- **Application-side** if it queries the running fleet, the application's per-request state, or per-job records.

Both sides use the same `make_node()` mounting pattern on the same `newspack_nodes/request_graph_ready` hook. There is no architectural difference between substrate-mounted and application-mounted CIs at runtime — the split is purely about which plugin owns the data.

### Browser dispatch example

```js
fetch( '/wp-json/newspack-nodes/v1/command', {
    method: 'POST',
    headers: {
        'Content-Type': 'application/json',
        'X-WP-Nonce':   nonce, // wp_create_nonce('wp_rest')
    },
    body: JSON.stringify( {
        type: 8,                 // TM_COMMAND
        to:   'topologies',      // CI shell-name (classes | layouts | topologies)
        from: '_http',           // reply path; defaults to '_http' if omitted
        id:   'req-' + Date.now(),
        value: JSON.stringify( {
            name:      'list',   // verb
            arguments: '{}',     // JSON-encoded args
            payload:   '',
        } ),
    } ),
} )
    .then( res => res.arrayBuffer() )
    .then( buf => {
        // Body is a packed Message. Unpack with the JS Message helper, or
        // pull the inner CI envelope via Message.unpacked(bytes).VALUE.
        // For TM_COMMAND | TM_RESPONSE (type === 24): payload is the verb's
        // JSON return. For TM_COMMAND | TM_ERROR (type === 40): payload is
        // the error string.
    } );
```

For high-level patterns, prefer the React glue (`useNodeFill`) over raw `fetch()` — it handles envelope construction, KEY correlation, and packed-Message unpacking. See `src/topology-console/hooks/` for examples.

### Legacy controllers (deleted in M4.7.2)

The 3 legacy REST controllers were deleted at commit `895ab89` after the topology-console rewrite (`05403b1`) verified all 7 verbs flow through `CommandClient`. The post-deletion surface is:

Deleted:
- `includes/rest/class-classes-controller.php` — replaced by `Classes_CI.list`.
- `includes/rest/class-layouts-controller.php` — replaced by `Layouts_CI.get` + `.save`.
- `includes/rest/class-topologies-controller.php` — replaced by `Topologies_CI.list/get/save/delete`.
- 7 PHPUnit suites: `tests/unit/{Layouts,Topologies}ControllerTest.php`, `tests/integration/{Classes,TopologiesGet,TopologiesGetOne,TopologiesPost}ControllerTest.php`.

Deleted (M4 follow-up):
- `includes/rest/class-topology-stream-controller.php` + its unit/integration tests — fully redundant. The Topology Console now subscribes to the worker's broadcast IPC partition through the generic `/messages/stream` (`subscribe={topology}.p{N}`, resolved by `open_subscription` → `Cli::attach_to_worker`) and sends commands through the generic `/command` (pivoted via `FROM=_http/<ssePid>`, where the pid comes from messages-stream's `connected` envelope). The 1s/5s `dump_metadata`/`uptime` poll moved client-side into `TopologyConsole.js`.

Kept:
- `includes/rest/class-spawn-controller.php` — HMAC-gated worker spawn endpoint; orthogonal to the command-dispatch surface.
- `includes/rest/class-messages-stream-controller.php` — paired SSE controller for the M3 messages stream.
- `includes/rest/class-command-controller.php` — the unified endpoint itself.

Gate tests in `tests/integration/M3BootstrapTest.php` (`test_legacy_*_controller_class_is_gone`) assert non-existence at the class-loader level so accidental re-registration trips CI.

### M4 dashboard cutovers — substrate-side

The application-side cutover log in `newspack-event-logger-nodes/MIGRATION.md` tracks all 7 dashboards; only one of them (topology-console) is substrate-resident:

| # | Dashboard | Rewrite commit | Deletion commit | Legacy controllers removed |
|---|-----------|----------------|-----------------|----------------------------|
| 7 | `topology-console` | `05403b1` | `895ab89` | `class-classes-controller.php`, `class-layouts-controller.php`, `class-topologies-controller.php` |

This is the final M4 cutover. With it M4 is COMPLETE — all 7 dashboards across both repos have migrated to the unified `POST /command` endpoint via `CommandClient`. ~30 `apiFetch` calls cut over; 14 legacy REST controllers deleted (3 here + 11 in the app). Reusable helpers (`getCommandClient()` singleton + `unwrapCommandResponse()` peeler) live in `src/shared/utils/` in both repos. Pivoted-REPL POST + 5 SSE controllers stay — `CommandInterpreter` dispatch is request/response only.
