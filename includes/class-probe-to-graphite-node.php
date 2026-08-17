<?php
/**
 * ProbeToGraphite
 *
 * Modeled on Tachikoma's `TopicProbeToGraphite.pm` over the substrate's
 * positional Probe_Record: fill() accumulates one entry per reader, fire()
 * formats `<prefix>.<reader>.<field> value ts` plaintext lines (fields:
 * distance, msgs_delta, bytes_read_delta, cache_size), batches them 16 per
 * TM_BYTESTREAM message to its sink, and clears state.
 *
 * Accumulation is per FIELD TYPE, which is where this parts from the original.
 * Tachikoma's `msg_sent` was the cumulative `$node->{counter}`, so its
 * latest-record-wins assignment was lossless; our MSGS_DELTA and
 * BYTES_READ_DELTA are per-sweep deltas that `drain_probe_window()` has already
 * re-baselined, so consecutive records PARTITION the work and the window's
 * truth is their SUM. DISTANCE (backlog bytes) and CACHE_SIZE (offsetlog
 * segment size) are levels, and keep the reference's latest-wins sampling.
 *
 * Wire: `Consumer topicprobe.p0 → Probe_To_Graphite → Graphite` (and/or
 * `→ Newspack_Log`). The reader id is sanitized `\W+ → _` for the metric
 * path, exactly as the original did.
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes;

\defined( 'ABSPATH' ) || exit;

/**
 * ProbeToGraphite node.
 */
class Probe_To_Graphite_Node extends Timer_Node {
	use Schema_Reflection;

	public const DEFAULT_INTERVAL_S = 15;
	public const DEFAULT_PREFIX     = 'nodes.topics';
	public const LINES_PER_MESSAGE  = 16;

	/** Metric fields emitted per reader, in Probe_Record positions. */
	private const FIELDS = [
		'distance'         => Probe_Record::DISTANCE,
		'msgs_delta'       => Probe_Record::MSGS_DELTA,
		'bytes_read_delta' => Probe_Record::BYTES_READ_DELTA,
		'cache_size'       => Probe_Record::CACHE_SIZE,
	];

	/** Fields that PARTITION work across sweeps: summed over the window, never sampled. */
	private const SUMMED = [ Probe_Record::MSGS_DELTA, Probe_Record::BYTES_READ_DELTA ];

	private string $prefix = self::DEFAULT_PREFIX;

	/** Emit cadence in seconds; 0 takes DEFAULT_INTERVAL_S. Positional 1. */
	private float $interval = self::DEFAULT_INTERVAL_S;

	/** @var array<string,array{record: array<int,int|string>,ts: float}> Latest record per reader. */
	private array $readers = [];

	/**
	 * `[ <prefix> <interval> ]` — defaults: [ `nodes.topics`, 15 ].
	 *
	 * @param list<string>|null $args
	 * @return list<string>
	 * @throws \InvalidArgumentException When the interval token isn't numeric.
	 */
	public function arguments( ?array $args = null ): array {
		if ( null === $args ) {
			return parent::arguments();
		}
		$this->parse_schema_args( $args );
		// A blank prefix is "not supplied"; the default only covers absent.
		$this->prefix  = '' !== $this->prefix ? $this->prefix : self::DEFAULT_PREFIX;
		$this->readers = [];
		// Tachikoma's `||=`: a ZERO token takes the default, not zero itself.
		$this->set_timer( $this->cadence_ms( $this->interval > 0.0 ? $this->interval : self::DEFAULT_INTERVAL_S ) );
		return $this->arguments;
	}

	public function fill( array $message ): void {
		if ( ! ( Core::as_int( $message[ Message::TYPE ], 0 ) & Message::TM_STRUCT ) ) {
			return;
		}
		$record = $message[ Message::VALUE ];
		if ( ! \is_array( $record ) ) {
			return;
		}
		/** @var array<int,int|string> $record */
		$reader = Core::str( $record[ Probe_Record::READER ] ?? null, '' );
		if ( '' === $reader ) {
			return;
		}
		$prior = $this->readers[ $reader ]['record'] ?? null;
		if ( \is_array( $prior ) ) {
			foreach ( self::SUMMED as $index ) {
				$record[ $index ] = Core::num_int( $prior[ $index ] ?? 0, 0 )
					+ Core::num_int( $record[ $index ] ?? 0, 0 );
			}
		}
		$this->readers[ $reader ] = [
			'record' => $record,
			'ts'     => Core::num_float( $message[ Message::TIMESTAMP ], Core::$now ),
		];
	}

	/**
	 * Format the accumulated readers into plaintext lines, emit them batched,
	 * clear the accumulator (each window reports what the probes said in it).
	 */
	public function fire(): void {
		$lines = [];
		foreach ( $this->readers as $reader => $entry ) {
			$path = \preg_replace( '/\W+/', '_', $reader );
			$ts   = (int) $entry['ts'];
			foreach ( self::FIELDS as $field => $index ) {
				$value   = Core::num_int( $entry['record'][ $index ] ?? 0, 0 );
				$lines[] = "{$this->prefix}.{$path}.{$field} {$value} {$ts}\n";
			}
		}
		$this->readers = [];
		foreach ( \array_chunk( $lines, self::LINES_PER_MESSAGE ) as $chunk ) {
			$response                       = Message::new_message();
			$response[ Message::TYPE ]      = Message::TM_BYTESTREAM;
			$response[ Message::TIMESTAMP ] = Core::$now;
			$response[ Message::VALUE ]     = \implode( '', $chunk );
			$this->stamp_message( $response, $this->name );
			parent::fill( $response );
		}
	}

	public static function node_schema(): array {
		return [
			'category'    => 'Transform',
			'description' => 'Formats topicprobe records into Graphite plaintext lines (Tachikoma TopicProbeToGraphite variant).',
			'arguments'   => [
				[ 'name' => 'prefix', 'type' => 'string', 'default' => self::DEFAULT_PREFIX, 'description' => 'Metric path prefix.' ],
				[ 'name' => 'interval', 'type' => 'float', 'default' => self::DEFAULT_INTERVAL_S, 'description' => 'Emit interval in seconds (numeric; 0 or empty takes the 15s default, floored at 1).' ],
			],
			'commands'    => [],
			'requests'    => [],
			'has_target'  => true,
		];
	}
}
