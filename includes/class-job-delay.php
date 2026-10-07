<?php
/**
 * Job Delay
 *
 * The delayed-jobs sweep. A job whose `not_before` or `delay` puts it in the
 * future parks in the single hardwired `jobdelay.p0` partition — the alerts.p0
 * precedent: low volume, one directory, one reader. The sweep is a step of
 * the minute reconciliation pass, `Bootstrap::reconcile_fleet()`, draining the
 * delay log with a durable-cursor Consumer, delivering every due entry into
 * the live jobintake with its `not_before` stripped and its partition key
 * re-hashed, and circulating the not-yet-due remainder back to the tail. Treating the delay
 * log as a circulating buffer is what makes a delayed job restart-safe while
 * adding no storage and no timers.
 *
 * Granularity is the reconciliation pass, roughly sixty seconds. Late is correct:
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
	 * Reader id: the sweep's Consumer takes it as a node name, the durable
	 * cursor lives in `offsets/jobdelay-sweep.p0`, and a line that will not
	 * unpack is quarantined in `deadletter/jobdelay-sweep.p0`. That Consumer
	 * exists only for the length of one reconciliation pass, so no `dl_*` verb
	 * can reach its quarantine: the dead-letters alert family reports the
	 * segment, and `wp nodes ingest` replays its packed records through a topic.
	 * Renaming it hands the next sweep a fresh cursor at the head of the delay
	 * log, which re-delivers every entry still retained there.
	 */
	public const READER = 'jobdelay-sweep';

	/**
	 * Drain jobdelay.p0 once: deliver the due entries, circulate the rest.
	 *
	 * Ordering is the durability contract. Held entries re-append BEFORE the
	 * checkpoint, so an abort anywhere replays this sweep, which duplicates and
	 * never drops. Enqueuers may append mid-drain, so the Consumer reads the
	 * delay log as a multi-writer source and takes the seal grace; whatever the
	 * drain misses is next tick's work. A line that will not unpack — a torn
	 * append — is dead-lettered to the sweep's quarantine and the drain moves
	 * past it (ADR-12), so one bad line never stalls the entries behind it.
	 * A delivery refused on lock contention (`Write_Lock_Held`) is held and
	 * circulates rather than aborting the entries behind it. Every other
	 * delivery failure is caught in the sink rather than thrown into the
	 * Consumer, whose quarantine would dead-letter the entry on sight and file a
	 * transient intake failure as poison. The drain runs on, and everything
	 * caught is raised once it ends, ahead of the re-append and the checkpoint,
	 * so the next sweep replays from the same cursor. An entry that came due
	 * mid-sweep delivers on its re-append, because `Job_Intake::write_job()`
	 * routes by `not_before`. The Consumer's teardown and the intake's close run
	 * whatever the drain threw, and every failure escapes combined.
	 *
	 * The delay log and the live intake hang off the configured base directory,
	 * the intake takes the configured partition count, and the cursor and the
	 * quarantine resolve through `<config:offsets_dir>` and `<config:deadletter_dir>`.
	 *
	 * @param float|null $now Clock the hold-or-deliver decision reads, defaulting to
	 *                        `Core::right_now()` (tests); a re-append routes against
	 *                        the real clock whatever this says.
	 * @return int Entries delivered into the live jobintake, counting any that came due
	 *             mid-sweep. Zero when the delay dir does not exist yet.
	 * @throws Worker_Should_Stop When a cooperative stop reaches a delivery (ADR-14).
	 * @throws \RuntimeException From resolving the base directory, the Consumer's setup —
	 *                           a source or offsetlog path outside the runtime tree — a
	 *                           delivery that fails for any reason but contention, a
	 *                           re-append write, the Consumer's teardown or the intake's
	 *                           close. The checkpoint never runs past a drain failure, so
	 *                           the next sweep replays from the same cursor.
	 */
	public static function sweep( ?float $now = null ): int {
		$base_dir  = \rtrim( Config::get_base_directory(), '/' );
		// Layout lives in Job_Intake's template; resolve it, don't rebuild.
		$delay_dir = Core::resolve_partition_template(
			Job_Intake::log_dir_templates( Log_Discovery::root( $base_dir, 'logs' ) )[ Job_Intake::DELAY_BASENAME ],
			0
		);
		if ( ! \is_dir( $delay_dir ) ) {
			return 0;
		}
		$now       = $now ?? Core::right_now();
		$intake    = new Job_Intake();
		$delivered = 0;
		$held      = [];
		$failed    = [];

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

		$consumer = new Consumer_Node();
		$consumer->name( self::READER );
		$consumer->sink(
			new Callback_Node(
				static function ( array $message ) use ( &$held, &$delivered, &$failed, $deliver, $now ): void {
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
					} catch ( Write_Lock_Held $e ) {
						$held[] = $entry;
						Core::stderr( '[Nodes] JobDelay: delivery deferred (' . $e->getMessage() . ')' );
					} catch ( Worker_Should_Stop $e ) {
						Worker_Should_Stop::raise( [ ...$failed, $e ] );
					} catch ( \Throwable $e ) {
						// Raised after the drain, never quarantined.
						$failed[] = $e;
					}
				}
			)
		);

		Worker_Should_Stop::raise(
			Worker_Should_Stop::attempt(
				static function () use ( $consumer, $delay_dir, $deliver, &$held, &$delivered, &$failed ): void {
					$reader = self::READER . '.p0';
					$consumer->arguments(
						[
							$delay_dir,
							Core::resolve_config_token( 'config', 'offsets_dir', true ) . "/{$reader}",
							Core::resolve_config_token( 'config', 'deadletter_dir', true ) . "/{$reader}",
						]
					);
					$consumer->set_multi_writer( true );
					$consumer->drain();
					Worker_Should_Stop::raise( $failed );

					// Re-append, then checkpoint: an abort replays this sweep.
					foreach ( $held as $entry ) {
						$not_before = Core::num_float( $entry['not_before'] ?? 0, 0.0 );
						if ( ! $deliver( $entry, $not_before > 0.0 ? [ 'not_before' => $not_before ] : [] ) ) {
							Core::stderr( '[Nodes] JobDelay: failed to circulate entry for handler: ' . Core::as_string( $entry['handler'] ?? '', '' ) );
						} elseif ( $not_before <= Core::right_now() ) {
							++$delivered; // Came due mid-sweep; write_job routed it live.
						}
					}
					// Graceful: the drain ended at EOF, nothing mid-attempt.
					$consumer->checkpoint( true );
				},
				$consumer->remove_node( ... ),
				$intake->close( ... )
			)
		);

		return $delivered;
	}
}
