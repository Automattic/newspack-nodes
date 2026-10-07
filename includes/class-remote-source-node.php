<?php
/**
 * Remote_Source: one SSE connection to a spoke, carrying a durable reader per stream.
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes;

use Newspack_Nodes\Rest\SSE_Out_Node;

\defined( 'ABSPATH' ) || exit;

/**
 * An SSE-pull broker: Tachikoma's ConsumerBroker shape over the wire. One
 * connection to a spoke carries every stream its `<source>:<target>` pairs
 * name, and each stamp it carries is read by its own `Remote_Consumer_Node`,
 * published as the sibling `<broker>:<kind>` — the cursor, offsetlog, dead
 * letters and debugger all belong to that reader.
 *
 * The channel comes from `Remote_Link_Node`: the `SSE_In` and `HTTP_Out`
 * patrons, the heartbeat, the reconnect and the status snapshot. This class
 * adds the routing between them and the readers. `SSE_In` hands each raw `msg`
 * payload to `route()`, which reads its FROM stamp and hands it to the reader
 * the first matching pair owns, building that reader on first sight. A connect
 * asks each live reader where its stream stands; a paused reader drops out of
 * the request and steps through `request_read()` over the HTTP_Out instead.
 * One valve meters the whole connection, on the bytes every reader holds.
 *
 * Credentials and URL come from the Vault entry the `<vault-id>` argument names; a
 * missing entry leaves the node disconnected rather than building mis-configured
 * patrons.
 */
class Remote_Source_Node extends Remote_Link_Node {
	use Fanout_Targets;

	/** Memcache TTL for the status snapshot (seconds). */
	public const STATUS_TTL = 300;

	/**
	 * SSE backpressure valve water marks: re-arm at 256 KB, disarm at 512 KB.
	 *
	 * The readers drain between arrivals, so their buffers accumulate in route():
	 * disarm once the sum crosses the high mark, re-arm once their drains bring
	 * it back under the low one. The hysteresis is what keeps the valve OPEN
	 * through normal flow. A single threshold closes it on every buffered line and
	 * stop-starts the spoke, which is what makes a hub-aggregation pull lag.
	 */
	private const PUMP_ARM_BYTES    = 262144;
	private const PUMP_DISARM_BYTES = 524288;

	/**
	 * The most stamps a broker's glob pairs claim, counting the readers built
	 * in this process and the reader dirs a glob pair left under the offsetlog
	 * root in an earlier one. A spoke names its stamps, so without it a glob
	 * would build a reader and its nodes for every stamp a spoke invents, and
	 * leave a cursor dir for each across restarts. An exact pair is bounded by
	 * configuration and never counts. One broker carries one spoke's streams,
	 * and a glob over a topic claims one stamp per partition: the cap is the
	 * `num_partitions` maximum, 16, times a 16× margin for globs.
	 */
	public const MAX_READERS = 256;

	/** Wall-second of the last heartbeat reply; 0 while none has come back. */
	private int $last_heartbeat_response = 0;

	/** Reason the last heartbeat failed, published as `last_error`; null on success. */
	private ?string $last_heartbeat_error = null;

	/** Mirror of the SSE_In valve state: true while armed. Only the readers' bytes flip it. */
	private bool $pump_armed = true;

	/**
	 * Whether the spoke logs this pulls are appended by more than one process
	 * (the firehose is, from every request). Unlike Consumer's flag of the same
	 * name it configures the reader on the OTHER end — a pull source has no
	 * segments of its own — because that is where the read happens. The spoke
	 * cannot decide for itself: which of its logs are shared lives in a topology
	 * line, and the SSE endpoint opens Consumers with no topology in the picture.
	 *
	 * Protected, like Consumer's: the inherited `dump_toggles()` reads it.
	 */
	protected bool $multi_writer = false;

	/** @var list<array{source:string,target:string}> The pairs this broker carries, in declaration order. */
	private array $pairs = [];

	/** The worker partition this broker runs in, bound at load as Table_Node binds it; null outside a worker, which publishes no status. */
	private ?int $bound_partition = null;

	/** @var array<string,Remote_Consumer_Node> The readers, by stamp, in the order they were built. */
	private array $consumers = [];

	/**
	 * The kinds a glob pair has claimed, each with a reader here or a dir under
	 * the offsetlog root; null until a glob first builds after construction or
	 * a replay, which counts both again.
	 *
	 * @var array<string,true>|null
	 */
	private ?array $glob_kinds = null;

	/** Root under which each reader's offsetlog sits, at `<root>/<kind>`. */
	protected string $offsetlog_root = '';

	/** Root under which each reader's dead letters sit, at `<root>/<kind>`. */
	protected string $deadletter_root = '';

	/** Fanned out to every reader, present or built later. */
	protected bool $assume_clean_shutdown = false;

	/** Tachikoma-parity: no-arg ctor. Auto-wire the `{name}:config` interpreter for the verb table. */
	public function __construct() {
		parent::__construct();
		$this->auto_wire_interpreter();
	}

	/**
	 * Parse `<vault_id> <offsetlog_root> <deadletter_root> <source:target>…`
	 * through the link, which arms the tick, then reconcile the readers with a
	 * replay. A reader no pair matches any more hands its cursor off and is
	 * retracted; each survivor takes its owning pair's target, and its dirs
	 * when the roots moved. A changed pair list restarts the stream, so the
	 * next request states the new set.
	 *
	 * @api Dynamic entrypoint.
	 * @param list<string>|null $args Positional tokens, or null to read them.
	 * @return list<string>
	 * @throws \InvalidArgumentException When a pair is malformed or none is named.
	 */
	public function arguments( ?array $args = null ): array {
		if ( null === $args ) {
			return parent::arguments();
		}
		$pairs = \array_map( self::parse_pair( ... ), \array_slice( $args, 3 ) );
		if ( [] === $pairs ) {
			throw new \InvalidArgumentException( 'Remote_Source: name at least one <source>:<target> pair' );
		}
		$previous              = $this->pairs;
		$parsed                = parent::arguments( $args );
		$this->bound_partition = \array_key_exists( 'partition', Core::$var ) ? Core::canonical_decimal( Core::$var['partition'] ) : null;
		$this->pairs           = $pairs;
		$this->glob_kinds      = null;
		foreach ( $this->consumers as $stamp => $child ) {
			$pair = $this->pair_for( $stamp );
			if ( null === $pair ) {
				$child->hand_off_cursor();
				$this->retract_sibling( Remote_Consumer_Node::kind_of( $stamp ) );
				unset( $this->consumers[ $stamp ] );
				continue;
			}
			$child->connect_node( $pair['target'] );
			if ( $this->reader_args( $stamp ) !== $child->arguments() ) {
				$child->arguments( $this->reader_args( $stamp ) );
			}
		}
		if ( $previous !== $this->pairs ) {
			$this->restream();
		}
		return $parsed;
	}

	/**
	 * What the next connect asks for: each exact pair whose reader is live,
	 * from that reader's own position, and each glob, with every reader it
	 * already owns stated — a paused one as `SSE_Out_Node::SKIP`, so the glob
	 * keeps finding new dirs while that one stays out. A new stream opens with
	 * its valve armed.
	 *
	 * @return array{0:list<string>,1:array<string,array{segment?:int,offset:int}|int|string>} Subscriptions, then per-stamp positions.
	 */
	protected function stream_request(): array {
		$this->pump_armed = true;
		$subscribe        = [];
		$positions        = [];
		foreach ( $this->pairs as $pair ) {
			$source = $pair['source'];
			if ( ! \str_contains( $source, '*' ) ) {
				$child = $this->consumer_for( $source );
				if ( null !== $child && $child->is_live() ) {
					$subscribe[]          = $source;
					$positions[ $source ] = $child->connect_position();
				}
				continue;
			}
			$subscribe[] = $source;
			foreach ( $this->consumers as $stamp => $child ) {
				if ( $this->pair_for( $stamp ) === $pair ) {
					$positions[ $stamp ] = $child->is_live() ? $child->connect_position() : SSE_Out_Node::SKIP;
				}
			}
		}
		return [ $subscribe, $positions ];
	}

	/**
	 * Connect while any exact pair's reader is live, or any glob may yet find a
	 * dir. Every exact pair is visited, so each one's reader exists from the
	 * first tick.
	 */
	protected function should_connect(): bool {
		$connect = false;
		foreach ( $this->pairs as [ 'source' => $source ] ) {
			$live    = \str_contains( $source, '*' ) || ( $this->consumer_for( $source )?->is_live() ?? false );
			$connect = $connect || $live;
		}
		return $connect;
	}

	/** Stamp the heartbeat send-time so record_heartbeat_reply() can compute the round-trip. */
	protected function record_heartbeat_sent( int $now ): void {
		$this->write_status( [ 'last_heartbeat_sent' => $now ] );
	}

	/**
	 * Record a heartbeat reply's round-trip into the status snapshot and clear the stored
	 * failure. `last_error` is republished from SSE_In's connection rather than blanked,
	 * because the stream can be down while the command channel still answers, and the
	 * dashboard badge has to say so.
	 */
	protected function record_heartbeat_reply(): void {
		if ( 0 === $this->last_heartbeat_sent ) {
			return;
		}
		$now                           = (int) Core::$now;
		$this->last_heartbeat_response = $now;
		$this->last_heartbeat_error    = null;
		$connection_error = null !== $this->sse_in
			? $this->sse_in->connection()['last_error']
			: null;
		$this->write_status( [
			'last_heartbeat_response' => $now,
			'last_heartbeat_rtt'      => $now - $this->last_heartbeat_sent,
			'last_error'              => $connection_error,
		] );
	}

	/** Clear a prior success immediately and retain the spoke's safe failure reason. */
	protected function record_heartbeat_failure( string $reason ): void {
		$this->last_heartbeat_response = 0;
		$this->last_heartbeat_error    = 'Client heartbeat failed: ' . $reason;
		$this->write_status( [
			'last_heartbeat_response' => null,
			'last_heartbeat_rtt'      => null,
			'last_error'              => $this->last_heartbeat_error,
		] );
	}

	/**
	 * Publish the connection-state snapshot from SSE_In::connection(). Ages out the heartbeat
	 * round-trip so the dashboard's Status badge can't latch 'success' on a stale timestamp: the
	 * response is "live" only while connected AND seen within the node's HEARTBEAT_INTERVAL*4
	 * window, and is nulled otherwise. While it IS live the two keys are left out of the
	 * write, so what record_heartbeat_reply() merged stands.
	 */
	protected function publish_status(): void {
		$conn = null !== $this->sse_in
			? $this->sse_in->connection()
			: [ 'connected' => false, 'connecting' => false, 'last_http_code' => null, 'last_error' => null, 'current_backoff' => SSE_In_Node::INITIAL_BACKOFF, 'last_sse_heartbeat' => null, 'last_attempt' => null, 'scheduled_reconnect_at' => null, 'unparseable_lines' => 0 ];
		$data = [
			'last_connection_attempt' => $conn['last_attempt'],
			'connected'               => $conn['connected'],
			// A socket mid-open: neither up nor a failure to rail red.
			'connecting'              => $conn['connecting'],
			'last_http_code'          => $conn['last_http_code'],
			'last_error'              => $conn['last_error'] ?? $this->last_heartbeat_error,
			'current_backoff'         => $conn['current_backoff'],
			'last_sse_heartbeat'      => $conn['last_sse_heartbeat'],
			// The dashboard's idle reading: closed on purpose, back at T.
			'scheduled_reconnect_at'  => $conn['scheduled_reconnect_at'],
			// Torn spoke lines this stream skipped; the pull itself stays up.
			'unparseable_lines'       => $conn['unparseable_lines'],
		];
		// Live only while connected AND the response is within slot-TTL window.
		$hb_live = $conn['connected']
			&& $this->last_heartbeat_response > 0
			&& ( (int) Core::$now - $this->last_heartbeat_response ) <= self::HEARTBEAT_INTERVAL * 4;
		if ( ! $hb_live ) {
			$data['last_heartbeat_response'] = null;
			$data['last_heartbeat_rtt']      = null;
		}
		$data['streams'] = \array_map( static fn ( Remote_Consumer_Node $child ): array => $child->stream_status(), $this->consumers );
		$this->write_status( $data );
	}

	/**
	 * Merge $data into the status snapshot under the per-node key.
	 *
	 * @param array<string,mixed> $data Fields to merge over whatever the snapshot holds.
	 */
	private function write_status( array $data ): void {
		$cache = Cache_Backend::shared_first();
		if ( null === $cache || null === $this->bound_partition ) {
			return;
		}
		$key      = self::status_key_for( $this->name, $this->bound_partition );
		$existing = $cache->get( $key );
		if ( ! \is_array( $existing ) ) {
			$existing = [];
		}
		$cache->set( $key, \array_merge( $existing, $data ), self::STATUS_TTL );
	}

	/**
	 * The cache key one broker publishes its status snapshot under: by NODE
	 * NAME, so two spokes do not collide; by worker PARTITION, because the same
	 * broker line runs once per partition; site-scoped, so two hubs naming a
	 * spoke alike do not either. Public because Aggregator_CI resolves the
	 * writer's exact key through it.
	 *
	 * @param string $name      The broker's name.
	 * @param int    $partition The worker partition it runs in.
	 */
	public static function status_key_for( string $name, int $partition ): string {
		return Cache_Backend::site_key( "remote:{$name}:p{$partition}" );
	}

	/**
	 * Send one reader's step to the spoke as `read_message <stamp> <position>`,
	 * from the reader's own name, so the reply returns to it by TO through this
	 * link's HTTP_Out (whose allowlist names every reader) and `_router`. A spoke
	 * this link holds no session with gets asked for one, and the reader retries.
	 *
	 * @param Remote_Consumer_Node $child    The paused reader.
	 * @param string               $position Where it reads, in `read_message`'s position grammar.
	 * @return bool True once the command is queued.
	 */
	public function request_read( Remote_Consumer_Node $child, string $position ): bool {
		$this->ensure_patrons();
		$http = $this->http_out;
		if ( null === $http ) {
			return false;
		}
		$spoke = $http->vault_id();
		if ( ! Command_Auth::has_session( $spoke ) ) {
			$http->ensure_session();
			return false;
		}
		$message                   = Message::new_message();
		$message[ Message::TYPE ]  = Message::TM_COMMAND;
		$message[ Message::FROM ]  = $child->name();
		$message[ Message::TO ]    = Remote_Consumer_Node::STEP_SERVICE;
		$message[ Message::VALUE ] = [
			'name'      => 'read_message',
			'arguments' => [ $child->stamp(), $position ],
		];
		Command_Auth::sign_for( $spoke, $message );
		$http->fill( $message );
		return true;
	}

	/**
	 * Build the base patrons, seed the seal-grace flag onto SSE_In (an aggregator configures its
	 * spokes before anything connects, so a patron built after the verb still has to carry it),
	 * then wire SSE_In's seams to the readers: the handshake and skip frames hand each stamp's
	 * cursor to the reader that owns it, and each raw `msg` payload goes through `route()`.
	 * HTTP_Out admits each reader's step reply by its name.
	 *
	 * @return SSE_In_Node|null The SSE_In patron once configured, else null.
	 */
	protected function ensure_patrons(): ?SSE_In_Node {
		$sse = parent::ensure_patrons();
		if ( null === $sse ) {
			return null;
		}
		$sse->set_multi_writer( $this->multi_writer );
		$sse->on_connected = function ( array $cursors ): void {
			/** @var array<string,array{segment?:int,offset:int}> $cursors */
			foreach ( $cursors as $stamp => $cursor ) {
				$this->consumer_for( $stamp )?->adopt_stream_start( $cursor );
			}
		};
		$sse->on_skipped = function ( array $cursors ): void {
			/** @var array<string,array{segment?:int,offset:int}> $cursors */
			foreach ( $cursors as $stamp => $cursor ) {
				( $this->consumers[ $stamp ] ?? null )?->skip_to( $cursor );
			}
		};
		$sse->on_message = function ( string $raw ): void {
			$this->route( $raw );
		};
		foreach ( $this->consumers as $child ) {
			$this->http_out?->allow_replies_to( $child->name() );
		}
		return $sse;
	}

	/**
	 * Route one raw `msg` payload, with its decoded message, to the reader its
	 * FROM stamp names. A frame that will not unpack has nothing to route by
	 * and is dropped, rate-limited; `consumer_for()` refuses the rest.
	 *
	 * @param string $raw One packed record.
	 */
	private function route( string $raw ): void {
		try {
			$message = Message::unpacked( $raw );
		} catch ( \InvalidArgumentException $e ) {
			$this->print_less_often( 'dropping unparseable SSE frame' );
			return;
		}
		$child = $this->consumer_for( Log_Discovery::dir_from_stamp( Core::as_string( $message[ Message::FROM ] ) ) );
		if ( null === $child ) {
			return;
		}
		$child->receive( $raw, $message );
		$this->pump_maybe_disarm();
	}

	/**
	 * The reader for a stamp, built on first sight when a pair claims it; null
	 * when none does. A spoke names the stamps it sends, in a line's FROM and
	 * its handshake's CURSORS alike, and a stamp names a sibling slot and a
	 * directory here, so the one builder refuses four, rate-limited: a stamp
	 * outside the stream name grammar, one naming a slot the broker keeps, one
	 * no pair claims, and a glob's past `MAX_READERS`.
	 *
	 * @param string $stamp A record's stamp.
	 */
	private function consumer_for( string $stamp ): ?Remote_Consumer_Node {
		if ( isset( $this->consumers[ $stamp ] ) ) {
			return $this->consumers[ $stamp ];
		}
		if ( '' === $this->name ) {
			return null;
		}
		if ( ! Log_Discovery::is_stamp( $stamp ) ) {
			$this->print_less_often( 'refusing a stamp outside the stream name grammar' );
			return null;
		}
		if ( self::is_reserved( $stamp ) ) {
			$this->print_less_often( 'refusing a stamp that names a slot the broker keeps: ', $stamp );
			return null;
		}
		$pair = $this->pair_for( $stamp );
		if ( null === $pair ) {
			$this->print_less_often( 'dropping a line no pair claims: ', $stamp );
			return null;
		}
		if ( \str_contains( $pair['source'], '*' ) && ! $this->claim_glob_kind( Remote_Consumer_Node::kind_of( $stamp ) ) ) {
			$this->print_less_often( 'refusing a reader past MAX_READERS: ', (string) self::MAX_READERS );
			return null;
		}
		$child = new Remote_Consumer_Node();
		$this->publish_sibling( Remote_Consumer_Node::kind_of( $stamp ), $child );
		$child->sink( $this->sink );
		$child->arguments( $this->reader_args( $stamp ) );
		$child->connect_node( $pair['target'] );
		$child->broker( $this );
		$child->set_assume_clean_shutdown( $this->assume_clean_shutdown );
		$this->http_out?->allow_replies_to( $child->name() );
		return $this->consumers[ $stamp ] = $child;
	}

	/**
	 * A reader's tokens: its stamp, then its offsetlog and dead-letter dirs,
	 * each nested under the broker's root at the stamp's kind.
	 *
	 * @param string $stamp A record's stamp.
	 * @return list<string>
	 */
	private function reader_args( string $stamp ): array {
		$kind = Remote_Consumer_Node::kind_of( $stamp );
		return [ $stamp, "{$this->offsetlog_root}/{$kind}", "{$this->deadletter_root}/{$kind}" ];
	}

	/** Close the valve once the readers' backlog crosses the high-water mark. */
	private function pump_maybe_disarm(): void {
		if ( $this->pump_armed && $this->buffered_bytes() >= self::PUMP_DISARM_BYTES ) {
			$this->sse_in?->disarm();
			$this->pump_armed = false;
		}
	}

	/** Re-open the valve once the readers have drained below the low-water mark (from each reader's refill). */
	public function pump_maybe_arm(): void {
		if ( ! $this->pump_armed && $this->buffered_bytes() <= self::PUMP_ARM_BYTES ) {
			$this->sse_in?->arm();
			$this->pump_armed = true;
		}
	}

	/** Bytes buffered across every reader: one connection, one valve. */
	private function buffered_bytes(): int {
		$bytes = 0;
		foreach ( $this->consumers as $child ) {
			$bytes += $child->buffered_bytes();
		}
		return $bytes;
	}

	/**
	 * Restart the stream so the next request states the live set again. The
	 * tick queues the reconnect, so readers that pause in one tick share one.
	 */
	public function restream(): void {
		$this->drop_stream();
	}

	/**
	 * Ask the spoke to read every stream with the multi-writer seal-grace
	 * (`Consumer_Node::SEAL_GRACE_SECONDS`): a peer there can keep appending to
	 * segment N for `Partition_Node::DRIFT_RESCAN_INTERVAL_SECONDS` after N+1
	 * appears, and a reader that advances on sight orphans that straggler —
	 * for the firehose, typically a request's terminal `process (complete)`,
	 * which then never finalizes here.
	 *
	 * The grace rides a connect-time query parameter, so a CHANGE drops the live
	 * stream through drop_stream(), and the tick reconnects past what is buffered.
	 *
	 * @param bool $flag Whether the spoke should apply the seal-grace.
	 */
	public function set_multi_writer( bool $flag ): void {
		$changed            = $flag !== $this->multi_writer;
		$this->multi_writer = $flag;
		if ( null === $this->sse_in || ! $changed ) {
			return;
		}
		$this->sse_in->set_multi_writer( $flag );
		$this->drop_stream();
	}

	/** Drop the live stream; what it left buffered still drains. */
	private function drop_stream(): void {
		$this->sse_in?->disconnect();
	}

	/**
	 * Every well-formed pair among `$tokens`, for a reader of the topology that
	 * must not fail on a line the runtime would refuse.
	 *
	 * @param list<string> $tokens Pair tokens.
	 * @return list<array{source:string,target:string}>
	 */
	public static function pairs_of( array $tokens ): array {
		$pairs = [];
		foreach ( $tokens as $token ) {
			try {
				$pairs[] = self::parse_pair( $token );
			} catch ( \InvalidArgumentException $e ) {
				continue;
			}
		}
		return $pairs;
	}

	/**
	 * Read one `<source>:<target>` token on its FIRST colon: a source never
	 * carries one (a partition dir or `sources/<name>`), a target may
	 * (`php-errors:partition`). A source no spoke could stream is refused
	 * here, at configuration, rather than failing quietly on every connect.
	 *
	 * @param string $token One pair token.
	 * @return array{source:string,target:string}
	 * @throws \InvalidArgumentException When either half is empty, or the source is no subscription.
	 */
	public static function parse_pair( string $token ): array {
		[ 'source' => $source, 'target' => $target ] = self::split_pair( $token );
		if ( '' === $source || '' === $target ) {
			// phpcs:ignore WordPress.Security.EscapeOutput.ExceptionNotEscaped -- plain-text message for log/CLI consumers; escape at the view, not the runtime.
			throw new \InvalidArgumentException( "Remote_Source: a pair is <source>:<target>, got '{$token}'" );
		}
		// An exact source is the stamp of the one stream it carries.
		$glob = \str_contains( $source, '*' );
		if ( ! ( $glob ? Log_Discovery::is_subscription( $source ) : Log_Discovery::is_stamp( $source ) ) ) {
			// phpcs:ignore WordPress.Security.EscapeOutput.ExceptionNotEscaped -- plain-text message for log/CLI consumers; escape at the view, not the runtime.
			throw new \InvalidArgumentException( "Remote_Source: pair names a source no spoke can stream: '{$token}'" );
		}
		if ( ! $glob && self::is_reserved( $source ) ) {
			// phpcs:ignore WordPress.Security.EscapeOutput.ExceptionNotEscaped -- plain-text message for log/CLI consumers; escape at the view, not the runtime.
			throw new \InvalidArgumentException( "Remote_Source: pair's reader names a slot the broker keeps: '{$token}'" );
		}
		return [ 'source' => $source, 'target' => $target ];
	}

	/**
	 * Split a token at its first colon outside `<…>`, so a `<ns:key>` config
	 * token in the source stays whole. A token with no such colon is all
	 * source; this validates nothing, as `parse_pair()` does.
	 *
	 * @param string $token One pair token.
	 * @return array{source:string,target:string}
	 */
	public static function split_pair( string $token ): array {
		$depth = 0;
		foreach ( \str_split( $token ) as $at => $char ) {
			if ( '<' === $char ) {
				++$depth;
			} elseif ( '>' === $char && $depth > 0 ) {
				--$depth;
			} elseif ( ':' === $char && 0 === $depth ) {
				return [
					'source' => \substr( $token, 0, $at ),
					'target' => \substr( $token, $at + 1 ),
				];
			}
		}
		return [ 'source' => $token, 'target' => '' ];
	}

	/**
	 * Whether a stamp's reader would take a sibling slot the broker publishes
	 * itself, which `publish_sibling()` refuses.
	 *
	 * @param string $stamp A record's stamp.
	 */
	private static function is_reserved( string $stamp ): bool {
		return \in_array( Remote_Consumer_Node::kind_of( $stamp ), self::RESERVED_KINDS, true );
	}

	/**
	 * Claim a kind for a glob pair's reader: free when the kind holds a reader
	 * or a dir already, refused once `MAX_READERS` kinds are claimed. The
	 * first claim, after construction or a replay, counts the glob readers
	 * built here and the kind dirs a glob pair left under the offsetlog root,
	 * so the cap holds across a replay and a restart alike.
	 *
	 * @param string $kind The kind the reader would take.
	 * @return bool True when the reader may be built.
	 */
	private function claim_glob_kind( string $kind ): bool {
		$this->glob_kinds ??= $this->claimed_glob_kinds();
		if ( ! isset( $this->glob_kinds[ $kind ] ) ) {
			if ( \count( $this->glob_kinds ) >= self::MAX_READERS ) {
				return false;
			}
			$this->glob_kinds[ $kind ] = true;
		}
		return true;
	}

	/**
	 * The kinds a glob pair claims, among the readers built here and the kind
	 * dirs under the offsetlog root. A reader with no checkpoint yet has no
	 * dir, so the readers count as well as the disk.
	 *
	 * @return array<string,true>
	 */
	private function claimed_glob_kinds(): array {
		$stamps = [];
		foreach ( $this->consumers as $stamp => $child ) {
			$stamps[] = $stamp;
		}
		foreach ( \glob( "{$this->offsetlog_root}/*", \GLOB_ONLYDIR ) ?: [] as $dir ) {
			// A stamp holds no `:`, so the kind's `:` spells its `/`.
			$stamps[] = \str_replace( ':', '/', \basename( $dir ) );
		}
		$kinds = [];
		foreach ( $stamps as $stamp ) {
			$pair = $this->pair_for( $stamp );
			if ( null !== $pair && \str_contains( $pair['source'], '*' ) ) {
				$kinds[ Remote_Consumer_Node::kind_of( $stamp ) ] = true;
			}
		}
		return $kinds;
	}

	/**
	 * The first pair, in declaration order, whose source is the stamp or a glob
	 * matching it.
	 *
	 * @param string $stamp A record's stamp.
	 * @return array{source:string,target:string}|null
	 */
	private function pair_for( string $stamp ): ?array {
		foreach ( $this->pairs as $pair ) {
			if ( Log_Discovery::carries( $pair['source'], $stamp ) ) {
				return $pair;
			}
		}
		return null;
	}

	/**
	 * Rename the readers through the base, then admit each one's step replies
	 * by its new name.
	 */
	protected function set_sibling_names(): void {
		parent::set_sibling_names();
		foreach ( $this->consumers as $child ) {
			$this->http_out?->allow_replies_to( $child->name() );
		}
	}

	/**
	 * Fan `assume_clean_shutdown` out to every reader, and to each one built later.
	 *
	 * @param bool $flag True commits past a stopped message on a cooperative stop.
	 */
	public function set_assume_clean_shutdown( bool $flag ): void {
		$this->assume_clean_shutdown = $flag;
		foreach ( $this->consumers as $child ) {
			$child->set_assume_clean_shutdown( $flag );
		}
	}

	/**
	 * An operational stop hands each reader's cursor off — the path a
	 * Vault_Group retraction takes. A cooperative one does nothing here: the
	 * worker's sweep reaches every reader itself, and a second strike would
	 * climb a healthy reader's attempts.
	 *
	 * @param string $stop_reason             `timeout` or `memory` for a cooperative stop.
	 * @param bool   $baseline_near_watermark Memory stop only.
	 * @throws \Throwable What the readers' handoffs threw, combined.
	 */
	public function hand_off_cursor( string $stop_reason = '', bool $baseline_near_watermark = false ): void {
		if ( 'timeout' === $stop_reason || 'memory' === $stop_reason ) {
			return;
		}
		Worker_Should_Stop::raise(
			Worker_Should_Stop::attempt_each( $this->consumers, static fn ( Remote_Consumer_Node $child ) => $child->checkpoint_shutdown() )
		);
	}

	/** @return array<string,Remote_Consumer_Node> The readers, by stamp. */
	public function consumers(): array {
		return $this->consumers;
	}

	/** Teardown: the base cascade removes every published reader with the transports. */
	public function remove_node(): void {
		parent::remove_node();
		$this->consumers = [];
	}

	/** Round-trip the toggles after the `make_node` line. */
	public function dump_config(): string {
		return parent::dump_config() . $this->dump_toggles();
	}

	/**
	 * Palette entry and configuration form: the vault and the two roots each
	 * reader's dirs nest under, then the pairs, and the two verbs that reach
	 * the whole connection.
	 *
	 * @api Dynamic entrypoint.
	 * @return array<string,mixed>
	 */
	public static function node_schema(): array {
		return \array_merge( parent::node_schema(), [
			// The parent hides itself; this subclass belongs in the palette.
			'category'    => 'I/O',
			'description' => 'SSE-pull broker: one connection to a spoke carrying several streams, a durable reader per `source:target` pair (Vault-resolved).',
			'arguments'   => [
				[ 'name' => 'vault_id',        'type' => 'vault_id', 'required' => true, 'description' => 'Which spoke to connect to — a Vault-registered server (URL + credentials).' ],
				[ 'name' => 'offsetlog_root',  'type' => 'string',   'required' => true, 'description' => 'Directory each reader\'s durable read-cursor offsetlog nests under, at <root>/<kind>. Carry `<topology>` so two fleets pulling one spoke keep separate cursors.' ],
				[ 'name' => 'deadletter_root', 'type' => 'string',   'required' => true, 'description' => 'Directory each reader\'s quarantined poison records nest under, at <root>/<kind>. Later tokens are `<source>:<target>` pairs: a spoke partition, glob or `sources/<name>`, then the node its lines go to.' ],
			],
			'commands'    => [
				[
					'name'        => 'set_multi_writer',
					'description' => 'Ask the spoke to read its logs with the multi-writer seal-grace (shared logs, e.g. the firehose).',
					'args'        => [
						[ 'name' => 'enabled', 'type' => 'bool', 'required' => false, 'description' => '1, true, yes or on enables; 0, false, no or off disables; any other word is refused.' ],
					],
					'toggle'      => 'multi_writer',
				],
				[
					...Remote_Consumer_Node::pump_verbs()[0],
					'description' => 'Treat a plain Worker_Should_Stop like Worker_Should_Stop_Clean in every reader — commit PAST the in-flight message on a cooperative stop instead of replaying it. For a durable-before-stop chain with no snapshot node (aggregator, Consumer→Partition, job-router). Only a true word enables.',
				],
			],
		] );
	}
}
