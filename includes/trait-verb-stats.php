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
 * called since its last; the node's tick calls it.
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
}
