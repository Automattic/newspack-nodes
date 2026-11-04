<?php
/**
 * Crawler_Node: crawl from each seed, following the same-origin links each
 * page carries.
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes;

\defined( 'ABSPATH' ) || exit;

/**
 * Crawler node — `make_node Crawler <name> <ttl> [vault_group] [delay_ms] [concurrency]`.
 *
 * A seed url, and each same-origin link and redirect Location a fetched page
 * carries, is normalized and `ADD`ed to the `{name}:seen` sqlite Table; each
 * new one joins the Frontier there, which the `{name}:curl` sibling fetches,
 * `concurrency` at a time or one every `delay_ms`. Every answer goes to
 * target with KEY set to its url, an answered url is never retried, and a
 * restart fetches again what was in flight. One Crawler per name per host:
 * two workers running one share its sqlite file.
 */
final class Crawler_Node extends Timer_Node implements Shutdown_Sweeper {
	use Schema_Reflection;

	/** Refill tick, in ms; the first tick also recovers `inflight`. */
	public const TICK_MS = 1000;

	/**
	 * Least positive `delay_ms`. A delay arms the refill timer at `delay_ms`,
	 * which takes its own event-loop slot below the Router's tick, so 5 ms
	 * would wake the loop some 200 times a second. A 100 ms gap already starts
	 * ten fetches a second, past where a politeness delay means anything; a
	 * faster crawl takes delay 0 and paces by `concurrency`.
	 */
	public const MIN_DELAY_MS = 100;

	/** Sibling kind of the Table that holds the seen keys and the frontier. */
	private const SEEN = 'seen';

	/** Seconds a URL counts as seen: the Table's TTL. */
	protected int $ttl = 0;

	/** Vault group handed to the Curl sibling; '' for none. */
	protected string $vault_group = '';

	/** Least ms between two fetch starts; 0 starts them as slots free. */
	protected int $delay_ms = 0;

	/** Most fetches in flight at once, 1 to `Curl_Node::MAX_IN_FLIGHT`. */
	protected int $concurrency = 1;

	/** The `{name}:curl` sibling that fetches. */
	private ?Curl_Node $curl = null;

	/** Asks the `{name}:seen` Table. */
	private Table_Client $tables;

	/** The urls to fetch, in the `{name}:seen` Table: `pending`, then `inflight`. */
	private Frontier $frontier;

	/** True while refill() runs; an answer arriving inside it does not re-enter. */
	private bool $refilling = false;

	/** When refill() last started a fetch, in `Core::$now` seconds; 0.0 before one. */
	private float $last_start = 0.0;

	/** The Table client asks by the crawler's live name, so it outlives a rename. */
	public function __construct() {
		parent::__construct();
		$this->tables   = new Table_Client( $this );
		$this->frontier = new Frontier( $this->tables, fn (): string => $this->sibling_name( self::SEEN ) );
	}

	/**
	 * `<ttl> [vault_group] [delay_ms] [concurrency]`: build both siblings,
	 * again on a changed `ttl` or `vault_group`, restoring what stood when they
	 * refuse, and pace the refill timer.
	 *
	 * @param list<string>|null $args Positional tokens, or null to read the current ones.
	 * @return list<string>
	 * @throws \InvalidArgumentException When a token is missing, mistyped or out of range.
	 * @throws \RuntimeException When a sibling refuses its name or its arguments.
	 * @throws Failures When the restore refuses too, carrying both refusals.
	 */
	public function arguments( ?array $args = null ): array {
		if ( null === $args ) {
			return parent::arguments();
		}
		$values      = $this->schema_values( $args );
		$delay_ms    = Core::as_int( $values['delay_ms'] );
		$concurrency = Core::as_int( $values['concurrency'] );
		if ( 0 !== $delay_ms && $delay_ms < self::MIN_DELAY_MS ) {
			$this->refuse_argument( 'delay_ms wants 0, or a whole number from ' . self::MIN_DELAY_MS . " up, got '{$delay_ms}'" );
		}
		try {
			Curl_Node::concurrency_of( $concurrency );
		} catch ( \InvalidArgumentException $refused ) {
			$this->refuse_argument( $refused->getMessage() );
		}
		$previous = [ $this->arguments, $this->ttl, $this->vault_group, $this->delay_ms, $this->concurrency ];
		$this->assign_schema_args( $args, $values );
		if ( null === $this->curl || $previous[1] !== $this->ttl || $previous[2] !== $this->vault_group ) {
			$built = null !== $this->curl;
			try {
				$this->build_siblings();
			} catch ( \Throwable $e ) {
				[ $this->arguments, $this->ttl, $this->vault_group, $this->delay_ms, $this->concurrency ] = $previous;
				$restore = function (): void {
					$this->build_siblings();
					$this->pace();
				};
				Worker_Should_Stop::raise( [ $e, ...( $built ? Worker_Should_Stop::attempt( $restore ) : [] ) ] );
			}
		}
		$this->pace();
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

	/** The tick refills: the window, or one url a fire under a delay. */
	protected function fire(): void {
		$this->refill( tick: true );
	}

	/**
	 * Arm the refill timer at `delay_ms`, or at `TICK_MS` with no delay,
	 * re-arming only when that interval changes.
	 */
	private function pace(): void {
		$interval = 0 < $this->delay_ms ? $this->delay_ms : self::TICK_MS;
		if ( $interval !== $this->interval_ms ) {
			$this->set_timer( $interval );
		}
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
			$this->publish_sibling( self::SEEN, $seen );
			$seen->arguments( \array_values( self::owned_table( self::SEEN, $this->name, [ (string) $this->ttl ] ) ) );
		} catch ( \Throwable $e ) {
			$this->drop_siblings();
			throw $e;
		}
		$seen->sink( $this->sink );
	}

	/**
	 * The `seen` Table a Crawler named `$owner` builds, which build_siblings()
	 * and the analyzer both read: the namespace, ttl and backend its arguments
	 * carry, in that order. The first argument is the TTL, which has no
	 * default.
	 *
	 * @param string       $suffix    The owned Table's suffix, `seen`.
	 * @param string       $owner     Crawler name.
	 * @param list<string> $arguments The Crawler's `make_node` arguments.
	 * @return array{namespace: string, ttl: string, backend: string}
	 * @throws \RuntimeException When the Crawler declares no TTL.
	 */
	public static function owned_table( string $suffix, string $owner, array $arguments ): array {
		return [
			'namespace' => $owner,
			'ttl'       => $arguments[0] ?? throw new \RuntimeException( \esc_html( "Crawler {$owner} declares no TTL" ) ),
			'backend'   => 'sqlite',
		];
	}

	/** Disarm and tear both siblings down. */
	private function drop_siblings(): void {
		$this->stop_timer();
		$this->drop_curl();
		$this->retract_sibling( self::SEEN );
	}

	/**
	 * Discover a valid seed url and refill, answering a TM_INFO copy for one
	 * already seen and a TM_ERROR copy for one invalid or whose `ADD` failed.
	 *
	 * @param array<int,mixed> $message The seed.
	 */
	private function seed( array $message ): void {
		$value = \trim( Core::as_string( $message[ Message::VALUE ] ) );
		$url   = self::seed_url( $value );
		if ( null === $url ) {
			$this->answer_seed( $message, Message::TM_ERROR, "invalid url {$value}" );
			return;
		}
		$message[ Message::KEY ] = $url;
		$new                     = $this->discover( [ $url ], $failed );
		if ( $failed ) {
			$this->answer_seed( $message, Message::TM_ERROR, 'ADD to ' . $this->sibling_name( self::SEEN ) . " failed {$url}" );
		} elseif ( [] === $new ) {
			$this->answer_seed( $message, Message::TM_INFO, "already seen {$url}" );
		}
		$this->refill( tick: false );
	}

	/**
	 * Send target a copy of the seed with its TYPE and VALUE replaced.
	 *
	 * @param array<int,mixed> $message The seed.
	 * @param int              $type    TM_ERROR or TM_INFO.
	 * @param string           $value   What the answer says.
	 */
	private function answer_seed( array $message, int $type, string $value ): void {
		$message[ Message::TYPE ]  = $type;
		$message[ Message::TO ]    = '';
		$message[ Message::VALUE ] = $value;
		parent::fill( $message );
	}

	/**
	 * A seed as a link to itself: resolved, normalized and kept on its own
	 * origin, so it and a page's link to the same url share one seen key.
	 *
	 * @param string $value The trimmed seed.
	 * @return string|null Null when it is not an absolute http(s) url, or holds whitespace.
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
	 * Discover what Curl's answer links to, send it to target, then settle its
	 * url and refill, so a forward that throws leaves the url for the next
	 * start.
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
		$this->frontier->settle( [ $url ] );
		$this->refill( tick: false );
	}

	/**
	 * `ADD` each url as seen and put the new ones in `pending`, unseeing them
	 * again when `pending` refuses.
	 *
	 * @param list<string> $urls   Absolute urls.
	 * @param ?bool        $failed Set true when the Table refused or left the `ADD` unanswered.
	 * @param-out bool     $failed
	 * @return list<string> The urls the Table reported new.
	 */
	private function discover( array $urls, ?bool &$failed = null ): array {
		$table = $this->sibling_name( self::SEEN );
		$new   = $this->tables->add_multi( $table, \array_fill_keys( $urls, [ '1' ] ), $failed );
		if ( [] === $new ) {
			return $new;
		}
		if ( $this->frontier->add( \array_fill_keys( $new, 1 ) ) ) {
			return $new;
		}
		$stuck = \array_diff( $new, $this->tables->remove( $table, $new ) );
		$this->print_less_often( 'WARNING: pending took no new url; their seen keys are removed' );
		if ( [] !== $stuck ) {
			$this->print_less_often( 'WARNING: urls pending refused stay seen until their ttl lapses: ', \implode( ' ', $stuck ) );
		}
		return $new;
	}

	/**
	 * Inside a running event loop, hand Curl as many urls as `concurrency`
	 * leaves free slots for once half the window or all of it is free, or
	 * under a delay one url a tick.
	 *
	 * @param bool $tick Whether the timer asks, rather than a seed or an answer.
	 * @throws \LogicException When the Curl sibling was never built.
	 */
	private function refill( bool $tick ): void {
		$paced = 0 < $this->delay_ms;
		if ( $paced && ! $tick ) {
			return;
		}
		// Tick jitter takes a tenth of a tick, as Timer_Node's slack does.
		if ( $paced && 'router' === $this->mode && Core::$now - $this->last_start < ( $this->delay_ms - self::TICK_MS / 10 ) / 1000 ) {
			$this->mark_due();
			return;
		}
		if ( $this->refilling || ! Event_Framework::instance()->is_running() ) {
			return;
		}
		$curl      = $this->curl ?? throw new \LogicException( \esc_html( "Crawler {$this->name} has no siblings; arguments() builds them" ) );
		$in_flight = $curl->transfers_in_flight();
		$window    = $paced ? 1 : $this->concurrency;
		$free      = \min( $window, $this->concurrency - $in_flight );
		if ( 0 < $in_flight && 2 * $free < $window ) {
			return;
		}
		$this->refilling = true;
		try {
			foreach ( $this->frontier->take( $free ) as [ $url ] ) {
				$this->last_start = Core::$now;
				$curl->fill( $this->fetch_message( $url ) );
			}
		} finally {
			$this->refilling = false;
		}
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
		$this->curl = null;
		$this->frontier->restart();
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
		$curl->arguments( '' === $this->vault_group ? [] : [ $this->vault_group ] );
		$curl->follow_redirects( false );
		$this->publish_sibling( 'curl', $curl );
		$curl->sink( $this->sink );
		$curl->target( $this->name );
		return $curl;
	}

	/** On a clean stop, remove the answered urls from `inflight`, so the next process fetches none again. */
	public function shutdown_sweep(): void {
		$this->frontier->flush();
	}

	/**
	 * Topology console manifest.
	 *
	 * @return array<string,mixed>
	 */
	public static function node_schema(): array {
		return [
			'category'    => 'I/O',
			'description' => 'Crawl from each seed url: fetch it, send every answer to target with KEY set to the url, and follow the links on its origin, each once per ttl; a seed already seen answers a TM_INFO.',
			'has_target'  => true,
			// The Table owned_table() declares, which the analyzer reads.
			'owns'        => [ self::SEEN => 'Table' ],
			'arguments'   => [
				[ 'name' => 'ttl', 'type' => 'int', 'required' => true, 'description' => 'Seconds a url counts as seen, at least 1; it may be crawled again after.' ],
				[ 'name' => 'vault_group', 'type' => 'vault_group', 'default' => '', 'description' => 'Optional Vault group: each url is fetched with the credential of the group entry on its origin, if any.' ],
				[ 'name' => 'delay_ms', 'type' => 'int', 'default' => 0, 'description' => 'Least milliseconds between two fetch starts, 0 or at least ' . self::MIN_DELAY_MS . '; 0 starts each as a slot frees.' ],
				[ 'name' => 'concurrency', 'type' => 'int', 'default' => 1, 'description' => 'Most fetches in flight at once, from 1 to ' . Curl_Node::MAX_IN_FLIGHT . '.' ],
			],
			'commands'    => [],
		];
	}
}
