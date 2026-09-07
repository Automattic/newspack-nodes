<?php
/**
 * Job Delay
 *
 * The delayed-jobs sweep. A job whose `not_before` or `delay` puts it in the
 * future parks in the single hardwired `jobdelay.p0` partition — the alerts.p0
 * precedent: low volume, one directory, one reader. The sweep rides the
 * existing `newspack_nodes/periodic` tick, draining the delay log with a
 * durable-cursor Consumer, delivering every due entry into the live jobintake
 * with its `not_before` stripped and its partition key re-hashed, and
 * circulating the not-yet-due remainder back to the tail. Treating the delay
 * log as a circulating buffer is what makes a delayed job restart-safe while
 * adding no storage and no timers.
 *
 * Granularity is the reconciliation pass, roughly sixty seconds, because that
 * is the one place `newspack_nodes/periodic` fires. Late is correct:
 * `not_before` means not before, so firing early is the bug. Delivery is
 * at-least-once — a crash between delivering an entry and committing the
 * cursor replays that sweep's entries, the same guarantee the rest of the
 * substrate gives.
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes;

\defined( 'ABSPATH' ) || exit;

/**
 * Job Delay sweep.
 *
 * Static throughout, carrying no state between passes: the durable cursor under
 * `offsets/` and the delay log itself hold everything one sweep hands the next,
 * so a sweep that dies mid-pass costs a replay and nothing else.
 */
class Job_Delay {

	/**
	 * Reader id: the sweep's Consumer takes it as a node name, and the durable
	 * cursor lives in `offsets/jobdelay-sweep.p0`. Renaming it hands the next
	 * sweep a fresh cursor at the head of the delay log, which re-delivers every
	 * entry still retained there.
	 */
	public const READER = 'jobdelay-sweep';

	/**
	 * Run one sweep from the `newspack_nodes/periodic` tick, reporting a failure
	 * instead of propagating it. The whole action fires inside a single
	 * `Bootstrap::reconcile_step()` catch, so a throw escaping here would cost
	 * every subscriber behind this one its turn on that tick.
	 */
	public static function sweep_action(): void {
		try {
			self::sweep();
		} catch ( \Throwable $e ) {
			Core::stderr( 'Job_Delay::sweep failed: ' . $e->getMessage() );
		}
	}

	/**
	 * Drain jobdelay.p0 once: deliver the due entries, circulate the rest.
	 *
	 * Ordering is the durability contract. Held entries re-append BEFORE the
	 * checkpoint, so an abort anywhere replays this sweep, which duplicates and
	 * never drops. Enqueuers may append mid-drain, so the Consumer reads the
	 * delay log as a multi-writer source and takes the seal grace; whatever the
	 * drain misses is next tick's work. A delivery that throws on lock
	 * contention is held and circulates rather than aborting the entries behind
	 * it. An entry that came due mid-sweep delivers on its re-append, because
	 * `Job_Intake::write_job()` routes by `not_before`.
	 *
	 * @param string|null $base_dir       Base directory (tests); defaults to the substrate config.
	 * @param int|null    $num_partitions Live-intake partition count (tests); defaults to the substrate config.
	 * @param float|null  $now            Clock the hold-or-deliver decision reads, defaulting to
	 *                                    `Core::right_now()` (tests); a re-append routes against
	 *                                    the real clock whatever this says.
	 * @return int Entries delivered into the live jobintake, counting any that came due
	 *             mid-sweep. Zero when the delay dir does not exist yet.
	 * @throws Worker_Should_Stop When a cooperative stop reaches a delivery (ADR-14).
	 * @throws \RuntimeException From outside the delivery catch: resolving the base
	 *                           directory, the Consumer's setup — a source or offsetlog
	 *                           path outside the runtime tree — or a re-append write. The
	 *                           checkpoint never runs, so the next sweep replays from the
	 *                           same cursor.
	 */
	public static function sweep( ?string $base_dir = null, ?int $num_partitions = null, ?float $now = null ): int {
		$base_dir  = \rtrim( $base_dir ?? Config::get_base_directory(), '/' );
		// Layout lives in Job_Intake's template; resolve it, don't rebuild.
		$delay_dir = Core::resolve_partition_template(
			Job_Intake::log_dir_templates( "{$base_dir}/logs" )[ Job_Intake::DELAY_BASENAME ],
			0
		);
		if ( ! \is_dir( $delay_dir ) ) {
			return 0;
		}
		$now       = $now ?? Core::right_now();
		$intake    = new Job_Intake( $base_dir, $num_partitions );
		$delivered = 0;
		$held      = [];

		$deliver = static function ( array $entry, array $options ) use ( $intake ): bool {
			$key = Core::as_string( $entry['key'] ?? '', '' );
			$id  = Core::as_string( $entry['id'] ?? '', '' );
			// Canonical list; `key` rides as an argument, not an option.
			foreach ( Job_Intake::DISPATCH_FIELDS as $field ) {
				if ( 'key' !== $field && isset( $entry[ $field ] ) ) {
					$options[ $field ] = $entry[ $field ];
				}
			}
			/** @var array<string,mixed> $parameters */
			$parameters = Core::arr( $entry['parameters'] ?? [], [] );
			/** @var array<string,mixed> $options */
			return $intake->write_job(
				Core::as_string( $entry['handler'] ?? '', '' ),
				'' !== $id ? $id : null,
				$parameters,
				'' !== $key ? $key : null,
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
						} catch ( Worker_Should_Stop $e ) {
							throw $e; // ADR-14: a cooperative stop is not a write failure.
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

				// Re-append, then checkpoint: an abort replays this sweep.
				foreach ( $held as $entry ) {
					$not_before = Core::num_float( $entry['not_before'] ?? 0, 0.0 );
					if ( ! $deliver( $entry, $not_before > 0.0 ? [ 'not_before' => $not_before ] : [] ) ) {
						Core::stderr( '[Nodes] JobDelay: failed to circulate entry for handler: ' . Core::as_string( $entry['handler'] ?? '', '' ) );
					} elseif ( $not_before <= Core::right_now() ) {
						++$delivered; // Came due mid-sweep; write_job routed it live.
					}
				}
				// Graceful: the drain ended at EOF, with nothing mid-attempt.
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
