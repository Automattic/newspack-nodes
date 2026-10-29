<?php
/**
 * Job Delay
 *
 * The delayed-jobs sweep. A job whose `not_before` or `delay` puts it in the
 * future parks in the single hardwired `jobdelay.p0` partition — the alerts.p0
 * precedent: low volume, one directory, one reader. The sweep is a step of
 * the minute reconciliation pass, `Bootstrap::reconcile_fleet()`, draining the
 * delay log through `Delay_Node::circulate()`, delivering every due entry
 * into the live jobintake with its `not_before` stripped and its partition
 * key re-hashed, and circulating the not-yet-due remainder back to the tail.
 * Treating the delay log as a circulating buffer is what makes a delayed job
 * restart-safe while adding no storage and no timers.
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
	 * Seconds a due job whose delivery failed waits before the next try: one
	 * reconciliation pass, so the next sweep retries it.
	 */
	public const RETRY_AFTER_S = 60;

	/**
	 * Drain jobdelay.p0 once: deliver the due entries, circulate the rest.
	 *
	 * The drain-and-circulate loop is `Delay_Node::circulate()`, which owns the
	 * ordering contract; this sweep supplies what is job-specific, over a
	 * reader it builds for the pass and removes after it, because the cron pass
	 * has no long-lived process. A due entry is written into the live intake
	 * with its partition key re-hashed. One refused on lock contention
	 * (`Write_Lock_Held`) is held, and one whose delivery threw is held and its
	 * failure raised once the pass has committed, so the reconcile pass reports
	 * it while nothing is lost. A held entry re-appends through `write_job()`:
	 * a due one with a `not_before` RETRY_AFTER_S on, because a due job routes
	 * live, the path that just failed; any other with its own, so one that came
	 * due mid-sweep routes live, and parks RETRY_AFTER_S on when that live
	 * partition is locked. A re-append that meets a held lock on jobdelay.p0
	 * itself has nowhere to land, so the re-append stops there and the cursor
	 * commits just short of that entry: it, and every entry after it, is read
	 * again next sweep, which may deliver a job twice and never loses one, and
	 * the commit is graceful, so a lock held for many sweeps never climbs the
	 * reader into crawl. The intake closes before the cursor commits, landing
	 * every re-append on disk.
	 *
	 * The delay log and the live intake hang off the configured base directory,
	 * the intake takes the configured partition count, and the cursor and the
	 * quarantine resolve through `<config:offsets_dir>` and `<config:deadletter_dir>`.
	 * Enqueuers append from other processes mid-drain, so the reader takes the
	 * multi-writer seal grace.
	 *
	 * @param float|null $now Clock the hold-or-deliver decision reads, defaulting to
	 *                        `Core::right_now()` (tests); a re-append routes against
	 *                        the real clock whatever this says.
	 * @return int Entries delivered into the live jobintake, counting any that came due
	 *             mid-sweep. Zero when the delay dir does not exist yet.
	 * @throws Worker_Should_Stop When a cooperative stop reaches a delivery (ADR-14).
	 * @throws \RuntimeException From resolving the base directory, the reader's setup —
	 *                           a source or offsetlog path outside the runtime tree — a
	 *                           delivery that failed for any reason but contention, after
	 *                           its entry was re-parked, a re-append write, the reader's
	 *                           teardown or the intake's close.
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
		$reader    = new Consumer_Node();
		$delivered = 0;
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

		$route = static function ( array $message ) use ( $deliver, $now, &$delivered ): bool {
			$entry = Core::arr( $message[ Message::VALUE ] );
			if ( 'job' !== ( $entry['k'] ?? '' ) ) {
				return true;
			}
			if ( Core::num_float( $entry['not_before'] ?? 0, 0.0 ) > $now ) {
				return false;
			}
			try {
				if ( $deliver( $entry, [] ) ) {
					++$delivered;
				} else {
					// Permanent; drop loud, don't circulate.
					Core::stderr( '[Nodes] JobDelay: dropped undeliverable due entry for handler: ' . Core::as_string( $entry['handler'] ?? '', '' ) );
				}
			} catch ( Write_Lock_Held $e ) {
				Core::stderr( '[Nodes] JobDelay: delivery deferred (' . $e->getMessage() . ')' );
				return false;
			}
			return true;
		};

		$requeue = static function ( array $held ) use ( $deliver, $intake, $now, &$delivered ): int {
			$settled = 0;
			foreach ( $held as $message ) {
				$entry      = Core::arr( Core::arr( $message )[ Message::VALUE ] );
				$not_before = Core::num_float( $entry['not_before'] ?? 0, 0.0 );
				if ( $not_before <= $now ) {
					$not_before = Core::right_now() + self::RETRY_AFTER_S;
				}
				// Due by now, write_job's later clock routes it live too.
				$live = $not_before <= Core::right_now();
				try {
					$written = $deliver( $entry, [ 'not_before' => $not_before ] );
				} catch ( Write_Lock_Held $e ) {
					if ( ! $live ) {
						Core::stderr( '[Nodes] JobDelay: re-append deferred (' . $e->getMessage() . '); the sweep commits short of it' );
						break;
					}
					// Its live partition is locked: park it a retry on.
					$live = false;
					try {
						$written = $deliver( $entry, [ 'not_before' => Core::right_now() + self::RETRY_AFTER_S ] );
					} catch ( Write_Lock_Held $e ) {
						Core::stderr( '[Nodes] JobDelay: re-append deferred (' . $e->getMessage() . '); the sweep commits short of it' );
						break;
					}
				}
				if ( ! $written ) {
					Core::stderr( '[Nodes] JobDelay: failed to circulate entry for handler: ' . Core::as_string( $entry['handler'] ?? '', '' ) );
				} elseif ( $live ) {
					++$delivered; // Came due mid-sweep; write_job routed it live.
				}
				++$settled;
			}
			$intake->close();
			return $settled;
		};

		Worker_Should_Stop::raise(
			Worker_Should_Stop::attempt(
				static function () use ( $reader, $delay_dir, $route, $requeue, &$failed ): void {
					$name = self::READER . '.p0';
					$reader->name( self::READER );
					$reader->arguments(
						[
							$delay_dir,
							Core::resolve_config_token( 'config', 'offsets_dir', true ) . "/{$name}",
							Core::resolve_config_token( 'config', 'deadletter_dir', true ) . "/{$name}",
						]
					);
					$reader->set_multi_writer( true );
					$failed = Delay_Node::circulate( $reader, $route, $requeue );
				},
				$reader->remove_node( ... ),
				$intake->close( ... )
			)
		);
		Worker_Should_Stop::raise( $failed );

		return $delivered;
	}
}
