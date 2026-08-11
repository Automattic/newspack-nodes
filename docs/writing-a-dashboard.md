# Writing a Nodes Dashboard

[writing-a-plugin.md](writing-a-plugin.md) stopped at a fully-working, fully-tested **headless** node plugin: the AI-newsletter digest pipeline. This walkthrough adds the other half — a **React admin dashboard** that reads the pipeline's live state and renders it in wp-admin. We'll end with **Publisher Insights**: a page that shows per-source counts, a score-ranked table of items, and a one-click "Draft newsletter" button.

The finished code is in [`examples/example-ai-newsletter/`](../examples/example-ai-newsletter/) — the same plugin the first guide built, now with a `src/dashboard/` tree and a scored, durable topology. Read along, or build it yourself and diff.

> **The one thing to hold onto:** a dashboard is *not* a new mechanism, and it is *not* one big React component fed by one big command. It is a **real node graph** — the same `fill(message)` contract you already know, expressed in JavaScript — with **message traffic at every edge**. Every edge is something you can drop a `Tee` into, watch in the debug overlay, and reuse on the next dashboard. You build a dashboard by *composing nodes*, exactly like a worker pipeline.

Do [writing-a-plugin.md](writing-a-plugin.md) first if you haven't — this guide assumes the digest pipeline (sources → summarizer → digest) and the `fill`/`sink`/`target`/`node_schema` vocabulary.

> **Diffing against the shipped code — the `_Demo` suffix.** The teaching snippets use bare names (`Scorer_Node`, `Insights_CI_Node`, …), but the bundled example carries a `_Demo` suffix on every class — `Scorer_Demo_Node`, `Insights_CI_Demo_Node`, files `class-*-demo-node.php`, namespace `Example_AI_Newsletter` — to deconflict from the real sibling plugin (`newspack-intelligence`) that can be loaded in the same WP. Likewise the topology file is `topologies/example-ai-newsletter.tsl` (name `example-ai-newsletter`), the durable log is `example-scored.p*`, and the mounted service CI node is `insights-demo`. So when you diff against [`examples/example-ai-newsletter/`](../examples/example-ai-newsletter/), map each bare name → its `_Demo` form.

> **A note on how this guide was written.** Every section below ends at a primitive in the substrate — `enqueue_react_page`, `buildDashboards`, `createJestConfig`, `Fetcher`, `read_latest_value_at`, `useBatchedPoll`. None of those existed when the dashboard was first built: each was 20–250 lines of copy-paste in the example until writing *this* walkthrough made the boilerplate impossible to ignore, at which point it moved into the substrate. That's the same rule the first guide follows — **when a step feels like boilerplate, the fix belongs in the substrate, not the tutorial.** §4's poll/batch wiring was the last seam this guide still showed hand-wired; it became `useBatchedPoll` + `addSliceFetcher` the moment a third caller copied it. Where a step is one call today, this guide says what it replaced, so you can see the seam.

---

## 0. What we're building

A dashboard's data flow is a node graph, so here is the whole graph — server side and browser side — laid out as nodes with traffic on every edge:

```
   browser (React admin page)
   ──────────────────────────────────────────────────────────────────────────
   insights:timer (Timer) ─> insights:tee (Tee) ─> fetch-counts (Fetcher) ─┐
                                                 ├> fetch-top    (Fetcher) ─┤  target = _shell/_http/insights-demo
                                                 └> fetch-acc    (Fetcher) ─┘
                                                                            │
                              _shell (Tap — watch every send) ─> _http (HttpOut)
                                              POST one batch    │ ▲  three replies batch back
                                                                ▼ │
   ════════════════════════════════════ server ═══════════════════════════════
                                  insights-demo (Insights_CI)
                          reads offsets/example-scored.p0 ONCE per request, then:
                          counts ─> {sources}   top ─> {top}   accumulated ─> {accumulated}
                                                                ▲ │
                                  each reply routes TO = the fetcher's receiver Tee
                                                                │ ▼
       countsIn (Tee) ─> source-counts:view ─> <SourceCounts/>
       topIn    (Tee) ─> top-table:view     ─> <TopTable/>
       accIn    (Tee) ─> accumulated:view   ─> <AccumulatedCard/>
```

Read that top to bottom. **One `Timer`** ticks; **one `Tee`** fans the tick to **three `Fetcher`s**; each Fetcher emits *its own* configured command through `_shell/_http/insights-demo`; the service CI answers each with a *small slice*; each reply routes back to *its own* receiver `Tee`, which fans to *its own* thin view node, which feeds *its own* React widget. **There is no place in this graph where the whole model lives.** Counts flow on the counts edges and never touch the top-table view; the top-table reply never touches the accumulated card.

That decomposition is the entire point. Here is the anti-pattern it exists to avoid:

> **The god object — what we're avoiding.** A "view node" that receives a finished `{sources, top, accumulated}` model from one server `insights` command and hands it to one React component is a **god node**, fed by a **god command**. It sits at **counter 0 / 0 B** in the topology console — zero traffic, nothing to `Tee`, nothing for the overlay to show, nothing reusable. That's a React app with a dead node stapled on, not a Nodes dashboard. **God commands are as bad as god nodes** — so we decompose *both* sides: three Fetchers, three slice verbs, three receiver Tees, three view nodes, three widgets.

Three pieces of new work, built in dependency order:

1. **Make the pipeline produce durable, scored state** the dashboard can read (a `Scorer` node + a durable log + a snapshotting `Consumer`). *Unchanged from a god-object dashboard — the data side is the same.*
2. **Serve that state** over the command protocol — as **three small slice verbs** (`counts`, `top`, `accumulated`), not one god verb, sharing one offsetlog read.
3. **Render it** — the real JS node graph (Timer → Tee → 3 Fetchers → 3 view nodes), three thin widgets, the build, the enqueue.

---

## 1. Give the pipeline something worth showing — score it, and make it durable

The digest from the first guide accumulates summaries in memory and flushes them to a file. A dashboard needs two things that pipeline lacks: a **score** to rank by, and **durable state** that survives the worker so the web request can read it.

### a. The Scorer — one more transform on the same contract

A `Scorer` is a transform exactly like the summarizer: receive a struct item, add a field, forward. The one seam a real scorer replaces is `score()`.

> Each PHP file below opens with the same preamble writing-a-plugin.md §2 established — `namespace Newspack_AI_Newsletter;` plus the `use Newspack_Nodes\{ Node, Message, Command_Interpreter_Node };` (or `Service_CI_Node`/`Partition_Node`/`Config`) it needs. The snippets show only the class body.

`includes/class-scorer-node.php`:

```php
class Scorer_Node extends Node {

	/** Per-source base weight; unknown sources score 1.0. */
	private const SOURCE_WEIGHT = [ 'releases' => 5.0, 'community' => 3.0 ];

	/** Bonus keywords — a title hit adds 1.0 each. */
	private const KEYWORDS = [ 'award', 'launch', 'ships', 'GA', 'million', '10k' ];

	/** The ONE seam a real scorer replaces: item -> notional priority score. */
	protected function score( array $item ): float {
		$source = Core::as_string( $item['source'] ?? null );
		$score  = self::SOURCE_WEIGHT[ $source ] ?? 1.0;
		$title  = Core::as_string( $item['title'] ?? null );
		foreach ( self::KEYWORDS as $kw ) {
			// Word-boundary match — 'GA' must not fire on "Garage".
			if ( 1 === \preg_match( '/\b' . \preg_quote( $kw, '/' ) . '\b/i', $title ) ) {
				$score += 1.0;
			}
		}
		return $score;
	}

	public function fill( array $message ): void {
		if ( 0 === ( ( $message[ Message::TYPE ] ?? 0 ) & Message::TM_STRUCT ) ) {
			return;
		}
		$item = $message[ Message::VALUE ];
		if ( ! \is_array( $item ) ) {
			return;
		}
		$item['score'] = $this->score( $item );

		$out                   = Message::new_message();
		$out[ Message::TYPE ]  = Message::TM_STRUCT;
		$out[ Message::FROM ]  = $this->name;
		$out[ Message::VALUE ] = $item;
		parent::fill( $out );   // stamp TO from target, forward to sink
	}
}
```

It slots between the summarizer and the digest: `summarizer → scorer → …`. Nothing else changes — the summarizer never learns there's a score, the digest never learns how it was computed. Same lesson as Ben's source in [writing-a-plugin.md](writing-a-plugin.md) §6.

### b. Durability — write to a log, tail it back, snapshot the result

The dashboard runs in a **web request**, a different process from the worker. It can't read the digest node's in-memory `$items`. So the pipeline has to write its state somewhere durable, and the substrate already has the parts: a **`Partition`** (an append-only log) and a **`Consumer`** (tails a log and forwards each record), plus the Consumer's **snapshot** feature, which co-commits a node's `save_state()` alongside its read cursor.

Here is the finished `topologies/example-ai-newsletter.tsl` for this chapter — the scored, durable graph (the durable log is `example-scored.p*`, not bare `scored.p*`, to keep the demo's data isolated from a real plugin's `scored` log in the same substrate dir):

```
var num_partitions = 1

make_node Releases_Source  releases
make_node Community_Source community
make_node Summarizer       summarizer
make_node Digest_Builder   digest
make_node Tee              digest:tee
make_node Log              digest:log /tmp/example-ai-newsletter/digest.md 1 2 7 0 0
cmd digest:log:config void_warranty
make_node Partition        scored:partition <config:logs_dir>/example-scored.p<partition> <config:segment_size> <config:min_segments> <config:num_segments> <config:min_lifetime> <config:lifetime>
cmd scored:partition:config void_warranty
make_node Consumer         scored:consumer <config:logs_dir>/example-scored.p<partition> <config:offsets_dir>/example-scored.p<partition> <config:deadletter_dir>/example-scored.p<partition>
cmd scored:consumer:config add_snapshot_node digest
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

- **`<config:...>` and `<partition>` tokens.** The `Partition`/`Consumer` arguments interpolate runtime config (the substrate's `logs_dir`, `segment_size`, …) and the worker's partition index, so the same `.tsl` works for any partition count. They're substrate-registered token namespaces — you use them, you don't declare them.
- **`scorer → scored:partition` writes the durable log;** `scored:consumer → digest` tails it straight back into the digest. The Consumer reads each scored record and `fill()`s it into the digest, exactly as a `connect_node` would.
- **`cmd scored:consumer:config add_snapshot_node digest`** is the key line. It tells the Consumer: each time you checkpoint your read cursor, also call `digest->save_state()` and co-commit that blob into your offsetlog **under the record's `cache` key, keyed by node name** — so a web request reads it straight back as `$value['cache']['digest']` (that's the `cache['digest']['items']` §2's reader pulls; your `save_state()` shape *is* the dashboard's read contract). On respawn the Consumer restores the cursor *and* hands the blob back via `digest->restore_state()` — **in lockstep**, so the digest's accumulated items and the cursor can never disagree. (`cmd scored:partition:config void_warranty` lifts the partition's 4 KB atomic-write cap, because a scored batch can exceed `PIPE_BUF` — see [ADR-4](architecture-decisions.md#adr-4-pipe_buf-atomic-writes).)

**The durable-snapshot recipe — lift these four lines.** This is the reusable pattern for *any* "make a worker's in-memory state readable from a web request" need; rename `scored` → your log name and `digest` → your state node:

```
make_node Partition  <log>:partition <config:logs_dir>/<log>.p<partition> <config:segment_size> <config:min_segments> <config:num_segments> <config:min_lifetime> <config:lifetime>
cmd <log>:partition:config void_warranty
make_node Consumer   <log>:consumer  <config:logs_dir>/<log>.p<partition> <config:offsets_dir>/<log>.p<partition> <config:deadletter_dir>/<log>.p<partition>
cmd <log>:consumer:config add_snapshot_node <state-node>
```

Then `connect_node <producer> <log>:partition` and `connect_node <log>:consumer <state-node>`. The four lines stay explicit on purpose: they're real nodes, so the topology console renders the durability and you can inspect the log and the read cursor live — a one-line macro would hide the `Partition`/`Consumer` and make the whole mechanism invisible on the canvas.

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

That's the whole durability story: the worker writes a snapshot the web request can read. Restart the worker, drive the pipeline, and `offsets/example-scored.p0` now holds the digest's scored items. Nothing in the dashboard reads in-memory state — it reads that snapshot.

---

## 2. Serve the data — three small slice verbs, not one god command

The browser can't read a file off the worker's disk. It speaks the **command protocol**: a `POST` of a `TM_COMMAND` to `/newspack-nodes/v1/command`, which the substrate routes to a node by name. So we mount a **service interpreter** into every web request and give it verbs.

The decomposition decision here is the same one we make on the client: a single `insights` verb returning `{sources, top, accumulated}` would be a **god command** — one verb that computes everything, that no one can reuse a slice of, that the dashboard can only fetch all-or-nothing. **God commands are as bad as god nodes.** So `Insights_CI` exposes **three small verbs**, one slice each:

- `counts` → `{ "sources": { "releases": 2, "community": 3 } }`
- `top` → `{ "top": [ { "source", "title", "score" }, … ] }`
- `accumulated` → `{ "accumulated": 5 }`

Each is independently fetchable (one `Fetcher` per verb, §3) — and because all three run inside one POST (§4's batching), they share **one** offsetlog read instead of globbing and unpacking the snapshot three times. That's the **memoized read** (`items()` + the `$read_items` closure seam): the first verb to run reads the snapshot once and caches the flattened items; the other two reuse the cache.

A service interpreter is a `Service_CI_Node` — a `Command_Interpreter_Node` whose verb table comes from its `node_schema()`, the same double-duty schema you already write for nodes. `includes/class-insights-ci-node.php`:

```php
class Insights_CI_Node extends Service_CI_Node {

	private const TOP_N = 10;

	/**
	 * Offsetlog-read seam. Lazily-defaulted to read_snapshot_items(); tests reassign it
	 * to count reads without short-circuiting the real glob/merge path. The memoized
	 * items() resolves and invokes it at most once per request.
	 *
	 * Signature: `function ( string $offsets_dir ): array<int,array<array-key,mixed>>`.
	 *
	 * @var \Closure|null
	 */
	public static ?\Closure $read_items = null;

	/** Per-request memo of the flattened snapshot items; null until items() reads once. */
	private ?array $items_cache = null;

	/**
	 * Read the offsetlog snapshot ONCE per request and memoize the flattened items, so the
	 * three batched slice verbs share a single read instead of globbing + unpacking thrice.
	 */
	private function items(): array {
		if ( null !== $this->items_cache ) {
			return $this->items_cache;
		}
		$read  = self::$read_items ?? static fn ( string $dir ): array => self::read_snapshot_items( $dir );
		$raw   = $read( Config::get_offsets_directory() );
		$items = [];
		foreach ( Core::arr( $raw ) as $item ) {
			if ( \is_array( $item ) ) {
				$items[] = $item;
			}
		}
		$this->items_cache = $items;
		return $this->items_cache;
	}

	/** Read every `example-scored.p*` offset dir's latest snapshot, flatten the digest caches. */
	public static function read_snapshot_items( string $offsets_dir ): array {
		return \Newspack_Nodes\Partition_Node::read_latest_snapshot_cache( $offsets_dir, 'example-scored.p*', 'digest' );
	}

	/** Count items per source → { source: count }. */
	private static function shape_sources( array $items ): array {
		$sources = [];
		foreach ( $items as $item ) {
			$source             = Core::str( $item['source'] ?? null, '?' );
			$sources[ $source ] = ( $sources[ $source ] ?? 0 ) + 1;
		}
		return $sources;
	}

	/** Top-N by score, descending, shaped to { source, title, score }. */
	private static function shape_top( array $items ): array {
		\usort(
			$items,
			static fn ( array $a, array $b ): int => Core::num_float( $b['score'] ?? null ) <=> Core::num_float( $a['score'] ?? null )
		);
		$top = [];
		foreach ( \array_slice( $items, 0, self::TOP_N ) as $item ) {
			$top[] = [
				'source' => $item['source'] ?? '?',
				'title'  => $item['title'] ?? '',
				'score'  => Core::num_float( $item['score'] ?? null ),
			];
		}
		return $top;
	}

}
```

> **← two substrate refinements, in sequence.** Reading "the newest committed record's VALUE from an offsetlog" used to be a 20-line walk (`new Partition_Node`, `arguments`, `get_segments(true)`, newest segment, `read_at`, split lines, `Message::unpacked`, pull `VALUE`) duplicated byte-for-byte in the substrate's `CLI::read_offsetlog_entry()` — that became **`Partition_Node::read_latest_value_at( $offsetlog_dir )`**. Then the *remaining* boilerplate (glob the `p*` snapshot dirs, descend into each `cache[<node>]['items']`, flatten) turned out to be the same in every dashboard, so it too moved down: **`Partition_Node::read_latest_snapshot_cache( $offsets_dir, $glob, $node )`** does the whole descent, and `read_snapshot_items()` collapsed to the one-liner above. You don't walk segments; you ask the Partition for its latest snapshot.

Now the three verbs. Each is a one-line `handler` that shapes one slice off the **memoized** `items()` and JSON-encodes it. Because a `Service_CI` verb runs *on the CI itself*, the interpreter handed to each handler **is** this node — so `$ci->items()` shares the per-request memo across all three:

```php
public static function node_schema(): array {
	// A Service_CI verb runs ON the CI — the interpreter IS this node, so $ci->items()
	// is the shared per-request memo. Service_CI_Node wraps every handler with
	// require_manage_options(), so the admin gate is centralized — no per-slice gate.
	// slice_verb() is the base-class helper: it wraps a shape callable into a verb
	// handler that json-encodes the shaped slice.
	return \array_merge( parent::node_schema(), [
		'category'    => 'Service',
		'description' => 'Reads the scored-pipeline offsetlog snapshot; serves the dashboard insights slices.',
		'commands'    => [
			[
				'name'        => 'counts',
				'description' => 'Return per-source item counts: { sources: { source: count } }.',
				'args'        => [],
				'handler'     => self::slice_verb( static fn ( self $ci ): array => [ 'sources' => self::shape_sources( $ci->items() ) ] ),
			],
			[
				'name'        => 'top',
				'description' => 'Return the top-10 items by score: { top: [ { source, title, score } ] }.',
				'args'        => [],
				'handler'     => self::slice_verb( static fn ( self $ci ): array => [ 'top' => self::shape_top( $ci->items() ) ] ),
			],
			[
				'name'        => 'accumulated',
				'description' => 'Return the total accumulated item count: { accumulated: N }.',
				'args'        => [],
				'handler'     => self::slice_verb( static fn ( self $ci ): array => [ 'accumulated' => \count( $ci->items() ) ] ),
			],
		],
	] );
}
```

Mount the CI on every request, exactly as a god-command dashboard would — the decomposition is in the *verbs*, not the mount:

```php
// In the plugin file: mount the CI into every request graph (idempotent).
function mount_insights_ci( \Newspack_Nodes\Command_Interpreter_Node $base ): void {
	if ( null !== \Newspack_Nodes\Core::node( 'insights-demo' ) ) {
		return;
	}
	require_once __DIR__ . '/includes/class-insights-ci-node.php';
	$base->make_node( 'Insights_CI', 'insights-demo' );
}
add_action( 'newspack_nodes/request_graph_ready', __NAMESPACE__ . '\\mount_insights_ci' );
```

Each verb returns its **slice as a JSON string** — `counts` gives `{sources}`, `top` gives `{top}`, `accumulated` gives `{accumulated}`. No transform node, no second round-trip; the browser's three fetches each get a finished slice in the POST response body. That choice — small slices, synchronous reads — is what makes the client three pure polls with no SSE.

You can verify this half **with no browser** — it's plain PHP:

```bash
wp eval '$items = \Example_AI_Newsletter\Insights_CI_Demo_Node::read_snapshot_items(
  \Newspack_Nodes\Config::get_offsets_directory() ); echo json_encode( $items );'
# [{"source":"releases","title":"Roundup Block ships","score":6}, …]
```

Server-side done. Now the browser.

---

## 3. The JS graph — Timer → Tee → three Fetchers, the same `fill()` contract

Here is the part that surprises people: **the browser runs the same node runtime.** `@newspack-nodes/runtime` is the JS port — `Node`, the `Message` field constants, a `CommandInterpreterNode`, `mountExospine` (which clips your nodes onto the standard `_command_interpreter → _router` backbone). So the client graph is *real*: a `Timer`, a `Tee`, three `Fetcher`s, three receiver `Tee`s, three view nodes. Message traffic at every edge.

### a. The `Fetcher` — the composition primitive

The piece that makes fan-out work is the generic **`Fetcher`** — a runtime node registered under the type name `Fetcher`, so you reach it through `makeNode`, not an import:

```js
// src/runtime/fetcher-node.js (already in the substrate — shown so you know the contract)
export class FetcherNode extends Node {
	// args = `<receiver> <command> [<command_args>...]`
	//   receiver — the local node the server's reply routes back TO (stamped as FROM)
	//   command  — the verb to send (CONFIGURED on the node, never read from the message)
	//   command_args — the remaining tokens as a flat token array (list<string>)

	fill( _message ) {
		if ( ! readyToMint() ) {
			return;   // unauthenticated; re-auth is under way, next poll carries it
		}
		const m = newMessage();
		m[ TYPE ]  = TM_COMMAND;
		m[ FROM ]  = this.receiver;                                    // reply routes back here
		m[ VALUE ] = { name: this.command, arguments: this.command_args };  // arguments is a token array
		markLocal( m );    // flag it as this process's own mint, and sign it
		super.fill( m );   // TO stamped from target, forwarded to sink
	}
}
```

Read `fill()` carefully — it **ignores its trigger message entirely**. Any message that arrives is only the *trigger* to emit *the Fetcher's own configured command*. The command is configured on the node at `make_node` time (`fetch-counts`'s command is `counts`, fixed), **never read from the triggering message**.

> **A node that sends the command its message carries is a `Shell`, and that's verboten.** A Shell *sends* arbitrary commands; a command *interpreter* is what *interprets* them. A named, always-firing node that relays whatever verb its incoming message names is a Shell wired into the graph — exactly the thing the substrate forbids. The Fetcher is the safe inverse: the command is fixed on the node, the message is only a trigger. When you need "on a tick, send verb X to node Y", reach for a `Fetcher`, never a Shell.

### b. Wiring the fan-out

`Timer ─> Tee ─> 3 Fetchers`, each Fetcher `connectNode`'d to **`_shell/_http/insights-demo`**:

- **`_http`** is the substrate's `HttpOut` egress — the boundary that POSTs the command batch to `/command`.
- **`_shell`** is an **observe-only `Tap`** sitting *in front* of `_http`. A `Tap` forwards everything to its sink unchanged, but it's a named node on the send path — so you can `connect _shell` in the console and **watch every command going out** without touching the graph. Routing the Fetchers through `_shell/_http/insights-demo` (not `_http/insights-demo` directly) is what buys you that observability. (`TO = _shell/_http/insights-demo` means: the router peels `_shell` → the Tap forwards to `_http` → `HttpOut` peels itself and POSTs to `insights-demo`.)

### c. The receiver reply path — why a `counts` reply only touches the counts view

Each Fetcher stamps **`FROM = its receiver Tee`** (`fetch-counts` → `FROM=countsIn`). The service CI replies **`TO = FROM`**, so the `counts` reply routes back to `countsIn`, which fans it to `source-counts:view`, which feeds `<SourceCounts/>`. The `top` reply lands on `topIn → top-table:view`; the `accumulated` reply on `accIn → accumulated:view`. **Three independent reply paths.** Nothing crosses; there is no shared model node to clobber.

### d. The thin view node

> **One-pager:** [writing-a-view-node.md](writing-a-view-node.md) distills this section into the view-node contract — the 3 routing facts, `setState('view')`, and why `fill()` must never throw.

Each view node is a `SliceViewNode` subclass that parses *its own* slice reply and publishes it. The base ships in the substrate — `@newspack-nodes/shared/nodes/slice-view-node` (shown here so you know the contract; it was a per-dashboard copy until it became a shared primitive):

```js
import { Node, TYPE, VALUE, TM_ERROR } from '@newspack-nodes/runtime';
import { errorMessage } from '@newspack-nodes/shared/pendingReplies';

export class SliceViewNode extends Node {
	constructor() {
		super();
		this.registrations.view = {};        // React subscribes to the 'view' state
		this.model = this.emptySlice();
		this.setState( 'view', this.model );  // a render before the first reply is valid
	}

	emptySlice() { return {}; }   // subclass supplies the shaped-but-empty slice

	fill( message ) {
		const value = message[ VALUE ];
		// TM_ERROR first: surface a transport error (string OR { payload }) so the widget never stays stale.
		if ( 0 !== ( ( message[ TYPE ] || 0 ) & TM_ERROR ) ) {
			const payload = value && 'object' === typeof value ? value.payload : value;
			this.model = { ...this.emptySlice(), error: errorMessage( payload ) };
			this.setState( 'view', this.model );
			return;
		}
		if ( ! value || 'object' !== typeof value ) {
			return;   // transient garbage keeps the prior slice
		}
		const slice = this._parse( value.payload );   // VALUE.payload is the slice's JSON string
		if ( null !== slice ) {
			this.model = slice;
			this.setState( 'view', this.model );        // publish → React re-renders
		}
	}
	// _parse(): JSON.parse with a try/catch, returns null on garbage.
}
```

Each subclass supplies **only** its empty slice — that is the whole subclass, `src/dashboard/nodes/source-counts-view-node.js`:

```js
import { SliceViewNode } from '@newspack-nodes/shared/nodes/slice-view-node';

// `source-counts:view` — owns the per-source counts slice ({ sources:{name:count} }).
export class SourceCountsViewNode extends SliceViewNode {
	emptySlice() { return { sources: {} }; }
}
```

`top-table-view-node.js` returns `{ top: [] }`; `accumulated-view-node.js` returns `{ accumulated: 0 }`. That's it — each owns one slice and nothing else.

> The `errorMessage` import is itself a substrate refinement: coercing a `TM_ERROR` payload (string / `{message}` / anything) to a readable string was copy-pasted across every dashboard view node, so it lives in **`@newspack-nodes/shared/pendingReplies`** now. (The companion `PendingReplies` Map is for views that *await* a verb — a button that fires a command and wants the reply. These three views only poll, so they don't need it.)

Register the three slice classes so `makeNode` can find them (the JS analogue of the PHP classmap) — `Timer`/`Tee`/`Fetcher`/`Tap`/`HttpOut` are runtime nodes and already registered. `src/dashboard/nodes/register.js`:

```js
import { CommandInterpreterNode } from '@newspack-nodes/runtime';
import { SourceCountsViewNode } from './source-counts-view-node';
import { TopTableViewNode } from './top-table-view-node';
import { AccumulatedViewNode } from './accumulated-view-node';

CommandInterpreterNode.registerNodeClasses( {
	SourceCountsView: SourceCountsViewNode,
	TopTableView: TopTableViewNode,
	AccumulatedView: AccumulatedViewNode,
} );
```

---

## 4. Mount the graph and poll it — the batched-poll toolkit

The hook builds the real graph and owns the poll loop. It does **not** use `useDashboardGraph` — that shortcut (mount one view node + fire one `poll` command) *is* the god pattern, the convenience that produced every god-object dashboard. We're composing a graph, so we reach for the substrate's batched-poll toolkit instead: **`useBatchedPoll`** owns all the mount/batch boilerplate, and **`addSliceFetcher`** wires one slice in one call. The hook is then its slices and nothing else.

`src/dashboard/hooks/usePublisherInsightsGraph.js`:

```js
import { useBatchedPoll } from '@newspack-nodes/shared/hooks/useBatchedPoll';
import { addSliceFetcher } from '@newspack-nodes/shared/helpers/addSliceFetcher';
import '../nodes/register';

const SERVER = 'insights-demo';   // the server-side CI mount (real product owns unsuffixed `insights`)
const TARGET = `_shell/_http/${ SERVER }`;

// { fetcher node, receiver Tee, verb, view node, view class } — one per slice.
const SLICES = [
	{ fetcher: 'fetch-counts', receiver: 'countsIn', command: 'counts',      view: 'source-counts:view', viewClass: 'SourceCountsView' },
	{ fetcher: 'fetch-top',    receiver: 'topIn',    command: 'top',         view: 'top-table:view',     viewClass: 'TopTableView' },
	{ fetcher: 'fetch-acc',    receiver: 'accIn',    command: 'accumulated', view: 'accumulated:view',   viewClass: 'AccumulatedView' },
];

export function usePublisherInsightsGraph( opts = {} ) {
	useBatchedPoll( {
		// build only adds THIS dashboard's nodes onto the owned fan-out Tee.
		build: ( { interpreter, tee } ) =>
			SLICES.forEach( ( slice ) =>
				addSliceFetcher( interpreter, { ...slice, tee, target: TARGET } )
			),
		timerName: 'insights:timer',
		teeName:   'insights:tee',
	} );
}
```

`useBatchedPoll` owns everything that used to be hand-wired here — the `mountExospine` call that brings the `_shell` Tap and the `_http` HttpOut (whose command client it assigns, injectable for tests), the fan-out `Tee`, the router-hitchhike `Timer`, the lock/flush bracket, and the page-visibility gate. Each `addSliceFetcher` wires one Fetcher → `_shell/_http/insights-demo`, its receiver Tee, and its view node. (When a slice needs a per-slice merge/dedup, pass `addSliceFetcher` a `transform: { name, nodeClass, args }` and it drops that node onto the receiver-Tee → view edge — so the transform lands on a graph edge, not inside the view.)

`useBatchedPoll` also takes two production knobs the real dashboards lean on, passed in the same options bag. Our toy polls every router tick and never pauses, so it passes neither:

- **`intervalMs`** — the poll cadence. Omit it (or `0`) to fire every router tick; a value `> 1000` throttles the Timer's hitchhike to that many milliseconds, re-pacing live when it changes. The event-aggregator dashboard wires this to its user-chosen refresh dropdown (`intervalMs: parseInt( refreshInterval, 10 ) || 0`).
- **`paused`** — suspend polling *without* unmounting the graph (it stops the Timer's hitchhike, exactly like a hidden tab, and resumes when false). The Overview dashboard passes `paused: dragging` so a poll doesn't fight a drag in flight.

(A slice can also emit *live* command args per tick — `addSliceFetcher` takes an `argsFn: () => argsTokens` fire-time getter, returning a flat token array, that it assigns to the Fetcher's `command_args`, so a filter/sort/page value can track React state without re-wiring the graph. The toy's three verbs take no args, so it doesn't need one.)

Two ideas still carry the whole hook; the toolkit owns them now instead of each hook copying them:

- **The tick hitchhike + the batch lock.** `insights:timer` is a `Timer` in router-hitchhike mode (`setTimer()` with no args) — it fires on every `_router` TIMER tick. `useBatchedPoll` brackets that tick with `http.lock()` and `http.flush()`. So when the tick fans out through the Tee to all three Fetchers, each Fetcher's command buffers behind the `_http` lock, and the single `flush()` after the tick ships them as **one `postBatch`**. **Fan-out is free: three Fetchers, one HTTP round-trip** — add a fourth slice and it's still one POST per tick. (This is the same batching principle the worker side gets from the drain loop — more traffic per tick, the same fixed cost.)
- **Page-visibility gating.** While the tab is hidden, the toolkit calls `timer.stopTimer()` to unregister the Timer from the router TIMER, so a tick fans out to nothing and no POST goes out; becoming visible re-arms it. No wasted polls behind a backgrounded tab.

> **← a substrate refinement.** The `_shell`-Tap + the `_http` `lock`/`flush` batching wiring — and the Timer/Tee/page-visibility plumbing around it — used to be **hand-wired here**, ~50 lines of `useEffect` + `mountExospine` copy-pasted across this example, the topology console's poll dashboards, and the performance hook. The batching *is* a primitive now: it became **`useBatchedPoll(build)`** (the mount + `_shell`/`_http` + Timer/Tee + lock/flush bracket + page-visibility gate) and **`addSliceFetcher()`** (the per-slice Fetcher → receiver-Tee → view block, with an optional transform slot). The hook collapsed to its slices, 175 lines down to 76, with the plumbing gone. That's the dogfooding rule this guide runs on: the moment a third caller copied the wiring, it moved into the substrate — so §4 is now one call, exactly like §6/§7.

The reply routing is worth reading once, because it's the whole graph in miniature. A Fetcher emits `TO=_shell/_http/insights-demo` (peeled hop by hop to the egress) and `FROM=countsIn`. The service CI's `counts` verb replies `TO=FROM=countsIn`, the router delivers it to the `countsIn` Tee, and the Tee fans it to `source-counts:view`. Same TO/FROM mechanics as the PHP side — the only browser-specific nodes are `_http` (the egress) and `_shell` (the observe Tap in front of it).

---

## 5. The view — three thin widgets, each reading its own node

There is no "the React component" here — there are **three** thin widgets, one per slice, each subscribing to *its own* view node via `useNodeState`. That's the composition made visible in the UI: each widget owns its data, its empty state, and its error state. No widget reads a god model; none can blank another.

The page lays the three out, `src/dashboard/PublisherInsightsPage.js`:

```js
import { __ } from '@wordpress/i18n';
import { usePublisherInsightsGraph } from './hooks/usePublisherInsightsGraph';
import { SourceCounts } from './widgets/SourceCounts';
import { TopTable } from './widgets/TopTable';
import { AccumulatedCard } from './widgets/AccumulatedCard';
import './styles/insights.scss';

export default function PublisherInsightsPage() {
	usePublisherInsightsGraph();   // mount the graph + start polling

	return (
		<div className="eai-insights">
			<header className="eai-insights__header">
				<h1>{ __( 'Publisher Insights', 'example-ai-newsletter' ) }</h1>
				<p className="eai-insights__sub">
					{ __( 'Each card is its own node graph slice — counts, top items, and the accumulated total.', 'example-ai-newsletter' ) }
				</p>
			</header>
			<div className="eai-insights__grid">
				<div className="eai-insights__stats"><AccumulatedCard /></div>
				<SourceCounts />
				<TopTable />
			</div>
		</div>
	);
}
```

Each widget reads exactly one node. `AccumulatedCard` is the simplest — it subscribes to `accumulated:view`, owns its own error branch, and renders one number. `src/dashboard/widgets/AccumulatedCard.js`:

```js
import { __ } from '@wordpress/i18n';
import { useNodeState } from '@newspack-nodes/runtime';

export function AccumulatedCard() {
	const slice = useNodeState( 'accumulated:view', 'view' ) || { accumulated: 0 };

	if ( slice.error ) {
		return <div className="eai-insights__notice eai-insights__notice--error" role="alert">{ slice.error }</div>;
	}
	return (
		<div className="eai-insights__stat">
			<span className="eai-insights__stat-num">{ slice.accumulated ?? 0 }</span>
			<span className="eai-insights__stat-label">{ __( 'Total items', 'example-ai-newsletter' ) }</span>
		</div>
	);
}
```

`SourceCounts` reads `source-counts:view` and renders one proportion bar per source — with its **own** error notice and its **own** "No sources yet" empty hint. `TopTable` reads `top-table:view` and renders the score-ranked table, with its own error/empty branches — that per-widget ownership of empty and error state *is* the composition: each card degrades independently. The `|| { … }` fallback in each (`useNodeState` returns undefined before the first reply) means the first render is valid — the view node guarantees its shaped-but-empty slice on construction.

`TopTable` also owns the newsletter actions — the **Draft newsletter**, **Copy markdown**, and **Create draft post** buttons — because they operate on *its* `top` items. The markdown is composed in the browser; only **Create draft post** leaves it, and it goes to the WP REST API, never back through the node graph. The three actions share one tiny normalizer so the on-screen preview, the markdown draft, and the draft-post HTML all agree on a row's display strings, `src/dashboard/itemLabel.js`:

```js
import { __ } from '@wordpress/i18n';

/** Normalize a ranked item to display strings — shared empty-field fallbacks, applied once. */
export function itemLabel( item = {} ) {
	return {
		title:  item.title  || __( '(untitled)', 'example-ai-newsletter' ),
		source: item.source || '?',
	};
}
```

`draftNewsletter` then turns the already-ranked `top` into markdown, `src/dashboard/draftNewsletter.js`:

```js
import { __ } from '@wordpress/i18n';
import { itemLabel } from './itemLabel';

export function draftNewsletter( items = [] ) {
	const lines = [ `# ${ __( 'Publisher Newsletter', 'example-ai-newsletter' ) }`, '' ];
	for ( const item of items ) {
		const { title, source } = itemLabel( item );
		lines.push( `- **${ title }** — ${ source }` );
	}
	return lines.join( '\n' );
}
```

`PublisherInsightsPage` reads `import './styles/insights.scss'` — create that file. Style it to the **Newspack in-product design system**: Cobalt (`#003DA5`) for the primary action, neutral surfaces (`#fff` / `#f7f7f7`) and borders (`#ddd`), `#1e1e1e` / `#6c6c6c` text, Inter, the 4/8/16/24 spacing scale, and functional colors (error `#B32D2E` on subtle `#FCF0F1`) only for status. The example's `insights.scss` is the reference. **Lay it out in flow** — a normal block in the admin content column — *not* `position: fixed` / full-bleed: that overlay pattern belongs to the Topology Console and the DevTools hub (which deliberately take over the viewport), and on a standalone admin page it hides the WP admin bar and menu.

The bundle entry mounts the page into the div the PHP enqueue will render, `src/dashboard/index.js`:

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

That is the entire view layer: three thin widgets reading three nodes, the client-side draft helpers, one mount.

---

## 6. Build it — a few lines, not a build system

The JS needs bundling (JSX, the `@wordpress/*` and `@newspack-nodes/*` imports, SCSS) into a single `build/dashboard/index.js` WordPress can enqueue. The substrate ships the builder; your `scripts/build.mjs` declares its entries and injects its own tools:

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
	// Bare imports inside the aliased substrate sources (d3, …) resolve here.
	nodePaths: [ path.resolve( ROOT, '../../node_modules' ) ],
	watch: process.argv.includes( '--watch' ),
} ).catch( ( err ) => { console.error( err ); process.exit( 1 ); } );
```

`buildDashboards` rewrites each `@wordpress/*` import listed in its `WP_EXTERNALS` map to the matching `window.wp.*` global (and records the dependency in `index.asset.php` so WordPress enqueues the right handles), compiles your SCSS, content-hashes the bundle for cache-busting, and emits the RTL companion. The `alias` map points the `@newspack-nodes/*` imports at the substrate's source — in this in-repo example, two levels up at `../../src` from `ROOT`. (The kit itself is loaded the same way: a `ROOT`-relative path with its own env override, dynamically imported after an exists guard — see the example's `scripts/build.mjs` — so all four substrate paths resolve from `ROOT`; match your own layout.) A standalone plugin points the aliases at its sibling `newspack-nodes` checkout instead, overridable per-environment via **one** env var, `NEWSPACK_NODES_SRC` — the substrate's `src` directory. Everything else is derived from it by `src/build-kit/alias-map.js`, the single resolver both esbuild and jest read, so the two cannot disagree about where an alias points.

It used to be four independent overrides, one per alias plus the kit, all naming paths inside that same directory; a release workflow had to set every one, and omitting any single one silently resolved to a nonexistent sibling path. Setting a retired name now fails the build immediately and names it, rather than being ignored.

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

And the `npm run build` / `npm run test:js` the guide keeps invoking are `package.json` scripts — the four you need:

```json
"scripts": {
	"build":   "npm run clean && node scripts/build.mjs",
	"watch":   "npm run clean && node scripts/build.mjs --watch",
	"clean":   "rm -rf build",
	"test:js": "jest --passWithNoTests"
}
```
(Plus the dev-dependencies any React/esbuild project needs — `esbuild`, `sass`, `rtlcss`, `jest`, `@testing-library/*`, `@wordpress/element`/`i18n`, `react`/`react-dom`; copy the example's `package.json` and `babel.config.js` rather than hand-rolling them.)

> **← two substrate refinements.** `scripts/build.mjs` was ~250 lines — the `@wordpress/*`→global externals plugin, the SCSS plugin, the asset-manifest emitter, the RTL pass, the watch/one-shot orchestration — copy-pasted across the substrate, the example, and the event-logger plugin. It became **`buildDashboards()`** (esbuild/sass/rtlcss are *injected*, so a sibling-checkout plugin with no `node_modules` of its own still resolves them). And the jest config hid a real footgun — the `@newspack-nodes/shared` mapper is listed **before** the `\.(css|scss)$` style-mock, and first match wins, so a style imported *through the alias* (`@newspack-nodes/shared/styles/x.scss`) resolves to the real file and babel-jest crashes parsing SCSS as JS instead of mocking it. **`createJestConfig()`** bakes that order in, and shared components import their own styles by relative path so the mock catches them. `npm run build`, `npm run test:js`, done.

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
		'style_deps'       => [ 'wp-components', 'newspack-nodes-graph' ],
	] );
}

if ( \is_admin() ) {
	\add_action( 'admin_menu', __NAMESPACE__ . '\\register_insights_admin_page', 11 );
	\add_action( 'admin_enqueue_scripts', __NAMESPACE__ . '\\enqueue_insights_assets' );
}
```

A standalone plugin dashboard gets its **own** top-level menu (`add_menu_page`) — it shouldn't squat inside the substrate's "Nodes" menu, which is for Nodes' own tools (the Console, the DevTools hub). If your dashboard genuinely *is* a Nodes-internal tool, register it as a `host: 'hub'` DevTools tab (the hub's tab API) rather than an `add_submenu_page` under `Admin::MENU_SLUG`. Either way, the gate above (`current_user_allowed()`) keeps visibility consistent with the substrate.

This example mounts `DebugOverlay` in §9, so its stylesheet explicitly depends on `newspack-nodes-graph` (which brings the canonical UI and theme handles with it). `GraphView` deliberately has no stylesheet side-effect import: every host that renders the graph owns this dependency, keeping the graph CSS in one build asset instead of copying it into each consumer bundle.

> **← a substrate refinement.** `enqueue_insights_assets` was ~40 lines: read the `$_GET['page']` and bail if it's not yours; `file_exists` the bundle; `require` the `index.asset.php` manifest for deps + version; `wp_enqueue_script`; the `index.css` sidecar; `wp_localize_script` the REST root + nonce as `NewspackNodesData` (which the JS transport reads). Every dashboard repeated it. It became **`Admin::enqueue_react_page( $args )`** — page-gate, manifest deps/version, CSS (and the RTL companion, which no site previously activated), and the `NewspackNodesData` localize, returning the handle so a caller can layer extras. You pass it where your bundle is and which page it's for.

The `NewspackNodesData` the registrar localizes (`{ restUrl, nonce }`) is exactly what the JS `defaultTransport()` reads to authenticate the `POST /command` — so `enqueue_react_page` (PHP) and HttpOut's lazily-defaulted transport (JS) are the two ends of one wire.

---

## 8. Run it — drive the pipeline, watch the dashboard, then inspect the graph

```bash
# Build the bundle, then deploy + activate the plugin on a site with the substrate.
npm run build
wp nodes activate example-ai-newsletter   # add to the active set + spawn the fleet now
wp nodes status                               #   example-ai-newsletter  0  live  3s ago  2m 10s
```

The worker is live but its snapshot is empty until the pipeline runs. Drive it from the worker's REPL — the sources emit on a `TICK` runtime request (`request_node`, not an admin command):

```bash
wp nodes cli example-ai-newsletter.p0
```
```
> request_node releases  TICK
> request_node community TICK
```

Each `TICK` flows `source → summarizer → scorer → scored:partition`; the Consumer tails the scored records into the digest and co-commits the snapshot. Now open **Publisher Insights** (its own top-level item) in wp-admin. The page mounts, the three Fetchers fire on the first tick (one POST), and you see it: **By source** counts, the **score-ranked table** (releases items at 6, community at 4–3, exactly the Scorer's weights) with its **Draft newsletter** button, and the **Total items** card. It refreshes every tick while the tab is visible. `TICK` the sources again and watch the counts climb on the next poll.

**Now the payoff the god node forfeits — inspect the live graph.** Because every edge carries real traffic, you can introspect any of it without redeploying. The dashboard's nodes live in the *browser*, so their REPL is the page's own — the debug overlay (§9) or the topology console — not `wp nodes cli`, which attaches to the worker's server-side graph:

```
> connect _shell    # watch EVERY command the Fetchers send, live
> ls                # insights:timer, insights:tee, fetch-* — all at non-zero counters
```

Drop a `Tee` onto any edge to fork a copy of the traffic; `connect _shell` to watch the three commands stream out each tick; watch the three counters (`fetch-counts`, `fetch-top`, `fetch-acc`) move independently. A god view-node at counter 0 gives you none of that — there's nothing flowing to observe. *That* is why you built the dashboard on Nodes instead of stapling a fetch loop to a React component.

You drove a server-side worker and a browser React app with the same protocol — a `TICK` runtime request to the sources, then a batched poll of three slice verbs — because both ends speak it.

---

## 9. Make it inspectable: mount the debug overlay

§8 ended on the payoff — *inspect the live graph*. From the worker's REPL that's `wp nodes cli`; **on the page itself** it's the **debug overlay**, and wiring it in is two lines. The overlay reads the page's *own* live `mountExospine` graph — the very `Core.nodes` your hook built — and renders it in the shared GraphView: every node, every edge, every counter, plus a REPL to poke it (`connect`/`remove`/`invoke`). That's the whole reason you built the dashboard as a genuine node graph instead of a fetch loop stapled to a component — the graph is *there* to be inspected, so put the inspector on the page.

Add the import and render it inside the page, alongside the widgets:

```js
import DebugOverlay from '@newspack-nodes/debug-overlay';
// …
<DebugOverlay storageKey="newspack-nodes:debug:example-insights" />
```

That's the entire wiring — `PublisherInsightsPage` already does exactly this (the worked case): one import, one element rendered after the `eai-insights__grid`. Three things make it free to leave in production:

- **It's self-gated by `isDebugEnabled`.** The overlay renders `null` unless debug is on — `?nodes-debug=1` in the URL turns it on and sticks it in `localStorage` (so it survives navigation), `?nodes-debug=0` turns it off. Absent the param, the sticky flag decides. So a shipped dashboard carries the overlay dormant: invisible to normal visitors, one query param away for you. (It's a pure dev affordance — no capability/PHP gate — so the FAB only ever appears for someone who deliberately flipped the flag.)
- **`storageKey` is per-dashboard.** It persists *this* overlay's panel layout independently of every other dashboard's, so name it `newspack-nodes:debug:<dashboard>` — `newspack-nodes:debug:example-insights` here, `newspack-nodes:debug:gyroscope` on the gyroscope page. Reusing one key across pages would make them fight over the same saved layout.
- **It reads the live graph, not a snapshot.** Because the overlay subscribes to the same `Core.nodes` your `useBatchedPoll` hook built, opening it (`Ctrl+\`` toggles the panel) shows the real thing live: `insights:timer`, `insights:tee`, the three `fetch-*` Fetchers, the receiver Tees, the view nodes — each at its real counter, climbing on every tick. Drop a `Tee` onto an edge or `invoke` a verb right from the panel. A god view-node at counter 0 would give the overlay nothing to draw; *this* graph is the payoff, and the overlay is how you see it.

One mount, and every dashboard you build the right way becomes self-documenting — the node graph you composed is visible, live, on its own page.

---

## 10. Recap — what you wrote vs. what the substrate gave you

**You wrote:** a `Scorer` node (one `fill`, one `score()` seam), two snapshot methods on the digest, an `Insights_CI` with **three small slice verbs** sharing one memoized read, **three thin `SliceViewNode` subclasses** (each only an `emptySlice()`), a `useBatchedPoll` hook whose `build` is one `addSliceFetcher` per slice, **three thin widgets** each reading its own node, the client-side draft helpers, and the thin build/jest/enqueue glue — a `scripts/build.mjs`, a `jest.config.js`, and the two enqueue functions.

**The substrate gave you:** the durable log + snapshotting Consumer, the command protocol and routing, the `_http`/`_shell` boundary, the JS node runtime and `mountExospine`, `useNodeState`, the **`Fetcher`** composition primitive, and — the through-line of this guide — primitives that each used to be boilerplate in this very example:

| You call | It replaced |
|---|---|
| `Fetcher` (trigger → one configured command, FROM=receiver) | a bespoke command-firing view node per dashboard (a Shell, verboten) |
| `useBatchedPoll(build)` | the ~50-line `mountExospine` + `_shell`/`_http` + Timer/Tee + lock/flush + page-visibility mount, copy-pasted per dashboard |
| `addSliceFetcher()` | the 6-line per-slice Fetcher → receiver-Tee → view block (the `SLICES.forEach` body) |
| `Partition_Node::read_latest_value_at()` | a 20-line offsetlog walk, duplicated in the CLI |
| `Service_CI_Node` + `node_schema()` verbs | a hand-built interpreter + REST controller |
| `@newspack-nodes/shared/pendingReplies` (`errorMessage`) | a per-view error-coercion helper, copy-pasted |
| `buildDashboards()` / `createJestConfig()` | a 250-line esbuild config + a footgun-prone jest config |
| `Admin::enqueue_react_page()` | a 40-line page-gate + manifest + localize |

The `useBatchedPoll`/`addSliceFetcher` rows are the newest entries — the §4 poll/batch wiring was the last seam this guide still showed hand-wired, and it moved into the substrate the moment a third caller copied it.

That table *is* the lesson, and it's the same one the first guide ends on, lifted to the client with one addition: **dashboards are composed node graphs, not a god view-node + god command.** You add a dashboard by composing primitives — a Timer, a Tee, Fetchers, thin view nodes, small verbs — not by building a dashboard framework and not by funneling everything through one node and one command. Uphold the `fill()` contract, decompose both sides, lean on the shared pieces, and the next dashboard is the handful of files you care about: the slice verbs, the view nodes, the widgets, and the hook that wires them.

---

## Where to go next

- **[writing-a-plugin.md](writing-a-plugin.md)** — the previous guide in order: the headless pipeline this dashboard reads from.
- **[writing-a-real-dashboard.md](writing-a-real-dashboard.md)** — the next step: take these primitives to a production dashboard.
- **[architecture-guide.md](architecture-guide.md)** — the full model: drain loop, partitions, workers, the REPL, and the JS runtime.
- **[`examples/example-ai-newsletter/`](../examples/example-ai-newsletter/)** — the complete, tested code for this walkthrough, including the `src/dashboard/` suites (each node, hook, and widget tested against a fake wire, no browser).
- **`newspack-event-logger-nodes`** — the production application: four real dashboards (Performance, Error Log, Gyroscope, Request Log) built on these same primitives, including the SSE ones this guide's poll shape deliberately doesn't cover.
</content>
</invoke>
