<?php
/**
 * Consumer: partition-aware reader with offsetlog checkpointing.
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes;

if ( ! \defined( 'ABSPATH' ) ) {
	exit;
}

class Consumer_Node extends Timer_Node {
	use Schema_Reflection;

	public const OFFSETLOG_SEGMENT_SIZE = 65536;
	public const OFFSETLOG_NUM_SEGMENTS = 2;
	public const MAX_LINE_BUFFER_SIZE = 20971520;

	/**
	 * Bytes read per poll — one block, then yield the event loop (Tachikoma's
	 * BUFSIZ in Partition::process_get). A poll drains the buffer it already
	 * holds, reads ONE more block, and returns so other nodes get a turn.
	 */
	public const READ_BLOCK_BYTES = 65536;

	/** Memcache key prefix Consumer_Node uses to publish its live cursor (read by Workers_CI + CLI). */
	public const POSITION_KEY_PREFIX = 'np:pos:';

	/**
	 * Canonical `np:pos:{host}:{reader_id}` cursor cache key. `$reader_id` is the
	 * per-reader offset-dir name (`{source_basename}.p{N}`) — unique per Consumer,
	 * so two readers tailing the same log don't collide on a shared key.
	 */
	public static function position_key( string $host, string $reader_id ): string {
		return self::POSITION_KEY_PREFIX . "{$host}:{$reader_id}";
	}

	/**
	 * This reader's live-position cache key, keyed by its offset-dir name.
	 * Empty when ephemeral (no durable offsetlog) — publish_position skips it.
	 */
	public function position_cache_key( string $host ): string {
		if ( '' === $this->offsetlog_base_dir ) {
			return '';
		}
		return self::position_key( $host, \basename( $this->offsetlog_base_dir ) );
	}

	public const POLL_INTERVAL_EOF_MS = 100;

	/** 0 = next event-loop iteration. */
	public const POLL_INTERVAL_BUSY_MS = 0;

	public const CHECKPOINT_INTERVAL_S = 1;

	/** Position is a coarse liveness breadcrumb — publish at most once a second, not every tick. */
	public const PUBLISH_INTERVAL_S = 1;

	protected float $last_checkpoint = 0.0;
	protected float $last_publish    = 0.0;

	/**
	 * Per-tick dispatch (Tachikoma's `$self->{fill}` function pointer). arguments()
	 * points this at poll_init; the first poll loads the durable cursor + restores
	 * the snapshot — by which time the whole topology is built — then swaps to
	 * poll_active. Keeps construction free of I/O and forward-reference order.
	 */
	protected ?\Closure $poll_cb = null;

	/** Last (seg, off) committed; skip checkpoint if cursor hasn't advanced. */
	protected int $checkpoint_seg = -1;
	protected int $checkpoint_off = -1;

	protected string $source_base_dir = '';
	protected int $source_partition   = 0;
	/**
	 * Raw token assigned by parse_schema_args() — the override normalizes it
	 * (rtrim '/') into the derived $offsetlog_dir below.
	 */
	protected string $offsetlog_base_dir = '';
	protected string $offsetlog_dir      = '';
	protected ?Partition_Node $source    = null;
	/** Null when constructed with empty $offsetlog_base_dir (ephemeral readers skip durable cursors). */
	protected ?Partition_Node $offsetlog = null;

	/** FROM-stamp override; defaults to $this->name. The IPC input-Consumer stamps as `_repl`. */
	private string $stamp_override = '';

	/**
	 * Name of a node whose state rides in the offsetlog alongside the cursor
	 * (Tachikoma's snapshot cache). Empty = offset-only. Set via set_snapshot_node.
	 */
	private string $snapshot_node = '';

	/**
	 * Cache read from the offsetlog at construction but not yet restored — the
	 * snapshot node usually doesn't exist yet when load_offsetlog() runs, so we
	 * stash it and restore once set_snapshot_node() names the (now-built) node.
	 *
	 * @var array<array-key, mixed>|null
	 */
	private ?array $loaded_cache = null;

	/** Cursor segment. cursor_off + buffer length is the next read position. */
	protected int $cursor_seg = 0;

	/** Durable read offset for cursor_seg; always a line boundary (last fully-emitted line). */
	protected int $cursor_off = 0;

	/** Bytes read past cursor_off but not yet emitted (read-ahead + trailing partial). Tachikoma's buffer. */
	protected string $buffer = '';

	protected bool $at_eof = true;

	/** Tachikoma-parity: no-arg ctor. Positional config arrives via arguments(). */
	public function __construct() {
		parent::__construct();
		// Build the {name}:config interpreter from the schema commands, so the
		// set_snapshot_node verb is dispatchable; handlers read the patron lazily.
		$this->auto_wire_interpreter();
	}

	/**
	 * Store the raw string, parse positional tokens via parse_schema_args()
	 * (source_base_dir / source_partition / offsetlog_base_dir), then normalize,
	 * derive offsetlog_dir, materialize the source / offsetlog Partitions and seed
	 * the in-memory cursor from any existing offsetlog entries.
	 *
	 * @param string|null $args
	 * @return string
	 */
	public function arguments( ?string $args = null ): string {
		if ( null === $args ) {
			return parent::arguments();
		}
		$result = parent::arguments( $args );
		// Bare make_node: store the raw string but don't walk the schema or build children.
		if ( '' === $args ) {
			return $result;
		}
		$this->parse_schema_args( $args );
		$this->source_base_dir = \rtrim( $this->source_base_dir, '/' );
		$this->offsetlog_dir   = \rtrim( $this->offsetlog_base_dir, '/' );

		$this->source = new Partition_Node();
		if ( '' !== $this->name ) {
			$this->source->name( "{$this->name}:source" );
		}
		$this->source->arguments( "{$this->source_base_dir} {$this->source_partition}" );
		$this->source->sink( $this->sink );
		$this->source->patron( $this );

		if ( '' !== $this->offsetlog_dir ) {
			$this->offsetlog = new Partition_Node();
			if ( '' !== $this->name ) {
				$this->offsetlog->name( "{$this->name}:offsetlog" );
			}
			$this->offsetlog->arguments( implode( ' ', [ "{$this->offsetlog_dir}", 0, self::OFFSETLOG_SEGMENT_SIZE, self::OFFSETLOG_NUM_SEGMENTS ] ) );
			$this->offsetlog->sink( $this->sink );
			$this->offsetlog->patron( $this );
		} else {
			$this->offsetlog = null;
		}

		// No I/O at construction: the first poll loads the durable cursor and
		// restores the snapshot, once the whole topology graph exists.
		$this->poll_cb = $this->poll_init( ... );
		$this->set_timer( self::POLL_INTERVAL_EOF_MS, true );

		return $result;
	}

	/**
	 * Handle TM_REQUEST introspection verbs (reply TO=FROM); else defer to Timer.
	 */
	public function fill( array &$message ): void {
		$type_raw = $message[ Message::TYPE ];
		$type     = \is_numeric( $type_raw ) ? (int) $type_raw : 0;
		if ( $type & Message::TM_REQUEST ) {
			$this->handle_request( $message );
			return;
		}
		parent::fill( $message );
	}

	/** @param array<int, mixed> $message Incoming request Message. */
	private function handle_request( array $message ): void {
		if ( null === $this->sink ) {
			throw new \RuntimeException( 'Consumer::fill requires a wired sink' );
		}
		$value_raw = $message[ Message::VALUE ];
		$value     = \is_scalar( $value_raw ) ? (string) $value_raw : '';
		$verb      = \strtoupper( \explode( ' ', \trim( $value ), 2 )[0] );

		$payload = null;
		if ( 'GET_LAG' === $verb ) {
			$payload = $this->compute_lag();
		} elseif ( 'GET_OFFSET' === $verb ) {
			$payload = [
				'cursor_seg'         => $this->cursor_seg,
				'cursor_off'         => $this->cursor_off,
				'checkpoint_seg'     => $this->checkpoint_seg,
				'checkpoint_off'     => $this->checkpoint_off,
				'last_checkpoint_ts' => (int) $this->last_checkpoint,
			];
		} else {
			$payload = [ 'error' => "unknown request verb: {$verb}" ];
		}

		$reply                   = Message::new_message();
        $reply[ Message::TYPE ]  = Message::TM_STRUCT | Message::TM_RESPONSE;
		$reply[ Message::FROM ]  = '' !== $this->stamp_override ? $this->stamp_override : $this->name;
		$reply[ Message::TO ]    = $message[ Message::FROM ];
		$reply[ Message::ID ]    = $message[ Message::ID ];
		$reply[ Message::KEY ]   = $message[ Message::KEY ];
		$reply[ Message::VALUE ] = [ 'verb' => $verb, 'data' => $payload ];
		$this->sink->fill( $reply );
	}

	/** Timer-driven: poll, periodically publish position + checkpoint, then re-arm (busy/EOF cadence). */
	protected function fire(): void {
		$this->poll();
		// Position is a liveness breadcrumb, not a hot read — publish at most once a second.
		if ( ( Core::$now - $this->last_publish ) >= self::PUBLISH_INTERVAL_S ) {
			$this->publish_position();
			$this->last_publish = Core::$now;
		}
		// poll() updates the in-memory cursor every read; checkpoint() makes it durable.
		if (
			null !== $this->offsetlog
			&& ( Core::$now - $this->last_checkpoint ) >= self::CHECKPOINT_INTERVAL_S
		) {
			$this->checkpoint();
			$this->last_checkpoint = Core::$now;
		}
		$next_ms = $this->at_eof ? self::POLL_INTERVAL_EOF_MS : self::POLL_INTERVAL_BUSY_MS;
		$this->set_timer( $next_ms, true ); // oneshot — fire() re-arms.
	}

	/** One tick. Dispatches through poll_cb: poll_init on the first call, poll_active after. */
	public function poll(): void {
		( $this->poll_cb ?? ( $this->poll_cb = $this->poll_init( ... ) ) )();
	}

	/**
	 * INIT phase (Tachikoma's status INIT → ACTIVE): seed the durable cursor from
	 * the offsetlog and restore the snapshot node's state. Runs on the first poll —
	 * inside the drain loop, after the whole topology is built — so the snapshot
	 * node exists no matter what order the topology declared it. A durable
	 * checkpoint OVERRIDES any pre-poll next_offset() the caller set (resume wins);
	 * with no checkpoint, that seek stands. Then become the steady-state poller and
	 * fall through to it so this tick still does work.
	 */
	protected function poll_init(): void {
		$this->load_offsetlog();
		if ( null !== $this->loaded_cache && '' !== $this->snapshot_node ) {
			$node = Core::node( $this->snapshot_node );
			if ( null !== $node && \method_exists( $node, 'restore_state' ) ) {
				$node->restore_state( $this->loaded_cache );
			} else {
				$this->print_less_often( "Consumer: snapshot node '{$this->snapshot_node}' missing or has no restore_state(); discarding restored cache" );
			}
		}
		$this->loaded_cache = null;
		$this->poll_cb      = $this->poll_active( ... );
		( $this->poll_cb )();
	}

	/**
	 * ACTIVE phase, mirroring Tachikoma fire(): emit whatever is already buffered,
	 * then read ONE more block, then return so the event loop moves on. A message
	 * read this tick is emitted next tick — the buffer carries it across.
	 */
	protected function poll_active(): void {
		$this->drain_buffer();
		$this->get_batch();
	}

	/** Emit every complete line in $buffer; advance cursor_off past them; keep the trailing partial. */
	private function drain_buffer(): void {
		$nl = \strrpos( $this->buffer, "\n" );
		if ( false === $nl ) {
			// No complete line. DoS guard: a single line can't grow past MAX_LINE_BUFFER_SIZE.
			if ( \strlen( $this->buffer ) > self::MAX_LINE_BUFFER_SIZE ) {
				$this->print_less_often(
					\sprintf( 'Consumer: line buffer exceeded %d bytes at seg %d - discarding', self::MAX_LINE_BUFFER_SIZE, $this->cursor_seg )
				);
				$this->set_state( 'OVERFLOW', [ 'seg' => $this->cursor_seg, 'off' => $this->cursor_off, 'limit' => self::MAX_LINE_BUFFER_SIZE ] );
				$this->cursor_off += \strlen( $this->buffer ); // Skip the garbage so polls don't re-read it.
				$this->buffer      = '';
			}
			return;
		}
		$complete     = \substr( $this->buffer, 0, $nl + 1 );
		$this->buffer = \substr( $this->buffer, $nl + 1 );

		$consumed = 0;
		foreach ( \explode( "\n", \rtrim( $complete, "\n" ) ) as $line ) {
			$abs_offset = $this->cursor_off + $consumed;
			$line_size  = \strlen( $line ) + 1; // +1 for the consumed \n.
			$consumed  += $line_size;
			if ( $line_size > $this->largest_msg_sent ) {
				$this->largest_msg_sent = $line_size;
			}

			// Each line is a packed Message; unpack, stamp FROM, forward.
			try {
				$msg = Message::unpacked( $line );
			} catch ( \InvalidArgumentException $e ) {
				$this->print_less_often( "Consumer: skipping unparseable line: {$e->getMessage()}" );
				continue;
			}
			$stamp = '' !== $this->stamp_override ? $this->stamp_override : $this->name;
			if ( '' !== $stamp && ! $this->stamp_message( $msg, $stamp ) ) {
				continue; // FROM exceeded MAX_FROM_SIZE; drop_message handled.
			}
			// Position breadcrumb goes in ID; KEY must stay the producer's routing key.
			$msg[ Message::ID ] = "{$this->cursor_seg}:{$abs_offset}";
			parent::fill( $msg );
		}
		$this->cursor_off += $consumed;
	}

	/**
	 * Read at most one READ_BLOCK_BYTES block into $buffer (Tachikoma get_batch +
	 * Partition::process_get). Rolls to the next segment when the current one is
	 * drained, sets at_eof when caught up, and bounds a single oversized line.
	 */
	private function get_batch(): void {
		// Defeat the stat cache so growth from another process's writer is visible.
		\clearstatcache( true, $this->source()->partition_dir() );
		$segments = $this->source()->get_segments( true );
		if ( empty( $segments ) ) {
			$this->at_eof = true;
			return;
		}
		$this->normalize_cursor( $segments );

		$sizes       = \array_column( $segments, 'size', 'id' );
		$newest_id   = \end( $segments )['id'];
		$newest_size = \end( $segments )['size'];

		$seg_size = $sizes[ $this->cursor_seg ] ?? 0;
		$read_at  = $this->cursor_off + \strlen( $this->buffer );

		// Current segment fully read: step to the next live segment (one per poll) or rest at EOF.
		if ( $read_at >= $seg_size ) {
			$next = $this->next_segment_id( $segments, $this->cursor_seg );
			if ( null !== $next ) {
				$this->cursor_seg = $next;
				$this->cursor_off = 0;
				$this->buffer     = '';
				$this->at_eof     = false;
				$this->set_state( 'SEGMENT', $this->cursor_seg );
				return;
			}
			// Nothing more on disk. drain_buffer ran first this tick, so the buffer
			// holds at most a trailing partial (never a complete line) here.
			$this->at_eof = true;
			return;
		}

		$len   = \min( self::READ_BLOCK_BYTES, $seg_size - $read_at );
		$bytes = $this->source()->read_at( $this->cursor_seg, $read_at, $len );
		// Consumers are the user-facing read nodes, so surface bytes_read here too.
		$this->bytes_read += \strlen( $bytes );
		$this->buffer     .= $bytes;

		// at_eof means "nothing left to do": caught up on disk AND no buffered line
		// still to drain. Leaving a pending line would back off to the EOF cadence
		// and stall the burst's trailing record ~100ms.
		$tail            = $this->cursor_off + \strlen( $this->buffer );
		$disk_caught_up  = ( $this->cursor_seg >= $newest_id ) && ( $tail >= $newest_size );
		$this->at_eof    = $disk_caught_up && ! $this->buffer_has_line();
	}

	/** True when $buffer holds at least one complete (newline-terminated) line still to drain. */
	private function buffer_has_line(): bool {
		return false !== \strpos( $this->buffer, "\n" );
	}

	/**
	 * Smallest live segment id greater than $after, or null when $after is the newest.
	 *
	 * @param array<int, array{id: int, size: int}> $segments Live segment list.
	 */
	private function next_segment_id( array $segments, int $after ): ?int {
		$next = null;
		foreach ( $segments as $s ) {
			if ( $s['id'] > $after && ( null === $next || $s['id'] < $next ) ) {
				$next = $s['id'];
			}
		}
		return $next;
	}

	/**
	 * Clamp the cursor against the live (non-empty) segment list.
	 *
	 * Two recoveries: the cursor segment was deleted by cleanup (rewind to the
	 * oldest segment), or it was wiped and recreated smaller — a full sweep
	 * restarts ids at 0, so a durable checkpoint can sit past EOF (rewind to
	 * the segment start instead of waiting forever for the file to grow back).
	 * Shared by poll() and compute_lag() so reads and lag agree on position.
	 *
	 * @param array<int, array{id: int, size: int}> $segments Live segment list.
	 */
	protected function normalize_cursor( array $segments ): void {
		$sizes = \array_column( $segments, 'size', 'id' );
		if ( ! isset( $sizes[ $this->cursor_seg ] ) ) {
			$this->cursor_seg = $segments[0]['id'];
			$this->cursor_off = 0;
			$this->buffer     = '';
		} elseif ( $sizes[ $this->cursor_seg ] < $this->cursor_off + \strlen( $this->buffer ) ) {
			$this->cursor_off = 0;
			$this->buffer     = '';
		}
	}

	/** Source Partition, materialized by arguments(). Throws if a read runs before configuration. */
	private function source(): Partition_Node {
		if ( null === $this->source ) {
			throw new \RuntimeException( 'Consumer source partition not initialized; call arguments() first' );
		}
		return $this->source;
	}

	/** Override the FROM-stamp used when emitting messages; '' falls back to $this->name. */
	public function set_stamp_as( string $stamp ): void {
		$this->stamp_override = $stamp;
	}

	/**
	 * Seed the cursor from the newest offsetlog entry and stash any co-committed
	 * snapshot cache. When a durable checkpoint is found it resumes the cursor from
	 * it — overriding any pre-poll next_offset() seek (resume wins); otherwise the
	 * cursor is left as-is (offsetlog disabled, empty, or corrupt).
	 */
	protected function load_offsetlog(): void {
		if ( null === $this->offsetlog ) {
			return;
		}
		$segments = $this->offsetlog->get_segments( true );
		if ( empty( $segments ) ) {
			return;
		}
		$newest = \end( $segments );
		$bytes  = $this->offsetlog->read_at( $newest['id'], 0, $newest['size'] );
		$lines  = \array_filter( \explode( "\n", $bytes ), static fn ( $l ) => '' !== $l );
		if ( empty( $lines ) ) {
			return;
		}
		try {
			$msg = Message::unpacked( \end( $lines ) );
		} catch ( \InvalidArgumentException $e ) {
			// Unparseable entry: keep the current position rather than resuming.
			$this->print_less_often( "Consumer: ignoring unparseable offsetlog entry while seeding cursor: {$e->getMessage()}" );
			return;
		}
		$entry = $msg[ Message::VALUE ];
		if ( ! \is_array( $entry ) || ! isset( $entry['seg'], $entry['off'] ) ) {
			return;
		}
		$seg                  = $entry['seg'];
		$off                  = $entry['off'];
		$this->cursor_seg     = \is_numeric( $seg ) ? (int) $seg : 0;
		$this->cursor_off     = \is_numeric( $off ) ? (int) $off : 0;
		$this->checkpoint_seg = $this->cursor_seg;
		$this->checkpoint_off = $this->cursor_off;
		// Offset + cache come from ONE record, so the resumed cursor and the
		// restored state are always aligned.
		$this->loaded_cache = \is_array( $entry['cache'] ?? null ) ? $entry['cache'] : null;
	}

	/**
	 * Name the node whose state is snapshotted into the offsetlog alongside the
	 * cursor (Tachikoma's `connect_edge` + cache_type=snapshot). On checkpoint the
	 * named node's save_state() rides in the committed record; the first poll
	 * (poll_init) restores it into the by-then-built node. Recording the name is
	 * all this does — the restore is deferred so topology declaration order can't
	 * forward-reference a node that doesn't exist yet. Lifts the offsetlog's
	 * PIPE_BUF cap (void_warranty): the worker holding the topology lock is the
	 * offsetlog's sole writer, so no per-write lock is needed.
	 */
	public function set_snapshot_node( string $name ): void {
		$this->snapshot_node = $name;
		$this->offsetlog?->void_warranty();
	}

	/**
	 * Set next read position: 'start' | 'recent' | 'end' | array{seg,off}.
	 *
	 * @param string|array<array-key, mixed> $position Magic value or explicit position (reads 'seg'/'off').
	 */
	public function next_offset( $position ): void {
		$this->buffer = '';
		$this->at_eof = false;

		if ( \is_array( $position ) ) {
			$seg              = $position['seg'] ?? 0;
			$off              = $position['off'] ?? 0;
			$this->cursor_seg = \is_numeric( $seg ) ? (int) $seg : 0;
			$this->cursor_off = \max( 0, \is_numeric( $off ) ? (int) $off : 0 );
			return;
		}

		$segments = $this->source()->get_segments( true );

		switch ( $position ) {
			case 'end':
				if ( ! empty( $segments ) ) {
					$newest           = \end( $segments );
					$this->cursor_seg = $newest['id'];
					$this->cursor_off = $newest['size'];
				}
				break;

			case 'recent':
				if ( ! empty( $segments ) ) {
					$count = \count( $segments );
					if ( $count >= 2 ) {
						$this->cursor_seg = $segments[ $count - 2 ]['id'];
					} else {
						$this->cursor_seg = $segments[0]['id'];
					}
					$this->cursor_off = 0;
				}
				break;

			case 'start':
			default:
				$this->cursor_seg = 0;
				$this->cursor_off = 0;
				break;
		}
	}

	/**
	 * Resolve the Consumer's immediate downstream processor(s) to `{name, class}` entries.
	 *
	 * A Tee target is expanded to its targets so the dashboard shows the real processors.
	 *
	 * @return array<int,array{name:string,class:string}>
	 */
	private function resolve_downstream_targets(): array {
		if ( ! \is_string( $this->target ) || '' === $this->target ) {
			return [];
		}
		$node = Core::node( $this->target );
		if ( null === $node ) {
			// Not yet registered or removed; surface the name without a class.
			return [ [ 'name' => $this->target, 'class' => '' ] ];
		}
		$class = Command_Interpreter_Node::shell_name_for( $node );
		if ( 'Tee' !== $class ) {
			return [ [ 'name' => $this->target, 'class' => $class ] ];
		}
		$tee_targets = $node->target;
		if ( ! \is_array( $tee_targets ) ) {
			return [ [ 'name' => $this->target, 'class' => 'Tee' ] ];
		}
		$out = [];
		foreach ( $tee_targets as $t ) {
			if ( '' === $t ) {
				continue;
			}
			$tn = Core::node( $t );
			$tc = null === $tn ? '' : Command_Interpreter_Node::shell_name_for( $tn );
			$out[] = [ 'name' => $t, 'class' => $tc ];
		}
		return $out;
	}

	public function checkpoint(): void {
		if ( null === $this->offsetlog ) {
			return;
		}
		// Always write the first checkpoint (even at 0:0) so an idle Consumer is still attributed.
		$first_checkpoint = -1 === $this->checkpoint_seg && -1 === $this->checkpoint_off;
		if (
			! $first_checkpoint
			&& $this->cursor_seg === $this->checkpoint_seg
			&& $this->cursor_off === $this->checkpoint_off
		) {
			return;
		}
		$msg                       = Message::new_message();
		$msg[ Message::TYPE ]      = Message::TM_STRUCT;
		$msg[ Message::TIMESTAMP ] = Core::$now;
		$msg[ Message::FROM ]      = $this->name;
		$value = [
			'seg'         => $this->cursor_seg,
			'off'         => $this->cursor_off,
			'ts'          => Core::$now,
			'name'        => $this->name,
			'target'      => \is_string( $this->target ) ? $this->target : '',
			'targets'     => $this->resolve_downstream_targets(),
			'worker_type' => self::worker_type_env(),
			// Real source log basename. Two readers can tail the same log under
			// distinct offset-dir names (firehose vs firehose.job-router); the
			// dashboard labels by this, not the disambiguated offset dir.
			'source_log'  => \basename( $this->source_base_dir ),
		];
		// Co-commit the snapshot node's state with the offset, as ONE record, so a
		// respawn restores the cache and resumes the cursor in lockstep.
		if ( '' !== $this->snapshot_node ) {
			$node = Core::node( $this->snapshot_node );
			if ( null !== $node && \method_exists( $node, 'save_state' ) ) {
				$value['cache'] = $node->save_state();
			}
		}
		$msg[ Message::VALUE ]     = $value;
		$this->offsetlog->fill( $msg );
		// Persist synchronously — don't wait for the offsetlog Partition's PIPE_BUF threshold.
		$this->offsetlog->flush();
		$this->checkpoint_seg = $this->cursor_seg;
		$this->checkpoint_off = $this->cursor_off;

		$this->set_state( 'CHECKPOINT', [ 'seg' => $this->cursor_seg, 'off' => $this->cursor_off ] );
	}

	/**
	 * True if this Consumer resumed from a durable offsetlog checkpoint (seg/off
	 * default to -1; poll_init's load_offsetlog seeds them ≥0). Only meaningful
	 * after the first poll — construction does no I/O. To pick a first-spawn start
	 * position, call next_offset() at build; poll_init resumes from the checkpoint
	 * when one exists (overriding that seek) and keeps it otherwise.
	 */
	public function has_checkpoint(): bool {
		return -1 !== $this->checkpoint_seg || -1 !== $this->checkpoint_off;
	}

	/**
	 * Publish the current cursor to memcache, keyed by hostname + source path, for live dashboards.
	 *
	 * No-op when Memcached is missing or unreachable; a failed connect is sticky for this worker.
	 */
	/** Worker-type env tag (set by SpawnController after HMAC auth); '' when unset. */
	private static function worker_type_env(): string {
		// phpcs:ignore WordPress.Security.ValidatedSanitizedInput.InputNotSanitized -- env var is set by SpawnController after HMAC auth.
		return Core::as_string( $_SERVER['NEWSPACK_NODES_WORKER_TYPE'] ?? '' );
	}

	private function publish_position(): void {
		if ( ! \class_exists( '\\Memcached' ) ) {
			return;
		}
		// Ephemeral readers (no offsetlog) have no durable per-reader identity — skip.
		$host = \gethostname() ?: 'unknown';
		$key  = $this->position_cache_key( $host );
		if ( '' === $key ) {
			return;
		}
		/** @var \Memcached|false|null $memd */
		static $memd = null;
		if ( false === $memd ) {
			return;
		}
		if ( null === $memd ) {
			$config  = Config::load_config();
			$servers = $config['memcache_servers'] ?? [];
			if ( ! \is_array( $servers ) || empty( $servers ) ) {
				$memd = false;
				return;
			}
			$memd = new \Memcached();
			foreach ( $servers as $hp ) {
				$hp_str    = \is_scalar( $hp ) ? (string) $hp : '';
				[ $h, $p ] = \array_pad( \explode( ':', \trim( $hp_str ) ), 2, '11211' );
				$memd->addServer( $h, (int) $p );
			}
			if ( empty( $memd->getServerList() ) ) {
				$memd = false;
				return;
			}
		}
		$memd->set(
			$key,
			[
				'seg'         => $this->cursor_seg,
				'off'         => $this->cursor_off,
				'ts'          => Core::$now,
				'name'        => $this->name,
				'target'      => \is_string( $this->target ) ? $this->target : '',
				'targets'     => $this->resolve_downstream_targets(),
				'worker_type' => self::worker_type_env(),
			],
			60
		);
	}

	/** @return array{bytes_behind: int, segments_behind: int, caught_up: bool} */
	private function compute_lag(): array {
		\clearstatcache( true, $this->source()->partition_dir() );
		$segments = $this->source()->get_segments( true );
		if ( empty( $segments ) ) {
			return [ 'bytes_behind' => 0, 'segments_behind' => 0, 'caught_up' => true ];
		}
		// Recover a deleted/recreated cursor segment first so lag reflects the
		// replay poll() will actually do (a stale cursor otherwise reads as caught up).
		$this->normalize_cursor( $segments );
		$bytes_behind     = 0;
		$segments_behind  = 0;
		foreach ( $segments as $s ) {
			$id   = $s['id'];
			$size = $s['size'];
			if ( $id < $this->cursor_seg ) {
				continue;
			}
			if ( $id === $this->cursor_seg ) {
				$bytes_behind += \max( 0, $size - $this->cursor_off );
			} else {
				$bytes_behind += $size;
				++$segments_behind;
			}
		}
		// Count buffered (already-read) bytes as consumed so lag reflects bytes-still-to-emit.
		$bytes_behind = \max( 0, $bytes_behind - \strlen( $this->buffer ) );
		return [
			'bytes_behind'    => $bytes_behind,
			'segments_behind' => $segments_behind,
			'caught_up'       => 0 === $bytes_behind,
		];
	}

	protected function check_name_availability( string $name ): void {
		parent::check_name_availability( $name );
		if ( null !== $this->source && null !== Core::node( "{$name}:source" ) ) {
			throw new \RuntimeException( \esc_html( "node name collision: {$name}:source already registered" ) );
		}
		if ( null !== $this->offsetlog && null !== Core::node( "{$name}:offsetlog" ) ) {
			throw new \RuntimeException( \esc_html( "node name collision: {$name}:offsetlog already registered" ) );
		}
	}

	protected function set_sibling_names( ?string $name = null ): void {
		$this->source?->name( "{$name}:source" );
		$this->offsetlog?->name( "{$name}:offsetlog" );
		parent::set_sibling_names( $name );
	}

	public function sink( ?Node $node = null ): ?Node {
		if ( \func_num_args() > 0 ) {
			if ( null !== $this->source ) {
				$this->source->sink( $node );
			}
			if ( null !== $this->offsetlog ) {
				$this->offsetlog->sink( $node );
			}
			return parent::sink( $node );
		}
		return parent::sink();
	}

	public function remove_node(): void {
		if ( null !== $this->source ) {
			$this->source->remove_node();
		}
		if ( null !== $this->offsetlog ) {
			$this->offsetlog->remove_node();
		}
		parent::remove_node();
	}

	public static function node_schema(): array {
		return \array_merge( parent::node_schema(), [
			'category'    => 'I/O',
			'description' => 'Tails a Partition; emits each appended message to its sink.',
			'arguments'        => [
				[ 'name' => 'source_base_dir',    'type' => 'string', 'required' => true ],
				[ 'name' => 'source_partition',   'type' => 'int',    'required' => true ],
				[ 'name' => 'offsetlog_base_dir', 'type' => 'string', 'default' => '' ],
			],
			'commands'    => [
				[
					'name'        => 'set_snapshot_node',
					'description' => 'Co-commit a named node\'s save_state() into the offsetlog alongside the cursor, so it resumes its in-flight state on respawn (Tachikoma snapshot cache). Lifts the offsetlog PIPE_BUF cap (single-writer).',
					'args'        => [
						[ 'name' => 'node', 'type' => 'node_name', 'required' => true ],
					],
					'handler'     => static function ( Command_Interpreter_Node $interpreter, string $args ): string {
						/** @var self $patron */
						$patron = $interpreter->patron();
						$patron->set_snapshot_node( \trim( $args ) );
						return 'ok';
					},
				],
			],
			'requests'    => [
				[
					'name'        => 'GET_LAG',
					'description' => 'Bytes/messages behind the source partition tail.',
					'reply_shape' => '{ bytes_behind, segments_behind, caught_up }',
				],
				[
					'name'        => 'GET_OFFSET',
					'description' => 'Current cursor + last checkpoint.',
					'reply_shape' => '{ cursor_seg, cursor_off, checkpoint_seg, checkpoint_off, last_checkpoint_ts }',
				],
			],
			'accepts_fill' => false,
		] );
	}
}
