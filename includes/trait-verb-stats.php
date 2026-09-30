<?php
/**
 * Verb_Stats: a store node's per-verb cost counters and its trace line.
 *
 * A using node counts, per verb, since it was built or last reset: calls, the
 * keys or rows asked and answered, the encoded bytes its store handled, and
 * total and max nanoseconds on the monotonic clock. It declares the verbs it
 * counts as `ZERO_STATS`, each mapped to `ZERO_ROW`, and the bytes its store
 * has handled as `stat_bytes()`; a verb outside ZERO_STATS counts nowhere.
 * `dump_node` and `dump_metadata` carry the counters as `verb_stats`, which the
 * topology console's Inspector draws for any node.
 *
 * A traced node (`debug_state` above 0) writes one `DEBUG: <VERB> <calls>
 * <ms>ms, …` line per Router tick through `trace_tick()`, over the verbs
 * called since its last; the node's tick calls it. A node writing a SQLite
 * WAL checkpoints it on the tick through `checkpoint_wal()`, once a
 * CHECKPOINT_INTERVAL_S, counted as CHECKPOINT.
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes;

\defined( 'ABSPATH' ) || exit;

trait Verb_Stats {

	/** A verb's calls, in its counter row. */
	private const CALLS = 0;

	/** Keys or rows a verb's calls asked for. */
	private const ASKED = 1;

	/** Keys or rows a verb's calls answered or took effect on. */
	private const ANSWERED = 2;

	/** Encoded bytes a store handled for a verb. */
	private const BYTES = 3;

	/** A verb's nanoseconds on the monotonic clock, all calls together. */
	private const TOTAL_NS = 4;

	/** A verb's longest call, in nanoseconds. */
	private const MAX_NS = 5;

	/** One verb's counter row at zero, which each ZERO_STATS entry maps to. */
	private const ZERO_ROW = [ 0, 0, 0, 0, 0, 0 ];

	/**
	 * Seconds between one store's WAL checkpoints. A checkpoint copies each
	 * page in the WAL back once, however many writes dirtied it since the
	 * last, so a hot page costs one copy an interval rather than one a tick.
	 * Checkpointing every tick, staging's aggregate Table spent 1,686 ms in
	 * 133 checkpoints, 39% of its time, beside 1,879 ms of SADD and 614 ms of
	 * MSET. At its ~630 frames a second, 30 s leaves ~19,000 frames, ~75 MB,
	 * to one checkpoint, and bounds what a crash replays from the WAL. It is
	 * half of Table_Node::PURGE_INTERVAL_S, so every other checkpoint of a
	 * Table shares its purge tick.
	 */
	public const CHECKPOINT_INTERVAL_S = 30;

	/**
	 * Checkpoints in a row that may leave frames behind, while the WAL grows,
	 * before the store warns. A PASSIVE checkpoint stops at the oldest open
	 * reader's snapshot, and a reader here is one request's mount, which PHP
	 * ends inside its 30-second max_execution_time. Checkpoints sit
	 * CHECKPOINT_INTERVAL_S apart, so one request straddles two of them at
	 * most; four in a row spans at least 90 seconds, three times what one
	 * request can hold, so it means readers overlapping without a gap, or one
	 * stuck, and the WAL grows until one lets go.
	 */
	public const WAL_STALL_CHECKPOINTS = 4;

	/**
	 * Monotonic-clock seam behind the per-verb timings, replacing
	 * `hrtime( true )`. Tests pin it to set what one verb measures.
	 * Signature: `function (): int`, nanoseconds from an arbitrary origin.
	 *
	 * @var (\Closure(): int)|null
	 */
	public static ?\Closure $hrtime = null;

	/**
	 * Per-verb counters since the node was built or last reset; see stats().
	 *
	 * @var array<string,array{int,int,int,int,int,int}>
	 */
	private array $verb_stats = self::ZERO_STATS;

	/**
	 * The counters as the last trace line left them, held only while traced.
	 *
	 * @var array<string,array{int,int,int,int,int,int}>|null
	 */
	private ?array $traced = null;

	/** The tick this store's next WAL checkpoint is due, in epoch seconds. */
	private int $checkpoint_due = 0;

	/** Consecutive WAL checkpoints that left frames behind. */
	private int $wal_stalled = 0;

	/** WAL frames at the first checkpoint of the current stall. */
	private int $wal_stall_frames = 0;

	/**
	 * The encoded bytes this node's store has handled, which count_call()
	 * differences around one call.
	 *
	 * @return int Bytes.
	 */
	abstract private function stat_bytes(): int;

	/**
	 * The node's snapshot, its per-verb counters shown as stats() reports them.
	 *
	 * @return array<string,mixed>
	 */
	public function dump_node(): array {
		return \array_replace( parent::dump_node(), [ 'verb_stats' => $this->stats() ] );
	}

	/**
	 * The per-verb counters, for the console's metadata row.
	 *
	 * @return array<string,mixed>
	 */
	public function dump_metadata(): array {
		return [ 'verb_stats' => $this->stats() ];
	}

	/**
	 * The per-verb counters since the node was built or last reset. `bytes` is
	 * what the store encoded or decoded; a call that threw still counts, with
	 * its time.
	 *
	 * @api The `stats` verb, dump_node() and dump_metadata() answer it.
	 * @return array<string,array{calls:int,asked:int,answered:int,bytes:int,total_ms:float,max_ms:float}>
	 */
	public function stats(): array {
		$out = [];
		foreach ( $this->verb_stats as $verb => $row ) {
			$out[ $verb ] = [
				'calls'    => $row[ self::CALLS ],
				'asked'    => $row[ self::ASKED ],
				'answered' => $row[ self::ANSWERED ],
				'bytes'    => $row[ self::BYTES ],
				'total_ms' => \round( $row[ self::TOTAL_NS ] / 1e6, 3 ),
				'max_ms'   => \round( $row[ self::MAX_NS ] / 1e6, 3 ),
			];
		}
		return $out;
	}

	/**
	 * Zero the counters, answering them as they stood, so no call lands
	 * between the read and the reset; a trace sums from here on.
	 *
	 * @return array<string,array{calls:int,asked:int,answered:int,bytes:int,total_ms:float,max_ms:float}>
	 */
	public function reset_stats(): array {
		$stats            = $this->stats();
		$this->verb_stats = self::ZERO_STATS;
		if ( null !== $this->traced ) {
			$this->traced = self::ZERO_STATS;
		}
		return $stats;
	}

	/**
	 * Count one call of `$verb` begun at `$started`: its time and the bytes
	 * its store handled since `$bytes`. A verb not counted adds no row.
	 * Callers bracket inline, since a closure would allocate once per message.
	 *
	 * @param string $verb    The verb.
	 * @param int    $started monotonic_ns() when the call began.
	 * @param int    $bytes   stat_bytes() when the call began.
	 */
	private function count_call( string $verb, int $started, int $bytes ): void {
		if ( ! isset( $this->verb_stats[ $verb ] ) ) {
			return;
		}
		$ns = self::monotonic_ns() - $started;
		++$this->verb_stats[ $verb ][ self::CALLS ];
		$this->verb_stats[ $verb ][ self::BYTES ]    += $this->stat_bytes() - $bytes;
		$this->verb_stats[ $verb ][ self::TOTAL_NS ] += $ns;
		if ( $ns > $this->verb_stats[ $verb ][ self::MAX_NS ] ) {
			$this->verb_stats[ $verb ][ self::MAX_NS ] = $ns;
		}
	}

	/**
	 * Add to a verb's keys or rows asked and answered; as count_call(), a
	 * verb not counted adds no row.
	 *
	 * @param string $verb     The verb.
	 * @param int    $asked    Keys or rows asked.
	 * @param int    $answered Keys or rows answered or written.
	 */
	private function count_rows( string $verb, int $asked, int $answered ): void {
		if ( ! isset( $this->verb_stats[ $verb ] ) ) {
			return;
		}
		$this->verb_stats[ $verb ][ self::ASKED ]    += $asked;
		$this->verb_stats[ $verb ][ self::ANSWERED ] += $answered;
	}

	/**
	 * The monotonic clock: `hrtime( true )`, or the `$hrtime` seam.
	 *
	 * @return int Nanoseconds from an arbitrary origin.
	 */
	private static function monotonic_ns(): int {
		return null === self::$hrtime ? (int) \hrtime( true ) : ( self::$hrtime )();
	}

	/**
	 * Read or set the trace level. Setting it on holds the counters as they
	 * stand, so the first trace line sums what came after; off drops them.
	 *
	 * @param int|null $level New level (null = pure getter).
	 * @return int The level now in force.
	 */
	public function debug_state( ?int $level = null ): int {
		$state = parent::debug_state( $level );
		if ( null !== $level ) {
			$this->traced = $state > 0 ? $this->traced ?? $this->verb_stats : null;
		}
		return $state;
	}

	/**
	 * A traced node's line for one Router tick: `DEBUG: <VERB> <calls>
	 * <ms>ms, …` over each verb called since its last line, on the stderr
	 * path set_state()'s DEBUG line takes, so the console's timeline reads
	 * it; no line when nothing was called.
	 */
	private function trace_tick(): void {
		$last  = $this->traced ?? $this->verb_stats;
		$parts = [];
		foreach ( $this->verb_stats as $verb => $row ) {
			$calls = $row[ self::CALLS ] - $last[ $verb ][ self::CALLS ];
			if ( $calls > 0 ) {
				$parts[] = "{$verb} {$calls} " . \round( ( $row[ self::TOTAL_NS ] - $last[ $verb ][ self::TOTAL_NS ] ) / 1e6, 3 ) . 'ms';
			}
		}
		$this->traced = $this->verb_stats;
		if ( [] !== $parts ) {
			$this->stderr( 'DEBUG: ' . \implode( ', ', $parts ) );
		}
	}

	/**
	 * One WAL checkpoint, unless a purge this tick spent the deadline (read
	 * off `Core::$now`, which the purge refreshed), or at once when no purge
	 * was due and the tick set no deadline. One that runs dates the next from
	 * `$now`. It is counted as CHECKPOINT: `asked` the WAL's frames,
	 * `answered` the frames written back. A partial one is ordinary and the
	 * next carries on; WAL_STALL_CHECKPOINTS of them in a row, with the WAL
	 * larger than when the stall began, is warned about, rate-limited, as is
	 * one that fails. One SQLite answers busy, while another connection
	 * checkpoints the file, counts its call alone: a stall neither ends nor
	 * grows on it.
	 *
	 * @param \Closure(): ?array{0: int, 1: int} $checkpoint The store's PASSIVE
	 *                                                       checkpoint, null
	 *                                                       on busy.
	 * @param int                               $now        The tick, in epoch seconds.
	 * @param ?float                            $until      The tick's deadline, shared by
	 *                                                      every store, or null when no
	 *                                                      purge was due.
	 */
	private function checkpoint_wal( \Closure $checkpoint, int $now, ?float $until ): void {
		if ( null !== $until && Core::$now >= $until ) {
			return;
		}
		$this->checkpoint_due = $now + self::CHECKPOINT_INTERVAL_S;
		$started              = self::monotonic_ns();
		try {
			$result = $checkpoint();
		} catch ( \PDOException $e ) {
			$this->print_less_often( 'WARNING: WAL checkpoint failed: ', $e->getMessage() );
			return;
		} finally {
			$this->count_call( 'CHECKPOINT', $started, $this->stat_bytes() );
		}
		if ( null === $result ) {
			return;
		}
		[ $frames, $written ] = $result;
		$this->count_rows( 'CHECKPOINT', $frames, $written );
		if ( $written >= $frames ) {
			$this->wal_stalled = 0;
			return;
		}
		if ( 0 === $this->wal_stalled++ ) {
			$this->wal_stall_frames = $frames;
		}
		if ( $this->wal_stalled >= self::WAL_STALL_CHECKPOINTS && $frames > $this->wal_stall_frames ) {
			$this->print_less_often( 'WARNING: WAL checkpoint has not completed ', "for {$this->wal_stalled} checkpoints while the WAL grew from {$this->wal_stall_frames} to {$frames} frames; an open reader holds an old snapshot" );
		}
	}

	/**
	 * Run `$batch`, a statement deleting at most `$room` rows, while each
	 * comes back full and the deadline, read through `Core::right_now()`,
	 * has not passed, so a spent deadline runs one; counted as one call of
	 * `$verb`, asked the batches' room and answered the rows deleted. The
	 * deadline is checked between batches, so one statement blocked on the
	 * file's write lock can hold the tick for its busy_timeout. A batch that
	 * throws still counts.
	 *
	 * @param string          $verb  The counted verb, PURGE or DROP.
	 * @param \Closure(): int $batch One statement, answering the rows it deleted.
	 * @param int             $room  Rows one statement deletes at most.
	 * @param float           $until The deadline.
	 * @return array{0: int, 1: int} Rows deleted, and batches run.
	 */
	private function delete_batches( string $verb, \Closure $batch, int $room, float $until ): array {
		$started = self::monotonic_ns();
		$bytes   = $this->stat_bytes();
		$batches = 0;
		$deleted = 0;
		try {
			do {
				++$batches;
				$rows     = $batch();
				$deleted += $rows;
			} while ( Core::right_now() < $until && $room === $rows );
		} finally {
			$this->count_rows( $verb, $batches * $room, $deleted );
			$this->count_call( $verb, $started, $bytes );
		}
		return [ $deleted, $batches ];
	}
}
