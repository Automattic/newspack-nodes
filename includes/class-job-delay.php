<?php
/**
 * Job Delay
 *
 * The delayed-jobs sweep. Jobs enqueued with `not_before`/`delay` park in a
 * single hardwired `jobdelay.p0` partition (the alerts.p0 precedent: low
 * volume, one dir, one reader). This sweep runs on the existing
 * `newspack_nodes/supervisor_periodic` tick: it drains the delay log with a
 * durable-cursor Consumer, delivers every due entry into the live jobintake
 * (delay fields stripped, partition key re-hashed), and circulates the
 * not-yet-due remainder back to the tail. The delay log is a circulating
 * buffer — restart-safe, no new storage, no new timers.
 *
 * Granularity = the supervisor tick (~15s). Delivery is at-least-once: a
 * crash between deliver/re-append and checkpoint re-plays that sweep's
 * entries, the same guarantee the rest of the substrate gives.
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes;

\defined( 'ABSPATH' ) || exit;

/**
 * Job Delay sweep.
 */
class Job_Delay {

	/** Reader id: names the sweep's Consumer + its durable offsetlog dir. */
	public const READER = 'jobdelay-sweep';

	/**
	 * Supervisor-tick entry point: sweep, never throw into the tick loop.
	 */
	public static function sweep_action(): void {
		try {
			self::sweep();
		} catch ( \Throwable $e ) {
			// phpcs:ignore WordPress.PHP.DevelopmentFunctions.error_log_error_log
			\error_log( 'Job_Delay::sweep failed: ' . $e->getMessage() );
		}
	}

	/**
	 * Drain jobdelay.p0 once: deliver due entries, circulate the rest.
	 *
	 * Ordering is the durability contract: held entries re-append BEFORE the
	 * checkpoint, so an abort anywhere replays this sweep (duplicates, never
	 * loss). Enqueuers may append mid-drain (shared log, hence multi-writer
	 * seal-grace); anything the drain misses is simply next tick's work. A
	 * delivery that throws (lock contention) is held and circulates instead
	 * of aborting the entries behind it. An entry that came due mid-sweep
	 * delivers on re-append (write_job routes by not_before).
	 *
	 * @param string|null $base_dir       Override base directory (tests); defaults to config.
	 * @param int|null    $num_partitions Override partition count (tests); defaults to config.
	 * @param float|null  $now            Due-ness clock (tests); defaults to the real clock.
	 * @return int Number of entries delivered into the live jobintake.
	 */
	public static function sweep( ?string $base_dir = null, ?int $num_partitions = null, ?float $now = null ): int {
		$base_dir  = \rtrim( $base_dir ?? Config::get_base_directory(), '/' );
		$delay_dir = "{$base_dir}/logs/" . Job_Intake::DELAY_BASENAME . '.p0';
		if ( ! \is_dir( $delay_dir ) ) {
			return 0;
		}
		$now       = $now ?? \microtime( true );
		$intake    = new Job_Intake( $base_dir, $num_partitions );
		$delivered = 0;
		$held      = [];

		$deliver = static function ( array $entry, array $options ) use ( $intake ): bool {
			$key = Core::as_string( $entry['key'] ?? '', '' );
			$id  = Core::as_string( $entry['id'] ?? '', '' );
			foreach ( [ 'retries', 'attempt' ] as $field ) {
				if ( isset( $entry[ $field ] ) ) {
					$options[ $field ] = Core::as_int( $entry[ $field ], 0 );
				}
			}
			$batch = Core::as_string( $entry['batch'] ?? '', '' );
			if ( '' !== $batch ) {
				$options['batch'] = $batch;
			}
			/** @var array<string, mixed> $parameters */
			$parameters = Core::arr( $entry['parameters'] ?? [], [] );
			/** @var array<string, mixed> $options */
			return $intake->write_job(
				Core::as_string( $entry['handler'] ?? '', '' ),
				$parameters,
				'' !== $key ? $key : null,
				'' !== $id ? $id : null,
				$options
			);
		};

		try {
			$consumer = new Consumer_Node();
			$consumer->name( self::READER );
			$consumer->sink(
				new Callback_Node(
					static function ( array $message ) use ( &$held, &$delivered, $deliver, $now ): void {
						if ( ! ( Core::as_int( $message[ Message::TYPE ], 0 ) & Message::TM_STRUCT ) ) {
							return; // drain()'s terminal TM_EOF.
						}
						$entry = $message[ Message::VALUE ];
						if ( ! \is_array( $entry ) || 'job' !== ( $entry['k'] ?? '' ) ) {
							return;
						}
						if ( Core::num_float( $entry['not_before'] ?? 0, 0.0 ) > $now ) {
							$held[] = $entry;
							return;
						}
						try {
							if ( $deliver( $entry, [] ) ) {
								++$delivered;
							} else {
								// Permanent; drop loud, don't circulate.
								Core::stderr( '[Nodes] JobDelay: dropped undeliverable due entry for handler: ' . Core::as_string( $entry['handler'] ?? '', '' ) );
							}
						} catch ( \RuntimeException $e ) {
							// Lock contention: circulate it.
							$held[] = $entry;
							Core::stderr( '[Nodes] JobDelay: delivery deferred (' . $e->getMessage() . ')' );
						}
					}
				)
			);
			try {
				$consumer->arguments( [ $delay_dir, "{$base_dir}/offsets/" . self::READER . '.p0' ] );
				$consumer->set_multi_writer( true );
				$consumer->drain();

				// Re-append precedes checkpoint: aborts dup, not drop.
				foreach ( $held as $entry ) {
					$not_before = Core::num_float( $entry['not_before'] ?? 0, 0.0 );
					if ( ! $deliver( $entry, $not_before > 0.0 ? [ 'not_before' => $not_before ] : [] ) ) {
						Core::stderr( '[Nodes] JobDelay: failed to circulate entry for handler: ' . Core::as_string( $entry['handler'] ?? '', '' ) );
					} elseif ( $not_before <= \microtime( true ) ) {
						++$delivered; // Came due mid-sweep; write_job routed it live.
					}
				}
				$consumer->checkpoint( true );
			} finally {
				$consumer->remove_node();
			}
		} finally {
			$intake->close();
		}

		return $delivered;
	}
}
