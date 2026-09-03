<?php
/**
 * Probe_To_Graphite: the formatter standing in front of the Graphite egress.
 *
 * It accumulates the `topicprobe.p0` records that arrive during one emit
 * window and, on each fire, renders them as the plaintext
 * `<prefix>.<reader>.<field> value timestamp` lines Graphite ingests — four
 * fields per reader: `distance`, `msgs_delta`, `bytes_read_delta` and
 * `cache_size`. The lines ship 16 to a TM_BYTESTREAM message and the
 * accumulator empties, so each window reports the probes that arrived inside
 * it and nothing else.
 *
 * A topology wires a Consumer of `topicprobe.p0` into this node, and this node
 * into `Graphite` for the UDP hop, into `Newspack_Log` to land the same lines
 * in the log, or into a `Tee` for both. It ports Tachikoma's
 * `TopicProbeToGraphite.pm` onto the substrate's positional `Probe_Record`,
 * and the reader id has every run of non-word characters replaced by an
 * underscore before it enters the metric path, as the original does.
 *
 * Accumulation is per FIELD TYPE, which is where this parts from the original.
 * Tachikoma's `msg_sent` is the cumulative node counter, so keeping the latest
 * record loses nothing there. MSGS_DELTA and BYTES_READ_DELTA are per-sweep
 * deltas that `Consumer_Node::probe_stats()` has already re-baselined, so
 * consecutive records PARTITION the work and the window's truth is their SUM;
 * keeping the latest would report one sweep out of however many the window
 * held. DISTANCE (backlog bytes) and CACHE_SIZE (offsetlog segment size) are
 * levels, and keep the reference's latest-wins sampling.
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes;

\defined( 'ABSPATH' ) || exit;

/**
 * Probe_To_Graphite node — `make_node Probe_To_Graphite <name> [prefix] [interval]`.
 */
class Probe_To_Graphite_Node extends Timer_Node {
	use Schema_Reflection;

	/** Emit cadence in seconds when the interval token is absent, blank or 0. */
	public const DEFAULT_INTERVAL_S = 15;

	/** Leading metric-path segment when the prefix token is absent or blank. */
	public const DEFAULT_PREFIX     = 'nodes.topics';

	/**
	 * Lines per emitted message, the batch size the original splices at. At the
	 * path lengths a reader id produces that keeps a VALUE near a kilobyte —
	 * inside the 4KB atomic-write cap a Log or Partition downstream writes
	 * under ([ADR-4](docs/architecture-decisions.md#adr-4-pipe_buf-atomic-writes)),
	 * and inside the one UDP datagram `Graphite_Node` sends per message.
	 */
	public const LINES_PER_MESSAGE  = 16;

	/** Metric fields emitted per reader: leaf name => the Probe_Record position it reads. */
	private const FIELDS = [
		'distance'         => Probe_Record::DISTANCE,
		'msgs_delta'       => Probe_Record::MSGS_DELTA,
		'bytes_read_delta' => Probe_Record::BYTES_READ_DELTA,
		'cache_size'       => Probe_Record::CACHE_SIZE,
	];

	/** Fields that PARTITION work across sweeps: summed over the window, never sampled. */
	private const SUMMED = [ Probe_Record::MSGS_DELTA, Probe_Record::BYTES_READ_DELTA ];

	/** Leading segment of every metric path, from the first positional argument. */
	private string $prefix = self::DEFAULT_PREFIX;

	/**
	 * Emit cadence in seconds, from the second positional argument.
	 * `cadence_ms()` floors it at one second, so a sub-second request rides the
	 * Router heartbeat instead of spinning an own event-loop slot.
	 */
	private float $interval = self::DEFAULT_INTERVAL_S;

	/**
	 * The open window, keyed by reader id: the record accumulated so far, and
	 * the TIMESTAMP of the newest probe folded into it, which is the instant
	 * every line for that reader carries.
	 *
	 * @var array<string,array{record:array<int,int|string>,ts:float}>
	 */
	private array $readers = [];

	/**
	 * Take `[ <prefix> <interval> ]` and arm the emit timer.
	 *
	 * Clearing the accumulator here keeps a window opened under the previous
	 * prefix and cadence from being emitted under the new ones, which would
	 * publish a window of one length at the path of another.
	 *
	 * @param list<string>|null $args Positional tokens; null reads the tokens in force.
	 * @return list<string> The tokens in force.
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

	/**
	 * Fold one probe record into the open window under its reader id.
	 *
	 * Only TM_STRUCT carries a record, so a bytestream line or a command reply
	 * is ignored rather than parsed, and so is a struct whose VALUE is not an
	 * array or whose READER slot is blank — an ephemeral reader has no
	 * offsetlog dir and writes that slot blank, so a blank id admitted here
	 * would merge every such reader into one series. The two SUMMED fields
	 * accumulate onto the prior record; every other slot takes the newest
	 * record's value.
	 *
	 * @param array<int,mixed> $message The 7-field positional message array.
	 */
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
	 * Render the window as plaintext lines, ship them batched, and empty the
	 * accumulator, so the next window starts from zero.
	 *
	 * Each line carries the timestamp of the newest probe folded in rather than
	 * the emit instant, so Graphite plots a sample at the moment it was taken.
	 * The batches are minted here, so this node stamps FROM with its own name,
	 * and they leave through `parent::fill()` rather than at the sink directly
	 * because that is what stamps `target` into an empty TO and counts them
	 * ([ADR-7](docs/architecture-decisions.md#adr-7-sink-vs-target-and-tofrom-replies)).
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

	/**
	 * Palette entry and argument form for the topology console. `has_target` is
	 * true because formatted lines are not a terminus: they need a Graphite, a
	 * Newspack_Log or a Tee downstream to reach anything.
	 *
	 * @return array<string,mixed>
	 */
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
