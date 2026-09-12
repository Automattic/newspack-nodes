# Writing a *Real* Nodes Plugin

You've finished [writing-a-plugin.md](writing-a-plugin.md). You built the toy AI-newsletter — two canned sources, a template summarizer, a markdown digest — watched items flow through `fill()`, turned the by-hand session into a topology, and stood it up as a live worker. That guide's **§7, "Make it real — the short hop"**, promised the production version is two method bodies away:

```php
// toy
protected function items(): array { return [ /* canned */ ]; }
// real (sketch)
protected function items(): array { return My_Github_Source::recent_releases(); }
```

That promise is true at the level of the *contract* — the summarizer and digest never learn the items stopped being canned. But "swap one method body" hand-waves a lot: real fetches block on the network, fail halfway, return duplicate items every tick, and need credentials an operator stores in the substrate's [Vault](../includes/class-vault.php). This guide is the deep dive. It walks the actual production plugin, **`newspack-intelligence`** (the sibling repo, not the bundled [`examples/example-ai-newsletter`](../examples/example-ai-newsletter/) toy), and shows everything that sits *on top of* the toy to take it live.

The shape is unchanged — three sources fan into a durable `ingest` partition, a consumer paces them through a summarizer, a scorer, and a second durable partition, and a final consumer feeds a digest builder. What changed is everything around the seam: a `Source` interface, a shared abstract base that owns the connector plumbing, three real connectors (GitHub, Linear, RSS/Atom), credentials kept in the substrate's **Vault** and referenced from the topology, and a test seam that lets all of it run under coverage without touching the network.

> **The one thing to hold onto (still):** every node has one entry point, `fill( array $message ): void`. Nothing below changes that. The real connectors are *more code* than the toy, but they're the same node — they still mint a `TM_STRUCT` per item and forward to their sink. Everything new lives behind `fetch()`, which `fill()` calls and the graph never sees.

The finished code is in the sibling [`newspack-intelligence`](https://github.com/Automattic/newspack-intelligence) repo. Read along, or diff it against the toy.

---

## 0. What changed — the same graph, real ends

The toy graph and the real graph are the same boxes and arrows, plus a durable **ingest** layer the toy didn't need. (The toy's scorer and its `scored` partition arrive in [writing-a-dashboard.md](writing-a-dashboard.md#1-give-the-pipeline-something-worth-showing--score-it-and-make-it-durable) §1, so the bundled example already carries them.) Here's the production topology:

![The production graph as five nested topology files. The aggregator newspack-intelligence.tsl (var on_demand_idle = 0, var num_partitions = 1, include topic-probe, four includes, secure) frames four stage bands. Ingest: github (set_vault_id github and five add_repo lines), linear (set_vault_id linear) and feed (three add_url lines, no credential) fan into ingest:partition, logs/ingest.p0 under void_warranty. Summary: ingest:consumer in line mode feeds the LLM summarizer and the scorer into scored:partition. Digest: scored:consumer, with add_snapshot_node digest, feeds digest (Digest_Builder scored:partition 3), digest:tee and digest:log (digest.md 1 2 7 0 0 0). Gate: gate:consumer tails the same ingest log under offsets/gate.p0 into gate, gate:tojson and gate:log. Dashed green lines mark each Consumer tailing a Partition under its own offsetlog.](img/wrp-production-topology.png)

It ships as five `.tsl` files, not one. [`topologies/newspack-intelligence.tsl`](https://github.com/Automattic/newspack-intelligence/blob/v0.9.11/topologies/newspack-intelligence.tsl) is an aggregator that `include`s a file per stage — `-ingest`, `-summary`, `-digest`, and `-gate` — and restates the resident default, `var on_demand_idle = 0`, which a stage meant to sleep between collects would raise. `register_plugin()` catalogs *every* `.tsl` in `topologies/`, so a stage can be activated alone and run as its own fleet — instead of the aggregator, never alongside it ([§6](#6-ship--operate-it)).

Three connector **sources** fan into the `ingest` partition (fan-in, exactly as Ben's community source fanned into the summarizer in the toy — the target is a partition now, not the summarizer). What's genuinely new from the toy's perspective is concentrated at the two ends, plus the ingest partition between them:

- **The source end.** The toy's `items()` returns a literal array. The real sources `fetch()` over HTTP and normalize wildly different payloads (GitHub REST, Linear GraphQL, RSS/Atom XML) into one item shape; their shared base then drops anything it has emitted before.
- **The credentials.** Two of the three sources take a token: Linear's `fetch()` returns `[]` without one, and GitHub sends its `Authorization` header only when one is set. The secret lives in the substrate's **Vault** (the station's *Vault* tab), and the topology carries only a *pointer* to it — a `set_vault_id <id>` verb on the node's `.tsl` line, resolved to the raw secret at `config()`. The rest of a source's config is topology verbs too (`add_repo`, `add_url`, `set_model`, …). None of that config lives in a Settings page or an options row.
- **The ingest partition.** A source TICK appends raw items to a durable log and stops there; `ingest:consumer` paces them through the summarizer and scorer (§5).

The middle — summarizer, scorer, the two partitions, consumers, digest — is its own story (the LLM seam, the durable `scored` log, the snapshot co-commit), and so is the gate observer hanging off `ingest`. This guide stays at the source end, the ingest buffer, and the credentials, because that's the part the toy guide explicitly deferred. We'll write it in the order you'd discover it: the contract first, then the base that implements it, then the three connectors, then the credentials that feed them, then wiring and ship.

---

## 1. The Source interface + the closure-HTTP test seam

The toy's "seam" was a `protected function items(): array` you'd override. That's fine for canned data. Real connectors promote the seam to a named contract — an interface — so the abstract base can depend on it and every connector is forced to honor it.

[`includes/interface-source.php`](https://github.com/Automattic/newspack-intelligence/blob/v0.9.11/includes/interface-source.php):

```php
namespace Newspack_Intelligence;

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

One method. Give me a config, hand me back normalized items. `fetch()` is where the network lives — and the network is exactly the thing tests can't touch. So every connector exposes a **closure-HTTP seam**: a static, nullable `\Closure` property that, when set, stands in for the one [`wp_remote_get`](https://developer.wordpress.org/reference/functions/wp_remote_get/)/`wp_remote_post` call. From [`Github_Source_Node`](https://github.com/Automattic/newspack-intelligence/blob/v0.9.11/includes/class-github-source-node.php):

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
	// print_less_often keys on its FIRST argument alone, so the varying message
	// rides as a second one; folding it into the first defeats the rate limit.
	$this->print_less_often( 'GitHub fetch failed: ', $response->get_error_message() );
	return [];
}
if ( 200 !== (int) \wp_remote_retrieve_response_code( $response ) ) {
	return [];
}
$decoded = \json_decode( \wp_remote_retrieve_body( $response ), true );
return Core::arr( $decoded );
```

![The same GitHub fetch twice, as six steps. With the static \Closure property $http_get, only step 2, the transport call, is the test's canned response; building the URL and headers, the is_wp_error() branch, the non-200 branch, json_decode and the per-endpoint normalization all run as measured production code. With a protected http_get() overridden in a test subclass, steps 1 to 5 are the override and read as covered while never executing; only the normalization runs. Beneath: GitHub and Feed carry $http_get and Linear $http_post, all with the signature function( string $url, array $args ): array|\WP_Error, and a fetch blocks for up to 15 seconds, which is acceptable because it runs in a background worker.](img/wrp-closure-seam.png)

The standing rule across these plugins is the static `\Closure` property, never a protected helper overridden in a test subclass, and the difference is coverage: the seam substitutes the side effect and leaves everything around it running as measured production code. Blocking is acceptable here because connector fetches run in a background worker rather than a VIP web request, which is what the file's `phpcs:ignore` notes for the VIP remote-request rules say. The worker is the isolation boundary, and the same reasoning licenses the LLM calls downstream.

---

## 2. The `Source_Node` abstract base — the uniform connector

In the toy, *every* source hand-rolls its own `fill()` and its own `handle_request()` — Ana's releases source and Ben's community source are near-identical copies. That's fine for two canned sources in a tutorial. For three real connectors that all need TICK handling, dedup, fire-and-forget emit, and normalization, copying that boilerplate three times is how drift creeps in. All of it therefore lives in one abstract base, `Source_Node`, leaving each connector only the two things that genuinely differ.

[`includes/class-source-node.php`](https://github.com/Automattic/newspack-intelligence/blob/v0.9.11/includes/class-source-node.php):

```php
abstract class Source_Node extends Node implements Source {
	use Schema_Reflection;

	/** Cap on the remembered emitted-id set — bounds memory on a long-lived worker. */
	private const MAX_SEEN = 2000;

	/** @var array<string,bool> Emitted item ids (insertion-ordered), for cross-tick dedup. */
	protected array $seen = [];

	/** No-arg ctor, as make_node requires. Mounts the `:config` sibling. */
	public function __construct() {
		parent::__construct();
		$this->auto_wire_interpreter();
	}

	/** The first seam: per-connector config (Vault + verb reads) passed to fetch(). */
	abstract protected function config(): array;

	/** TICK is a runtime trigger: a TM_REQUEST handled here in fill(). */
	public function fill( array $message ): void {
		$type = Core::num_int( $message[ Message::TYPE ] );
		if ( $type & Message::TM_REQUEST ) {
			$this->handle_request( $message );
		}
	}
```

That constructor is what makes §4's `cmd github:config set_vault_id …` lines work. [`Schema_Reflection::auto_wire_interpreter()`](../includes/trait-schema-reflection.php) reads `node_schema()['commands']` and mounts a sibling `Command_Interpreter_Node` named `{node}:config`, so every connector gets its config verbs without wiring one by hand ([ADR-11](architecture-decisions.md#adr-11-make_node-construction-sequence)).

![Source_Node's handling of one TICK in three steps. A TM_REQUEST reaches fill(), tested with Core::num_int( TYPE ) & TM_REQUEST, and no reply goes back. Inside try, fetch( $this->config() ) returns normalized items and each passes a loop: an item whose id is not a non-empty string is skipped, an id already in $seen is skipped, and otherwise remember( $id ) records it (past MAX_SEEN = 2000 the oldest are sliced off) and a TM_STRUCT goes out stamped TO ingest:partition. In finally, one TM_INFO "DONE\n" from the node's own name follows every item, even when fetch() threw. Side cards give the item contract { source, id: "$source:$id", title, url, body, timestamp }, the in-memory $seen that dies with the worker, and what the base declares: the {node}:config interpreter, the shared source_schema() with accepts_fill false, and an abstract class make_node Source cannot build.](img/wrp-source-tick.png)

The base owns what the toy copies per source: the TICK trigger, the bounded dedup, the fire-and-forget emit ([ADR-3](architecture-decisions.md#adr-3-fire-and-forget-messaging)) and the item shape. Unlike the toy, it sends no `{ emitted }` reply to whoever ticked it; every TICK closes, in a `finally`, with one `TM_INFO` `DONE` that travels *downstream* to the digest (§5 spells out the auto-compose it drives):

```php
private function handle_request( array $message ): void {
	try {
		foreach ( $this->fetch( $this->config() ) as $item ) {
			$id = Core::str( $item['id'] ?? null );
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
	} finally {
		// DONE always fires (even if fetch() throws) so one failing source can't stall collection.
		// FROM keys the digest's per-source tally; VALUE carries the marker.
		$done                   = Message::new_message();
		$done[ Message::TYPE ]  = Message::TM_INFO;
		$done[ Message::FROM ]  = $this->name;
		$done[ Message::VALUE ] = "DONE\n";
		parent::fill( $done );
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

Each transform on the way forwards `DONE` untouched, and each Consumer prepends its name to `FROM` through `Node::stamp_message()`; §5 follows it to the digest.

**Shared `normalize_item()` and `source_schema()`.** Three connectors, three unrelated payloads, one output shape. The base coerces and guards every field once:

```php
protected function normalize_item( string $source, string $id, mixed $title, mixed $url, mixed $body, mixed $when ): array {
	$ts = \is_string( $when ) ? \strtotime( $when ) : false;
	return [
		'source'    => $source,
		'id'        => "$source:$id",
		'title'     => Core::str( $title ),
		'url'       => Core::str( $url ),
		'body'      => Core::str( $body ),
		'timestamp' => false !== $ts ? $ts : 0,
	];
}
```

That's the **item contract**: `{ source, id, title, url, body, timestamp }`.

`source_schema()` builds each connector's `node_schema()` from one shared shape, so the connectors don't restate it:

```php
protected static function source_schema( string $description, string $tick_description ): array {
	return \array_merge( parent::node_schema(), [
		'category'     => 'Source',
		'description'  => $description,
		'requests'     => [
			[ 'name' => 'TICK', 'description' => $tick_description ],
		],
		'accepts_fill' => false,
	] );
}
```

This is the uniform-`fill()` contract ([ADR-1](architecture-decisions.md#adr-1-uniform-fill-contract)) taken one level up from the toy. In the toy each node hand-rolls `fill()`. Here a whole *category* of nodes — connectors — shares one implementation of the contract, and a new connector implements just the two abstract seams, `fetch()` and `config()`. The base is the connector; the subclass is the wiring to a specific API.

---

## 3. The three real connectors

Three APIs, three payload shapes, two auth schemes and one connector that needs none. Each subclass is small because the base does the heavy lifting — each adds only `config()`, `fetch()`, its verb handlers, the `dump_config()` lines those verbs round-trip through, and a `source_schema()`-based `node_schema()`.

### GitHub — three endpoints, per-endpoint isolation

[`Github_Source_Node`](https://github.com/Automattic/newspack-intelligence/blob/v0.9.11/includes/class-github-source-node.php) pulls **Releases**, **Merged PRs**, and **Issues** across every repo registered via `add_repo`. `config()` returns the repo list plus the token it resolves from the node's `vault_id`; `fetch()` loops the repos:

```php
public function fetch( array $config ): array {
	$repos = \is_array( $config['repos'] ?? null ) ? $config['repos'] : [];
	$token = \is_string( $config['token'] ?? null ) ? $config['token'] : '';
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

Every request asks for `per_page=10` (`PER_PAGE`), so a TICK's cost is bounded at three calls of ten items per repo however busy the repo is; the base's `$seen` set is what keeps the overlap between ticks from reaching the digest.

Auth is **Bearer**, and GitHub *requires* a `User-Agent`. Both live in `request_args()`, which adds the `Authorization` header only when a token is set:

```php
$headers = [
	'Accept'     => 'application/vnd.github+json',
	'User-Agent' => self::USER_AGENT,
];
if ( '' !== $token ) {
	$headers['Authorization'] = 'Bearer ' . $token;
}
```

**A failed repo or endpoint contributes nothing and never throws.** `get_json()` returns `[]` on a `WP_Error`, a non-200, or a non-array body — the caller treats "no items" and "fetch failed" identically. One unreachable repo, one rate-limited endpoint, can't sink the whole batch. That's graceful degradation at the granularity of a single HTTP call.

### Linear — GraphQL, raw-token auth

[`Linear_Source_Node`](https://github.com/Automattic/newspack-intelligence/blob/v0.9.11/includes/class-linear-source-node.php) is a single GraphQL **POST**, behind a `$http_post` seam. `config()` returns just the token it resolves from the node's `vault_id`; `fetch()` short-circuits to `[]` when there's no token (no creds, nothing to do), then posts a fixed query:

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

Second, **a GraphQL 200 can still carry errors.** GraphQL returns HTTP 200 with a partial `data` plus an `errors` array; the connector tolerates that by walking `data.issues.nodes[]` defensively and emitting whatever issues did come back:

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

[`Feed_Source_Node`](https://github.com/Automattic/newspack-intelligence/blob/v0.9.11/includes/class-feed-source-node.php) reads any number of RSS/Atom URLs from `feeds`, GETs each (behind `$http_get`), and parses the body. The parse is the interesting part, because the input is **untrusted third-party XML**:

```php
$prev = \libxml_use_internal_errors( true );
// LIBXML_NONET: untrusted feed body — no SYSTEM ref may fetch a URL.
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
- **Atom.** Entries at `entry`, read through the Atom namespace (`children( self::ATOM_NS )->entry`); id prefers `<id>`, else the link. Body prefers `<summary>`, else `<content>`. And the link takes a walk of its own — an entry can carry several `<link rel="…">` elements, and you want the `rel="alternate"` (the human-readable page), not a leading `rel="self"`/`rel="edit"`:
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

## 4. Credentials in the Vault, config in the topology

Real sources need tokens, repo lists and feed URLs. **None of it goes on a WordPress Settings page** — the substrate already owns the credential surface (the **Vault**), and the topology already owns node config (the `:config` verbs).

![A credential's path in five hops. The operator adds an entry in the Vault tab through Vault_CI_Node: an id of 1 to 64 characters from [a-zA-Z0-9_-], an HTTPS url, and a username and password each capped silently at 256 bytes, the password sealed as $enc$ under a key derived from wp_salt( 'auth' ). It lands in the one non-autoloaded option, newspack_nodes_vault. The .tsl names only the id, with set_vault_id github. The node resolves it at config() time through the Vault_Secret trait, and gets '' when the id is blank or unknown. The token rides GitHub's Bearer header, Linear's raw Authorization header, or nothing for Feed. Side cards: list and get return only { id, url, auth_username, has_credentials }; an empty token throws nowhere; get_all() reads the option once per process until Config::RESET_ACTION or Vault::fresh() drops the memo; every non-secret value is a verb too.](img/wrp-vault-pointer.png)

### The Vault — where the operator enters the token

The Vault is the station's Vault tab (`admin.php?page=newspack-nodes-station&tab=vault`), a React surface under [`src/vault/`](../src/vault/) backed by [`Vault_CI_Node`](../includes/rest/class-vault-ci-node.php) and the `newspack_nodes_vault` option. An operator adds one entry per credential, and the token goes in the Basic-Auth `auth_password`. `Vault::validate_config()` requires an HTTPS `url` even for an entry that exists only to carry a token, so point it at the API root the token belongs to (`https://api.github.com`, `https://api.linear.app`); the connectors here read the password and nothing else. So the topology never sees a token; it sees a Vault entry **id** like `github`, `linear`, or `AI-proxy`.

### The topology references the entry; the node resolves it at `config()`

The seam on the node side is one verb, `set_vault_id`, that stashes the id, and a shared `Vault_Secret` trait that resolves it. From `Github_Source_Node`:

```php
/** `set_vault_id` verb handler — last-write-wins. */
public function set_vault_id( string $args ): string {
	$this->vault_id = \trim( $args );
	return 'ok';
}

/** @return array{repos:array<int,string>,token:string} */
protected function config(): array {
	return [
		'repos' => $this->repos,
		'token' => $this->resolve_vault_secret( $this->vault_id ),   // the id, opened at fetch time
	];
}
```

`resolve_vault_secret()` (the [`Vault_Secret`](https://github.com/Automattic/newspack-intelligence/blob/v0.9.11/includes/trait-vault-secret.php) trait, shared by both token-bearing sources and the LLM-config trait) is the entire resolution — and it fails *soft*, returning `''` whenever the id is blank, unknown, or the substrate Vault class isn't even loaded:

```php
protected function resolve_vault_secret( string $vault_id ): string {
	if ( '' === $vault_id || ! \class_exists( '\\Newspack_Nodes\\Vault' ) ) {
		return '';
	}
	$entry    = \Newspack_Nodes\Vault::get_instance()->get( $vault_id );
	$password = ( null !== $entry ) ? ( $entry['auth_password'] ?? null ) : null;
	return ( \is_string( $password ) && '' !== $password ) ? $password : '';
}
```

The verb's schema arg is typed `vault_id`, which the topology console renders as a **Vault-entry dropdown** rather than a free-text box, or as a text input while no entry exists:

```php
[
	'name'        => 'set_vault_id',
	'description' => 'Set the Vault entry ID to resolve the GitHub token from: <vault_id>.',
	'args'        => [
		[ 'name' => 'vault_id', 'type' => 'vault_id', 'required' => true ],
	],
	'handler'     => static fn ( Command_Interpreter_Node $interpreter, array $args ): string => self::cmd_set_vault_id( $interpreter, $args ),
],
```

A schema `handler` is a dispatch closure — it receives the pre-split **token array** `array $args` (`list<string>` argv), not a string. The static `cmd_set_vault_id` resolves the patron node and delegates the first token to the string instance method: `$patron->set_vault_id( Core::as_string( $args[0] ?? '' ) )`. The instance verb methods (`set_vault_id`, `add_repo`) each take a single `string` because each expects one scalar token — the array-to-scalar seam lives in the dispatch closure.

**`node_name` is the arg type that also draws.** `CtorField` renders it as a node picker the same way `vault_id` renders a Vault picker — §5's `add_snapshot_node digest` is the substrate's one use — but the name an operator picks is a *destination*, and `augmentWithVirtualEdges()` folds it onto the draft canvas as a dimmed **virtual edge**. That fold is what keeps the layout honest: a node wired only through a verb has no `connect_node` line, so without the virtual edge `autoLayout` reads it as an unwired source and pins it to column 0 instead of placing it downstream of its producer. The console draws the same kind of edge for any verb whose name matches `set_*target`, folded in as a **config-role** edge. Neither kind is clickable off the canvas, and the Inspector shows it as a chip with no clear control, pointing at the Verbs section instead. Removing an edge issues `disconnect_node`, which would leave the verb line that named the target standing. Retarget one by calling the verb again — with an empty argument to vacate it.

> **A one-property verb can skip the trio.** `Schema_Reflection` reads a `'toggle' => 'some_flag'` and then a `'setter' => 'vault_id'` before it looks for `handler`. Either names a property. `declared_setter()` synthesizes the handler — it coerces the first token and calls the patron's own `set_vault_id()` — and `dump_setters()` / `dump_toggles()` emit the round-trip line for every such verb in one call. A verb that assigns one value therefore needs no closure, no static `cmd_*`, and no per-verb branch in `dump_config()`. The connectors here spell all three out; [`Consumer_Node`](../includes/class-consumer-node.php)'s `set_multi_writer` is the substrate's example of the short route: one `'toggle' => 'multi_writer'` declaration, and a `dump_config()` that calls `dump_toggles()` without naming the verb. `add_repo` and `add_url` cannot take it: they *append* to a list rather than assign to a property, which is what their hand-written handlers buy. A declared verb can also opt *out* of the automatic line with `'dump' => false`, which `dump_declared()` honors for both keys — the escape hatch for a setting whose `dump_config()` fragment some other path already writes. `Consumer_Node`'s `set_line_mode` (§5) is the substrate's one case: `dump_time_travel_config()` owns that line because PAUSE parks the reader. Without the flag the value would land in the dump twice and be re-applied twice on replay.

### Repos and feeds are ordered verbs, not options

Each non-secret value is an append-only `:config` verb, stored on the node and dumped back out round-trippably. GitHub's repo list is `add_repo`, read straight off the node in `config()`:

```php
public function add_repo( string $args ): string {
	$repo = \trim( $args );
	if ( '' === $repo ) {
		return 'error: add_repo requires <owner/name>';
	}
	$this->repos[] = $repo;
	return 'ok';
}
```

You set these in the topology console, or as `cmd <node>:config …` lines in the `.tsl` (shown in §5). Because every verb also round-trips through `dump_config()`, the console can serialize a live graph back to a topology that re-applies each verb in order. `config_line()` writes the canonical spelling, `command_node`; `cmd` and `command` are its aliases, and the shipped `.tsl` files use `cmd`.

> **The React dashboard is separate.** The Vault tab is *credentials in*. The **Publisher Insights** dashboard (the React mount on its own admin menu, served by `Insights_CI`) is *insights out* — and it's a whole other build story (the `@newspack-nodes/shared` alias, esbuild, jest). That's [writing-a-real-dashboard.md](writing-a-real-dashboard.md), not this guide. This guide stops at a headless, Vault-fed pipeline.

---

## 5. Wiring real sources into the topology

The production topology is the toy one with real source nodes swapped in, the durable **ingest** buffer added at the front, and the scored/durable middle behind it. The sources fan into the `ingest` partition (not the summarizer); a consumer paces `ingest` through the enrich; each source also carries its `:config` verbs inline. Below, three stage files are flattened into one block and trimmed to the shape: `newspack-intelligence-ingest.tsl` down to the ingest partition, `-summary.tsl` through the scored partition, then `-digest.tsl`. In the repo each stage carries its own `connect_node` lines and closes with `secure`. The `-gate.tsl` observer is left out; §0 sketches it.

```
make_node Github_Source  github
cmd github:config set_vault_id github
cmd github:config add_repo Automattic/newspack-plugin

make_node Linear_Source  linear
cmd linear:config set_vault_id linear

make_node Feed_Source    feed
cmd feed:config add_url https://wordpress.org/news/feed/

# ingest: raw fetched items buffer between the bursty sources and the LLM summarizer,
# so a TICK never makes an LLM call and the per-item enrich is paced by the consumer.
make_node Partition ingest:partition <config:logs_dir>/ingest.p<partition> <config:segment_size> <config:min_segments> <config:num_segments> <config:max_segments> <config:min_lifetime> <config:lifetime>
cmd ingest:partition:config void_warranty

make_node Consumer   ingest:consumer <config:logs_dir>/ingest.p<partition> <config:offsets_dir>/ingest.p<partition> <config:deadletter_dir>/ingest.p<partition>
cmd ingest:consumer:config set_line_mode true
make_node Summarizer summarizer
make_node Scorer     scorer
make_node Partition  scored:partition <config:logs_dir>/scored.p<partition> <config:segment_size> <config:min_segments> <config:num_segments> <config:max_segments> <config:min_lifetime> <config:lifetime>
cmd scored:partition:config void_warranty

make_node Consumer scored:consumer <config:logs_dir>/scored.p<partition> <config:offsets_dir>/scored.p<partition> …
# Co-commit the digest's save_state() into the consumer's offsetlog on every checkpoint,
# so a respawned worker restores the accumulator in lockstep with the cursor.
cmd scored:consumer:config add_snapshot_node digest
cmd scored:consumer:config set_line_mode true
# Two args: the scored Partition to nudge on RESET, then the progress denominator
# (done/total), which MUST equal the number of sources that will report DONE.
make_node Digest_Builder digest scored:partition 3
cmd digest:config set_vault_id AI-proxy
cmd digest:config set_model gpt-oss-120b
make_node Tee digest:tee
make_node Log digest:log <config:logs_dir>/digest.md 1 2 7 0 0 0
cmd digest:log:config void_warranty

connect_node github          ingest:partition
connect_node linear          ingest:partition
connect_node feed            ingest:partition
connect_node ingest:consumer summarizer
connect_node summarizer      scorer
connect_node scorer          scored:partition
connect_node scored:consumer digest
connect_node digest          digest:tee
connect_node digest:tee      digest:log
```

Those `<config:…>` tokens are resolved before the node ever sees them. [`Config::register_token_namespace()`](../includes/class-config.php) registers the `config` namespace at boot; [`Topology_Loader`](../includes/class-topology-loader.php) binds `<partition>` and `<topology>`, then runs the file through a `Shell`, whose interpolation replaces every `<ns:key>` and every bare `<var>`. A `make_node` line therefore reaches the node with plain strings, which is how a `Partition` can name its whole retention policy without hard-coding a number.

The same token syntax works in a `node_schema()` argument **default** — every retention argument on `Log_Node` and `Partition_Node` declares one — but it gets there by a different route: a default lives in PHP and never passes through the Shell, so `Schema_Reflection::parse_schema_args()` resolves it itself, strictly (an unresolvable token throws rather than silently becoming `''`). Omit a positional argument and you get the runtime's configured value; supply one and it wins. `digest:log`'s `1 2 7 0 0 0` is the other extreme, every retention knob spelled out: a `segment_size` of 1 rotates before every write, so each composed draft lands in a segment of its own and `num_segments 7` keeps the last seven.

Three sources, one partition, one wire each — fan-in needs no special node, just like Ben's community source, except the shared target is now a durable log. **Why the partition sits between the sources and the summarizer:** a source TICK is a fetch-and-append whose cost scales with the number of ENDPOINTS — three calls per GitHub repo, one per feed, one for Linear — where an inline enrich would cost one blocking LLM call per ITEM fetched. The `ingest:consumer` feeds the summarizer and scorer one item at a time instead, spreading that enrich across drain cycles. `set_line_mode true` is what buys that pacing, as the diagram below draws. `void_warranty` lifts the partition's 4 KB PIPE_BUF write cap ([ADR-4](architecture-decisions.md#adr-4-pipe_buf-atomic-writes)) because a raw item can exceed it.

**An unconfigured source yields no items**, only its closing `DONE`, so activation is safe before the credentials land: the shipped `.tsl` already carries the repo and feed verbs, and the Vault entries are the one thing a fresh install lacks.

### There is no manual FLUSH — the digest auto-composes on `DONE`

Unlike the toy, the real digest is **not** flushed by hand. Each source ends its TICK with a terminal `DONE` (§2); the digest counts the *distinct* sources that have reported and composes + writes `digest:log` automatically once every source is in:

![A sequence across five lanes: Collect, Sources, the ingest log and consumer, the enrich stage and scored log, and the Digest. One Collect sends request_node digest RESET, which empties items, seen and reported and appends a throwaway TM_INFO 'RESET' to scored:partition so the next checkpoint co-commits the emptied snapshot, then a TICK to github, linear and feed. Each source appends its items and a DONE to ingest:partition; ingest:consumer forwards one record per event cycle in line mode and prepends its name to FROM; the summarizer and scorer forward TM_INFO untouched, so DONE stays behind its items; scored:consumer prepends its name again, so the digest reads scored:consumer/ingest:consumer/github. The digest marks reported[ FROM ] and composes the draft through digest:tee into digest:log once count( reported ) reaches the literal 3 on its make_node line.](img/wrp-done-to-compose.png)

```php
// Digest_Builder_Node::handle_info() — a DONE from each distinct source; compose when all in.
if ( "DONE\n" === $value ) {
	$from                    = \is_string( $message[ Message::FROM ] ?? null ) ? $message[ Message::FROM ] : '';
	$this->reported[ $from ] = true;
	if ( \count( $this->reported ) >= $this->total ) {
		$this->compose_draft();
	}
}
```

So driving it by hand is a **RESET, then a TICK per source** — the dashboard's *Collect* button does exactly this:

```
> request_node digest RESET        # empty the accumulator, zero the per-cycle DONE tally
> request_node github TICK
> request_node linear TICK
> request_node feed   TICK
# …the third DONE reaches the digest and it composes + writes digest:log automatically.
```

---

## 6. Ship & operate it

A real plugin lives in its own repo and installs on a site that already has the substrate. The [§8 essentials](writing-a-plugin.md#8-ship-it--the-essential-rigging) from the toy guide all apply (`Requires Plugins: newspack-nodes`, the deferred `plugins_loaded` loader, the test bootstrap, phpcs/phpstan, the release workflow). Here are the operational gotchas specific to taking *this* plugin live.

**Deploy installs a prebuilt zip — build first.** A deploy installs the `release/*.zip` that is already there; it does **not** build one. So the loop is *build, then deploy*:

```bash
npm run release:archive    # builds release/<plugin>.zip
# …then install that zip however this site installs plugins.
```

Skip the build and your live `wp nodes` runs the *old* code — and because the PHPUnit suite runs from the source tree, not the installed copy, the tests won't catch the stale deploy.

**After adding node classes, regenerate the autoloader.** `make_node` resolves a type token by name — `{$prefix}{$type}_Node` against the registered namespace prefixes ([ADR-10](architecture-decisions.md#adr-10-class-naming--make_node-namespace-resolution)) — so the class has only to be *loadable*, which under a classmap autoloader means present in the map. `Classes_CI` reads that same map to populate the console palette. After adding or renaming a node run `composer build:autoloaders` (= `composer install --optimize-autoloader`) or `composer dump-autoload -o`; skip it and the class is missing from the palette and unresolvable to `make_node`, with nothing else wrong. The release zip is already optimized, so a freshly-built zip needs no separate dump.

**Swapping the plugin's files takes the fleet DOWN, not a restart.** A running
worker holds the old class in its PHP process for the rest of its ~595-second
lifespan ([ADR-8](architecture-decisions.md#adr-8-worker-zombie-pattern)), so new
code needs a refresh either way. But overwriting `includes/` underneath a live
worker makes its autoloader fail on the plugin's own classes, and the consumer
quarantines whatever was in flight as poison. Hold the fleet down across the
install instead:

```bash
wp nodes stop && <install the zip> && wp nodes start
```

`wp nodes stop` sets the hold, flags every live worker, and blocks until the
last lock dir is gone and no spawn is still in flight — `--timeout` seconds, 90
by default. The in-flight half is what keeps `stop` from reporting success into
a gap: a worker that released its lock and POSTed its own respawn just before
the hold landed holds no lock dir at all while it boots. If the wait expires,
`stop` exits non-zero and names the stragglers, so the `&&` chain never lands
the install on a live process. `wp nodes restart all` is the lighter tool
for the case where the files are already in place — after activating a second
provider plugin, say.

Run these as the worker's OS user — the same account the web server runs as, not
root. [`Config::assert_private_to_us()`](../includes/class-config.php) refuses a runtime tree owned by another
non-root uid outright, and only warns for root, because root's hazard runs the
other way: the files it leaves behind are root-owned, and the web-user worker
cannot write them.

Every worker that comes back gets a fresh WordPress bootstrap, rebuilding its
process-local topology catalog from the complete provider set. Bring the fleet
back only after every provider is in place: a worker born while a provider's
plugin directory was temporarily absent stays blind to it until its natural
turnover.

**Topologies register, but you activate them.** `register_plugin()` (in the bootstrap) makes every `.tsl` in `topologies/` a *catalog* entry; only a topology in the *active* set is spawned. Activate the aggregator — it `include`s the four stage files, so they need no activation of their own — from the station's Overview or Topologies tab, which share one control cluster, or from the CLI, then confirm:

```bash
wp nodes activate <plugin-topology>
wp nodes status
#   <plugin-topology>.p0  live  3s ago  2m 10s
```

Activate the aggregator *or* the stages, never both. [`Topology_Analyzer::find_conflicts()`](../includes/class-topology-analyzer.php) runs on every activation and refuses two active topologies whose write sets overlap. A partition both declare with the identical `make_node` line is tolerated as a deliberate multi-writer log — but not these two: `ingest:partition` and `scored:partition` each lift the write cap with `void_warranty`, and a lifted cap assumes a sole writer. Offsetlogs never share at all, so the consumers collide whatever the cap does. Running one stage as its own fleet therefore means deactivating the aggregator first.

**The analyzer classifies a node by class LINEAGE, not by its `make_node` token.** `Topology_Analyzer` resolves each token through `Command_Interpreter_Node::resolve_class()` and tests descent, most-derived first (`Log_Node` before `Partition_Node`, which it extends). So *your* `Partition_Node` or `Topic_Node` subclass lands in the write set on lineage alone, however unfamiliar its token reads — gated by `find_conflicts()`, and spared by the `wp nodes gc` sweep as a declared dir — and your `Consumer_Node` subclass appears in `consumer_positions()`, which is what pairs an on-demand worker with the log whose growth should wake it. All that costs is the namespace `register_plugin()` already registers; where no namespace resolves yet, a fallback matches `<token>_Node` against the base class's own short name, which is how the stock tokens answer before boot wiring completes. The footgun is a node that writes a log *without* descending from one of those classes: it is invisible to every one of those passes, and the sweep takes its directory. Declare its path template through the `newspack_nodes/registered_log_producers` filter instead.

**Tests are hermetic — no network.** The closure-HTTP seam is what buys that: a test sets `$http_get` or `$http_post` to return a canned body, so nothing leaves the box.

```bash
cd tests && ../vendor/bin/phpunit
```

Lint to the same bar as the substrate. `npm run lint:php` runs phpcs (VIP Go) and then the comment-length gate; `npm run lint:phpstan` runs [`phpstan-deadcode.neon`](https://github.com/Automattic/newspack-intelligence/blob/v0.9.11/phpstan-deadcode.neon), which includes the level-10 + strict-rules config and adds the ShipMonk dead-code overlay. Read a dead-code finding skeptically: this is an application on a substrate the analysis cannot see, so `fill()`, `arguments()`, `node_schema()` and the rest of the Node contract read as dead here and are not — the config names those exemptions rather than muting the rule, and anything outside the list is a real finding.

**Release the substrate before the plugin that pins it.** A consumer importing an `@newspack-nodes/*` alias checks the substrate out in CI at a literal tag — `ref: v2.55.2` in [`.github/workflows/release.yml`](https://github.com/Automattic/newspack-intelligence/blob/v0.9.11/.github/workflows/release.yml), feeding `NEWSPACK_NODES_SRC` — while a local build resolves the same alias to your working tree. When the two disagree the build still succeeds, so **a green Release workflow proves nothing about which substrate got bundled.** Tag the substrate first, let `scripts/bump-version.sh` rewrite the pin (it refuses a substrate version with no local tag), then verify the published asset: download the release zip and `diff -rq` its `build/` against your local one. Identical bytes means the pin was right.

**The pin is not the floor.** Two version numbers relate a consumer to the substrate and answer different questions. The `ref:` pin decides which substrate SOURCE a CI build bundles; the `Bootstrap::version_at_least()` call in the deferred loader ([the toy guide's §8a](writing-a-plugin.md#a-depend-on-the-substrate--declare-it-defer-your-wiring)) decides which INSTALLED substrate the plugin will run against, going dormant behind an admin notice below it. They move independently, and a pin several tags ahead of the floor is the normal state: intelligence pins v2.55.2 and floors at 2.53.0.

---

## 7. Recap — what you added vs. what the substrate still gave you

The toy guide's punchline was *Ana and Ben never met* — capability added by wiring a node, not editing a system. Going real didn't change that bet; it cashed it in.

You added three real classes — `Github_Source_Node`, `Linear_Source_Node`, `Feed_Source_Node` — and each one supplies only `config()`, `fetch()`, its `:config` verb handlers, the `dump_config()` lines those verbs round-trip through, and a `node_schema()` built from the shared `source_schema()`, because the **`Source_Node`** base absorbs every connector concern the toy copies per source: the TICK trigger, the bounded dedup set, the fire-and-forget emit, and the shared `normalize_item()` that flattens three unrelated payloads into one item shape. You added a `Source` interface to name the seam, a closure-HTTP seam per connector so the network-touching code runs under coverage, and a `set_vault_id` pointer into the substrate's Vault so the two token-bearing connectors have credentials to fetch with.

And here's what you **still** never touched. The summarizer, the scorer, the digest builder — none of them learned the items stopped being canned; they consume `{ source, id, title, url, body, timestamp }` exactly as before. The router, the worker lifecycle, fleet revival, the topology console, the Vault credential store, the offsetlog snapshot in the durable middle — all reused. The connectors dropped into a graph full of pieces they've never seen, because they upheld the one contract: a message arrives at `fill()`, you do your work, you forward it to your sink.

That was the short hop the toy guide promised: `items()` becomes `fetch()`. It turned out to be two method bodies of *intent* wrapped in a base class of *plumbing*, a Vault-backed credential pointer, and a test seam. The intent was small. The plumbing is what the substrate lets you write once and stop thinking about.

---

## Where to go next

- **[writing-a-plugin.md](writing-a-plugin.md)** — the toy walkthrough this guide extends (re-read §7–9 with the real code in mind).
- **[writing-a-real-dashboard.md](writing-a-real-dashboard.md)** — this guide's sibling: the production console/dashboard surfaces (palette vs inspector, measured transcript ceilings, the icons build gotcha) and the *insights out* half §4 deferred.
- **[writing-a-dashboard.md](writing-a-dashboard.md)** — the toy Publisher Insights React dashboard walkthrough.
- **[architecture-guide.md](architecture-guide.md)** — the full model: drain loop, partitions, workers, fleet revival, the REPL.
- **[architecture-decisions.md](architecture-decisions.md)** — the six ADRs this guide leans on (ADR-1 uniform `fill()`, ADR-3 fire-and-forget, ADR-4 PIPE_BUF, ADR-8 worker zombie, ADR-10 `make_node` namespace resolution, ADR-11 `make_node` construction).
- **[`newspack-intelligence`](https://github.com/Automattic/newspack-intelligence)** — the complete production plugin: `includes/`, the aggregator and four stage `.tsl` files under `topologies/`, the PHPUnit suite.
