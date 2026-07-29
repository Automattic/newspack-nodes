# Writing a *Real* Nodes Plugin

You've finished [writing-a-plugin.md](writing-a-plugin.md). You built the toy AI-newsletter — two canned sources, a template summarizer, a markdown digest — watched items flow through `fill()`, turned the by-hand session into a topology, and stood it up as a live worker. That guide's **§7, "Make it real — the short hop"**, promised the production version is just two method bodies away:

```php
// toy
protected function items(): array { return [ /* canned */ ]; }
// real (sketch)
protected function items(): array { return My_Github_Source::recent_releases(); }
```

That promise is true at the level of the *contract* — the summarizer and digest never learn the items stopped being canned. But "swap one method body" hand-waves a lot: real fetches block on the network, fail halfway, return duplicate items every tick, and need credentials an operator stores in the substrate's Vault. This guide is the deep dive. It walks the actual production plugin, **`newspack-intelligence`** (the sibling repo, not the bundled `examples/example-ai-newsletter` toy), and shows everything we built *on top of* the toy to take it live.

The shape is unchanged — three sources fan into a durable `ingest` partition, a consumer paces them through a summarizer, a scorer, and a second durable partition, and a final consumer feeds a digest builder. What changed is everything around the seam: a `Source` interface, a shared abstract base that owns the connector plumbing, three real connectors (GitHub, Linear, RSS/Atom), credentials kept in the substrate's **Vault** and referenced from the topology, and a test seam that lets all of it run under coverage without touching the network.

> **The one thing to hold onto (still):** every node has one entry point, `fill( array $message ): void`. Nothing below changes that. The real connectors are *more code* than the toy, but they're the same node — they still mint a `TM_STRUCT` per item and forward to their sink. Everything new lives behind `fetch()`, which `fill()` calls and the graph never sees.

The finished code is in the sibling [`newspack-intelligence/`](../../newspack-intelligence/) repo. Read along, or diff it against the toy.

---

## 0. What changed — the same graph, real ends

The toy graph and the real graph are the same boxes and arrows, plus a durable **ingest** layer the toy didn't need. Here's the production topology (`topologies/newspack-intelligence.tsl`):

```
github ┐
linear ┼─ ingest:partition                                 (durable raw-item log)
feed   ┘
ingest:consumer ─ summarizer ─ scorer ─ scored:partition   (durable `scored` log)
scored:consumer ─ digest ─ digest:tee ─ digest:log
```

Three connector **sources** fan into the `ingest` partition (fan-in, exactly as Ben's community source fanned into the summarizer in the toy — the target is a partition now, not the summarizer). What's genuinely new from the toy's perspective is concentrated at the two ends, plus that new partition in the middle:

- **The source end.** The toy's `items()` returned a literal array. The real sources `fetch()` over HTTP, normalize wildly different payloads (GitHub REST, Linear GraphQL, RSS/Atom XML) into one item shape, dedup against what they've already emitted, and need credentials.
- **The credentials.** A real source is useless without a token. The secret lives in the substrate's **Vault** (the devtools-hub's *Vault* tab), and the topology carries only a *pointer* to it — a `set_vault_id <id>` verb on the node's `.tsl` line, resolved to the raw secret at `config()`. The rest of a source's config is topology verbs too (`add_repo`, `add_url`, `set_model`, …). No WordPress Settings page, no per-plugin options.
- **The ingest partition.** A source TICK writes raw items to a durable log — a *fast* append, no per-item LLM work — so the worker keeps heartbeating during a collect. The `ingest:consumer` then paces those items through the blocking summarizer/scorer LLM calls one read-block per drain, spreading the enrich across drain cycles. The partition is the buffer between the bursty sources and the slow enrich.

The middle — summarizer, scorer, the two partitions, consumers, digest — is its own story (the LLM seam, the durable `scored` log, the snapshot co-commit); this guide stays at the source end, the ingest buffer, and the credentials, because that's the part the toy guide explicitly deferred. We'll write it in the order you'd discover it: the contract first, then the base that implements it, then the three connectors, then the credentials that feed them, then wiring and ship.

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
return Core::arr( $decoded );
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
	public function fill( array $message ): void {
		$type = Core::num_int( $message[ Message::TYPE ] );
		if ( $type & Message::TM_REQUEST ) {
			$this->handle_request( $message );
		}
	}
```

The base owns four things the toy duplicated:

**TICK handling.** `fill()` branches on `TM_REQUEST` and calls `handle_request()` — once, in the base. (Note: unlike the toy, the production source does *not* send a `{ emitted }` reply; per-item emit is pure fire-and-forget. But it *does* close every TICK with one terminal `DONE` — see below.)

**Dedup by item `id`, then a terminal `DONE`.** A real source is polled on a timer; each TICK re-fetches the same window and would re-emit items the digest already has. So the base keeps a bounded `$seen` set and drops anything it's emitted before — then, in a `finally`, emits one `TM_INFO` `DONE` so the digest can count collection progress (§5 spells out the auto-compose it drives):

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
		// FROM (the source name) is the digest's distinct-source key; VALUE is the marker.
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

`fetch()` is synchronous, so the `DONE` is minted *after* every item this TICK produced — and because it's a normal message it rides the same `ingest → … → scored → digest` path in order, reaching the digest after all the items it follows. The `finally` guarantees a `DONE` even when `fetch()` throws, so a single failing source can never stall the collect. The digest counts distinct `DONE` sources and auto-composes once all of them have reported ([§5](#5-wiring-real-sources-into-the-topology)) — there is no manual flush.

An item with no string `id` is skipped — no id means no dedup key, and the contract requires one. The set is capped at `MAX_SEEN = 2000` and evicts oldest-first with `array_slice`, so a worker that lives ten minutes and ticks repeatedly never grows the set without bound. (This is the Tachikoma "sliding-window expiration / bounded state" discipline: constant memory regardless of message rate.)

**Fire-and-forget emit.** Each new item goes out via `parent::fill( $response )` — the §2-of-the-toy emit pattern: build the message, let the base `Node::fill()` stamp `TO` from the `connect_node`-wired target and forward to the sink. No reply, no `TM_PERSIST` ack ([ADR-3](architecture-decisions.md#adr-3-fire-and-forget-messaging)); the single-threaded drain is the backpressure.

**Shared `normalize_item()` and `source_schema()`.** Three connectors, three radically different payloads, but exactly one output shape. The base coerces and guards every field once:

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

`source_schema()` builds each connector's `node_schema()` from one shared shape (category `Source`, one `TICK` request) so the connectors don't restate it:

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

`Source_Node` is `abstract` and declares no `node_schema()` of its own — you never `make_node Source_Node`. Each concrete connector supplies its own one-liner.

This is force #7, **uniform interface**, taken one level up from the toy. In the toy each node hand-rolled `fill()`. Here, a *category* of nodes — connectors — share one implementation of the contract, and a new connector supplies only `fetch()` + `config()`. The base is the connector; the subclass is the wiring to a specific API.

---

## 3. The three real connectors

Three APIs, three payload shapes, three auth schemes. Each subclass is small precisely because the base did the heavy lifting — each adds only `config()`, `fetch()`, and a one-line `node_schema()`.

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

## 4. Credentials in the Vault, config in the topology

A real source needs a token, a repo list, a feed list. There is **no per-plugin WordPress Settings page** for these — the substrate already owns the credential surface (the **Vault**), and the topology already owns node config (the `:config` verbs). The split is deliberate:

- **The secret lives in the Vault** — server-side, entered once by an operator, never written into the topology or any plugin option in plaintext.
- **The topology holds only a *pointer* to it** — a `set_vault_id <id>` verb on the source's `.tsl` line. The node resolves that id to the raw secret at `config()` time.
- **Everything non-secret is a `:config` verb too** — `add_repo`, `add_url`, `set_api_url`, `set_model`, `set_feature`, `add_profile`. Ordered, round-trippable, no options table.

### The Vault — where the operator enters the token

The Vault is a real tab in the devtools hub (`admin.php?page=newspack-nodes-hub&tab=vault`), a React surface under `newspack-nodes/src/vault/` backed by `Vault_CI_Node` and the `newspack_nodes_vault` option. An operator adds one entry per credential — an `id`, a `url`, and a Basic-Auth `auth_username` / `auth_password` pair; the token goes in `auth_password`. The store is write-and-forget: the `list`/`get` verbs return only the **public shape** — `{ id, url, has_credentials, is_config }` — so the secret itself never leaves the server, not even to the dashboard that manages it:

```php
// Vault_CI_Node::public_shape() — credentials are computed away, never returned.
return [
	'id'              => $id,
	'url'             => (string) $raw_url,
	'has_credentials' => ! empty( $config['auth_username'] ) && ! empty( $config['auth_password'] ),
	'is_config'       => $registry->is_config_server( $id ),
];
```

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
		'token' => $this->resolve_vault_secret( $this->vault_id ),   // id → raw secret, at fetch time
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

That soft failure is the whole no-creds-no-emit story: a source whose `vault_id` resolves to `''` fetches with no token and returns `[]` — the TICK is a silent no-op, which is the correct default for a freshly-activated topology (§5).

The verb also carries a typed schema arg, `type: 'vault_id'` — that type is what makes the topology console render a **Vault-entry dropdown** for the field instead of a free-text box, so an operator picks an existing entry rather than typing a raw id:

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

A schema `handler` is a dispatch closure — it receives the pre-split **token array** `array $args` (`list<string>` argv), not a string. The static `cmd_set_vault_id` resolves the patron node and delegates the first token to the string instance method: `$patron->set_vault_id( Core::as_string( $args[0] ?? '' ) )`. The instance verb methods below (`set_vault_id`, `add_repo`) take a single `string` because each expects one scalar token — the array-to-scalar seam lives in the dispatch closure.

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

You set these in the topology console (or as `cmd <node>:config …` lines in the `.tsl`, shown in §5). Because every verb also round-trips through `dump_config()`, the console can serialize a live graph back to a topology that re-applies each verb in order.

> **The React dashboard is separate.** The Vault tab is *credentials in*. The **Publisher Insights** dashboard (the React mount on its own admin menu, served by `Insights_CI`) is *insights out* — and it's a whole other build story (the `@newspack-nodes/shared` alias, esbuild, jest). That's [writing-a-real-dashboard.md](writing-a-real-dashboard.md), not this guide. This guide stops at a headless, Vault-fed pipeline.

---

## 5. Wiring real sources into the topology

The production `.tsl` is the toy topology with real source nodes swapped in, the durable **ingest** buffer added at the front, and the scored/durable middle behind it. The sources fan into the `ingest` partition (not the summarizer); a consumer paces `ingest` through the enrich; each source also carries its `:config` verbs inline. Trimmed to the shape:

```
make_node Github_Source  github
cmd github:config set_vault_id github
cmd github:config add_repo Automattic/newspack-plugin

make_node Linear_Source  linear
cmd linear:config set_vault_id linear

make_node Feed_Source    feed
cmd feed:config add_url https://wordpress.org/news/feed/

# ingest: raw fetched items buffer between the bursty sources and the LLM summarizer,
# so a TICK's fetch+write is fast and the per-item enrich is paced by the consumer.
make_node Partition ingest:partition <config:logs_dir>/ingest.p<partition> <config:segment_size> <config:min_segments> <config:num_segments> <config:min_lifetime> <config:lifetime>
cmd ingest:partition:config void_warranty
make_node Consumer  ingest:consumer  <config:logs_dir>/ingest.p<partition> <config:offsets_dir>/ingest.p<partition>
cmd ingest:consumer:config set_line_mode true

make_node Summarizer     summarizer
make_node Scorer         scorer
make_node Partition      scored:partition ...
make_node Consumer       scored:consumer  ...
# The digest's sole arg is the progress denominator (done/total) — it MUST equal the
# source count (count(Insights_CI_Node::SOURCE_NODES) === 3).
make_node Digest_Builder digest scored:partition 3

connect_node github          ingest:partition
connect_node linear          ingest:partition
connect_node feed            ingest:partition
connect_node ingest:consumer summarizer
connect_node summarizer      scorer
connect_node scorer          scored:partition
connect_node scored:consumer digest
```

Three sources, one partition, one wire each — fan-in needs no special node, just like Ben's community source, except the shared target is now a durable log. **Why the partition sits between the sources and the summarizer:** a source TICK's job is a fast *fetch-and-append*, with no per-item LLM call on the hot path, so the worker keeps heartbeating while it collects; the `ingest:consumer` then tails one read-block per drain into the blocking summarizer → scorer, spreading the enrich across drain cycles instead of stalling the whole collect on the network. `void_warranty` lifts the partition's 4 KB PIPE_BUF write cap ([ADR-4](architecture-decisions.md#adr-4-pipe_buf-atomic-writes)) because a raw item can exceed it.

The other new substrate behavior at the source end is that the sources **emit nothing until configured**: a `Linear_Source` whose `set_vault_id` resolves to no token returns `[]` from `fetch()` and the TICK is a silent no-op. So a freshly-activated topology is live but silent, and stays silent until you add the Vault entry and the `:config` verbs — which is the correct default.

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

`$total` is the `make_node Digest_Builder digest scored:partition 3` argument — the source count. Counting *distinct* `FROM` names (not raw signals) keeps it idempotent across re-ticks and replays, so a stale `DONE` can't overshoot. Because `DONE` rides the `ingest → scored → digest` path in order, it lands after every item it follows, so the compose sees a complete cycle.

So driving it by hand is a **RESET, then a TICK per source** — the dashboard's *Collect* button does exactly this:

```
> request_node digest RESET        # zero the per-cycle DONE tally (and empty the accumulator)
> request_node github TICK
> request_node linear TICK
> request_node feed   TICK
# …the third DONE reaches the digest and it composes + writes digest:log automatically.
```

The only manual compose verb is `REGENERATE`, which recomposes a draft from the items *already* collected (no re-fetch). With no creds the TICKs emit nothing, the three `DONE`s still arrive, and the digest composes an empty draft — add a Vault entry + an `add_repo` and re-collect to see items flow.

---

## 6. Ship & operate it

A real plugin lives in its own repo and installs on a site that already has the substrate. The §8 essentials from the toy guide all apply (`Requires Plugins: newspack-nodes`, the deferred `plugins_loaded` loader, the test bootstrap, phpcs/phpstan, the release workflow). Here are the operational gotchas specific to taking *this* plugin live.

**Deploy installs a prebuilt zip — build first.** The setup script installs the existing `release/*.zip`; it does **not** build. So the loop is *build, then deploy*:

```bash
cd services/pyrobase/sources/newspack-intelligence
npm run release:archive    # builds release/newspack-intelligence.zip
docker exec eve-pyrobase1-1 /services/pyrobase/setup/newspack-intelligence.sh
```

Skip the build and your live `wp nodes` runs the *old* code — and because the PHPUnit suite runs from `/services`, the tests won't catch the stale deploy.

**After adding node classes, regenerate the autoloader.** The classmap is what `make_node` resolves against and what `Classes_CI` scans to populate the console palette. For local container testing run `composer dump-autoload -o` after adding or renaming a node. (The release zip is already optimized, so a freshly-built zip needs no separate dump.)

**Restart long-lived processes after the complete deploy.** A running worker
holds the old class in its PHP process for the rest of its ~10-minute lifespan.
Wait until all topology-provider plugins have been installed and activated as
WordPress plugins, then refresh the workers first and the singleton supervisor
last:

```bash
docker exec -u bend eve-pyrobase1-1 wp nodes restart all --all-partitions --path=/var/www/html
docker exec -u bend eve-pyrobase1-1 wp nodes restart supervisor --path=/var/www/html
```

Run both commands as the worker's OS user: Nodes ownership-guards the runtime
tree where those restart flags are written.

The first command restarts every worker topology so it loads the new PHP;
`restart all` deliberately excludes the supervisor. The second requests a
clean supervisor turnover with a fresh WordPress bootstrap, rebuilding its
process-local topology catalog from the complete provider set. Without that
final restart, a supervisor born while a provider's plugin directory was
temporarily absent can remain blind to the provider until its natural turnover.

**Topologies register, but you activate them.** `register_plugin()` (in the bootstrap) makes `newspack-intelligence.tsl` a *catalog* entry; the supervisor only spawns a topology in the *active* set. Activate it from the console's Topology Manager or with `topologies activate <name>`, then confirm:

```bash
docker exec eve-pyrobase1-1 wp nodes status --allow-root --path=/var/www/html
#   newspack-intelligence  0  live  3s ago  2m 10s
```

**Tests run in the container, from `/services`, no network.** The closure-HTTP seam is what makes the connector suites hermetic — tests set `$http_get`/`$http_post` to return canned bodies, so nothing leaves the box:

```bash
docker exec -u bend eve-pyrobase1-1 bash -c \
  'cd /services/pyrobase/sources/newspack-intelligence/tests && ../vendor/bin/phpunit'
```

Lint to the same bar as the substrate — `npm run lint:php` (phpcs, VIP Go) and `npm run lint:phpstan` (level 10 + strict rules).

---

## 7. Recap — what you added vs. what the substrate still gave you

The toy guide's punchline was *Ana and Ben never met* — capability added by wiring a node, not editing a system. Going real didn't change that bet; it cashed it in.

You added three real classes — `Github_Source_Node`, `Linear_Source_Node`, `Feed_Source_Node` — and each one is only `config()` + `fetch()` + a one-line `node_schema()`, because the new **`Source_Node`** base absorbed every connector concern the toy used to copy per source: the TICK trigger, the bounded dedup set, the fire-and-forget emit, and the shared `normalize_item()` that flattens three wildly different payloads into one item shape. You added a `Source` interface to name the seam, a closure-HTTP seam per connector so the network-touching code runs under coverage, and a `set_vault_id` pointer into the substrate's Vault so the connectors have credentials to fetch with.

And here's what you **still** never touched. The summarizer, the scorer, the digest builder — none of them learned the items stopped being canned; they consume `{ source, id, title, url, body }` exactly as before. The router, the worker lifecycle, the supervisor, the topology console, the Vault credential store, the offsetlog snapshot in the durable middle — all reused. The connectors dropped into a graph full of pieces they've never seen, because they upheld the one contract: a message arrives at `fill()`, you do your work, you forward it to your sink.

That was the short hop the toy guide promised — `items()` → `fetch()`. It turned out to be two method bodies of *intent* wrapped in a base class of *plumbing*, a Vault-backed credential pointer, and a test seam. The intent really was small. The plumbing is what the substrate lets you write once and stop thinking about.

---

## Where to go next

- **[writing-a-plugin.md](writing-a-plugin.md)** — the toy walkthrough this guide extends (re-read §7–9 with the real code in mind).
- **[writing-a-real-dashboard.md](writing-a-real-dashboard.md)** — this guide's sibling: the production console/dashboard surfaces (palette vs inspector, measured transcript ceilings, the icons build gotcha) and the *insights out* half §4 deferred.
- **[writing-a-dashboard.md](writing-a-dashboard.md)** — the original toy Publisher Insights React dashboard walkthrough.
- **[architecture-guide.md](architecture-guide.md)** — the full model: drain loop, partitions, workers, supervisor, the REPL.
- **[architecture-decisions.md](architecture-decisions.md)** — the load-bearing ADRs (fire-and-forget §3, PIPE_BUF §4, lazy init §5).
- **[`../../newspack-intelligence/`](../../newspack-intelligence/)** — the complete production plugin: `includes/`, `topologies/newspack-intelligence.tsl`, the PHPUnit suite.
