# Writing a Nodes Plugin

This walkthrough builds a real pipeline from an empty directory: an AI-newsletter digest that pulls items from independent sources, summarizes each, and assembles a markdown draft. You'll run it after every step and end with a live worker graph you can watch and drive in the topology console.

The finished code is in [`examples/example-ai-newsletter/`](examples/example-ai-newsletter/) — read along, or build it yourself and diff.

> **The one thing to hold onto:** every node has a single entry point, `fill( array &$message ): void`. A node does its job and forwards the message to its **sink**. Nodes never call each other's methods; they pass messages. Keep that contract and your node drops into any graph.

If you haven't run the example yet, do [getting-started.md](getting-started.md) first — it's the same pipeline, five minutes, no building.

> **Diffing against the shipped code — the `_Demo` suffix.** The teaching snippets below use bare names (`Releases_Source_Node`, `Summarizer_Node`, …), but the bundled example carries a `_Demo` suffix on every class — `Releases_Source_Demo_Node`, files `class-*-demo-node.php`, namespace `Example_AI_Newsletter` — to deconflict from the real sibling plugin (`newspack-ai-newsletter`) that can be loaded in the same WP. Likewise the topology file is `topologies/example-ai-newsletter.tsl` (name `example-ai-newsletter`) and the durable log is `example-scored.p*`. So when you diff against [`examples/example-ai-newsletter/`](examples/example-ai-newsletter/), map each bare name → its `_Demo` form. The teaching code reads cleaner without the suffix; the example needs it.

---

## 0. What we're building

```
releases ─┐
          ├─> summarizer ─> digest ─> log (Log)
community ┘
```

Two **sources** emit items. One **summarizer** condenses each item to a line. One **builder** accumulates the lines and, on request, writes a draft. `log` is the substrate's built-in `Log`. Sources emit on a `TICK` request; the digest writes on a `FLUSH` request — both typeable in the REPL with `request_node`, so you can drive the whole thing by hand.

> **TM_COMMAND vs. TM_REQUEST — the convention.** Two different jobs, two different message types. **`TM_COMMAND`** is the *startup & administration* plane: graph construction (`make_node`/`connect_node`), config verbs, topology load. **`TM_REQUEST`** is the *runtime* plane: live triggers and queries that drive a running graph (`TICK`, `FLUSH`, `GET_LAG`). A request is handled in the node's own `fill()` — branch on `TM_REQUEST`, do the work, and reply `TM_STRUCT | TM_RESPONSE` to `TO = $message[FROM]` (the breadcrumb). You trigger one from the REPL with `request_node <node> <VERB>`. So a *runtime trigger is never a `cmd_*` verb* — `cmd_*` is for admin/config that runs once at build time.

We'll write it in the order you'd actually discover it: one node, run it, wire the next, run it again.

---

## 1. Scaffold — one call to register the plugin

A Nodes plugin is an ordinary WordPress plugin. It needs two things: a Composer **classmap** (so `make_node` can find your node classes — and so the topology console's palette can read their schemas), and one registration call.

`composer.json`:

```json
{
	"name": "newspack/ai-newsletter-example",
	"description": "Nodes walkthrough example — deterministic digest pipeline.",
	"require": { "php": ">=8.2" },
	"autoload": { "classmap": [ "includes/" ] }
}
```

`example-ai-newsletter.php`:

```php
<?php
/**
 * Plugin Name: Newspack AI Newsletter (Nodes example)
 */
namespace Newspack_AI_Newsletter;

\defined( 'ABSPATH' ) || exit;

add_action(
	'plugins_loaded',
	static function (): void {
		if ( ! \class_exists( '\Newspack_Nodes\Topology_Registry' ) ) {
			return; // substrate not active
		}
		require_once __DIR__ . '/vendor/autoload.php';

		// One call wires everything: the namespace (so make_node resolves your
		// *_Node classes), the topologies/ dir, a catalog entry per *.tsl in it,
		// and a guarded worker-spawn handler.
		\Newspack_Nodes\Topology_Registry::register_plugin(
			'Newspack_AI_Newsletter\\',
			__DIR__ . '/topologies'
		);
	},
	12
);
```

That's the whole "register a Nodes plugin" story — one call. (It used to be four separate hook registrations; collapsing them into `register_plugin` was a substrate refinement that fell out of writing *this* walkthrough — when a step feels like boilerplate, the fix belongs in the substrate, not the tutorial.)

Run `composer dump-autoload -o` now, and again whenever you add or rename a node — the classmap is what `make_node` and the console palette read.

There are no nodes yet. Let's write one.

---

## 2. The first node — a source *(Ana's story)*

Ana is asked to add release-notes ingestion. She doesn't know — and doesn't need to know — what happens to the items afterward. Her job: **emit each item as a message to my sink.** That's the contract; whatever consumes it is someone else's node.

`includes/class-releases-source.php`:

```php
namespace Newspack_AI_Newsletter;

use Newspack_Nodes\Node;
use Newspack_Nodes\Message;

class Releases_Source_Node extends Node {

	/** The ONE seam a real source replaces: return ingest items. Toy = canned. */
	protected function items(): array {
		return [
			[ 'title' => 'Roundup Block ships', 'url' => 'https://example.test/r1', 'body' => 'AI summarizes selected posts into a draft.' ],
			[ 'title' => 'Editorial Assistant GA', 'url' => 'https://example.test/r2', 'body' => 'Inline AI assistance in the editor.' ],
		];
	}

	/** TICK is a runtime trigger: a TM_REQUEST handled here in fill(). */
	public function fill( array &$message ): void {
		if ( $message[ Message::TYPE ] & Message::TM_REQUEST ) {
			$this->handle_request( $message );
		}
	}

	/** TICK handler: emit each item as a TM_STRUCT message. Fire-and-forget — no reply. */
	private function handle_request( array $message ): void {
		foreach ( $this->items() as $item ) {
			$message                   = Message::new_message();
			$message[ Message::TYPE ]  = Message::TM_STRUCT;
			$message[ Message::FROM ]  = $this->name;
			$message[ Message::VALUE ] = [ 'source' => 'releases' ] + $item;
			parent::fill( $message );   // <-- see "the emit pattern" below
		}
	}
}
```

**The emit pattern (important).** A node that *generates* a message sends it with `parent::fill( $message )`, not `$this->fill( $message )`. The base `Node::fill()` does two things: it stamps `TO` from this node's `target` (whatever `connect_node` wired downstream) and forwards to the `sink`. Calling `$this->fill()` would re-enter *your own* `fill()` and recurse. So: build the message, `parent::fill()`. (Generator nodes across the substrate follow this exact pattern — see `Tail`.)

**Sources are fire-and-forget.** The TICK handler emits and returns — it sends **no reply**. Triggering `request_node releases TICK` drives the emit; you won't see a `{ emitted }` echo back. (A node *can* reply along the breadcrumb — `TO = $message[FROM]`, `TM_STRUCT | TM_RESPONSE` — and the substrate's own readers do, e.g. `Consumer_Node::handle_request`'s `GET_LAG`. But a source has nothing to report, so it doesn't.)

**Where does `TICK` come from?** It's a **runtime trigger**, so it's a `TM_REQUEST` you handle in `fill()` — *not* a `TM_COMMAND` verb on a sibling interpreter. (Reserve `TM_COMMAND` / `node_schema()['commands']` for *admin/config* that runs at build time; see the convention box in §0.) `fill()` branches on the `TM_REQUEST` flag and does the work. A request handler *may* reply `TM_STRUCT | TM_RESPONSE` back along the FROM breadcrumb — the substrate's own readers do (see `Consumer_Node::handle_request`'s `GET_LAG`) — but this source doesn't: it emits and returns.

You still document the verb in `node_schema()`, under a **`requests`** key (the runtime counterpart to `commands`) so the console palette and per-node Inspector list it:

```php
	public static function node_schema(): array {
		return \array_merge( parent::node_schema(), [
			'category'     => 'Source',
			'description'  => 'Emits canned release-notes items on a TICK request (request_node releases TICK).',
			'arguments'    => [],
			'requests'     => [
				[
					'name'        => 'TICK',
					'description' => 'Emit the current batch of items. Trigger with `request_node releases TICK`.',
					'reply_shape' => '{ emitted }',
				],
			],
			'accepts_fill' => true,
			'has_target'   => true,
		] );
	}
```

Two things to internalize:

- **No constructor, no sibling interpreter.** A runtime trigger lives on the node itself (in `fill()`); there's no `{node}:config` interpreter to wire and no `Command_Interpreter_Node` import. (You'd reach for that sibling-interpreter machinery only for *admin/config* verbs — `commands` — which this node has none of.)
- **`accepts_fill` is now `true`.** The node *does* act on a message arriving at `fill()` — a `TM_REQUEST`. (A pure source that only ever minted on a `cmd_*` verb used to set this `false`; once the trigger is a request, the node has a real `fill()` contract.)

**Run it — standalone, in the bare REPL.** No topology, no wiring yet: just make the node and fire the request.

```bash
composer dump-autoload -o
wp nodes cli            # bare REPL: local nodes only
```
```
> make_node Releases_Source releases
> request_node releases TICK
```

The source is fire-and-forget, so there's no reply to print — the two items were emitted to the (not-yet-wired) sink and dropped. It lives. Ana is done — she never wrote a line about summaries or drafts.

---

## 3. The summarizer — a transform that knows nothing about sources

The summarizer's contract: **receive one item, emit the item plus a one-line summary.** It does not know what a "release" or a "community post" is — only that a `TM_STRUCT` message arrived with an item in `VALUE`.

`includes/class-summarizer.php`:

```php
class Summarizer_Node extends Node {

	/** The ONE seam a real summarizer replaces: item -> one-line summary. Toy = template. */
	protected function summarize( array $item ): string {
		$title = $item['title'] ?? '(untitled)';
		$body  = $item['body'] ?? '';
		return $title . ' — ' . \mb_substr( $body, 0, 80 );
	}

	public function fill( array &$message ): void {
		if ( 0 === ( $message[ Message::TYPE ] & Message::TM_STRUCT ) ) {
			return;   // only handle struct items
		}
		$item            = $message[ Message::VALUE ];
		$item['summary'] = $this->summarize( $item );

		$out                   = Message::new_message();
		$out[ Message::TYPE ]  = Message::TM_STRUCT;
		$out[ Message::FROM ]  = $this->name;
		$out[ Message::VALUE ] = $item;
		parent::fill( $out );   // stamp TO from target, forward to sink
	}
}
```

It's a pure transform — no verbs, just `fill()`. Wire a source to it and watch an item flow through:

```
> make_node Summarizer summarizer
> connect_node releases summarizer          # releases' target = summarizer
> request_node releases TICK
```

`connect_node releases summarizer` set the releases node's `target` to `summarizer`; now each emitted item is stamped `TO=summarizer` and the router delivers it. (The source is fire-and-forget — the TICK prints nothing; the items flow to the summarizer.) The summarizer adds a `summary` and forwards. (Add a `Log` after the summarizer if you want to eyeball the struct — or just trust the counts in step 5.)

---

## 4. The digest builder — accumulate, then `FLUSH`. And reuse `Log`.

The builder collects summarized items as they arrive, and on a `FLUSH` request renders them to markdown and emits the draft as a `TM_BYTESTREAM` string.

Here `fill()` does **two** jobs, distinguished by message type: a `TM_STRUCT` is *data* to accumulate; a `TM_REQUEST` is the runtime `FLUSH` trigger. That's the general shape of a node that both consumes a stream and answers runtime requests.

`includes/class-digest-builder.php`:

```php
class Digest_Builder_Node extends Node {

	/** @var array<int,array<string,mixed>> */
	private array $items = [];

	public static function node_schema(): array {
		return \array_merge( parent::node_schema(), [
			'category'    => 'Transform',
			'description' => 'Accumulates summarized items; a FLUSH request renders a markdown draft.',
			'requests'    => [
				[
					'name'        => 'FLUSH',
					'description' => 'Render the accumulated items to a markdown draft and emit it. Trigger with `request_node digest FLUSH`.',
					'reply_shape' => '{ flushed }',
				],
			],
		] );
	}

	public function fill( array &$message ): void {
		if ( $message[ Message::TYPE ] & Message::TM_REQUEST ) {
			$this->handle_request( $message );   // FLUSH
			return;
		}
		if ( 0 === ( $message[ Message::TYPE ] & Message::TM_STRUCT ) ) {
			return;
		}
		$this->items[] = $message[ Message::VALUE ];   // accumulate
		++$this->counter;
	}

	private function handle_request( array $message ): void {
		$lines = [ '# Newsletter draft', '' ];
		foreach ( $this->items as $item ) {
			$lines[] = '- ' . ( $item['summary'] ?? '' );
		}
		$draft = \implode( "\n", $lines ) . "\n";

		$message                   = Message::new_message();
		$message[ Message::TYPE ]  = Message::TM_BYTESTREAM;   // a string payload, not a struct
		$message[ Message::FROM ]  = $this->name;
		$message[ Message::VALUE ] = $draft;
		parent::fill( $message );

		$n           = \count( $this->items );
		$this->items = [];

		// Reply to the caller along the breadcrumb.
		$reply                   = Message::new_message();
		$reply[ Message::TYPE ]  = Message::TM_STRUCT | Message::TM_RESPONSE;
		$reply[ Message::FROM ]  = $this->name;
		$reply[ Message::TO ]    = $message[ Message::FROM ];
		$reply[ Message::ID ]    = $message[ Message::ID ];
		$reply[ Message::VALUE ] = [ 'verb' => 'FLUSH', 'data' => [ 'flushed' => $n ] ];
		$this->sink->fill( $reply );
	}
}
```

The draft has to land somewhere. You don't write a file-writer node — the substrate ships one. **`Log`** appends whatever it receives to a file. Wire the digest into it:

```
> make_node Digest_Builder digest
> make_node Log log /tmp/example-ai-newsletter/digest.md
> connect_node summarizer digest
> connect_node digest log
> request_node releases TICK
> request_node digest FLUSH
{ "verb": "FLUSH", "data": { "flushed": 2 } }
```
```bash
cat /tmp/example-ai-newsletter/digest.md
# # Newsletter draft
#
# - Roundup Block ships — AI summarizes selected posts into a draft.
# - Editorial Assistant GA — Inline AI assistance in the editor.
```

Four nodes, a working pipeline. You wrote three; `Log` you reused.

---

## 5. Make it a topology — and get a debugger for free

Typing `make_node`/`connect_node` by hand is how you explore. To run it as a real, persistent worker, write the same lines to a topology file.

`topologies/example-ai-newsletter.tsl` — shown here **simplified for teaching** (it already includes the `community` source from step 6 and the `Tee` tap; if you're following along, leave `community` and its `connect_node` out until step 6):

```
var num_partitions = 1
make_node Releases_Source   releases
make_node Community_Source  community
make_node Summarizer        summarizer
make_node Digest_Builder    digest
make_node Tee               tee
make_node Log               log  /tmp/example-ai-newsletter/digest.md 1 7
connect_node releases   summarizer
connect_node community  summarizer
connect_node summarizer digest
connect_node digest     tee
connect_node tee        log
connect_node tee        _repl
```

> **The shipped `.tsl` does more.** This is a teaching reduction. The real [`topologies/example-ai-newsletter.tsl`](examples/example-ai-newsletter/topologies/example-ai-newsletter.tsl) additionally inserts a `Scorer` between the summarizer and a **durable scored `Partition`** (`example-scored.p<partition>`), with a `Consumer` tailing it back into the digest and `set_snapshot_node digest` co-committing the digest's state — that's the durability the [dashboard guide](writing-a-dashboard.md) reads from. Ignore that middle for now; it's [writing-a-dashboard.md](writing-a-dashboard.md)'s §1.

A few things this file adds that the by-hand session didn't:

- `var num_partitions = 1` is a topology **variable** — frontmatter the supervisor reads to size the worker pool. (`var <name> = <value>` is a Shell verb; `num_partitions` is the one the runtime acts on. Omit it and the topology still defaults to one partition, but copy the line so the example partitions the way the shipped file does.)
- A `Tee` fans the draft into **two** sinks — the `Log` file *and* `_repl`. The `_repl` tap is what lets the topology console (and a pivoted `wp nodes cli`) actually *see* the emitted draft scroll by; without it the draft only ever lands in the file. (`Tee` is the fan-out node introduced in step 6.)
- `Log log <file> 1 7` passes the file's positional `arguments` — `file`, `segment_size` (`1` → roll every write), `num_segments` (`7` → keep the last 7 segments `{file}.0`…`{file}.6`). The by-hand version omitted them and took the defaults (one large growing segment).

`register_plugin` (step 1) already pointed at `topologies/`, so this file is now a catalog entry. Activate it — `wp nodes activate` adds the topology to the active set and spawns its fleet immediately (the shipped active set is empty by default — nothing spawns until you activate it; you can also toggle it under **Settings → Nodes Runtime → Topologies**):

```bash
composer dump-autoload -o
wp nodes activate example-ai-newsletter
wp nodes ls
#   example-ai-newsletter.p0   [live]
```

Open the **topology console**. There's your graph — the same boxes and arrows you drew above — now live, with a message count on every edge. This is the payoff of the uniform contract: because every node speaks `fill()` and announces itself via `node_schema()`, the dashboard can render and drive a graph it has never seen. You didn't build any of this observability.

`cd` into the worker and drive it from the console's REPL — or pivot a terminal in:

```bash
wp nodes cli example-ai-newsletter.p0
```
```
> request_node releases TICK
> request_node digest FLUSH
```

Watch the counts climb on `releases → summarizer → digest`, and `digest.md` fill. Click the `TICK` and `FLUSH` buttons in the Inspector and the same thing happens — the buttons come straight from each node's `node_schema()` `requests`.

---

## 6. The reveal — a second source *(Ben's story)*

Months later, Ben is asked to add the publisher-community feed to the newsletter. Ben has not read Ana's code. He has never seen the summarizer or the digest builder. He is told one thing: **a source emits a `TM_STRUCT` item — `{ source, title, url, body }` — to its sink.**

So he writes the only thing he can: a source.

`includes/class-community-source.php`:

```php
class Community_Source_Node extends Node {

	protected function items(): array {
		return [
			[ 'title' => 'Reader forum hits 10k members', 'url' => 'https://example.test/c1', 'body' => 'The publisher community forum crossed ten thousand members this week.' ],
			[ 'title' => 'Local meetup recap', 'url' => 'https://example.test/c2', 'body' => 'Highlights from the latest in-person reader meetup downtown.' ],
			[ 'title' => 'Volunteer spotlight', 'url' => 'https://example.test/c3', 'body' => 'A community moderator shares why they give their time.' ],
		];
	}

	public function fill( array &$message ): void {
		if ( $message[ Message::TYPE ] & Message::TM_REQUEST ) {
			$this->handle_request( $message );
		}
	}

	private function handle_request( array $message ): void {
		foreach ( $this->items() as $item ) {
			$message                   = Message::new_message();
			$message[ Message::TYPE ]  = Message::TM_STRUCT;
			$message[ Message::FROM ]  = $this->name;
			$message[ Message::VALUE ] = [ 'source' => 'community' ] + $item;
			parent::fill( $message );   // fire-and-forget — emit, no reply
		}
	}

	// node_schema(): same shape as Releases_Source — category 'Source', a `TICK`
	// entry under 'requests'. No constructor, no sibling interpreter.
}
```

Then he adds his node to the topology and points it at the summarizer — **one line**:

```diff
  make_node Releases_Source   releases
+ make_node Community_Source  community
  make_node Summarizer        summarizer
  ...
  connect_node releases   summarizer
+ connect_node community  summarizer
```

```bash
composer dump-autoload -o
wp nodes restart example-ai-newsletter --all-partitions    # reload the topology
wp nodes cli example-ai-newsletter.p0
```
```
> request_node releases  TICK
> request_node community TICK
> request_node digest FLUSH
{ "verb": "FLUSH", "data": { "flushed": 5 } }
```

Five items in the draft, from two sources. **Ben changed nothing in the summarizer, the digest, the Log, or Ana's source.** He added a node and one wire.

Notice what `connect_node community summarizer` is: just another node pointing its `target` at the same downstream. That's **fan-in**, and it needs no special node — it's a direct consequence of the contract. (Fan-*out* — one source to many destinations — is the one case that needs a node: `Tee`.)

---

## 7. Make it real — the short hop

The example is deterministic on purpose, but every external touchpoint is a single seam:

- **Sources** — the toy `items()` returns a canned array. The real one returns ingest results: a `context-a8c` GitHub/Linear query, an RSS pull, a DB read. Nothing downstream changes — the summarizer and digest never knew the items were canned.
- **Summarizer** — the toy `summarize()` returns a template string. The real one calls your AI model. The graph is identical; one method body changes.

```php
// toy
protected function items(): array { return [ /* canned */ ]; }
// real (sketch)
protected function items(): array { return My_Github_Source::recent_releases(); }
```

Two method bodies stand between this walkthrough and a production newsletter pipeline. That's the short hop.

---

## 8. Ship it — the essential rigging

The example above runs *inside* this repo. A real plugin lives in its own repo and installs on a site that already has the substrate. Four essentials get you there — no more. (The sibling **`newspack-cache-cozy`** plugin is the minimal, fully-rigged reference: one node + a mu-plugin drop-in, every file below and nothing else. Read it alongside this section.)

### a. Depend on the substrate — declare it, defer your wiring

Two things, and resist adding a third:

- **Declare the dependency** in the plugin header so WordPress 6.5+ keeps the substrate active:
  ```php
  * Requires Plugins: newspack-nodes
  ```
- **Defer your wiring to `plugins_loaded` priority 11.** WordPress loads plugins alphabetically, so a plugin whose slug sorts before `newspack-nodes` loads *before* the substrate — its classes aren't available at your file-load time. Defer the runtime-dependent wiring, gated on a `class_exists` substrate-presence check (the §1 pattern), so it no-ops cleanly if the substrate isn't loaded:
  ```php
  add_action( 'plugins_loaded', static function () use ( $load ): void {
      if ( \class_exists( '\Newspack_Nodes\Timer_Node' ) ) {  // or whatever you extend
          $load();
      }
  }, 11 );
  ```

That's the whole story — `Requires Plugins` + a presence check. **Don't build a version-floor / capability-probe / admin-notice "substrate guard."** The plugins deploy together, so "present but too old" isn't a real case; a version floor is just machinery that pins an arbitrary minimum and rots. (If your plugin genuinely needs an API added in a specific substrate release, gate on `class_exists` / `method_exists` of *that exact symbol* — presence of the thing you need, never a version string.)

### b. Test it — the bootstrap is the only non-obvious part

Each node tests exactly as the recap below describes: build a message, call `fill()`, assert on a `Capture_Sink_Node`. The one piece that isn't obvious is the **test bootstrap**, because your tests need the substrate's classes (`Node`, `Timer_Node`, `Core`, `Message`) without a running WordPress. cache-cozy's `tests/bootstrap.php` is the template:

1. Define the handful of WordPress functions your code calls as `if ( ! function_exists() )` stubs (option store, `add_action`/`apply_filters`, `home_url`, …).
2. `require` the substrate plugin from its sibling checkout, then its test helpers — `tests/Helpers/TestCase.php` (resets `Core` in `setUp`) and `tests/Helpers/CaptureSink.php`.
3. `require` your own `vendor/autoload.php` (your classmap) and any mu-plugin drop-in.

Your test classes then `extend \Newspack_Nodes\Tests\TestCase`. Add a `tests/phpunit.xml` with `bootstrap="bootstrap.php"` and you're running `../vendor/bin/phpunit`.

### c. Lint to the same bar

Copy two configs and you lint identically to the substrate: `phpcs.xml.dist` (the `WordPress-VIP-Go` ruleset) and `phpstan.neon.dist` (level 10 + `phpstan-strict-rules`). The one node-plugin-specific line tells PHPStan where the substrate's classes are, so your `extends Timer_Node` resolves with real types:
```neon
scanDirectories:
    - ../newspack-nodes/includes
```
(Point it at wherever your newspack-nodes checkout lives.) `composer.json` pulls in `automattic/vipwpcs`, `phpstan/phpstan` + `phpstan-strict-rules` + `szepeviktor/phpstan-wordpress` as dev deps; cache-cozy's is a ~50-line copy-and-rename.

### d. Release it

A `build-release.sh` that stages via `.distignore`, runs `composer install --no-dev --optimize-autoloader`, and zips the plugin dir; plus a tag-triggered `.github/workflows/release.yml` that runs it and publishes the zip with the matching `CHANGELOG.md` section as the notes. Pushing a `v1.2.3` tag is the whole release. cache-cozy's pair works as-is after a slug rename.

> **Dashboards are a separate story.** Everything above is server-side PHP. The moment you add a React admin dashboard you're into the substrate's shared-JS build (the `@newspack-nodes/shared` alias, esbuild, jest) — involved enough to deserve its own guide, **[writing-a-dashboard.md](writing-a-dashboard.md)**, which picks up this exact pipeline and adds the Publisher Insights dashboard. This guide stops at a fully-working, fully-tested, headless node plugin.

---

## 9. Recap — what you wrote vs. what you never touched

You wrote four small classes, each with one `fill()` (or one verb), and a topology file. You **reused** `Log`, the `Command_Interpreter`, the router, the worker lifecycle, and the entire topology console — none of which you wrote or configured.

And here's the thing worth sitting with: **Ana and Ben never met.** Ana wrote the releases source knowing nothing about summaries. The author of the summarizer never knew either source would exist. Ben added the community feed without reading a line of any of it. Nobody scheduled an integration meeting, because there was nothing to integrate — every node already agreed on the only thing that matters: a message arrives at `fill()`, you do your work, you forward it to your sink.

That's the bet of Nodes. You add capability by wiring a node, not by editing a system. Uphold the contract, and your piece drops into a graph full of pieces you've never seen — and theirs drop into yours.

And the same contract is what makes each node testable in isolation: the example ships PHPUnit suites under [`examples/example-ai-newsletter/tests/`](examples/example-ai-newsletter/tests/) — one per node, plus a `PipelineTest` that wires the whole graph. Each test does exactly what the substrate does: construct a message, call `fill()`, and assert on what landed in a `Capture_Sink_Node`. No worker, no router, no topology — just the contract.

---

## Where to go next

- **[writing-a-real-plugin.md](writing-a-real-plugin.md)** — the production deep dive: picks up where §7 stops and walks the real `newspack-ai-newsletter` plugin — a `Source` interface, real connectors (GitHub, Linear, RSS), a credential settings page, and a network test seam.
- **[getting-started.md](getting-started.md)** — the five-minute tour (if you skipped it).
- **[architecture-guide.md](architecture-guide.md)** — the full model: drain loop, partitions, workers, supervisor, the REPL.
- **[API.md](API.md)** — the REST endpoints.
- **[`examples/example-ai-newsletter/`](examples/example-ai-newsletter/)** — the complete, tested code for this walkthrough.
- **`newspack-cache-cozy`** — the minimal, fully-rigged *standalone* plugin (one node + a mu-plugin drop-in): the §8 essentials — `Requires Plugins` + a deferred presence-gated loader, test bootstrap, phpcs/phpstan, release workflow — as real files to copy.
