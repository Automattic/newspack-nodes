<?php
/**
 * Partition: file-segmented append-only log.
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes;

if ( ! \defined( 'ABSPATH' ) ) {
	exit;
}

class Partition_Node extends Timer_Node {
	use Schema_Reflection;
	use File_Writer;
	use Dead_Letter_Queue;
	public const DEFAULT_LIFETIME     = 0;
	/** Hard-cap default sentinel: 0 = derive as 2 × num_segments (see derive_max_segments()). */
	public const DEFAULT_MAX_SEGMENTS = 0;
	public const DEFAULT_MIN_LIFETIME = 0;
	public const DEFAULT_MIN_SEGMENTS = 2;
	public const DEFAULT_NUM_SEGMENTS = 4;

	public const DEFAULT_SEGMENT_SIZE = 67108864;

	/**
	 * Default write-lock wait, for EXTERNAL writers — a page render through
	 * pyrobase's Log runtime, `wp nodes ingest` — that hold no worker lease and
	 * have no loop to retry from. Long enough to ride out a live writer's burst,
	 * short enough that a web request never hangs on one.
	 *
	 * @longform It deliberately does NOT outwait a crashed predecessor's lock,
	 * which only becomes stealable once its heartbeat ages past STALE_TIMEOUT.
	 * Sitting through that window means blocking longer than the lease anyone
	 * inside a drain loop is working under, so the safe default is to fail and
	 * let the caller come back. Topology workers pass 0 (try-lock) or a debounce
	 * window and retry on their next tick, which costs nothing.
	 */
	public const DEFAULT_LOCK_WAIT_MS = 15000;

	public const DRIFT_RESCAN_INTERVAL_SECONDS = 1.0;
	public const MAX_LARGE_LINE_SIZE  = 33554432;
	public const MAX_LINE_SIZE        = 4096;

	/** Inter-process rotation lock TTL: anything older counts as stale. */
	public const ROTATE_LOCK_TTL_SECONDS = 5;
	public const SEGMENT_CACHE_TTL    = 0.25;
	public const SEGMENT_PATTERN      = '/^(\d+)\.log$/';

	/**
	 * get_segments() directory-scan seam. Lazily-defaulted at the call site to a
	 * closure wrapping the real scandir; tests reassign this in-place (then reset
	 * to null in a finally) to count or stub the directory scan WITHOUT
	 * short-circuiting the rest of get_segments()'s pattern-match + filesize +
	 * sort path, so that production logic stays under real coverage.
	 *
	 * Signature: `function ( string $dir ): array|false`.
	 *
	 * @var (\Closure(string): (list<string>|false))|null
	 */
	public static ?\Closure $scandir = null;

	/** @var array<string, string> Resolved partition dirs written since the last flush. */
	private static array $pending_wakes = [];

	/** Guards the one shutdown-time flush registration per process. */
	private static bool $wake_flush_registered = false;

	protected bool $allow_large_writes = false;

	/** @var string Packed messages awaiting one PIPE_BUF-atomic syswrite. */
	protected string $batch = '';

	/** @var list<array{message:array<int, mixed>,size:int}> Flushed in lockstep with $batch. */
	protected array $batch_index_args = [];
	protected ?string $current_idx_path = null;
	protected ?string $current_log_path = null;

	protected ?int $current_segment_id = null;
	protected int $current_size = 0;

	/**
	 * Debounced-lock mode ([65]): when > 0, allow_large_writes acquires the write lock
	 * lazily on the first write of a burst and releases it after this many ms of idle
	 * (fire() debounces the release), so other processes can write between bursts. 0 =
	 * the default acquire-and-hold-for-life mode. $lock_held tracks current ownership;
	 * $last_write_at (Core::$now seconds) is the idle reference the debounce measures from.
	 */
	protected int $debounce_lock_ms = 0;

	/** @var resource|null */
	protected $fh = null;
	protected int $fh_segment_id = -1;
	protected ?Timer_Node $heartbeat_timer = null;
	/** @var resource|null */
	protected $idx_fh = null;

	/** @var (callable(array<int, mixed>, array<string, int>): (string|null))|null fn(array $message, array $position) => string|null */
	protected $index_callback = null;
	/** Formatter name set via the `with_index` verb — the round-trippable form of the index callback (which itself can't be dumped). */
	protected ?string $index_formatter_name = null;
	protected float $last_lock_heartbeat = 0.0;

	protected float $last_segment_check = 0.0;
	protected float $last_write_at = 0.0;
	protected bool $lock_held = false;
	protected int $lock_max_wait_ms = 0;
	protected int $lock_stale_timeout = 0;
	protected int $lifetime         = self::DEFAULT_LIFETIME;
	/** True HARD cap: prune oldest UNCONDITIONALLY above this (only the floor of 2 protects). 0 until arguments() derives it. */
	protected int $max_segments     = self::DEFAULT_MAX_SEGMENTS;
	protected int $min_lifetime     = self::DEFAULT_MIN_LIFETIME;
	protected int $min_segments     = self::DEFAULT_MIN_SEGMENTS;
	/** Count-rule target: prune above this only for segments older than min_lifetime. */
	protected int $num_segments     = self::DEFAULT_NUM_SEGMENTS;

	/** Resolved segment directory ( = the rtrim'd $dir ); segments live at {partition_dir}/{seg}.log. */
	protected string $partition_dir = '';

	protected int $segment_size     = self::DEFAULT_SEGMENT_SIZE;

	/** @var array<int, array{id:int, size:int}>|null Cached on-disk segment list (id + byte size), sorted by id. */
	protected ?array $segments_cache = null;
	protected float $segments_cache_time = 0.0;
	protected ?Lock_Node $write_lock = null;
	/** True when the large-write cap was lifted via void_warranty() (no lock) rather than allow_large_writes() (held lock) — drives which verb dump_config round-trips. */
	private bool $warranty_voided = false;

	/** Tachikoma-parity: no-arg ctor. Wires the sibling :config interpreter; positional config arrives via arguments(). */
	public function __construct() {
		parent::__construct();
		$this->auto_wire_interpreter();
	}

	/**
	 * Store the raw string, parse positional tokens via parse_schema_args(), then
	 * normalize the values. partition_dir is the resolved $dir; a bare make_node
	 * leaves it ''. Getter returns the raw string.
	 *
	 * @param list<string>|null $args
	 * @return list<string>
	 */
	public function arguments( ?array $args = null ): array {
		if ( null === $args ) {
			return parent::arguments();
		}
		$this->parse_schema_args( $args );
		$this->partition_dir  = \rtrim( $this->partition_dir, '/' );
		Config::assert_within_base( $this->partition_dir );
		$this->segment_size   = \max( 1, $this->segment_size );
		$this->min_segments   = \max( 2, $this->min_segments );
		$this->num_segments   = \max( $this->min_segments, $this->num_segments );
		$this->min_lifetime   = \max( 0, $this->min_lifetime );
		$this->lifetime       = \max( 0, $this->lifetime );
		$this->max_segments   = self::derive_max_segments( $this->num_segments, $this->max_segments );
		$this->deadletter_dir = self::derive_write_deadletter_dir( $this->partition_dir );
		return $args;
	}

	/**
	 * Node entry point: pack the message and append to the current segment.
	 *
	 * @param array<int, mixed> $message Reference; not mutated.
	 */
	public function fill( array $message ): void {
		++$this->counter;

		// One read/fill: cached if set, else one warming read; threaded down.
		$now = Core::$now ?: Core::right_now();

		// Debounced: hold lock for the burst; arm timer so fire() frees it.
		if ( $this->debounce_lock_ms > 0 ) {
			$this->ensure_debounced_lock();
			$this->last_write_at = $now;
			$this->set_timer( $this->debounce_lock_ms, true );
		}

		// No-event-loop heartbeat: throw if heartbeat() shows lost ownership.
		if ( $this->allow_large_writes && $this->lock_held && null === $this->heartbeat_timer && null !== $this->write_lock ) {
			// Staleness needs a REAL clock: no drain refreshes the cache here.
			$hb_now = Core::right_now();
			if ( $hb_now - $this->last_lock_heartbeat >= $this->lock_stale_timeout / 3.0 ) {
				if ( ! $this->write_lock->heartbeat() ) {
					throw new \RuntimeException(
						\esc_html(
							"Partition: write lock at {$this->write_lock_path()} "
							. 'no longer owned (stolen via stale-takeover); cannot continue.'
						)
					);
				}
				$this->last_lock_heartbeat = $hb_now;
			}
		}

		// Size cap is on the packed bytes (not VALUE) — what hits PIPE_BUF.
		$record = $this->serialize_record( $message );
		$max    = $this->allow_large_writes ? self::MAX_LARGE_LINE_SIZE : self::MAX_LINE_SIZE;
		$size   = \strlen( $record );
		if ( $size > $max ) {
			$this->drop_message( $message, "oversize: {$size} > {$max}" );
			return;
		}

		$this->mark_pending_wake();

		if ( $size > $this->largest_msg_sent ) {
			$this->largest_msg_sent = $size;
		}

		if ( null === $this->current_segment_id ) {
			$this->init_current_segment();
		}

		$this->maybe_rescan_segments( $now );

		// Large messages bypass the batch; flush it first to preserve ordering.
		if ( $size > self::MAX_LINE_SIZE ) {
			$this->flush();
			if ( $this->current_size + $size > $this->segment_size ) {
				$this->rotate_segment();
			}
			$fh = $this->get_handle();
			if ( null === $fh ) {
				$this->quarantine_unwritten( [ [ 'message' => $message, 'size' => $size ] ], 0, 'segment open failed' );
				return;
			}
			$offset              = $this->current_size;
			$wrote               = $this->write_all( $fh, $record, $this->current_log_path );
			$this->current_size += $wrote;
			if ( $wrote < $size ) {
				$this->recover_write_stall( $fh, $offset, [ [ 'message' => $message, 'size' => $size ] ], $wrote );
				return;
			}
			if ( null !== $this->index_callback ) {
				$this->write_index_entry( $message, $offset, $size );
			}
			$this->touch_segments_cache();
			// Durable write done; honor a pending stop (flush no-ops here).
			$this->maybe_stop();
			return;
		}

		// Flush before batch would exceed PIPE_BUF, keeping the write atomic.
		if ( '' !== $this->batch && \strlen( $this->batch ) + $size > self::MAX_LINE_SIZE ) {
			$this->flush();
		}

		if ( $this->current_size + $size > $this->segment_size ) {
			$this->rotate_segment();
		}

		$this->batch              .= $record;
		$this->batch_index_args[]  = [
			'message' => $message,
			'size'    => $size,
		];

		// Beat the heartbeat after batching; a stop flushes it durable first.
		$this->maybe_stop();

		// 0-delay one-shot flush at the end of this event-loop iteration.
		$this->set_timer( 0, true );
	}

	/** Timer fire: drain the batch at the end of the current event-loop iteration. */
	protected function fire(): void {
		$this->flush();
		// Debounced: free lock once idle past the window, else re-arm.
		if ( $this->debounce_lock_ms > 0 && $this->lock_held ) {
			$idle_ms = ( Core::$now - $this->last_write_at ) * 1000.0;
			if ( $idle_ms >= $this->debounce_lock_ms ) {
				$this->release_debounced_lock();
			} else {
				$this->set_timer( $this->debounce_lock_ms, true );
			}
		}
	}

	/**
	 * Note that this partition was written to, for the next flush to act on.
	 *
	 * @longform Every producer reaches disk through a Partition — Job_Intake
	 * writes one, a Topic fans into them, a Log extends one, a worker's IPC is
	 * one — so this is the single place that sees every hop. Hanging the wake
	 * off producer helpers covered only the FIRST hop: a job routed firehose →
	 * jobs, or drained jobintake → jobs, landed where nothing woke its reader.
	 *
	 * Marking is deliberately cheap — the resolved directory as its own key, no
	 * lookup, no I/O — because this runs per message. The work happens at flush:
	 * on the router tick inside a drain loop, and at shutdown in request scope,
	 * so a web request never pays it on the way out. The path IS the key, so
	 * nothing here parses a partition out of a name.
	 */
	private function mark_pending_wake(): void {
		$dir                         = \rtrim( $this->segment_dir(), '/' );
		self::$pending_wakes[ $dir ] = $dir;
		if ( ! self::$wake_flush_registered ) {
			self::$wake_flush_registered = true;
			\register_shutdown_function( [ self::class, 'flush_pending_wakes' ] );
		}
	}

	/**
	 * Resolve the hard-cap ceiling: an explicit value floored to num_segments, or —
	 * when unset (0) — the derived default of twice the target count. The single
	 * place the num_segments → max_segments derivation lives; the admin + CI disk-
	 * ceiling displays call it so what they show matches what cleanup_segments()
	 * actually enforces.
	 */
	public static function derive_max_segments( int $num_segments, int $max_segments ): int {
		$num_segments = \max( 2, $num_segments ); // mirror arguments()' floor
		$cap          = $max_segments > 0 ? $max_segments : 2 * $num_segments;
		return \max( $num_segments, $cap );
	}

	/**
	 * Write-stall quarantine dir ([159]): `{base}/deadletter/{dir-under-base,
	 * dotted}` — unique per partition dir, beside the read-side consumer DLQs.
	 * Anything already under deadletter/ gets NONE (a quarantine quarantining
	 * into a quarantine would chain forever on a full disk).
	 */
	private static function derive_write_deadletter_dir( string $dir ): string {
		if ( '' === $dir ) {
			return '';
		}
		$base = \rtrim( Config::get_base_directory(), '/' );
		$rel  = \str_starts_with( $dir, "{$base}/" ) ? \substr( $dir, \strlen( $base ) + 1 ) : \ltrim( $dir, '/' );
		if ( \str_starts_with( $rel, 'deadletter/' ) ) {
			return '';
		}
		return "{$base}/deadletter/" . \str_replace( '/', '.', $rel );
	}

	/**
	 * Beat the worker heartbeat from inside a long in-process write burst (pump()).
	 * If the cooperative stop is honored, flush the batched in-flight message to disk
	 * BEFORE the throw unwinds so the Consumer can commit past it (the clean-stop
	 * contract) — close_handle does NOT flush, and remove_node's teardown flush lands
	 * too late (after the Consumer has already committed). The large-write path already
	 * wrote synchronously, so the flush is a no-op there.
	 */
	private function maybe_stop(): void {
		try {
			Event_Framework::instance()->pump();
		} catch ( Worker_Should_Stop $e ) {
			// Stop takes priority: a flush failure must not replace it.
			try {
				$this->flush();
			} catch ( \Throwable $flush_error ) {
				$this->print_less_often( 'flush failed during cooperative stop: ', $flush_error->getMessage() );
			}
			throw $e;
		}
	}

	/**
	 * Seam (Log overrides): bytes written per fill()'d message. Partition = packed envelope + newline.
	 *
	 * @param array<int, mixed> $message
	 */
	protected function serialize_record( array $message ): string {
		return Message::packed( $message ) . "\n";
	}

	/**
	 * Drift / TOCTOU recovery: rescan and follow the newest segment if a peer rotated.
	 */
	protected function maybe_rescan_segments( ?float $now = null ): void {
		// fill() threads its read; else cached clock (no clobber) or warm.
		$now = $now ?? ( Core::$now ?: Core::right_now() );
		if ( $now - $this->last_segment_check < self::DRIFT_RESCAN_INTERVAL_SECONDS ) {
			return;
		}
		$this->last_segment_check = $now;
		$segments                 = $this->get_segments( true, $now );
		if ( empty( $segments ) ) {
			return;
		}
		$newest = \end( $segments );
		if ( $newest['id'] !== $this->current_segment_id ) {
			$this->close_handle();
			$this->current_segment_id = $newest['id'];
			$this->current_size       = $newest['size'];
			$this->current_log_path   = $this->get_segment_path( $this->current_segment_id );
			$this->current_idx_path   = $this->get_index_path( $this->current_segment_id );
		}
	}

	public function partition_dir(): string {
		return $this->segment_dir();
	}

	public function __destruct() {
		// Flush residual batch so request-scope writes aren't GC'd unwritten.
		$this->flush();
		$this->close_handle();
	}

	/**
	 * Truncate the offsetlog AFTER a segment: delete every segment with id > $segment,
	 * then reset the write state so the offsetlog resumes coherently FROM $segment —
	 * the next rotate lands at $segment + 1, monotonic, no gap, no survivor
	 * overwritten. No-op when $segment is the newest, past the newest, or absent.
	 *
	 * Backs the Consumer time-travel PLAY truncate-on-resume: after a rewind seek,
	 * PLAY drops the now-stale forward frames before re-arming so the re-written
	 * timeline stays monotonic. The OFFSETLOG only — never the source log.
	 *
	 * @api Consumed by Consumer_Node::play() (time-travel replay), not in-substrate.
	 */
	public function truncate_after( int $segment ): void {
		$segments = $this->get_segments( true );
		$sizes    = \array_column( $segments, 'size', 'id' );
		if ( ! isset( $sizes[ $segment ] ) ) {
			return; // Absent or past the newest — nothing to truncate.
		}

		$survivors = [];
		foreach ( $segments as $s ) {
			if ( $s['id'] <= $segment ) {
				$survivors[] = $s;
				continue;
			}
			// Partition's segment dir is base_dir-relative — not WP-managed.
			// phpcs:disable WordPressVIPMinimum.Functions.RestrictedFunctions.file_ops_unlink
			@\unlink( $this->get_segment_path( $s['id'] ) );
			@\unlink( $this->get_index_path( $s['id'] ) );
			// phpcs:enable
		}

		$this->close_handle();
		$this->current_segment_id = $segment;
		$this->current_size       = $sizes[ $segment ];
		$this->current_log_path   = $this->get_segment_path( $segment );
		$this->current_idx_path   = $this->get_index_path( $segment );

		// $survivors is already 0-indexed by id — no array_values() re-key.
		$this->segments_cache      = $survivors;
		$this->segments_cache_time = Core::$now ?: Core::right_now();
	}

	/** Flush the residual batch, then close file handles + release write lock before normal Node teardown. */
	public function remove_node(): void {
		$this->flush(); // deterministic shutdown flush (cleanup_all_nodes), not GC/__destruct
		$this->close_handle();
		// Timer::remove_node() unregisters it from _router's TIMER list.
		if ( null !== $this->heartbeat_timer ) {
			$this->heartbeat_timer->remove_node();
			$this->heartbeat_timer = null;
		}
		if ( null !== $this->write_lock ) {
			// Release only a lock we hold — a debounced peer may own it now.
			if ( $this->lock_held ) {
				$this->write_lock->release();
			}
			// Unregister the sibling: a later Partition may reuse the name.
			$this->write_lock->remove_node();
			$this->write_lock = null;
		}
		parent::remove_node();
	}

	/**
	 * Lift the line-size limit to MAX_LARGE_LINE_SIZE (32 MiB) and acquire a Lock
	 * serializing cross-process writes.
	 *
	 * Requires name() and sink() to be set BEFORE this is called.
	 *
	 * @param int $max_wait_ms Lock acquisition timeout (ms).
	 * @param int $debounce_ms 0 (default) = acquire the lock now and hold it for life.
	 *                         > 0 = debounced mode: acquire lazily on each write burst and
	 *                         release after this many ms of idle so other writers can take
	 *                         turns ([65]). Lock acquisition is deferred to the first write.
	 * @throws \RuntimeException when the lock cannot be acquired (hold mode).
	 * @return self
	 */
	public function allow_large_writes( int $max_wait_ms = self::DEFAULT_LOCK_WAIT_MS, int $debounce_ms = 0 ): self {
		$stale_timeout = 60;
		$lock          = new Lock_Node( $this->write_lock_path(), $stale_timeout );

		// Sibling lock: name it, share our sink, patron-link to hide it.
		if ( '' !== $this->name ) {
			$lock->name( "{$this->name}:lock" );
		}
		$lock->sink( $this->sink );
		$lock->patron( $this );

		$this->allow_large_writes = true;
		$this->write_lock         = $lock;
		$this->lock_stale_timeout = $stale_timeout;
		$this->lock_max_wait_ms   = $max_wait_ms;

		if ( $debounce_ms > 0 ) {
			// Debounced: fill() grabs the lock per burst, fire() frees it.
			$this->debounce_lock_ms = $debounce_ms;
			return $this;
		}

		// Hold mode: acquire for life; arm heartbeat Timer, else fill() drives.
		$ef_running = Event_Framework::instance()->is_running();

		if ( ! $lock->acquire( $max_wait_ms ) ) {
			throw new \RuntimeException(
				\esc_html(
					"Partition::allow_large_writes() failed to acquire write lock at "
					. "{$this->write_lock_path()} after {$max_wait_ms}ms — another live writer holds it. "
					. 'Two concurrent writers on the same Partition is unsupported.'
				)
			);
		}

		$this->lock_held           = true;
		$this->last_lock_heartbeat = Core::right_now();

		if ( $ef_running ) {
			// Heartbeat cadence = stale_timeout/3 ms; 3 ticks per stale window.
			$this->heartbeat_timer = new Timer_Node();
			$this->heartbeat_timer->name( "{$this->name}:heartbeat" );
			$this->heartbeat_timer->arguments( [ (string) \intdiv( $stale_timeout * 1000, 3 ) ] );
			$this->heartbeat_timer->sink( $this->write_lock );
			$this->heartbeat_timer->key( 'heartbeat' );
			$this->heartbeat_timer->patron( $this );
		}

		return $this;
	}

	/**
	 * Debounced mode: acquire the write lock for the current burst if we don't hold it,
	 * re-syncing segment state from disk afterwards — another writer may have appended or
	 * rotated while we held nothing, so the cached handle/segment/size are stale ([65]).
	 *
	 * @throws \RuntimeException when the lock can't be acquired within lock_max_wait_ms.
	 */
	private function ensure_debounced_lock(): void {
		if ( $this->lock_held || null === $this->write_lock ) {
			return;
		}
		if ( ! $this->write_lock->acquire( $this->lock_max_wait_ms ) ) {
			throw new \RuntimeException(
				\esc_html(
					'Partition::allow_large_writes() (debounced) failed to acquire write lock at '
					. "{$this->write_lock_path()} after {$this->lock_max_wait_ms}ms — another writer holds it."
				)
			);
		}
		$this->lock_held           = true;
		$this->last_lock_heartbeat = Core::right_now();
		// Drop cached position/handle: the live disk end is authoritative now.
		$this->close_handle();
		$this->current_segment_id = null;
		$this->segments_cache     = null;
	}

	/** Debounced mode: drain the batch, close the handle, and free the lock for other writers ([65]). */
	private function release_debounced_lock(): void {
		$this->flush();
		$this->close_handle();
		if ( null !== $this->write_lock ) {
			$this->write_lock->release();
		}
		$this->lock_held = false;
	}

	/** Append $batch to the current segment, then write companion index entries with post-flush offsets. */
	public function flush(): void {
		if ( '' === $this->batch ) {
			return;
		}
		$batch_bytes = $this->batch;
		$batch_args  = $this->batch_index_args;
		// Reset up-front so an exception below doesn't cause a re-flush loop.
		$this->batch             = '';
		$this->batch_index_args  = [];

		if ( null === $this->current_segment_id ) {
			$this->init_current_segment();
		}

		$batch_len = \strlen( $batch_bytes );
		if ( $this->current_size + $batch_len > $this->segment_size ) {
			$this->rotate_segment();
		}

		$fh = $this->get_handle();
		if ( null === $fh ) {
			$this->quarantine_unwritten( $batch_args, 0, 'segment open failed' );
			return;
		}
		$start_offset        = $this->current_size;
		$wrote               = $this->write_all( $fh, $batch_bytes, $this->current_log_path );
		$this->current_size += $wrote;
		$kept                = \count( $batch_args );
		if ( $wrote < $batch_len ) {
			$kept = $this->recover_write_stall( $fh, $start_offset, $batch_args, $wrote );
		}

		if ( null !== $this->index_callback ) {
			$offset = $start_offset;
			foreach ( \array_slice( $batch_args, 0, $kept ) as $item ) {
				$this->write_index_entry( $item['message'], $offset, $item['size'] );
				$offset += $item['size'];
			}
		}

		$this->touch_segments_cache();
	}

	/**
	 * Write-stall recovery ([159]): a short write must never silently lose the
	 * batch OR leave a torn record desyncing every reader after it. Truncate
	 * the partial record off the segment, then quarantine every message that
	 * didn't land in full. Returns the count of durable leading messages.
	 *
	 * @param resource                                                  $fh           Segment handle.
	 * @param int                                                       $start_offset Segment size before this batch.
	 * @param array<int, array{message: array<int, mixed>, size: int}>  $batch_args   Batched messages, in write order.
	 * @param int                                                       $wrote        Bytes write_all() landed.
	 * @return int Leading messages fully on disk.
	 */
	protected function recover_write_stall( $fh, int $start_offset, array $batch_args, int $wrote ): int {
		$kept       = 0;
		$kept_bytes = 0;
		foreach ( $batch_args as $item ) {
			if ( $kept_bytes + $item['size'] > $wrote ) {
				break;
			}
			$kept_bytes += $item['size'];
			++$kept;
		}
		if ( $kept_bytes < $wrote ) {
			// phpcs:ignore WordPress.WP.AlternativeFunctions.file_system_operations_ftruncate, WordPressVIPMinimum.Functions.RestrictedFunctions.file_ops_ftruncate -- substrate-owned segment file under base_dir, not WP-managed.
			@\ftruncate( $fh, \max( 0, $start_offset + $kept_bytes ) );
			@\fseek( $fh, 0, \SEEK_END );
		}
		$this->current_size = $start_offset + $kept_bytes;
		$this->quarantine_unwritten( $batch_args, $kept, 'write stalled' );
		return $kept;
	}

	/**
	 * Route messages [$from..] through the DLQ ([159]) — loud + replayable via
	 * `wp nodes ingest`; with no quarantine dir the trait logs-and-drops loudly.
	 *
	 * @param array<int, array{message: array<int, mixed>, size: int}> $batch_args Batched messages.
	 * @param int                                                      $from       First unwritten index.
	 */
	protected function quarantine_unwritten( array $batch_args, int $from, string $reason ): void {
		$this->ensure_deadletter();
		foreach ( \array_slice( $batch_args, $from ) as $item ) {
			$this->dead_letter( $item['message'], $reason );
		}
	}

	/**
	 * Rotate to a new segment, multi-writer-safe via an mkdir lock.
	 *
	 * Single-writer mode (allow_large_writes) skips the lock — the per-write Lock serializes.
	 */
	protected function rotate_segment(): void {
		$this->close_handle();

		if ( $this->allow_large_writes ) {
			$this->do_rotate();
			return;
		}

		$lock_dir = $this->rotate_lock_path();
		$dir      = $this->segment_dir();

		if ( ! \is_dir( $dir ) ) {
			// phpcs:ignore WordPressVIPMinimum.Functions.RestrictedFunctions.directory_mkdir
			@\mkdir( $dir, 0755, true );
		}

		// Atomic acquire via mkdir.
		// phpcs:ignore WordPressVIPMinimum.Functions.RestrictedFunctions.directory_mkdir
		if ( ! @\mkdir( $lock_dir, 0755 ) ) {
			\clearstatcache( true, $lock_dir );
			$mtime = @\filemtime( $lock_dir );
			if ( false === $mtime ) {
				// Disappeared mid-check; back off and re-init from disk.
				\usleep( 50000 );
				$this->init_current_segment();
				return;
			}
			$age = \time() - $mtime;
			if ( $age < self::ROTATE_LOCK_TTL_SECONDS ) {
				// Peer is rotating; wait briefly and re-init from disk.
				\usleep( 50000 );
				$this->init_current_segment();
				return;
			}
			// Stale lock: force-clear and retry.
			// phpcs:ignore WordPressVIPMinimum.Functions.RestrictedFunctions.directory_rmdir
			@\rmdir( $lock_dir );
			// phpcs:ignore WordPressVIPMinimum.Functions.RestrictedFunctions.directory_mkdir
			if ( ! @\mkdir( $lock_dir, 0755 ) ) {
				$this->init_current_segment();
				return;
			}
		}

		try {
			$this->do_rotate();
		} finally {
			// phpcs:ignore WordPressVIPMinimum.Functions.RestrictedFunctions.directory_rmdir
			@\rmdir( $lock_dir );
		}
	}

	/**
	 * Perform the actual rotation, with or without the rotation lock held.
	 *
	 * Detects "a peer already advanced": adopt the newest segment if it still has room.
	 */
	protected function do_rotate(): void {
		// Multi-writer rescans for peer rotations; single-writer stays warm.
		$segments = $this->get_segments( ! $this->allow_large_writes );

		if ( ! empty( $segments ) ) {
			$newest = \end( $segments );
			if ( $newest['size'] < $this->segment_size ) {
				$this->current_segment_id = $newest['id'];
				$this->current_size       = $newest['size'];
				$this->current_log_path   = $this->get_segment_path( $this->current_segment_id );
				$this->current_idx_path   = $this->get_index_path( $this->current_segment_id );
				// Cache already holds the adopted newest; keep it warm.
				return;
			}
		}

		$next_id = empty( $segments ) ? 0 : ( \end( $segments )['id'] + 1 );

		$this->current_segment_id = $next_id;
		$this->current_size       = 0;
		$this->current_log_path   = $this->get_segment_path( $next_id );
		$this->current_idx_path   = $this->get_index_path( $next_id );

		// Touch the empty file so get_handle()'s guard won't reset to seg 0.
		if ( ! \is_dir( $this->segment_dir() ) ) {
			// phpcs:ignore WordPressVIPMinimum.Functions.RestrictedFunctions.directory_mkdir
			@\mkdir( $this->segment_dir(), 0755, true );
		}
		// phpcs:ignore WordPress.WP.AlternativeFunctions.file_system_operations_touch, WordPressVIPMinimum.Functions.RestrictedFunctions.file_ops_touch
		if ( ! @\touch( $this->current_log_path ) ) {
			$this->print_less_often( 'WARNING: touch() failed for ', $this->current_log_path );
		}

		// Keep cache warm: scan + new empty segment; cleanup prunes in place.
		$this->segments_cache[]    = [ 'id' => $next_id, 'size' => 0 ];
		$this->segments_cache_time = Core::$now ?: Core::right_now();

		$this->cleanup_segments();

		$this->set_state( 'SEGMENT', (string) $this->current_segment_id );
	}

	/**
	 * Three-rule retention, oldest-first, above a hard floor of 2 segments. Prune
	 * the oldest segment when ANY rule fires:
	 *   - age rule: older than lifetime (0 = off), keeping at least min_segments;
	 *   - count rule: more than num_segments, keeping anything younger than min_lifetime;
	 *   - hard cap: more than max_segments — UNCONDITIONAL (min_lifetime does not
	 *     protect; only the floor of 2 does), so a hot partition full of young
	 *     segments can't grow past max_segments.
	 * So the age rule can prune below num_segments, and the count rule below
	 * lifetime — each bounded by the other axis's floor; the hard cap is the ceiling.
	 */
	public function cleanup_segments(): void {
		// Use the warm cache; standalone callers (cold cache) force-scan.
		$segments       = null === $this->segments_cache ? $this->get_segments( true ) : $this->segments_cache;
		$count          = \count( $segments );
		$initial_count  = $count;
		$now            = \time();

		while ( $count > 2 ) {
			$oldest = $segments[0];
			$path   = $this->get_segment_path( $oldest['id'] );
			// The hard cap needs no age: it must fire even on unreadable mtime.
			if ( $count <= $this->max_segments ) {
				$mtime = @\filemtime( $path );
				if ( false === $mtime ) {
					break; // can't determine age → keep it (and stop, oldest-first).
				}
				$age         = $now - $mtime;
				$age_prune   = $this->lifetime > 0 && $age > $this->lifetime && $count > $this->min_segments;
				$count_prune = $count > $this->num_segments && $age >= $this->min_lifetime;
				if ( ! $age_prune && ! $count_prune ) {
					break;
				}
			}
			// Partition's segment dir is base_dir-relative — not WP-managed.
			// phpcs:disable WordPressVIPMinimum.Functions.RestrictedFunctions.file_ops_unlink
			@\unlink( $path );
			@\unlink( $this->get_index_path( $oldest['id'] ) );
			// phpcs:enable
			\array_shift( $segments );
			--$count;
		}
		// Keep the pruned list as the warm cache instead of discarding it.
		$this->segments_cache      = \array_values( $segments );
		$this->segments_cache_time = Core::$now ?: Core::right_now();

		$deleted = $initial_count - $count;
		if ( $deleted > 0 ) {
			$this->set_state( 'CLEANUP', \implode( ' ', [ 'DELETED', $deleted, 'ALIVE', $count ] ) );
		}
	}

	/** Seam (Log overrides): mkdir-lock dir serializing multi-writer rotation. */
	protected function rotate_lock_path(): string {
		return "{$this->segment_dir()}/.rotate.lock.d";
	}

	/**
	 * Lazily open and cache the .log + .idx handles for the current segment.
	 *
	 * @return resource|null Log handle, or null on open failure.
	 */
	protected function get_handle() {
		if ( ! \is_dir( $this->segment_dir() ) ) {
			// phpcs:ignore WordPressVIPMinimum.Functions.RestrictedFunctions.directory_mkdir
			@\mkdir( $this->segment_dir(), 0755, true );
			// Whole tree got wiped; reset from disk (lands at segment 0).
			$this->init_current_segment();
		} elseif ( null === $this->current_log_path || ! \file_exists( $this->current_log_path ) ) {
			// No active segment, or log file vanished — (re-)init from disk.
			$this->init_current_segment();
		}

		// init_current_segment() sets these together; bail if somehow unset.
		$log_path   = $this->current_log_path;
		$idx_path   = $this->current_idx_path;
		$segment = $this->current_segment_id;
		if ( null === $log_path || null === $idx_path || null === $segment ) {
			return null;
		}

		if ( null === $this->fh || $this->fh_segment_id !== $segment ) {
			$this->close_handle();
			// umask 022 would leave these world-readable.
			$prev_umask = \umask( 0077 );
			try {
				// phpcs:ignore WordPress.WP.AlternativeFunctions.file_system_operations_fopen, WordPressVIPMinimum.Functions.RestrictedFunctions.file_ops_fopen
				$fh = @\fopen( $log_path, 'a' );
			} finally {
				\umask( $prev_umask );
			}
			if ( false === $fh ) {
				return null;
			}
			$this->fh            = $fh;
			$this->fh_segment_id = $segment;

			// Single-writer: disable PHP's 8KB buffer so readers see writes.
			if ( $this->allow_large_writes ) {
				\stream_set_write_buffer( $this->fh, 0 );
			}

			// Open .idx only when a with_index() formatter is set; else none.
			if ( null !== $this->index_callback ) {
				$prev_umask = \umask( 0077 );
				try {
					// phpcs:ignore WordPress.WP.AlternativeFunctions.file_system_operations_fopen, WordPressVIPMinimum.Functions.RestrictedFunctions.file_ops_fopen
					$idx_fh = @\fopen( $idx_path, 'a' );
				} finally {
					\umask( $prev_umask );
				}
				$this->idx_fh = ( false === $idx_fh ) ? null : $idx_fh;
			}
		}
		return $this->fh;
	}

	/**
	 * Initialize current segment state from existing segments on disk.
	 *
	 * Does NOT create files — segment files materialize on first write via fopen('a').
	 */
	protected function init_current_segment(): void {
		$this->close_handle();
		$segments = $this->get_segments( true );
		if ( empty( $segments ) ) {
			$this->current_segment_id = 0;
			$this->current_size       = 0;
			$this->current_log_path   = $this->get_segment_path( 0 );
			$this->current_idx_path   = $this->get_index_path( 0 );
			return;
		}
		$newest                   = \end( $segments );
		$this->current_segment_id = $newest['id'];
		$this->current_size       = $newest['size'];
		$this->current_log_path   = $this->get_segment_path( $this->current_segment_id );
		$this->current_idx_path   = $this->get_index_path( $this->current_segment_id );
	}

	/**
	 * Write one companion-index entry for the message at $offset. Caller guards on $index_callback.
	 *
	 * @param array<int, mixed> $message The unpacked message array handed to the index callback.
	 */
	private function write_index_entry( array $message, int $offset, int $length ): void {
		$callback   = $this->index_callback;
		$segment = $this->current_segment_id;
		if ( null === $callback || null === $segment ) {
			return;
		}
		$position = [
			'segment' => $segment,
			'offset'     => $offset,
			'length'     => $length,
		];
		try {
			$entry = $callback( $message, $position );
			if ( null !== $entry && '' !== $entry && \is_resource( $this->idx_fh ) ) {
				$this->write_all( $this->idx_fh, $entry . "\n", $this->current_idx_path );
			}
		} catch ( \Throwable $e ) {
			$this->print_less_often( 'WARNING: index callback threw: ', $e->getMessage() );
		}
	}

	/**
	 * Mirror current_size into segments_cache so a stale hit doesn't misreport the active segment.
	 */
	protected function touch_segments_cache(): void {
		if ( null === $this->segments_cache || null === $this->current_segment_id ) {
			return;
		}
		$found = false;
		foreach ( $this->segments_cache as $i => $s ) {
			if ( $s['id'] === $this->current_segment_id ) {
				$this->segments_cache[ $i ]['size'] = $this->current_size;
				$found                              = true;
				break;
			}
		}
		if ( ! $found ) {
			$this->segments_cache[] = [ 'id' => $this->current_segment_id, 'size' => $this->current_size ];
		}
	}

	protected function close_handle(): void {
		if ( \is_resource( $this->fh ) ) {
			@\fclose( $this->fh );
			$this->fh = null;
			$this->fh_segment_id = -1;
		}
		if ( \is_resource( $this->idx_fh ) ) {
			@\fclose( $this->idx_fh );
			$this->idx_fh = null;
		}
	}

	/** Seam (Log overrides): per-writer exclusivity lock dir for allow_large_writes(). */
	protected function write_lock_path(): string {
		return "{$this->segment_dir()}/write.lock.d";
	}

	/**
	 * Decoded random-access read: the record at {seg,off,len} unpacked to a Message.
	 * The single canonical "read a record as a message" — callers use this instead of
	 * read_at + a hand-rolled json_decode. Returns null on a torn/short record (the
	 * bytes don't unpack to a 7-field envelope) rather than throwing.
	 *
	 * @api Cross-plugin entrypoint — Performance_CI (event-logger-nodes) reads via this.
	 * @return array<int, mixed>|null
	 */
	public function read_message_at( int $segment, int $offset, int $length ): ?array {
		$bytes = $this->read_at( $segment, $offset, $length );
		if ( '' === $bytes ) {
			return null;
		}
		try {
			return Message::unpacked( $bytes );
		} catch ( \InvalidArgumentException $e ) {
			return null;
		}
	}

	/**
	 * Read bytes from a segment at a given offset (bounds-checked).
	 *
	 * @param int $segment Segment to read from.
	 * @param int $offset     Byte offset within segment.
	 * @param int $length     Number of bytes to read.
	 * @return string Bytes read; empty string on bounds violation, missing file, or read failure.
	 */
	public function read_at( int $segment, int $offset, int $length ): string {
		if ( $segment < 0 || $offset < 0 || $length < 0 ) {
			return '';
		}
		if ( 0 === $length ) {
			return '';  // fread() throws on $length === 0 in PHP 8.1+.
		}
		$path = $this->get_segment_path( $segment );
		if ( ! \file_exists( $path ) ) {
			return '';
		}
		// phpcs:ignore WordPress.WP.AlternativeFunctions.file_system_operations_fopen, WordPressVIPMinimum.Functions.RestrictedFunctions.file_ops_fopen
		$fh = @\fopen( $path, 'r' );
		if ( false === $fh ) {
			return '';
		}
		@\fseek( $fh, $offset );
		// phpcs:ignore WordPress.WP.AlternativeFunctions.file_system_operations_fread
		$bytes = @\fread( $fh, $length );
		// phpcs:ignore WordPress.WP.AlternativeFunctions.file_system_operations_fclose
		@\fclose( $fh );
		if ( false !== $bytes ) {
			$this->bytes_read += \strlen( $bytes );
			return $bytes;
		}
		return '';
	}

	/** Seam (Log overrides): data-file path for a segment. Partition = {dir}/{seg}.log. */
	public function get_segment_path( int $segment ): string {
		if ( $segment < 0 ) {
			throw new \InvalidArgumentException( 'Segment ID must be non-negative' );
		}
		return "{$this->segment_dir()}/{$segment}.log";
	}

	/**
	 * Walk every JSONL .idx entry across all segments and invoke the callback per entry.
	 *
	 * Only meaningful when a with_index() formatter is installed — without it no
	 * .idx is written, so this early-returns. Callback signature: fn(string $line,
	 * int $segment). Return false from the callback to terminate the scan early.
	 *
	 * @api
	 * @param callable $cb           Per-entry callback.
	 * @param bool     $newest_first Iterate newest segment first when true.
	 */
	public function scan_index( callable $cb, bool $newest_first = false ): void {
		if ( null === $this->index_callback ) {
			return;
		}

		$segments = $this->get_segments();
		if ( $newest_first ) {
			$segments = \array_reverse( $segments );
		}

		foreach ( $segments as $s ) {
			$idx_path = $this->get_index_path( $s['id'] );
			if ( ! \file_exists( $idx_path ) ) {
				continue;
			}

			// phpcs:ignore WordPressVIPMinimum.Performance.FetchingRemoteData.FileGetContentsUnknown
			$idx = @\file_get_contents( $idx_path );
			if ( false === $idx ) {
				continue;
			}

			$lines = \explode( "\n", \rtrim( $idx, "\n" ) );
			if ( $newest_first ) {
				$lines = \array_reverse( $lines );
			}
			foreach ( $lines as $line ) {
				if ( '' === $line ) {
					continue;
				}
				$result = $cb( $line, $s['id'] );
				if ( false === $result ) {
					return;
				}
			}
		}
	}

	/**
	 * List segments on disk sorted by id, cached for SEGMENT_CACHE_TTL.
	 *
	 * An allow_large_writes (single-writer) log skips the TTL: with no peer able to
	 * change the dir behind it, its cache never goes stale, so it serves warm.
	 *
	 * @param bool       $force_refresh Skip the cache and rescan.
	 * @param float|null $now           Clock to age the cache against; null resolves it (fill threads its one read).
	 * @return array<int,array{id:int,size:int}>
	 */
	public function get_segments( bool $force_refresh = false, ?float $now = null ): array {
		// fill() threads its read; else cached clock (no clobber) or warm.
		$now = $now ?? ( Core::$now ?: Core::right_now() );
		$cache_fresh = $this->allow_large_writes || ( $now - $this->segments_cache_time ) < self::SEGMENT_CACHE_TTL;
		if ( ! $force_refresh && null !== $this->segments_cache && $cache_fresh ) {
			return $this->segments_cache;
		}
		$segments = [];
		$dir      = $this->segment_dir();
		if ( ! \is_dir( $dir ) ) {
			$this->segments_cache      = [];
			$this->segments_cache_time = $now;
			return [];
		}
		// phpcs:ignore WordPress.WP.AlternativeFunctions.file_system_operations_scandir
		$scan  = self::$scandir ?? static fn ( string $d ) => @\scandir( $d );
		$files = $scan( $dir );
		if ( ! $files ) {
			$this->segments_cache      = [];
			$this->segments_cache_time = $now;
			return [];
		}
		$pattern = $this->segment_pattern();
		foreach ( $files as $f ) {
			if ( \preg_match( $pattern, $f, $m ) ) {
				$segments[] = [ 'id' => (int) $m[1], 'size' => @\filesize( "{$dir}/{$f}" ) ?: 0 ];
			}
		}
		\usort( $segments, fn ( $a, $b ) => $a['id'] <=> $b['id'] );
		$this->segments_cache      = $segments;
		$this->segments_cache_time = $now;
		return $segments;
	}

	/** Seam (Log overrides): regex matching a data filename in segment_dir(); group 1 = id. */
	protected function segment_pattern(): string {
		return self::SEGMENT_PATTERN;
	}

	/** Seam (Log overrides): companion-index path for a segment. Partition = {dir}/{seg}.idx. */
	protected function get_index_path( int $segment ): string {
		return "{$this->segment_dir()}/{$segment}.idx";
	}

	/** Seam (Log overrides): the directory segments live in. Partition = the resolved dir. */
	protected function segment_dir(): string {
		return $this->partition_dir;
	}

	/**
	 * Glob a family of snapshot-offsetlog dirs and flatten their latest cached item lists.
	 *
	 * For every dir matching `$offsets_dir/$glob`, read the newest committed record's VALUE
	 * (via read_latest_value_at), descend `VALUE[$cache_key][$node][$items_key]`, and concatenate the
	 * array-shaped items into one list. The per-dir read is fault-tolerant: a missing cache,
	 * a non-array items list, or a non-array item is silently skipped. Callers memoize per
	 * request — this re-globs and re-reads every call.
	 *
	 * @api Public substrate primitive: a Service_CI that fans a digest snapshot across
	 *      partitions (e.g. the example AI-newsletter insights demo) reads its accumulated
	 *      items through this instead of re-implementing the glob + cache descent.
	 *
	 * @param string $offsets_dir Absolute path to the offsets base dir holding the snapshot dirs.
	 * @param string $glob        A glob (relative to $offsets_dir) selecting the snapshot dirs, e.g. `scored.p*`.
	 * @param string $node        Snapshot-node name keying this state in the frame's cache map.
	 * @param string $cache_key   VALUE key holding the cache object. Default `cache`.
	 * @param string $items_key   Cache key holding the items list. Default `items`.
	 * @return array<int,array<array-key,mixed>> The flattened, array-shaped items across all matched dirs.
	 */
	public static function read_latest_snapshot_cache(
		string $offsets_dir,
		string $glob,
		string $node,
		string $cache_key = 'cache',
		string $items_key = 'items'
	): array {
		$dirs = \glob( \rtrim( $offsets_dir, '/' ) . '/' . $glob, \GLOB_ONLYDIR );
		if ( false === $dirs || [] === $dirs ) {
			return [];
		}
		$items = [];
		foreach ( $dirs as $dir ) {
			$value = self::read_latest_value_at( $dir );
			$cache = \is_array( $value ) && \is_array( $value[ $cache_key ] ?? null ) ? $value[ $cache_key ] : [];
			$state = \is_array( $cache[ $node ] ?? null ) ? $cache[ $node ] : [];
			$list  = $state[ $items_key ] ?? null;
			if ( ! \is_array( $list ) ) {
				continue;
			}
			foreach ( $list as $item ) {
				if ( \is_array( $item ) ) {
					$items[] = $item;
				}
			}
		}
		return $items;
	}

	/**
	 * Read the latest committed record's VALUE from an offsetlog directory.
	 *
	 * The offsetlog is a flat segmented-log dir; this opens it at $offsetlog_dir,
	 * reads the last non-empty line of the newest segment, unpacks the packed Message,
	 * and returns its VALUE (a decoded JSON object), or null if empty/unreadable.
	 *
	 * @api Public substrate primitive for dashboard/external consumers that read an
	 *      offsetlog snapshot (e.g. a Service_CI serving dashboard state). No
	 *      in-substrate caller, so this is marked API to keep the deadcode gate honest.
	 *
	 * @param string $offsetlog_dir Absolute path to the offset dir (e.g. {base}/offsets/firehose.p0).
	 * @return array<string,mixed>|null The newest record's VALUE, or null.
	 */
	public static function read_latest_value_at( string $offsetlog_dir ): ?array {
		try {
			$offsetlog = new self();
			$offsetlog->arguments( [ $offsetlog_dir ] );
			$segments = $offsetlog->get_segments( true );
			if ( empty( $segments ) ) {
				return null;
			}
			$newest = \end( $segments );
			$bytes  = $offsetlog->read_at( $newest['id'], 0, $newest['size'] );
			if ( '' === $bytes ) {
				return null;
			}
			$lines = \array_filter( \explode( "\n", $bytes ), static fn ( $l ) => '' !== $l );
			if ( empty( $lines ) ) {
				return null;
			}
			$value = Message::unpacked( \end( $lines ) )[ Message::VALUE ] ?? null;
			if ( ! \is_array( $value ) ) {
				return null;
			}
			/** @var array<string,mixed> $value The offsetlog VALUE is a decoded JSON object (string keys). */
			return $value;
		} catch ( \Throwable $e ) {
			return null;
		}
	}

	/**
	 * Set the companion-index formatter BY NAME — the round-trippable form, and
	 * the one a Topic propagates to each partition it materializes.
	 *
	 * @param string $formatter_name Registered formatter name.
	 * @return bool False when no such formatter is registered.
	 */
	public function with_index_named( string $formatter_name ): bool {
		$callable = Formatters::resolve( $formatter_name );
		if ( null === $callable ) {
			return false;
		}
		$this->with_index( $callable );
		$this->index_formatter_name = $formatter_name;
		return true;
	}

	/**
	 * Enable companion index files via a custom formatter callback.
	 *
	 * The formatter receives the unpacked message array (the 7-field positional
	 * Message) plus the on-disk position — never the serialized JSONL line — so
	 * it reads `$message[ Message::VALUE ]` directly instead of json_decode-ing.
	 *
	 * @param callable(array<int, mixed>, array<string, int>): (string|null) $callback fn(array $message, array $position) => string|null. Return null/'' to skip.
	 * @return self
	 */
	public function with_index( callable $callback ): self {
		$this->index_callback = $callback;
		return $this;
	}

	/**
	 * Wake every on-demand worker tailing a partition written since the last
	 * flush. Fire-and-forget; `Bootstrap::on_demand_wake_map()` caches the
	 * lookup and `Spawn_Coordinator` throttles the spawn, so a partition nothing
	 * on-demand tails costs one cached array read.
	 *
	 * @api Registered as a shutdown function; also called from the router tick.
	 */
	public static function flush_pending_wakes(): void {
		if ( [] === self::$pending_wakes ) {
			return;
		}
		$pending             = self::$pending_wakes;
		self::$pending_wakes = [];
		try {
			$coordinator = Bootstrap::spawn_coordinator();
			$now         = Core::right_now();
			foreach ( $pending as $dir ) {
				$coordinator->wake_on_demand( $dir, $now );
			}
		} catch ( \Throwable $e ) {
			// Shutdown path: a failed wake must not eat the request.
			Core::print_less_often( 'pending wake failed: ', $e->getMessage() );
		}
	}

	/** Drop pending wakes without posting them. Tests only. */
	public static function forget_pending_wakes(): void {
		self::$pending_wakes = [];
	}

	/** Sidecars (offsetlogs, quarantines) never quarantine their own writes — that recurses. */
	public function without_write_deadletter(): void {
		$this->deadletter_dir = '';
	}

	/**
	 * The write-quarantine is shared by every writer of this partition dir; it
	 * is sole-writer only when the SOURCE is single-writer ([159] audit) — a
	 * lockless (void_warranty) quarantine under multi-writer stalls would race
	 * rotation exactly when every writer stalls at once (disk full).
	 */
	protected function deadletter_sole_writer(): bool {
		return $this->allow_large_writes;
	}

	public static function hash_to_partition( string $key, int $num_partitions ): int {
		[ $stripped ] = \explode( '?', $key, 2 );
		return ( \crc32( $stripped ) & 0x7FFFFFFF ) % $num_partitions;
	}

	/**
	 * Lift the PIPE_BUF cap WITHOUT acquiring the per-partition exclusivity lock —
	 * the no-lock sibling of allow_large_writes(). The caller ASSERTS it is this
	 * partition's sole writer (e.g. a worker that already holds its topology lock,
	 * so the offset/snapshot offsetlog it owns has no other writer). Permits
	 * > PIPE_BUF writes and skips the rotate-lock, exactly like allow_large_writes(),
	 * but trusts the caller instead of enforcing exclusivity with a held lock.
	 *
	 * WARRANTY VOID: two concurrent writers + this = silent torn-write corruption,
	 * with no lock to stop the second writer. If you can't guarantee single-writer,
	 * use allow_large_writes() — it ENFORCES it (and throws on a second writer).
	 */
	public function void_warranty(): self {
		$this->allow_large_writes = true;
		$this->warranty_voided    = true;
		return $this;
	}

	/**
	 * Emit the base config plus this Partition's verb-config, from STATE — the
	 * `allow_large_writes` flag and the `with_index` formatter name. (The index
	 * callback itself can't be dumped; the formatter name is its round-trip form.)
	 */
	public function dump_config(): string {
		$out = parent::dump_config();
		if ( $this->allow_large_writes ) {
			if ( $this->warranty_voided ) {
				$verb = 'void_warranty';
			} elseif ( $this->debounce_lock_ms > 0 ) {
				$verb = "allow_large_writes {$this->debounce_lock_ms}";
			} else {
				$verb = 'allow_large_writes';
			}
			$out .= "command_node {$this->name}:config {$verb}\n";
		}
		if ( null !== $this->index_formatter_name ) {
			$out .= "command_node {$this->name}:config with_index {$this->index_formatter_name}\n";
		}
		return $out;
	}

	/**
	 * Index the newest segment's TAIL by a VALUE field, latest-record-wins.
	 *
	 * Reads at most `$max_bytes` from the END of the NEWEST segment and returns
	 * `key => VALUE` for the LAST record carrying each distinct `$key_field`.
	 * Records append chronologically, so the tail holds the most recent ones; a
	 * producer that writes every key on a short interval (Topic_Probe: every 15s)
	 * keeps every active key present. A bounded tail read is cheaper than the
	 * whole segment. A leading partial line (the tail may start mid-record) is
	 * dropped; records whose key is missing/empty/non-string are skipped.
	 *
	 * Scope caveat: only the newest segment is read, so a key whose latest record
	 * predates the last rotation — a producer silent for longer than the newest
	 * segment currently spans, or, transiently, every key for the seconds right
	 * after a rotation until the next sweep repopulates the fresh segment — is
	 * absent. Intended for "currently-active" state, not a full historical sweep.
	 *
	 * @param string     $dir       The partition dir.
	 * @param int|string $key_field VALUE field to index by (an int for a positional record).
	 * @param int        $max_bytes Max tail bytes to scan (default 128 KiB).
	 * @return array<string,array<mixed>> key → the latest record's VALUE.
	 */
	public static function read_tail_index_by( string $dir, int|string $key_field, int $max_bytes = 131072 ): array {
		$index = [];
		try {
			$log = new self();
			$log->arguments( [ $dir ] );
			$segments = $log->get_segments( true );
			if ( empty( $segments ) ) {
				return [];
			}
			$newest = \end( $segments );
			$size   = $newest['size'];
			$offset = $size > $max_bytes ? $size - $max_bytes : 0;
			$bytes  = $log->read_at( $newest['id'], $offset, $size - $offset );
			if ( '' === $bytes ) {
				return [];
			}
			// A non-zero start may land mid-record; drop the partial line.
			if ( $offset > 0 ) {
				$nl    = \strpos( $bytes, "\n" );
				$bytes = false === $nl ? '' : \substr( $bytes, $nl + 1 );
			}
			foreach ( \explode( "\n", $bytes ) as $line ) {
				if ( '' === $line ) {
					continue;
				}
				$value = Message::unpacked( $line )[ Message::VALUE ] ?? null;
				if ( ! \is_array( $value ) ) {
					continue;
				}
				$key = $value[ $key_field ] ?? '';
				if ( \is_string( $key ) && '' !== $key ) {
					$index[ $key ] = $value; // chronological → last wins
				}
			}
			return $index;
		} catch ( \Throwable $e ) {
			return [];
		}
	}
	/**
	 * `allow_large_writes` verb handler — lift the 4KB cap on the patron + acquire its write
	 * lock. An optional debounce_ms arg switches to debounced mode (lock per write burst,
	 * released after that many ms of idle) instead of acquire-and-hold ([65]).
	 *
	 * @param Command_Interpreter_Node $interpreter Verb argument.
	 * @param array<array-key, mixed>  $args        Optional debounce_ms (default 0 = hold mode).
	 *
	 * @return string
	 */
	public static function cmd_allow_large_writes( Command_Interpreter_Node $interpreter, array $args ): string {
		/** @var self $patron */
		$patron   = $interpreter->patron();
		$debounce = \max( 0, Core::as_int( $args[0] ?? '' ) );
		$patron->allow_large_writes( self::DEFAULT_LOCK_WAIT_MS, $debounce );
		return "ok\n";
	}

	/**
	 * `void_warranty` verb handler — lift the 4KB cap with NO lock (caller asserts single-writer).
	 *
	 * @param Command_Interpreter_Node $interpreter Verb argument.
	 *
	 * @return string
	 */
	public static function cmd_void_warranty( Command_Interpreter_Node $interpreter ): string {
		/** @var self $patron */
		$patron = $interpreter->patron();
		$patron->void_warranty();
		return "ok\n";
	}

	/**
	 * `with_index` verb handler — set the patron's companion-index line-formatter by name.
	 *
	 * @param Command_Interpreter_Node $interpreter Verb argument.
	 * @param array<array-key, mixed>  $args        Verb argument.
	 *
	 * @return string
	 */
	public static function cmd_with_index( Command_Interpreter_Node $interpreter, array $args ): string {
		$args = Core::as_string( $args[0] ?? '' );
		if ( '' === $args ) {
			throw new \RuntimeException( 'usage: with_index <formatter_name>' );
		}
		$callable = Formatters::resolve( $args );
		if ( null === $callable ) {
			throw new \RuntimeException( \esc_html( "unknown formatter: $args" ) );
		}
		/** @var self $patron */
		$patron = $interpreter->patron();
		$patron->with_index_named( $args );
		return "ok\n";
	}

	public function sink( ?Node $node = null ): ?Node {
		$result = \func_num_args() > 0 ? parent::sink( $node ) : parent::sink();
		if ( \func_num_args() > 0 ) {
			$this->set_state( 'READY', $this->name );
		}
		return $result;
	}

	/** Topology console manifest: palette entry + ctor form + verb forms. */
	public static function node_schema(): array {
		return \array_merge( parent::node_schema(), [
			'category'      => 'I/O',
			'description'   => 'Append-only segmented log; data file + offset index per partition.',
			'arguments'     => [
				[ 'name' => 'partition_dir', 'type' => 'string', 'required' => true, 'description' => 'On-disk directory holding this partition\'s numbered {seg}.log segment files and .idx indexes.' ],
				[ 'name' => 'segment_size',  'type' => 'int',    'default'  => '<config:segment_size>', 'description' => 'Segment rotation threshold in bytes; a new segment starts once a write would exceed it (default 64 MiB).' ],
				[ 'name' => 'min_segments',  'type' => 'int',    'default'  => '<config:min_segments>', 'description' => 'Floor for the age rule: keep at least this many segments even when pruning by lifetime (clamped to a hard minimum of 2).' ],
				[ 'name' => 'num_segments',  'type' => 'int',    'default'  => '<config:num_segments>', 'description' => 'Count-rule target: prune the oldest back to this many segments, but only ones older than min_lifetime.' ],
				[ 'name' => 'max_segments',  'type' => 'int',    'default'  => '<config:max_segments>', 'description' => 'True hard cap: prune the oldest UNCONDITIONALLY above this many segments (min_lifetime does not protect them; only the floor of 2 does). 0 = derive as 2 × num_segments.' ],
				[ 'name' => 'min_lifetime',  'type' => 'int',    'default'  => '<config:min_lifetime>', 'description' => 'Floor for the count rule: keep segments younger than this many seconds even when over num_segments; 0 keeps nothing extra.' ],
				[ 'name' => 'lifetime',      'type' => 'int',    'default'  => '<config:lifetime>', 'description' => 'Age rule: prune segments older than this many seconds down to min_segments; 0 disables age-based pruning.' ],
			],
			'commands'    => [
				[
					'name'        => 'allow_large_writes',
					'description' => 'Lift the 4KB PIPE_BUF cap; acquire the per-partition write lock. Optional debounce_ms > 0 switches to debounced mode: lock per write burst, release after that idle window.',
					'args'        => [
						[ 'name' => 'debounce_ms', 'type' => 'int', 'required' => false ],
					],
					'handler'     => static fn ( Command_Interpreter_Node $interpreter, array $args ): string => self::cmd_allow_large_writes( $interpreter, $args ),
				],
				[
					'name'        => 'void_warranty',
					'description' => 'Lift the 4KB PIPE_BUF cap with NO write lock — caller asserts single-writer (corrupts under concurrent writers; use allow_large_writes otherwise).',
					'args'        => [],
					'handler'     => static fn ( Command_Interpreter_Node $interpreter, array $args ): string => self::cmd_void_warranty( $interpreter ),
				],
				[
					'name'        => 'with_index',
					'description' => 'Use a named line-formatter for the companion index file.',
					'args'        => [
						[ 'name' => 'formatter', 'type' => 'formatter_name', 'required' => true ],
					],
					'handler'     => static fn ( Command_Interpreter_Node $interpreter, array $args ): string => self::cmd_with_index( $interpreter, $args ),
				],
			],
			'registrations' => [ 'READY' ],
			'has_target'    => false,
		] );
	}
}
