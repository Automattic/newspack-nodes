# Writing a Nodes Dashboard

[writing-a-plugin.md](writing-a-plugin.md) stopped at a fully-working, fully-tested **headless** node plugin: the AI-newsletter digest pipeline. This walkthrough adds the other half — a **React admin dashboard** that reads the pipeline's live state and renders it in wp-admin. We'll end with **Publisher Insights**: a page that shows per-source counts, a score-ranked table of items, and a one-click "Draft newsletter" button.

The finished code is in [`examples/example-ai-newsletter/`](../examples/example-ai-newsletter/) — the same plugin the first guide built, now with a `src/dashboard/` tree and a scored, durable topology. Read along, or build it yourself and diff.

> **The one thing to hold onto:** a dashboard is *not* a new mechanism, and it is *not* one big React component fed by one big command. It is a **real node graph** — the same `fill(message)` contract you already know, expressed in JavaScript — with **message traffic at every edge**. Every edge is something you can drop a `Tee` into, watch in the debug overlay, and reuse on the next dashboard. You build a dashboard by *composing nodes*, exactly like a worker pipeline.

Do [writing-a-plugin.md](writing-a-plugin.md) first if you haven't — this guide assumes the digest pipeline (sources → summarizer → digest) and the `fill`/`sink`/`target`/`node_schema` vocabulary.

> **Diffing against the shipped code — the `_Demo` suffix.** The teaching snippets use bare names (`Scorer_Node`, `Insights_CI_Node`, …), but the bundled example carries a `_Demo` suffix on every class — `Scorer_Demo_Node`, `Insights_CI_Demo_Node`, files `class-*-demo-node.php`, namespace `Example_AI_Newsletter` — to deconflict from the real sibling plugin (`newspack-intelligence`) that can be loaded in the same WP. Likewise the topology file is `topologies/example-ai-newsletter.tsl` (name `example-ai-newsletter`), the durable log is `example-scored.p*`, and the mounted service CI node is `insights-demo`. So when you diff against [`examples/example-ai-newsletter/`](../examples/example-ai-newsletter/), map each bare name → its `_Demo` form.

> **A note on how this guide was written.** Every section below ends at a primitive in the substrate — `enqueue_react_page`, `buildDashboards`, `createJestConfig`, `Fetcher`, `read_latest_snapshot_cache`, `useBatchedPoll`, `addSliceFetcher`. None of those existed when the dashboard was first built: each was 20–250 lines of copy-paste in the example until writing *this* walkthrough made the boilerplate impossible to ignore, at which point it moved into the substrate. That's the same rule the first guide follows — **when a step feels like boilerplate, the fix belongs in the substrate, not the tutorial.** Where a step is one call today, this guide says what it replaced, so you can see the seam.

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
       countsIn (Tee) ─> source-counts:view ─> <SourceCounts/>      …and back to
       topIn    (Tee) ─> top-table:view     ─> <TopTable/>          its own Fetcher,
       accIn    (Tee) ─> accumulated:view   ─> <AccumulatedCard/>   settling the ask
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

> Each PHP file below opens with the same preamble writing-a-plugin.md §2 established — `namespace Newspack_AI_Newsletter;` plus the `use Newspack_Nodes\{ Node, Message, Core, Command_Interpreter_Node };` (or `Service_CI_Node`/`Partition_Node`/`Config`) it needs. The snippets show only the class body.

`includes/class-scorer-node.php`:

```php
class Scorer_Node extends Node {

	/** Per-source base weight; unknown sources score 1.0. */
	private const SOURCE_WEIGHT = [ 'releases' => 5.0, 'community' => 3.0 ];

	/** Bonus keywords — a title hit adds 1.0 each. */
	private const KEYWORDS = [ 'award', 'launch', 'ships', 'GA', 'million', '10k' ];

	public function fill( array $message ): void {
		$type = $message[ Message::TYPE ];
		if ( ! ( $type & Message::TM_STRUCT ) ) {
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

	/** The ONE seam a real scorer replaces: item -> notional priority score. */
	protected function score( array $item ): float {
		$source = Core::as_string( $item['source'] ?? null );
		$base   = self::SOURCE_WEIGHT[ $source ] ?? 1.0;
		$title  = Core::as_string( $item['title'] ?? null );
		$bump   = 0.0;
		foreach ( self::KEYWORDS as $kw ) {
			// Word-boundary match — 'GA' must not fire on "Garage".
			if ( 1 === \preg_match( '/\b' . \preg_quote( $kw, '/' ) . '\b/i', $title ) ) {
				$bump += 1.0;
			}
		}
		return \round( $base + $bump, 1 );
	}
}
```

It slots between the summarizer and the digest: `summarizer → scorer → …`. Nothing else changes — the summarizer never learns there's a score, the digest never learns how it was computed. Same lesson as Ben's source in [writing-a-plugin.md](writing-a-plugin.md) §6. The toy scorer carries no clock and no randomness, so its suite asserts exact scores rather than ranges; an LLM call belongs in `score()` and nothing else in the file changes when it arrives.

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
make_node Log              digest:log <config:logs_dir>/digest.md 1 2 7 0 0 0
cmd digest:log:config void_warranty
make_node Partition        scored:partition <config:logs_dir>/example-scored.p<partition> <config:segment_size> <config:min_segments> <config:num_segments> <config:max_segments> <config:min_lifetime> <config:lifetime>
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

- **`<config:...>` and `<partition>` tokens.** The `Log`/`Partition`/`Consumer` arguments interpolate runtime config (the substrate's `logs_dir`, `segment_size`, …) and the worker's partition index, so the same `.tsl` works for any partition count. They're substrate-registered token namespaces — you use them, you don't declare them. `Log` and `Partition` take the same seven positionals: the path, then `segment_size`, `min_segments`, `num_segments`, `max_segments`, `min_lifetime`, `lifetime`. Run `help Log` in the REPL for what each one prunes.
- **`scorer → scored:partition` writes the durable log;** `scored:consumer → digest` tails it straight back into the digest. The Consumer reads each scored record and `fill()`s it into the digest, exactly as a `connect_node` would.
- **`cmd scored:consumer:config add_snapshot_node digest`** is the key line. It tells the Consumer: each time you checkpoint your read cursor, also call `digest->save_state()` and co-commit that blob into your offsetlog **under the record's `cache` key, keyed by node name** — so a web request reads it straight back as `$value['cache']['digest']` (that's the `cache['digest']['items']` §2's reader pulls; your `save_state()` shape *is* the dashboard's read contract). On respawn the Consumer restores the cursor *and* hands the blob back via `digest->restore_state()` — **in lockstep**, so the digest's accumulated items and the cursor can never disagree. (`cmd scored:partition:config void_warranty` lifts the partition's 4 KB atomic-write cap, because a scored batch can exceed `PIPE_BUF` — see [ADR-4](architecture-decisions.md#adr-4-pipe_buf-atomic-writes).)

**The durable-snapshot recipe — lift these four lines.** This is the reusable pattern for *any* "make a worker's in-memory state readable from a web request" need; rename `scored` → your log name and `digest` → your state node:

```
make_node Partition  <log>:partition <config:logs_dir>/<log>.p<partition> <config:segment_size> <config:min_segments> <config:num_segments> <config:max_segments> <config:min_lifetime> <config:lifetime>
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

	/** Count items per source → { source: count }. An unnamed source counts under `?`. */
	private static function shape_sources( array $items ): array {
		$sources = [];
		foreach ( $items as $item ) {
			$source             = \is_string( $item['source'] ?? null ) ? $item['source'] : '?';
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

> **← two substrate refinements, in sequence.** Reading "the newest committed record's VALUE from an offsetlog" was a 20-line walk — construct a `Partition_Node`, set `arguments`, `get_segments( true )`, take the newest segment, `read_at`, split lines, `Message::unpacked`, pull `VALUE` — copied wherever a snapshot was read. It became **`Partition_Node::read_latest_value_at( $offsetlog_dir )`**, which falls back a segment when the newest one rotated but was never written. Then the *remaining* boilerplate — glob the `p*` snapshot dirs, descend into each `cache[<node>]['items']`, flatten — turned out to be the same in every dashboard, so it moved down too: **`Partition_Node::read_latest_snapshot_cache( $offsets_dir, $glob, $node )`** does the whole descent (`$cache_key` and `$items_key` default to `cache` and `items`), and `read_snapshot_items()` collapsed to the one-liner above. You don't walk segments; you ask the Partition for its latest snapshot. It re-globs on every call, which is exactly why `items()` memoizes.

Now the three verbs. Each is a one-line `handler` that shapes one slice off the **memoized** `items()` and JSON-encodes it. Because a `Service_CI` verb runs *on the CI itself*, the interpreter handed to each handler **is** this node — so `$ci->items()` shares the per-request memo across all three:

```php
public static function node_schema(): array {
	// A Service_CI verb runs ON the CI — the interpreter IS this node, so $ci->items()
	// is the shared per-request memo. Service_CI_Node gates every handler on the role
	// its schema entry declares in `capability`, defaulting to MANAGE — so a verb that
	// declares nothing demands the strictest role, and a per-slice gate here would
	// only stack a second check. slice_verb() is the base-class helper: it wraps a
	// shape callable into a verb handler that json-encodes the shaped slice.
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

A read-only dashboard can widen that gate by declaring the role on the verb — `'capability' => \Newspack_Nodes\Capabilities::READ` beside `'name'`, which is what the substrate's own dashboard verbs do. The three roles are `read` (dashboards, SSE, introspection), `tune` (declared configuration and application data) and `manage` (fleet control and credentials); all three resolve to `manage_options` until an operator runs `wp nodes caps install`.

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
// src/runtime/fetcher-node.js — the contract, not the whole file.
// args = `<receiver> <command> [<command_args>...]`
//   receiver     — the local node the server's reply routes back TO (stamped as FROM)
//   command      — the verb to send (CONFIGURED on the node, never read from the message)
//   command_args — the remaining tokens as a flat token array, or a fire-time getter
fill( message ) {
	if ( message[ TYPE ] & ( TM_RESPONSE | TM_ERROR ) ) {
		this._settle( message );   // the answer to an ask; take it off the outbox
		return;
	}
	if ( ! readyToMint() ) {
		return;   // unauthenticated; re-auth is under way, next poll carries it
	}
	// Re-send anything unanswered past retry_after_s, drop anything past the
	// hard expiry, then mint one new ask only when the outbox is empty.
	// _ask() builds the message:
	//   m[ TYPE ]  = TM_COMMAND;
	//   m[ FROM ]  = this.receiver;   // reply routes back here (ADR-7)
	//   m[ VALUE ] = { name: this.verb, arguments: ask.args };
	//   markLocal( m );               // this process's own mint — and its signature
	//   super.fill( m );              // TO stamped from target, forwarded to sink
}
```

Read `fill()` carefully — apart from a reply, it **ignores its trigger message entirely**. Its type, VALUE and addressing go unread: any message that is not a reply is only the *trigger* to emit *the Fetcher's own configured command*. The command is configured on the node at `make_node` time (`fetch-counts`'s command is `counts`, fixed), **never read from the triggering message**.

Two fields are what a caller reaches for. `outbox` holds the asks in flight, so a table can read which rows are still waiting; `command_args` holds either a static token array or a **fire-time getter** the trigger calls, which is how a filter, a sort or a page value tracks React state without re-wiring the graph. `send( args, path, supersede )` is the other way in, for a caller with an answer to wait on: it parks arguments the next trigger puts on the wire, and parks the **subject** the ask is about, which rides on FROM so the answer comes back naming it. That is how one Fetcher serves many rows with nothing correlated. `useCommandOnce` is that path packaged — reach for it rather than driving `send()` by hand.

> **A node that sends the command its message carries is a `Shell`, and that's verboten.** A Shell *sends* arbitrary commands; a command *interpreter* is what *interprets* them. A named, always-firing node that relays whatever verb its incoming message names is a Shell wired into the graph — exactly the thing the substrate forbids. The Fetcher is the safe inverse: the command is fixed on the node, the message is only a trigger. When you need "on a tick, send verb X to node Y", reach for a `Fetcher`, never a Shell.

### b. Wiring the fan-out

`Timer ─> Tee ─> 3 Fetchers`, each Fetcher `connectNode`'d to **`_shell/_http/insights-demo`**:

- **`_http`** is the substrate's `HttpOut` egress — the boundary that POSTs the command batch to `/command`.
- **`_shell`** is an **observe-only `Tap`** sitting *in front* of `_http`. A `Tap` forwards everything to its sink unchanged, but it's a named node on the send path — so you can `connect _shell` in the console and **watch every command going out** without touching the graph. Routing the Fetchers through `_shell/_http/insights-demo` (not `_http/insights-demo` directly) is what buys you that observability. Read `TO = _shell/_http/insights-demo` hop by hop: the router peels `_shell`, the Tap forwards to `_http`, and `HttpOut` peels itself and POSTs to `insights-demo`.

Both names are reserved, so spell the path through **`egressPath( ci )`** (`@newspack-nodes/shared/helpers/egressPath`) rather than by hand: it returns `_shell/_http/<ci>`, or a bare `_shell/_http` for a command-interpreter builtin such as `taillog`. Skipping the Tap is silent — the command still arrives, and `connect _shell` simply stops seeing it.

### c. The receiver reply path — why a `counts` reply only touches the counts view

Each Fetcher stamps **`FROM = its receiver Tee`** (`fetch-counts` → `FROM=countsIn`). The service CI replies **`TO = FROM`**, so the `counts` reply routes back to `countsIn`, which fans it to `source-counts:view`, which feeds `<SourceCounts/>`. The `top` reply lands on `topIn → top-table:view`; the `accumulated` reply on `accIn → accumulated:view`. **Three independent reply paths.** Nothing crosses; there is no shared model node to clobber.

Each receiver `Tee` fans the reply **back to its own Fetcher** as well, which is what takes the ask off that Fetcher's outbox. `addSliceFetcher` connects the Fetcher **last**, after the view, because a Tee fans out in connect order and the ask must still stand while the reply renders. Until the ask settles, the Fetcher is quiet: a one-second refresh on a four-second verb asks once and waits, instead of stacking four identical commands the server is still working through. An answer that never arrives stops holding the outbox open after `retry_after_s` (15 seconds by default; 0 disables the re-ask, which is what a write wants), and an ask that stands for 120 seconds is retired outright — so a lost reply costs one slow refresh rather than a dead widget.

### d. The thin view node

> **One-pager:** [writing-a-view-node.md](writing-a-view-node.md) distills this section into the view-node contract — the 3 routing facts, `setState('view')`, and why `fill()` must never throw.

Each view node is a `SliceViewNode` subclass that parses *its own* slice reply and publishes it. The base ships in the substrate — `@newspack-nodes/shared/nodes/slice-view-node` (shown here so you know the contract; it was a per-dashboard copy until it became a shared primitive):

```js
import { Node, TYPE, VALUE, TM_ERROR, payloadOf } from '@newspack-nodes/runtime';
import { errorMessage } from '@newspack-nodes/shared/errorMessage';
import { isControl } from '@newspack-nodes/shared/helpers/controlMsg';

export class SliceViewNode extends Node {
	constructor() {
		super();
		// `registrations: [ 'view' ]` in nodeSchema() names the key a direct
		// register() may use; useNodeEvent seeds the key React subscribes on.
		this.model = this.emptySlice();
		this.settled = {};   // the status fields THIS shape declares, at rest
		if ( 'loading' in this.model ) { this.settled.loading = false; }
		if ( 'error'   in this.model ) { this.settled.error   = null; }
		this.controlFrom = '';                // who, if anyone, drives this view
		this.setState( 'view', this.model );  // a render before the first reply is valid
	}

	emptySlice() { return {}; }   // subclass supplies the shaped-but-empty slice

	fill( message ) {
		this.counter += 1;   // terminal node: count here for the overlay's throughput
		const value = message[ VALUE ];
		// ORIGIN first: only the declared driver can send a control.
		if ( isControl( this, message ) ) {
			this._control( value );
			this.setState( 'view', this.model );
			return;
		}
		// TM_ERROR next: a transport refusal arrives as a bare STRING VALUE.
		if ( 0 !== ( ( message[ TYPE ] || 0 ) & TM_ERROR ) ) {
			this.model = { ...this.model, error: errorMessage( payloadOf( value ) ), loading: false };
			this.setState( 'view', this.model );
			return;
		}
		if ( ! value || 'object' !== typeof value ) {
			return;   // transient garbage keeps the prior slice
		}
		const slice = this._parse( value.payload );   // VALUE.payload is the slice's JSON string
		if ( null !== slice ) {
			this.model = { ...this.settled, ...slice };  // retires last tick's spinner and error
			this.setState( 'view', this.model );         // publish → React re-renders
		}
	}
	// _parse(): JSON.parse with a try/catch, returns null on garbage.
}
```

Three branches, three failure rules, and none of them blanks the widget. A **control** is recognised by who sent it (`controlFrom`), never by what its payload looks like — ADR-7 addressing applied to controls, so a reply carrying an `action` field is still a reply. A **TM_ERROR** keeps the slice already on screen and adds `error` while clearing `loading`, so a transient failure neither empties a working widget nor leaves it spinning. An **unparseable payload** keeps the prior slice untouched. `_parse()` reports what it cannot use by returning null, never by throwing: `fill()` runs synchronously in the drain with no per-message try/catch, so a throw aborts the whole turn.

> **Three more message helpers.** `@newspack-nodes/runtime` re-exports `payloadOf` alongside the field constants, and three of its siblings measure or label a message rather than parse one. `typeLabels( type )` returns one label per flag set in a TYPE bitmask, and an empty array when no known flag matches — the Dumper renders that case as `TM_UNKNOWN(0x…)` itself. `byteLength( str )` measures a string in UTF-8 bytes the way PHP's `strlen()` does, through `Blob` rather than the `TextEncoder` jsdom lacks; the command transport and `HttpOut` weigh their wire traffic with it. `valueSize( m )` measures a message's VALUE through it — UTF-8 bytes for a string, and the character length of the JSON encoding, an estimate rather than a wire-exact count, for a struct or a command object.

Each subclass supplies **only** its empty slice — that is the whole subclass, `src/dashboard/nodes/source-counts-view-node.js`:

```js
import { SliceViewNode } from '@newspack-nodes/shared/nodes/slice-view-node';

// `source-counts:view` — owns the per-source counts slice ({ sources:{name:count} }).
export class SourceCountsViewNode extends SliceViewNode {
	emptySlice() { return { sources: {} }; }
}
```

`top-table-view-node.js` returns `{ top: [] }`; `accumulated-view-node.js` returns `{ accumulated: 0 }`. That's it — each owns one slice and nothing else.

> The `errorMessage` import is itself a substrate refinement: coercing a `TM_ERROR` payload (string / `{message}` / anything) to a readable string was copy-pasted across every dashboard view node, so it lives in **`@newspack-nodes/shared/errorMessage`** now.

**Three subclasses whose whole content is a literal are three declarations.** `sliceView( { empty, parse, json, description } )` returns the class those values imply, and `registerSliceViews( views )` declares a bundle's views, registers their names, and hands the classes back:

```js
import { registerSliceViews } from '@newspack-nodes/shared/nodes/slice-view-node';

export const views = registerSliceViews( {
	SourceCountsView: { empty: { sources: {} } },
	TopTableView:     { empty: { top: [] } },
	AccumulatedView:  { empty: { accumulated: 0 } },
} );
```

Every dashboard the substrate ships declares its views this way. Subclass only for a view that owns more than its slice — its own `fill()`, a timer, a teardown; the example keeps one file per view because a tutorial has to show the class before it shows the shorthand. Either way the classes are what the graph is built from, and the names are for TSL and the console palette.

Register the classes so `makeNode` can find them by name (the JS analogue of the PHP classmap) — `Timer`/`Tee`/`Fetcher`/`Tap`/`HttpOut` are runtime nodes and already registered. `src/dashboard/nodes/register.js`:

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

> **Hand `makeNode` the CLASS, not the name** ([ADR-16](architecture-decisions.md#adr-16-js-node-class-resolution--names-are-the-tsl-surface-classes-are-the-api)). `includeNodes` is a per-bundle static, so a name resolves only through an interpreter *this* bundle mounted; a hub tab building its graph through another bundle's interpreter would find nothing. The registration above still earns its keep — TSL and the palette have no class to hand — but §4's `SLICES` table carries the imported classes.

---

## 4. Mount the graph and poll it — the batched-poll toolkit

The hook builds the real graph and owns the poll loop. The shortcut it refuses is "mount one view node and fire one `poll` command" — that *is* the god pattern, the convenience that produced every god-object dashboard. We're composing a graph, so we reach for the substrate's batched-poll toolkit instead: **`useBatchedPoll`** owns all the mount boilerplate, and **`addSliceFetcher`** wires one slice in one call. The hook is then its slices and nothing else.

`src/dashboard/hooks/usePublisherInsightsGraph.js`:

```js
import { useBatchedPoll } from '@newspack-nodes/shared/hooks/useBatchedPoll';
import { addSliceFetcher } from '@newspack-nodes/shared/helpers/addSliceFetcher';
import '../nodes/register';
import { SourceCountsViewNode } from '../nodes/source-counts-view-node';
import { TopTableViewNode } from '../nodes/top-table-view-node';
import { AccumulatedViewNode } from '../nodes/accumulated-view-node';

const SERVER = 'insights-demo';   // the server-side CI mount (real product owns unsuffixed `insights`)
const TARGET = `_shell/_http/${ SERVER }`;

// A digest moves on the order of minutes, so this is a retry, not a feed.
const DEFAULT_INTERVAL_MS = 30000;

// { fetcher node, receiver Tee, verb, view node, view CLASS } — one per slice.
const SLICES = [
	{ fetcher: 'fetch-counts', receiver: 'countsIn', command: 'counts',      view: 'source-counts:view', viewClass: SourceCountsViewNode },
	{ fetcher: 'fetch-top',    receiver: 'topIn',    command: 'top',         view: 'top-table:view',     viewClass: TopTableViewNode },
	{ fetcher: 'fetch-acc',    receiver: 'accIn',    command: 'accumulated', view: 'accumulated:view',   viewClass: AccumulatedViewNode },
];

export function usePublisherInsightsGraph( opts = {} ) {
	useBatchedPoll( {
		// build only adds THIS dashboard's nodes onto the owned fan-out Tee.
		build: ( { interpreter, tee } ) =>
			SLICES.forEach( ( slice ) =>
				addSliceFetcher( interpreter, { ...slice, tee, target: TARGET } )
			),
		timerName:  'insights:timer',
		teeName:    'insights:tee',
		intervalMs: opts.intervalMs ?? DEFAULT_INTERVAL_MS,
	} );
}
```

`useBatchedPoll` owns everything that used to be hand-wired here — the `mountExospine` call that brings the `_shell` Tap and the `_http` HttpOut, the fan-out `Tee`, the router-hitchhike `Timer`, and the page-visibility gate. It returns `{ interpreterRef, pollNow }`: the live interpreter, and a `pollNow()` that marks this poll due and runs the Router's tick, which is how a filter change refreshes without waiting out the cadence. Each `addSliceFetcher` wires one Fetcher → `_shell/_http/insights-demo`, its receiver Tee, its view node, and the receiver's edge back to the Fetcher that settles the ask. (When a slice needs a per-slice merge or dedup, pass `addSliceFetcher` a `transform: { name, nodeClass, args }` and it drops that node onto the receiver-Tee → view edge — so the transform lands on a graph edge, not inside the view.)

Four options ride in the same bag:

- **`intervalMs`** — set the poll cadence, **required and at least 1000 ms**; a lower value throws a `TypeError` naming the timer. That floor is `TimerNode`'s own hitchhike threshold: a sub-second timer takes its own `setInterval` slot outside the Router's lock/flush bracket, which costs one POST per slice per tick and batches nothing. Exactly 1000 rides every router tick; above that the Timer throttles against the shared wall-clock grid ([ADR-17](architecture-decisions.md#adr-17-timers-fire-on-a-shared-wall-clock-grid)), so two surfaces on one cadence meet on the same tick and share the POST. Changing the value re-arms the Timer live — the Aggregator dashboard wires it straight to a refresh dropdown (`intervalMs: parseInt( refreshInterval, 10 ) || parseInt( DEFAULT_REFRESH_MS, 10 )`). Sub-second work belongs to `useRouterTick`.
- **`paused`** — suspend polling *without* unmounting the graph (it stops the Timer's hitchhike, exactly like a hidden tab, and resumes when false). The Overview dashboard passes `paused: dragging` so a poll doesn't fight a drag in flight. A paused mount still delivers its one first load, because a surface that has never shown its data has no cadence to suspend.
- **`enabled`** — gate a tab nobody has opened: `false` costs nothing at all, with no first load, no timer and no named node, and flipping it true delivers the first load then.
- **`passenger`** — clip onto a backbone somebody else owns, for a poll that is *part* of a page rather than its graph. The owner keeps the full rebuild; a passenger re-attaches when the backbone comes back.

A slice can also emit *live* command args per tick: `addSliceFetcher` takes an `argsFn: () => argsTokens` fire-time getter, returning a flat token array, that it assigns to the Fetcher's `command_args`. A `null` return sends nothing that tick. The toy's three verbs take no args, so it needs none.

Two ideas carry the whole hook; the toolkit owns them now instead of each hook copying them:

- **The tick hitchhike and the batch bracket.** `insights:timer` is a `Timer` registered on `_router`'s TIMER channel, so it fires on the router tick. **The Router owns the bracket**, not this hook: `RouterNode.fireCb()` calls `_http.lock()`, notifies every TIMER registrant, and flushes in a `finally`. So when the tick fans out through the Tee to all three Fetchers, each command buffers behind the `_http` lock and the single flush ships them as **one `postBatch`**. **Fan-out is free: three Fetchers, one HTTP round-trip** — add a fourth slice and it is still one POST per tick. A mount opening a bracket of its own would make that tick pay for a second POST, which is exactly why `useBatchedPoll` opens none. (Same batching principle the worker side gets from the drain loop: more traffic per tick, the same fixed cost.)
- **Page-visibility gating.** While the tab is hidden, the toolkit calls `timer.stopTimer()` to unregister the Timer from the router TIMER, so a tick fans out to nothing and no POST goes out; becoming visible re-arms it and delivers any first load still owed. No wasted polls behind a backgrounded tab.

> **← a substrate refinement.** The `_shell`-Tap wiring, the Timer/Tee fan-out and the page-visibility plumbing used to be **hand-wired here** — roughly 50 lines of `useEffect` plus `mountExospine`, copy-pasted across this example, the topology console's poll dashboards, and the performance hook. It became **`useBatchedPoll( … )`** (the mount, `_shell`/`_http`, the Timer and Tee, the visibility gate, the first-load and unsigned-tick retries) and **`addSliceFetcher()`** (the per-slice Fetcher → receiver-Tee → view block, with its optional transform slot). The hook collapsed to its slices. That's the dogfooding rule this guide runs on: the moment a third caller copied the wiring, it moved into the substrate — so §4 is now one call, exactly like §6 and §7.

> **A catalog is one call further.** `useCatalogSlice( { scope, ci, viewClass, key } )` polls one CI's `list` verb as a slice and hands back the published model plus `loading`, `error` and `refresh()`. The tick *is* the retry, so a refusal recovers with no latch and no memoised promise. Its default cadence is 30 seconds, on the reasoning that a catalog changes when someone edits it.

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

`SourceCounts` reads `source-counts:view` and renders one proportion bar per source — with its **own** error notice and its **own** "No sources yet" empty hint. `TopTable` reads `top-table:view` and renders the score-ranked table, with its own error/empty branches — that per-widget ownership of empty and error state *is* the composition: each card degrades independently. The `|| { … }` fallback in each covers the one render before the hook's effect mounts the node, where `useNodeState` has no node to read and returns undefined. From construction onward the view node publishes its own shaped-but-empty slice, so every later render is valid without it.

`TopTable` also owns the newsletter actions — the **Draft newsletter**, **Copy markdown** and **Create draft post** buttons — because they operate on *its* `top` items. Both documents are composed in the browser; only **Create draft post** leaves it, and it goes to the WP REST API (`POST /wp/v2/posts`), never back through the node graph. That call sits behind a `createDraft` prop defaulting to `apiFetch`, so a test hands the component a fake that resolves or rejects and exercises both rendered outcomes without touching the network. The three actions share one tiny normalizer so the on-screen preview, the markdown draft and the draft-post HTML all agree on a row's display strings, `src/dashboard/itemLabel.js`:

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

Its sibling `src/dashboard/newsletterPost.js` builds the draft post's `{ title, content }` from the same items, as an HTML list. It escapes the five HTML-significant characters itself rather than leaving that to WordPress: an administrator on a single site holds `unfiltered_html` and is exempt from kses, so an item title carrying markup would be stored as markup. `draftNewsletter` escapes nothing, because its destination is the clipboard.

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

That is the entire view layer: three thin widgets reading three nodes, two client-side document builders over one shared normalizer, and one mount.

---

## 6. Build it — a few lines, not a build system

The JS needs bundling (JSX, the `@wordpress/*` and `@newspack-nodes/*` imports, SCSS) into a single `build/dashboard/index.js` WordPress can enqueue. The substrate ships the builder; your `scripts/build.mjs` declares its entries and injects its own tools. Only one thing differs between a plugin bundled in this repo and a standalone one — **where the substrate's `src` directory is** — so both forms are below. Pick the one that matches where your plugin lives.

**In this repo**, `examples/example-ai-newsletter/scripts/build.mjs` — the example sits at `examples/<name>/`, so `src` is at a fixed depth:

```js
import esbuild from 'esbuild';
import * as sass from 'sass';
import rtlcss from 'rtlcss';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve( path.dirname( fileURLToPath( import.meta.url ) ), '..' );

// This example ships INSIDE the substrate repo, so `src` is at a fixed depth.
// A standalone plugin reads NEWSPACK_NODES_SRC here instead.
const SUBSTRATE_SRC = path.resolve( ROOT, '../../src' );

// import(), not a static import: the specifier is computed, and a static one
// would hoist past the guard and fail with ERR_MODULE_NOT_FOUND instead.
const buildKit = path.join( SUBSTRATE_SRC, 'build-kit/index.mjs' );
if ( ! existsSync( buildKit ) ) {
	throw new Error( `build-kit not found at ${ buildKit }` );
}
const { buildDashboards } = await import( pathToFileURL( buildKit ).href );

// `.default` because alias-map.cjs is CommonJS — jest requires it synchronously.
const { esbuildAlias } = (
	await import( pathToFileURL( path.join( SUBSTRATE_SRC, 'build-kit/alias-map.cjs' ) ).href )
).default;

buildDashboards( {
	esbuild, sass, rtlcss, root: ROOT,
	entries: [ { entry: 'src/dashboard/index.js', outDir: path.resolve( ROOT, 'build/dashboard' ) } ],
	alias: esbuildAlias( SUBSTRATE_SRC ),
	// Bare imports inside the aliased substrate sources (d3, …) resolve here.
	nodePaths: [ path.resolve( ROOT, '../../node_modules' ) ],
	watch: process.argv.includes( '--watch' ),
} ).catch( ( err ) => { console.error( err ); process.exit( 1 ); } );
```

**A standalone plugin** lives in `wp-content/plugins/<slug>/`, where [writing-a-plugin.md](writing-a-plugin.md) §1 put yours, and `../../src` there resolves to `wp-content/src` — so the guard above fires and the build stops at `build-kit not found`. Replace the `SUBSTRATE_SRC` block and the two loads with the resolution both standalone consumers ship — `newspack-event-logger-nodes/scripts/build.mjs` and `newspack-intelligence/scripts/build.mjs`, which spell it identically down to the error string (and name the constant `substrateSrc`):

```js
// A sibling newspack-nodes checkout by default; NEWSPACK_NODES_SRC wherever
// the substrate sits elsewhere, as a release workflow's checkout does.
const SUBSTRATE_SRC =
	process.env.NEWSPACK_NODES_SRC || path.resolve( ROOT, '../newspack-nodes/src' );
if ( ! existsSync( SUBSTRATE_SRC ) ) {
	throw new Error(
		`substrate src not found at ${ SUBSTRATE_SRC } — set NEWSPACK_NODES_SRC when building outside a sibling newspack-nodes checkout`
	);
}

const { buildDashboards } = await import(
	pathToFileURL( path.join( SUBSTRATE_SRC, 'build-kit/index.mjs' ) ).href
);
const { esbuildAlias, assertNoRetiredOverrides } = (
	await import( pathToFileURL( path.join( SUBSTRATE_SRC, 'build-kit/alias-map.cjs' ) ).href )
).default;

// Refuse the retired per-alias overrides; never silently ignore one.
assertNoRetiredOverrides( process.env );
```

**That sibling has to be a git clone.** The release zip carries the runtime alone — `includes/`, `topologies/`, `build/` and a production `vendor/` — because `.distignore` drops `src/`, `scripts/`, `tests/` and `docs/`. So `wp plugin install newspack-nodes.zip`, the install [getting-started.md](getting-started.md) walks you through, leaves a substrate at `wp-content/plugins/newspack-nodes/` with no `src/` in it — at exactly the path the default resolves to. The build then stops on `substrate src not found at …`, and pointing `NEWSPACK_NODES_SRC` at that same directory changes nothing. Clone the substrate repository beside your plugin, or point `NEWSPACK_NODES_SRC` at that clone's `src`. You need the clone three more times: the `jest.config.js` below spells it literally in both the `require()` and `aliasBase`, since jest reads no environment variable; [writing-a-plugin.md](writing-a-plugin.md) §8b's test bootstrap loads the substrate's `tests/Helpers/`; and §8c's PHPStan config scans `../newspack-nodes/includes`.

The guard moves from the kit file onto the directory, because the directory is what the variable names: a wrong `NEWSPACK_NODES_SRC` should say so rather than report a missing `index.mjs`. The `buildDashboards` call below it changes in one place — `nodePaths` becomes your own `node_modules` (`path.resolve( ROOT, 'node_modules' )`), since the substrate checkout beside you may have none. A plugin that declares dependencies of its own, as both standalone consumers declare `d3` and `@noble/hashes`, needs one more loop to pin them; [writing-a-real-dashboard.md](writing-a-real-dashboard.md) §7 carries that loop and the 88KB duplicate it prevents.

`buildDashboards` rewrites each `@wordpress/*` import listed in its `WP_EXTERNALS` map to the matching `window.wp.*` global (and records the dependency in `index.asset.php` so WordPress enqueues the right handles), compiles your SCSS, content-hashes the bundle for cache-busting, and emits the RTL companion. It checks every alias path *before* esbuild starts, so a bad checkout fails with a fixable line naming the missing directory.

**One base path, three aliases, one resolver.** `src/build-kit/alias-map.cjs` is the single place `@newspack-nodes/runtime`, `@newspack-nodes/shared` and `@newspack-nodes/debug-overlay` are written down; `esbuildAlias( base )` projects them for esbuild and `jestModuleNameMapper( base )` for jest, so the two cannot disagree about where an alias points. The `.cjs` extension is load-bearing — `jest.cjs` must `require()` it synchronously while `build.mjs` imports it as a module. Both forms above hand `base` the same value they hand the kit, which is the point of the single override: `NEWSPACK_NODES_SRC` names the substrate's `src` directory, and everything derives from it. The in-repo example reads no env var, because its depth is fixed and a variable there would only be a way to build against a different checkout by accident.

`assertNoRetiredOverrides( process.env )` defends that single override. There used to be four independent ones, one per alias plus the kit, all naming paths inside that same directory; a release workflow had to set every one, and omitting any single one silently resolved to a nonexistent sibling path. Setting a retired name now throws and names it, rather than being ignored.

The jest config is one call too, and it splits the same two ways — `jest.config.js` **in this repo**:

```js
const path = require( 'node:path' );
const { createJestConfig } = require( '../../src/build-kit/jest.cjs' );

module.exports = createJestConfig( {
	aliasBase:    path.resolve( __dirname, '../../src' ),
	pinReactFrom: path.resolve( __dirname, 'node_modules' ),
} );
```

and **a standalone plugin**, reaching `jest.cjs` through the sibling checkout:

```js
const path = require( 'node:path' );
const { createJestConfig } = require( '../newspack-nodes/src/build-kit/jest.cjs' );

module.exports = createJestConfig( {
	aliasBase:    path.resolve( __dirname, '../newspack-nodes/src' ),
	pinReactFrom: path.resolve( __dirname, 'node_modules' ),
} );
```

Jest reads no `NEWSPACK_NODES_SRC`: the `require()` is a literal path, so the sibling checkout is spelled twice in this file and the env var moves the build alone. The release workflow builds without running jest, so nothing there depends on the two agreeing — but a `jest.config.js` aimed at a different substrate than the bundle is a suite passing against code you do not ship.

`createJestConfig` also takes `extraMappers` (the example pins `@wordpress/api-fetch` and `d3` at the substrate's installed copies), `transformIgnorePatterns` (d3 and `@noble/*` ship ESM only, so they opt out of the node_modules transform skip) and `testPathIgnorePatterns` (the substrate excludes `/examples/`, which runs its own suite). It resolves two `<rootDir>` files it expects you to provide — jest's convention, not the substrate's:

```js
// jest.setup.js — @testing-library matchers (toBeInTheDocument, …)
import '@testing-library/jest-dom';
```
```js
// jest.style-mock.js — SCSS/CSS imports are stubbed in tests
module.exports = {};
```

Ahead of your `jest.setup.js` the factory loads one of its own, `src/build-kit/jest-node-timers.js`. It holds every runtime node your suite mounts to two timer invariants, and breaking either fails the test:

- **No runtime interval outlives the test file.** The harness wraps `TimerNode`'s `setTimer`/`stopTimer`, disarms after each test whatever that test armed, and closes any `SseInNode` it opened — so a suite owns no timer teardown of its own. An interval armed from `src/runtime/` that is still live after the last test throws from `afterAll`, naming the frame that armed it, because a timer outliving its test fires into the next one.
- **A node armed on the real clock must not still be armed when the suite fakes `setInterval`.** Its handle belongs to the real clock, so `advanceTimersByTime` never fires it: the graph does not tick and the test passes for the wrong reason. `createTimerHazardGuard` (`src/build-kit/timer-hazard.js`) catches the swap and throws at that test's teardown, naming the arming line in your `__tests__` file (`firstFrame` picks that frame out of the stack) and the three one-line remedies — install fake timers before you mount or arm the graph, dispose the stale graph before re-mounting under them, or fake only what you advance: `jest.useFakeTimers( { doNotFake: [ 'setInterval', 'requestAnimationFrame' ] } )`. Faking `setTimeout` alone to drive a component debounce is not a hazard and is not reported.

Both invariants are browser-only. The file's body sits behind a `typeof window` check, so a suite declaring `/* @jest-environment node */` — the build-tooling tests — pulls no runtime graph in and is held to neither.

The example's `jest.setup.js` earns three more blocks, and a dashboard suite wants all three. It **authenticates the command session** in a `beforeEach` (`forgetSession`, `__setAuthFetch`, `ensureSession` from `src/runtime/command-auth`) — every Fetcher holds until `readyToMint()` says yes, which is what production does, so without it every poll test asserts silence. It installs Node's `TextEncoder` and `webcrypto` over jsdom's, which ships neither and the command signer needs both. And it **fails any test emitting an unexpected `console.warn` or `console.error`**, letting through only the substrate's own timestamped `Core.stderr()` lines.

Tests drive the graph through the **wire**, not the client: `installFakeCommandWire( replyFor )` from `@newspack-nodes/shared/test-utils/fakeCommandWire` stubs `global.fetch` (and `/auth`), so packing, `HttpOut`, the Router and the interpreter all run for real and replies come back `TO = FROM`. `wire.batches` is what was posted, which is how the example asserts that one tick is one POST carrying three commands. Its companion `runClockFast( factor )` from `test-utils/fastClock` shadows `Core.now()` so a test reaches the next poll boundary instead of waiting out a 30-second cadence.

And the `npm run build` / `npm run test:js` the guide keeps invoking are `package.json` scripts — the four you need:

```json
"scripts": {
	"build":   "npm run clean && node scripts/build.mjs",
	"watch":   "npm run clean && node scripts/build.mjs --watch",
	"clean":   "rm -rf build",
	"test:js": "jest --passWithNoTests"
}
```
(Plus the dependencies any React/esbuild project needs — `esbuild`, `sass`, `rtlcss`, `jest`, `jest-environment-jsdom`, `babel-jest`, `@testing-library/*`, `@wordpress/element`/`i18n`/`api-fetch`, `react`/`react-dom`; copy the example's `package.json` and `babel.config.js` rather than hand-rolling them. `babel.config.js` is for jest alone — esbuild reads none of it — and must set `targets: { node: 'current' }` and the automatic JSX runtime, matching the kit's `jsx: 'automatic'`, because nothing under `src/` binds `React`.)

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

A standalone plugin dashboard gets its **own** top-level menu (`add_menu_page`) — it shouldn't squat inside the substrate's menus, which belong to Nodes' own tools: `Admin::MENU_SLUG` (`newspack-nodes`) for settings, `Admin::HUB_MENU_SLUG` (`newspack-nodes-hub`) for the DevTools hub that carries the Console, Overview, Jobs, Vault and the rest. If your dashboard genuinely *is* a Nodes-internal tool, register it as a `host: 'hub'` DevTools tab — `registerDevtoolsTab( { id, label, host, component, order, slug } )` from `@newspack-nodes/shared/devtools/tabRegistry` — rather than as an `add_submenu_page`. Either way, the gate above (`current_user_allowed()`) keeps visibility consistent with the substrate.

This example mounts `DebugOverlay` in §9, so its stylesheet names `newspack-nodes-graph`, and WordPress loads the two handles beneath it in the same cascade. The substrate registers three, each depending on the one before:

- **`newspack-nodes-theme`** defines the `--np-*` custom properties — the one definition of the product palette, type scale and spacing scale.
- **`newspack-nodes-ui`** adds the component appearance under the `.newspack-nodes-ui` scope, and depends on the theme.
- **`newspack-nodes-graph`** adds the topology-canvas artwork and layout, and depends on the UI sheet.

A dashboard that draws no graph omits `style_deps` and takes the registrar's default, `[ 'wp-components', 'newspack-nodes-ui' ]`. A consumer wanting the palette without the component skin names `newspack-nodes-theme` alone and carries `.newspack-nodes-theme` on its root, as pyrobase's editor pages do — the tokens are defined on that class, so a root without it resolves no `var(--np-*)`. The same holds one level up: the component rules scope under `.newspack-nodes-ui`, so a host opts into the skin by carrying that class too. This page carries neither, because `DebugOverlay` supplies both on its own root whenever no ancestor is already a provider. `GraphView` deliberately has no stylesheet side-effect import: every host that renders the graph owns this dependency, keeping the graph CSS in one build asset instead of copying it into each consumer bundle.

> **← a substrate refinement.** `enqueue_insights_assets` was ~40 lines: read the `$_GET['page']` and bail if it's not yours; `file_exists` the bundle; `require` the `index.asset.php` manifest for deps + version; `wp_enqueue_script`; the `index.css` sidecar; `wp_localize_script` the REST root + nonce as `NewspackNodesData` (which the JS transport reads). Every dashboard repeated it. It became **`Admin::enqueue_react_page( $args )`** — page-gate, manifest deps/version, CSS (and the RTL companion, which no site previously activated), and the `NewspackNodesData` localize, returning the handle so a caller can layer extras. You pass it where your bundle is and which page it's for.

The `NewspackNodesData` the registrar localizes (`{ restUrl, nonce }`) is exactly what the JS `defaultTransport()` reads to authenticate the `POST /command` — so `enqueue_react_page` (PHP) and HttpOut's lazily-defaulted transport (JS) are the two ends of one wire.

---

## 8. Run it — drive the pipeline, watch the dashboard, then inspect the graph

```bash
# Regenerate the classmap, build the bundle, then deploy + activate the plugin
# on a site with the substrate.
composer dump-autoload -o
npm run build
wp nodes activate example-ai-newsletter   # add to the active set + spawn the fleet now
wp nodes status                           #   example-ai-newsletter.p0  live  3s ago  2m 10s
```

Skip the dump and the worker boots into `unknown class: Scorer`: §1a added that class file, and `make_node Scorer` resolves it through `class_exists()` against the classmap. §2's `Insights_CI` is the one exception — its mount `require_once`s its own file, so it needs no dump.

The worker is live but its snapshot is empty until the pipeline runs. Drive it from the worker's REPL — the sources emit on a `TICK` runtime request (`request_node`, not an admin command):

```bash
wp nodes cli example-ai-newsletter.p0
```
```
> request_node releases  TICK
> request_node community TICK
```

Each `TICK` flows `source → summarizer → scorer → scored:partition`; the Consumer tails the scored records into the digest and co-commits the snapshot. Now open **Publisher Insights** (its own top-level item) in wp-admin. The page mounts, the three Fetchers fire on the first load (one POST), and you see it: **By source** counts, the **score-ranked table** (releases items at 6, community at 4–3, exactly the Scorer's weights) with its **Draft newsletter** button, and the **Total items** card. It refreshes every 30 seconds while the tab is visible. `TICK` the sources again and watch the counts climb on the next poll.

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
- **`storageKey` is per-dashboard.** It scopes the **canvas** layout — where each node sits on the graph — so name it `newspack-nodes:debug:<dashboard>`: `newspack-nodes:debug:example-insights` here, `newspack-nodes:debug:hub:<tab>` on the DevTools hub, where each tab builds a graph of its own. Reusing one key across pages would make two different graphs fight over one set of node positions. The panel's own frame geometry is global and ignores it. (A third prop, `buildRepl: false`, tells the Console tab to point at the page's existing console instead of building a second graph and REPL — the hub passes it on its Console tab, where the two would collide on `_output`.)
- **It reads the live graph, not a snapshot.** Because the overlay subscribes to the same `Core.nodes` your `useBatchedPoll` hook built, opening it (`Ctrl+\`` toggles the panel) shows the real thing live: `insights:timer`, `insights:tee`, the three `fetch-*` Fetchers, the receiver Tees, the view nodes — each at its real counter, climbing on every tick. Drop a `Tee` onto an edge or `invoke` a verb right from the panel. A god view-node at counter 0 would give the overlay nothing to draw; *this* graph is the payoff, and the overlay is how you see it.

One mount, and every dashboard you build the right way becomes self-documenting — the node graph you composed is visible, live, on its own page.

---

## 10. Recap — what you wrote vs. what the substrate gave you

**You wrote:** a `Scorer` node (one `fill`, one `score()` seam), two snapshot methods on the digest, the four durable-snapshot topology lines, an `Insights_CI` with **three small slice verbs** sharing one memoized read, **three thin `SliceViewNode` subclasses** (each only an `emptySlice()`), a `useBatchedPoll` hook whose `build` is one `addSliceFetcher` per slice, **three thin widgets** each reading its own node, the two client-side document builders and their shared label normalizer, and the thin build/jest/enqueue glue — a `scripts/build.mjs`, a `jest.config.js`, and the two enqueue functions.

**The substrate gave you:** the durable log + snapshotting Consumer, the command protocol and routing, the `_http`/`_shell` boundary, the JS node runtime and `mountExospine`, `useNodeState`, the **`Fetcher`** composition primitive, and — the through-line of this guide — primitives that each used to be boilerplate in this very example:

| You call | It replaced |
|---|---|
| `Fetcher` (trigger → one configured command, FROM=receiver) | a bespoke command-firing view node per dashboard (a Shell, verboten) |
| `useBatchedPoll( … )` | the ~50-line `mountExospine` + `_shell`/`_http` + Timer/Tee + page-visibility mount, copy-pasted per dashboard |
| `addSliceFetcher()` | the 6-line per-slice Fetcher → receiver-Tee → view block (the `SLICES.forEach` body) |
| `egressPath( ci )` | the `_shell/_http/<ci>` path spelled out at every send site |
| `Partition_Node::read_latest_snapshot_cache()` | a per-dashboard glob and cache descent, over a 20-line offsetlog segment walk |
| `Service_CI_Node` + `node_schema()` verbs | a hand-built interpreter, a REST controller and a per-verb capability check |
| `@newspack-nodes/shared/errorMessage` | a per-view error-coercion helper, copy-pasted |
| `sliceView()` / `registerSliceViews()` | a class file per view whose whole content was an empty-model literal |
| `buildDashboards()` / `createJestConfig()` / `alias-map.cjs` | a 250-line esbuild config, a footgun-prone jest config, and four env overrides |
| `Admin::enqueue_react_page()` | a 40-line page-gate + manifest + localize |
| `installFakeCommandWire()` | a hand-stubbed command client per suite, which tested past the wire |

That table *is* the lesson, and it's the same one the first guide ends on, lifted to the client with one addition: **dashboards are composed node graphs, not a god view-node + god command.** You add a dashboard by composing primitives — a Timer, a Tee, Fetchers, thin view nodes, small verbs — not by building a dashboard framework and not by funneling everything through one node and one command. Uphold the `fill()` contract, decompose both sides, lean on the shared pieces, and the next dashboard is the handful of files you care about: the slice verbs, the view nodes, the widgets, and the hook that wires them.

---

## Where to go next

- **[writing-a-plugin.md](writing-a-plugin.md)** — the previous guide in order: the headless pipeline this dashboard reads from.
- **[writing-a-view-node.md](writing-a-view-node.md)** — the one-page contract for §3d's terminal view node: one reply in, one render model out.
- **[writing-a-real-plugin.md](writing-a-real-plugin.md)** — the next guide in order: taking the toy pipeline to real sources, credentials in the Vault, a durable ingest partition.
- **[writing-a-real-dashboard.md](writing-a-real-dashboard.md)** — then this one: what a dashboard owes the Topology Console, the DevTools hub and `release:archive`.
- **[architecture-guide.md](architecture-guide.md)** — the full model: drain loop, partitions, workers, the REPL, and the JS runtime.
- **[architecture-decisions.md](architecture-decisions.md)** — the ADRs this guide leans on: [ADR-7](architecture-decisions.md#adr-7-sink-vs-target-and-tofrom-replies) (TO=FROM replies), [ADR-16](architecture-decisions.md#adr-16-js-node-class-resolution--names-are-the-tsl-surface-classes-are-the-api) (classes, not names) and [ADR-17](architecture-decisions.md#adr-17-timers-fire-on-a-shared-wall-clock-grid) (the timer grid).
- **[`examples/example-ai-newsletter/`](../examples/example-ai-newsletter/)** — the complete, tested code for this walkthrough, including the `src/dashboard/` suites (each node, hook and widget driven through the fake command wire, no browser).
- **`newspack-event-logger-nodes`** — the production application: four admin dashboards (Performance, Error Log, Gyroscope, Request Log) built on these same primitives, including the SSE ones this guide's poll shape deliberately doesn't cover.
