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
 *
 * @phpstan-import-type Stream_Request from Remote_Link_Node
 */
class Remote_Source_Node extends Remote_Link_Node {

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

	/** How much of a refused stamp its log line shows; a stamp's length is unbounded. */
	private const LOGGED_STAMP_BYTES = 200;

	/** Wall-second of the last heartbeat reply; 0 while none has come back. */
	private int $last_heartbeat_response = 0;

	/** Reason the last heartbeat failed, published as `last_error`; null on success. */
	private ?string $last_heartbeat_error = null;

	/**
	 * The status snapshot this broker last wrote: the one copy of what it
	 * publishes, so a write needs no read of the cache first.
	 *
	 * @var array<string,mixed>
	 */
	private array $status = [];

	/** Wall-second the snapshot was last written; 0 before the first write. */
	private int $status_written_at = 0;

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

	/** The topology this broker runs in, bound at load beside the partition; null outside a worker, whose readers report under no id. */
	private ?string $bound_topology = null;

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
	 * when the roots moved. A changed source list restarts the stream, so the
	 * next request states the new set; a changed target alone does not.
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
		$this->bound_partition = Core::bound_partition();
		$pairs                 = $this->owned_pairs( self::variadic_in( $args ) );
		$previous              = $this->pairs;
		$parsed                = parent::arguments( $args );
		$this->bound_topology  = Core::bound_topology();
		$this->pairs           = $pairs;
		$this->glob_kinds      = null;
		foreach ( $this->readers() as $stamp => $child ) {
			$pair = $this->pair_for( $stamp );
			if ( null === $pair ) {
				$child->hand_off_cursor();
				$this->retract_sibling( Log_Discovery::kind_of( $stamp ) );
				continue;
			}
			$child->connect_node( $pair['target'] );
			if ( $this->reader_args( $stamp ) !== $child->arguments() ) {
				$child->arguments( $this->reader_args( $stamp ) );
			}
			$child->broker( $this );
		}
		// A target names no stream: only a changed source list restreams.
		if ( \array_column( $previous, 'source' ) !== \array_column( $this->pairs, 'source' ) ) {
			$this->restream();
		}
		return $parsed;
	}

	/**
	 * The pairs this worker reads, each with `{partition}` resolved at its
	 * bound partition, and kept where `Core::owns()` holds for its source as
	 * written: a source naming no partition reads once per fleet, and
	 * elsewhere its pair builds no reader, joins no subscription and leaves no
	 * dir (ADR-33). Every pair is checked wherever it is skipped, so a bad one
	 * fails on every partition. Outside a worker a pair naming `{partition}`
	 * is refused, because no partition's log is that process's own.
	 *
	 * @param list<string> $tokens The pair tokens as written.
	 * @return list<array{source:string,target:string}>
	 * @throws \InvalidArgumentException When a pair is malformed, none is
	 *                                   named, or one names `{partition}`
	 *                                   where none is bound.
	 */
	private function owned_pairs( array $tokens ): array {
		if ( [] === $tokens ) {
			throw new \InvalidArgumentException( 'Remote_Source: name at least one <source>:<target> pair' );
		}
		$owned = [];
		foreach ( $tokens as $token ) {
			if ( null === $this->bound_partition && Core::has_partition_token( $token ) ) {
				// phpcs:ignore WordPress.Security.EscapeOutput.ExceptionNotEscaped -- plain-text message for log/CLI consumers; escape at the view, not the runtime.
				throw new \InvalidArgumentException( "Remote_Source: pair '{$token}' names " . Core::PARTITION_TOKEN . ', but no partition is bound' );
			}
			$written = self::split_pair( $token );
			$pair    = self::checked_pair(
				Core::resolve_partition_template( $written['source'], $this->bound_partition ?? 0 ),
				Core::resolve_partition_template( $written['target'], $this->bound_partition ?? 0 ),
				$token
			);
			if ( Core::owns( $written['source'], $this->bound_partition ) ) {
				$owned[] = $pair;
			}
		}
		return $owned;
	}

	/**
	 * What the next connect asks for: each exact pair whose reader is live,
	 * from that reader's own position, and each glob, with every reader it
	 * already owns stated — a paused one as `SSE_Out_Node::SKIP`, so the glob
	 * keeps finding new dirs while that one stays out. A new stream opens with
	 * its valve armed.
	 *
	 * @return Stream_Request Subscriptions, then per-stamp positions.
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
			foreach ( $this->readers() as $stamp => $child ) {
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
		$this->write_status( $data );
	}

	/**
	 * Merge $data into the status snapshot and write it under the per-node key
	 * when it changed, or once a `HEARTBEAT_INTERVAL` has run since the last
	 * write: a broker whose state stands still writes once a heartbeat rather
	 * than once a second, and a key the cache evicted or lost on a restart is
	 * back within one interval instead of reading as down.
	 *
	 * @param array<string,mixed> $data Fields to merge over the snapshot.
	 */
	private function write_status( array $data ): void {
		$cache = Cache_Backend::shared_first();
		if ( null === $cache || null === $this->bound_partition ) {
			return;
		}
		$status = \array_merge( $this->status, $data );
		$now    = (int) Core::$now;
		if ( $status === $this->status && $now - $this->status_written_at < self::HEARTBEAT_INTERVAL ) {
			return;
		}
		$cache->set( self::status_key_for( $this->name, $this->bound_partition ), $status, self::STATUS_TTL );
		$this->status            = $status;
		$this->status_written_at = $now;
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
	 * The two names a reader of this broker reports under on the probe log:
	 * SOURCE, the spoke's log as `Log_Discovery::remote_for()` names it, and
	 * READER, `reader_id()`, blank outside a worker, where the broker is bound
	 * to no topology or partition.
	 *
	 * @param string $stamp The reader's stamp.
	 * @return array{0:string,1:string} The SOURCE, then the READER.
	 */
	public function probe_names( string $stamp ): array {
		$kind   = Log_Discovery::kind_of( $stamp );
		$reader = null === $this->bound_topology || null === $this->bound_partition
			? ''
			: self::reader_id( $this->bound_topology, $this->name, $kind, $this->bound_partition );
		return [ Log_Discovery::remote_for( $this->vault_id, $stamp ), $reader ];
	}

	/**
	 * The id a broker's reader reports under on the probe log: its node name,
	 * `<broker>:<kind>`, scoped by the topology and spelled as a worker id at
	 * the worker partition the broker runs in, as a stock Consumer's offsetlog
	 * basename `<topology>.<log>.p{partition}` is. Two spokes' `firehose.p0`
	 * readers then key apart, `CLI::consumer_rows()` reads the partition back
	 * through `CLI::parse_worker_id()`, and a stale row of an active topology
	 * keeps its place. Public because `Aggregator_CI` matches the rows of each
	 * broker it reports through it, with the kind `Log_Discovery::remote_of()`
	 * reads off the row's SOURCE; the Workers dashboard's
	 * `reconstructWorkers()` composes it the same way.
	 *
	 * @param string $topology  The topology the broker runs in.
	 * @param string $broker    The broker's name.
	 * @param string $kind      The reader's kind, `Log_Discovery::kind_of()` of its stamp.
	 * @param int    $partition The worker partition the broker runs in.
	 */
	public static function reader_id( string $topology, string $broker, string $kind, int $partition ): string {
		return CLI::worker_id( "{$topology}." . self::sibling_name_of( $broker, $kind ), $partition );
	}

	/**
	 * Send one reader's step to the spoke as `read_message <stamp> <position>`,
	 * from the reader's own name, so the reply returns to it by TO through this
	 * link's HTTP_Out (whose allowlist names every reader) and `_router`. A spoke
	 * this link holds no session with gets asked for one on the link's own
	 * cadence, and the reader retries.
	 *
	 * @param Remote_Consumer_Node $child    The paused reader.
	 * @param string               $position Where it reads, in `read_message`'s position grammar.
	 * @return bool True once the command is queued.
	 */
	public function request_read( Remote_Consumer_Node $child, string $position ): bool {
		$this->ensure_patrons();
		$message = $this->mint( $child->name(), Remote_Consumer_Node::STEP_SERVICE, 'read_message', [ $child->stamp(), $position ] );
		if ( null === $message ) {
			return false;
		}
		$this->http_out?->fill( $message );
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
				$this->reader( $stamp )?->skip_to( $cursor );
			}
		};
		$sse->on_message = function ( string $raw ): void {
			$this->route( $raw );
		};
		foreach ( $this->readers() as $child ) {
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
		$built = $this->reader( $stamp );
		if ( null !== $built ) {
			return $built;
		}
		if ( '' === $this->name ) {
			return null;
		}
		if ( ! Log_Discovery::is_stamp( $stamp ) ) {
			$this->print_less_often( 'refusing a stamp outside the stream name grammar: ', self::loggable( $stamp ) );
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
		if ( \str_contains( $pair['source'], '*' ) && ! $this->claim_glob_kind( Log_Discovery::kind_of( $stamp ) ) ) {
			$this->print_less_often( 'refusing a reader past MAX_READERS: ', (string) self::MAX_READERS );
			return null;
		}
		$child = new Remote_Consumer_Node();
		$this->publish_sibling( Log_Discovery::kind_of( $stamp ), $child );
		$child->sink( $this->sink );
		$child->arguments( $this->reader_args( $stamp ) );
		$child->connect_node( $pair['target'] );
		$child->broker( $this );
		$child->set_assume_clean_shutdown( $this->assume_clean_shutdown );
		$this->http_out?->allow_replies_to( $child->name() );
		return $child;
	}

	/**
	 * A refused stamp as its log line shows it: quoted, so an empty one reads
	 * `""`, control bytes rendered by `Core::terminal_safe()`, and cut to
	 * LOGGED_STAMP_BYTES with its full length named.
	 *
	 * @param string $stamp The stamp a spoke sent.
	 */
	private static function loggable( string $stamp ): string {
		$length = \strlen( $stamp );
		$shown  = '"' . Core::terminal_safe( \substr( $stamp, 0, self::LOGGED_STAMP_BYTES ) ) . '"';
		return $length > self::LOGGED_STAMP_BYTES ? "{$shown} ({$length} bytes)" : $shown;
	}

	/**
	 * The reader a stamp's kind holds in the sibling map, or null; builds
	 * nothing, and a slot holding anything else is no reader.
	 *
	 * @param string $stamp A record's stamp.
	 */
	private function reader( string $stamp ): ?Remote_Consumer_Node {
		$sibling = $this->siblings()[ Log_Discovery::kind_of( $stamp ) ] ?? null;
		return $sibling instanceof Remote_Consumer_Node ? $sibling : null;
	}

	/**
	 * A reader's tokens: its stamp, then its offsetlog and dead-letter dirs,
	 * each nested under the broker's root at the stamp's kind.
	 *
	 * @param string $stamp A record's stamp.
	 * @return list<string>
	 */
	private function reader_args( string $stamp ): array {
		$kind = Log_Discovery::kind_of( $stamp );
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
		foreach ( $this->reader_walk() as $child ) {
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
		$stamps = \array_keys( $this->readers() );
		foreach ( \glob( "{$this->offsetlog_root}/*", \GLOB_ONLYDIR ) ?: [] as $dir ) {
			$stamps[] = Log_Discovery::stamp_of( \basename( $dir ) );
		}
		$kinds = [];
		foreach ( $stamps as $stamp ) {
			$pair = $this->pair_for( $stamp );
			if ( null !== $pair && \str_contains( $pair['source'], '*' ) ) {
				$kinds[ Log_Discovery::kind_of( $stamp ) ] = true;
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
	 * by its new name and hand it the names it reports under. A new name is a
	 * new status key, which the next tick writes.
	 */
	protected function set_sibling_names(): void {
		parent::set_sibling_names();
		$this->status_written_at = 0;
		foreach ( $this->readers() as $child ) {
			$this->http_out?->allow_replies_to( $child->name() );
			$child->broker( $this );
		}
	}

	/**
	 * Fan `assume_clean_shutdown` out to every reader, and to each one built later.
	 *
	 * @param bool $flag True commits past a stopped message on a cooperative stop.
	 */
	public function set_assume_clean_shutdown( bool $flag ): void {
		$this->assume_clean_shutdown = $flag;
		foreach ( $this->readers() as $child ) {
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
			Worker_Should_Stop::attempt_each( $this->readers(), static fn ( Remote_Consumer_Node $child ) => $child->checkpoint_shutdown() )
		);
	}

	/**
	 * Every reader the sibling map holds, by stamp, in the order they were
	 * built: the map is the one list of them.
	 *
	 * @return array<string,Remote_Consumer_Node>
	 */
	private function readers(): array {
		return \iterator_to_array( $this->reader_walk() );
	}

	/**
	 * The one walk of the sibling map for its readers, keyed by stamp; it
	 * builds nothing, so the valve's per-line sum pays for no array.
	 *
	 * @return \Generator<string,Remote_Consumer_Node>
	 */
	private function reader_walk(): \Generator {
		foreach ( $this->siblings() as $sibling ) {
			if ( $sibling instanceof Remote_Consumer_Node ) {
				yield $sibling->stamp() => $sibling;
			}
		}
	}

	/**
	 * Each pair's target, written through that pair's reader rather than a
	 * target of the broker's own, so the canvas and the analyzer draw one edge
	 * per pair. Only a pair `pairs_of()` accepts names one, so the graph shows
	 * no edge for a pair `make_node` refuses, and each target is as written.
	 *
	 * @param list<string> $args The `make_node` argument tokens, the name excluded.
	 * @return list<string>
	 */
	public static function declared_targets( array $args ): array {
		return \array_column( self::pairs_of( self::variadic_in( $args ) ), 'target' );
	}

	/**
	 * Every pair among `$tokens` the runtime would accept, split as written,
	 * for a reader of the topology that must not fail on a line the runtime
	 * would refuse. A token is judged with its `{partition}` and config tokens
	 * resolved, as the broker reads it, and kept with them, as the TSL names
	 * its nodes; a token already resolved reads the same either way.
	 *
	 * @param list<string> $tokens Pair tokens.
	 * @return list<array{source:string,target:string}>
	 */
	public static function pairs_of( array $tokens ): array {
		$pairs = [];
		foreach ( $tokens as $token ) {
			try {
				self::parse_pair( Core::resolve_partition_template( $token, 0 ) );
			} catch ( \InvalidArgumentException $e ) {
				continue;
			}
			$pairs[] = self::split_pair( $token );
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
		return self::checked_pair( $source, $target, $token );
	}

	/**
	 * Refuse a split pair `parse_pair()` would refuse, naming the token as
	 * written.
	 *
	 * @param string $source The source half.
	 * @param string $target The target half.
	 * @param string $token  The token the halves came from.
	 * @return array{source:string,target:string}
	 * @throws \InvalidArgumentException When either half is empty, or the source is no subscription.
	 */
	private static function checked_pair( string $source, string $target, string $token ): array {
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
	 * Whether a stamp's reader would take a sibling slot the broker publishes
	 * itself, which `publish_sibling()` refuses.
	 *
	 * @param string $stamp A record's stamp.
	 */
	private static function is_reserved( string $stamp ): bool {
		return \in_array( Log_Discovery::kind_of( $stamp ), self::RESERVED_KINDS, true );
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
			// Each pair names its destination, so Node refuses connect_node.
			'has_target'  => false,
			'description' => 'SSE-pull broker: one connection to a spoke carrying several streams, a durable reader per `source:target` pair (Vault-resolved).',
			'arguments'   => [
				[ 'name' => 'vault_id',        'type' => 'vault_id', 'required' => true, 'description' => 'Which spoke to connect to — a Vault-registered server (URL + credentials).' ],
				[ 'name' => 'offsetlog_root',  'type' => 'string',   'required' => true, 'partition' => 'bound', 'description' => 'Directory each reader\'s durable read-cursor offsetlog nests under, at <root>/<kind>. Carry `<topology>` so two fleets pulling one spoke keep separate cursors.' ],
				[ 'name' => 'deadletter_root', 'type' => 'string',   'required' => true, 'partition' => 'bound', 'description' => 'Directory each reader\'s quarantined poison records nest under, at <root>/<kind>.' ],
				[ 'name' => 'pairs', 'type' => 'string', 'required' => true, 'variadic' => true, 'description' => '`<source>:<target>` pairs: a spoke partition, glob or `sources/<name>`, then the node its lines go to.' ],
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
