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
	use Offsetlog_Cursor;
	use Dead_Letter_Queue;
	use Time_Travel;
	use Buffered_Pump;

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

	/** Discard the resumable snapshot cache after this many seconds of an unbroken crash streak. */
	public const STATE_WIPE_AFTER_S = 900;

	/**
	 * Multi-writer source: apply the seal-grace (see SEAL_GRACE_SECONDS) before
	 * advancing off a segment that a newer segment supersedes. Set true ONLY for a
	 * genuinely shared log (the firehose); single-writer logs leave it false and
	 * advance immediately.
	 */
	protected bool $multi_writer = false;

	/** Seal-grace bookkeeping: the segment + size last seen caught-up, and when that size last changed. */
	protected int $seal_segment     = -1;
	protected float $seal_since = 0.0;
	protected int $seal_size    = -1;
	protected ?Partition_Node $source    = null;

	protected string $source_dir = '';

	/**
	 * Cache read from the offsetlog at construction but not yet restored — the
	 * snapshot node usually doesn't exist yet when load_offsetlog() runs, so we
	 * stash it and restore once set_snapshot_node() names the (now-built) node.
	 *
	 * @var array<array-key, mixed>|null
	 */
	private ?array $loaded_cache = null;

	/** Tachikoma-parity: no-arg ctor. Positional config arrives via arguments(). */
	public function __construct() {
		parent::__construct();
		// Build {name}:config interpreter so set_snapshot_node dispatchable.
		$this->auto_wire_interpreter();
	}

	/**
	 * Store the raw string, parse positional tokens via parse_schema_args()
	 * (source_dir / offsetlog_dir), then normalize, materialize the source / offsetlog
	 * Partitions (the offsetlog is a flat segmented-log dir) and seed the in-memory
	 * cursor from any existing offsetlog entries.
	 *
	 * @param list<string>|null $args
	 * @return list<string>
	 */
	public function arguments( ?array $args = null ): array {
		if ( null === $args ) {
			return parent::arguments();
		}
		$this->parse_schema_args( $args );
		[ $source_path, $offsetlog_path ] = $this->resolve_args();
		$this->source_dir    = \rtrim( $source_path, '/' );
		$this->offsetlog_dir = \rtrim( $offsetlog_path, '/' );

		$this->source = $this->make_source();
		if ( '' !== $this->name ) {
			$this->source->name( "{$this->name}:source" );
		}
		$this->source->arguments( [ $this->source_dir ] );
		$this->source->sink( $this->sink );
		$this->source->patron( $this );

		$this->ensure_offsetlog();

		$this->deadletter_dir = \rtrim( $this->deadletter_dir, '/' );
		$this->ensure_deadletter();

		// No I/O at construction: first poll loads cursor + restores snapshot.
		$this->poll_cb = $this->poll_init( ... );
		$this->set_timer( self::POLL_INTERVAL_EOF_MS, true );
		$this->set_state( 'POLLING', 'ACTIVE' );

		return $args;
	}

	/**
	 * Handle TM_REQUEST introspection verbs (reply TO=FROM); else defer to Timer.
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

	/** @param array<int, mixed> $message Incoming request Message. */
	private function handle_request( array $message ): void {
		if ( null === $this->sink ) {
			throw new \RuntimeException( 'fill requires a wired sink' );
		}
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
		$this->sink->fill( $reply );
	}

	/** Seam (Tail overrides → Log): the source segmented-log node to read. Consumer reads a Partition. */
	protected function make_source(): Partition_Node {
		return new Partition_Node();
	}

	/** Requeue target: the source Partition this Consumer tails, so dl_requeue re-injects into it. */
	protected function deadletter_requeue_target(): ?Partition_Node {
		return $this->source;
	}

	/**
	 * Seam (Tail overrides): [source_path, offsetlog_path] from the parsed schema args.
	 * Consumer's schema args are source_dir + offsetlog_dir.
	 *
	 * @return array{0:string,1:string}
	 */
	protected function resolve_args(): array {
		return [ $this->source_dir, $this->offsetlog_dir ];
	}

	/**
	 * Probe seam: the raw snapshot `TopicProbe` reads from outside this Consumer,
	 * as the POSITIONAL `Probe_Record` array (kept tiny for 24h SSE replay). Just
	 * the state at this instant — `SOURCE` (partition tailed) + `READER` (offsetlog
	 * dir basename, the durable per-reader id) + the consumer cursor + the partition
	 * END (newest segment + size, so the topologies tab trims its live list back to
	 * here) + `DISTANCE` (bytes behind, for the overview graph) + `MSGS`. Rates and
	 * totals are NOT logged — readers derive them from consecutive records.
	 *
	 * @return array<int,int|string> A `Probe_Record`-indexed positional array.
	 */
	public function probe_stats(): array {
		$lag                                    = $this->compute_lag();
		$record                                 = [];
		$record[ Probe_Record::SOURCE ]         = '' !== $this->source_dir ? \basename( $this->source_dir ) : '';
		$record[ Probe_Record::READER ]         = '' !== $this->offsetlog_dir ? \basename( $this->offsetlog_dir ) : '';
		$record[ Probe_Record::CURSOR_SEGMENT ] = $this->cursor_segment;
		$record[ Probe_Record::CURSOR_OFF ]     = $this->cursor_offset;
		$record[ Probe_Record::END_SEGMENT ]    = $lag['end_segment'];
		$record[ Probe_Record::END_SIZE ]       = $lag['end_size'];
		$record[ Probe_Record::DISTANCE ]       = $lag['bytes_behind'];
		$record[ Probe_Record::MSGS ]           = $this->counter;
		$record[ Probe_Record::END_BYTES ]      = $lag['end_bytes'];
		$record[ Probe_Record::CACHE_SIZE ]     = $this->offsetlog_cache_size();
		return $record;
	}

	/**
	 * Byte size of the consumer's newest offsetlog segment — the position-cache
	 * footprint the overview graphs. 0 for an ephemeral reader (no offsetlog) or
	 * before the first checkpoint writes a segment.
	 */
	private function offsetlog_cache_size(): int {
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

	/** @return array{bytes_behind: int, segments_behind: int, caught_up: bool, end_segment: int, end_size: int, end_bytes: int} */
	private function compute_lag(): array {
		\clearstatcache( true, $this->source()->partition_dir() );
		$segments = $this->source()->get_segments( true );
		if ( empty( $segments ) ) {
			return [ 'bytes_behind' => 0, 'segments_behind' => 0, 'caught_up' => true, 'end_segment' => 0, 'end_size' => 0, 'end_bytes' => 0 ];
		}
		// Recover deleted/recreated cursor first; stale one reads as caught up.
		$this->normalize_cursor( $segments );
		$bytes_behind     = 0;
		$segments_behind  = 0;
		$end_bytes        = 0;
		foreach ( $segments as $s ) {
			$id   = $s['id'];
			$size = $s['size'];
			// Absolute byte pos (sum of segment sizes); browser derives rate.
			$end_bytes += $size;
			if ( $id < $this->cursor_segment ) {
				continue;
			}
			if ( $id === $this->cursor_segment ) {
				$bytes_behind += \max( 0, $size - $this->cursor_offset );
			} else {
				$bytes_behind += $size;
				++$segments_behind;
			}
		}
		// Count buffered bytes as consumed so lag reflects bytes-to-emit.
		$bytes_behind = \max( 0, $bytes_behind - \strlen( $this->buffer ) );
		// Partition END from SAME read as cursor; topologies tab trims here.
		$last = \end( $segments );
		return [
			'bytes_behind'    => $bytes_behind,
			'segments_behind' => $segments_behind,
			'caught_up'       => 0 === $bytes_behind,
			'end_segment'         => $last['id'],
			'end_size'        => $last['size'],
			'end_bytes'       => $end_bytes,
		];
	}

	/**
	 * Buffered_Pump boot seam: Consumer's "where do I start" is a durable seek. Seed
	 * the cursor from the offsetlog, restore the snapshot node's state (the whole
	 * topology exists by the first poll), then apply the default_offset() seek when
	 * there's no checkpoint and no explicit next_offset(). A durable checkpoint
	 * OVERRIDES a pre-poll next_offset() (resume wins); with no checkpoint, that seek
	 * stands.
	 */
	protected function init_position(): void {
		$this->load_offsetlog();
		if ( null !== $this->loaded_cache && '' !== $this->snapshot_node ) {
			$node = Core::node( $this->snapshot_node );
			if ( null !== $node && \method_exists( $node, 'restore_state' ) ) {
				$node->restore_state( $this->loaded_cache );
				// Restore survived: recommit cache stateful; boot stateless.
				$this->write_checkpoint_frame( false, true );
			} else {
				$this->print_less_often( "WARNING: snapshot node '{$this->snapshot_node}' missing or has no restore_state(); discarding restored cache" );
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
		if ( 'drop' === $this->skip_head_disposition ) {
			// Booted on quarantine marker: seal boot pos until drop passes it.
			$this->sealed_quarantine = [ 'segment' => $this->cursor_segment, 'offset' => $this->cursor_offset ];
		}
		// Offset + cache from ONE record, so cursor and state stay aligned.
		$this->loaded_cache = \is_array( $entry['cache'] ?? null ) ? $entry['cache'] : null;
		// Crash streak past wipe window: discard the corrupt resumable state.
		if (
			null !== $this->loaded_cache
			&& null !== $this->first_crash_ts
			&& ( Core::$now - $this->first_crash_ts ) > self::STATE_WIPE_AFTER_S
		) {
			$this->print_less_often( 'WARNING: snapshot cache exceeded ' . self::STATE_WIPE_AFTER_S . 's crash streak; discarding (suspected corrupt state, not a poison message)' );
			$this->loaded_cache = null;
		}
		// Stateless boot frame BEFORE restore: crash still advances counter.
		$this->write_checkpoint_frame( false, false );
	}

	/**
	 * True if this Consumer resumed from a durable offsetlog checkpoint (seg/off
	 * default to -1; poll_init's load_offsetlog seeds them ≥0). Only meaningful
	 * after the first poll — construction does no I/O. To pick a first-spawn start
	 * position, call next_offset() at build; poll_init resumes from the checkpoint
	 * when one exists (overriding that seek) and keeps it otherwise.
	 */
	public function has_checkpoint(): bool {
		return -1 !== $this->checkpoint_segment || -1 !== $this->checkpoint_offset;
	}

	/**
	 * Seam (Tail overrides → 'end'): first-spawn cursor when there's no durable
	 * checkpoint AND no explicit next_offset(). null = leave at the constructed
	 * default (0:0 = start), which is Consumer's behavior.
	 */
	protected function default_offset(): ?string {
		return null;
	}

	/**
	 * Set next read position: 'start' | 'recent' | 'end' | array{segment,offset}.
	 *
	 * @param string|array<array-key, mixed> $position Magic value or explicit position (reads 'segment'/'offset').
	 */
	public function next_offset( $position ): void {
		$this->offset_set = true;
		$this->buffer     = '';
		$this->at_eof     = false;

		if ( \is_array( $position ) ) {
			$segment = $position['segment'] ?? 0;
			$offset  = $position['offset'] ?? 0;
			$this->cursor_segment = Core::num_int( $segment );
			$this->cursor_offset = \max( 0, Core::num_int( $offset ) );
			return;
		}

		$segments = $this->source()->get_segments( true );

		switch ( $position ) {
			case 'end':
				if ( ! empty( $segments ) ) {
					$newest = \end( $segments );
					$this->cursor_segment = $newest['id'];
					$this->cursor_offset = $newest['size'];
				}
				break;

			case 'recent':
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

			case 'start':
			default:
				$this->cursor_segment = 0;
				$this->cursor_offset = 0;
				break;
		}
	}

	/**
	 * @param bool $graceful Final checkpoint of a clean shutdown — stamps attempts=0
	 *                       (the cursor sits at an un-attempted message), so a respawn
	 *                       resumes at a virgin first attempt rather than counting a strike.
	 */
	public function checkpoint( bool $graceful = false ): void {
		// Skip an unestablished cursor: 0:0 commit clobbers durable pos.
		if ( null === $this->offsetlog || ( ! $this->poll_initialized && ! $this->offset_set ) ) {
			return;
		}
		// Advance-guard: skip redundant same-cursor write (graceful is exempt).
		if ( ! $graceful && ! $this->cursor_moved_since_checkpoint( $this->cursor_segment, $this->cursor_offset ) ) {
			return;
		}
		// Progress past boot cursor ends crash streak; not while crawling.
		if ( ! $graceful && ! $this->crawl && $this->cursor_advanced_since_boot() ) {
			$this->attempts       = 1;
			$this->first_crash_ts = null;
			$this->poison_reason  = '';
		}
		$this->write_checkpoint_frame( $graceful, true );
	}

	/**
	 * Commit one offsetlog frame at the current cursor — UNCONDITIONALLY (no
	 * advance-guard; the boot sequence re-commits the same cursor on purpose). The
	 * shared base frame + Consumer's static extra ride commit_checkpoint_frame(); the
	 * only per-call variation is the snapshot cache.
	 *
	 * @param bool                    $graceful   Stamp attempts=0 (clean handoff) instead of the live count.
	 * @param bool                    $with_state Co-commit the snapshot node's save_state(). False for the
	 *                                            stateless boot frame written BEFORE restore — reading the
	 *                                            un-restored node there would clobber the good cache.
	 * @param array<array-key, mixed> $extra      Per-call frame additions (the quarantine marker).
	 */
	protected function write_checkpoint_frame( bool $graceful, bool $with_state, array $extra = [] ): void {
		// Co-commit snapshot with offset as ONE record for lockstep respawn.
		if ( $with_state && '' !== $this->snapshot_node ) {
			$node = Core::node( $this->snapshot_node );
			if ( null !== $node && \method_exists( $node, 'save_state' ) ) {
				$extra['cache'] = $node->save_state();
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
	 * @return array<array-key, mixed>
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

	/** Worker-type env tag (set by SpawnController after HMAC auth); '' when unset. */
	private static function worker_type_env(): string {
		// phpcs:ignore WordPress.Security.ValidatedSanitizedInput.InputNotSanitized -- env var is set by SpawnController after HMAC auth.
		return Core::as_string( $_SERVER['NEWSPACK_NODES_WORKER_TYPE'] ?? '' );
	}

	/**
	 * Read at most one READ_BLOCK_BYTES block into $buffer (Tachikoma get_batch +
	 * Partition::process_get). Rolls to the next segment when the current one is
	 * drained, sets at_eof when caught up, and bounds a single oversized line.
	 *
	 * The Buffered_Pump refill seam: Consumer's synchronous disk read. A push source
	 * (Remote_Source_Node) implements the same abstract seam by arming its curl valve.
	 */
	protected function get_batch(): void {
		// Defeat stat cache so growth from another process's writer visible.
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

	/** Source Partition, materialized by arguments(). Throws if a read runs before configuration. */
	private function source(): Partition_Node {
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
	 * Shared by poll() and compute_lag() so reads and lag agree on position.
	 *
	 * @param array<int, array{id: int, size: int}> $segments Live segment list.
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

	// Time-travel transport hooks; shared machinery in the Time_Travel trait.

	/**
	 * STEP's advance: drive ticks until exactly one message is emitted or EOF is
	 * reached. poll_init's first tick only loads the buffer (emits nothing in line
	 * mode), so always tick at least once, then keep going until one message lands
	 * or a poll leaves us genuinely at EOF with nothing buffered.
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
	 * Synchronous read-to-EOF — the messaging interface a CLI (reqgrep) drives instead
	 * of hand-rolling read_bytes_at + decode. This is Tachikoma v2.0's drain(): poll the
	 * source until it is genuinely at EOF with no buffered complete line, fill()ing each
	 * unpacked Message into the sink as poll() does, then emit one terminal TM_EOF (its
	 * drain tail). The Consumer's fire_cb is the async event-loop wrapper of the same path.
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

	/** Enable/disable the multi-writer seal-grace. Set true only for a shared log (the firehose). */
	public function set_multi_writer( bool $flag ): void {
		$this->multi_writer = $flag;
	}

	/**
	 * Re-emit the Consumer's persistent config verbs (the shared time-travel ones plus
	 * `set_multi_writer`) after the base `make_node`/`connect_node` lines, so a console
	 * dump_config → replay round-trips them. Without the snapshot_node line, a replayed
	 * Consumer loses its snapshot target and the downstream stateful node's save_state()
	 * silently stops co-committing.
	 */
	public function dump_config(): string {
		$out  = parent::dump_config();
		$out .= $this->dump_time_travel_config( $this->name );
		$out .= $this->dump_pump_config( $this->name );
		if ( $this->multi_writer ) {
			// Explicit `1`: bare/empty arg disables, flips multi_writer false.
			$out .= "cmd {$this->name}:config set_multi_writer 1\n";
		}
		return $out;
	}

	/**
	 * `set_multi_writer` verb handler — toggle the patron's seal-grace. Only an
	 * explicit truthy arg (`1`/`true`/`yes`/`on`) enables it; anything else disables,
	 * so the default stays "off" (single-writer, immediate advance).
	 *
	 * @param Command_Interpreter_Node $interpreter The `{name}:config` interpreter.
	 * @param array<array-key, mixed>  $args        Optional bool; only a truthy value enables.
	 */
	public static function cmd_set_multi_writer( Command_Interpreter_Node $interpreter, array $args ): string {
		$patron = $interpreter->patron();
		if ( $patron instanceof self ) {
			$patron->set_multi_writer( \in_array( \strtolower( Core::as_string( $args[0] ?? '' ) ), [ '1', 'true', 'yes', 'on' ], true ) );
		}
		return 'ok';
	}

	/** PLAY re-arm: the busy-cadence oneshot fire() loop. */
	protected function time_travel_resume(): void {
		$this->set_timer( self::POLL_INTERVAL_BUSY_MS, true );
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
	 * Fold the time-travel READ surface (frames + cursor) into the canvas-poll
	 * payload the inspector round-trips. Delegates to the Time_Travel trait, which
	 * reads the cursor/checkpoint fields directly.
	 *
	 * @return array{frames: array<int, array{id:int,size:int}>, cursor: array{segment:int, offset:int}, polling: string, at_frame: int|null, on_frame: bool, deadletter_segments: int}
	 */
	public function dump_metadata(): array {
		return $this->time_travel_metadata() + $this->deadletter_metadata();
	}

	protected function check_name_availability( string $name ): void {
		parent::check_name_availability( $name );
		if ( null !== $this->source && null !== Core::node( "{$name}:source" ) ) {
			throw new \RuntimeException( \esc_html( "node name collision: {$name}:source already registered" ) );
		}
		if ( null !== $this->offsetlog && null !== Core::node( "{$name}:offsetlog" ) ) {
			throw new \RuntimeException( \esc_html( "node name collision: {$name}:offsetlog already registered" ) );
		}
		if ( null !== $this->deadletter && null !== Core::node( "{$name}:deadletter" ) ) {
			throw new \RuntimeException( \esc_html( "node name collision: {$name}:deadletter already registered" ) );
		}
	}

	protected function set_sibling_names( ?string $name = null ): void {
		$this->source?->name( "{$name}:source" );
		$this->offsetlog?->name( "{$name}:offsetlog" );
		$this->deadletter?->name( "{$name}:deadletter" );
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
			if ( null !== $this->deadletter ) {
				$this->deadletter->sink( $node );
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
		if ( null !== $this->deadletter ) {
			$this->deadletter->remove_node();
		}
		parent::remove_node();
	}

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
						'handler'     => static fn ( Command_Interpreter_Node $interpreter, array $args ): string => self::cmd_set_multi_writer( $interpreter, $args ),
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
