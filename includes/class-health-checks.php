<?php
/**
 * Canonical environment and fleet health report — the one evaluator behind both
 * the Site Health test and `wp nodes doctor`.
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes;

\defined( 'ABSPATH' ) || exit;

/**
 * The environment and fleet report: cache backend, runtime filesystem,
 * ownership, housekeeping cron and configuration keys, followed by the three
 * alert families.
 *
 * Declaring a check here is what keeps the two surfaces in sync. Site Health's
 * `direct` test and `wp nodes doctor` both render whatever `evaluate()`
 * returns, so neither can carry a check the other lacks, and the three statuses
 * are WordPress Site Health's own vocabulary, reaching it unchanged.
 *
 * A check that cannot answer says so in its own result instead of throwing. An
 * unresolvable base directory or an unreadable config file costs one line;
 * throwing would cost the operator the whole report, and the cache, filesystem
 * and ownership findings are what diagnose the rest.
 *
 * @phpstan-type HealthStatus 'good'|'recommended'|'critical'
 * @phpstan-type HealthResult array{id:string,label:string,status:HealthStatus,messages:list<string>}
 * @phpstan-type NormalizedAlert array{key:string,message:string,severity:string}
 */
final class Health_Checks {

	/** Nothing to act on. */
	public const STATUS_GOOD = 'good';

	/** Worth attention; the fleet still runs. */
	public const STATUS_RECOMMENDED = 'recommended';

	/** Broken now: workers cannot run, or shared state is unreliable. */
	public const STATUS_CRITICAL = 'critical';

	/**
	 * Result id of the cache-backend check. `Health_Probe_Client` refuses a
	 * loopback result that does not carry this id and this label, so a response
	 * from anything but this check can never stand in for a local probe.
	 */
	public const CACHE_ID = 'cache-backend';

	/** Label of the cache-backend check, validated alongside `CACHE_ID`. */
	public const CACHE_LABEL = 'Cache backend';

	/**
	 * Probe-removal seam. Lazily-defaulted at the call site to a closure calling
	 * `unlink()`. Tests reassign it to refuse the removal, so the writability
	 * check, the real write probe and the message formatting around it run as
	 * production code rather than being mocked away.
	 *
	 * Signature: `function ( string $path ): bool`.
	 *
	 * @var (\Closure(string): bool)|null
	 */
	public static ?\Closure $remove_probe = null;

	/**
	 * Alerts-evaluation seam. Lazily-defaulted at the call site to a closure
	 * calling `Alerts::evaluate()`. Tests reassign it to feed fixed alert rows,
	 * malformed ones included, and to count calls — which is how the skip on an
	 * unresolved base directory is proved.
	 *
	 * Signature: `function (): array<int,array<string,mixed>>`.
	 *
	 * @var (\Closure(): array<int,array<string,mixed>>)|null
	 */
	public static ?\Closure $evaluate_alerts = null;

	/** Never instantiated: every entry point is static. */
	private function __construct() {}

	/**
	 * Evaluate the ordered health report: eight results, plus `fleet-hold`
	 * while a deploy hold stands, plus `other-alerts` when an alert declares a
	 * family this class does not bucket.
	 *
	 * The base directory resolves once here, and its refusal is caught rather
	 * than propagated: `filesystem()` and `ownership()` are the two checks that
	 * can explain it, and ownership needs the configured path the validation
	 * rejected. When it does not resolve, the alerts evaluator is skipped — it
	 * computes every condition from lock-dir heartbeats, the probe cursor log
	 * and the quarantine dirs, all of which live under that base — and the three
	 * fleet families report that instead.
	 *
	 * `wp nodes doctor` passes the web runtime's cache result over the loopback,
	 * because a CLI process sees a different cache posture than the process
	 * serving requests.
	 *
	 * @param HealthResult|null $cache_result Validated remote cache result, or null for a local probe.
	 * @return list<HealthResult>
	 */
	public static function evaluate( ?array $cache_result = null ): array {
		$configured = '';
		$base_dir   = null;
		$refused    = '';
		try {
			$configured = Config::configured_base_directory();
			$base_dir   = Config::get_base_directory();
		} catch ( \RuntimeException $e ) {
			$refused = $e->getMessage();
		}

		$fleet = null === $base_dir
			? self::unavailable_fleet_results()
			: self::fleet_results( self::current_alerts() );
		return [
			$cache_result ?? self::cache_backend(),
			self::filesystem( $base_dir, $refused ),
			self::ownership( $base_dir, $configured, $refused ),
			self::housekeeping(),
			self::config_keys(),
			...self::fleet_hold(),
			...$fleet,
		];
	}

	/**
	 * The deploy hold, when one is standing. Absent otherwise: this is a
	 * reminder, not a permanent status line — and the failure mode it guards is
	 * a forgotten `wp nodes start`, which the age makes obvious.
	 *
	 * @return list<HealthResult>
	 */
	private static function fleet_hold(): array {
		$since = Spawn_Coordinator::hold();
		if ( $since <= 0 ) {
			return [];
		}
		$age = CLI::format_duration( \max( 0, \time() - $since ) );
		return [
			self::result(
				'fleet-hold',
				'Fleet hold',
				self::STATUS_RECOMMENDED,
				"The fleet has been held for {$age} and no workers will spawn. "
					. 'Run `wp nodes start` to release it.'
			),
		];
	}

	/**
	 * Config keys the runtime ignored.
	 *
	 * The deploy copies the operator's own file over the shipped path, so a key
	 * renamed in `Settings_Schema` leaves a stale entry there. It is ignored
	 * rather than fatal — this is where it becomes visible, since the value the
	 * operator set is silently not in effect.
	 *
	 * @return HealthResult
	 */
	private static function config_keys(): array {
		try {
			$unknown = Config::unrecognized_keys();
		} catch ( \Throwable $e ) {
			return self::result( 'config-keys', 'Configuration keys', self::STATUS_RECOMMENDED, 'Configuration could not be read: ' . $e->getMessage() );
		}
		if ( [] === $unknown ) {
			return self::result( 'config-keys', 'Configuration keys', self::STATUS_GOOD, 'Every key in newspack-nodes-config.php is declared by the settings schema.' );
		}
		return self::result(
			'config-keys',
			'Configuration keys',
			self::STATUS_CRITICAL,
			'newspack-nodes-config.php sets key(s) no longer declared by the settings schema, so the '
			. 'value you set is NOT in effect: ' . \implode( ', ', $unknown ) . '. Remove them, or '
			. 'rename each to its current key.'
		);
	}

	/**
	 * Report whether the reconciliation cron event is scheduled, once any
	 * topology is active.
	 *
	 * Housekeeping rides `Bootstrap::reconcile_fleet()` on the minute cron, so a
	 * missing `newspack_nodes/reconcile` event loses retention, orphan reaping,
	 * alert emission, the delayed-jobs sweep and every `newspack_nodes/periodic`
	 * subscriber — silently, while every other check stays green. The same event
	 * is the cold-start revival tier, and a veto is easy to miss because a
	 * short-circuited schedule is silent.
	 *
	 * @return HealthResult
	 */
	private static function housekeeping(): array {
		try {
			$active = Bootstrap::get_topologies();
		} catch ( \Throwable $e ) {
			return self::result( 'housekeeping', 'Housekeeping', self::STATUS_RECOMMENDED, 'Housekeeping could not be evaluated: ' . $e->getMessage() );
		}
		if ( [] === $active ) {
			return self::result( 'housekeeping', 'Housekeeping', self::STATUS_GOOD, 'No topology is active, so there is nothing to keep house for.' );
		}
		$next = \function_exists( 'wp_next_scheduled' ) ? \wp_next_scheduled( Bootstrap::CRON_EVENT ) : false;
		if ( ! $next ) {
			return self::result(
				'housekeeping',
				'Housekeeping',
				self::STATUS_CRITICAL,
				'The ' . Bootstrap::CRON_EVENT . ' cron event is not scheduled, so nothing runs the '
				. 'reconciliation pass: log retention, orphan partition/IPC reaping, alert emission, '
				. 'the delayed-jobs sweep, every newspack_nodes/periodic subscriber and cold-start '
				. 'worker revival are all stopped. Recover with: wp cron event schedule '
				. Bootstrap::CRON_EVENT . ' now ' . Bootstrap::CRON_SCHEDULE
			);
		}
		return self::result( 'housekeeping', 'Housekeeping', self::STATUS_GOOD, 'The reconciliation pass is scheduled; next run ' . \gmdate( 'Y-m-d H:i:s', $next ) . ' UTC.' );
	}

	/**
	 * Compare the runtime directory's owner against this process's effective
	 * uid — the mismatch that leaves one process unable to write into the lock
	 * and IPC directories another uid created.
	 *
	 * A refused base directory is inspected too, at the configured path: an
	 * owner mismatch is the likeliest cause of that refusal, and naming it beats
	 * repeating the refusal message. Where posix is absent the uid reads -1 and
	 * the answer is `recommended`, because unverifiable is not the same as
	 * wrong.
	 *
	 * @param string|null $base_dir   Validated base directory, or null when it refused to resolve.
	 * @param string      $configured Configured base path, unvalidated.
	 * @param string      $refused    Refusal message, or '' when the base directory resolved.
	 * @return HealthResult
	 */
	private static function ownership( ?string $base_dir, string $configured, string $refused ): array {
		$path = $base_dir ?? $configured;
		if ( '' === $path || ! \is_dir( $path ) ) {
			return self::result( 'ownership', 'Ownership', self::STATUS_CRITICAL, 'Runtime-directory ownership cannot be trusted because the configured base directory did not resolve.' );
		}
		$uid   = CLI::uid();
		$owner = \fileowner( $path );
		if ( null === $base_dir ) {
			if ( 0 <= $uid && false !== $owner && $owner !== $uid ) {
				return self::ownership_mismatch( $path, $owner, $uid );
			}
			return self::result( 'ownership', 'Ownership', self::STATUS_CRITICAL, "Runtime-directory ownership could not make the configured path usable: {$refused}" );
		}
		if ( $uid < 0 || false === $owner ) {
			return self::result( 'ownership', 'Ownership', self::STATUS_RECOMMENDED, "Runtime-directory ownership for {$path} could not be verified on this platform." );
		}
		if ( $owner !== $uid ) {
			return self::ownership_mismatch( $path, $owner, $uid );
		}
		return self::result( 'ownership', 'Ownership', self::STATUS_GOOD, "Runtime directory {$path} is owned by this process's uid {$uid}." );
	}

	/**
	 * The mismatch result, shared by the refused-base and validated-base
	 * branches so that both name the same `chown` recovery.
	 *
	 * @param string $path  Runtime directory inspected.
	 * @param int    $owner Uid owning that directory.
	 * @param int    $uid   Effective uid of this process.
	 * @return HealthResult
	 */
	private static function ownership_mismatch( string $path, int $owner, int $uid ): array {
		return self::result( 'ownership', 'Ownership', self::STATUS_CRITICAL, "Runtime directory {$path} is owned by uid {$owner}, but this process runs as uid {$uid}. Recover with: chown -R <webuser> {$path}" );
	}

	/**
	 * Prove the runtime base directory takes a write and gives it back:
	 * `is_writable()`, then a real write and a real remove.
	 *
	 * The permission bits are not the answer a worker needs. A full filesystem
	 * passes `is_writable()` and still refuses the write, and a directory that
	 * accepts writes but refuses removals grows until partitions stall. Random
	 * bytes in the probe name keep two reports running at once from deleting
	 * each other's file.
	 *
	 * @param string|null $base_dir Validated base directory, or null when it refused to resolve.
	 * @param string      $refused  Refusal message, or '' when the base directory resolved.
	 * @return HealthResult
	 */
	private static function filesystem( ?string $base_dir, string $refused ): array {
		if ( null === $base_dir ) {
			$message = '' === $refused ? 'Runtime base directory could not be resolved.' : $refused;
			return self::result( 'filesystem', 'Filesystem', self::STATUS_CRITICAL, $message . ' Workers cannot write partitions, locks, or IPC.' );
		}
		// phpcs:ignore WordPressVIPMinimum.Functions.RestrictedFunctions.file_ops_is_writable -- Health check targets the operator-selected runtime directory, not WP-managed storage.
		if ( ! \is_writable( $base_dir ) ) {
			return self::result( 'filesystem', 'Filesystem', self::STATUS_CRITICAL, "Runtime directory {$base_dir} is not writable. Workers cannot write partitions, locks, or IPC." );
		}

		$probe = $base_dir . '/.health-probe-' . \bin2hex( \random_bytes( 8 ) );
		// phpcs:ignore WordPressVIPMinimum.Functions.RestrictedFunctions.file_ops_file_put_contents -- Actual health probe in the operator-selected runtime directory.
		if ( false === \file_put_contents( $probe, 'newspack-nodes-health' ) ) {
			return self::result( 'filesystem', 'Filesystem', self::STATUS_CRITICAL, "Runtime directory {$base_dir} refused the write probe. Workers cannot write partitions, locks, or IPC." );
		}
		// phpcs:ignore WordPressVIPMinimum.Functions.RestrictedFunctions.file_ops_unlink -- Removes the probe from the operator-selected runtime directory.
		$remove = self::$remove_probe ?? static fn ( string $path ): bool => \unlink( $path );
		if ( ! $remove( $probe ) ) {
			return self::result( 'filesystem', 'Filesystem', self::STATUS_CRITICAL, "Runtime directory {$base_dir} accepted the write probe but the probe could not be removed." );
		}
		return self::result( 'filesystem', 'Filesystem', self::STATUS_GOOD, "Runtime directory {$base_dir} accepted a write/remove probe." );
	}

	/**
	 * Run an add/read/delete probe through the selected production backend.
	 *
	 * `shared_first()` is the tier the cross-process surfaces resolve — transient
	 * coordination, command sessions and SSE slot leases — so the probe measures
	 * the posture those depend on rather than one nothing reads. `add()` is the
	 * write, and it doubles as proof the key was absent; the `finally` deletes
	 * whatever the round trip left behind, and the 30-second expiry retires the
	 * key even when deleting is what failed.
	 *
	 * Public because the health-cache REST route returns this result on its own,
	 * which is how `wp nodes doctor` learns what the request-serving process
	 * sees.
	 *
	 * @return HealthResult
	 */
	public static function cache_backend(): array {
		$backend = Cache_Backend::shared_first();
		if ( null === $backend ) {
			return self::result(
				self::CACHE_ID,
				self::CACHE_LABEL,
				self::STATUS_CRITICAL,
				'No cache backend is available; transient coordination, command sessions, and SSE slot leases cannot be shared.'
			);
		}

		$name  = 'memcached' === $backend->backend_name() ? 'Memcached' : 'APCu';
		$key   = 'newspack_nodes_health_' . \bin2hex( \random_bytes( 16 ) );
		$value = \bin2hex( \random_bytes( 16 ) );
		if ( ! $backend->add( $key, $value, 30 ) ) {
			return self::cache_failure( $name, 'add' );
		}

		$deleted = false;
		try {
			$read = $backend->read( $key );
			if ( Cache_Backend::READ_HIT !== $read['status'] || $value !== $read['value'] ) {
				return self::cache_failure( $name, 'read' );
			}
			$deleted = $backend->delete( $key );
			if ( ! $deleted ) {
				return self::cache_failure( $name, 'delete' );
			}
			return self::result(
				self::CACHE_ID,
				self::CACHE_LABEL,
				self::STATUS_GOOD,
				"Cache backend {$name} add/read/delete round trip succeeded."
			);
		} finally {
			if ( ! $deleted ) {
				$backend->delete( $key );
			}
		}
	}

	/**
	 * The failed-round-trip result, shared by the three probe stages.
	 *
	 * @param string $name      Backend name for the message: `Memcached` or `APCu`.
	 * @param string $operation Stage that failed: `add`, `read` or `delete`.
	 * @return HealthResult
	 */
	private static function cache_failure( string $name, string $operation ): array {
		return self::result(
			self::CACHE_ID,
			self::CACHE_LABEL,
			self::STATUS_CRITICAL,
			"Cache backend {$name} add/read/delete round trip failed during {$operation}; transient coordination, command sessions, and SSE slot leases are unreliable."
		);
	}

	/**
	 * The alert rows for this report, read through the seam.
	 *
	 * @return array<int,array<string,mixed>>
	 */
	private static function current_alerts(): array {
		$evaluate = self::$evaluate_alerts ?? static fn (): array => Alerts::evaluate();
		return $evaluate();
	}

	/**
	 * Bucket the alert rows by the family each declares, then turn every bucket
	 * into one result.
	 *
	 * A row missing `key`, `message` or `severity`, or declaring a severity
	 * outside warning and critical, throws: severity is what picks the result's
	 * status, so an unrecognized one would quietly demote a critical fleet
	 * condition to a recommendation. An unrecognized family decides nothing but
	 * which bucket the row lands in, so it falls through to `other-alerts`.
	 *
	 * @param array<int,mixed> $alerts Alerts evaluator output, validated here.
	 * @return list<HealthResult>
	 * @throws \UnexpectedValueException When a row is not an array, omits a required field, or declares a severity outside the two Alerts mints.
	 */
	private static function fleet_results( array $alerts ): array {
		$groups = [
			Alerts::FAMILY_WORKER_LIVENESS     => [],
			Alerts::FAMILY_CONSUMER_LAG        => [],
			Alerts::FAMILY_DEAD_LETTERS        => [],
			'other-alerts'                     => [],
		];
		foreach ( $alerts as $alert ) {
			if ( ! \is_array( $alert ) ) {
				throw new \UnexpectedValueException( 'Health alert must be an array' );
			}
			$key        = self::required_alert_string( $alert, 'key' );
			$message    = self::required_alert_string( $alert, 'message' );
			$severity   = self::required_alert_string( $alert, 'severity' );
			if ( ! \in_array( $severity, [ Alerts::SEVERITY_WARNING, Alerts::SEVERITY_CRITICAL ], true ) ) {
				// phpcs:ignore WordPress.Security.EscapeOutput.ExceptionNotEscaped -- Plain-text internal contract diagnostic; presentation layers escape report content.
				throw new \UnexpectedValueException( "Health alert {$key} has an invalid severity" );
			}
			$normalized = [
				'key'      => $key,
				'message'  => $message,
				'severity' => $severity,
			];
			// @longform Bucket on the family Alerts declares. An unrecognized
			// one surfaces under 'other' and is never thrown: this runs as a WP
			// `direct` Site Health test and under `wp nodes doctor`, so a throw
			// would lose the cache, filesystem and ownership results too:
			// the whole report, because one alert kind was new.
			$group_id = self::required_alert_string( $alert, 'family' );
			if ( ! isset( $groups[ $group_id ] ) ) {
				$group_id = 'other-alerts';
			}
			$groups[ $group_id ][] = $normalized;
		}
		$results = [
			self::alert_result( Alerts::FAMILY_WORKER_LIVENESS, 'Worker liveness', $groups[ Alerts::FAMILY_WORKER_LIVENESS ], 'All configured workers are running.' ),
			self::alert_result( Alerts::FAMILY_CONSUMER_LAG, 'Consumer lag', $groups[ Alerts::FAMILY_CONSUMER_LAG ], 'All consumers are within the configured lag threshold.' ),
			self::alert_result( Alerts::FAMILY_DEAD_LETTERS, 'Dead letters', $groups[ Alerts::FAMILY_DEAD_LETTERS ], 'No reader exceeds the configured dead-letter threshold.' ),
		];
		// Only when a row arrived that no family claimed.
		if ( [] !== $groups['other-alerts'] ) {
			$results[] = self::alert_failures( 'other-alerts', 'Other alerts', $groups['other-alerts'] );
		}
		return $results;
	}

	/**
	 * One family's result: the healthy line when nothing alerted, the failures
	 * otherwise.
	 *
	 * @param string                $id      Result id, which is the family name.
	 * @param string                $label   Label for the family.
	 * @param list<NormalizedAlert> $group   Alerts in this result family.
	 * @param string                $healthy Message carried when the family is empty.
	 * @return HealthResult
	 */
	private static function alert_result( string $id, string $label, array $group, string $healthy ): array {
		return [] === $group
			? self::result( $id, $label, self::STATUS_GOOD, $healthy )
			: self::alert_failures( $id, $label, $group );
	}

	/**
	 * Report a family that HAS alerts. Split from `alert_result()` so the
	 * unrecognized-family row, which is only built when it has rows, does not
	 * have to pass a healthy message that could never be reached.
	 *
	 * @param string                          $id    Result id.
	 * @param string                          $label Label for the family.
	 * @param array<int,array<string,string>> $group Non-empty alert rows.
	 * @return HealthResult
	 */
	private static function alert_failures( string $id, string $label, array $group ): array {
		$status = Alerts::SEVERITY_CRITICAL === Alerts::worst_severity( $group )
			? self::STATUS_CRITICAL
			: self::STATUS_RECOMMENDED;
		return [
			'id'       => $id,
			'label'    => $label,
			'status'   => $status,
			'messages' => \array_column( $group, 'message' ),
		];
	}

	/**
	 * Read one required string field off an alert row.
	 *
	 * Empty counts as missing: an empty key, message or severity would travel
	 * into the report as a blank line no operator can act on.
	 *
	 * @param array<array-key,mixed> $alert Alert evaluator row.
	 * @param string                 $field Field to read.
	 * @return string The non-empty field value.
	 * @throws \UnexpectedValueException When the field is absent, not a string, or empty.
	 */
	private static function required_alert_string( array $alert, string $field ): string {
		if ( ! \array_key_exists( $field, $alert ) || ! \is_string( $alert[ $field ] ) || '' === $alert[ $field ] ) {
			// phpcs:ignore WordPress.Security.EscapeOutput.ExceptionNotEscaped -- Plain-text internal contract diagnostic; presentation layers escape report content.
			throw new \UnexpectedValueException( "Health alert requires a non-empty string {$field}" );
		}
		return $alert[ $field ];
	}

	/**
	 * The three fleet families reported unevaluated, for a base directory that
	 * did not resolve.
	 *
	 * `recommended`, not `critical`: the filesystem and ownership results
	 * already carry that failure, and these three say only that fleet state is
	 * unknown.
	 *
	 * @return list<HealthResult>
	 */
	private static function unavailable_fleet_results(): array {
		$message = 'Fleet state could not be evaluated because the runtime base directory is unavailable.';
		return [
			self::result( Alerts::FAMILY_WORKER_LIVENESS, 'Worker liveness', self::STATUS_RECOMMENDED, $message ),
			self::result( Alerts::FAMILY_CONSUMER_LAG, 'Consumer lag', self::STATUS_RECOMMENDED, $message ),
			self::result( Alerts::FAMILY_DEAD_LETTERS, 'Dead letters', self::STATUS_RECOMMENDED, $message ),
		];
	}

	/**
	 * Build a single-message result. Every check composes through it, so the
	 * result shape is stated once.
	 *
	 * @param string       $id      Result id, stable across reports.
	 * @param string       $label   Label rendered beside the status.
	 * @param HealthStatus $status  Canonical result status.
	 * @param string       $message The one message.
	 * @return HealthResult
	 */
	private static function result( string $id, string $label, string $status, string $message ): array {
		return [
			'id'       => $id,
			'label'    => $label,
			'status'   => $status,
			'messages' => [ $message ],
		];
	}

	/**
	 * Return the worst canonical status in a report.
	 *
	 * An unknown status throws here rather than reaching Site Health, whose
	 * renderer `match`es the three canonical values and would fatal on a fourth
	 * without naming the result that carried it.
	 *
	 * @param list<array{status:string}> $results Report results, validated here.
	 * @return HealthStatus
	 * @throws \UnexpectedValueException When a result carries a status outside the three constants.
	 */
	public static function worst_status( array $results ): string {
		$worst = self::STATUS_GOOD;
		foreach ( $results as $result ) {
			$status = $result['status'];
			if ( self::STATUS_CRITICAL === $status ) {
				return self::STATUS_CRITICAL;
			}
			if ( self::STATUS_RECOMMENDED === $status ) {
				$worst = self::STATUS_RECOMMENDED;
			} elseif ( self::STATUS_GOOD !== $status ) {
				throw new \UnexpectedValueException( 'Unknown health status' );
			}
		}
		return $worst;
	}
}
