# Writing a *Real* Nodes Plugin

You've finished [writing-a-plugin.md](writing-a-plugin.md). You built the toy AI-newsletter — two canned sources, a template summarizer, a markdown digest — watched items flow through `fill()`, turned the by-hand session into a topology, and stood it up as a live worker. That guide's **§7, "Make it real — the short hop"**, promised the production version is two method bodies away:

```php
// toy
protected function items(): array { return [ /* canned */ ]; }
// real (sketch)
protected function items(): array { return My_Github_Source::recent_releases(); }
```

That promise is true at the level of the *contract* — the summarizer and digest never learn the items stopped being canned. But "swap one method body" hand-waves a lot: real fetches block on the network, fail halfway, return duplicate items every tick, and need credentials an operator stores in the substrate's Vault. This guide is the deep dive. It walks the actual production plugin, **`newspack-intelligence`** (the sibling repo, not the bundled `examples/example-ai-newsletter` toy), and shows everything that sits *on top of* the toy to take it live.

The shape is unchanged — three sources fan into a durable `ingest` partition, a consumer paces them through a summarizer, a scorer, and a second durable partition, and a final consumer feeds a digest builder. What changed is everything around the seam: a `Source` interface, a shared abstract base that owns the connector plumbing, three real connectors (GitHub, Linear, RSS/Atom), credentials kept in the substrate's **Vault** and referenced from the topology, and a test seam that lets all of it run under coverage without touching the network.

> **The one thing to hold onto (still):** every node has one entry point, `fill( array $message ): void`. Nothing below changes that. The real connectors are *more code* than the toy, but they're the same node — they still mint a `TM_STRUCT` per item and forward to their sink. Everything new lives behind `fetch()`, which `fill()` calls and the graph never sees.

The finished code is in the sibling [`newspack-intelligence`](https://github.com/Automattic/newspack-intelligence) repo. Read along, or diff it against the toy.

---

## 0. What changed — the same graph, real ends

The toy graph and the real graph are the same boxes and arrows, plus a durable **ingest** layer the toy didn't need. (The toy's scorer and its `scored` partition arrive in [writing-a-dashboard.md](writing-a-dashboard.md) §1, so the bundled example already carries them.) Here's the production topology:

```
github ┐
linear ┼─ ingest:partition                                 (durable raw-item log)
feed   ┘
ingest:consumer ─ summarizer ─ scorer ─ scored:partition   (durable `scored` log)
scored:consumer ─ digest ─ digest:tee ─ digest:log
gate:consumer ─ gate ─ gate:tojson ─ gate:log              (observer, own cursor)
```

It ships as five `.tsl` files, not one. `topologies/newspack-intelligence.tsl` is an aggregator that `include`s a file per stage — `-ingest`, `-summary`, `-digest`, and `-gate`. `register_plugin()` catalogs *every* `.tsl` in `topologies/`, so a stage can be activated alone and run as its own fleet — instead of the aggregator, never alongside it ([§6](#6-ship--operate-it)). Each file declares `var num_partitions = 1`, `include`s `topic-probe`, and closes with `secure`, which climbs the security ratchet one level: at level 1 `make_node` is refused, so the built graph can no longer be rebuilt from the wire. A `secure` line inside an *included* file is skipped — `Shell_Node::declares_secure_level()` drops it — so only the topology being loaded decides the process level. Without that skip the first stage's `secure` would refuse every `make_node` in the three stages behind it. The aggregator also restates the resident default, `var on_demand_idle = 0`; a stage meant to sleep between collects would raise it.

Three connector **sources** fan into the `ingest` partition (fan-in, exactly as Ben's community source fanned into the summarizer in the toy — the target is a partition now, not the summarizer). What's genuinely new from the toy's perspective is concentrated at the two ends, plus that new partition in the middle:

- **The source end.** The toy's `items()` returns a literal array. The real sources `fetch()` over HTTP and normalize wildly different payloads (GitHub REST, Linear GraphQL, RSS/Atom XML) into one item shape; their shared base then drops anything it has emitted before.
- **The credentials.** Two of the three sources take a token: Linear's `fetch()` returns `[]` without one, and GitHub sends its `Authorization` header only when one is set. The secret lives in the substrate's **Vault** (the devtools-hub's *Vault* tab), and the topology carries only a *pointer* to it — a `set_vault_id <id>` verb on the node's `.tsl` line, resolved to the raw secret at `config()`. The rest of a source's config is topology verbs too (`add_repo`, `add_url`, `set_model`, …). None of that config lives in a Settings page or an options row.
- **The ingest partition.** A source TICK writes raw items to a durable log and stops there — no per-item LLM call on the collect path. The `ingest:consumer` then paces those items through the blocking summarizer and scorer one item per event cycle, spreading the enrich across drain cycles. The partition is the buffer between the bursty sources and the slow enrich.

The middle — summarizer, scorer, the two partitions, consumers, digest — is its own story (the LLM seam, the durable `scored` log, the snapshot co-commit), and so is the gate observer hanging off `ingest`. This guide stays at the source end, the ingest buffer, and the credentials, because that's the part the toy guide explicitly deferred. We'll write it in the order you'd discover it: the contract first, then the base that implements it, then the three connectors, then the credentials that feed them, then wiring and ship.

---

## 1. The Source interface + the closure-HTTP test seam

The toy's "seam" was a `protected function items(): array` you'd override. That's fine for canned data. Real connectors promote the seam to a named contract — an interface — so the abstract base can depend on it and every connector is forced to honor it.

`includes/interface-source.php`:

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

**Why a closure property and not a `protected function http_get()` you override in a test subclass?** Coverage. The standing rule across these plugins is the static `\Closure` property form, never the protected-helper-with-subclass-override form. A test reassigns `Github_Source_Node::$http_get = fn( $url, $args ) => [ 'response' => [ 'code' => 200 ], 'body' => $canned_json ];` and substitutes *only* the transport call — header assembly, the `is_wp_error` branch, the non-200 branch, `json_decode`, and the whole per-endpoint normalization then run as **real production code under coverage**. A subclass override would mark `http_get()` covered while the production body — where the bugs live — never executed in any test. The seam replaces the side effect and exercises everything around it.

> **Fetches block — and that's fine.** `wp_remote_get` with a 15-second timeout is a synchronous, blocking call; so is the Linear GraphQL POST. In a web request that would be unacceptable. But connector fetches don't run in a web request — they run inside a background **worker** process (that's why the file carries `phpcs:ignore` notes for the VIP remote-request rules: *"connector fetches run in a background worker, not a VIP web request"*). The same reasoning licenses the LLM calls downstream. Blocking is acceptable here precisely because the worker is the isolation boundary.

---

## 2. The `Source_Node` abstract base — the uniform connector

In the toy, *every* source hand-rolls its own `fill()` and its own `handle_request()` — Ana's releases source and Ben's community source are near-identical copies. That's fine for two canned sources in a tutorial. For three real connectors that all need TICK handling, dedup, fire-and-forget emit, and normalization, copying that boilerplate three times is how drift creeps in. All of it therefore lives in one abstract base, `Source_Node`, leaving each connector only the two things that genuinely differ.

`includes/class-source-node.php`:

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

That constructor is what makes §4's `cmd github:config set_vault_id …` lines work. `Schema_Reflection::auto_wire_interpreter()` reads `node_schema()['commands']` and mounts a sibling `Command_Interpreter_Node` named `{node}:config`, so every connector gets its config verbs without wiring one by hand ([ADR-11](architecture-decisions.md#adr-11-make_node-construction-sequence)).

The base owns four things the toy duplicates:

**TICK handling.** `fill()` branches on `TM_REQUEST` and calls `handle_request()` — once, in the base. Unlike the toy, the production source sends no `{ emitted }` reply to its caller. It closes every TICK with a terminal `DONE` instead, which travels *downstream* to the digest rather than back to whoever ticked it — see below.

**Dedup by item `id`, then a terminal `DONE`.** A real source is TICKed over and over — the dashboard's *Collect* button, or `request_node github TICK` by hand — and every TICK re-fetches the same window, which would re-emit items the digest already has. So the base keeps a bounded `$seen` set and drops anything it's emitted before — then, in a `finally`, emits one `TM_INFO` `DONE` so the digest can count collection progress (§5 spells out the auto-compose it drives):

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

`fetch()` is synchronous, so the `DONE` is minted *after* every item this TICK produced; being an ordinary message, it then rides the same ingest-to-scored-to-digest path in order and reaches the digest behind all the items it follows. Every transform on that path forwards it untouched — `Summarizer_Node::fill()` and `Scorer_Node::fill()` each branch on `TM_INFO` before their `TM_STRUCT` work — so a transform that dropped what it did not recognize would strand the compose. Each Consumer along the way prepends its own name to `FROM` (`Node::stamp_message()`), so what the digest actually reads is `scored:consumer/ingest:consumer/github` rather than the bare `github`: still one distinct key per source, but not a name you can compare against.

An item with no string `id` is skipped: no id means no dedup key, and the contract requires one. The set is capped at `MAX_SEEN = 2000` and evicts oldest-first with `array_slice`, so a worker that ticks all through its ten-minute life holds at most 2000 ids.

The set is also **in-memory only, and does not survive a respawn** — a fresh worker re-emits whatever its next fetch still returns. That is deliberate rather than a hole: `Digest_Builder_Node` dedups on the same `id`, so the digest stays correct, and only the summarize and score stages upstream of it pay for the repeat. A TICK-driven source has no Consumer offsetlog to co-commit a snapshot into, which is why the `add_snapshot_node` route the digest uses is unavailable here.

**Fire-and-forget emit.** Each new item goes out via `parent::fill( $response )` — the emit pattern from §2 of the toy guide: build the message, let the base `Node::fill()` stamp `TO` from the `connect_node`-wired target and forward to the sink. No reply, no `TM_PERSIST` ack ([ADR-3](architecture-decisions.md#adr-3-fire-and-forget-messaging)); the single-threaded drain is the backpressure.

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

That's the **item contract**: `{ source, id, title, url, body, timestamp }`. The final `id` is namespaced `"$source:$id"` so a GitHub `#release-5` and a Linear `ENG-5` never collide in the dedup set; the bare `$id` each connector passes must already be stable per item, because that's what dedup keys on. A date string that won't parse becomes `timestamp 0` rather than throwing.

`source_schema()` builds each connector's `node_schema()` from one shared shape — category `Source`, one `TICK` request, and `accepts_fill` false, because a source mints messages and never consumes them — so the connectors don't restate it:

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

`Source_Node` is `abstract` and declares no `node_schema()` of its own. `make_node Source` — the token that would resolve to it — returns `null` rather than fataling, because `resolve_class()` skips an abstract match and keeps scanning the remaining namespaces. Each concrete connector calls `source_schema()` and adds its own verbs.

This is the uniform-`fill()` contract ([ADR-1](architecture-decisions.md#adr-1-uniform-fill-contract)) taken one level up from the toy. In the toy each node hand-rolls `fill()`. Here a whole *category* of nodes — connectors — shares one implementation of the contract, and a new connector implements just the two abstract seams, `fetch()` and `config()`. The base is the connector; the subclass is the wiring to a specific API.

---

## 3. The three real connectors

Three APIs, three payload shapes, two auth schemes and one connector that needs none. Each subclass is small because the base does the heavy lifting — each adds only `config()`, `fetch()`, its verb handlers, the `dump_config()` lines those verbs round-trip through, and a `source_schema()`-based `node_schema()`.

### GitHub — three endpoints, per-endpoint isolation

`Github_Source_Node` pulls **Releases**, **Merged PRs**, and **Issues** across every repo registered via `add_repo`. `config()` returns the repo list plus the token it resolves from the node's `vault_id`; `fetch()` loops the repos:

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

`Linear_Source_Node` is a single GraphQL **POST**, behind a `$http_post` seam. `config()` returns just the token it resolves from the node's `vault_id`; `fetch()` short-circuits to `[]` when there's no token (no creds, nothing to do), then posts a fixed query:

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

`Feed_Source_Node` reads any number of RSS/Atom URLs from `feeds`, GETs each (behind `$http_get`), and parses the body. The parse is the interesting part, because the input is **untrusted third-party XML**:

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

Real sources need tokens, repo lists and feed URLs. **None of it goes on a WordPress Settings page** — the substrate already owns the credential surface (the **Vault**), and the topology already owns node config (the `:config` verbs). The plugin does register one Settings submenu, and it is a useful contrast: `Clients_Settings` takes a CSV upload of the publisher master, which is *application data an administrator uploads*, not runtime configuration. The split is deliberate:

- **The secret lives in the Vault** — server-side, entered once by an operator, never written into the topology or any plugin option in plaintext.
- **The topology holds only a *pointer* to it** — a `set_vault_id <id>` verb on the source's `.tsl` line. The node resolves that id to the raw secret at `config()` time.
- **Everything non-secret is a `:config` verb too** — `add_repo`, `add_url`, `set_api_url`, `set_model`, `set_feature`, `add_profile`. Ordered, round-trippable, no options table.

### The Vault — where the operator enters the token

The Vault is a real tab in the devtools hub (`admin.php?page=newspack-nodes-hub&tab=vault`), a React surface under `newspack-nodes/src/vault/` backed by `Vault_CI_Node` and the `newspack_nodes_vault` option. An operator adds one entry per credential — an `id`, a `url`, and a Basic-Auth `auth_username` / `auth_password` pair; the token goes in `auth_password`. `Vault::validate_config()` requires the `url` and refuses anything that is not HTTPS, even for an entry that exists only to carry a token, so point it at the API root the token belongs to (`https://api.github.com`, `https://api.linear.app`); the connectors here read the password and nothing else. It sanitizes both credential fields — the username through `sanitize_text_field()`, the password through a control-character strip — and then caps each at **256 bytes**, silently: `add()` and `update()` still return true, and the entry seals the truncated value. A token longer than that stores broken, and the only symptom is a 401 from the far side. The `list`/`get` verbs return only the **public shape** — `{ id, url, auth_username, has_credentials, is_config }` — so the SECRET never leaves the server, not even to the dashboard that manages it. The username does: it is half an address rather than a secret, and the Edit form cannot offer to change what it cannot show.

```php
// Vault_CI_Node::public_shape() — the password is computed away, never returned.
return [
	'id'              => $id,
	'url'             => Core::as_string( $config['url'] ?? '' ),
	'auth_username'   => Core::as_string( $config['auth_username'] ?? '' ),
	'has_credentials' => ! empty( $config['auth_username'] ) && ! empty( $config['auth_password'] ),
	'is_config'       => $registry->is_config_server( $id ),
];
```

That projection holds only while every Vault verb gates at `manage`. Declaring one of them `read` would put `auth_username` in front of a role that cannot otherwise open the store, so the username's exemption is a consequence of the gate, not a property of the field.

So the topology never sees a token; it sees a Vault entry **id** like `github`, `linear`, or `AI-proxy`.

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

`resolve_vault_secret()` (the `Vault_Secret` trait, shared by both token-bearing sources and the LLM-config trait) is the entire resolution — and it fails *soft*, returning `''` whenever the id is blank, unknown, or the substrate Vault class isn't even loaded:

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

That soft failure is what makes an unconfigured source harmless. Each connector then decides what an empty token means: `Linear_Source_Node::fetch()` returns `[]` before it builds a request, so its TICK is a silent no-op, while `Github_Source_Node::request_args()` simply omits the `Authorization` header and fetches unauthenticated. Neither throws, and neither needs an operator to have visited the Vault first (§5).

`get_instance()` is the right accessor here because `get_all()` memoizes the merged, decrypted registry for the life of the process: a resident worker opens the option and the config file once and resolves every later `config()` from memory. Two things drop that memo. The first is `Config::RESET_ACTION`, the config-reload signal `Vault::reset()` is wired to at boot, and it is how a rotated credential reaches a worker that would otherwise serve the old one until it recycles. The second is `Vault::fresh()` — the same singleton with its memo already dropped, for a *request-scope* reader like the service CIs that writes an entry and reads it back inside one request. Code that writes the Vault and reads it in one pass must call `fresh()`, or it reads its own stale answer.

The verb also carries a typed schema arg, `type: 'vault_id'` — that type is what makes the topology console render a **Vault-entry dropdown** for the field instead of a free-text box, so an operator picks an existing entry rather than typing a raw id. (With no entries registered yet it falls back to a text input, so a fresh install isn't a dead end.)

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

> **A one-property verb can skip the trio.** `Schema_Reflection` reads a `'toggle' => 'some_flag'` and then a `'setter' => 'vault_id'` before it looks for `handler`. Either names a property. `declared_setter()` synthesizes the handler — it coerces the first token and calls the patron's own `set_vault_id()` — and `dump_setters()` / `dump_toggles()` emit the round-trip line for every such verb in one call. A verb that assigns one value therefore needs no closure, no static `cmd_*`, and no per-verb branch in `dump_config()`. The connectors here spell all three out; `Consumer_Node`'s `set_multi_writer` is the substrate's example of the short route: one `'toggle' => 'multi_writer'` declaration, and a `dump_config()` that calls `dump_toggles()` without naming the verb. `add_repo` and `add_url` cannot take it: they *append* to a list rather than assign to a property, which is what their hand-written handlers buy. A declared verb can also opt *out* of the automatic line with `'dump' => false`, which `dump_declared()` honors for both keys — the escape hatch for a setting whose `dump_config()` fragment some other path already writes. `Consumer_Node`'s `set_line_mode` (§5) is the substrate's one case: `dump_time_travel_config()` owns that line because PAUSE parks the reader. Without the flag the value would land in the dump twice and be re-applied twice on replay.

### Repos and feeds are ordered verbs, not options

The non-secret config follows the same pattern — each value is an append-only `:config` verb, stored on the node and dumped back out round-trippably. GitHub's repo list is `add_repo` (`multiple: true`), read straight off the node in `config()`; the Feed source's URLs are `add_url`; the LLM nodes take `set_api_url` / `set_model` / `set_feature` / `add_profile`. There is no `github_repos` or `linear_token` option anywhere — the repos come from repeated `add_repo` verbs, and the Linear token is a Vault entry reached via `set_vault_id`:

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

Those `<config:…>` tokens are resolved before the node ever sees them. `Config::register_token_namespace()` registers the `config` namespace at boot; `Topology_Loader` binds `<partition>` and `<topology>`, then runs the file through a `Shell`, whose interpolation replaces every `<ns:key>` and every bare `<var>`. A `make_node` line therefore reaches the node with plain strings, which is how a `Partition` can name its whole retention policy without hard-coding a number.

The same token syntax works in a `node_schema()` argument **default** — every retention argument on `Log_Node` and `Partition_Node` declares one — but it gets there by a different route: a default lives in PHP and never passes through the Shell, so `Schema_Reflection::parse_schema_args()` resolves it itself, strictly (an unresolvable token throws rather than silently becoming `''`). Omit a positional argument and you get the runtime's configured value; supply one and it wins. `digest:log`'s `1 2 7 0 0 0` is the other extreme, every retention knob spelled out: a `segment_size` of 1 rotates before every write, so each composed draft lands in a segment of its own and `num_segments 7` keeps the last seven.

Three sources, one partition, one wire each — fan-in needs no special node, just like Ben's community source, except the shared target is now a durable log. **Why the partition sits between the sources and the summarizer:** a source TICK is a fetch-and-append whose cost scales with the number of ENDPOINTS — three calls per GitHub repo, one per feed, one for Linear — where an inline enrich would cost one blocking LLM call per ITEM fetched. The `ingest:consumer` feeds the summarizer and scorer one item at a time instead, spreading that enrich across drain cycles. `set_line_mode true` is what buys the pacing: the drain forwards at most one record per event cycle and skips its buffer top-up on any cycle that forwarded one, so a slow LLM call holds up the next item rather than a whole 64 KB block of them. `void_warranty` lifts the partition's 4 KB PIPE_BUF write cap ([ADR-4](architecture-decisions.md#adr-4-pipe_buf-atomic-writes)) because a raw item can exceed it.

The other difference at the source end is that **an unconfigured source yields no items** — only its closing `DONE` — so activation is safe before the credentials land. The shipped `.tsl` already carries the repo and feed verbs, which leaves the Vault entries as the one thing a fresh install still lacks: `linear` returns `[]` before it builds a request, `github` fetches without an `Authorization` header, and `feed` never wanted a credential at all.

### There is no manual FLUSH — the digest auto-composes on `DONE`

Unlike the toy, the real digest is **not** flushed by hand. Each source ends its TICK with a terminal `DONE` (§2); the digest counts the *distinct* sources that have reported and composes + writes `digest:log` automatically once every source is in:

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

`$total` is the digest's **second** `make_node` argument — `make_node Digest_Builder digest scored:partition 3`, where `3` is the source count. Nothing computes it: the `.tsl` literal has to match the sources the topology TICKs, which `Insights_CI_Node` keeps in one private `SOURCE_NODES` list (`github`, `linear`, `feed`) that its Collect verb both counts and iterates. Add a fourth connector and both the list and that literal move. Counting *distinct* `FROM` paths, not raw signals, keeps the tally idempotent across re-ticks and replays, so a stale `DONE` can't overshoot. And because each `DONE` arrives behind every item it follows (§2), the compose sees a complete cycle.

So driving it by hand is a **RESET, then a TICK per source** — the dashboard's *Collect* button does exactly this:

```
> request_node digest RESET        # empty the accumulator, zero the per-cycle DONE tally
> request_node github TICK
> request_node linear TICK
> request_node feed   TICK
# …the third DONE reaches the digest and it composes + writes digest:log automatically.
```

Nothing in the shipped topology collects on a schedule — no `Timer` node TICKs a source — so every cycle starts with that Collect button, or with those four lines typed into `wp nodes cli`. Collecting on a cadence instead would take a `Timer_Node` subclass whose `fire()` mints the same `RESET` and `TICK` requests.

RESET also explains the digest's *first* argument. Emptying the accumulator changes this node's state but not the consumer's cursor, so the offsetlog would keep the stale item list and a restart would reload it. RESET therefore appends one throwaway message to the named `scored:partition`, which advances `scored:consumer` and makes its next checkpoint co-commit the emptied snapshot.

The only manual compose verb is `REGENERATE`, which recomposes a draft from the items *already* collected (no re-fetch). A source that fetches nothing still reports `DONE`, so a cycle where every source comes back empty composes an empty draft rather than hanging — the `finally` in §2 is what guarantees it.

---

## 6. Ship & operate it

A real plugin lives in its own repo and installs on a site that already has the substrate. The §8 essentials from the toy guide all apply (`Requires Plugins: newspack-nodes`, the deferred `plugins_loaded` loader, the test bootstrap, phpcs/phpstan, the release workflow). Here are the operational gotchas specific to taking *this* plugin live.

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
root. `Config::assert_private_to_us()` refuses a runtime tree owned by another
non-root uid outright, and only warns for root, because root's hazard runs the
other way: the files it leaves behind are root-owned, and the web-user worker
cannot write them.

Every worker that comes back gets a fresh WordPress bootstrap, rebuilding its
process-local topology catalog from the complete provider set. Bring the fleet
back only after every provider is in place: a worker born while a provider's
plugin directory was temporarily absent stays blind to it until its natural
turnover.

**Topologies register, but you activate them.** `register_plugin()` (in the bootstrap) makes every `.tsl` in `topologies/` a *catalog* entry; only a topology in the *active* set is spawned. Activate the aggregator — it `include`s the four stage files, so they need no activation of their own — from the **Nodes** hub's Overview or Topologies tab, which share one control cluster, or from the CLI, then confirm:

```bash
wp nodes activate <plugin-topology>
wp nodes status
#   <plugin-topology>.p0  live  3s ago  2m 10s
```

Activate the aggregator *or* the stages, never both. `Topology_Analyzer::find_conflicts()` runs on every activation and refuses two active topologies whose write sets overlap. A partition both declare with the identical `make_node` line is tolerated as a deliberate multi-writer log — but not these two: `ingest:partition` and `scored:partition` each lift the write cap with `void_warranty`, and a lifted cap assumes a sole writer. Offsetlogs never share at all, so the consumers collide whatever the cap does. Running one stage as its own fleet therefore means deactivating the aggregator first.

**The analyzer classifies a node by class LINEAGE, not by its `make_node` token.** `Topology_Analyzer` resolves each token through `Command_Interpreter_Node::resolve_class()` and tests descent, most-derived first (`Log_Node` before `Partition_Node`, which it extends). So *your* `Partition_Node` or `Topic_Node` subclass lands in the write set on lineage alone, however unfamiliar its token reads — gated by `find_conflicts()`, and spared by the `wp nodes gc` sweep as a declared dir — and your `Consumer_Node` subclass appears in `consumer_positions()`, which is what pairs an on-demand worker with the log whose growth should wake it. All that costs is the namespace `register_plugin()` already registers; where no namespace resolves yet, a fallback matches `<token>_Node` against the base class's own short name, which is how the stock tokens answer before boot wiring completes. The footgun is a node that writes a log *without* descending from one of those classes: it is invisible to every one of those passes, and the sweep takes its directory. Declare its path template through the `newspack_nodes/registered_log_producers` filter instead.

**Tests are hermetic — no network.** The closure-HTTP seam is what buys that: a test sets `$http_get` or `$http_post` to return a canned body, so nothing leaves the box.

```bash
cd tests && ../vendor/bin/phpunit
```

Lint to the same bar as the substrate. `npm run lint:php` runs phpcs (VIP Go) and then the comment-length gate; `npm run lint:phpstan` runs `phpstan-deadcode.neon`, which includes the level-10 + strict-rules config and adds the ShipMonk dead-code overlay. Read a dead-code finding skeptically: this is an application on a substrate the analysis cannot see, so `fill()`, `arguments()`, `node_schema()` and the rest of the Node contract read as dead here and are not — the config names those exemptions rather than muting the rule, and anything outside the list is a real finding.

**Release the substrate before the plugin that pins it.** A consumer importing an `@newspack-nodes/*` alias checks the substrate out in CI at a literal tag — `ref: v2.46.2` in `.github/workflows/release.yml`, feeding `NEWSPACK_NODES_SRC` — while a local build resolves the same alias to your working tree. When the two disagree the build still succeeds, so **a green Release workflow proves nothing about which substrate got bundled.** Tag the substrate first, let `scripts/bump-version.sh` rewrite the pin (it refuses a substrate version with no local tag), then verify the published asset: download the release zip and `diff -rq` its `build/` against your local one. Identical bytes means the pin was right.

**The pin is not the floor.** Two version numbers relate a consumer to the substrate and answer different questions. The `ref:` pin decides which substrate SOURCE a CI build bundles; the `Bootstrap::version_at_least()` call in the deferred loader (the toy guide's §8a) decides which INSTALLED substrate the plugin will run against, going dormant behind an admin notice below it. They move independently, and a pin several tags ahead of the floor is the normal state: intelligence pins v2.46.2 and floors at 2.25.0, the release that added `Node::config_line()` — the newest substrate API it calls.

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
