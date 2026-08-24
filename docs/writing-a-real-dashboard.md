# Writing a *Real* Nodes Dashboard

[writing-a-dashboard.md](writing-a-dashboard.md) walked the happy path: a `Scorer` + a durable snapshot, a `Service_CI_Node` verb that reads it, a JS view node, a `useBatchedPoll` + `addSliceFetcher` poll hook, a thin React view, the build, the enqueue, the run. By the end you had **Publisher Insights** rendering live in wp-admin. If you haven't done that walkthrough, do it first — this guide assumes its vocabulary (`fill`/`sink`/`target`, `useNodeState`, `node_schema`, the `_http` boundary) and never re-explains it.

This is the companion that picks up where the toy stops: the **production realities** you hit shipping a dashboard *for real*. Not "here's another feature," but "here's what bit us." A standalone admin page is the easy case — the moment your nodes show up in the **Topology Console** and the **DevTools overlay**, the moment you `npm run release:archive`, the moment a designer asks for an icon, you're past the tutorial. Seven of these caught us; one shipped broken to a real WP version before we noticed.

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

The catalog feeds two surfaces. The overlay nests your console inside a tab bar. The build externalizes packages against WordPress's enqueue registry. Each of those is a seam where the toy's assumptions stop holding. We'll take them in the order they bit.

---

## 1. Two surfaces, one catalog — the palette/inspector split

The toy's `Insights_CI` declared `'category' => 'Service'` and you moved on. Here's what that one string does.

`Classes_CI_Node::list` is the single catalog builder. It scans the composer classmap for concrete `*_Node` classes under a registered namespace, inlines each `node_schema()`, and — the line that matters — **drops a class on any of three conditions**:

```php
$cat    = $schema['category'] ?? '';
// (e) skip non-palette: Hidden, empty category, or hidden flag.
if ( 'Hidden' === $cat || '' === $cat || ! empty( $schema['hidden'] ) ) {
	continue;
}
```

`category: 'Hidden'`, no category at all, **or** an explicit `'hidden' => true` schema flag — any one removes the class from the catalog **entirely**. Each condition covers a different case. A class that declares nothing inherits `Node`'s empty-category default and drops out on the second (`SSE_Out_Node`, a pure HTTP response writer, never overrides `node_schema()` at all). The `hidden` flag is the escape hatch for a node that wants a real functional category yet still opts out of the palette — `SSE_In_Node` declares `'category' => 'I/O'` and `'hidden' => true`, because a patron node configures it programmatically.

"Entirely" is the gotcha, because `GraphView` feeds that *same array* to two children (`src/topology-console/components/GraphView.js`):

```jsx
{ showPalette && (
	<Palette classes={ catalog } … />
) }
…
<Inspector … catalog={ catalog } … />
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

A Service CI like `Insights_CI` is **mounted** into every request graph (`make_node( 'Insights_CI', 'insights' )` on `request_graph_ready` — toy guide §2). It is *never* `make_node`'d from the canvas. Dragging it from the palette would mint a stray second `insights` node that nobody routes to — a duplicate with no purpose. So you want it gone from the palette. But you still want its verb buttons in the inspector: select the mounted `insights` node, see its `counts` / `top` / `accumulated` buttons, fire one. Dropping it from the catalog kills both.

The substrate's answer is a **palette-only** filter, not a catalog drop. `Palette` keeps a `NON_DRAGGABLE_CATEGORIES` denylist:

```js
// Categories kept in the catalog but NOT draggable (Service CIs are mounted).
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
return [
	...commands.map( ( spec ) => (
		<VerbButton … kind="command" … />
	) ),
	...requests.map( ( spec ) => (
		<VerbButton … kind="request" … />
	) ),
];
```

A request button carries the tooltip `TM_REQUEST <name>` and dispatches `kind="request"`, which the console sends as a `TM_REQUEST` rather than a `TM_COMMAND` (`VerbButton` in `Inspector.js`; the dispatch in `hooks/useGraphHandlers.js`). So select your `releases` source in the console, hit the **TICK** button, and you've driven the pipeline from the canvas — the same trigger the toy guide typed as `request_node releases TICK` at the REPL, now a button. Declaring a `requests` entry is all it takes; the inspector wiring is free.

The takeaway for a real dashboard: your operator-facing **actions** (admin commands the CI answers) go in `commands`; your pipeline **triggers** (the runtime pokes that make data flow) go in `requests`. Both render, as different kinds, because they *are* different kinds on the wire.

---

## 3. Floating panels need *measured* ceilings, not viewport math

The toy view was a normal block in the admin content column — it scrolled with the page, no height math. A real REPL surface is different: the transcript pane can't grow past the canvas it floats over, and "the canvas" is a different height in every host. This is where a hard-coded `window.innerHeight − const` quietly goes wrong.

`ReplFooter` is deliberately dumb about its own ceiling. It accepts a `maxHeightPx` prop and, when set, prefers it over its viewport fallback (`src/topology-console/components/ReplFooter.js`):

```js
// Optional ceiling override for maxHeight(); overlay passes inner height.
maxHeightPx = null,
…
const ceiling = maxHeightPx ?? maxHeight();
```

That fallback `maxHeight()` is the trap. It's `window.innerHeight − FIXED_CHROME_PX − RESIZE_HANDLE_OVERHANG_PX`, where the 6px overhang reserve keeps the handle from clipping and `FIXED_CHROME_PX = 174` is a sum of magic constants (`ReplFooter.js`):

```js
// Pre-layout FALLBACK; callers pass measured maxHeightPx. 174=32+64+40+38.
const FIXED_CHROME_PX = 174;
```

That is `32` (WP admin bar) + `64` (header) + `40` (hub tab bar) + `38` (repl bar).

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

`useContainerRefit` is the shared hook every chart and canvas observes through: it
ignores the observation `observe()` delivers for the box you just drew, debounces
the rest, and falls back to a `window` listener where `ResizeObserver` is missing.
A `debounceMs` of `0` runs the callback in the observation itself — after layout,
before paint — which is what a measurement wants.

and derives the ceiling from the *measured* app height, subtracting only the grid's own rows (`replCeilingFromAppHeight` in `TopologyConsole.js`):

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

Note what it *doesn't* subtract: there's no header term. The console grid is `grid-template-rows: 1fr 38px` — the console's own header moved up to the shared hub header above the tabs, so the canvas frame no longer reserves a header row. The ceiling is `appHeight − repl-bar − a resize-handle reserve`, and that reserve is **`0`** here (not the overlay's `4`): because `appHeight` is measured exactly and the transcript bottom is exactly the repl-bar top, `0` lands the transcript top precisely at the canvas top. That measurement is also what closed the old drift — the console now renders as a `fullBleed` tab **inside the DevtoolsTabHost tab bar** (`src/topology-console/tabMeta.js`), which the `window.innerHeight − FIXED_CHROME_PX` fallback can't see. Measure the container and the drift can't happen.

**Host B — the debug overlay's Inspector tab.** Same disease, different frame. It measures *its own* tab bar instead of hardcoding it (`src/debug-overlay/tabs/InspectorTab.js`):

```js
export function measureTabBarHeight( rootEl ) {
	const content = rootEl?.closest?.( '.nodes-devtools__tab-content' );
	const bar = content?.previousElementSibling;
	if ( ! bar?.classList?.contains( 'nodes-devtools__tabbar' ) ) {
		return 0;   // single-tab host: no bar
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

Three nuances are worth lifting out of that body. First, the `- 4` **reserves the resize handle** so full height doesn't clip it — the console passes `0` there instead, because it measures its frame exactly. Second, the prompt bar it subtracts is `38` because the transcript's CSS anchor sits at `bottom: 38px` — the bar's *actual* rendered height, not the round `40` you'd guess (`.topology-repl__transcript` in `src/topology-console/styles/graph-view.scss`). Get that number from the CSS, not from intuition. Third, this path hardcodes the header (`64`) and the bar (`38`) but *measures* the tab bar via `measureTabBarHeight` (also in `InspectorTab.js`), so the ceiling stays honest if the bar wraps to two rows.

The pattern, stated once: `ReplFooter` is a pure consumer of `maxHeightPx`; **each host measures its own frame and hands the floor in.** A floating panel never knows its own bounds from the viewport — it knows them from the box it's mounted in. If you build a third REPL surface, you measure, you don't guess `window.innerHeight − 174`.

---

## 4. The `@wordpress/icons` build gotcha (the one that shipped broken)

The toy build "just worked" because it imported only `@wordpress/element`, `@wordpress/i18n`, and `@wordpress/api-fetch` — packages WordPress genuinely exposes as runtime scripts. The first time a real dashboard reaches for an **icon**, the build kit's externalization model breaks in a way that's invisible until runtime.

`buildDashboards` rewrites every `@wordpress/*` import to a `window` global and records the matching enqueue handle in `*.asset.php` (toy guide §6). The map that drives it is `WP_EXTERNALS` (`src/build-kit/index.mjs`). Look at what's conspicuously *absent* — and the comment explaining why (`index.mjs`):

```js
// NOT @wordpress/icons: build-time (no runtime global) — bundle it.
'@wordpress/data': {
	global: 'window.wp.data',
	handle: 'wp-data',
},
```

The failure mode is a clean two-stage trap. `@wordpress/element` and `@wordpress/i18n` are runtime scripts: WP serves them, registers `wp-element` / `wp-i18n` handles, and `window.wp.element` exists. `@wordpress/icons` is **not** that — it's a *build-time* package of SVG-as-React-components. WordPress ships no `window.wp.icons` global and registers no `wp-icons` script handle. So if you'd naively added it to `WP_EXTERNALS`:

1. **At runtime:** esbuild rewrites `import { chartBar } from '@wordpress/icons'` to read `window.wp.icons.chartBar` — which is `undefined`. Your icon renders nothing, no error at build time.
2. **In wp-admin (WP 6.9.1):** the `*.asset.php` lists `wp-icons` as a dependency WordPress can't satisfy, and WP logs *"dependencies that are not registered: wp-icons."*

The fix is the absence itself: **omit `@wordpress/icons` from `WP_EXTERNALS` so esbuild bundles it** from `node_modules` like any ordinary library. The icon's SVG ends up inlined in your bundle (esbuild already handles `.svg` as `dataurl` — `index.mjs`), `window.wp.icons` is never read, and the `.asset.php` no longer lists the phantom `wp-icons`.

The general rule for any package you're tempted to add to that map: **only externalize packages WordPress registers as runtime scripts.** The map holds ten today — `@wordpress/element`, `-i18n`, `-components`, `-api-fetch`, `-data`, `-blocks`, `-block-library`, plus `react`, `react-dom`, and `react/jsx-runtime` — and WP serves every one. Build-time-only packages (icons, and most `@wordpress/*` that are pure JS helpers) must be *bundled*, not externalized, or you ship an undefined global and an unmet-dependency warning. This one reached a real WP version before we caught it; treat the `WP_EXTERNALS` map as a closed set you extend only with proof WP registers the handle.

---

## 5. The DevTools tab host, the hub, and the tab registry

Sections 0 and 3 kept referring to "the overlay" and "the hub." Here's the shared machinery; the files carry the detail.

The center of it is **`DevtoolsTabHost`** (`src/shared/devtools/DevtoolsTabHost.js`) — one component, two hosts. It reads the tab registry for a given `host`, renders a tab bar (hidden when ≤1 tab), and **lazily mounts only the selected tab**, keyed on the active id so each tab's build-before-render runs fresh on switch (`DevtoolsTabHost.js`):

```jsx
<Active key={ active.id } { ...tabProps } host={ host } />
```

A tab declares which host(s) it belongs to (`host ∈ overlay | hub | both`) and whether it's full-bleed. A list-style tab scrolls inside `.nodes-devtools__tab-content`; a tab that owns its own full-height canvas (the Topology Console) sets `fullBleed: true` to opt out via `.is-full-bleed` (`DevtoolsTabHost.js`). That `fullBleed` flag is exactly why §3's console-in-the-hub needs the measured ceiling — it fills the frame.

The two hosts are thin wrappers around it:

- **The floating overlay** mounts tabs with `host="overlay"` (the Inspector tab from §3 is one of them).
- **The full-page hub** (`src/devtools-hub/DevToolsHub.js`) mounts `host="hub"` inside a `position: fixed`, full-height admin container so a full-screen canvas tab gets usable height (`DevToolsHub.js`). It also gates the floating overlay's REPL off the Console tab — a second overlay REPL there would collide on the shared `_output` infra (`DevToolsHub.js`).

You register a tab by filtering into the registry via the **`newspack_nodes/devtools_tab_bundles`** filter (the PHP analogue of the toy's CI mount). Your bundle exports a tab descriptor; the host picks it up by `host`. If your real dashboard genuinely *is* a Nodes-internal tool rather than a standalone page, this is where it belongs — a `host: 'hub'` tab — instead of the toy guide's standalone `add_menu_page`. Read `DevtoolsTabHost.js` and `DevToolsHub.js` once; the contract is small.

---

## 6. Where the API credentials go — the Vault, not a page you build

The most production-real surface of all — **where do the API credentials go?** — is one you *don't* write. The substrate already ships it: the **Vault**, a built-in DevTools-hub tab at `admin.php?page=newspack-nodes-hub&tab=vault`, not a WordPress Settings-API page and not a React tree you have to author.

The Vault is a real hub tab (`src/vault/`, registered `host: 'hub'` / `slug: 'vault'` via the `newspack_nodes/devtools_tab_bundles` filter) — a thin `VaultAdmin` view over the `Vault_CI_Node` credential store (`includes/rest/class-vault-ci-node.php`). Secrets persist server-side in the `newspack_nodes_vault` option and are **never** returned to the browser: `list`/`get` hand back `{ id, url, auth_username, has_credentials, is_config }`, never the secret itself. (The username rides along so the tab's Edit form can show it; the password does not, which is why leaving that field blank means "keep the stored one".)

Your topology only *references* an entry. A source node carries a `set_vault_id <id>` verb — a `vault_id`-typed `node_schema` arg, which the console renders as a Vault dropdown — and resolves that id to the raw secret at `config()` time via the `Vault_Secret` trait (`newspack-intelligence/includes/class-github-source-node.php`: `cmd_set_vault_id` → `resolve_vault_secret`). Non-secret per-source config rides sibling verbs on the same node (`add_repo <owner/name>`, `add_url <feed>`), never the Vault.

So the split is: **the operator enters the secret in the Vault tab; the topology points at it.** When the right surface is credentials, reach for the Vault entry + a `set_vault_id` reference — not a hand-rolled settings form and not a React page. The full credentials-in-the-Vault / config-in-the-topology model is [writing-a-real-plugin.md](writing-a-real-plugin.md) §4; here it's the reminder that the credential surface is a tab you already have.

---

## 7. Build & deploy realities

The toy ran `npm run build` and `wp nodes status` and called it done. Shipping for real has a handful of sharp edges around that.

**`release:archive` bundles `build/`, not `src/`, with an optimized autoloader.** The release zip carries the *built* `build/dashboard/index.js` (and its `.asset.php` / `.css` / `-rtl.css`), composer's `--no-dev` autoloader, and none of `src/` or `tests/`. So your `npm run build` output is the artifact — if you didn't build, the zip ships stale JS.

**The setup scripts install a PREBUILT zip — they don't build.** This is the one that silently runs old code. `newspack-nodes.sh` / `newspack-intelligence.sh` install the existing `release/*.zip`; they do not run esbuild. So the deploy loop is **`npm run release:archive` first, then the setup script** — otherwise `wp nodes` runs the previous build and your PHPUnit (which runs from `/services`) won't catch it because the source on disk *is* current; only the deployed copy is stale.

**A shared-source edit fans out to every consumer bundle.** Anything under `src/shared`, `src/debug-overlay`, or `src/build-kit` is *inlined* into each consumer's bundle at build time via the `@newspack-nodes/*` aliases — there is no shared runtime script. So editing, say, `ReplFooter`'s ceiling logic or `WP_EXTERNALS` means rebuilding **and redeploying every consumer** — `newspack-nodes` itself, `newspack-event-logger-nodes`, `newspack-intelligence`, and the in-repo example — or the un-rebuilt ones ship the old inline copy. The toy's single bundle hid this; a real change to the shared kit doesn't get that luxury.

**Mounting the debug overlay needs more jest config than the toy showed.** [writing-a-dashboard.md](writing-a-dashboard.md) §6 hands you a 2-key `createJestConfig` (`aliasBase` + `pinReactFrom`) — enough for the toy's thin view. But the moment you follow its §9 and mount `<DebugOverlay>` in your dashboard, jest has to resolve what the overlay drags in, and `d3` is the one that bites: the overlay's `OverviewTab` → `TopicsChart` pulls it transitively, and it ships ESM-only. Give `extraMappers` an entry for every module jest must resolve outside your own `node_modules`: `newspack-intelligence` installs `d3` and maps `^d3$` at its own tree, while the in-repo `examples/example-ai-newsletter/jest.config.js` installs no `d3` at all and maps it — along with `@wordpress/api-fetch` — at the substrate's. Add a `transformIgnorePatterns` alongside that opts d3's ESM packages out of the transform skip.

**Restart workers after deploy.** Otherwise the running worker process holds the old class for up to ~10 more minutes; `wp nodes restart …` (per the env's restart verbs) makes the new node code live.

**The `_Demo` suffix is a deconfliction tactic, not decoration.** The in-repo teaching example (`examples/example-ai-newsletter/`) names its classes `Scorer_Demo_Node`, `Insights_CI_Demo_Node`, `Releases_Source_Demo_Node`, … while the real plugin uses bare `Scorer_Node`, `Insights_CI_Node`, etc. Both can be active at once, and §1 showed the catalog scans *every* registered namespace — so without the suffix the toy's `Scorer` and the real plugin's `Scorer` would collide on one palette tile and one inspector lookup (`shell_name === 'Scorer'` matching two classes). The `_Demo` suffix gives the example its own `Scorer_Demo` shell name, keeping the two pipelines distinct in the one shared catalog. If you ship an example alongside a real plugin, suffix the example.

---

## 8. Recap — what you wrote vs. what the substrate gave you

**You wrote:** a `category` string on your CI (`'Service'`, not `'Hidden'`), a `requests` entry or two for your runtime triggers, a `host`-scoped tab descriptor if your tool belongs in the hub, a `set_vault_id` reference to a Vault credential entry (not a settings form), and a build/deploy sequence that rebuilds before it deploys.

**The substrate gave you — and these are the contracts, not conveniences:**

| The shared surface | The contract it imposes |
|---|---|
| `Classes_CI` one catalog → Palette + Inspector | `'Hidden'`/`''` drops from BOTH; `'Service'` is palette-only-hidden, inspector-kept |
| `node_schema['requests']` | `TM_REQUEST` triggers render as `kind="request"` buttons, distinct from `commands` |
| `ReplFooter` `maxHeightPx` | each host MEASURES its own frame + tab bar; viewport math drifts |
| `WP_EXTERNALS` | externalize ONLY packages WP registers as runtime scripts (icons → bundle) |
| `DevtoolsTabHost` + the tab registry | one host, `host`-scoped tabs, lazy-keyed mount, `fullBleed` for canvas tabs |
| the Vault hub tab + `set_vault_id` | credentials live in the Vault; the topology only references an entry |
| `release:archive` / setup zip / shared-alias inlining | rebuild before deploy; a shared edit rebuilds every consumer |

The first guide's lesson was that you add a dashboard by composing primitives. The real-world lesson is the corollary: **the moment your dashboard touches a shared surface, you inherit its contract.** A `category` you set wrong blanks your verb buttons. A ceiling you hardcode drifts behind a tab bar. A package you externalize without checking ships an undefined global to production. None of these are bugs in your code — they're contracts in the substrate's surfaces that your code has to honor. Honor them, and the dashboard that works on your page works in the console, in the overlay, in the hub, and after the next `release:archive`.

---

## Where to go next

- **[writing-a-dashboard.md](writing-a-dashboard.md)** — the toy this guide hardens; the poll loop, the view node, the enqueue.
- **[writing-a-real-plugin.md](writing-a-real-plugin.md)** — this guide's sibling: the real headless pipeline (connectors, the `Source` seam) and the full credentials-in-the-Vault / config-in-the-topology model §6 only gestures at.
- **[writing-a-plugin.md](writing-a-plugin.md)** — the original toy pipeline walkthrough, if you skipped it.
- **[architecture-guide.md](architecture-guide.md)** — the substrate model behind the catalog, the tab host, and the build kit.
- **`newspack-event-logger-nodes`** — the production application: four real dashboards on these surfaces (Performance, Error Log, Gyroscope, Request Log), including the SSE ones, and the second consumer that proves the shared-alias rebuild rule.
