<?php
/**
 * Crawler_Node: crawl one site, following the same-origin links each page
 * carries.
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes;

\defined( 'ABSPATH' ) || exit;

/**
 * Crawler node — `make_node Crawler <name> <ttl> [vault_id]`.
 *
 * A seed is a TM_BYTESTREAM url from anyone but the crawler itself. It,
 * every same-origin link a fetched page carries and every same-origin
 * redirect Location are normalized and `ADD`ed to the `{name}:seen` sqlite
 * Table, and each one the Table reports new joins its `pending` set. A
 * refill moves up to `Curl_Node::MAX_IN_FLIGHT` less the fetches in flight
 * from `pending` to `inflight` and hands each url to the `{name}:curl`
 * sibling, which follows no redirect and whose answers come back here through
 * its target. An answer, the body, the redirect as TM_RESPONSE or the
 * TM_ERROR, leaves `inflight` and goes on to target with KEY set to the url;
 * an answered url is done, never retried. The first tick after the node is
 * built returns whatever `inflight` holds to `pending`, so a restart refetches
 * what the last process left in flight.
 *
 * One Crawler per name per host: the Table's namespace and file are the
 * crawler's name, so two workers running one crawler share its sqlite file
 * and re-queue each other's `inflight`.
 */
final class Crawler_Node extends Timer_Node {
	use Schema_Reflection;

	/** Refill tick, in ms; the first tick also recovers `inflight`. */
	public const TICK_MS = 1000;

	/** The frontier set: URLs discovered and not yet fetched. */
	private const PENDING = 'pending';

	/** URLs handed to Curl and not yet answered. */
	private const INFLIGHT = 'inflight';

	/** Seconds a url waits in `pending` or `inflight`: one year, past any ttl. */
	public const FRONTIER_TTL = 31536000;

	/** Seconds a URL counts as seen: the Table's TTL. */
	protected int $ttl = 0;

	/** Vault server id handed to the Curl sibling; '' for none. */
	protected string $vault_id = '';

	/** The `{name}:curl` sibling that fetches. */
	private ?Curl_Node $curl = null;

	/** Asks the `{name}:seen` Table. */
	private Table_Client $tables;

	/** Whether `inflight` has been returned to `pending` since this process built the node. */
	private bool $recovered = false;

	/** True while refill() runs; an answer arriving inside it does not re-enter. */
	private bool $refilling = false;

	/** The Table client asks by the crawler's live name, so it outlives a rename. */
	public function __construct() {
		parent::__construct();
		$this->tables = new Table_Client( $this );
	}

	/**
	 * `<ttl> [vault_id]`: build both siblings and arm the refill tick. A
	 * replay with new tokens tears both siblings down and builds them again;
	 * one the siblings refuse restores the tokens and the crawler they built.
	 *
	 * @param list<string>|null $args Positional tokens, or null to read the current ones.
	 * @return list<string>
	 * @throws \InvalidArgumentException When `ttl` is missing or not a whole number.
	 * @throws \RuntimeException When a sibling refuses its name or its arguments.
	 * @throws Failures When the restore refuses too, carrying both refusals.
	 */
	public function arguments( ?array $args = null ): array {
		if ( null === $args ) {
			return parent::arguments();
		}
		$previous = [ $this->arguments, $this->ttl, $this->vault_id ];
		$this->parse_schema_args( $args );
		if ( null === $this->curl || $previous[0] !== $args ) {
			$built = null !== $this->curl;
			try {
				$this->build_siblings();
			} catch ( \Throwable $e ) {
				[ $this->arguments, $this->ttl, $this->vault_id ] = $previous;
				$restore = function (): void {
					$this->build_siblings();
					$this->set_timer( self::TICK_MS );
				};
				Worker_Should_Stop::raise( [ $e, ...( $built ? Worker_Should_Stop::attempt( $restore ) : [] ) ] );
			}
		}
		$this->set_timer( self::TICK_MS );
		return $args;
	}

	/**
	 * A Table's reply goes to the client, an answer from Curl to `answer()`,
	 * a seed to `seed()`; anything else is dropped.
	 *
	 * @param array<int,mixed> $message The 7-field positional message array.
	 */
	public function fill( array $message ): void {
		if ( $this->tables->accepts( $message ) ) {
			return;
		}
		$type = Core::num_int( $message[ Message::TYPE ] );
		if ( $this->name === $message[ Message::FROM ] && 0 !== ( $type & ( Message::TM_BYTESTREAM | Message::TM_RESPONSE | Message::TM_ERROR ) ) ) {
			$this->answer( $message );
			return;
		}
		if ( 0 === ( $type & Message::TM_BYTESTREAM ) ) {
			$this->drop_message( $message, 'not a TM_BYTESTREAM url' );
			return;
		}
		$this->seed( $message );
	}

	/** The tick refills. */
	protected function fire(): void {
		$this->refill();
	}

	/**
	 * Replace whatever siblings stand with a Curl and a Table built from the
	 * current fields. The Table is named before its arguments arrive, because
	 * its sqlite file is spelled from its name; a sibling that refuses leaves
	 * neither behind and the tick disarmed.
	 *
	 * @throws \Throwable What a sibling refused.
	 */
	private function build_siblings(): void {
		$this->drop_siblings();
		$seen = new Table_Node();
		$seen->patron( $this );
		try {
			$this->curl = $this->publish_curl();
			$this->publish_sibling( 'seen', $seen );
			$seen->arguments( [ $this->name, (string) $this->ttl, 'sqlite' ] );
		} catch ( \Throwable $e ) {
			$this->drop_siblings();
			throw $e;
		}
		$seen->sink( $this->sink );
	}

	/** Disarm and tear both siblings down. */
	private function drop_siblings(): void {
		$this->stop_timer();
		$this->drop_curl();
		$this->retract_sibling( 'seen' );
	}

	/**
	 * Take a seed: one that is no absolute http(s) url, or that holds
	 * whitespace, answers a TM_ERROR copy to target; a valid one is normalized
	 * as a link is, discovered, and the crawler refills.
	 *
	 * @param array<int,mixed> $message The seed.
	 */
	private function seed( array $message ): void {
		$value = \trim( Core::as_string( $message[ Message::VALUE ] ) );
		$url   = self::seed_url( $value );
		if ( null === $url ) {
			$message[ Message::TYPE ]  = Message::TM_ERROR;
			$message[ Message::TO ]    = '';
			$message[ Message::VALUE ] = "invalid url {$value}";
			parent::fill( $message );
			return;
		}
		$this->discover( [ $url ] );
		$this->refill();
	}

	/**
	 * A seed as a link to itself: resolved, normalized and kept on its own
	 * origin, so it and a page's link to the same url share one seen key.
	 *
	 * @param string $value The trimmed seed.
	 * @return string|null Null when it is no absolute http(s) url, or holds whitespace.
	 */
	private static function seed_url( string $value ): ?string {
		try {
			$origin = Curl_Node::origin_of( $value );
		} catch ( \UnexpectedValueException ) {
			return null;
		}
		return self::link( $value, Core::arr( \wp_parse_url( $value ) ), $origin );
	}

	/**
	 * Take Curl's answer: discover a body's links or a redirect's Location,
	 * send the answer to target, take the url out of `inflight`, and refill.
	 * The url leaves `inflight` last, so a forward that throws leaves it
	 * there for the next start to fetch again.
	 *
	 * @param array<int,mixed> $message The body as TM_BYTESTREAM, the Location as TM_RESPONSE, or the TM_ERROR.
	 */
	private function answer( array $message ): void {
		$url   = Core::as_string( $message[ Message::KEY ] );
		$type  = Core::num_int( $message[ Message::TYPE ] );
		$value = Core::as_string( $message[ Message::VALUE ] );
		if ( 0 !== ( $type & Message::TM_BYTESTREAM ) ) {
			$this->discover( self::links( $value, $url ) );
		} elseif ( 0 !== ( $type & Message::TM_RESPONSE ) ) {
			$this->discover( self::location( $value, $url ) );
		}
		parent::fill( $message );
		$this->tables->remove_members( $this->sibling_name( 'seen' ), self::INFLIGHT, [ $url ] );
		$this->refill();
	}

	/**
	 * `ADD` each url as seen, and put every one the Table reports new in
	 * `pending` for `FRONTIER_TTL`. When `pending` takes none of them, their
	 * seen keys are removed again, so a later sighting finds them new.
	 *
	 * @param list<string> $urls Absolute urls.
	 */
	private function discover( array $urls ): void {
		$table = $this->sibling_name( 'seen' );
		$new   = $this->tables->add_multi( $table, \array_fill_keys( $urls, [ '1' ] ) );
		if ( [] === $new || [] !== $this->tables->add_members( $table, [ self::PENDING => \array_fill_keys( $new, 1 ) ], self::FRONTIER_TTL ) ) {
			return;
		}
		$this->tables->remove( $table, $new );
		$this->print_less_often( 'WARNING: pending took no new url; their seen keys are removed' );
	}

	/**
	 * Move as many urls from `pending` to `inflight` as Curl has free slots
	 * for, in one `SMOVE`, and hand each to Curl. Only inside a running event
	 * loop, where a transfer can complete. An answer Curl sends synchronously
	 * does not refill, so its slot waits for the next tick or the next answer;
	 * an answer that completes later refills on its own. A throw out of Curl's
	 * `fill()` mid-batch leaves the rest of the batch in `inflight` until the
	 * next start returns it to `pending`. Nothing moves while a recovery is
	 * owed, or the next one would return live urls to `pending`.
	 *
	 * @throws \LogicException When no Curl sibling was built.
	 */
	private function refill(): void {
		if ( $this->refilling || ! Event_Framework::instance()->is_running() ) {
			return;
		}
		$curl            = $this->curl ?? throw new \LogicException( \esc_html( "Crawler {$this->name} has no siblings; arguments() builds them" ) );
		$this->refilling = true;
		try {
			$this->recovered = $this->recovered || $this->recover();
			if ( ! $this->recovered ) {
				return;
			}
			$free = Curl_Node::MAX_IN_FLIGHT - $curl->transfers_in_flight();
			if ( $free < 1 ) {
				return;
			}
			foreach ( $this->tables->move_members( $this->sibling_name( 'seen' ), self::PENDING, self::INFLIGHT, $free ) as $url ) {
				$curl->fill( $this->fetch_message( $url ) );
			}
		} finally {
			$this->refilling = false;
		}
	}

	/**
	 * Return every url the last process left in `inflight` to `pending`.
	 *
	 * @return bool Whether recovery finished; a move the Table does not answer
	 *              leaves it for the next tick.
	 */
	private function recover(): bool {
		$table = $this->sibling_name( 'seen' );
		do {
			$moved = \count( $this->tables->move_members( $table, self::INFLIGHT, self::PENDING, Table_Node::MAX_MEMBERS_LIMIT, $failed ) );
			if ( $failed ) {
				return false;
			}
		} while ( Table_Node::MAX_MEMBERS_LIMIT === $moved );
		return true;
	}

	/**
	 * The fetch Curl is handed: the url as VALUE and KEY, FROM the crawler,
	 * which Curl copies into its answer.
	 *
	 * @param string $url The url to fetch.
	 * @return array<int,mixed>
	 */
	private function fetch_message( string $url ): array {
		$message                   = Message::new_message();
		$message[ Message::TYPE ]  = Message::TM_BYTESTREAM;
		$message[ Message::FROM ]  = $this->name;
		$message[ Message::KEY ]   = $url;
		$message[ Message::VALUE ] = $url;
		return $message;
	}

	/**
	 * The absolute same-origin links of a page, fragments dropped, each once,
	 * in document order.
	 *
	 * @param string $html     The page body.
	 * @param string $page_url The page's absolute http(s) url.
	 * @return list<string>
	 * @throws \UnexpectedValueException When the page url is not absolute http(s).
	 */
	public static function links( string $html, string $page_url ): array {
		$origin = Curl_Node::origin_of( $page_url );
		if ( '' === \trim( $html ) ) {
			return [];
		}
		$doc      = new \DOMDocument();
		$previous = \libxml_use_internal_errors( true );
		try {
			// The prefix declares UTF-8; libxml assumes Latin-1 without it.
			$doc->loadHTML( '<?xml encoding="utf-8"?>' . $html, \LIBXML_NONET | \LIBXML_NOERROR | \LIBXML_NOWARNING | \LIBXML_COMPACT );
		} finally {
			// A caller already collecting errors keeps what it collected.
			if ( ! $previous ) {
				\libxml_clear_errors();
			}
			\libxml_use_internal_errors( $previous );
		}
		$base = Core::arr( \wp_parse_url( $page_url ) );
		foreach ( $doc->getElementsByTagName( 'base' ) as $element ) {
			if ( ! $element->hasAttribute( 'href' ) ) {
				continue;
			}
			$href     = \trim( $element->getAttribute( 'href' ) );
			$resolved = self::absolute_url( $href, $base );
			$base     = null === $resolved ? $base : Core::arr( \wp_parse_url( $resolved ) );
			break;
		}
		$out = [];
		foreach ( $doc->getElementsByTagName( 'a' ) as $element ) {
			$url = self::link( $element->getAttribute( 'href' ), $base, $origin );
			if ( null !== $url ) {
				$out[ $url ] = true;
			}
		}
		return \array_map( 'strval', \array_keys( $out ) );
	}

	/**
	 * A redirect's Location as the one link it is: resolved against the page,
	 * normalized, and kept only on the page's origin.
	 *
	 * @param string $location The Location Curl answered.
	 * @param string $page_url The page's absolute http(s) url.
	 * @return list<string>
	 * @throws \UnexpectedValueException When the page url is not absolute http(s).
	 */
	private static function location( string $location, string $page_url ): array {
		$url = self::link( $location, Core::arr( \wp_parse_url( $page_url ) ), Curl_Node::origin_of( $page_url ) );
		return null === $url ? [] : [ $url ];
	}

	/**
	 * One href resolved against a base and normalized, kept only when it is
	 * on `$origin` and holds no whitespace.
	 *
	 * @param string             $href   The href as written.
	 * @param array<mixed,mixed> $base   The absolute base url's parts.
	 * @param string             $origin The origin a link must share.
	 * @return string|null
	 */
	private static function link( string $href, array $base, string $origin ): ?string {
		$url = self::absolute_url( \trim( $href ), $base );
		if ( null === $url || Cache_Backend::refuses_key( $url ) ) {
			return null;
		}
		try {
			return Curl_Node::origin_of( $url ) === $origin ? $url : null;
		} catch ( \UnexpectedValueException ) {
			return null;
		}
	}

	/**
	 * Resolve a reference against a parsed base, RFC 3986 section 5.2.2, as
	 * `scheme://host[:port]path[?query]` with no fragment, an empty path as
	 * `/` and a default port dropped (section 6.2.3).
	 *
	 * @param string              $ref  The href as written.
	 * @param array<mixed,mixed>  $base The absolute base url's parts.
	 * @return string|null Null for an empty or unparseable reference, or one carrying userinfo.
	 */
	private static function absolute_url( string $ref, array $base ): ?string {
		if ( '' === $ref ) {
			return null;
		}
		$r = \wp_parse_url( $ref );
		if ( ! \is_array( $r ) || isset( $r['user'] ) || isset( $r['pass'] ) ) {
			return null;
		}
		$ref_path = Core::as_string( $r['path'] ?? '' );
		$query    = $r['query'] ?? null;
		if ( isset( $r['scheme'] ) || isset( $r['host'] ) ) {
			$scheme = Core::as_string( $r['scheme'] ?? $base['scheme'] ?? '' );
			$host   = Core::as_string( $r['host'] ?? '' );
			$port   = $r['port'] ?? null;
			$path   = $ref_path;
		} else {
			$scheme = Core::as_string( $base['scheme'] ?? '' );
			$host   = Core::as_string( $base['host'] ?? '' );
			$port   = $base['port'] ?? null;
			if ( '' === $ref_path ) {
				$path  = Core::as_string( $base['path'] ?? '' );
				$query = $query ?? ( $base['query'] ?? null );
			} else {
				$path = '/' === $ref_path[0] ? $ref_path : self::merge_path( $base['path'] ?? '', $ref_path );
			}
		}
		if ( '' === $host ) {
			return null;
		}
		$scheme = \strtolower( $scheme );
		$host   = \strtolower( $host );
		if ( null !== $port && ( Curl_Node::DEFAULT_PORTS[ $scheme ] ?? null ) === Core::as_int( $port ) ) {
			$port = null;
		}
		$url  = "{$scheme}://{$host}";
		$url .= null === $port ? '' : ':' . Core::as_string( $port );
		$url .= self::remove_dot_segments( '' === $path ? '/' : $path );
		return null === $query ? $url : $url . '?' . Core::as_string( $query );
	}

	/**
	 * Merge a relative path onto a base path, RFC 3986 section 5.2.3, for a
	 * base that has an authority.
	 *
	 * @param mixed  $base_path The base url's path, if any.
	 * @param string $ref_path  The relative reference path.
	 * @return string
	 */
	private static function merge_path( mixed $base_path, string $ref_path ): string {
		$base_path = Core::as_string( $base_path );
		$slash     = \strrpos( $base_path, '/' );
		return false === $slash ? '/' . $ref_path : \substr( $base_path, 0, $slash + 1 ) . $ref_path;
	}

	/**
	 * Remove the `.` and `..` segments of a path, RFC 3986 section 5.2.4,
	 * less the branches for a path with no leading slash, which a resolved
	 * path never is.
	 *
	 * @param string $path The path to normalize.
	 * @return string
	 */
	private static function remove_dot_segments( string $path ): string {
		$out = '';
		while ( '' !== $path ) {
			if ( \str_starts_with( $path, '/./' ) ) {
				$path = \substr( $path, 2 );
			} elseif ( '/.' === $path ) {
				$path = '/';
			} elseif ( \str_starts_with( $path, '/../' ) ) {
				$path = \substr( $path, 3 );
				$out  = self::drop_last_segment( $out );
			} elseif ( '/..' === $path ) {
				$path = '/';
				$out  = self::drop_last_segment( $out );
			} else {
				$next = \strpos( $path, '/', 1 );
				$len  = false === $next ? \strlen( $path ) : $next;
				$out .= \substr( $path, 0, $len );
				$path = \substr( $path, $len );
			}
		}
		return $out;
	}

	/**
	 * Drop the last segment, and its leading slash, from an output path.
	 *
	 * @param string $out The output path so far.
	 * @return string
	 */
	private static function drop_last_segment( string $out ): string {
		$slash = \strrpos( $out, '/' );
		return false === $slash ? '' : \substr( $out, 0, $slash );
	}

	/**
	 * Name the siblings through `parent::`, then, on a rename, replace Curl:
	 * the answers of its fetches in flight carry the old name, so they are
	 * released, and recovery fetches their urls again.
	 */
	protected function set_sibling_names(): void {
		parent::set_sibling_names();
		if ( null === $this->curl || $this->name === $this->curl->target() ) {
			return;
		}
		$this->drop_curl();
		$this->curl = $this->publish_curl();
	}

	/**
	 * Tear Curl down. It discards its transfers, and the next refill recovers
	 * their urls from `inflight`.
	 */
	private function drop_curl(): void {
		$this->curl      = null;
		$this->recovered = false;
		$this->retract_sibling( 'curl' );
	}

	/**
	 * Build and publish a Curl sibling, following no redirect, whose answers
	 * come back here.
	 *
	 * @return Curl_Node
	 * @throws \RuntimeException When the Curl slot or name is taken.
	 */
	private function publish_curl(): Curl_Node {
		$curl = new Curl_Node();
		$curl->patron( $this );
		$curl->arguments( '' === $this->vault_id ? [] : [ $this->vault_id ] );
		$curl->follow_redirects( false );
		$this->publish_sibling( 'curl', $curl );
		$curl->sink( $this->sink );
		$curl->target( $this->name );
		return $curl;
	}

	/**
	 * Topology console manifest.
	 *
	 * @return array<string,mixed>
	 */
	public static function node_schema(): array {
		return [
			'category'    => 'I/O',
			'description' => 'Crawl one site from each seed url: fetch it, send every answer to target with KEY set to the url, and follow its same-origin links, each once per ttl.',
			'has_target'  => true,
			'arguments'   => [
				[ 'name' => 'ttl', 'type' => 'int', 'required' => true, 'description' => 'Seconds a url counts as seen, at least 1; it may be crawled again after.' ],
				[ 'name' => 'vault_id', 'type' => 'vault_id', 'default' => '', 'description' => 'Optional Vault server the Curl sibling fetches through; seeds must be on its origin.' ],
			],
			'commands'    => [],
		];
	}
}
