# Writing a Nodes Dashboard

[writing-a-plugin.md](writing-a-plugin.md) stopped at a fully-working, fully-tested **headless** node plugin: the AI-newsletter digest pipeline. This walkthrough adds the other half — a **React admin dashboard** that reads the pipeline's live state and renders it in wp-admin. We'll end with **Publisher Insights**: a page that shows per-source counts, a score-ranked table of items, and a one-click "Draft newsletter" button.

The finished code is in [`examples/example-ai-newsletter/`](examples/example-ai-newsletter/) — the same plugin the first guide built, now with a `src/dashboard/` tree and a scored, durable topology. Read along, or build it yourself and diff.

> **The one thing to hold onto:** a dashboard is *not* a new mechanism. It is the **same `fill(message)` contract**, expressed in JavaScript, talking to the same node graph over one HTTP boundary. You already know how to write a node. A dashboard is a few nodes that happen to run in the browser, plus a thin React view that reads one of them.

Do [writing-a-plugin.md](writing-a-plugin.md) first if you haven't — this guide assumes the digest pipeline (sources → summarizer → digest) and the `fill`/`sink`/`target`/`node_schema` vocabulary.

> **A note on how this guide was written.** Every section below ends at a primitive in the substrate — `enqueue_react_page`, `buildDashboards`, `createJestConfig`, `PendingReplies`, `useDashboardGraph`, `read_latest_value_at`. None of those existed when the dashboard was first built: each was 20–250 lines of copy-paste in the example until writing *this* walkthrough made the boilerplate impossible to ignore, at which point it moved into the substrate. That's the same rule the first guide follows — **when a step feels like boilerplate, the fix belongs in the substrate, not the tutorial.** Where a step is one call today, this guide says what it replaced, so you can see the seam.

---

## 0. What we're building

```
                                    browser (React admin page)
                                    ────────────────────────────
   wp-admin page  ─mount─>  _http ──> insights:view ──> useNodeState ──> <PublisherInsights/>
                            (HttpOut)   (view-model node)
                               │
                               │  POST /newspack-nodes/v1/command   {verb: "insights"}
                               ▼
   ════════════════════════════ server ════════════════════════════
   Insights_CI  ──reads──>  offsets/scored.p0   (the durable snapshot the worker wrote)
```

The dashboard graph is **two nodes** clipped onto the substrate's REPL backbone: `_http` (the HTTP egress boundary) and `insights:view` (a view-model node that holds the data React reads). A page-visibility-gated poll fires an `insights` command; it travels over `_http` to a server-side **service interpreter** (`Insights_CI`), which reads the worker's durable snapshot and replies with the model. `insights:view` publishes the model; React re-renders. No SSE — the repeated poll *is* the live data.

So there are three pieces of new work, and we'll build them in dependency order:

1. **Make the pipeline produce durable, scored state** the dashboard can read (a `Scorer` node + a durable log + a snapshotting `Consumer`).
2. **Serve that state** over the command protocol (the `Insights_CI` service verb).
3. **Render it** (the JS node graph, the React view, the build, the enqueue).

---

## 1. Give the pipeline something worth showing — score it, and make it durable

The digest from the first guide accumulates summaries in memory and flushes them to a file. A dashboard needs two things that pipeline lacks: a **score** to rank by, and **durable state** that survives the worker so the web request can read it.

### a. The Scorer — one more transform on the same contract

A `Scorer` is a transform exactly like the summarizer: receive a struct item, add a field, forward. The one seam a real scorer replaces is `score()`.

> Each PHP file below opens with the same preamble writing-a-plugin.md §2 established — `namespace Newspack_AI_Newsletter;` plus the `use Newspack_Nodes\{ Node, Message, Command_Interpreter_Node };` (or `Service_CI_Node`/`Partition_Node`/`Config`) it needs. The snippets show just the class body.

`includes/class-scorer.php`:

```php
class Scorer_Node extends Node {

	/** Per-source base weight; unknown sources score 1.0. */
	private const SOURCE_WEIGHT = [ 'releases' => 5.0, 'community' => 3.0 ];

	/** Bonus keywords — a title hit adds 1.0 each. */
	private const KEYWORDS = [ 'award', 'launch', 'ships', 'GA', 'million', '10k' ];

	/** The ONE seam a real scorer replaces: item -> notional priority score. */
	protected function score( array $item ): float {
		$source = \is_string( $item['source'] ?? null ) ? $item['source'] : '';
		$score  = self::SOURCE_WEIGHT[ $source ] ?? 1.0;
		$title  = \is_string( $item['title'] ?? null ) ? $item['title'] : '';
		foreach ( self::KEYWORDS as $kw ) {
			// Word-boundary match — 'GA' must not fire on "Garage".
			if ( 1 === \preg_match( '/\b' . \preg_quote( $kw, '/' ) . '\b/i', $title ) ) {
				$score += 1.0;
			}
		}
		return $score;
	}

	public function fill( array &$message ): void {
		if ( 0 === ( ( $message[ Message::TYPE ] ?? 0 ) & Message::TM_STRUCT ) ) {
			return;
		}
		$item            = $message[ Message::VALUE ];
		$item['score']   = $this->score( $item );

		$out                   = Message::new_message();
		$out[ Message::TYPE ]  = Message::TM_STRUCT;
		$out[ Message::FROM ]  = $this->name;
		$out[ Message::VALUE ] = $item;
		parent::fill( $out );   // stamp TO from target, forward to sink
	}
}
```

It slots between the summarizer and the digest: `summarizer → scorer → …`. Nothing else changes — the summarizer never learns there's a score, the digest never learns how it was computed. Same lesson as Ben's source.

### b. Durability — write to a log, tail it back, snapshot the result

The dashboard runs in a **web request**, a different process from the worker. It can't read the digest node's in-memory `$items`. So the pipeline has to write its state somewhere durable, and the substrate already has the parts: a **`Partition`** (an append-only log) and a **`Consumer`** (tails a log and forwards each record), plus the Consumer's **snapshot** feature, which co-commits a node's `save_state()` alongside its read cursor.

Here is the finished `topologies/digest.tsl` for this chapter — the scored, durable graph:

```
var num_partitions = 1

make_node Releases_Source  releases
make_node Community_Source community
make_node Summarizer       summarizer
make_node Digest_Builder   digest
make_node Tee              digest:tee
make_node Log              digest:log /tmp/example-ai-newsletter/digest.md 1 7
cmd digest:log:config void_warranty
make_node Partition        scored:partition <config:logs_dir>/scored.p<partition> <config:segment_size> <config:num_segments> <config:max_lifespan>
cmd scored:partition:config void_warranty
make_node Consumer         scored:consumer <config:logs_dir>/scored.p<partition> <config:offsets_dir>/scored.p<partition>
cmd scored:consumer:config set_snapshot_node digest
make_node Scorer           scorer
connect_node releases    summarizer
connect_node community   summarizer
connect_node summarizer  scorer
connect_node scorer      scored:partition
connect_node scored:consumer digest
connect_node digest      digest:tee
connect_node digest:tee  digest:log
```

Three new ideas, all using nodes the substrate ships:

- **`<config:...>` and `<partition>` tokens.** The `Partition`/`Consumer` arguments interpolate runtime config (the substrate's `logs_dir`, `segment_size`, …) and the worker's partition index, so the same `.tsl` works for any partition count. They're substrate-registered token namespaces — you just use them.
- **`scorer → scored:partition` writes the durable log;** `scored:consumer → digest` tails it straight back into the digest. The Consumer reads each scored record and `fill()`s it into the digest, exactly as a `connect_node` would.
- **`cmd scored:consumer:config set_snapshot_node digest`** is the key line. It tells the Consumer: each time you checkpoint your read cursor, also call `digest->save_state()` and co-commit that blob into your offsetlog. On respawn the Consumer restores the cursor *and* hands the blob back via `digest->restore_state()` — **in lockstep**, so the digest's accumulated items and the cursor can never disagree. (`cmd scored:partition:config void_warranty` lifts the partition's 4 KB atomic-write cap, because a scored batch can exceed `PIPE_BUF` — see [ADR-4](docs/architecture-decisions.md#adr-4-pipe_buf-atomic-writes).)

The digest node implements the snapshot contract — two small methods:

```php
/** Snapshot contract: the items the Consumer co-commits into its offsetlog. */
public function save_state(): array {
	return [ 'items' => $this->items ];
}

/** Restore from a snapshot cache (tolerates a malformed blob). */
public function restore_state( array $state ): void {
	$this->items = [];
	$items       = $state['items'] ?? null;
	if ( ! \is_array( $items ) ) {
		return;
	}
	foreach ( $items as $item ) {
		if ( \is_array( $item ) ) {
			$this->items[] = $item;
		}
	}
}
```

That's the whole durability story: the worker writes a snapshot the web request can read. Restart the worker, drive the pipeline, and `offsets/scored.p0` now holds the digest's scored items. Nothing in the dashboard reads in-memory state — it reads that snapshot.

---

## 2. Serve the data — a service verb that reads the snapshot

The browser can't read a file off the worker's disk either. It speaks the **command protocol**: a `POST` of a `TM_COMMAND` to `/newspack-nodes/v1/command`, which the substrate routes to a node by name. So we mount a **service interpreter** into every web request and give it one verb, `insights`.

A service interpreter is a `Service_CI_Node` — a `Command_Interpreter_Node` whose verb table comes from its `node_schema()`, the same double-duty schema you already write for nodes. `includes/class-insights-ci.php`:

```php
class Insights_CI_Node extends Service_CI_Node {

	private const TOP_N = 10;

	/** A score is whatever the Scorer wrote; coerce defensively for sorting/display. */
	private static function to_float( mixed $value ): float {
		return \is_numeric( $value ) ? (float) $value : 0.0;
	}

	public function build_insights_json(): string {
		$offsets_dir = \Newspack_Nodes\Config::get_offsets_directory();
		return (string) \wp_json_encode( self::read_insights_model( $offsets_dir ) );
	}

	/** Shape the dashboard model from the scored offsetlog snapshot(s). */
	public static function read_insights_model( string $offsets_dir ): array {
		$empty = [ 'sources' => [], 'top' => [], 'accumulated' => 0 ];
		$dirs  = \glob( \rtrim( $offsets_dir, '/' ) . '/scored.p*', \GLOB_ONLYDIR );
		if ( false === $dirs || [] === $dirs ) {
			return $empty;
		}

		$items = [];
		foreach ( $dirs as $dir ) {
			foreach ( self::read_cache_items( $dir ) as $item ) {
				$items[] = $item;
			}
		}
		if ( [] === $items ) {
			return $empty;
		}

		$sources = [];
		foreach ( $items as $item ) {
			$source             = \is_string( $item['source'] ?? null ) ? $item['source'] : '?';
			$sources[ $source ] = ( $sources[ $source ] ?? 0 ) + 1;
		}
		\usort( $items, static fn ( array $a, array $b ): int =>
			self::to_float( $b['score'] ?? null ) <=> self::to_float( $a['score'] ?? null ) );

		$top = [];
		foreach ( \array_slice( $items, 0, self::TOP_N ) as $item ) {
			$top[] = [
				'source' => $item['source'] ?? '?',
				'title'  => $item['title'] ?? '',
				'score'  => self::to_float( $item['score'] ?? null ),
			];
		}
		return [ 'sources' => $sources, 'top' => $top, 'accumulated' => \count( $items ) ];
	}

	/** Read one offset dir's newest snapshot, return its cache['items']. */
	private static function read_cache_items( string $offset_dir ): array {
		$value = \Newspack_Nodes\Partition_Node::read_latest_value_at( $offset_dir );
		$cache = \is_array( $value ) && \is_array( $value['cache'] ?? null ) ? $value['cache'] : [];
		$items = $cache['items'] ?? null;
		if ( ! \is_array( $items ) ) {
			return [];
		}
		$out = [];
		foreach ( $items as $item ) {
			if ( \is_array( $item ) ) {
				$out[] = $item;
			}
		}
		return $out;
	}
}
```

> **← a substrate refinement.** `read_cache_items` used to be a 20-line walk: `new Partition_Node`, `arguments`, `get_segments(true)`, find the newest segment, `read_at`, split lines, `Message::unpacked`, pull `VALUE` — guarded and try/caught. The substrate's `CLI::read_offsetlog_entry()` had a byte-identical copy. Reading "the newest committed record's VALUE from an offsetlog" is a substrate concern, so it became **`Partition_Node::read_latest_value_at( $offset_dir )`**, and both callers collapsed to one line. You don't walk segments; you ask the Partition for its latest value.

Declare the verb in `node_schema()` (same double-duty schema as a node — `array_merge( parent::node_schema(), … )`) and mount the CI on every request:

```php
public static function node_schema(): array {
	return \array_merge( parent::node_schema(), [
		'category'    => 'Service',
		'description' => 'Serves the Publisher Insights model from the scored offsetlog.',
		'commands'    => [ [
			'name'        => 'insights',
			'description' => 'Return the current Publisher Insights model.',
			'args'        => [],
			'handler'     => static function ( Command_Interpreter_Node $interpreter, string $args ): string {
				self::require_manage_options();      // the verb is admin-only
				/** @var self $ci */
				$ci = $interpreter;                   // a Service_CI verb runs ON the CI
				return $ci->build_insights_json();    // FULLY-SHAPED model as a JSON string
			},
		] ],
	] );
}
```

```php
// In the plugin file: mount the CI into every request graph (idempotent).
function mount_insights_ci( \Newspack_Nodes\Command_Interpreter_Node $base ): void {
	if ( null !== \Newspack_Nodes\Core::node( 'insights' ) ) {
		return;
	}
	require_once __DIR__ . '/includes/class-insights-ci.php';
	$base->make_node( 'Insights_CI', 'insights' );
}
add_action( 'newspack_nodes/request_graph_ready', __NAMESPACE__ . '\\mount_insights_ci' );
```

The verb returns the **fully-shaped model as a JSON string** — there is no transform node, no second round-trip. The browser's poll gets the finished `{ sources, top, accumulated }` in the POST response body. That choice is what makes the client a pure poll with no SSE.

You can verify this half **with no browser at all** — it's just PHP:

```bash
wp eval '$m = \Newspack_AI_Newsletter\Insights_CI_Node::read_insights_model(
  \Newspack_Nodes\Config::get_offsets_directory() ); echo json_encode( $m );'
# {"sources":{"releases":6,"community":6},"top":[{"source":"releases","title":"Roundup Block ships","score":6}, …],"accumulated":12}
```

Server-side done. Now the browser.

---

## 3. The JS graph — the same `fill()` contract, in JavaScript

Here is the part that surprises people: **the browser runs the same node runtime.** `@newspack-nodes/runtime` is the JS port — `Node`, `Message`, a `CommandInterpreterNode`, `mountExospine` (which clips your nodes onto the standard `_command_interpreter → _router` backbone). A "dashboard view model" is a `Node` whose `fill()` stores the latest reply and publishes it for React to read.

`src/dashboard/nodes/insightsView.js` — the view-model node:

```js
import { Node, ID, TYPE, VALUE, TM_ERROR } from '@newspack-nodes/runtime';
import { PendingReplies, errorMessage } from '@newspack-nodes/shared/pendingReplies';

export const emptyModel = () => ( { sources: {}, top: [], accumulated: 0 } );

export class InsightsViewNode extends Node {
	constructor() {
		super();
		this.registrations.view = {};   // React subscribes to the 'view' state
		this.model = emptyModel();
		this.replies = new PendingReplies();   // ← see below
	}

	fill( message ) {
		const value = message[ VALUE ];
		if ( ! value || 'object' !== typeof value ) {
			return;
		}
		// Awaited verbs (if any) settle here; the poll reply has no pending entry.
		if ( this.replies.settle( message ) ) {
			return;
		}
		if ( 0 !== ( ( message[ TYPE ] || 0 ) & TM_ERROR ) ) {
			this.model = { ...emptyModel(), error: errorMessage( value.payload ) };
			this.setState( 'view', this.model );
			return;
		}
		// The poll reply: VALUE.payload is the JSON-string model from the CI.
		const model = this._parse( value.payload );
		if ( null !== model ) {
			this.model = model;
			this.setState( 'view', this.model );   // publish → React re-renders
		}
	}
	// _parse(): JSON.parse with a try/catch, returns null on garbage.
}
```

Two things to notice:

- **`setState('view', model)`** is how a node hands data to React. A companion hook (`useNodeState('insights:view', 'view')`, §5) subscribes to that key and re-renders on every publish. The node owns the data; the component just reads it.
- **`this.replies = new PendingReplies()`** — for any verb you *await* (a button that fires a command and wants the reply), you stash `{resolve, reject}` under the outgoing `message[ID]`, and the matching reply settles the Promise. The poll doesn't await; its reply just updates the model. `settle(message)` returns `true` if it matched a pending entry, so `fill()` knows whether to fall through to the model path.

> **← a substrate refinement.** Every dashboard view node had this same block: a `Map` keyed by `message[ID]`, settled on the pivoted reply, plus an `errorMessage()` that coerces a `TM_ERROR` payload (string / `{message}` / anything) to a readable string. It was copy-pasted across WorkerStatus, RawLogs, the ELN performance views, and this one. It became **`@newspack-nodes/shared/pendingReplies`** — `errorMessage` (the pure coercion) and a `PendingReplies` class (`add` / `has` / `settle → bool` / `rejectAll`). Your view node composes it instead of re-implementing the correlation.

Register the class so `makeNode` can find it (the JS analogue of the PHP classmap), `src/dashboard/nodes/register.js`:

```js
import { CommandInterpreterNode } from '@newspack-nodes/runtime';
import { InsightsViewNode } from './insightsView';

CommandInterpreterNode.registerNodeClasses( { InsightsView: InsightsViewNode } );
```

---

## 4. Mount the graph and poll it — one hook call

The hook wires the graph (mount `_http` + your view node) and owns the poll loop. Almost all of that is identical for every poll-based dashboard, so it's one substrate call. `src/dashboard/hooks/useInsightsGraph.js`, in full:

```js
import {
	newMessage, TYPE, FROM, TO, ID, VALUE, TM_COMMAND,
} from '@newspack-nodes/runtime';
import { useDashboardGraph, makeOpId } from '@newspack-nodes/shared/hooks/useDashboardGraph';
import '../nodes/register';

const HTTP = '_http';
const VIEW = 'insights:view';

/** Build the `insights` TM_COMMAND: TO=`_http/insights`, FROM=view (the reply pivot). */
function buildInsightsCommand( id ) {
	const m = newMessage();
	m[ TYPE ]  = TM_COMMAND;
	m[ FROM ]  = VIEW;
	m[ TO ]    = `${ HTTP }/insights`;
	m[ ID ]    = id;
	m[ VALUE ] = { name: 'insights', arguments: '' };
	return m;
}

export function useInsightsGraph( { commandClient, refreshMs = 4000 } = {} ) {
	useDashboardGraph( {
		mountNodes: ( interpreter ) => interpreter.makeNode( 'InsightsView', VIEW ),
		poll:       ( interpreter ) => interpreter.fill( buildInsightsCommand( makeOpId( 'insights-op' ) ) ),
		refreshMs,
		commandClient,
	} );
}
```

That's the whole hook. You supply two closures — **`mountNodes`** (mount your view node) and **`poll`** (fire your command) — and `useDashboardGraph` owns the rest.

The command itself is worth reading once, because it's the routing in miniature: `TO=_http/insights` means the router peels `_http` (delivering the bare command to the `HttpOut` egress, which POSTs it), and `FROM=insights:view` is the reply pivot — the server CI replies `TO=FROM`, so the reply lands back at the view. Same TO/FROM mechanics as the PHP side; the only new node is `_http`, the boundary between the browser graph and the server.

> **← a substrate refinement.** `useInsightsGraph` was ~120 lines: a `useEffect` that called `mountExospine`, mounted an `HttpOut` and built a `CommandClient` from `window.NewspackNodesData`, bumped a re-render so `useNodeState` rebinds, fired an immediate poll, then a second `useEffect` running a page-visibility-gated `setInterval` — plus its own `makeOpId`. Every poll dashboard repeated it. It became **`useDashboardGraph({ mountNodes, poll, refreshMs, commandClient })`** (it returns `{ interpreterRef }` for dashboards that also fire awaited verbs, like WorkerStatus's restart). The `commandClient` parameter is the test seam — pass a fake and the hook never touches the network. **Not every dashboard fits it:** the SSE dashboards (a live request stream) keep their own `_sse`/`_heartbeat` mount, because they aren't a poll. Adopting it there would be a false fit — the substrate gives you the shape that's genuinely shared, not one stretched over cases that differ.

---

## 5. The view — read the model, render, draft

The React component is thin by design: it reads the model the node publishes and renders it. `src/dashboard/PublisherInsights.js` (condensed):

```js
import { useState } from '@wordpress/element';
import { useNodeState } from '@newspack-nodes/runtime';
import { useInsightsGraph } from './hooks/useInsightsGraph';
import { emptyModel } from './nodes/insightsView';
import { draftNewsletter } from './draftNewsletter';
import './styles/insights.scss';

export default function PublisherInsights( { refreshMs = 4000, commandClient } ) {
	useInsightsGraph( { refreshMs, commandClient } );   // mount + poll the graph
	const model = useNodeState( 'insights:view', 'view' ) || emptyModel();
	const [ draft, setDraft ] = useState( null );

	return (
		<div className="nan-insights">
			<h1>Publisher Insights</h1>
			<p>Accumulated items: { model.accumulated }</p>

			<h2>By source</h2>
			<ul>{ Object.entries( model.sources ).map( ( [ name, count ] ) =>
				<li key={ name }>{ name }: { count }</li> ) }</ul>

			<h2>Top items</h2>
			<table>{ /* a row per model.top item: source, title, score */ }</table>

			<button onClick={ () => setDraft( draftNewsletter( model.top ) ) }>
				Draft newsletter
			</button>
			{ null !== draft && <textarea value={ draft } onChange={ … } /> }
		</div>
	);
}
```

`useNodeState('insights:view', 'view')` is the bridge: it subscribes to the `view` key the node `setState`s, so every poll publish re-renders the table. The `|| emptyModel()` fallback means the first render (before the first reply lands) is still valid — the node guarantees its data fields on every publish.

The real component picks one of three branches off that model — an **error notice** (`model.error`, set when a poll reply is `TM_ERROR`), an **empty state** (nothing scored yet), or the **data grid** — rather than rendering an empty table into the void. Surfacing the error and the "drive the pipeline" hint is most of the difference between a demo and something an operator can actually read:

```js
let content;
if ( model.error ) {
	content = <div className="nan-insights__notice nan-insights__notice--error" role="alert">{ model.error }</div>;
} else if ( 0 === model.accumulated && 0 === model.top.length ) {
	content = <div className="nan-insights__empty">No scored items yet — drive the pipeline.</div>;
} else {
	content = /* the By-source list + score-ranked table + Draft button */;
}
```

The **Draft newsletter** button is pure client-side — `draftNewsletter(model.top)` turns the already-ranked items into markdown with no server call:

```js
export function draftNewsletter( items = [] ) {
	const lines = [ `# Publisher Newsletter`, '' ];
	for ( const item of items ) {
		lines.push( `- **${ item.title || '(untitled)' }** — ${ item.source || '?' }` );
	}
	return lines.join( '\n' );
}
```

`PublisherInsights` reads `import './styles/insights.scss'` — create that file. Style it to the **Newspack in-product design system** ([`docs/DESIGN.product.md`](DESIGN.product.md)): Cobalt (`#003DA5`) for the primary action, neutral surfaces (`#fff` / `#f7f7f7`) and borders (`#ddd`), `#1e1e1e` / `#6c6c6c` text, Inter, the 4/8/16/24 spacing scale, and functional colors (error `#B32D2E` on subtle `#FCF0F1`) only for status. The example's `insights.scss` is the reference. **Lay it out in flow** — a normal block in the admin content column — *not* `position: fixed` / full-bleed: that overlay pattern belongs to the Topology Console and the DevTools hub (which deliberately take over the viewport), and on a standalone admin page it just hides the WP admin bar and menu.

Wrap the component in a page so the bundle entry has a single default export to mount, `src/dashboard/PublisherInsightsPage.js`:

```js
import PublisherInsights from './PublisherInsights';

export default function PublisherInsightsPage() {
	return <PublisherInsights refreshMs={ 4000 } />;
}
```

The bundle entry mounts that page into the div the PHP enqueue will render, `src/dashboard/index.js`:

```js
import { createRoot } from '@wordpress/element';
import PublisherInsightsPage from './PublisherInsightsPage';

document.addEventListener( 'DOMContentLoaded', () => {
	const el = document.getElementById( 'example-ai-newsletter-insights' );
	if ( el ) {
		createRoot( el ).render( <PublisherInsightsPage /> );
	}
} );
```

That is the entire view layer: one component reading one node's state, one client-side draft function, one mount.

---

## 6. Build it — a few lines, not a build system

The JS needs bundling (JSX, the `@wordpress/*` and `@newspack-nodes/*` imports, SCSS) into a single `build/dashboard/index.js` WordPress can enqueue. The substrate ships the builder; your `scripts/build.mjs` just declares its entries and injects its own tools:

```js
import esbuild from 'esbuild';
import * as sass from 'sass';
import rtlcss from 'rtlcss';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildDashboards } from '../../../src/build-kit/index.mjs';

const ROOT = path.resolve( path.dirname( fileURLToPath( import.meta.url ) ), '..' );

buildDashboards( {
	esbuild, sass, rtlcss, root: ROOT,
	entries: [ { entry: 'src/dashboard/index.js', outDir: path.resolve( ROOT, 'build/dashboard' ) } ],
	alias: {
		'@newspack-nodes/runtime':       path.resolve( ROOT, '../../src/runtime/index.js' ),
		'@newspack-nodes/shared':        path.resolve( ROOT, '../../src/shared' ),
		'@newspack-nodes/debug-overlay': path.resolve( ROOT, '../../src/debug-overlay/DebugOverlay.js' ),
	},
	watch: process.argv.includes( '--watch' ),
} ).catch( ( err ) => { console.error( err ); process.exit( 1 ); } );
```

`buildDashboards` rewrites every `@wordpress/*` import to the matching `window.wp.*` global (and records the dependency in `index.asset.php` so WordPress enqueues the right handles), compiles your SCSS, content-hashes the bundle for cache-busting, and emits the RTL companion. The `alias` map points the `@newspack-nodes/*` imports at the substrate's source — in this in-repo example, two levels up at `../../src`; a standalone plugin points them at its sibling `newspack-nodes` checkout (with `NEWSPACK_NODES_*` env overrides for CI).

The jest config is one call too, `jest.config.js`:

```js
const path = require( 'node:path' );
const { createJestConfig } = require( '../../src/build-kit/jest.cjs' );

module.exports = createJestConfig( {
	aliasBase:    path.resolve( __dirname, '../../src' ),
	pinReactFrom: path.resolve( __dirname, 'node_modules' ),
} );
```

`createJestConfig` resolves two `<rootDir>` files it expects you to provide (jest's convention, not the substrate's) — create both:

```js
// jest.setup.js — @testing-library matchers (toBeInTheDocument, …)
import '@testing-library/jest-dom';
```
```js
// jest.style-mock.js — SCSS/CSS imports are stubbed in tests
module.exports = {};
```

And the `npm run build` / `npm run test:js` the guide keeps invoking are just `package.json` scripts — the four you need:

```json
"scripts": {
	"build":   "npm run clean && node scripts/build.mjs",
	"watch":   "npm run clean && node scripts/build.mjs --watch",
	"clean":   "rm -rf build",
	"test:js": "jest --passWithNoTests"
}
```
(Plus the dev-dependencies any React/esbuild project needs — `esbuild`, `sass`, `rtlcss`, `jest`, `@testing-library/*`, `@wordpress/element`/`i18n`, `react`/`react-dom`; copy the example's `package.json` and `babel.config.js` rather than hand-rolling them.)

> **← two substrate refinements.** `scripts/build.mjs` was ~250 lines — the `@wordpress/*`→global externals plugin, the SCSS plugin, the asset-manifest emitter, the RTL pass, the watch/one-shot orchestration — copy-pasted across the substrate, the example, and the event-logger plugin. It became **`buildDashboards()`** (esbuild/sass/rtlcss are *injected*, so a sibling-checkout plugin with no `node_modules` of its own still resolves them). And the jest config hid a real footgun — the `@newspack-nodes/shared` mapper **must** precede the `\.(css|scss)$` style-mock, or an aliased style import resolves to the mock and the test crashes parsing SCSS as JS. **`createJestConfig()`** bakes that order in so you can't get it wrong. `npm run build`, `npm run test:js`, done.

---

## 7. Enqueue it — one registrar call, and the admin page

Finally, register the admin page (a menu item + a mount div) and enqueue the bundle on it. The enqueue is one substrate call. In the plugin file:

```php
const INSIGHTS_MENU_SLUG = 'example-ai-newsletter-insights';

// Register the dashboard as its OWN top-level menu — it's this plugin's page, not
// a Nodes-substrate tool, so it stands alone rather than nesting under "Nodes".
// The callback prints only the React mount div inside the standard `.wrap`.
function register_insights_admin_page(): void {
	if ( ! \class_exists( '\Newspack_Nodes\Admin\Admin' )
		|| ! \Newspack_Nodes\Admin\Admin::current_user_allowed() ) {
		return;
	}
	\add_menu_page(
		'Publisher Insights', 'Publisher Insights', 'manage_options', INSIGHTS_MENU_SLUG,
		static fn () => print( '<div class="wrap"><div id="' . \esc_attr( INSIGHTS_MENU_SLUG ) . '"></div></div>' ),
		'dashicons-chart-bar', 58.7
	);
}

// Enqueue the bundle on that page — one call.
function enqueue_insights_assets(): void {
	if ( ! \class_exists( '\Newspack_Nodes\Admin\Admin' )
		|| ! \Newspack_Nodes\Admin\Admin::current_user_allowed() ) {
		return;
	}
	\Newspack_Nodes\Admin\Admin::enqueue_react_page( [
		'handle'           => 'example-ai-newsletter-insights',
		'page'             => INSIGHTS_MENU_SLUG,
		'dir'              => __DIR__ . '/build/dashboard',
		'url'              => \plugins_url( 'build/dashboard', __FILE__ ),
		'version_fallback' => '0.1.0',
		'style_deps'       => [],
	] );
}

if ( \is_admin() ) {
	\add_action( 'admin_menu', __NAMESPACE__ . '\\register_insights_admin_page', 11 );
	\add_action( 'admin_enqueue_scripts', __NAMESPACE__ . '\\enqueue_insights_assets' );
}
```

A standalone plugin dashboard gets its **own** top-level menu (`add_menu_page`) — it shouldn't squat inside the substrate's "Nodes" menu, which is for Nodes' own tools (the Console, the DevTools hub). If your dashboard genuinely *is* a Nodes-internal tool, register it as a `host: 'hub'` DevTools tab (the hub's tab API) rather than an `add_submenu_page` under `Admin::TOPOLOGY_MENU_SLUG`. Either way, the gate above (`current_user_allowed()`) keeps visibility consistent with the substrate.

> **← a substrate refinement.** `enqueue_insights_assets` was ~40 lines: read the `$_GET['page']` and bail if it's not yours; `file_exists` the bundle; `require` the `index.asset.php` manifest for deps + version; `wp_enqueue_script`; the `index.css` sidecar; `wp_localize_script` the REST root + nonce as `NewspackNodesData` (which the JS `CommandClient` reads). Every dashboard repeated it. It became **`Admin::enqueue_react_page( $args )`** — page-gate, manifest deps/version, CSS (and the RTL companion, which no site previously activated), and the `NewspackNodesData` localize, returning the handle so a caller can layer extras. You pass it where your bundle is and which page it's for.

The `NewspackNodesData` the registrar localizes (`{ restUrl, nonce }`) is exactly what the JS `CommandClient` reads to authenticate the `POST /command` — so `enqueue_react_page` (PHP) and `useDashboardGraph`'s lazily-built `CommandClient` (JS) are the two ends of one wire.

---

## 8. Run it — drive the pipeline, watch the dashboard

```bash
# Build the bundle, then deploy/activate the plugin on a site with the substrate.
npm run build
wp nodes ls                       #   digest.p0   [live]
```

The worker is live but its snapshot is empty until the pipeline runs. Drive it from the worker's REPL — the sources emit on a `TICK` runtime request (`request_node`, not an admin command):

```bash
wp nodes cli digest.p0
```
```
> request_node releases  TICK
> request_node community TICK
```

Each `TICK` flows `source → summarizer → scorer → scored:partition`; the Consumer tails the scored records into the digest and co-commits the snapshot. Now open **Publisher Insights** (its own top-level item) in wp-admin. The page mounts, the poll fires, and you see it: **By source** counts, the **score-ranked table** (releases items at 6, community at 4–3, exactly the Scorer's weights), and **Draft newsletter** producing the markdown. It refreshes every 4 s while the tab is visible. `TICK` the sources again and watch the counts climb on the next poll.

You drove a server-side worker and a browser React app with the same protocol — a `TICK` runtime request to the sources, then a poll of `insights` — because both ends speak it.

---

## 9. Recap — what you wrote vs. what the substrate gave you

**You wrote:** a `Scorer` node (one `fill`, one `score()` seam), two snapshot methods on the digest, an `Insights_CI` with one verb, a JS view node (one `fill`), a 12-line hook, a thin React component, a client-side draft function, and ~15 lines of build/jest/enqueue glue.

**The substrate gave you:** the durable log + snapshotting Consumer, the command protocol and routing, the `_http` boundary, the JS node runtime and `mountExospine`, `useNodeState`, and — the through-line of this guide — six primitives that each used to be boilerplate in this very example:

| You call | It replaced |
|---|---|
| `Partition_Node::read_latest_value_at()` | a 20-line offsetlog walk, duplicated in the CLI |
| `Service_CI_Node` + `node_schema()` verb | a hand-built interpreter + REST controller |
| `@newspack-nodes/shared/pendingReplies` | a per-view reply-correlation `Map` + error coercion |
| `useDashboardGraph({ mountNodes, poll })` | a 120-line mount + poll + visibility hook |
| `buildDashboards()` / `createJestConfig()` | a 250-line esbuild config + a footgun-prone jest config |
| `Admin::enqueue_react_page()` | a 40-line page-gate + manifest + localize |

That table *is* the lesson, and it's the same one the first guide ends on, lifted to the client: **you add a dashboard by composing primitives, not by building a dashboard framework.** Every line above that felt like boilerplate became a substrate primitive the moment writing this walkthrough exposed it — which is exactly where the boilerplate belongs. Uphold the `fill()` contract, lean on the shared pieces, and the next dashboard is the four files you actually care about: a view node, a hook, a component, and a service verb.

---

## Where to go next

- **[writing-a-plugin.md](writing-a-plugin.md)** — the headless pipeline this dashboard reads from.
- **[ARCHITECTURE.md](architecture-guide.md)** — the full model: drain loop, partitions, workers, the REPL, and the JS runtime.
- **[`examples/example-ai-newsletter/`](examples/example-ai-newsletter/)** — the complete, tested code for this walkthrough, including the `src/dashboard/` suites (each node and hook tested with a fake `CommandClient`, no browser).
- **`newspack-event-logger-nodes`** — the production application: six real dashboards (performance, gyroscope, request stream, aggregator) built on these same primitives, including the SSE ones this guide's poll shape deliberately doesn't cover.
