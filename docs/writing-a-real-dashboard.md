# Writing a *Real* Nodes Dashboard

[writing-a-dashboard.md](writing-a-dashboard.md) walked the happy path: a `Scorer` + a durable snapshot, a `Service_CI_Node` verb that reads it, a JS view node, a `useBatchedPoll` + `addSliceFetcher` poll hook, a thin React view, the build, the enqueue, the run. By the end you had **Publisher Insights** rendering live in wp-admin. If you haven't done that walkthrough, do it first — this guide assumes its vocabulary (`fill`/`sink`/`target`, `useNodeState`, `node_schema`, the `_http` boundary) and never re-explains it.

This is the companion that picks up where the toy stops: the **production realities** you hit shipping a dashboard *for real*. Not "here's another feature," but "here's what bit us." A standalone admin page is the easy case — the moment your nodes show up in the **Topology Console** and the **DevTools overlay**, the moment you `npm run release:archive`, the moment a designer asks for an icon, you're past the tutorial. Seven of these caught us; one shipped broken to a real WordPress version before we noticed.

> **The one thing to hold onto:** the toy guide's lesson was "compose primitives, don't build a framework." The production lesson is its mirror image — **the substrate's shared surfaces have contracts you didn't sign up for.** Your Service CI lands in a palette you didn't write. Your floating REPL lives inside a tab bar you didn't measure. Your `@wordpress/*` import becomes a WP enqueue handle that has to exist. Honoring those contracts is most of the difference between "works on my page" and "works everywhere the substrate puts it."

---

## 0. What changed since the toy

The toy dashboard was a closed loop: your page, your bundle, your one verb. A real dashboard leaks into shared substrate surfaces:

```
   your Service CI  ──appears in──>  the class catalog (Classes_CI `list`)
                                       │
                          ┌────────────┴────────────┐
                          ▼                          ▼
                    the Palette                 the Inspector
                  (drag to make_node)        (verb buttons per node)
                          │
   your REPL view  ──lives inside──>  DevtoolsTabHost (overlay | hub)
                                       │
   your bundle     ──externalizes──>  @wordpress/* → window globals → WP handles
```

The catalog feeds two surfaces. The overlay nests your console inside a tab bar. The build externalizes packages against WordPress's enqueue registry. Each of those is a seam where the toy's assumptions stop holding. We'll take them in the order they bit, and close on what the shipped dashboards do to stay fast under load.

---

## 1. Two surfaces, one catalog — the palette/inspector split

The toy's `Insights_CI` declared `'category' => 'Service'` and you moved on. Here's what that one string does.

`Classes_CI_Node::cmd_list` is the single catalog builder. It scans every registered composer classmap for concrete `*_Node` classes under a registered namespace, inlines the serializable half of each `node_schema()`, and — the line that matters — **drops a class on any of three conditions** (`includes/rest/class-classes-ci-node.php`):

```php
$cat    = $schema['category'] ?? '';
// (d) skip non-palette: Hidden, empty category, or hidden flag.
if ( 'Hidden' === $cat || '' === $cat || ! empty( $schema['hidden'] ) ) {
	continue;
}
```

`category: 'Hidden'`, no category at all, **or** an explicit `'hidden' => true` schema flag — any one removes the class from the catalog **entirely**. Each condition covers a different case. A class that declares nothing inherits `Node::node_schema()`'s empty-category default and drops out on the second (`SSE_Out_Node`, a pure HTTP response writer, never overrides `node_schema()` at all). The `hidden` flag is the escape hatch for a node that wants a real functional category yet still opts out of the palette — `SSE_In_Node` declares `'category' => 'I/O'` and `'hidden' => true`, because a patron node configures it programmatically.

"Entirely" is the gotcha, because that *same array* reaches two surfaces. `CatalogProvider` publishes it once as `classes`, and each surface reads it from context rather than down a prop chain (`src/topology-console/CatalogContext.js`):

```js
// In Palette.js — the draggable tiles.
const { classes, topologies } = useCatalog();
// In Inspector.js — the selected node's verb buttons.
const { classes: catalog, formatters, vaults, composeTargets } = useCatalog();
```

The Palette renders draggable class tiles from it. The Inspector renders a selected node's verb buttons by looking the node's class up in it (`src/topology-console/components/Inspector.js`, where `type` is `node.class`):

```jsx
const schema = catalog.find( ( c ) => c.shell_name === type );
const commands = ( schema && schema.commands ? schema.commands : [] ).filter(
	( spec ) => ! spec.hidden
);
const requests = schema && schema.requests ? schema.requests : [];
```

One array, two consumers. That coupling is the whole section: **`category: 'Hidden'` hides your class from the palette AND blanks its inspector verb buttons** — because the Inspector's `catalog.find()` comes back `undefined`, so `commands`/`requests` fall to `[]`. For a Service CI that's exactly backwards.

### Why a Service CI shouldn't be draggable

A Service CI like `Insights_CI` is **mounted** into every request graph (`make_node( 'Insights_CI', 'insights-demo' )` on `request_graph_ready` — toy guide §2). It is *never* `make_node`'d from the canvas. Dragging it from the palette would mint a stray second `insights-demo` node that nobody routes to — a duplicate with no purpose. So you want it gone from the palette. But you still want its verb buttons in the inspector: select the mounted `insights-demo` node, see its `counts` / `top` / `accumulated` buttons, fire one. Dropping it from the catalog kills both.

The substrate's answer is a **palette-only** filter, not a catalog drop. `Palette` keeps a `NON_DRAGGABLE_CATEGORIES` denylist — "categories the catalog carries that the palette must never offer", as its docblock puts it:

```js
const NON_DRAGGABLE_CATEGORIES = new Set( [ 'Service', 'Remote' ] );
…
const draggable = classes.filter(
	( c ) => ! NON_DRAGGABLE_CATEGORIES.has( c.category )
);
```

`'Remote'` rides the same rule for the same reason: a `Remote`-category node is wired in by the topology, not drag-minted from the canvas, so it stays catalog-resolvable but palette-undraggable.

The filter runs *inside the Palette*, on the way to rendering tiles. The catalog array the Inspector reads is untouched. So `category: 'Service'` is the correct declaration for a mounted CI: it stays in the catalog (inspector verbs resolve), but `NON_DRAGGABLE_CATEGORIES` strips it from the palette (no stray-duplicate drag). `category: 'Hidden'` is for nodes that should be invisible to *both* surfaces — spine plumbing like `SSE_Out_Node`, which is a pure HTTP response writer with no user-facing verbs at all.

The decision table:

| You want… | Declare | Mechanism |
|---|---|---|
| Draggable tile **and** inspector verbs (a normal transform/source) | `category: 'Transform'` (or `'Source'`, …) | in catalog, not denylisted |
| **No** tile, but **keep** inspector verbs (a mounted Service CI) | `category: 'Service'` | in catalog, palette-denylisted |
| Gone from **both** (spine plumbing, no user verbs) | `category: 'Hidden'` or omit | dropped from catalog by `Classes_CI` |

When your real dashboard's CI doesn't show its verb buttons, this is the first thing to check: did you reach for `'Hidden'` when you meant `'Service'`?

### The per-command flags, one level down

The class-level gate is coarse. Inside a class that made the catalog, `strip_commands()` projects each `commands[]` entry down to `{ name, description, args }` — dropping the non-serializable `handler` and the `capability` the base gate enforces server-side — and carries three flags forward:

| Flag | Who reads it | Effect |
|---|---|---|
| `hidden` | the Inspector | the verb keeps working; its button is not rendered |
| `multiple` | the topology editor | the verb may be invoked more than once, one row per invocation |
| `action` | the topology editor | the verb is an action, not configuration, so the editor omits it |

A malformed entry — a non-array, or one with no name — is skipped rather than allowed to throw, because one bad class must not fatal a catalog `list` that scans every registered class.

Five more catalog fields drive the console's own editors. A class declares three of them in its schema, inheriting `Node::node_schema()`'s defaults where it declares none; `Classes_CI` derives the other two from the class itself, so no schema can misstate them:

| Field | Where it comes from | What it decides |
|---|---|---|
| `accepts_fill` | the schema, default `true` | Whether the node takes an inbound message; the palette tile and the canvas both draw the IN port from it. |
| `has_target` | the schema, default `true` | Whether the node routes outbound at all; the inspector hides the Routing row without it, and the canvas gates its OUT port on the same answer. |
| `registrations` | the schema, default `[]` | Which register events the class accepts, which the inspector offers in its "Register a listener" modal. |
| `is_interpreter` | derived: the class extends `Command_Interpreter_Node` | Where §2's command buttons address — the node itself rather than its `:config` sibling. |
| `fans_out` | derived: the class uses the `Fanout_Targets` trait | Whether the target is a LIST, which makes the inspector render target chips instead of a single field. |

---

## 2. `node_schema['requests']` → the inspector's request buttons

The toy's `Insights_CI` declared a `commands` array and got command buttons. A real pipeline also has **runtime triggers** — the fire-and-forget `TM_REQUEST` verbs that drive the graph (the toy's §8 `TICK`). Those live under a *different* schema key, `requests`, and the Inspector renders them as a distinct button kind.

The real plugin's source nodes declare a `TICK` request through `Source_Node::source_schema()`, the shared helper every concrete connector merges into its own `node_schema()` (`newspack-intelligence/includes/class-source-node.php`):

```php
return \array_merge( parent::node_schema(), [
	'category'    => 'Source',
	'description' => $description,
	'requests'    => [
		[
			'name'        => 'TICK',
			'description' => $tick_description,
		],
	],
	'accepts_fill' => false,
] );
```

and the digest its `RESET` / `REGENERATE` requests (`newspack-intelligence/includes/class-digest-builder-node.php`):

```php
'requests'     => [
	[
		'name'        => 'RESET',
		'description' => 'Zero the collection counter (the dashboard Collect sends this before TICKing sources). `total` comes from the make_node argument, not this request.',
	],
	[
		'name'        => 'REGENERATE',
		'description' => 'Compose a new draft based on the items already collected.',
	],
],
```

None of these is a `TM_COMMAND` verb dispatched through the interpreter's verb table — they're `TM_REQUEST` triggers handled directly in the node's own `fill()` (`if ( $type & Message::TM_REQUEST )`). The schema split mirrors the wire split, and the Inspector keeps them visually distinct (`src/topology-console/components/Inspector.js`):

```jsx
<Section title={ __( 'Verbs', 'newspack-nodes' ) }>
	<div className="topology-insp__actions">
		{ commands.map( ( spec ) => (
			<VerbButton … kind="command" … />
		) ) }
		{ requests.map( ( spec ) => (
			<VerbButton … kind="request" … />
		) ) }
	</div>
</Section>
```

Empty both lists and the Verbs section returns `null`, which is how a `'Hidden'` category erases the whole panel rather than leaving an empty heading. Both button kinds are labelled with the bare verb name; the `kind` shows in the tooltip, which reads `Send TM_REQUEST <name>` for a request whose spec declares no description of its own. The kind also decides three things at dispatch (`src/topology-console/hooks/useGraphHandlers.js`):

| | `kind="command"` | `kind="request"` |
|---|---|---|
| Message type | `TM_COMMAND`, minted and signed by `_output` | `TM_REQUEST`, marked LOCAL and unsigned |
| Addressed to | `<node>:config`, unless the catalog's `is_interpreter` flag says the class *is* an interpreter, in which case the node itself | the node itself |
| Echoed in the transcript as | `command_node <target> <verb>` | `request_node <node> <verb>` |

So select your `releases` source in the console, hit the **TICK** button, and you've driven the pipeline from the canvas — the same trigger the toy guide typed as `request_node releases TICK` at the REPL, now a button. Declaring a `requests` entry is all it takes; the inspector wiring is free.

The takeaway for a real dashboard: your operator-facing **actions** (admin commands the CI answers) go in `commands`; your pipeline **triggers** (the runtime pokes that make data flow) go in `requests`. Both render, as different kinds, because they *are* different kinds on the wire.

---

## 3. Floating panels need *measured* ceilings, not viewport math

The toy view was a normal block in the admin content column — it scrolled with the page, no height math. A real REPL surface is different: the transcript pane can't grow past the canvas it floats over, and "the canvas" is a different height in every host. This is where a hard-coded `window.innerHeight − const` quietly goes wrong.

`ReplFooter` is deliberately dumb about its own ceiling. It accepts a `maxHeightPx` prop and, when set, prefers it over its viewport fallback (`src/topology-console/components/ReplFooter.js`):

```js
const ceiling = maxHeightPx ?? maxHeight();
```

Every consumer of the ceiling reads it that way — the drag, the keyboard nudge, the double-click-to-maximize and the re-clamp on window resize.

That fallback `maxHeight()` is the trap. It's `window.innerHeight − FIXED_CHROME_PX − RESIZE_HANDLE_OVERHANG_PX`, where the 6px overhang reserve keeps the handle from clipping and `FIXED_CHROME_PX` is a sum of magic constants:

```js
/**
 * Chrome the transcript can never occupy, in pixels: 32 for the WordPress
 * admin bar, 64 for the hub header, 40 for the tab bar and 38 for the prompt
 * bar. It is the pre-layout fallback alone — a consumer that has measured its
 * own panel passes `maxHeightPx`, which wins wherever it is given.
 */
const FIXED_CHROME_PX = 174;
```

It's correct *only* on a full-page console with exactly that chrome above it. The two hosts that mount a REPL each compute their own ceiling and pass it in.

**Host A — the full-page Topology Console.** It measures its `.topology-app` grid with a `ResizeObserver` rather than trusting the viewport (the `appRef` measure effect in `TopologyConsole.js`):

```js
const measureApp = useCallback( () => {
	if ( appRef.current ) {
		setAppHeight( appRef.current.offsetHeight );
	}
}, [] );
useEffect( measureApp, [ measureApp ] );
useContainerRefit( appRef, measureApp, [ measureApp ], 0 );
```

`useContainerRefit` is the shared hook every chart and canvas observes through, and §8 covers what it does under load. The argument that matters here is the last one: a `debounceMs` of `0` runs the callback in the observation itself — after layout, before paint — which is what a measurement wants.

It then derives the ceiling from the *measured* app height, subtracting only the grid's own rows (`replCeilingFromAppHeight` in `TopologyConsole.js`):

```js
const CONSOLE_REPL_BAR_PX = 38;
const CONSOLE_RESIZE_HANDLE_PX = 0;
export function replCeilingFromAppHeight( appHeight ) {
	if ( ! appHeight || appHeight <= 0 ) {
		return null;
	}
	return Math.max(
		REPL_MIN_HEIGHT_PX,
		appHeight - CONSOLE_REPL_BAR_PX - CONSOLE_RESIZE_HANDLE_PX
	);
}
```

Note what it *doesn't* subtract: there's no header term. The console grid is `grid-template-rows: 1fr 38px` — canvas and REPL bar, nothing else. The brand header belongs to the hub, above the tabs, so the console frame reserves no header row of its own. The handle term is `0` because the handle straddles the transcript's top border on absolute positioning rather than stacking above it, so it costs the transcript nothing; the term stays named so the ceiling reads as the sum of the chrome it accounts for. Returning `null` before layout is deliberate — the footer keeps its own fallback until there is a real measurement to hand it.

That measurement is also what keeps the ceiling honest under a moving frame: the console renders as a `fullBleed` tab **inside the DevtoolsTabHost tab bar** (`src/topology-console/tabMeta.js`), and the `window.innerHeight − FIXED_CHROME_PX` fallback cannot see that bar. Measure the container and the drift can't happen.

**Host B — the debug overlay's Console tab (`InspectorTab`).** Same disease, different frame. It measures *its own* tab bar instead of hardcoding it, and answers `0` where the host renders no bar at all (`src/debug-overlay/tabs/InspectorTab.js`):

```js
export function measureTabBarHeight( rootEl ) {
	const content = rootEl?.closest?.( '.nodes-devtools__tab-content' );
	const bar = content?.previousElementSibling;
	if ( ! bar?.classList?.contains( 'nodes-devtools__tabbar' ) ) {
		return 0;
	}
	return bar.offsetHeight;
}
```

and folds that measurement into its ceiling (`replMaxHeight` in `InspectorTab.js`):

```js
export function replMaxHeight( frameHeight, tabBarHeight = 0 ) {
	// -4 reserves the resize handle so full height doesn't clip it.
	return Math.max( 80, frameHeight - 64 - 38 - tabBarHeight - 4 );
}
```

Three nuances are worth lifting out of that body. First, the `- 4` **reserves the resize handle** so full height doesn't clip it; the console passes `0` there, for the reason given above. Second, the prompt bar it subtracts is `38` because the transcript's CSS anchor sits at `bottom: 38px` — the bar's *actual* rendered height, not the round `40` you'd guess (`.topology-repl__transcript` in `src/topology-console/styles/graph-view.scss`). Get that number from the CSS, not from intuition. Third, this path hardcodes the panel header (`64`) and the bar (`38`) but *measures* the tab bar, so the ceiling stays honest if the bar wraps to two rows.

Each helper takes its input as an argument — an element for the measurement, two numbers for the arithmetic — rather than reading it off the component, so both are assertable without mounting the tab.

The pattern, stated once: `ReplFooter` is a pure consumer of `maxHeightPx`; **each host measures its own frame and hands the floor in.** A floating panel never knows its own bounds from the viewport — it knows them from the box it's mounted in. If you build a third REPL surface, you measure, you don't guess `window.innerHeight − 174`.

---

## 4. The `@wordpress/icons` build gotcha (the one that shipped broken)

The toy build "just worked" because it imported only `@wordpress/element`, `@wordpress/i18n`, and `@wordpress/api-fetch` — packages WordPress genuinely exposes as runtime scripts. The first time a real dashboard reaches for an **icon**, the build kit's externalization model breaks in a way that's invisible until runtime.

`buildDashboards` rewrites every `@wordpress/*` import to a `window` global and records the matching enqueue handle in `*.asset.php` (toy guide §6). The map that drives it is `WP_EXTERNALS` (`src/build-kit/index.mjs`). Look at what's conspicuously *absent*, and at the docblock explaining why:

```js
/**
 * Import specifier → the window global that supplies it at runtime and the
 * WordPress enqueue handle that guarantees the global is there.
 *
 * WordPress already serves these packages, so bundling a second copy ships
 * dead bytes, and a second React breaks hooks outright. `@wordpress/icons` is
 * absent deliberately: it publishes no runtime global, so a consumer importing
 * it bundles the icons it uses.
 */
export const WP_EXTERNALS = { … };
```

The failure mode is a clean two-stage trap. `@wordpress/element` and `@wordpress/i18n` are runtime scripts: WP serves them, registers `wp-element` / `wp-i18n` handles, and `window.wp.element` exists. `@wordpress/icons` is **not** that — it's a *build-time* package of SVG-as-React-components. WordPress ships no `window.wp.icons` global and registers no `wp-icons` script handle. So if you'd naively added it to `WP_EXTERNALS`:

1. **At runtime:** esbuild rewrites `import { chartBar } from '@wordpress/icons'` to read `window.wp.icons.chartBar` — which is `undefined`. Your icon renders nothing, no error at build time.
2. **In wp-admin:** the `*.asset.php` lists `wp-icons` as a dependency WordPress can't satisfy, and WP logs *"dependencies that are not registered: wp-icons."*

The fix is the absence itself: **omit `@wordpress/icons` from `WP_EXTERNALS` so esbuild bundles it** from `node_modules` like any ordinary library. The icon's SVG ends up inlined in your bundle (esbuild already loads `.svg` and `.png` as `dataurl` — `index.mjs`), `window.wp.icons` is never read, and the `.asset.php` no longer lists the phantom `wp-icons`.

The general rule for any package you're tempted to add to that map: **only externalize packages WordPress registers as runtime scripts.** The map holds ten entries — `@wordpress/element`, `-api-fetch`, `-components`, `-blocks`, `-block-library`, `-i18n`, `-data`, plus `react`, `react-dom`, and `react/jsx-runtime` — and WP serves every one. Everything else is bundled for the same reason the icons are: `d3`, which the shared time charts draw through, and `@noble/hashes`, which the runtime's command signer needs synchronously, publish no WordPress global either. Treat the `WP_EXTERNALS` map as a closed set you extend only with proof WP registers the handle.

---

## 5. The DevTools tab host, the hub, and the tab registry

Sections 0 and 3 kept referring to "the overlay" and "the hub." Here's the shared machinery; the files carry the detail.

The center of it is **`DevtoolsTabHost`** (`src/shared/devtools/DevtoolsTabHost.js`) — one component, two hosts. It reads the tab registry for a given `host`, renders a tab bar (hidden when ≤1 tab), and **lazily mounts only the selected tab**, keyed on the active id so each tab's build-before-render runs fresh on switch:

```jsx
<Active key={ active.id } { ...tabProps } host={ host } />
```

The routing `host` is applied *after* `tabProps` spreads, so a caller cannot hand a tab the wrong surface even by putting `host` in `tabProps`.

A tab is a descriptor in the registry (`src/shared/devtools/tabRegistry.js`). `id`, `label`, `host` and `component` are required; `order`, `slug`, `param`, `gate`, `icon` and `fullBleed` are optional:

| Field | Contract |
|---|---|
| `id` | The registry key. Registering it again **shadows** the holder rather than adding a second tab. The key space is not partitioned by host, so ids must be globally distinct — the overlay's Overview is deliberately `io-overview`, because reusing the hub's `overview` would replace that descriptor and leave the hub with no Overview at all. |
| `host` | `overlay`, `hub` or `both`. A read asks for `overlay` or `hub` and gets the `both` tabs as well. |
| `order` | Sort weight, ties broken alphabetically by label. |
| `slug` | Deep-link slug (`?tab=<slug>`); defaults to the id. |
| `param` | A query param the tab owns, such as `topology` or `log`; the host clears it while another tab is active. |
| `gate` | Excludes the tab while it returns false, evaluated per read. |
| `fullBleed` | The tab owns a full-height canvas, so the host adds `.is-full-bleed` to the `.nodes-devtools__tab-content` pane, opting it out of that container's default vertical scroll. |

That `fullBleed` flag is exactly why §3's console-in-the-hub needs the measured ceiling: it fills the frame, and the default container would wrap its self-scrolling canvas in a second outer scrollbar.

The registry lives on `window.__newspackNodesDevtoolsTabs`, not in module scope. Each tab-bearing bundle is its own IIFE and inlines the module, so a module-local Map would give the hub page one registry per bundle — the host would read its own empty copy while three bundles registered into theirs.

The two hosts are thin wrappers around it:

- **The floating overlay** mounts tabs with `host="overlay"` — the substrate registers Overview and the Console tab from §3 (`src/debug-overlay/tabs/index.js`), and a consumer adds its own: event-logger-nodes contributes `eln-current-request`, labelled Request.
- **The full-page hub** (`src/devtools-hub/DevToolsHub.js`) mounts `host="hub"` inside a `position: fixed`, full-height admin container positioned against `useAdminMenuWidth()`, so a full-screen canvas tab gets usable height. It also passes `syncUrl`, which makes the host own the page's query string: the initial tab comes from `?tab=<slug>`, the resolved tab is mirrored back through `replaceState`, and each tab's declared `param` survives only while that tab is showing. And it gates the floating overlay's REPL off the Console tab — a second overlay REPL there would collide on the shared `_output` infra.

### Registering a tab, and shipping it lazily

You register a tab by filtering into **`newspack_nodes/devtools_tab_bundles`** (the PHP analogue of the toy's CI mount). The filter takes a list of bundle descriptors, each `{ handle, dir, url, localize?, lazy? }`; `Admin::enqueue_devtools_tab_bundles()` runs on the hub page alone and skips any entry missing `handle`, `dir` or `url`. Importing the bundle is what registers the tab, so PHP never names one.

`lazy: true` is the knob that matters at production size. The substrate's four heaviest hub tabs — Console, Vault, Sessions and Aggregator — ship on tab click rather than page load. Each registers a **placeholder** carrying the same descriptor the real bundle spreads, kept in its own `tabMeta.js` so importing it pulls a label string and no component tree:

```js
// src/vault/tabMeta.js — every field of the tab except the component.
export default {
	id: 'vault',
	label: __( 'Vault', 'newspack-nodes' ),
	host: 'hub',
	slug: 'vault',
	order: 30,
};
```

`src/vault/tabs.js` spreads that same object with its component; `devtools-hub/lazyTabs.js` spreads it into the placeholder. Label, order, slug and `fullBleed` therefore resolve identically before anything loads, and on first activation the arriving bundle's own `registerDevtoolsTab` shadows the placeholder by id rather than adding a second tab beside it. Two spellings of the descriptor would rename, reorder or duplicate the tab the moment the bundle lands.

If your real dashboard genuinely *is* a Nodes-internal tool rather than a standalone page, this is where it belongs — a `host: 'hub'` tab, split into `tabMeta.js` + `tabs.js`, declared `lazy` — instead of the toy guide's standalone `add_menu_page`.

---

## 6. Where the API credentials go — the Vault, not a page you build

The most production-real surface of all — **where do the API credentials go?** — is one you *don't* write. The substrate already ships it: the **Vault**, a built-in DevTools-hub tab at `admin.php?page=newspack-nodes-hub&tab=vault`, not a WordPress Settings-API page and not a React tree you have to author.

The Vault is a real hub tab (`src/vault/`, registered `host: 'hub'` / `slug: 'vault'` through the `newspack_nodes/devtools_tab_bundles` filter as a lazy bundle) — a thin `VaultAdmin` view over the `Vault_CI_Node` credential store (`includes/rest/class-vault-ci-node.php`). Secrets persist server-side in the `newspack_nodes_vault` option and are **never** returned to the browser: `list` and `get` both project through one `public_shape()` that hands back `{ id, url, auth_username, has_credentials, is_config }` and nothing else. The username rides along because it is half an address rather than a secret, and an edit form cannot offer to change what it cannot show — which is why leaving the password field blank means "keep the stored one". That disclosure holds only while every Vault verb is `manage`; declaring one `read` would widen it.

Your topology only *references* an entry. A source node carries a `set_vault_id` verb — its argument is `'type' => 'vault_id'`, which `CtorField` renders as a Vault dropdown — and resolves that id to the raw secret at `config()` time through the `Vault_Secret` trait (`newspack-intelligence/includes/class-github-source-node.php`: `cmd_set_vault_id` → `resolve_vault_secret`). Non-secret per-source config rides sibling verbs on the same node (`add_repo <owner/name>`, `add_url <feed>`), never the Vault, and each writes a round-trippable `config_line()` so the topology dumps back exactly as it was built.

So the split is: **the operator enters the secret in the Vault tab; the topology points at it.** When the right surface is credentials, reach for the Vault entry + a `set_vault_id` reference — not a hand-rolled settings form and not a React page. The full credentials-in-the-Vault / config-in-the-topology model is [writing-a-real-plugin.md](writing-a-real-plugin.md) §4; here it's the reminder that the credential surface is a tab you already have.

---

## 7. Build & deploy realities

The toy ran `npm run build` and `wp nodes status` and called it done. Shipping for real has a handful of sharp edges around that.

**`release:archive` bundles `build/`, not `src/`, with an optimized autoloader.** The release zip carries the *built* `build/dashboard/index.js` (and its `.asset.php` / `.css` / `-rtl.css`), a `composer install --no-dev --optimize-autoloader` autoloader, and none of `src/` or `tests/` — `.distignore` names both. So your `npm run build` output is the artifact; if you didn't build, the zip ships stale JS.

**The setup scripts install a PREBUILT zip — they don't build.** This is the one that silently runs old code. `newspack-nodes.sh` and `newspack-intelligence.sh` `wp plugin install` the existing `release/*.zip`; neither runs esbuild. So the deploy loop is **`npm run release:archive` first, then the setup script** — otherwise `wp nodes` runs the previous build, and PHPUnit (which runs from the `/services` source mount) won't catch it, because the source on disk *is* current. Only the deployed copy is stale.

**A shared-source edit fans out to every consumer bundle.** The `@newspack-nodes/*` surface is three aliases, all resolved from one base by `src/build-kit/alias-map.cjs`:

| Alias | Resolves to |
|---|---|
| `@newspack-nodes/runtime` | `src/runtime/index.js` |
| `@newspack-nodes/debug-overlay` | `src/debug-overlay/DebugOverlay.js` |
| `@newspack-nodes/shared` | `src/shared` (a directory; subpaths append) |

Everything reached through them is *inlined* into each consumer's bundle at build time — there is no shared runtime script. `src/build-kit` is the fourth shared tree and is not an alias at all: a consumer's `scripts/build.mjs` and `jest.config.js` load it by real path. Either way, editing `ReplFooter`'s ceiling logic or `WP_EXTERNALS` means rebuilding **and redeploying every consumer** — `newspack-nodes` itself, `newspack-event-logger-nodes`, `newspack-intelligence`, and the in-repo example — or the un-rebuilt ones ship the old inline copy. The toy's single bundle hid this; a real change to the shared kit doesn't get that luxury.

**`src/build-kit/index.mjs` exports five names, and your `scripts/build.mjs` calls one.** `buildDashboards()` is that one. The other four serve it, and the kit exports them so its own tests can reach them (`src/build-kit/__tests__/buildKit.test.js`); the `esbuildAlias` and `assertNoRetiredOverrides` your script also loads come from `alias-map.cjs` beside it:

| Export | What it does |
|---|---|
| `buildDashboards( opts )` | Builds — or, under `watch`, keeps rebuilding — every entry, one esbuild context each. The one export a consumer calls. |
| `WP_EXTERNALS` | §4's specifier → `{ global, handle }` map, driving both the import rewrite and the `.asset.php` dependency list. |
| `substrateVersion()` | Returns the `SUBSTRATE_VERSION` literal the kit stamps as every bundle's `/* @newspack-nodes <version> */` banner, so a deployed bundle names the substrate it was built against. `scripts/bump-version.sh` rewrites it alongside the plugin header, the `NEWSPACK_NODES_VERSION` constant and `package.json`. |
| `assertAliasPathsExist( alias )` | Throws on the first alias pointing nowhere, naming that alias and `NEWSPACK_NODES_SRC`. `buildDashboards()` calls it before esbuild starts, which is what turns a bad checkout into a fixable message instead of an `ERR_MODULE_NOT_FOUND` from deep inside a resolve. |
| `emitAssetPhp( handles, version )` | Renders the `<base>.asset.php` manifest, sorted and deduped, so it changes only when the dependencies do. The `version` it stamps is a content hash of the emitted JS, so a rebuild that changed nothing leaves the tracked `build/` tree alone. |

**One env var names the substrate, and the retired four are refused.** A consumer's release workflow checks the substrate out and points `NEWSPACK_NODES_SRC` at its `src`; every alias and the kit path derive from that. `assertNoRetiredOverrides()` throws when `NEWSPACK_NODES_RUNTIME`, `_DEBUG_OVERLAY`, `_SHARED` or `_BUILD_KIT` is set — refused rather than ignored, because a stale override that silently does nothing is how a release builds against the wrong checkout and still goes green.

**Pin your own dependencies, or a dev build ships two copies of one.** `NEWSPACK_NODES_SRC` moves the substrate; it does not move where a bare import resolves. Aliased substrate source importing `d3` (the shared time charts) or `@noble/hashes` (the command signer) resolves it from the substrate's own tree first, and `nodePaths` is the fallback esbuild reaches only after that fails. In CI the substrate is a dependency-free checkout, so the fallback finds your copy; in a dev checkout the sibling has `node_modules`, so esbuild bundles a second copy under a different absolute path — 88KB of duplicate d3 in event-logger-nodes' overview bundle. Both standalone consumers close it with the same loop over the dependencies they declare, reading `package.json` and writing into an `alias` binding they lift out of the `buildDashboards` call (`newspack-event-logger-nodes/scripts/build.mjs`, verbatim in `newspack-intelligence`). Two edits make the standalone script in [writing-a-dashboard.md](writing-a-dashboard.md) §6 take that loop: widen its `node:fs` import to `import { existsSync, readFileSync } from 'node:fs';`, and bind the alias map above the call as `const alias = esbuildAlias( SUBSTRATE_SRC );` so the call can pass `alias` where it now inlines that projection.

```js
for ( const dep of Object.keys(
	JSON.parse( readFileSync( path.join( ROOT, 'package.json' ), 'utf8' ) )
		.dependencies || {}
) ) {
	// `@wordpress/*` is externalised by a plugin; a path alias would defeat it.
	if ( ! dep.startsWith( '@wordpress/' ) ) {
		alias[ dep ] = path.resolve( ROOT, 'node_modules', dep );
	}
}
```

`@wordpress/*` skips the loop because those specifiers belong to §4's externals plugin, which matches the bare name: alias one to a path and the bundle carries a copy of a package WordPress already serves. The in-repo example needs no loop — it declares no `d3`, and its `nodePaths` names the substrate's own `node_modules`, so one tree answers every bare import. [writing-a-dashboard.md](writing-a-dashboard.md) §6 hands you that example's script, so a standalone plugin that changes only `SUBSTRATE_SRC` builds green and ships the duplicate.

**Mounting the debug overlay needs more jest config than the toy showed.** [writing-a-dashboard.md](writing-a-dashboard.md) §6 hands you a 2-key `createJestConfig` (`aliasBase` + `pinReactFrom`) — enough for the toy's thin view. But the moment you follow its §9 and mount `<DebugOverlay>` in your dashboard, jest has to resolve what the overlay drags in, and `d3` is the one that bites: the overlay's `OverviewTab` pulls it in transitively through `TopicsChart`, and it ships ESM-only. Give `extraMappers` an entry for every module jest must resolve outside your own `node_modules` — `newspack-intelligence` installs `d3` and maps `^d3$` at its own tree, while the in-repo `examples/example-ai-newsletter/jest.config.js` installs no `d3` at all and maps it, along with `@wordpress/api-fetch`, at the substrate's. Add a `transformIgnorePatterns` alongside that opts d3's ESM packages out of the transform skip.

**Restart workers after deploy.** Otherwise the running worker process holds the old class for up to ~10 more minutes; `wp nodes restart …` (per the env's restart verbs) makes the new node code live.

**The `_Demo` suffix is a deconfliction tactic, not decoration.** The in-repo teaching example (`examples/example-ai-newsletter/`) names its classes `Scorer_Demo_Node`, `Insights_CI_Demo_Node`, `Releases_Source_Demo_Node`, … while the real plugin uses bare `Scorer_Node`, `Insights_CI_Node`, and so on. Both can be active at once, and §1 showed the catalog scans *every* registered namespace — so without the suffix the toy's `Scorer` and the real plugin's `Scorer` would collide on one palette tile and one inspector lookup (`shell_name === 'Scorer'` matching two classes). The `_Demo` suffix gives the example its own `Scorer_Demo` shell name, keeping the two pipelines distinct in the one shared catalog. If you ship an example alongside a real plugin, suffix the example.

### What `@newspack-nodes/shared` holds

The alias resolves to a directory with no index, so every import names a subpath. The map below is the whole of that directory: one row per module, its exported names, and what it is for. [stability.md](stability.md) puts this surface outside the frozen set — a consumer resolves it at build time from its own pinned substrate checkout, so the table says what is there, not what stays. Read it before writing a primitive of your own; §8 covers what several of these cost under load.

| Module | Exports | What it is |
|---|---|---|
| `errorMessage` | `errorMessage` | The readable text behind a TM_ERROR reply, including the wording for a payload carrying nothing. |
| `rateSmoother` | `RateSmoother` | Windowed average plus EMA behind every per-second readout, because a raw delta between two samples reads as a burst or a zero. |
| `theme` | `applySkin`, `initSkin`, `resetSkin`, `getStoredTheme`, `isValidTheme`, `THEMES`, `DEFAULT_THEME`, `THEME_STORAGE_KEY`, `SKIN_EVENT` | Skin storage and application. One `theme-<slug>` class on `<html>` is the whole skin state, so no two surfaces on a page can disagree. |
| `components/ColumnPicker` | `ColumnPicker` (default) | The checkbox row a "Cols" toolbar button reveals; `useColumnPicker` owns the selection it edits. |
| `components/ConnectionBanner` | `ConnectionBanner` (default) | The polite live-region banner a dashboard renders while its transport is down. |
| `components/HeaderSlot` | `HeaderSlot` | A dashboard's own controls, portalled into the host's shared header or rendered inline where no host offers a slot. |
| `components/LogBrowser` | `LogBrowser` (default) | The Live/Replay browse rail; both log-stream dashboards drive it as a segment browser. |
| `components/LogListHeader` | `LogListHeader` (default) | The column-header row capping a log pane, sized from the same cell classes as the rows. |
| `components/LogRowList` | `LogRowList` (default), `DEBUG_MAX_ROWS` | §8's ring-aware virtualized row list, plus the cap on the un-virtualized debug regime. |
| `components/LogStreamViewer` | `LogStreamViewer` (default), `debugValue` | The chrome every log-stream dashboard wears: toolbar, reconnect banner, browse rail and row list. |
| `components/Modal` | `Modal` (default) | The plain-DOM dialog shell carrying the canonical `.newspack-nodes-modal` role, dismissed through `useDismissable`. |
| `devtools/DevtoolsTabHost` | `DevtoolsTabHost` (default) | §5's one tab host, behind both the floating overlay and the full-page hub. |
| `devtools/tabRegistry` | `registerDevtoolsTab`, `getDevtoolsTabs`, `getDevtoolsTabsVersion`, `subscribeDevtoolsTabs`, `resetDevtoolsTabs` | §5's registry on `window`: a bundle registers at import time, the host reads and subscribes, and a test resets. |
| `helpers/addSliceFetcher` | `addSliceFetcher` | One dashboard slice wired in one call, with the Fetcher connected last (§8). |
| `helpers/controlMsg` | `controlMsg`, `isControl` | The one minter of a view node's control message, and the recognizer that admits what it mints. |
| `helpers/egressPath` | `egressPath` | The TO path a browser-minted command travels: the observe-only `_shell` Tap, the `_http` egress, then the server CI. |
| `hooks/useAdminMenuWidth` | `useAdminMenuWidth` (default) | The WordPress admin menu's width as a number, so a fixed-position UI sits flush against a menu that folds. |
| `hooks/useAskPicker` | `useAskPicker`, `ASK_TRIGGER_ATTR`, `ASKING_CLASS` | Ask-about-this-element picking off one `data-ask` attribute; the attribute and class are exported because the shared SCSS and a consumer's trigger button name them too. |
| `hooks/useBatchedPoll` | `useBatchedPoll`, `useCatalogSlice` | §8's poll backbone — exospine mount, fan-out Tee, hitchhiking Timer, visibility gate — and the catalog slice whose next tick is its retry. |
| `hooks/useColumnPicker` | `useColumnPicker`, `gridTemplate` | A table's persisted visible-column set, and the CSS grid track list that lays it out. |
| `hooks/useCommandOnce` | `useCommandOnce` | One verb sent exactly once per call on the batched tick, its reply landing on the hook's own result node. |
| `hooks/useContainerRefit` | `useContainerRefit` | The resize hook of §3 and §8: debounced by default, `0` for a measurement, and deaf to the observation for the box it just drew. |
| `hooks/useDeepLinkedSelection` | `useDeepLinkedSelection` (default) | A picker's `?param=` contract: seed the selection once from the URL, then reflect every user pick back into it. |
| `hooks/useDismissable` | `useDismissable` | ESC and mousedown-outside, the two ways every dialog closes besides its own button. |
| `hooks/useLogPositions` | `useLogPositions` (default), `useLogStatusSegments`, `useSegmentBrowse`, `segmentPositions`, `replayPositions`, `stepPosition` | The browse model both log-stream dashboards share, expressed as the SSE `positions` seed their stream URL already carries. |
| `hooks/usePageVisibility` | `usePageVisibility` (default) | The one read of tab visibility every substrate poller gates on. |
| `hooks/usePersistedState` | `usePersistedState`, `usePersistedChoice` | A preference that outlives the page: read the key, validate what came back, fall back, write it again. |
| `hooks/useRouterTick` | `useRouterTick` (default) | "Call me on the router heartbeat", for any React poller — a passenger on a backbone another mount owns. |
| `hooks/useStreamGraph` | `useStreamGraph`, `useSteppedRead`, `useLogCatalog` | A streaming dashboard's whole graph (link, stream Tee, view), the one-record stepped read, and the polled subscription catalog. |
| `hooks/useTimeChart` | `useTimeChart`, `openFrame`, `drawAxes`, `drawLegend`, `setupTooltip`, `buildTimeSlots`, `formatXTick`, `MARGIN`, `PALETTE`, `BUCKET_MS`, `BUCKET_SECONDS`, `BUCKET_MINUTES`, `NUM_BUCKETS`, `DEFAULT_RETENTION_SECONDS` | The one d3 frame every dashboard time chart is drawn on; a caller owns its marks and nothing else. |
| `hooks/useVirtualization` | `useVirtualization` (default) | Row-window math for a long list, measured against whichever element actually scrolls. Its scroll state lands in React, which is why `LogRowList` reads geometry live instead. |
| `nodes/catalog-list-view-node` | `CatalogListViewNode` | The slice view holding a picker's catalog; `useLogCatalog` is its only builder. |
| `nodes/command-result-node` | `CommandResultNode` | Where a one-shot command's reply lands. Every reply publishes and notifies, refusals included — the opposite of a slice. |
| `nodes/log-stream-view-node` | `LogStreamViewNode` | The view-node base under every log-stream dashboard: the 100 000-row ring, the paused belt and step budget, the decaying rate readout, seek tracking and the shared control verbs. |
| `nodes/seekTracker` | `SeekTracker`, `browseControl`, `LIVE`, `REPLAY` | Node-side seek and position tracking, derived from each record's `segment:offset:length` breadcrumb. |
| `nodes/slice-view-node` | `SliceViewNode`, `sliceView`, `registerSliceViews` | The per-widget view-node base a dashboard's slices extend, its declarative factory, and the name registration a TSL or palette surface needs ([ADR-16](architecture-decisions.md#adr-16-js-node-class-resolution--names-are-the-tsl-surface-classes-are-the-api)). |
| `test-utils/fakeCommandWire` | `installFakeCommandWire`, `makeFakeCommandWire`, `answerBatch`, `commandReply` | A `/command` server double whose seam is the wire, so pack/unpack, HttpOut, the Router and the interpreter all run for real. |
| `test-utils/fastClock` | `runClockFast` | The substrate clock run faster than the wall clock, so a test reaches the next poll boundary instead of waiting it out. |
| `utils/answerStatus` | `answerStatus` | An answer as the line a row or form shows for it: working, failed with this text, or succeeded. |
| `utils/axis-ticks` | `axisDuration`, `binaryTicks`, `integerTicks` | Ticks and units for a value axis, so a byte axis ticked in base 10 never reads "977 KB". |
| `utils/buttonClass` | `primaryButtonClass` | The one composition of a confirm button's class list, disabled state included. |
| `utils/fnv1a` | `fnv1a` (default) | The 12-character URL identity this port shares with PHP's `Log_Manager::url_hash()`; the two agree on ASCII. |
| `utils/formatters` | `formatBytes`, `formatByteRate`, `formatMsgRate`, `formatCount`, `formatAge`, `formatEta`, `formatEtaSeconds`, `etaSeconds`, `compactFixed` | The presentation formatters, so no two surfaces disagree about what 881869 bytes reads as. |
| `utils/formatUtils` | `formatDuration`, `formatLocalDateTime`, `formatTime`, `getDurationClass`, `getDurationColor`, `getStateColor`, `getStatusCategory`, `getStatusClass`, `getStatusColor`, `getTextColor`, `hexToRgba`, `STATUS_COLORS` | The shared color and readout vocabulary. Every color is a literal hex and skin-independent, because these paint fills; the text colors that follow the theme live in the SCSS tokens. |
| `utils/parseOffsetJump` | `parseOffsetJump` (default) | The grammar behind the Jump box, whose three-part form is a message ID verbatim. |
| `utils/queryParams` | `getQueryParam`, `setQueryParam` | The `?param=` deep-link surface, written so setting one param preserves every other. |
| `utils/storage` | `readStorage`, `writeStorage` | `localStorage` without the try/catch at every call site; both absorb the failure and leave the caller on its default. |

Two things in `src/shared/` sit off that table. `styles/` holds twelve SCSS partials — the tokens, the mixins, the focus rules, and the component roles for buttons, controls, the toolbar, the modal and a field scope — and SCSS reaches them through the same alias: `@forward "@newspack-nodes/shared/styles/tokens"` resolves because the build kit's Sass importer swaps the prefix for its absolute path, Sass never having seen esbuild's alias map. Never import one of those partials from JavaScript through the alias — jest's `^@newspack-nodes/shared/(.*)$` mapper matches ahead of its style mock, and babel then parses SCSS as JS — which is why a shared component imports its own stylesheet by relative path. `test-utils/` belongs to a consumer's jest suite rather than its bundle, and `fakeCommandWire` is the most-imported subpath across the substrate and its consumers.

---

## 8. What the shipped dashboards do to stay fast

The toy polls three verbs and renders three numbers, so nothing it does can hurt. The substrate's own dashboards replay 24 hours of probe records, window a 100 000-row log ring under flood, and redraw d3 panels on every tick. Nine patterns carry that load, and each is a primitive you get by reaching for the right hook rather than a knob you tune afterwards.

**A poll cadence has a floor of 1000 ms, and it is a `TypeError` below it.** `useBatchedPoll` requires `intervalMs >= 1000` (`src/shared/hooks/useBatchedPoll.js`) because 1000 ms is `TimerNode`'s router-hitchhike threshold. The batch **is** the lock/flush bracket the Router puts around `notifyTimer`, so only a hitchhiking timer sits inside it; a sub-second value takes its own `setInterval` slot firing outside the bracket, which is one POST per slice per tick and no batch at all. Above 1000 ms the timer throttles against the shared wall-clock grid ([ADR-17](architecture-decisions.md#adr-17-timers-fire-on-a-shared-wall-clock-grid)), so two surfaces on one cadence meet on the same tick and share the POST. Sub-second work belongs to `useRouterTick`, which is a passenger on somebody else's backbone.

**A surface nobody is looking at costs nothing.** Three gates, in ascending order of thrift: `usePageVisibility` stops the hitchhike while the tab is hidden; `paused` suspends an open surface — a drag in flight — while still delivering the one first load it owes; `enabled: false` owns nothing at all, no request and no named node. The three catalog hooks (`useClassCatalog`, `useTopologyList`, `useVaults` in `src/topology-console/hooks/useCatalogs.js`) all default to `enabled: false`, so every caller opts a catalog in deliberately: the console holds its classes and vaults open, hands the OPEN dialog's topology list `enabled: openModalShown`, and the overlay's Console tab enables its class catalog only once it has a cwd.

The same gate is worth more on a **streaming** dashboard, where it frees a scarce server resource rather than a request. An SSE stream occupies one php-fpm child for its whole life, so the substrate caps concurrent streams in a slot pool. `useStreamGraph` (`src/shared/hooks/useStreamGraph.js`) opens the stream only while the tab is visible and the user has not paused, and routes pause down the same close path as the visibility gate — so pausing returns the slot, and a paused stream stays closed through hide and show. [sse-host-budget.md](sse-host-budget.md) carries the arithmetic behind the bounds.

**A catalog is a slow slice, and the tick is its retry.** `useCatalogSlice` defaults to a 30 000 ms cadence (`CATALOG_MS` in `src/shared/hooks/useBatchedPoll.js`). A refusal needs no latch and no memoized promise, because the next tick asks again — which is also how a session that turns over recovers without a reload. A bad tick keeps whatever is already on screen, since an empty palette is the worse answer.

**Tee fan-out order is contractual, and the Fetcher goes last.** `addSliceFetcher` connects the receiver Tee to the transform-or-view first and the Fetcher second (`src/shared/helpers/addSliceFetcher.js`): a consumer that acts once per ANSWER asks `isAsking()` as the reply renders, and a settled ask is gone by then. Reverse the two and the view sees a Fetcher that already forgot what it asked.

**Publish is throttled, the series is bounded twice, and the key set is bounded once more.** `ProbeStreamViewNode` (`src/event-dashboards/nodes/probe-stream-view-node.js`) — the shared base under `TopicProbeViewNode` and `JobstatsViewNode` — throttles `setState('view', …)` to `PUBLISH_THROTTLE_MS` 500 (leading + trailing), so a 24-hour replay burst doesn't thrash React. One key's series is bounded by a hard ring cap (`MAX_SAMPLES` 5761, one 15-second sample per slot over the 24-hour `RETENTION_S`) and by the live window, which drops a record older than retention on arrival. The set of keys is bounded by a liveness TTL (`ENTRY_TTL_MS` 300000, measured by arrival rather than record timestamp), which evicts a key that stopped reporting — and a fill arriving more than one TTL after the last one shifts every lease forward instead of evicting, because that gap is a hidden tab rather than a dead key. Folding a record costs one push and a sweep of the live keys; every walk waits for a publish. `SettingsAuditViewNode` caps at 5000 entries on the same 500 ms throttle, and `PartitionViewerViewNode` clips a record's `content`/`value` at 1000 characters and its `raw` at 262 144.

**Filter at ingest, not at render.** `LogStreamViewNode` (`src/shared/nodes/log-stream-view-node.js`) runs `matchesFilter()` before a shaped row enters the ring, so the ring holds only what is displayed and the list windows straight off it. A rejected row still moves the seek breadcrumb, because the stream really did advance past it and the rail reports position rather than matches.

**Per-frame work is bounded by the viewport, not by the input rate.** `LogRowList` (`src/shared/components/LogRowList.js`) reads a ring-backed view node through `linesCount` + `lineAt( i )` — both O(1), newest first — and pulls only the on-screen window each animation frame, so a 100k-row ring costs O(rows on screen) per frame and the rows never become React state. Three details make that survive a flood:

- The window bounds come from scroll geometry read live *inside* the frame, not from `useVirtualization`, whose deferred scroll-state re-render lands a frame behind the pull it would feed.
- New rows glide in behind a `translate3d` offset that decays to zero, with hysteresis — gliding resumes under `RESUME_GLIDE_ROWS` 1 and stops past `STOP_GLIDE_ROWS` 2 — because a single threshold flips a reader hovering at the boundary every frame. The glide debt is capped at `MAX_DEBT_ROWS` 300: past the budget the excess appears instantly, so the data always shows and only the animation drops.
- Stats publishes coalesce to `STATS_INTERVAL_MS` 250, keeping toolbar re-renders off the frame rate.

**Downsample to the pixel budget before d3 sees it.** `TopicsChart` (`src/event-dashboards/TopicsChart.js`) hands `buildAlignedSeries` a `MAX_POINTS` of 1000. A panel is about 1800px wide, so a denser axis is sub-pixel: the bucket starts at the 15-second probe cadence and widens only enough to hold the axis under that cap. The chart is also wrapped in `memo`, because a panel rebuilds its whole SVG from scratch while Overview re-renders on every poll tick, fold, expand and reorder — so callers hand it props stable across those renders (a memoized `series`, module-level formatters, the shared `fillModeForMetric` constants) and a panel whose own inputs didn't move skips the draw entirely.

**Measure the container, debounced, and ignore your own box.** `useContainerRefit( ref, callback, deps, debounceMs = 150 )` (`src/shared/hooks/useContainerRefit.js`) is what every chart and canvas resizes through. It drops the observation `ResizeObserver` delivers for the box you just drew, which is what makes a callback that resizes its own container settle instead of loop, and it falls back to a `window` listener where `ResizeObserver` is missing. Pass `0` when you want a measurement (§3's ceiling); leave the default when you want a redraw.

---

## 9. Recap — what you wrote vs. what the substrate gave you

**You wrote:** a `category` string on your CI (`'Service'`, not `'Hidden'`), a `requests` entry or two for your runtime triggers, a `tabMeta`-plus-`tabs` pair if your tool belongs in the hub, a `set_vault_id` reference to a Vault credential entry (not a settings form), and a build/deploy sequence that rebuilds before it deploys.

**The substrate gave you — and these are the contracts, not conveniences:**

| The shared surface | The contract it imposes |
|---|---|
| `Classes_CI`'s one catalog, feeding Palette and Inspector | `'Hidden'`/`''` drops from BOTH; `'Service'` is palette-only-hidden, inspector-kept |
| `node_schema['requests']` | `TM_REQUEST` triggers render as `kind="request"` buttons, addressed to the node; `commands` go to `<node>:config` unless the class is an interpreter |
| `ReplFooter` `maxHeightPx` | each host MEASURES its own frame, and the overlay its tab bar besides; viewport math drifts |
| `WP_EXTERNALS` | externalize ONLY packages WP registers as runtime scripts (icons, d3 and `@noble/hashes` are bundled) |
| `DevtoolsTabHost` + the tab registry | one host, `host`-scoped tabs, globally distinct ids, lazy-keyed mount, `fullBleed` for canvas tabs |
| `tabMeta.js` + `lazy` bundles | one descriptor spelling for the placeholder and the bundle, so a lazy tab does not rename itself on arrival |
| the Vault hub tab + `set_vault_id` | credentials live in the Vault; the topology only references an entry |
| `release:archive` / setup zip / `NEWSPACK_NODES_SRC` | rebuild before deploy; a shared edit rebuilds every consumer |
| a standalone consumer's `alias` map | pin every non-`@wordpress/*` dependency to your own `node_modules`, or a dev build bundles the substrate's copy beside yours |
| `useBatchedPoll` / `addSliceFetcher` | one tick is one POST; the cadence floor is 1000 ms and connect order is contractual |
| `LogRowList` / `ProbeStreamViewNode` / `TopicsChart` | bound the work by the viewport and the pixel budget, never by the input rate |

The first guide's lesson was that you add a dashboard by composing primitives. The real-world lesson is the corollary: **the moment your dashboard touches a shared surface, you inherit its contract.** A `category` you set wrong blanks your verb buttons. A ceiling you hardcode drifts behind a tab bar. A package you externalize without checking ships an undefined global to production. None of these are bugs in your code — they're contracts in the substrate's surfaces that your code has to honor. Honor them, and the dashboard that works on your page works in the console, in the overlay, in the hub, and after the next `release:archive`.

---

## Where to go next

- **[writing-a-dashboard.md](writing-a-dashboard.md)** — the toy this guide hardens; the poll loop, the view node, the enqueue.
- **[writing-a-view-node.md](writing-a-view-node.md)** — the view-node bases (`sliceView`, `LogStreamViewNode`, `CommandResultNode`) that §8's throttles and rings sit on.
- **[writing-a-real-plugin.md](writing-a-real-plugin.md)** — this guide's sibling: the real headless pipeline (connectors, the `Source` seam) and the full credentials-in-the-Vault / config-in-the-topology model §6 only gestures at.
- **[writing-a-plugin.md](writing-a-plugin.md)** — the original toy pipeline walkthrough, if you skipped it.
- **[architecture-guide.md](architecture-guide.md)** — the substrate model behind the catalog, the tab host, and the build kit.
- **`newspack-event-logger-nodes`** — the production application: four dashboards on these surfaces (Performance, Errors, Gyroscope, Request Log), an `overlay`-host Request tab registered into the same window registry, and the second consumer that proves the shared-alias rebuild rule.
