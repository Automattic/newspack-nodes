<?php
/**
 * ProbeToGraphite
 *
 * Modeled on Tachikoma's `TopicProbeToGraphite.pm` over the substrate's
 * positional Probe_Record: fill() accumulates the latest record per reader,
 * fire() formats `<prefix>.<reader>.<field> value ts` plaintext lines
 * (fields: distance, msgs_delta, bytes_read_delta, cache_size), batches
 * them 16 per TM_BYTESTREAM message to its sink, and clears state.
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
	public const LINES_PER_MESSAGE  = 16;

	/** Metric fields emitted per reader, in Probe_Record positions. */
	private const FIELDS = [
		'distance'         => Probe_Record::DISTANCE,
		'msgs_delta'       => Probe_Record::MSGS_DELTA,
		'bytes_read_delta' => Probe_Record::BYTES_READ_DELTA,
		'cache_size'       => Probe_Record::CACHE_SIZE,
	];

	private string $prefix = 'nodes.topics';

	/** @var array<string,array{record: array<int,int|string>,ts: float}> Latest record per reader. */
	private array $readers = [];

	/**
	 * `[ <prefix> <interval> ]` — defaults: [ `nodes.topics`, 15 ].
	 *
	 * @param list<string>|null $args
	 * @return list<string>
	 */
	public function arguments( ?array $args = null ): array {
		if ( null === $args ) {
			return parent::arguments();
		}
		$this->arguments = $args;
		$prefix          = Core::as_string( $args[0] ?? '', '' );
		$this->prefix    = '' !== $prefix ? $prefix : 'nodes.topics';
		$interval        = Core::num_float( $args[1] ?? 0, 0.0 );
		$interval        = $interval > 0 ? $interval : self::DEFAULT_INTERVAL_S;
		$this->readers   = [];
		$this->set_timer( (int) ( $interval * 1000 ) );
		return $args;
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
				[ 'name' => 'prefix', 'type' => 'string', 'default' => 'nodes.topics', 'description' => 'Metric path prefix.' ],
				[ 'name' => 'interval', 'type' => 'float', 'default' => self::DEFAULT_INTERVAL_S, 'description' => 'Emit interval in seconds.' ],
			],
			'commands'    => [],
			'requests'    => [],
			'has_target'  => true,
		];
	}
}
