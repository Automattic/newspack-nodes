<?php
/**
 * Consumer: reads a source Partition forward and records where it stopped, so a
 * restart resumes the stream instead of replaying it.
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes;

if ( ! \defined( 'ABSPATH' ) ) {
	exit;
}

/**
 * Tails a source Partition and emits every appended record to its sink.
 *
 * The read model itself lives in `Durable_Reader`: the offsetlog cursor, the
 * timer-driven buffered pump, the dead-letter lifecycle and the pause/step/seek
 * debugger. This class supplies the seams that point it at a segmented directory
 * of `{seg}.log` files. `make_source()` and `resolve_args()` say where
 * the bytes live, `get_batch()` performs the read, and `init_position()` with
 * `default_offset()` decide where a fresh reader starts. `Tail_Node` redeclares
 * `make_source()`, `resolve_args()` and `default_offset()` to follow a `Log`'s
 * `{file}.{seg}` segments instead; `File_Tail_Node` goes further and follows a
 * single inode.
 *
 * Three surfaces ask how far behind the reader is — the `GET_LAG` request,
 * `probe_stats()` for the topicprobe sweep, and `idle_since()` for an on-demand
 * worker deciding whether to exit — and all three read `compute_lag()`. A
 * subclass with a different byte source overrides that one method, so the three
 * answers cannot disagree.
 *
 * A Consumer is a source, not a processor: `accepts_fill` is false, and `fill()`
 * exists to answer TM_REQUEST introspection rather than to carry data.
 */
class Consumer_Node extends Timer_Node implements Idle_Reporter {
	/** Positional `arguments()` parsing plus the auto-wired `{name}:config` interpreter. */
	use Schema_Reflection;

	/** Dead_Letter_Queue rides in with Durable_Reader, which drives it. */
	use Durable_Reader;

	/**
	 * Bytes read per poll — one block, then yield the event loop (Tachikoma's
	 * BUFSIZ in Partition::process_get). A poll drains the buffer it already
	 * holds, reads ONE more block, and returns so other nodes get a turn.
	 */
	public const READ_BLOCK_BYTES = 65536;

	/**
	 * Multi-writer seal-grace: seconds a segment's size must hold steady before,
	 * with a newer segment present, the reader advances off it. A peer writer on a
	 * shared log (the firehose) can keep appending to segment N for up to
	 * Partition_Node::DRIFT_RESCAN_INTERVAL_SECONDS after N+1 appears; this must
	 * exceed that so a straggler's final line (often a request's terminal
	 * `process (complete)`) is never orphaned by a premature advance. Only applies
	 * in $multi_writer mode — a single-writer log seals N the instant it creates
	 * N+1, so its reader advances immediately (no added latency).
	 */
	public const SEAL_GRACE_SECONDS = 2.0;

	/**
	 * Seek the start of the log. Tachikoma's `start` (`Consumer.pm`: "valid
	 * offsets: start (0), recent (-2), end (-1)"). Inside an explicit
	 * `{segment, offset}` pair 0 is a real byte position, not this sentinel.
	 */
	public const SEEK_START = 0;

	/** Seek the current end: deliver only what is appended after the seek. Tachikoma's `end`. */
	public const SEEK_END = -1;

	/** Seek the start of the second-newest segment, or of the only one. Tachikoma's `recent`. */
	public const SEEK_RECENT = -2;

	/** Discard the resumable snapshot cache after this many seconds of an unbroken crash streak. */
	public const STATE_WIPE_AFTER_S = 900;

	/**
	 * Multi-writer source: apply the seal-grace (see SEAL_GRACE_SECONDS) before
	 * advancing off a segment that a newer segment supersedes. Set true ONLY for a
	 * genuinely shared log (the firehose); single-writer logs leave it false and
	 * advance immediately.
	 */
	protected bool $multi_writer = false;

	/** Seal-grace bookkeeping: the segment whose size is being watched; -1 before the first check. */
	protected int $seal_segment = -1;

	/** Seal-grace bookkeeping: Core::$now when ($seal_segment, $seal_size) last changed. */
	protected float $seal_since = 0.0;

	/** Seal-grace bookkeeping: the size $seal_segment held at $seal_since; -1 before the first check. */
	protected int $seal_size = -1;

	/** Source Partition, built by arguments() and published as the `source` sibling. Read it through source(). */
	protected ?Partition_Node $source = null;

	/** Source partition directory, trailing slash stripped. In Tail this holds the source FILE base. */
	protected string $source_dir = '';

	/**
	 * Snapshot cache lifted out of the offsetlog frame by load_offsetlog(), for
	 * init_position() to restore once the cursor is seeded. `null` once that
	 * restore has run, and whenever the frame carried no cache.
	 *
	 * @var array<array-key,mixed>|null
	 */
	private ?array $loaded_cache = null;

	/**
	 * State loaded for snapshot names that could not restore (node absent at
	 * boot). Folded back into every recommitted frame so an unresolvable
	 * node's durable state survives until a live save_state() replaces it.
	 *
	 * @var array<string,array<array-key,mixed>>
	 */
	private array $snapshot_carry = [];

	/** When the source was first seen with no segments at all; null once it has any. */
	private ?float $empty_since = null;

	/** Probe baseline: $counter as of the previous probe_stats() sweep. */
	private int $probe_msgs = 0;

	/** Probe baseline: $bytes_read as of the previous probe_stats() sweep. */
	private int $probe_bytes = 0;

	/** Probe baseline: Core::$now at the previous sweep; the constructor opens the first window. */
	private float $probe_ts = 0.0;

	/** Tachikoma-parity: no-arg ctor. Positional config arrives via arguments(). */
	public function __construct() {
		parent::__construct();
		// The first probe window opens now, so its elapsed is time-since-birth.
		$this->probe_ts = Core::$now;
		// The {name}:config interpreter makes add_snapshot_node dispatchable.
		$this->auto_wire_interpreter();
	}

	/**
	 * Configure the reader from its positional tokens. `parse_schema_args()`
	 * assigns `source_dir`, `offsetlog_dir` and `deadletter_dir`; `resolve_args()`
	 * says which source and offsetlog paths this class reads back (Tail swaps in
	 * its `source_file`); both are checked against the runtime base directory; and
	 * the source Partition plus the offsetlog and dead-letter sidecars are
	 * materialized. No I/O runs here — the first poll loads the durable cursor and
	 * restores the snapshot state.
	 *
	 * A replay REPLACES the source unconditionally, and each sidecar whenever its
	 * dir moved — the `ensure_*` guards own that rule, so it reaches every reader
	 * rather than only the ones routed through here. The source is assigned BEFORE
	 * its publish, so a refused publish unwinds to the node this call BUILT; a
	 * sidecar publishes first and assigns after, leaving a refused slot empty for
	 * its own guard to rebuild.
	 *
	 * @param list<string>|null $args Positional tokens, or null to read the stored set back.
	 * @return list<string> The tokens as stored.
	 */
	public function arguments( ?array $args = null ): array {
		if ( null === $args ) {
			return parent::arguments();
		}
		$this->parse_schema_args( $args );
		[ $source_path, $offsetlog_path ] = $this->resolve_args();
		$this->source_dir    = \rtrim( $source_path, '/' );
		$this->offsetlog_dir = $offsetlog_path;
		Config::assert_within_base( $this->source_dir );
		Config::assert_within_base( $this->offsetlog_dir );

		$source = $this->make_source();
		$source->arguments( [ $this->source_dir ] );
		$source->sink( $this->sink );
		$source->patron( $this );
		// Assign before publish: a refusal must unwind to the live node.
		$this->retract_sibling( 'source' );
		$this->source = $source;
		$this->publish_sibling( 'source', $source );

		$this->ensure_offsetlog();
		$this->ensure_deadletter();

		// No I/O at construction: first poll loads cursor + restores snapshot.
		$this->poll_cb = $this->poll_init( ... );
		$this->set_timer( self::POLL_INTERVAL_EOF_MS );
		$this->set_state( 'POLLING', 'ACTIVE' );

		return $args;
	}

	/**
	 * Answer a TM_REQUEST introspection verb; everything else falls through to
	 * Timer_Node. `accepts_fill` is false, so this entry point carries no data —
	 * it exists because introspection reaches a node the same way anything else
	 * does, through `fill()` (ADR-1).
	 *
	 * @param array<int,mixed> $message Incoming Message.
	 */
	public function fill( array $message ): void {
		$type_raw = $message[ Message::TYPE ];
		$type     = Core::num_int( $type_raw );
		if ( $type & Message::TM_REQUEST ) {
			$this->handle_request( $message );
			return;
		}
		parent::fill( $message );
	}

	/**
	 * Dispatch one request verb and reply to whoever asked. `GET_LAG` is the only
	 * verb; an unknown one comes back as an `error` payload rather than a throw,
	 * because there is no interpreter on this path to turn a throw into a TM_ERROR
	 * reply. TO=FROM is the whole correlation and ID and KEY ride back unchanged,
	 * so the asker needs no registry of outstanding requests (ADR-7).
	 *
	 * @param array<int,mixed> $message Incoming request Message.
	 */
	private function handle_request( array $message ): void {
		$sink = $this->require_sink();
		$value_raw = $message[ Message::VALUE ];
		$value     = Core::as_string( $value_raw );
		$verb      = \strtoupper( \explode( ' ', \trim( $value ), 2 )[0] );

		$payload = match ( $verb ) {
			'GET_LAG' => $this->compute_lag(),
			default   => [ 'error' => "unknown request verb: {$verb}" ],
		};

		$reply                   = Message::new_message();
		$reply[ Message::TYPE ]  = Message::TM_STRUCT | Message::TM_RESPONSE;
		$reply[ Message::FROM ]  = '' !== $this->stamp_override ? $this->stamp_override : $this->name;
		$reply[ Message::TO ]    = $message[ Message::FROM ];
		$reply[ Message::ID ]    = $message[ Message::ID ];
		$reply[ Message::KEY ]   = $message[ Message::KEY ];
		$reply[ Message::VALUE ] = [ 'verb' => $verb, 'data' => $payload ];
		$sink->fill( $reply );
	}

	/** Source seam: the segmented-log node to read. Consumer builds a Partition; Tail builds a Log. */
	protected function make_source(): Partition_Node {
		return new Partition_Node();
	}

	/**
	 * Path seam: the source and offsetlog paths, read back off the properties
	 * `parse_schema_args()` has just assigned. Consumer's are `source_dir` and
	 * `offsetlog_dir`; Tail substitutes its `source_file`.
	 *
	 * @return array{0:string,1:string} Source path, then offsetlog path.
	 */
	protected function resolve_args(): array {
		return [ $this->source_dir, $this->offsetlog_dir ];
	}

	/**
	 * When the source last grew, for a consumer that has read all of it.
	 *
	 * `null` means "do not treat this stream as idle" and is reserved for bytes
	 * still waiting — hanging up on a consumer with unread backlog would starve
	 * it on every reconnect. A source with NO segments is not that case: it is
	 * idle from when it was first seen empty, so a consumer tailing a log nobody
	 * has written cannot veto a peer's idle exit, and an SSE stream over one
	 * still heartbeats for its timeout instead of closing on the first tick.
	 *
	 * @return float|null Epoch seconds this reader went idle; null while it holds
	 *                   unread bytes, or when the newest segment's mtime is unreadable.
	 */
	public function idle_since(): ?float {
		if ( ! $this->compute_lag()['caught_up'] ) {
			return null;
		}
		$segments = $this->source()->get_segments( true );
		if ( empty( $segments ) ) {
			// Idle since first seen empty; null here reads as BUSY.
			$this->empty_since ??= Core::right_now();
			return $this->empty_since;
		}
		$this->empty_since = null;
		$last = \end( $segments );
		$path = $this->source()->get_segment_path( Core::as_int( $last['id'] ) );
		\clearstatcache( true, $path );
		$mtime = @\filemtime( $path );
		return \is_int( $mtime ) ? (float) $mtime : null;
	}

	/**
	 * Probe seam: the snapshot `Topic_Probe` reads from outside this Consumer, as
	 * the POSITIONAL `Probe_Record` array (kept tiny for 24h SSE replay). A
	 * DRAINING read — call it once per sweep. Positions ride verbatim (`SOURCE`,
	 * `READER`, the cursor, the partition END, `DISTANCE`, `CACHE_SIZE`); the
	 * counters ride as the work done since the previous call, with the interval
	 * that work covers, so a reader divides ONE record instead of differencing
	 * across records (which read a ~595s worker recycle as a counter reset).
	 *
	 * @return array<int,int|string> A `Probe_Record`-indexed positional array.
	 */
	public function probe_stats(): array {
		$lag                                    = $this->compute_lag();
		$window                                 = $this->drain_probe_window();
		$record                                 = [];
		$record[ Probe_Record::SOURCE ]         = '' !== $this->source_dir ? \basename( $this->source_dir ) : '';
		$record[ Probe_Record::READER ]         = '' !== $this->offsetlog_dir ? \basename( $this->offsetlog_dir ) : '';
		$record[ Probe_Record::CURSOR_SEGMENT ] = $this->cursor_segment;
		$record[ Probe_Record::CURSOR_OFF ]     = $this->cursor_offset;
		$record[ Probe_Record::END_SEGMENT ]    = $lag['end_segment'];
		$record[ Probe_Record::END_SIZE ]       = $lag['end_size'];
		$record[ Probe_Record::DISTANCE ]       = $lag['bytes_behind'];
		$record[ Probe_Record::MSGS_DELTA ]     = $window['msgs'];
		$record[ Probe_Record::END_BYTES ]      = $lag['end_bytes'];
		$record[ Probe_Record::CACHE_SIZE ]     = $this->offsetlog_cache_size();
		$record[ Probe_Record::BYTES_READ_DELTA ] = $window['bytes'];
		$record[ Probe_Record::ELAPSED_MS ]     = $window['elapsed_ms'];
		return $record;
	}

	/**
	 * Close the probe window: the messages sent and bytes read since the previous
	 * sweep, plus how long that window ran, then re-baseline. Reported bytes are
	 * the ones this reader actually READ, so retention deleting a segment cannot
	 * make the figure fall the way the partition's on-disk size does.
	 *
	 * @return array{msgs:int,bytes:int,elapsed_ms:int}
	 */
	protected function drain_probe_window(): array {
		$window = [
			'msgs'       => \max( 0, $this->counter - $this->probe_msgs ),
			'bytes'      => \max( 0, $this->bytes_read - $this->probe_bytes ),
			'elapsed_ms' => (int) \round( \max( 0.0, Core::$now - $this->probe_ts ) * 1000 ),
		];
		$this->probe_msgs  = $this->counter;
		$this->probe_bytes = $this->bytes_read;
		$this->probe_ts    = Core::$now;
		return $window;
	}

	/**
	 * Byte size of the consumer's newest offsetlog segment — the position-cache
	 * footprint the overview graphs. 0 for an ephemeral reader (no offsetlog) or
	 * before the first checkpoint writes a segment.
	 */
	protected function offsetlog_cache_size(): int {
		if ( null === $this->offsetlog ) {
			return 0;
		}
		$segments = $this->offsetlog->get_segments( true );
		if ( [] === $segments ) {
			return 0;
		}
		$last = \end( $segments );
		return $last['size'];
	}

	/**
	 * How far behind this reader is. THE lag seam: `GET_LAG`, `probe_stats()`
	 * and `idle_since()` all read it, so a subclass substituting one byte-source
	 * for another overrides this alone and the three can never disagree.
	 *
	 * @return array{bytes_behind: int, segments_behind: int, caught_up: bool, end_segment: int, end_size: int, end_bytes: int, cursor_segment: int, cursor_offset: int}
	 */
	protected function compute_lag(): array {
		\clearstatcache( true, $this->source()->partition_dir() );
		$segments = $this->source()->get_segments( true );
		if ( empty( $segments ) ) {
			return self::lag_of( [], 0, 0 );
		}
		// Recover deleted/recreated cursor first; stale one reads as caught up.
		$this->normalize_cursor( $segments );
		return self::lag_of( $segments, $this->cursor_segment, $this->cursor_offset );
	}

	/**
	 * Lag for a reader that is NOT running, computed entirely from disk: segment
	 * sizes for the partition end, the offsetlog's newest frame for the cursor.
	 *
	 * This is what lets the substrate hold an opinion about a partition an
	 * external producer wrote — the probe log only ever reports what a LIVE
	 * consumer said, so a down reader reads as caught up there. Partition
	 * constructors do no event-loop work (ADR-5), so this is safe in request
	 * scope and on the WP-Cron pass.
	 *
	 * `cursor_known` says whether the reported backlog can be acted on: true when
	 * a committed cursor was found, and true for an empty partition, where there is
	 * nothing to be behind. False means the backlog defaults to the whole
	 * partition, which a caller deciding whether to WAKE something must not act on
	 * — `ensure_offsetlog()` creates the directory at construction, so an empty one
	 * is the ordinary state between boot and the first checkpoint.
	 *
	 * @param string $source_dir    Partition directory the reader tails.
	 * @param string $offsetlog_dir Its durable cursor dir; empty = no cursor at all.
	 * @return array{bytes_behind: int, segments_behind: int, caught_up: bool, end_segment: int, end_size: int, end_bytes: int, cursor_segment: int, cursor_offset: int, cursor_known: bool}
	 */
	public static function lag_from_disk( string $source_dir, string $offsetlog_dir ): array {
		\clearstatcache( true, $source_dir );
		$source = new Partition_Node();
		$source->arguments( [ $source_dir ] );
		$segments = $source->get_segments( true );
		if ( empty( $segments ) || '' === $offsetlog_dir ) {
			// Empty partition = caught up; no offsetlog = no cursor to know.
			return self::lag_of( $segments, 0, 0 )
				+ [ 'cursor_known' => empty( $segments ) ];
		}
		$offsetlog = new Partition_Node();
		$offsetlog->arguments( [ $offsetlog_dir ] );
		$frame = self::last_frame_of( $offsetlog );
		if ( null === $frame ) {
			// Not checkpointed yet is not a cursor parked at 0:0.
			return self::lag_of( $segments, 0, 0 ) + [ 'cursor_known' => false ];
		}
		return self::lag_of(
			$segments,
			Core::as_int( $frame['segment'] ?? 0 ),
			Core::as_int( $frame['offset'] ?? 0 )
		) + [ 'cursor_known' => true ];
	}

	/**
	 * The lag arithmetic, over a segment list and a cursor. Pure, so the live
	 * reader and `lag_from_disk()` share ONE implementation and a change to the
	 * accounting cannot land on one path and miss the other.
	 *
	 * Both of `normalize_cursor()`'s recoveries apply, because a partition can be
	 * recreated beneath a reader: a cursor whose segment is absent snaps to the
	 * oldest, and one pointing past a segment that came back SHORTER rewinds to
	 * its start. Skip either and a wiped-and-refilled partition reads as caught
	 * up — every id sorting below the cursor in the first case, the subtraction
	 * clamping to zero in the second — which is exactly the optimistic silence
	 * this measurement exists to remove. Idempotent for the live caller, which
	 * has already normalized.
	 *
	 * @param array<int,array{id: int, size: int}> $segments       Ascending segment list.
	 * @param int                                  $cursor_segment Committed segment id.
	 * @param int                                  $cursor_offset  Committed offset within it.
	 * @return array{bytes_behind: int, segments_behind: int, caught_up: bool, end_segment: int, end_size: int, end_bytes: int, cursor_segment: int, cursor_offset: int}
	 */
	public static function lag_of( array $segments, int $cursor_segment, int $cursor_offset ): array {
		if ( empty( $segments ) ) {
			return [
				'bytes_behind' => 0,
				'segments_behind' => 0,
				'caught_up' => true,
				'end_segment' => 0,
				'end_size' => 0,
				'end_bytes' => 0,
				'cursor_segment' => $cursor_segment,
				'cursor_offset' => $cursor_offset,
			];
		}
		// Segment gone, or shorter than the cursor: recreated, so re-read.
		$sizes = \array_column( $segments, 'size', 'id' );
		if ( ! isset( $sizes[ $cursor_segment ] ) ) {
			$oldest         = \reset( $segments );
			$cursor_segment = $oldest['id'];
			$cursor_offset  = 0;
		} elseif ( $sizes[ $cursor_segment ] < $cursor_offset ) {
			$cursor_offset = 0;
		}
		$bytes_behind    = 0;
		$segments_behind = 0;
		$end_bytes       = 0;
		foreach ( $segments as $s ) {
			$id   = $s['id'];
			$size = $s['size'];
			// Absolute byte pos (sum of segment sizes); browser derives rate.
			$end_bytes += $size;
			if ( $id < $cursor_segment ) {
				continue;
			}
			if ( $id === $cursor_segment ) {
				$bytes_behind += \max( 0, $size - $cursor_offset );
			} else {
				$bytes_behind += $size;
				++$segments_behind;
			}
		}
		// Partition END from SAME read as cursor; topologies tab trims here.
		$last = \end( $segments );
		return [
			'bytes_behind'    => $bytes_behind,
			'segments_behind' => $segments_behind,
			'caught_up'       => 0 === $bytes_behind,
			'end_segment'     => $last['id'],
			'end_size'        => $last['size'],
			'end_bytes'       => $end_bytes,
			// Carried so a distance and the cursor it measured travel together.
			'cursor_segment'  => $cursor_segment,
			'cursor_offset'   => $cursor_offset,
		];
	}

	/**
	 * Durable_Reader boot seam: Consumer's "where do I start" is a durable seek. Seed
	 * the cursor from the offsetlog, restore the snapshot node's state (the whole
	 * topology exists by the first poll), then apply the default_offset() seek when
	 * there's no checkpoint and no explicit next_offset(). A durable checkpoint
	 * OVERRIDES a pre-poll next_offset() (resume wins); with no checkpoint, that seek
	 * stands.
	 */
	protected function init_position(): void {
		$this->load_offsetlog();
		if ( null !== $this->loaded_cache && [] !== $this->snapshot_nodes ) {
			$restored = false;
			foreach ( $this->snapshot_nodes as $snapshot_name ) {
				$node  = Core::node( $snapshot_name );
				$state = $this->loaded_cache[ $snapshot_name ] ?? null;
				if ( \is_array( $state ) && null !== $node && \method_exists( $node, 'restore_state' ) ) {
					$node->restore_state( $state );
					$restored = true;
				} else {
					$this->print_less_often( "WARNING: snapshot node '{$snapshot_name}' missing, stateless, or absent from the frame; skipping its restore" );
					if ( \is_array( $state ) ) {
						// Carry unrestored state into recommits: never drop it.
						$this->snapshot_carry[ $snapshot_name ] = $state;
					}
				}
			}
			if ( $restored ) {
				// Restore survived: recommit cache stateful; boot stateless.
				$this->write_checkpoint_frame( false, true );
			}
		}
		$this->loaded_cache = null;
		if ( ! $this->has_checkpoint() && ! $this->offset_set ) {
			$default = $this->default_offset();
			if ( null !== $default ) {
				$this->next_offset( $default );
			}
		}
	}

	/**
	 * Seed the cursor from the newest offsetlog entry and stash any co-committed
	 * snapshot cache. When a durable checkpoint is found it resumes the cursor from
	 * it — overriding any pre-poll next_offset() seek (resume wins); otherwise the
	 * cursor is left as-is (offsetlog disabled, empty, or corrupt).
	 */
	protected function load_offsetlog(): void {
		$entry = $this->read_last_offsetlog_frame();
		if ( null === $entry || ! isset( $entry['segment'], $entry['offset'] ) ) {
			return;
		}
		$segment                   = $entry['segment'];
		$offset                    = $entry['offset'];
		$this->cursor_segment      = Core::num_int( $segment );
		$this->cursor_offset       = Core::num_int( $offset );
		$this->boot_cursor_segment = $this->cursor_segment;
		$this->boot_cursor_offset  = $this->cursor_offset;
		// Resume attempt accounting and arm the boot head-skip (ADR-12).
		$this->arm_skip_head_from_frame( $entry );
		// Offset + cache from ONE record, so cursor and state stay aligned.
		$this->loaded_cache = \is_array( $entry['cache'] ?? null ) ? $entry['cache'] : null;
		// Crash streak past wipe window: discard the corrupt resumable state.
		if (
			null !== $this->loaded_cache
			&& null !== $this->first_crash_ts
			&& ( Core::$now - $this->first_crash_ts ) > self::STATE_WIPE_AFTER_S
		) {
			$this->print_less_often( 'WARNING: snapshot cache exceeded '
				. self::STATE_WIPE_AFTER_S . 's crash streak; discarding (suspected corrupt state, not a poison message)' );
			$this->loaded_cache = null;
		}
		// Stateless boot frame BEFORE restore: crash still advances counter.
		$this->write_checkpoint_frame( false, false );
	}

	/**
	 * True once a frame has been committed at this reader's cursor; the tracked
	 * segment and offset both start at -1. `load_offsetlog()` commits one the
	 * moment it finds a durable entry, so by the time `init_position()` consults
	 * it a true answer means the reader resumed. Construction does no I/O, so it
	 * reads false until the first poll. To pick a first-spawn start position call
	 * `next_offset()` at build time: a durable checkpoint overrides that seek, and
	 * with no checkpoint the seek stands.
	 */
	public function has_checkpoint(): bool {
		return -1 !== $this->checkpoint_segment || -1 !== $this->checkpoint_offset;
	}

	/**
	 * First-spawn seam: where the cursor starts when there is no durable checkpoint
	 * and no explicit `next_offset()`. `null` leaves the constructed default of
	 * 0:0, the start of the log, which is Consumer's behaviour; Tail returns
	 * `'end'` so a fresh follower sees only what is appended after it starts.
	 */
	protected function default_offset(): ?string {
		return null;
	}

	/**
	 * Set the next read position: a SEEK sentinel, one of its aliases, or an exact
	 * `{segment, offset}` pair.
	 *
	 * The sentinels are Tachikoma's (`Consumer.pm`: "valid offsets: start (0),
	 * recent (-2), end (-1)"), and they are what travels on the wire — a signed
	 * number expresses every seek, so `0` is unambiguously the START of the log
	 * rather than doubling as "no position given". The words are aliases the
	 * human-facing boundaries still speak (the `taillog` verb, TSL, dashboards);
	 * they resolve here, so there is one behaviour behind both spellings. An
	 * exact resume keeps the pair, because our Partition addresses a byte within
	 * a numbered segment where Tachikoma's is absolute across the log.
	 *
	 * @param string|int|array<array-key,mixed> $position Sentinel, alias, or explicit `{segment, offset}`.
	 */
	public function next_offset( $position ): void {
		$this->offset_set = true;
		$this->buffer     = '';
		$this->at_eof     = false;

		if ( \is_array( $position ) ) {
			$segment = $position['segment'] ?? 0;
			$offset  = $position['offset'] ?? 0;
			$this->cursor_segment = Core::num_int( $segment );
			// An exact pair addresses a real byte; only a SEEK may be negative.
			$this->cursor_offset = \max( 0, Core::num_int( $offset ) );
			return;
		}

		$seek     = self::seek_sentinel( $position );
		$segments = $this->source()->get_segments( true );

		switch ( $seek ) {
			case self::SEEK_END:
				if ( ! empty( $segments ) ) {
					$newest = \end( $segments );
					$this->cursor_segment = $newest['id'];
					$this->cursor_offset = $newest['size'];
				}
				break;

			case self::SEEK_RECENT:
				if ( ! empty( $segments ) ) {
					$count = \count( $segments );
					if ( $count >= 2 ) {
						$this->cursor_segment = $segments[ $count - 2 ]['id'];
					} else {
						$this->cursor_segment = $segments[0]['id'];
					}
					$this->cursor_offset = 0;
				}
				break;

			case self::SEEK_START:
			default:
				$this->cursor_segment = 0;
				$this->cursor_offset = 0;
				break;
		}
	}

	/**
	 * Resolve a scalar position to its SEEK sentinel — the one place the alias words
	 * map to numbers, shared with the push source, which forwards the sentinel to
	 * whoever holds the segments rather than resolving it locally. An unknown word
	 * reads as SEEK_START, matching `next_offset()`'s default case.
	 *
	 * @param string|int|float $position Sentinel or alias word.
	 * @return int A SEEK_* constant, or the numeric position itself.
	 */
	public static function seek_sentinel( $position ): int {
		return match ( $position ) {
			'end'    => self::SEEK_END,
			'recent' => self::SEEK_RECENT,
			'start'  => self::SEEK_START,
			default  => Core::num_int( $position, self::SEEK_START ),
		};
	}

	/**
	 * Commit one offsetlog frame at the current cursor — UNCONDITIONALLY (no
	 * advance-guard; the boot sequence re-commits the same cursor on purpose).
	 * `commit_checkpoint_frame()` carries the shared base frame and
	 * `checkpoint_frame_extra()`; what this method adds is the snapshot cache.
	 *
	 * @param bool                   $graceful   Stamp attempts=0 (clean handoff) instead of the live count.
	 * @param bool                   $with_state Co-commit the snapshot node's save_state(). False for the
	 *                                           stateless boot frame written BEFORE restore — reading the
	 *                                           un-restored node there would clobber the good cache.
	 * @param array<array-key,mixed> $extra      Frame fields merged over the base, for a caller that has some.
	 */
	protected function write_checkpoint_frame( bool $graceful, bool $with_state, array $extra = [] ): void {
		// Co-commit snapshots with offset as ONE record for lockstep respawn.
		if ( $with_state && [] !== $this->snapshot_nodes ) {
			$cache = $this->snapshot_carry;
			foreach ( $this->snapshot_nodes as $snapshot_name ) {
				$node = Core::node( $snapshot_name );
				if ( null !== $node && \method_exists( $node, 'save_state' ) ) {
					$cache[ $snapshot_name ] = $node->save_state();
				}
			}
			if ( [] !== $cache ) {
				$extra['cache'] = $cache;
			}
		}
		$this->commit_checkpoint_frame( $this->cursor_segment, $this->cursor_offset, $graceful, $extra );
	}

	/**
	 * Consumer's frame extras beyond the shared base: its identity + downstream wiring the
	 * dashboard labels by. `source_log` is the real source log basename — two readers can
	 * tail the same log under distinct offset-dir names (firehose vs firehose.job-router);
	 * the dashboard labels by this, not the disambiguated offset dir.
	 *
	 * @return array<array-key,mixed>
	 */
	protected function checkpoint_frame_extra(): array {
		return [
			'name'        => $this->name,
			'target'      => Core::str( $this->target ),
			'targets'     => $this->resolve_downstream_targets(),
			'worker_type' => self::worker_type_env(),
			'source_log'  => \basename( $this->source_dir ),
		];
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
		// instanceof, not exact name match, so Tee subclass (Tap) expands too.
		if ( ! $node instanceof Tee_Node ) {
			return [ [ 'name' => $this->target, 'class' => $class ] ];
		}
		$tee_targets = $node->target;
		if ( ! \is_array( $tee_targets ) ) {
			return [ [ 'name' => $this->target, 'class' => $class ] ];
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

	/** Worker-type env tag, set by `Spawn_Controller` on spawn and by `Bootstrap` on the reconcile pass; '' when unset. */
	private static function worker_type_env(): string {
		// phpcs:ignore WordPress.Security.ValidatedSanitizedInput.InputNotSanitized -- env var is set by SpawnController after HMAC auth.
		return Core::as_string( $_SERVER['NEWSPACK_NODES_WORKER_TYPE'] ?? '' );
	}

	/**
	 * Read at most one READ_BLOCK_BYTES block into $buffer (Tachikoma get_batch +
	 * Partition::process_get). Rolls to the next segment when the current one is
	 * drained, and sets at_eof when the reader is caught up on disk with no
	 * complete line still buffered.
	 *
	 * The Durable_Reader refill seam: Consumer's synchronous disk read. A push source
	 * (Remote_Source_Node) implements the same abstract seam by arming its curl valve.
	 */
	protected function get_batch(): void {
		// Defeat the stat cache so another process's appends become visible.
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

		$seg_size = $sizes[ $this->cursor_segment ] ?? 0;
		$read_at  = $this->cursor_offset + \strlen( $this->buffer );

		// Current segment fully read: step to next live segment or rest at EOF.
		if ( $read_at >= $seg_size ) {
			$next = $this->next_segment_id( $segments, $this->cursor_segment );
			if ( null !== $next ) {
				// Multi-writer grace: hold boundary steady for SEAL_GRACE.
				if ( $this->multi_writer
					&& $this->cursor_segment >= $newest_id - 1
					&& ! $this->segment_sealed( $this->cursor_segment, $seg_size ) ) {
					$this->at_eof = true;
					return;
				}
				$this->cursor_segment = $next;
				$this->cursor_offset = 0;
				$this->buffer     = '';
				$this->at_eof     = false;
				$this->set_state( 'SEGMENT', (string) $this->cursor_segment );
				return;
			}
			// Nothing on disk; buffer holds at most a trailing partial here.
			$this->at_eof = true;
			return;
		}

		$length   = \min( self::READ_BLOCK_BYTES, $seg_size - $read_at );
		$bytes = $this->source()->read_at( $this->cursor_segment, $read_at, $length );
		// Consumers are user-facing read nodes, so surface bytes_read here too.
		$this->bytes_read += \strlen( $bytes );
		$this->buffer     .= $bytes;

		// at_eof: caught up on disk AND no buffered line, else stalls ~100ms.
		$tail            = $this->cursor_offset + \strlen( $this->buffer );
		$disk_caught_up  = ( $this->cursor_segment >= $newest_id ) && ( $tail >= $newest_size );
		$this->at_eof    = $disk_caught_up && ! $this->buffer_has_line();
	}

	/**
	 * Smallest live segment id greater than $after, or null when $after is the newest.
	 *
	 * @param array<int,array{id: int,size: int}> $segments Live segment list.
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
	 * Multi-writer seal test: true once segment $segment has held $size steady for
	 * >= SEAL_GRACE_SECONDS. Any change in ($segment, $size) restarts the clock and
	 * returns false, so a straggler append (which grows $size) always defers the
	 * advance by another full grace window. Uses Core::$now so tests drive it.
	 */
	private function segment_sealed( int $segment, int $size ): bool {
		if ( $segment !== $this->seal_segment || $size !== $this->seal_size ) {
			$this->seal_segment   = $segment;
			$this->seal_size  = $size;
			$this->seal_since = Core::$now;
			return false;
		}
		return ( Core::$now - $this->seal_since ) >= self::SEAL_GRACE_SECONDS;
	}

	/**
	 * Source Partition, materialized by arguments(). Throws if a read runs
	 * before configuration. Protected so a subclass reading a source the
	 * segment model cannot express (File_Tail's single inode) can say so by
	 * name rather than leaving the parent's invariant quietly violated.
	 */
	protected function source(): Partition_Node {
		if ( null === $this->source ) {
			throw new \RuntimeException( 'Consumer source partition not initialized; call arguments() first' );
		}
		return $this->source;
	}

	/**
	 * Clamp the cursor against the live (non-empty) segment list.
	 *
	 * Two recoveries: the cursor segment was deleted by cleanup (rewind to the
	 * oldest segment), or it was wiped and recreated smaller — a full sweep
	 * restarts ids at 0, so a durable checkpoint can sit past EOF (rewind to
	 * the segment start instead of waiting forever for the file to grow back).
	 * Shared by get_batch() and compute_lag() so reads and lag agree on position.
	 *
	 * @param array<int,array{id: int,size: int}> $segments Live segment list.
	 */
	protected function normalize_cursor( array $segments ): void {
		$sizes = \array_column( $segments, 'size', 'id' );
		if ( ! isset( $sizes[ $this->cursor_segment ] ) ) {
			$this->cursor_segment = $segments[0]['id'];
			$this->cursor_offset = 0;
			$this->buffer     = '';
		} elseif ( $sizes[ $this->cursor_segment ] < $this->cursor_offset + \strlen( $this->buffer ) ) {
			$this->cursor_offset = 0;
			$this->buffer     = '';
		}
	}

	/**
	 * This reader's resume point, `segment:offset`, for the `connected`
	 * envelope's CURSORS token.
	 *
	 * The offset is the next byte to read, which is what a resume seeks to —
	 * the same boundary a client derives from a delivered record's ID
	 * breadcrumb, so a stream that delivers nothing still hands it a position.
	 *
	 * @return string `{segment}:{offset}`.
	 */
	public function cursor_position(): string {
		return "{$this->cursor_segment}:{$this->cursor_offset}";
	}

	/**
	 * STEP's advance: drive ticks until exactly one message is emitted or EOF is
	 * reached. poll_init's first tick only loads the buffer (emits nothing in line
	 * mode), so always tick at least once, then keep going until one message lands
	 * or a poll leaves the reader genuinely at EOF with nothing buffered.
	 *
	 * @return array{segment:int, offset:int, at_eof:bool}
	 */
	protected function advance_one_message(): array {
		$before = $this->counter;
		do {
			$this->poll();
		} while ( $this->counter === $before && ! $this->at_eof );
		return [ 'segment' => $this->cursor_segment, 'offset' => $this->cursor_offset, 'at_eof' => $this->at_eof ];
	}

	/**
	 * Synchronous read-to-EOF — the messaging interface a CLI (reqgrep) drives
	 * instead of hand-rolling `read_at()` and its own decode. Polls the source
	 * until it is genuinely at EOF with no buffered complete line, filling each
	 * unpacked Message into the sink exactly as `poll()` does, then emits one
	 * terminal TM_EOF so the caller knows the stream ended. `fire()` is the
	 * event-loop wrapper of the same path.
	 *
	 * @api Cross-plugin CLI entrypoint — reqgrep (event-logger-nodes) drives it.
	 */
	public function drain(): void {
		do {
			$this->poll();
		} while ( ! $this->at_eof || false !== \strpos( $this->buffer, "\n" ) );
		$eof                  = Message::new_message();
		$eof[ Message::TYPE ] = Message::TM_EOF;
		$stamp                = '' !== $this->stamp_override ? $this->stamp_override : $this->name;
		if ( '' !== $stamp ) {
			$this->stamp_message( $eof, $stamp );
		}
		if ( \is_string( $this->target ) && '' !== $this->target ) {
			$eof[ Message::TO ] = $this->target;
		}
		$this->sink?->fill( $eof );
	}

	/** Turn the multi-writer seal-grace on or off. Set it true only for a shared log (the firehose). */
	public function set_multi_writer( bool $flag ): void {
		$this->multi_writer = $flag;
	}

	/**
	 * Re-emit the Consumer's persistent config verbs — the time-travel ones plus
	 * every schema-declared toggle currently on (`multi_writer`,
	 * `assume_clean_shutdown`) — after the base `make_node` and `connect_node`
	 * lines, so a console dump_config and replay round-trips them. Without the
	 * add_snapshot_node line a replayed Consumer loses its snapshot target, and the
	 * downstream stateful node's save_state() silently stops co-committing.
	 *
	 * @return string TSL lines, each newline-terminated.
	 */
	public function dump_config(): string {
		$out  = parent::dump_config();
		$out .= $this->dump_time_travel_config();
		$out .= $this->dump_toggles();
		return $out;
	}

	/** PLAY re-arm: the busy cadence; fire() backs it off to EOF once caught up. */
	protected function time_travel_resume(): void {
		$this->set_timer( self::POLL_INTERVAL_BUSY_MS );
	}

	/** Publish the CHECKPOINT state after each committed frame (the trait's post-commit hook). */
	protected function on_checkpoint_committed(): void {
		$this->set_state( 'CHECKPOINT', \implode( ' ', [ 'SEGMENT', $this->checkpoint_segment, 'OFFSET', $this->checkpoint_offset ] ) );
	}

	/** Override the FROM-stamp used when emitting messages; '' falls back to $this->name. */
	public function set_stamp_as( string $stamp ): void {
		$this->stamp_override = $stamp;
	}

	/** The FROM-stamp override ('' if unset). The SSE resolver names each Consumer by this. */
	public function stamped_as(): string {
		return $this->stamp_override;
	}

	/**
	 * The inspector's canvas-poll payload: the time-travel READ surface (keyframes,
	 * live cursor, polling state) merged with the dead-letter segment count it
	 * badges. `Durable_Reader` supplies the first half straight off the cursor and
	 * checkpoint fields; `Dead_Letter_Queue` supplies the second.
	 *
	 * @return array{frames: array<int,array{id:int,size:int}>, cursor: array{segment:int, offset:int}, polling: string, at_frame: int|null, on_frame: bool, deadletter_segments: int}
	 */
	public function dump_metadata(): array {
		return $this->time_travel_metadata() + $this->deadletter_metadata();
	}

	/**
	 * Drop the slots the base cascade just tore down. A slot still pointing at
	 * a torn-down node hands `ensure_offsetlog()`/`source()` a node whose name,
	 * sink and patron are gone — writes reach disk, nothing is addressable.
	 */
	public function remove_node(): void {
		parent::remove_node();
		$this->source     = null;
		$this->offsetlog  = null;
		$this->deadletter = null;
	}

	/**
	 * Topology console manifest: the palette entry, the three positional arguments
	 * `parse_schema_args()` assigns, and the verb set — dead-letter triage, time
	 * travel, the pump toggles and `set_multi_writer`.
	 *
	 * @return array<string,mixed>
	 */
	public static function node_schema(): array {
		return \array_merge( parent::node_schema(), [
			'category'      => 'I/O',
			'description'   => 'Tails a Partition; emits each appended message to its sink.',
			'arguments'     => [
				[ 'name' => 'source_dir',     'type' => 'string', 'required' => true, 'description' => 'Partition directory to tail; each {seg}.log segment\'s appended messages are emitted to the sink.' ],
				[ 'name' => 'offsetlog_dir',  'type' => 'string', 'default' => '', 'description' => 'Directory for the durable read-cursor offsetlog (resume-after-restart); empty disables checkpointing.' ],
				[ 'name' => 'deadletter_dir', 'type' => 'string', 'default' => '', 'description' => 'Directory where poison/dead-letter records are quarantined; empty disables the dead-letter queue.' ],
			],
			// Verbs: DLQ triage + time-travel + pump + set_multi_writer.
			'commands'      => \array_merge(
				self::deadletter_verbs(),
				self::time_travel_verbs(),
				self::pump_verbs(),
				[
					[
						'name'        => 'set_multi_writer',
						'description' => 'Enable the multi-writer seal-grace (shared logs, e.g. the firehose).',
						'args'        => [
							[ 'name' => 'enabled', 'type' => 'bool', 'required' => false, 'description' => 'A truthy value (1/true/yes/on) enables; anything else disables.' ],
						],
						'toggle'      => 'multi_writer',
					],
				]
			),
			'requests'      => [
				[
					'name'        => 'GET_LAG',
					'description' => 'Bytes/messages behind the source partition tail.',
					'reply_shape' => '{ bytes_behind, segments_behind, caught_up }',
				],
			],
			'registrations' => [ 'READY' ],
			'accepts_fill'  => false,
		] );
	}
}
