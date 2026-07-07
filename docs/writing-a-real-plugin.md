# Writing a *Real* Nodes Plugin

You've finished [writing-a-plugin.md](writing-a-plugin.md). You built the toy AI-newsletter — two canned sources, a template summarizer, a markdown digest — watched items flow through `fill()`, turned the by-hand session into a topology, and stood it up as a live worker. That guide's **§7, "Make it real — the short hop"**, promised the production version is just two method bodies away:

```php
// toy
protected function items(): array { return [ /* canned */ ]; }
// real (sketch)
protected function items(): array { return My_Github_Source::recent_releases(); }
```

That promise is true at the level of the *contract* — the summarizer and digest never learn the items stopped being canned. But "swap one method body" hand-waves a lot: real fetches block on the network, fail halfway, return duplicate items every tick, and need credentials a user types into a settings page. This guide is the deep dive. It walks the actual production plugin, **`newspack-ai-newsletter`** (the sibling repo, not the bundled `examples/example-ai-newsletter` toy), and shows everything we built *on top of* the toy to take it live.

The shape is unchanged — three sources fan into a summarizer, which feeds a scorer, a durable partition, a consumer, and a digest builder. What changed is everything around the seam: a `Source` interface, a shared abstract base that owns the connector plumbing, three real connectors (GitHub, Linear, RSS/Atom), a credential settings page, and a test seam that lets all of it run under coverage without touching the network.

> **The one thing to hold onto (still):** every node has one entry point, `fill( array &$message ): void`. Nothing below changes that. The real connectors are *more code* than the toy, but they're the same node — they still mint a `TM_STRUCT` per item and forward to their sink. Everything new lives behind `fetch()`, which `fill()` calls and the graph never sees.

The finished code is in the sibling [`newspack-ai-newsletter/`](../../newspack-ai-newsletter/) repo. Read along, or diff it against the toy.

---

## 0. What changed — the same graph, real ends

The toy graph and the real graph are the same boxes and arrows. Here's the production topology (`topologies/newspack-ai-newsletter.tsl`):

```
github ┐
linear ┼─ summarizer ─ scorer ─ scored:partition      (durable `scored` log)
feed   ┘
scored:consumer ─ digest ─ digest:tee ─ digest:log
```

Three connector **sources** fan into the summarizer (fan-in, exactly as Ben's community source did in the toy). What's genuinely new from the toy's perspective is concentrated at the two ends:

- **The source end.** The toy's `items()` returned a literal array. The real sources `fetch()` over HTTP, normalize wildly different payloads (GitHub REST, Linear GraphQL, RSS/Atom XML) into one item shape, dedup against what they've already emitted, and need credentials.
- **The credentials.** A real source is useless without a token. We added a settings page built on the substrate's `Config_System`, and learned the hard way that a `Field` without a `render`/`sanitize` callback silently never appears.

The middle — summarizer, scorer, partition, consumer, digest — is its own story (the LLM seam, the durable `scored` log, the snapshot co-commit); this guide stays at the source end and the settings, because that's the part the toy guide explicitly deferred. We'll write it in the order you'd discover it: the contract first, then the base that implements it, then the three connectors, then the credentials that feed them, then wiring and ship.

---

## 1. The Source interface + the closure-HTTP test seam

The toy's "seam" was a `protected function items(): array` you'd override. That's fine for canned data. For real connectors we promoted the seam to a named contract — an interface — so the abstract base can depend on it and every connector is forced to honor it.

`includes/interface-source.php`:

```php
namespace Newspack_AI_Newsletter;

interface Source {
	/**
	 * Fetch and normalize items from the underlying connector.
	 *
	 * @param array<string,mixed> $config Connector configuration (tokens, feeds, filters).
	 * @return array<int,array<string,mixed>> Normalized items.
	 */
	public function fetch( array $config ): array;
}
```

One method. Give me a config, hand me back normalized items. `fetch()` is where the network lives — and the network is exactly the thing tests can't touch. So every connector exposes a **closure-HTTP seam**: a static, nullable `\Closure` property that, when set, stands in for the one `wp_remote_get`/`wp_remote_post` call. From `Github_Source_Node`:

```php
/**
 * libcurl/wp_remote_get call seam. Null by default; the call site then invokes
 * the real `wp_remote_get`. Tests reassign it (and reset to null in tearDown) to
 * return canned GitHub JSON WITHOUT short-circuiting header assembly, the
 * WP_Error / non-200 branches, or the per-endpoint normalization — so all of
 * that runs as real, covered production code.
 *
 * Signature: `function ( string $url, array $args ): array|\WP_Error`.
 *
 * @var (\Closure( string, array<string,mixed> ): (array<string,mixed>|\WP_Error))|null
 */
public static ?\Closure $http_get = null;
```

The call site resolves the seam lazily, with a ternary — null means "use the real thing":

```php
$response = null !== self::$http_get ? ( self::$http_get )( $url, $args ) : \wp_remote_get( $url, $args );
if ( \is_wp_error( $response ) ) {
	$this->print_less_often( 'GitHub fetch failed: ' . $response->get_error_message() );
	return [];
}
if ( 200 !== (int) \wp_remote_retrieve_response_code( $response ) ) {
	return [];
}
$decoded = \json_decode( \wp_remote_retrieve_body( $response ), true );
return \is_array( $decoded ) ? $decoded : [];
```

**Why a closure property and not a `protected function http_get()` you override in a test subclass?** This is the rule from `~/.claude/rules/test-seams.md`: always use the static `\Closure` property form, never the protected-helper-with-subclass-override form. The difference is coverage. A test reassigns `Github_Source_Node::$http_get = fn( $url, $args ) => [ 'response' => [ 'code' => 200 ], 'body' => $canned_json ];` and substitutes *only* the one transport call — header assembly, the `is_wp_error` branch, the non-200 branch, `json_decode`, and the whole per-endpoint normalization all run as **real production code under coverage**. A subclass override would mark `http_get()` "covered" while the production body — the part where the actual bugs live — never executes in any test. The seam substitutes the side effect and exercises everything around it.

> **Fetches block — and that's fine.** `wp_remote_get` with a 15-second timeout is a synchronous, blocking call; so is the Linear GraphQL POST. In a web request that would be unacceptable. But connector fetches don't run in a web request — they run inside a background **worker** process (that's why the file carries `phpcs:ignore` notes for the VIP remote-request rules: *"connector fetches run in a background worker, not a VIP web request"*). The same reasoning licenses the LLM calls downstream. Blocking is acceptable here precisely because the worker is the isolation boundary — exactly the [Tachikoma](https://github.com/datapoke/tachikoma) "process isolation for blocking ops" pattern, ported to WordPress workers.

---

## 2. The `Source_Node` abstract base — the uniform connector

In the toy, *every* source hand-rolled its own `fill()` and its own `handle_request()` — Ana's releases source and Ben's community source were near-identical copies. That's fine for two canned sources in a tutorial. For three real connectors that all need TICK handling, dedup, fire-and-forget emit, and normalization, copying that boilerplate three times is how drift creeps in. So we hoisted all of it into one abstract base, `Source_Node`, and left each connector with only the two things that genuinely differ.

`includes/class-source-node.php`:

```php
abstract class Source_Node extends Node implements Source {

	/** Cap on the remembered emitted-id set — bounds memory on a long-lived worker. */
	private const MAX_SEEN = 2000;

	/** @var array<string,bool> Emitted item ids (insertion-ordered), for cross-tick dedup. */
	protected array $seen = [];

	/** The first seam: per-connector config (Settings reads) passed to fetch(). */
	abstract protected function config(): array;

	/** TICK is a runtime trigger: a TM_REQUEST handled here in fill(). */
	public function fill( array &$message ): void {
		$type = \is_numeric( $message[ Message::TYPE ] ) ? (int) $message[ Message::TYPE ] : 0;
		if ( $type & Message::TM_REQUEST ) {
			$this->handle_request( $message );
		}
	}
```

The base owns four things the toy duplicated:

**TICK handling.** `fill()` branches on `TM_REQUEST` and calls `handle_request()` — once, in the base. (Note: unlike the toy, the production source does *not* send a `{ emitted }` reply; emit is pure fire-and-forget. See below.)

**Dedup by item `id`.** A real source is polled on a timer; each TICK re-fetches the same window and would re-emit items the digest already has. So the base keeps a bounded `$seen` set and drops anything it's emitted before:

```php
private function handle_request( array $message ): void {
	foreach ( $this->fetch( $this->config() ) as $item ) {
		$id = isset( $item['id'] ) && \is_string( $item['id'] ) ? $item['id'] : '';
		if ( '' === $id || isset( $this->seen[ $id ] ) ) {
			continue;
		}
		$this->remember( $id );
		$response                   = Message::new_message();
		$response[ Message::TYPE ]  = Message::TM_STRUCT;
		$response[ Message::FROM ]  = $this->name;
		$response[ Message::VALUE ] = $item;
		// parent::fill stamps TO from a connect_node-set target, then forwards to sink.
		parent::fill( $response );
	}
}

/** Record an emitted id, evicting the oldest once the set exceeds MAX_SEEN. */
private function remember( string $id ): void {
	$this->seen[ $id ] = true;
	if ( \count( $this->seen ) > self::MAX_SEEN ) {
		$this->seen = \array_slice( $this->seen, -self::MAX_SEEN, null, true );
	}
}
```

An item with no string `id` is skipped — no id means no dedup key, and the contract requires one. The set is capped at `MAX_SEEN = 2000` and evicts oldest-first with `array_slice`, so a worker that lives ten minutes and ticks repeatedly never grows the set without bound. (This is the Tachikoma "sliding-window expiration / bounded state" discipline: constant memory regardless of message rate.)

**Fire-and-forget emit.** Each new item goes out via `parent::fill( $response )` — the §2-of-the-toy emit pattern: build the message, let the base `Node::fill()` stamp `TO` from the `connect_node`-wired target and forward to the sink. No reply, no `TM_PERSIST` ack ([ADR-3](architecture-decisions.md#adr-3-fire-and-forget-messaging)); the single-threaded drain is the backpressure.

**Shared `normalize_item()` and `source_schema()`.** Three connectors, three radically different payloads, but exactly one output shape. The base coerces and guards every field once:

```php
protected function normalize_item( string $source, string $id, mixed $title, mixed $url, mixed $body, mixed $when ): array {
	$ts = \is_string( $when ) ? \strtotime( $when ) : false;
	return [
		'source'    => $source,
		'id'        => "$source:$id",
		'title'     => \is_string( $title ) ? $title : '',
		'url'       => \is_string( $url ) ? $url : '',
		'body'      => \is_string( $body ) ? $body : '',
		'timestamp' => false !== $ts ? $ts : 0,
	];
}
```

That's the **item contract**: `{ source, id, title, url, body, timestamp }`. The final `id` is namespaced `"$source:$id"` so a GitHub `#release-5` and a Linear `ENG-5` never collide in the dedup set; the bare `$id` each connector passes must already be stable per item, because that's what dedup keys on. A date string that won't parse becomes `timestamp 0` rather than throwing.

`source_schema()` builds each connector's `node_schema()` from one shared shape (category `Source`, one `TICK` request) so the connectors don't restate it:

```php
protected static function source_schema( string $description, string $tick_description ): array {
	return \array_merge( parent::node_schema(), [
		'category'    => 'Source',
		'description' => $description,
		'requests'    => [
			[ 'name' => 'TICK', 'description' => $tick_description ],
		],
	] );
}
```

`Source_Node` is `abstract` and declares no `node_schema()` of its own — you never `make_node Source_Node`. Each concrete connector supplies its own one-liner.

This is force #7, **uniform interface**, taken one level up from the toy. In the toy each node hand-rolled `fill()`. Here, a *category* of nodes — connectors — share one implementation of the contract, and a new connector supplies only `fetch()` + `config()`. The base is the connector; the subclass is the wiring to a specific API.

---

## 3. The three real connectors

Three APIs, three payload shapes, three auth schemes. Each subclass is small precisely because the base did the heavy lifting — each adds only `config()`, `fetch()`, and a one-line `node_schema()`.

### GitHub — three endpoints, per-endpoint isolation

`Github_Source_Node` pulls **Releases**, **Merged PRs**, and **Issues** across every repo in `github_repos`. `config()` reads the repo list and token; `fetch()` loops the repos:

```php
public function fetch( array $config ): array {
	$repos = \is_array( $config['repos'] ?? null ) ? $config['repos'] : [];
	$token = Core::as_string( $config['token'] ?? null );
	$items = [];
	foreach ( $repos as $repo ) {
		if ( ! \is_string( $repo ) || '' === $repo ) {
			continue;
		}
		$items = \array_merge(
			$items,
			$this->releases( $repo, $token ),
			$this->merged_prs( $repo, $token ),
			$this->issues( $repo, $token )
		);
	}
	return $items;
}
```

The three endpoints each have a quirk the connector handles:

- **Merged PRs.** The PRs endpoint lists *closed* PRs, most of which were never merged. The connector filters on `merged_at` — closed-but-not-merged contributes nothing:
  ```php
  $merged_at = $pr['merged_at'] ?? null;
  if ( ! \is_string( $merged_at ) || '' === $merged_at ) {
      continue; // Closed but not merged.
  }
  ```
- **Issues.** GitHub's issues endpoint *also* returns PRs (each carries a `pull_request` key). Those are dropped so a PR doesn't appear twice:
  ```php
  if ( ! \is_array( $issue ) || isset( $issue['pull_request'] ) ) {
      continue;
  }
  ```
- **Stable ids.** Each item gets a stable, namespaced id — `github:owner/repo#release-N`, `…#pr-N`, `…#issue-N` — so dedup is deterministic across ticks.

Auth is **Bearer**, and GitHub *requires* a `User-Agent`. Both live in `request_args()`, which adds the `Authorization` header only when a token is actually set:

```php
$headers = [
	'Accept'     => 'application/vnd.github+json',
	'User-Agent' => self::USER_AGENT,
];
if ( '' !== $token ) {
	$headers['Authorization'] = 'Bearer ' . $token;
}
```

The crucial robustness property: **a failed repo or endpoint contributes nothing and never throws.** `get_json()` returns `[]` on a `WP_Error`, a non-200, or a non-array body — the caller treats "no items" and "fetch failed" identically. One unreachable repo, one rate-limited endpoint, can't sink the whole batch. That's graceful degradation (force #12) at the granularity of a single HTTP call.

### Linear — GraphQL, raw-token auth

`Linear_Source_Node` is a single GraphQL **POST**, behind a `$http_post` seam. `config()` reads just `linear_token`; `fetch()` short-circuits to `[]` when there's no token (no creds, nothing to do), then posts a fixed query:

```php
private const QUERY = '{ issues(first: 30, orderBy: updatedAt) { nodes { identifier title url description updatedAt } } }';
```

Two things differ from GitHub. First, **auth is the raw token — not `Bearer ` + token.** Linear's API wants the token verbatim in the `Authorization` header:

```php
'headers' => [
	'Authorization' => $token,          // raw token, NOT 'Bearer ' . $token
	'Content-Type'  => 'application/json',
],
'body'    => (string) \wp_json_encode( [ 'query' => self::QUERY ] ),
```

Second, **a GraphQL 200 can still carry errors.** GraphQL returns HTTP 200 with a partial `data` plus an `errors` array; the connector tolerates that by simply walking `data.issues.nodes[]` defensively and emitting whatever issues did come back:

```php
$data   = \is_array( $decoded ) ? ( $decoded['data'] ?? null ) : null;
$issues = \is_array( $data ) ? ( $data['issues'] ?? null ) : null;
$nodes  = \is_array( $issues ) ? ( $issues['nodes'] ?? null ) : null;
if ( ! \is_array( $nodes ) ) {
	return [];
}
```

Each node's `identifier` (e.g. `ENG-123`) is the stable per-item id; a node without one is skipped.

### Feed — RSS 2.0 *and* Atom, from untrusted XML

`Feed_Source_Node` reads any number of RSS/Atom URLs from `feeds`, GETs each (behind `$http_get`), and parses the body. The parse is the interesting part, because the input is **untrusted third-party XML**:

```php
$prev = \libxml_use_internal_errors( true );
// LIBXML_NONET: a third-party feed body is untrusted — never let a DTD/xinclude
// SYSTEM reference fetch a URL. (libxml 2.9+ already disables external entity
// substitution by default, since we don't pass LIBXML_NOENT.)
$xml = \simplexml_load_string( $body, \SimpleXMLElement::class, LIBXML_NONET );
\libxml_clear_errors();
\libxml_use_internal_errors( $prev );
if ( false === $xml ) {
	$this->print_less_often( 'Feed parse failed' );
	return [];
}
// Dispatch on document shape: RSS has <channel>; Atom's root is <feed>.
return isset( $xml->channel ) ? $this->parse_rss( $xml ) : $this->parse_atom( $xml );
```

`LIBXML_NONET` is the load-bearing flag: it stops a malicious feed's DTD/xinclude `SYSTEM` reference from making the parser fetch a URL (an SSRF vector). libxml errors are captured and a parse failure yields `[]` — same fire-and-forget posture as the HTTP failures.

The two formats have their own field-mapping quirks:

- **RSS 2.0.** Items at `channel/item`; id prefers `<guid>`, else `<link>`. When a feed has no `<pubDate>` (RSS 1.0 / RDF-bridged feeds), it falls back to Dublin Core `<dc:date>` via a namespaced read:
  ```php
  $when = (string) $item->pubDate;
  if ( '' === $when ) {
      $when = (string) $item->children( self::DC_NS )->date;
  }
  ```
- **Atom.** Entries at `entry`; id prefers `<id>`, else the link. Body prefers `<summary>`, else `<content>`. And the link itself is non-trivial — an entry can carry several `<link rel="…">` elements, and you want the `rel="alternate"` (the human-readable page), not a leading `rel="self"`/`rel="edit"`:
  ```php
  $rel = (string) ( $link->attributes()->rel ?? '' );
  if ( '' === $rel || 'alternate' === $rel ) {   // "" means alternate by Atom default
      return $href;
  }
  if ( '' === $fallback ) {
      $fallback = $href;   // remember a non-alternate only as last resort
  }
  ```

All three connectors hand the base the same `{ source, id, title, url, body, timestamp }` shape via `normalize_item()`. Downstream, the summarizer cannot tell a merged PR from a Linear issue from a blog post — and doesn't need to.

---

## 4. Credentials & the settings page

A real source needs a token, a repo list, a feed list — values a user types in. The substrate ships the machinery for this: `Config_System`. You declare one `Field` per setting and the `Schema` derives every consumer (the overlay key-list, the `register_setting` loop, the reset surface, restart classification). The plugin's declaration is `Settings::schema()`.

### Every Field needs a `render` and a `sanitize` — or it silently vanishes

This is the bug we hit, so it leads. The substrate's `Schema` **skips any field without a `render` and `sanitize` callback** — no error, no warning, the field just never appears in the UI. So each `Field` carries factory-built closures. The text/password render factory:

```php
private static function text_render( string $key, bool $secret = false ): \Closure {
	return static function () use ( $key, $secret ): void {
		\printf(
			'<input type="%s" name="%s" value="%s" class="regular-text" autocomplete="off" />',
			$secret ? 'password' : 'text',
			\esc_attr( self::PREFIX . $key ),
			\esc_attr( self::get_string( $key ) )
		);
	};
}
```

List fields (the repo list, the feed list) render as a one-entry-per-line textarea:

```php
private static function list_render( string $key ): \Closure {
	return static function () use ( $key ): void {
		\printf(
			'<textarea name="%s" rows="4" class="large-text code">%s</textarea>',
			\esc_attr( self::PREFIX . $key ),
			\esc_textarea( \implode( "\n", self::get_array( $key ) ) )
		);
	};
}
```

And the matching sanitizers — text is trim + strip-tags; the list splits on newlines and drops blanks:

```php
private static function list_sanitize(): \Closure {
	return static function ( $value ): array {
		$lines = \is_array( $value )
			? $value
			: \preg_split( '/\r\n|\r|\n/', \is_scalar( $value ) ? (string) $value : '' );
		$out = [];
		foreach ( (array) $lines as $line ) {
			if ( \is_scalar( $line ) && '' !== ( $clean = \sanitize_text_field( (string) $line ) ) ) {
				$out[] = $clean;
			}
		}
		return $out;
	};
}
```

### Secrets are password inputs, not autoloaded

The three credentials — `ai_proxy_token`, `github_token`, `linear_token` — render as `password` inputs (the `$secret` flag) and carry `register_args: [ 'secret' => true, 'autoload' => false ]`. `secret` is the substrate's free-form per-field metadata seam (the `Field` has no native secret flag) — sub-projects read it to render the password input and keep the value out of any config dump. `autoload: false` keeps the token out of WordPress's autoloaded options bundle on every page load. A representative declaration:

```php
new Field(
	key: 'github_token',
	type: 'text',
	label: static fn(): string => \__( 'GitHub Token', 'newspack-ai-newsletter' ),
	section: self::CONNECTORS_SECTION,
	sanitize: self::text_sanitize(),
	render: self::text_render( 'github_token', true ),   // secret = password input
	register_args: [ 'secret' => true, 'autoload' => false ],
),
```

Labels are lazy `fn(): string` thunks wrapping `__()` so building the schema (a frontend request does this via `overlay_keys()`) never calls `__()` at load time.

### The classic Settings-API page

The admin page is plain WordPress Settings API — no React. `register_settings()` (on `admin_init`) hands the substrate Schema the two halves it needs:

```php
function register_settings(): void {
	if ( ! \class_exists( '\Newspack_Nodes\Config_System\Schema' ) ) {
		return;
	}
	$schema = Settings::schema();
	$schema->register_options( SETTINGS_GROUP );                   // register_setting() per field
	$schema->register_sections_and_fields( SETTINGS_MENU_SLUG );   // add_settings_field() per field
}
```

`register_options( SETTINGS_GROUP )` wires `register_setting()` for every sanitized field under the group; `register_sections_and_fields( SETTINGS_MENU_SLUG )` adds the rendered fields to the page. The page callback is the textbook form:

```php
function render_settings_page(): void {
	if ( ! \current_user_can( 'manage_options' ) ) {
		return;
	}
	echo '<div class="wrap"><h1>' . \esc_html__( 'AI Newsletter Settings', 'newspack-ai-newsletter' ) . '</h1>';
	echo '<form method="post" action="options.php">';
	\settings_fields( SETTINGS_GROUP );          // nonce + group, must match register_options()
	\do_settings_sections( SETTINGS_MENU_SLUG ); // the rendered fields, must match register_sections_and_fields()
	\submit_button();
	echo '</form></div>';
}
```

The contract that ties it together: the input's `name` attribute (`PREFIX . $key`, e.g. `newspack_ai_newsletter_github_token`) **must equal** the option `register_setting` registered, or the value posts into the void and never saves. The render factory and `register_options()` both derive that name from the same `PREFIX . $key`, which is why they stay in lockstep.

> **The React dashboard is separate.** This Settings page is *credentials in*. The **Publisher Insights** dashboard (the React mount on its own admin menu, served by `Insights_CI`) is *insights out* — and it's a whole other build story (the `@newspack-nodes/shared` alias, esbuild, jest). That's [writing-a-real-dashboard.md](writing-a-real-dashboard.md), not this guide. This guide stops at a headless, credential-fed pipeline.

---

## 5. Wiring real sources into the topology

The production `.tsl` is the toy topology with real source nodes swapped in and the scored/durable middle added. The fan-in is unchanged — three sources point their `target` at the summarizer:

```
make_node Github_Source  github
make_node Linear_Source  linear
make_node Feed_Source    feed
make_node Summarizer     summarizer
...
connect_node github          summarizer
connect_node linear          summarizer
connect_node feed            summarizer
```

Three sources, one summarizer, one wire each — fan-in needs no special node, just like Ben's community source. The only new substrate trick at the source end is that the sources **emit nothing until credentials are set**: a `Linear_Source` with no `linear_token` returns `[]` from `fetch()` and the TICK is a no-op. So a freshly-activated topology is live but silent, and stays silent until you fill in the settings page — which is the correct default.

Driving it by hand is identical to the toy: TICK each source, then FLUSH the digest.

```
> request_node github TICK
> request_node linear TICK
> request_node feed   TICK
> request_node digest FLUSH
```

(With no creds, the TICKs emit nothing and the FLUSH writes an empty draft — set a `github_token` + a `github_repos` entry and re-TICK to see items flow.)

---

## 6. Ship & operate it

A real plugin lives in its own repo and installs on a site that already has the substrate. The §8 essentials from the toy guide all apply (`Requires Plugins: newspack-nodes`, the deferred `plugins_loaded` loader, the test bootstrap, phpcs/phpstan, the release workflow). Here are the operational gotchas specific to taking *this* plugin live.

**Deploy installs a prebuilt zip — build first.** The setup script installs the existing `release/*.zip`; it does **not** build. So the loop is *build, then deploy*:

```bash
cd services/pyrobase/sources/newspack-ai-newsletter
npm run release:archive    # builds release/newspack-ai-newsletter.zip
docker exec eve-pyrobase1-1 /services/pyrobase/setup/newspack-ai-newsletter.sh
```

Skip the build and your live `wp nodes` runs the *old* code — and because the PHPUnit suite runs from `/services`, the tests won't catch the stale deploy.

**After adding node classes, regenerate the autoloader.** The classmap is what `make_node` resolves against and what `Classes_CI` scans to populate the console palette. For local container testing run `composer dump-autoload -o` after adding or renaming a node. (The release zip is already optimized, so a freshly-built zip needs no separate dump.)

**Restart workers after deploy.** A running worker holds the old class in its PHP process for the rest of its ~10-minute lifespan. Force the refresh:

```bash
docker exec eve-pyrobase1-1 wp nodes restart all --all-partitions --allow-root --path=/var/www/html
```

**Topologies register, but you activate them.** `register_plugin()` (in the bootstrap) makes `newspack-ai-newsletter.tsl` a *catalog* entry; the supervisor only spawns a topology in the *active* set. Activate it from the console's Topology Manager or with `topologies activate <name>`, then confirm:

```bash
docker exec eve-pyrobase1-1 wp nodes ls --allow-root --path=/var/www/html
#   newspack-ai-newsletter.p0   [live]
```

**Tests run in the container, from `/services`, no network.** The closure-HTTP seam is what makes the connector suites hermetic — tests set `$http_get`/`$http_post` to return canned bodies, so nothing leaves the box:

```bash
docker exec -u bend eve-pyrobase1-1 bash -c \
  'cd /services/pyrobase/sources/newspack-ai-newsletter/tests && ../vendor/bin/phpunit'
```

Lint to the same bar as the substrate — `npm run lint:php` (phpcs, VIP Go) and `npm run lint:phpstan` (level 10 + strict rules).

---

## 7. Recap — what you added vs. what the substrate still gave you

The toy guide's punchline was *Ana and Ben never met* — capability added by wiring a node, not editing a system. Going real didn't change that bet; it cashed it in.

You added three real classes — `Github_Source_Node`, `Linear_Source_Node`, `Feed_Source_Node` — and each one is only `config()` + `fetch()` + a one-line `node_schema()`, because the new **`Source_Node`** base absorbed every connector concern the toy used to copy per source: the TICK trigger, the bounded dedup set, the fire-and-forget emit, and the shared `normalize_item()` that flattens three wildly different payloads into one item shape. You added a `Source` interface to name the seam, a closure-HTTP seam per connector so the network-touching code runs under coverage, and a `Config_System` settings page so the connectors have credentials to fetch with.

And here's what you **still** never touched. The summarizer, the scorer, the digest builder — none of them learned the items stopped being canned; they consume `{ source, id, title, url, body }` exactly as before. The router, the worker lifecycle, the supervisor, the topology console, the Settings-API plumbing behind `register_options()`, the offsetlog snapshot in the durable middle — all reused. The connectors dropped into a graph full of pieces they've never seen, because they upheld the one contract: a message arrives at `fill()`, you do your work, you forward it to your sink.

That was the short hop the toy guide promised — `items()` → `fetch()`. It turned out to be two method bodies of *intent* wrapped in a base class of *plumbing*, a settings page, and a test seam. The intent really was small. The plumbing is what the substrate lets you write once and stop thinking about.

---

## Where to go next

- **[writing-a-plugin.md](writing-a-plugin.md)** — the toy walkthrough this guide extends (re-read §7–9 with the real code in mind).
- **[writing-a-real-dashboard.md](writing-a-real-dashboard.md)** — this guide's sibling: the production console/dashboard surfaces (palette vs inspector, measured transcript ceilings, the icons build gotcha) and the *insights out* half §4 deferred.
- **[writing-a-dashboard.md](writing-a-dashboard.md)** — the original toy Publisher Insights React dashboard walkthrough.
- **[architecture-guide.md](architecture-guide.md)** — the full model: drain loop, partitions, workers, supervisor, the REPL.
- **[architecture-decisions.md](architecture-decisions.md)** — the load-bearing ADRs (fire-and-forget §3, PIPE_BUF §4, lazy init §5).
- **[`../../newspack-ai-newsletter/`](../../newspack-ai-newsletter/)** — the complete production plugin: `includes/`, `topologies/newspack-ai-newsletter.tsl`, the PHPUnit suite.
