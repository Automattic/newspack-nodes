<?php
/**
 * Partition
 *
 * File-segmented append-only log.
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes;

if ( ! \defined( 'ABSPATH' ) ) {
	exit;
}

class Partition extends Timer {
	public const DEFAULT_SEGMENT_SIZE = 67108864;
	public const DEFAULT_NUM_SEGMENTS = 4;
	public const DEFAULT_MAX_LIFESPAN = 86400;
	public const MAX_LINE_SIZE        = 4096;
	public const MAX_LARGE_LINE_SIZE  = 10485760;
	public const MAX_READ_SIZE        = 10485760; // 10MB cap on read_at + scan_index per-file size.
	public const SEGMENT_CACHE_TTL    = 0.25;
	public const SEGMENT_PATTERN      = '/^(\d+)\.log$/';

	/** Inter-process rotation lock TTL: anything older counts as stale. */
	public const ROTATE_LOCK_TTL_SECONDS = 5;

	/** Max in-loop fwrite attempts before giving up on a partial write. */
	public const MAX_PARTIAL_WRITE_ATTEMPTS = 5;

	/** Minimum interval between drift-detection rescans inside do_write(). */
	public const DRIFT_RESCAN_INTERVAL_SECONDS = 1.0;

	protected string $base_dir;
	protected int $partition;
	protected int $segment_size;
	protected int $num_segments;
	protected int $max_lifespan;

	protected string $partition_dir;

	protected ?int $current_segment_id = null;
	protected int $current_size = 0;
	protected ?string $current_log_path = null;
	protected ?string $current_idx_path = null;

	/** @var resource|null */
	protected $fh = null;
	protected int $fh_segment_id = -1;
	/** @var resource|null */
	protected $idx_fh = null;

	protected ?array $segments_cache = null;
	protected float $segments_cache_time = 0.0;

	protected bool $allow_large_writes = false;
	protected ?Lock $write_lock = null;
	protected ?Timer $heartbeat_timer = null;
	/** stale_timeout (s) cached at acquire so fill() can compute the heartbeat cadence in no-event-loop mode. */
	protected int $lock_stale_timeout = 0;
	/** Last manually-driven heartbeat timestamp (no-event-loop mode only). */
	protected float $last_lock_heartbeat = 0.0;

	/** Last drift-rescan timestamp; throttles do_write rescans to once per second. */
	protected float $last_segment_check = 0.0;

	/** @var callable|null fn(string $line, array $position, ?array &$data) => string|null */
	protected $index_callback = null;

	/**
	 * In-memory batch of packed messages awaiting a single PIPE_BUF-atomic
	 * syswrite. Mirrors Tachikoma `Partition.pm:206`'s `push @{$self->{batch}}`
	 * + `fire()` flush pattern, with the legacy newspack-performance-logger
	 * LogManager rule applied: if `strlen(batch) + strlen(new_packed)` would
	 * exceed `MAX_LINE_SIZE` (4KB), flush the existing batch FIRST, then
	 * append the new packed message to a now-empty batch.
	 *
	 * @var string
	 */
	protected string $batch = '';

	/**
	 * Per-batched-message bookkeeping flushed in lockstep with `$batch` —
	 * each entry carries the ORIGINAL packed bytes + caller-supplied $data
	 * so the index_callback can be invoked at flush time once the actual
	 * on-disk offset is known.
	 *
	 * @var list<array{packed:string,len:int,data:mixed}>
	 */
	protected array $batch_index_args = [];

	public function __construct(
		string $base_dir,
		int $partition,
		int $segment_size = self::DEFAULT_SEGMENT_SIZE,
		int $num_segments = self::DEFAULT_NUM_SEGMENTS,
		int $max_lifespan = self::DEFAULT_MAX_LIFESPAN
	) {
		// Timer::__construct seeds the FIRE registration slot — we extend
		// Timer so each batched fill can schedule a 0-delay flush via
		// `set_timer(0, oneshot)` (mirrors Tachikoma `Partition.pm:207`).
		parent::__construct();
		$this->base_dir      = \rtrim( $base_dir, '/' );
		$this->partition     = $partition;
		$this->segment_size  = \max( 1, $segment_size );
		$this->num_segments  = \max( 2, $num_segments );
		$this->max_lifespan  = \max( 0, $max_lifespan );
		$this->partition_dir = "{$this->base_dir}/p{$partition}";
		// Round-trip ctor args via Node::$arguments so dump_config emits a
		// `make_node Partition <name> <base_dir> <partition> ...` that
		// re-creates this instance verbatim.
		$this->arguments = "{$this->base_dir} {$this->partition} {$this->segment_size} {$this->num_segments} {$this->max_lifespan}";

		// Sibling CommandInterpreter for runtime configuration verbs
		// (allow_large_writes, with_index). Constructed nameless;
		// Node::name() will propagate `{patron}:config` once make_node
		// names the patron. Routing happens via the existing `cmd`
		// builtin (Shell) → TM_COMMAND → Router → sibling CI's
		// interpret() → verb handler in self::config_verbs().
		$ci = new CommandInterpreter();
		$ci->patron( $this );
		$ci->commands( self::config_verbs() );
		$this->attach_interpreter( $ci );
	}

	/**
	 * Timer fire — drains the batch at the end of the current event-loop
	 * iteration. Each `fill()` that appends to the batch arms a 0-delay
	 * one-shot via `set_timer(0, true)`; once the iteration's events finish
	 * processing, EventFramework calls `fire_cb` here and we land all the
	 * accumulated packed messages in one syswrite.
	 */
	protected function fire(): void {
		$this->flush();
	}

	public function partition_dir(): string {
		return $this->partition_dir;
	}

	public function get_segment_path( int $segment_id ): string {
		if ( $segment_id < 0 ) {
			throw new \InvalidArgumentException( 'Segment ID must be non-negative' );
		}
		return "{$this->partition_dir}/{$segment_id}.log";
	}

	/**
	 * Node entry point.
	 *
	 * Pack the whole message via Message::packed() and append to the current
	 * segment. All TYPE flags pass through — Partition is a generic transport,
	 * including for control messages (TM_REQUEST, TM_ERROR, TM_EOF). The
	 * pivoted-cli IPC pattern relies on this: cli ↔ worker round-trips drain
	 * markers (TM_EOF), error responses (TM_COMMAND|TM_ERROR), and
	 * introspection requests (TM_REQUEST) through Partition-as-bus. Data
	 * partitions like firehose.log only ever see TM_BYTESTREAM / TM_STRUCT in
	 * practice, so the broader contract is a no-op for production paths.
	 *
	 * @param array $message Reference; not mutated.
	 */
	public function fill( array &$message ): void {
		++$this->counter;
		// Mirror Node::fill's largest_msg_sent tracking — Partition's
		// override of fill() skips the base, so without this every
		// Partition would report 0 in stats / dump_metadata.
		$size = Message::value_size( $message );
		if ( $size > $this->largest_msg_sent ) {
			$this->largest_msg_sent = $size;
		}

		// No-event-loop heartbeat: when allow_large_writes was set up outside
		// a drain (request-scope JobIntake-style callers), there's no Timer
		// to refresh the lock's heartbeat file. Drive it from here at most
		// once per (stale_timeout/3) seconds. Lock::heartbeat verifies
		// ownership before touching the file and returns false if we lost
		// it (stale-takeover by another holder) — throw in that case so
		// the caller can't unknowingly write into another holder's segments.
		// $write_lock is guaranteed non-null when allow_large_writes is true.
		if ( $this->allow_large_writes && null === $this->heartbeat_timer ) {
			$now = \microtime( true );
			if ( $now - $this->last_lock_heartbeat >= $this->lock_stale_timeout / 3.0 ) {
				if ( ! $this->write_lock->heartbeat() ) {
					throw new \RuntimeException(
						\esc_html(
							"Partition: write lock at {$this->partition_dir}/write.lock.d "
							. 'no longer owned (stolen via stale-takeover); cannot continue.'
						)
					);
				}
				$this->last_lock_heartbeat = $now;
			}
		}

		// Pack the whole message and append. Bytes are newline-terminated so
		// Consumer can split lines without needing Tachikoma's length-prefix
		// wire format. Size cap is on the FINAL packed bytes (not VALUE
		// alone) — that's what hits PIPE_BUF.
		$packed = Message::packed( $message ) . "\n";
		$max    = $this->allow_large_writes ? self::MAX_LARGE_LINE_SIZE : self::MAX_LINE_SIZE;
		if ( \strlen( $packed ) > $max ) {
			// Silent oversize drop is the most common "where did my
			// message go?" mystery. Narrate it for debug_state.
			$this->set_state(
				'DROPPED',
				[ 'reason' => 'oversize', 'size' => \strlen( $packed ), 'max' => $max ]
			);
			return;
		}

		if ( null === $this->current_segment_id ) {
			$this->init_current_segment();
		}

		$len = \strlen( $packed );
		$this->maybe_rescan_segments();

		// Node-fed path has no pre-decoded $data — index_callback (if any)
		// re-parses $packed when needed.
		$data = null;

		// Large messages (only reachable on allow_large_writes Partitions) bypass
		// the in-memory batch — they're already > 4KB so batching can't shrink
		// them under PIPE_BUF anyway. Flush any pending batch first so on-disk
		// ordering matches submission order, then write the lone message.
		if ( $len > self::MAX_LINE_SIZE ) {
			$this->flush();
			if ( $this->current_size + $len > $this->segment_size ) {
				$this->rotate_segment();
			}
			$fh = $this->get_handle();
			if ( null === $fh ) {
				return;
			}
			$offset = $this->current_size;
			if ( ! $this->loop_fwrite( $fh, $packed ) ) {
				return;
			}
			// loop_fwrite already advanced current_size.
			$this->write_index_entry( $packed, $offset, $len, $data );
			$this->touch_segments_cache();
			return;
		}

		// Small message — append to in-memory batch. Flush first if adding
		// this packed message would push the batch over PIPE_BUF (4KB), so
		// every actual syswrite is atomic-append safe. Mirrors the legacy
		// newspack-performance-logger LogManager batching rule.
		if ( '' !== $this->batch && \strlen( $this->batch ) + $len > self::MAX_LINE_SIZE ) {
			$this->flush();
		}

		// Re-check rotation now that the batch is flushed (or empty); the
		// pending append needs to fit in the current segment.
		if ( $this->current_size + $len > $this->segment_size ) {
			$this->rotate_segment();
		}

		$this->batch              .= $packed;
		$this->batch_index_args[]  = [
			'packed' => $packed,
			'len'    => $len,
			'data'   => $data,
		];

		// Schedule a 0-delay one-shot flush at the end of this event-loop
		// iteration. Mirrors Tachikoma `Partition.pm:207`: every batched
		// fill bumps the timer; the iteration's tail calls fire() once,
		// landing every accumulated message in one syswrite.
		$this->set_timer( 0, true );
	}

	/**
	 * Sysseek + sysappend the accumulated `$batch` to the current segment,
	 * then walk `$batch_index_args` to write companion index entries with
	 * post-flush offsets. Called automatically by `fill()` whenever adding a
	 * new message would push the batch past PIPE_BUF, and at the latest from
	 * `__destruct()` so request-scope writes land before the process exits.
	 */
	public function flush(): void {
		if ( '' === $this->batch ) {
			return;
		}
		$batch_bytes = $this->batch;
		$batch_args  = $this->batch_index_args;
		// Reset state up-front so an exception below doesn't cause a re-flush
		// loop (e.g., from __destruct on the way down).
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
			return;
		}
		$start_offset = $this->current_size;
		if ( ! $this->loop_fwrite( $fh, $batch_bytes ) ) {
			return;
		}
		// loop_fwrite already advanced $this->current_size — don't double-count.

		// Walk the per-message index args and write each at its computed
		// post-flush offset. The batch's first message lands at start_offset;
		// each subsequent one lands at +its packed length.
		$offset = $start_offset;
		foreach ( $batch_args as $item ) {
			$this->write_index_entry( $item['packed'], $offset, $item['len'], $item['data'] );
			$offset += $item['len'];
		}

		$this->touch_segments_cache();
	}

/**
	 * Write one companion-index entry for a packed message at $offset.
	 * Caller-supplied formatter (`with_index()`) wins; default is the
	 * 8-byte binary pack the Consumer's load-offsetlog code expects.
	 */
	private function write_index_entry( string $packed, int $offset, int $len, $data ): void {
		if ( null !== $this->index_callback ) {
			$position = [
				'segment_id' => $this->current_segment_id,
				'offset'     => $offset,
				'length'     => $len,
			];
			try {
				$entry = ( $this->index_callback )( $packed, $position, $data );
				if ( null !== $entry && '' !== $entry && \is_resource( $this->idx_fh ) ) {
					// phpcs:ignore WordPress.WP.AlternativeFunctions.file_system_operations_fwrite, WordPressVIPMinimum.Functions.RestrictedFunctions.file_ops_fwrite
					@\fwrite( $this->idx_fh, $entry . "\n" );
				}
			} catch ( \Throwable $e ) {
				Core::print_less_often( 'Partition: index callback threw: ' . $e->getMessage() );
			}
			return;
		}
		if ( \is_resource( $this->idx_fh ) ) {
			// Default binary 8-byte format: <segment_id, offset> as two big-endian uint32s.
			// phpcs:ignore WordPress.WP.AlternativeFunctions.file_system_operations_fwrite, WordPressVIPMinimum.Functions.RestrictedFunctions.file_ops_fwrite
			@\fwrite( $this->idx_fh, \pack( 'NN', $this->current_segment_id, $offset ) );
		}
	}

	public function __destruct() {
		// Land any residual batched messages before closing handles —
		// otherwise request-scope writes (LogManager via Topic) get GC'd
		// without ever hitting disk. Mirrors register_shutdown_function but
		// scoped tighter: flushes whenever this Partition is collected.
		$this->flush();
		$this->close_handle();
	}

	/**
	 * Close file handles + release write lock before normal Node teardown.
	 * Without this, files only close at GC/__destruct, leaving a window where
	 * a stale handle can race against rotate-via-mkdir-lock.
	 */
	public function remove_node(): void {
		$this->close_handle();
		if ( null !== $this->write_lock ) {
			$this->write_lock->release();
			$this->write_lock = null;
		}
		parent::remove_node();
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

	public static function hash_to_partition( string $key, int $num_partitions ): int {
		[ $stripped ] = \explode( '?', $key, 2 );
		return ( \crc32( $stripped ) & 0x7FFFFFFF ) % $num_partitions;
	}

	/**
	 * Initialize current segment state from existing segments on disk.
	 * Does NOT create files — segment files materialize on first write via fopen('a').
	 */
	protected function init_current_segment(): void {
		$this->close_handle();
		$segments = $this->get_segments( true );
		if ( empty( $segments ) ) {
			$this->current_segment_id = 0;
			$this->current_size       = 0;
			$this->current_log_path   = "{$this->partition_dir}/0.log";
			$this->current_idx_path   = "{$this->partition_dir}/0.idx";
			return;
		}
		$newest                   = \end( $segments );
		$this->current_segment_id = $newest['id'];
		$this->current_size       = $newest['size'];
		$this->current_log_path   = "{$this->partition_dir}/{$this->current_segment_id}.log";
		$this->current_idx_path   = "{$this->partition_dir}/{$this->current_segment_id}.idx";
	}

	/**
	 * List segments on disk sorted by id, cached for SEGMENT_CACHE_TTL.
	 *
	 * @param bool $force_refresh Skip the cache and rescan.
	 * @return array<int,array{id:int,size:int}>
	 */
	public function get_segments( bool $force_refresh = false ): array {
		$now = \microtime( true );
		if ( ! $force_refresh && null !== $this->segments_cache && ( $now - $this->segments_cache_time ) < self::SEGMENT_CACHE_TTL ) {
			return $this->segments_cache;
		}
		$segments = [];
		if ( ! \is_dir( $this->partition_dir ) ) {
			$this->segments_cache      = [];
			$this->segments_cache_time = $now;
			return [];
		}
		// phpcs:ignore WordPress.WP.AlternativeFunctions.file_system_operations_scandir
		$files = @\scandir( $this->partition_dir );
		if ( ! $files ) {
			$this->segments_cache      = [];
			$this->segments_cache_time = $now;
			return [];
		}
		foreach ( $files as $f ) {
			if ( \preg_match( self::SEGMENT_PATTERN, $f, $m ) ) {
				$segments[] = [ 'id' => (int) $m[1], 'size' => @\filesize( "{$this->partition_dir}/{$f}" ) ?: 0 ];
			}
		}
		\usort( $segments, fn ( $a, $b ) => $a['id'] <=> $b['id'] );
		$this->segments_cache      = $segments;
		$this->segments_cache_time = $now;
		return $segments;
	}

	/**
	 * Lift the line-size limit to 10MB and acquire a Lock that serializes
	 * cross-process writes for the lifetime of this Partition.
	 *
	 * The Lock is constructed as a Node (`{$this->name}:lock`) sinking to
	 * whatever this Partition sinks into, so its own outbound traffic
	 * (currently none, but reserved) routes through `_router`. A Timer
	 * (`{$this->name}:heartbeat`) sinks INTO the Lock and stamps each
	 * emitted message with `KEY = 'heartbeat'`; Lock::fill matches the KEY
	 * tag and refreshes the lock file. Heartbeat cadence is one-third the
	 * stale-timeout — well under the threshold even if the worker stalls
	 * for one tick.
	 *
	 * Requires `name()` and `sink()` to be set BEFORE this is called.
	 *
	 * Single-writer claim: only one Partition can hold this dir's write_lock
	 * at a time. `Lock::acquire()` blocks with retry up to `stale_timeout +
	 * margin` so the common case — a previous worker that just exited and
	 * left a heartbeat that hasn't aged out yet — recovers without dropping
	 * the spawn. The retry loop steals automatically once the heartbeat
	 * crosses the stale threshold.
	 *
	 * If we still can't acquire after that, throw — at that point another
	 * live writer is genuinely active and proceeding would corrupt their
	 * writes (and the lock-loser's own state would be set silently to
	 * allow_large_writes=true on a dir it doesn't own).
	 *
	 * @param int $max_wait_ms How long to wait for lock acquisition, in
	 *                          milliseconds. Default 65000 (stale_timeout +
	 *                          5s margin) is sized for normal worker respawn
	 *                          races. Tests can pass a smaller value to
	 *                          exercise the throw path quickly.
	 * @throws \RuntimeException when the lock cannot be acquired.
	 * @return self
	 */
	public function allow_large_writes( int $max_wait_ms = 65000 ): self {
		$stale_timeout = 60;
		$lock          = new Lock( "{$this->partition_dir}/write.lock.d", $stale_timeout );

		// Two call patterns:
		//   (a) Inside a worker — EventFramework::drain() is active. Use the
		//       Node-graph integration: Lock as a sink, heartbeat Timer fires
		//       every stale_timeout/3 ms via the EF, KEY='heartbeat' is the
		//       Lock::fill dispatch tag.
		//   (b) Outside an event loop — request-scope code (JobIntake etc.)
		//       acquires the lock for a few writes and releases. A Timer here
		//       would register with EF but never fire (no drain), and the
		//       graph wiring (lock->name + lock->sink) would never be reached
		//       by any router. Skip all of it; drive the heartbeat manually
		//       from fill() and verify ownership inline.
		$ef_running = EventFramework::instance()->is_running();
		if ( $ef_running ) {
			$lock->name( "{$this->name}:lock" );
			$lock->sink( $this->sink );
			// Mark as patron-linked plumbing so dump_metadata hides
			// it from the topology console canvas.
			$lock->patron( $this );
		}

		// Block up to max_wait_ms so respawn races (old worker just exited,
		// heartbeat still fresh) recover automatically once the previous
		// holder's heartbeat ages out (after stale_timeout).
		if ( ! $lock->acquire( $max_wait_ms ) ) {
			throw new \RuntimeException(
				\esc_html(
					"Partition::allow_large_writes() failed to acquire write lock at "
					. "{$this->partition_dir}/write.lock.d after {$max_wait_ms}ms — another live writer holds it. "
					. 'Two concurrent writers on the same Partition is unsupported.'
				)
			);
		}

		$this->allow_large_writes  = true;
		$this->write_lock          = $lock;
		$this->lock_stale_timeout  = $stale_timeout;
		$this->last_lock_heartbeat = \microtime( true );

		if ( $ef_running ) {
			// Heartbeat Timer: sinks into the Lock; KEY='heartbeat' tags every
			// fired message so Lock::fill recognizes it as a heartbeat tick.
			// Cadence (ms) = stale_timeout * 1000 / 3 — three heartbeats per
			// stale window means a single missed tick still doesn't expire us.
			$this->heartbeat_timer = new Timer();
			$this->heartbeat_timer->name( "{$this->name}:heartbeat" );
			$this->heartbeat_timer->sink( $this->write_lock );
			$this->heartbeat_timer->set_key( 'heartbeat' );
			$this->heartbeat_timer->set_timer( (int) ( $stale_timeout * 1000 / 3 ) );
			// Same hide-from-canvas marker as the Lock above.
			$this->heartbeat_timer->patron( $this );
		}

		return $this;
	}

	/**
	 * Enable companion index files via a custom formatter callback.
	 *
	 * Replaces the default binary `pack('NN', ...)` format with caller-supplied
	 * JSONL (or any other shape returned by the formatter). Used by
	 * RequestBuilder::format_index_entry and FlameBuilder::format_index_entry.
	 *
	 * @param callable $callback fn(string $line, array $position, ?array &$data) => string|null
	 *                           Return null to skip the entry; '' is treated as overflow-skip.
	 * @return self
	 */
	public function with_index( callable $callback ): self {
		$this->index_callback = $callback;
		return $this;
	}

	/**
	 * Get the current write position (segment_id + tail offset of the active segment).
	 *
	 * @return array{segment_id:int, offset:int}
	 */
	public function get_current_position(): array {
		if ( null === $this->current_segment_id ) {
			$this->init_current_segment();
		}
		return [
			'segment_id' => (int) $this->current_segment_id,
			'offset'     => $this->current_size,
		];
	}

	/**
	 * Drift / TOCTOU recovery: every DRIFT_RESCAN_INTERVAL_SECONDS, rescan the
	 * segment list and follow the newest if another writer rotated underneath us.
	 *
	 * Without this, a long-lived single-process writer can wedge on a stale segment_id
	 * after a peer (or test) rotated the directory.
	 */
	protected function maybe_rescan_segments(): void {
		$now = \microtime( true );
		if ( $now - $this->last_segment_check < self::DRIFT_RESCAN_INTERVAL_SECONDS ) {
			return;
		}
		$this->last_segment_check = $now;
		$segments                 = $this->get_segments( true );
		if ( empty( $segments ) ) {
			return;
		}
		$newest = \end( $segments );
		if ( $newest['id'] !== $this->current_segment_id ) {
			$this->close_handle();
			$this->current_segment_id = $newest['id'];
			$this->current_size       = $newest['size'];
			$this->current_log_path   = "{$this->partition_dir}/{$this->current_segment_id}.log";
			$this->current_idx_path   = "{$this->partition_dir}/{$this->current_segment_id}.idx";
		}
	}

	/**
	 * Loop fwrite up to MAX_PARTIAL_WRITE_ATTEMPTS to handle short writes.
	 * Updates $this->current_size as bytes go out.
	 *
	 * @param resource $fh    Open file handle (append mode).
	 * @param string   $bytes Bytes to write.
	 * @return bool True if all bytes were written.
	 */
	protected function loop_fwrite( $fh, string $bytes ): bool {
		$remaining = $bytes;
		$attempts  = 0;
		while ( '' !== $remaining ) {
			// phpcs:ignore WordPress.WP.AlternativeFunctions.file_system_operations_fwrite, WordPressVIPMinimum.Functions.RestrictedFunctions.file_ops_fwrite
			$written = @\fwrite( $fh, $remaining );
			if ( false === $written || 0 === $written ) {
				++$attempts;
				if ( $attempts >= self::MAX_PARTIAL_WRITE_ATTEMPTS ) {
					Core::print_less_often( 'Partition: fwrite stalled (' . $attempts . " attempts) for {$this->current_log_path}" );
					return false;
				}
				continue;
			}
			$this->current_size  += $written;
			$this->bytes_written += $written;
			$remaining            = \substr( $remaining, $written );
		}
		return true;
	}

	/**
	 * Mirror current_size back into the segments_cache so a stale cache hit
	 * doesn't lie about the active segment. Adds the segment if it's new.
	 */
	protected function touch_segments_cache(): void {
		if ( null === $this->segments_cache ) {
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

	/**
	 * Rotate to a new segment. Multi-writer-safe: acquires an mkdir lock at
	 * `{base}/locks/{topic}.p{N}.rotate.lock.d` so concurrent writers can't both
	 * create segment N+1. Stale locks (mtime older than ROTATE_LOCK_TTL_SECONDS)
	 * are forced.
	 *
	 * Single-writer mode (allow_large_writes()) skips the lock since the per-write
	 * Lock already serializes access.
	 */
	protected function rotate_segment(): void {
		$this->close_handle();

		// Single-writer / large-writes mode already serializes; skip the rotation lock.
		if ( $this->allow_large_writes ) {
			$this->do_rotate();
			return;
		}

		$log_name  = \basename( $this->base_dir );
		$log_base  = \dirname( $this->base_dir );
		$locks_dir = "{$log_base}/locks";
		$lock_dir  = "{$locks_dir}/{$log_name}.p{$this->partition}.rotate.lock.d";

		if ( ! \is_dir( $locks_dir ) ) {
			// phpcs:ignore WordPressVIPMinimum.Functions.RestrictedFunctions.directory_mkdir
			@\mkdir( $locks_dir, 0755, true );
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
				// Another process is rotating; wait briefly and re-init from disk.
				\usleep( 50000 );
				$this->init_current_segment();
				return;
			}
			// Stale lock: force-clear and retry. If retry still fails, give up gracefully.
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
	 * Perform the actual rotation. Called either with the rotation lock held
	 * (multi-writer) or without it (single-writer / allow_large_writes).
	 *
	 * Also detects "another writer already advanced": if the newest segment on
	 * disk still has room, just adopt it instead of bumping the id.
	 */
	protected function do_rotate(): void {
		// Force-refresh the segments list — the cache may pre-date a peer's rotation.
		$segments = $this->get_segments( true );

		if ( ! empty( $segments ) ) {
			$newest = \end( $segments );
			if ( $newest['size'] < $this->segment_size ) {
				// A peer already rotated and the new segment still has room. Adopt it.
				$this->current_segment_id = $newest['id'];
				$this->current_size       = $newest['size'];
				$this->current_log_path   = "{$this->partition_dir}/{$this->current_segment_id}.log";
				$this->current_idx_path   = "{$this->partition_dir}/{$this->current_segment_id}.idx";
				$this->segments_cache     = null;
				return;
			}
		}

		$next_id = empty( $segments ) ? 0 : ( \end( $segments )['id'] + 1 );

		$this->current_segment_id = $next_id;
		$this->current_size       = 0;
		$this->current_log_path   = "{$this->partition_dir}/{$next_id}.log";
		$this->current_idx_path   = "{$this->partition_dir}/{$next_id}.idx";
		$this->segments_cache     = null;

		// Defeat get_handle()'s file-missing TOCTOU guard: materialize the empty file
		// now so a concurrent reader/writer doesn't trip the "missing? must be a wipe"
		// path and re-init back to segment 0.
		if ( ! \is_dir( $this->partition_dir ) ) {
			// phpcs:ignore WordPressVIPMinimum.Functions.RestrictedFunctions.directory_mkdir
			@\mkdir( $this->partition_dir, 0755, true );
		}
		// phpcs:ignore WordPress.WP.AlternativeFunctions.file_system_operations_touch, WordPressVIPMinimum.Functions.RestrictedFunctions.file_ops_touch
		if ( ! @\touch( $this->current_log_path ) ) {
			Core::print_less_often( "Partition: touch() failed for {$this->current_log_path}" );
		}

		// Run retention right after rotating so we don't accumulate forever — matches
		// upstream Firehose::do_rotate().
		$this->cleanup_segments();

		// Durable state: which segment are we writing to now? Late
		// subscribers (eventual SSE controller, any in-process Topic that
		// wires up an event listener) get immediate replay of the current
		// segment. Cached by set_state.
		$this->set_state( 'SEGMENT', $this->current_segment_id );
	}

	/**
	 * AND-gated retention: delete oldest segments when BOTH
	 * count > num_segments AND (now - mtime) >= max_lifespan.
	 */
	public function cleanup_segments(): void {
		$segments       = $this->get_segments( true );
		$count          = \count( $segments );
		$initial_count  = $count;
		$now            = \time();

		while ( $count > $this->num_segments ) {
			$oldest = $segments[0];
			$path   = "{$this->partition_dir}/{$oldest['id']}.log";
			$mtime  = @\filemtime( $path );
			if ( false === $mtime || ( $now - $mtime ) < $this->max_lifespan ) {
				break;
			}
			// Partition's segment directory is base_dir-relative — not WP-managed.
			// phpcs:disable WordPressVIPMinimum.Functions.RestrictedFunctions.file_ops_unlink
			@\unlink( $path );
			@\unlink( "{$this->partition_dir}/{$oldest['id']}.idx" );
			// phpcs:enable
			\array_shift( $segments );
			--$count;
		}
		$this->segments_cache = null;

		// State transition only when retention actually removed something —
		// `cleanup_segments` runs every rotate but most calls are no-ops
		// (under the lifespan threshold). Late subscribers see the most
		// recent non-zero deletion + current alive count.
		$deleted = $initial_count - $count;
		if ( $deleted > 0 ) {
			$this->set_state( 'CLEANUP', [ 'deleted' => $deleted, 'alive' => $count ] );
		}
	}

	/**
	 * Read bytes from a segment at a given offset.
	 *
	 * Bounds-checked: rejects negative IDs/offsets/lengths and lengths over
	 * MAX_READ_SIZE to prevent memory exhaustion from malicious or buggy callers.
	 *
	 * @param int $segment_id Segment to read from.
	 * @param int $offset     Byte offset within segment.
	 * @param int $length     Number of bytes to read.
	 * @return string Bytes read; empty string on bounds violation, missing file, or read failure.
	 */
	public function read_at( int $segment_id, int $offset, int $length ): string {
		if ( $segment_id < 0 || $offset < 0 || $length < 0 || $length > self::MAX_READ_SIZE ) {
			return '';
		}
		if ( 0 === $length ) {
			return '';  // fread() throws on $length === 0 in PHP 8.1+; short-circuit.
		}
		$path = $this->get_segment_path( $segment_id );
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

	/**
	 * Walk every .idx entry across all segments and invoke the callback per entry.
	 *
	 * Behavior depends on whether with_index() configured a custom formatter:
	 *   - Default (no custom formatter): each entry is 8 bytes packed as two
	 *     big-endian uint32s; callback signature is fn(int $segment_id, int $offset).
	 *   - Custom formatter (JSONL): each line in the .idx file is delivered as
	 *     a string; callback signature is fn(string $line, int $segment_id).
	 *
	 * Returns false from the callback to terminate the scan early.
	 *
	 * @param callable $cb           Per-entry callback.
	 * @param bool     $newest_first Iterate newest segment first (and entries within
	 *                               newest-first too) when true. Default oldest-first.
	 */
	public function scan_index( callable $cb, bool $newest_first = false ): void {
		$segments = $this->get_segments();
		if ( $newest_first ) {
			$segments = \array_reverse( $segments );
		}

		foreach ( $segments as $s ) {
			$idx_path = "{$this->partition_dir}/{$s['id']}.idx";
			if ( ! \file_exists( $idx_path ) ) {
				continue;
			}

			// Cap the per-file read at MAX_READ_SIZE so a runaway .idx file
			// can't OOM the worker on scan.
			$idx_size = @\filesize( $idx_path );
			if ( false === $idx_size || $idx_size > self::MAX_READ_SIZE ) {
				continue;
			}

			// phpcs:ignore WordPressVIPMinimum.Performance.FetchingRemoteData.FileGetContentsUnknown
			$idx = @\file_get_contents( $idx_path );
			if ( false === $idx ) {
				continue;
			}

			if ( null !== $this->index_callback ) {
				// Custom (JSONL) format.
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
				continue;
			}

			// Default binary 8-byte format.
			$len = \strlen( $idx );
			if ( $newest_first ) {
				for ( $i = $len - 8; $i >= 0; $i -= 8 ) {
					$entry = \substr( $idx, $i, 8 );
					if ( \strlen( $entry ) !== 8 ) {
						continue;
					}
					[ , $seg, $off ] = \unpack( 'N2', $entry );
					if ( false === $cb( $seg, $off ) ) {
						return;
					}
				}
			} else {
				for ( $i = 0; $i < $len; $i += 8 ) {
					$entry = \substr( $idx, $i, 8 );
					if ( \strlen( $entry ) !== 8 ) {
						break;
					}
					[ , $seg, $off ] = \unpack( 'N2', $entry );
					if ( false === $cb( $seg, $off ) ) {
						return;
					}
				}
			}
		}
	}

	/**
	 * Lazily open and cache the .log + .idx handles for the current segment.
	 *
	 * Re-init on partition_dir disappearance (recovery from rm -rf), and on missing
	 * current_log_path (defeats TOCTOU when a peer rotates between init and open).
	 *
	 * For single-writer scenarios (allow_large_writes), disable PHP's stream buffer
	 * so downstream readers see new entries immediately instead of waiting for the
	 * 8KB stdio buffer to fill.
	 *
	 * @return resource|null Log handle, or null on open failure.
	 */
	protected function get_handle() {
		if ( ! \is_dir( $this->partition_dir ) ) {
			// phpcs:ignore WordPressVIPMinimum.Functions.RestrictedFunctions.directory_mkdir
			@\mkdir( $this->partition_dir, 0755, true );
			// Whole tree got wiped; reset state from disk (will land at segment 0).
			$this->init_current_segment();
		} elseif ( null !== $this->current_log_path && ! \file_exists( $this->current_log_path ) ) {
			// Active log file disappeared underneath us — re-init from on-disk state.
			$this->init_current_segment();
		}

		if ( null === $this->fh || $this->fh_segment_id !== $this->current_segment_id ) {
			$this->close_handle();
			// phpcs:ignore WordPress.WP.AlternativeFunctions.file_system_operations_fopen, WordPressVIPMinimum.Functions.RestrictedFunctions.file_ops_fopen
			$fh = @\fopen( $this->current_log_path, 'a' );
			if ( false === $fh ) {
				return null;
			}
			$this->fh            = $fh;
			$this->fh_segment_id = $this->current_segment_id;

			// Single-writer mode: disable PHP's 8KB stream buffer so SSE / Tail readers
			// see writes immediately (matches upstream Firehose).
			if ( $this->allow_large_writes ) {
				\stream_set_write_buffer( $this->fh, 0 );
			}

			// phpcs:ignore WordPress.WP.AlternativeFunctions.file_system_operations_fopen, WordPressVIPMinimum.Functions.RestrictedFunctions.file_ops_fopen
			$idx_fh       = @\fopen( $this->current_idx_path, 'a' );
			$this->idx_fh = ( false === $idx_fh ) ? null : $idx_fh;
		}
		return $this->fh;
	}

	/**
	 * Per-class verb table for the sibling `:config` CI. Resolved
	 * per-instance via `$ci->patron()` at dispatch time so each
	 * closure is stateless and shareable across all Partition
	 * instances (memoized on first call).
	 *
	 * @return array<string,callable>
	 */
	private static function config_verbs(): array {
		static $verbs = null;
		if ( null === $verbs ) {
			$verbs = [
				'allow_large_writes' => static function ( CommandInterpreter $ci, string $args ): string {
					/** @var self $patron */
					$patron = $ci->patron();
					$patron->allow_large_writes();
					$patron->mark_verb_invoked( 'allow_large_writes', '' );
					return 'ok';
				},
				'with_index'         => static function ( CommandInterpreter $ci, string $args ): string {
					$args = \trim( $args );
					if ( '' === $args ) {
						return 'usage: with_index <formatter_name>';
					}
					$callable = Formatters::resolve( $args );
					if ( null === $callable ) {
						return "unknown formatter: $args";
					}
					/** @var self $patron */
					$patron = $ci->patron();
					$patron->with_index( $callable );
					$patron->mark_verb_invoked( 'with_index', $args );
					return 'ok';
				},
			];
		}
		return $verbs;
	}

	/**
	 * Manifest the topology console reads to render the palette
	 * entry + ctor form + verb forms for Partition. See
	 * Node::node_schema() for the shape contract.
	 */
	public static function node_schema(): array {
		return \array_merge( parent::node_schema(), [
			'category'    => 'Storage',
			'description' => 'Append-only segmented log; data file + offset index per partition.',
			'ctor'        => [
				[ 'name' => 'base_dir',     'type' => 'string', 'required' => true ],
				[ 'name' => 'partition',    'type' => 'int',    'required' => true, 'default' => '<partition>' ],
				[ 'name' => 'segment_size', 'type' => 'int',    'default' => '<config:segment_size>' ],
				[ 'name' => 'num_segments', 'type' => 'int',    'default' => '<config:num_segments>' ],
				[ 'name' => 'max_lifespan', 'type' => 'int',    'default' => '<config:max_lifespan>' ],
			],
			'verbs'       => [
				[
					'name'        => 'allow_large_writes',
					'description' => 'Lift the 4KB PIPE_BUF cap; acquire per-partition write lock.',
					'args'        => [],
				],
				[
					'name'        => 'with_index',
					'description' => 'Use a named line-formatter for the companion index file.',
					'args'        => [
						[ 'name' => 'formatter', 'type' => 'formatter_name', 'required' => true ],
					],
				],
			],
			'has_target'  => false,
		] );
	}
}
