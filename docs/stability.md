# Stability Contract

The names below are the substrate's declared surface: the shapes
[API.md](API.md), [cli.md](cli.md) and the ADRs document. A consumer reaches
past them constantly — `Core`, `Config`, `Job_Intake`, `Cache_Backend`,
`LRU_Cache`, `Partition_Node`, `Table_Node` and the [`Bootstrap`](../includes/class-bootstrap.php) trio
`node_dirs()`, `node_partitions()` and `stale_timeout_for()` all carry sibling
traffic, and not one of them is on the list. Nothing forbids reaching past the
list, but those names move inside a major, and every consumer-facing change
lands in [upgrading.md](upgrading.md) with the rewrite beside it, frozen or not.

That trio and [`Topology_Analyzer::includes()`](../includes/class-topology-analyzer.php) answer questions a consumer cannot
answer for itself. `node_dirs()` and `node_partitions()` are how a reader finds
a node's partitions across every ACTIVE topology declaring it: `node_dirs()`
answers partition index => directory for a Partition or Topic node, and
`node_partitions()` the ascending indices alone, for per-partition state that
never lands on disk — event-logger-nodes builds one memcache `Stats_Store` per
flame-builder index from it. The global `num_partitions` setting is never that
number. A topology carries its own worker count, and a Topic's second
constructor argument is its own fan-out width, which an aggregator declares
above the worker count for hub fan-in or deliberately below it, so a consumer
looping to the global setting reads the low partitions alone and reports no
error. `stale_timeout_for( $type )` does the same for staleness, returning the
threshold that topology's frontmatter declares and falling back to
[`Lock_Node::STALE_TIMEOUT`](../includes/class-lock-node.php) for an unknown name. `CLI::ls_workers()` behind
`wp nodes status` reads it there, and so does the render lease
nuclear-gyrobase hands its Perl child. A consumer judging staleness against the
flat default instead calls a worker on a raised-threshold topology dead while
the peer scan correctly leaves it running.
`Topology_Analyzer::includes( $name )` answers "does this deployment run X?",
which the active topology NAMES cannot: a deployment routinely runs a stock
topology through a locally-named wrapper, and the wrapper's name says nothing
about what it composes. Event-logger-nodes' hub
detection tests `'aggregator' === $name` and then that include set before it
falls back to scanning the graph for a `Remote_Source` node.

All four can raise `\RuntimeException`, and not only for the caller's own
mistake. The three `Bootstrap` names resolve the active topology set first,
which fails when the runtime base directory is unusable; the analyzer behind
`node_dirs()`, `node_partitions()` and `includes()` fails again when ANY
topology it walks declares an unknown include, an include cycle or a conflicting
`make_node` — someone else's `.tsl`, not the node the caller asked about.
Event-logger-nodes calls `node_dirs()` on dashboard request paths from
[`Performance_CI_Node`](https://github.com/Automattic/newspack-event-logger-nodes/blob/v0.96.0/includes/app/class-performance-ci-node.php) and [`Flame_Builder_Node`](https://github.com/Automattic/newspack-event-logger-nodes/blob/v0.96.0/includes/class-flame-builder-node.php), where an uncaught throw is a 500
on every dashboard request, and wraps `includes()` in a try/catch for the same
reason. Catch it, or let the surrounding controller's catch own it.

## Frozen surfaces

1. **The node contract.** `fill( array $message ): void`, `sink()`, `target()`,
   `stamp_message()`, `register()` / `notify()` / `set_state()`, `arguments()`,
   `node_schema()` — the shapes [ADR-1](architecture-decisions.md#adr-1-uniform-fill-contract),
   [ADR-7](architecture-decisions.md#adr-7-sink-vs-target-and-tofrom-replies)
   and [ADR-11](architecture-decisions.md#adr-11-make_node-construction-sequence)
   pin. `set_state()` is `protected`: a Node subclass calls it, nothing else.
2. **The message.** The 7-field positional layout (`Message::TYPE`, `TIMESTAMP`,
   `FROM`, `TO`, `ID`, `KEY`, `VALUE`), the `TM_*` type flags, and the
   positional-JSON wire format (`packed()` / `unpacked()`) —
   [ADR-2](architecture-decisions.md#adr-2-one-message-format-the-7-field-positional-array).
   `Message::LOCAL` is an eighth slot carrying in-process provenance taint;
   `packed()` never emits it and `unpacked()` rejects an 8-field line, which is
   what makes its presence worth trusting ([ADR-15](architecture-decisions.md#adr-15-command-authorization-local-taint--the-minter-signs)).
   On-disk Partition segments written by any release in the current major stay
   readable by every later release in that major. That covers the packed
   ENVELOPE, never the record inside a VALUE: a producer owns its own record —
   `Probe_Record`, `Jobstats_Record`, a durable reader's offsetlog frame — and
   may re-cut its fields inside a major.
   `Message::new_message()` is the sanctioned way to mint one, and it is frozen
   with the layout: it returns the seven indices populated, TYPE at
   `TM_UNTYPED`, TIMESTAMP warmed off the cached clock and empty strings
   elsewhere, leaving the caller to assign TYPE. Nothing builds the array by
   hand.

   The eighteen reserved node names are wire strings too, and their VALUES are
   frozen for the major even though the JS module carrying them is not.
   [`Node_Names`](../includes/class-node-names.php) is the PHP half and [`src/runtime/reserved-node-names.json`](../src/runtime/reserved-node-names.json) the
   canonical map, which `src/runtime/index.js` exports as `reservedNames` for a
   consumer bundle to compile in. The two halves meet at runtime and not before:
   a browser mints `FROM = _sse:<pid>/_output` from a bundle built against its
   own pinned substrate, while the worker gates on `Node_Names::SSE` and stamps
   `Node_Names::OUTPUT` out of the INSTALLED one. Rename a value and the failure
   is silent — the reply addresses a node that does not exist, and nothing
   errors anywhere — so a rename takes an upgrading.md entry.
3. **TSL.** The statement grammar ([`Shell_Node::parse_statements()`](../includes/class-shell-node.php) semantics),
   the shell builtins (`var`, `include`, `print`, `clear`, `status`,
   `debug_level`, `show_parse`, and `cd` with its alias `chdir`), the graph
   verbs (`make_node`, `set_sink`, `connect_node`, `disconnect_node`,
   `move_node`, `remove_node`, `register`, `unregister`, and `command_node` with
   its aliases `command` and `cmd`), the one-way `secure` ratchet every stock
   topology closes with, the `insecure` declaration refused once that level has
   climbed, and token resolution: the `<partition>` and `<topology>` variables
   `Topology_Loader` binds before it evaluates the file, and the `<ns:key>`
   form each namespace resolves through the resolver it registered at boot —
   `<config:KEY>` is the substrate's, and a consumer adds its own through
   `Core::register_config_namespace()`. The grammar is one grammar in both
   ports: [`src/runtime/shell-node.js`](../src/runtime/shell-node.js)'s `parseStatements` is held to
   `parse_statements()` by the shared [`tests/fixtures/statements/`](../tests/fixtures/statements) corpus,
   which the PHP and JS suites both read.
4. **Stock node types.** The registered names and constructor-argument shapes of
   every node the palette lists. `node_schema()` is the authority and
   `help <NodeType>` renders it. A schema declaring the category `Hidden`, no
   category at all, or a `hidden` flag sits outside the palette and outside this
   contract.
5. **CLI.** The `wp nodes` verbs and their documented arguments and output
   contracts, `--format=json` shapes included. [cli.md](cli.md) is the
   reference; an application plugin's own verbs in the same namespace —
   event-logger-nodes adds `reqgrep` and `ruleset-bench` — belong to that
   plugin's contract, not this one.
6. **REST.** The routes under `newspack-nodes/v1` and their envelope shapes
   ([API.md](API.md)): `/workers/spawn`, `/auth`, `/command`,
   `/messages/stream`, `/log/stream`, and the internal `/health/cache` probe.
   That last one is gated by an [`Internal_Request_Token`](../includes/class-internal-request-token.php) rather than a
   capability, and carries the web runtime's cache posture back to
   `wp nodes doctor` — the substrate's own wire between its tiers, not a
   consumer surface.
7. **Hooks.** Every `newspack_nodes/*` action and filter name and signature,
   enumerated with its arguments and its firing site in
   [API.md → Extensibility hooks](API.md#extensibility-hooks).
8. **Config_System.** The public API of seven classes, name by name:
   - [`Field`](../includes/config-system/class-field.php) — the constructor, its readonly declaration (`key`, `type`,
     `section`, `id`, `restart`, `min`, `max`, `default`, `ui`,
     `register_args`, and the derived `delete_on_blank`, `render` and
     `sanitize`), `label()`, `sanitize_callback()`, `is_setting()`,
     `is_rendered()` and `render_id()`.
   - [`Schema`](../includes/config-system/class-schema.php) — the `( $prefix, $fields, $sections )` constructor,
     `overlay_keys()`, `setting_option_names()`, `delete_on_blank_options()`,
     `restart_for()`, `field_for_short()`, `defaults()`, `prefix()`,
     `fields()`, `rendered_fields()`, `register_options()` and
     `register_sections_and_fields()`.
   - [`Options_Overlay`](../includes/config-system/class-options-overlay.php) — `apply()`, `stored_value()` and the `ABSENT`
     sentinel that reports a missing option row.
   - [`Reset_Gate`](../includes/config-system/class-reset-gate.php) — `register()`, `resolve()` and `mark_name()`.
   - [`Field_Reset_Assets`](../includes/config-system/class-field-reset-assets.php) — `enqueue()` and `highlight_style()`, and with them
     the DOM vocabulary both key off: the `data-nn-reset` wrapper naming the
     mark, its `data-nn-reset-toggle` button, the `data-nn-reset-default` a
     control declares, the `data-nn-reset-marker` the toggle plants and the
     `is-marked` class the style paints. Pyrobase writes that markup by hand
     rather than calling `Settings_Renderer`, so a rename in the JS leaves it a
     dead toggle or an unstyled mark and nothing raises.
   - [`Settings_Renderer`](../includes/config-system/class-settings-renderer.php) — `render_effective_config_section()` and
     `effective_config_rows()` behind the Effective Configuration panel, the
     five controls `number()`, `directory()`, `textarea()`, `checkbox()` and
     `react_mount()`, and the `reset_wrapper()` / `reset_toggle()` pair every
     control goes out through.
   - [`Restart_Planner`](../includes/config-system/class-restart-planner.php) — `plan()`, `request_restarts()`, `request_reloads()`
     and `topologies_for()`.

   The first five carry a second guarantee — they stay loadable without the
   substrate, so a consumer's hermetic harness can require the five files
   alone, as pyrobase's `tests/load-config-system.php` does. A substrate call
   added to any of the five fatals that harness on a missing
   `Newspack_Nodes\Core`, which is why `Field::label()` and
   `Schema::register_sections_and_fields()` inline their string coercion rather
   than call `Core::str()`. The other two use the substrate legitimately;
   event-logger-nodes consumes both.
9. **[Config_Utils](../includes/class-config-utils.php).** `validate_config_path()`, `load_config_file()` and the
   `validate_config_values()` walk beneath them — the file half of
   [ADR-20](architecture-decisions.md#adr-20-a-config-default-lives-in-code-every-config-file-is-an-override-surface),
   which the substrate's own `Config` and event-logger-nodes' `Config` both read
   their configuration through. The two entry points take a trailing prefix
   string naming the calling class in the log line or the exception; the walk
   takes a recursion depth instead. Three guarantees a consumer builds on: a
   config file overrides the schema defaults for the keys it names, so a missing
   one returns the passed config untouched; a file returning anything but a tree
   of scalars, nulls and arrays throws, and so does one nesting arrays more than
   ten deep, which is how the walk ends on a self-referential tree; and a path
   failing any check logs through `Core::stderr()` and comes back null, leaving
   the caller to decide whether a bad path is fatal. That `Core::` call is why
   this class cannot join item 8's hermetic five: without the substrate, a
   harness fatals the first time a path check fails.
10. **Consumer boot.** [`Topology_Registry::register_plugin()`](../includes/class-topology-registry.php),
    [`Command_Interpreter_Node::register_namespace()`](../includes/class-command-interpreter-node.php),
    `Bootstrap::version_at_least()`, and three constants the entry point
    defines: `NEWSPACK_NODES_VERSION`, the handshake a consumer compares
    against; `NEWSPACK_NODES_DIR`, the plugin's filesystem root, holding the
    autoloader, the stock topologies and `build/`; and `NEWSPACK_NODES_URL`, the
    browser base for that same `build/`. Both paths end in the slash their
    `plugin_dir_path()` / `plugin_dir_url()` sources give them.
    `Field_Reset_Assets::enqueue()`, frozen in item 8, reads the build's
    `index.asset.php` off DIR and its script src off URL. URL is the one that
    can go missing — the plugin defines it only where `plugin_dir_url()` exists
    — so every reader guards it: `enqueue()` returns early and
    `Admin::build_url()` falls back to the empty string.

    [`Formatters::register( $name, $cb )`](../includes/class-formatters.php) is the third registration, and the
    only supplier for a `cmd <node>:config with_index <name>` line: TSL has no
    closure syntax, so a topology names a formatter and a plugin registers the
    callable under that name at load. The name and its callable argument are
    frozen; the signature that callable must satisfy is not, because it belongs
    to whoever resolves the name — for the companion-index formatters, to
    `Partition_Node::with_index()`.

    Three [`Admin\Admin`](../includes/admin/class-admin.php) statics are the admin half of the same contract.
    `enqueue_react_page()` is the registrar every consumer dashboard enqueues
    through, and returns null rather than enqueueing when the build is absent.
    `css_cache_version()` versions a stylesheet on its content hash, so a
    SCSS-only rebuild lands instead of serving from cache behind an unchanged
    `?ver=`. `overlay_pages()` collects the page slugs a
    bundle contributing an overlay tab must enqueue on, so an overlay embedded
    by one plugin still shows another's tab. The gate a consumer's own menu asks
    is `Capabilities::can( MANAGE )`, item 12 below. Nuclear-gyrobase calls
    `css_cache_version()` with no `class_exists()` guard, so withdrawing one is
    a fatal rather than a degradation.
11. **The cooperative stop.** [`Worker_Should_Stop`](../includes/class-worker-should-stop.php), its
    `Worker_Should_Stop_Clean` subclass, and the [`Deferred_Clean_Stop`](../includes/trait-deferred-clean-stop.php) trait's
    `guarded()`, `clear_pending_stop()` and `raise_pending_stop()`.
    [ADR-14](architecture-decisions.md#adr-14-cooperative-stop-propagates-through-broad-catches)
    obliges every broad catch on a consumer's drain path to name
    `Worker_Should_Stop` in an explicit first `catch` and re-throw it, so the
    class name is compiled into consumer code the substrate never sees. Moving
    that name fails SILENTLY: a `catch` on a class that no longer exists never
    matches, the broad `catch ( \Throwable )` behind it swallows the stop,
    nothing fatals, nothing logs, and the worker runs past its deadline.
12. **The capability gate.** The three role constants [`Capabilities::READ`](../includes/class-capabilities.php),
    `TUNE` and `MANAGE`, and the three entry points a consumer reaches them
    through: `can( $role )`, the boolean a menu, a REST `permission_callback`
    or a request-path decision asks; `require( $role )`, which throws the
    refusal `Command_Interpreter_Node::interpret()` wraps as
    TM_COMMAND|TM_ERROR; and `cap_for( $role )`, the WP capability a consumer
    hands `add_menu_page()` so its own pages open to exactly the holders the
    substrate admits. The constants are wire-adjacent rather than internal:
    every `capability` in a consumer's `node_schema()['commands']` is one of
    the three, and `Service_CI_Node` reads them out of the INSTALLED substrate.
    `can()` also applies the operator's `allowed_users` list, and returns false
    rather than throwing when the config behind that list will not load — a
    permission callback answers 403 instead of 500, and a `fill()` on the
    request path keeps [ADR-13](architecture-decisions.md#adr-13-fill-returns-nothing).

    `$session_scope` and the `NONE` constant go with them: a consumer
    authenticating its own credential installs the session's scope as a ceiling
    for one command, as event-logger-nodes' [`MCP_Controller`](https://github.com/Automattic/newspack-event-logger-nodes/blob/v0.96.0/includes/app/class-mcp-controller.php) does, and NONE is
    what a refusal installs. `highest_held()`, `scope_covers()` and
    `operator_list_excludes()` are the substrate's own and stay outside this
    contract.

Not frozen: any class, method, JS module, dashboard markup, SCSS or option name
absent from that list. The three `@newspack-nodes/*` build aliases — `runtime`,
`debug-overlay` and `shared` — and the React surface behind them move freely,
in a patch as readily as in a minor. A consumer resolves them at build time from its own pinned substrate
checkout, so that surface changes when the consumer bumps its pin, never when
the substrate ships. Item 2's reserved names are the one exception, and for
that same reason: a value compiled into an old bundle still has to answer a new
substrate.

## The version gap

![A timeline in three rows across substrate releases 2.41.0, 2.55.0 and 2.56.0. The substrate row shows locate_by's signature gaining an optional $wanted, the key set that bounds its index walk, defaulting to an empty array at 2.41.0, a bridge that reads nothing, and losing the default at 2.55.0. The consumer row shows event-logger-nodes' pin lagging until its next bump, then declaring version_at_least 2.56.0. The stale-call row shows a one-argument caller getting an empty result inside the window and an ArgumentCountError past it, with an arrow from the consumer's floor back to the retirement: the family's only caller has its floor past 2.41.0, so no build can reach the one-argument form and the bridge is out; inside the window lookup_multi() invoked the backing bare, so a throw there was a 500. Two cards below cover the floor mechanism, its method_exists guard and check-substrate-floor.sh as a lower bound, and the degrade-then-retire rule for a new parameter.](img/st-version-gap.png)

The substrate ships before its consumers, by necessity: a consumer pins a
substrate tag, so the tag has to exist first. The window where a host runs the
new substrate against a not-yet-updated consumer is therefore guaranteed, not
hypothetical, and two mechanisms cover it from opposite ends.

**A consumer declares its floor.** [`Bootstrap::version_at_least( $min,
$dependent )`](../includes/class-bootstrap.php) returns false and posts an admin notice, so a consumer built
against a newer substrate stays dormant instead of fataling mid-request. Guard
the call with `method_exists()`, as [event-logger-nodes](https://github.com/Automattic/newspack-event-logger-nodes/blob/v0.96.0/newspack-event-logger-nodes.php), intelligence and
cache-cozy each do. [`scripts/check-substrate-floor.sh`](../scripts/check-substrate-floor.sh) proves the floor covers
every substrate API the plugin calls, and is sound rather than complete: a
call resolved to a union, `mixed` or a dynamic name goes uncounted, so the
floor it reports is a lower bound.

**A new parameter degrades, and the default is a bridge.** Adding a
*required* parameter to a public method closes the window with a fatal, so a
new parameter ships with a default whose behaviour is safe and useless, and
that default comes out once every consumer's floor is past the release that
added it. [`Partition_Node::locate_by( \Closure $extract, array $wanted )`](../includes/class-partition-node.php)
is the worked case above: `$wanted`, the key set that bounds the index walk,
is required because event-logger-nodes is its only caller in the family and
floors at 2.56.0, past the 2.41.0 that added it.

## How a frozen name changes

A change to a name above lands in [upgrading.md](upgrading.md) in the same
commit as its CHANGELOG entry. What the list buys is a reference: a consumer
builds against prose instead of against the substrate's source.

It buys neither stillness nor an alias. No file in the tree carries
`@deprecated`: a hook, a CLI verb or a TSL node type is renamed or removed
with no alias and no shim, and its upgrading.md entry says so outright. The
three fail differently. A removed CLI target is refused by name and a renamed
TSL node type resolves no class at load; the hook is the quiet one — a
subscriber still on the old name is never called, and nothing says so.

A constructor argument or a route's required capability moves the same way, in
a minor: read upgrading.md before every minor upgrade, not only before a major.

Additive change — new verbs, new nodes, new hooks, new optional arguments — is
free, and earns a CHANGELOG line rather than an upgrading.md entry.

## Versioning

The numbering is semantic-versioning-shaped: patch is fixes, minor is additive,
and a major is a break too broad to migrate one entry at a time: a rule that
reaches every caller at once, such as the signature every command sent to
`/command` carries, which no per-name note can cover. A minor may still move a
frozen name, which is why the thing to read is upgrading.md, not the version
number.
