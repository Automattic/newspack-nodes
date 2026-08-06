<?php
/**
 * Canonical environment and fleet health report.
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes;

use Newspack_Nodes\Config_System\Restart_Planner;

\defined( 'ABSPATH' ) || exit;

/**
 * @phpstan-type HealthStatus 'good'|'recommended'|'critical'
 * @phpstan-type HealthResult array{id:string,label:string,status:HealthStatus,messages:list<string>}
 * @phpstan-type NormalizedAlert array{key:string,message:string,severity:string}
 */
final class Health_Checks {

	public const STATUS_GOOD        = 'good';
	public const STATUS_RECOMMENDED = 'recommended';
	public const STATUS_CRITICAL    = 'critical';

	public const CACHE_ID    = 'cache-backend';
	public const CACHE_LABEL = 'Cache backend';

	/** @var (\Closure(string): bool)|null */
	public static ?\Closure $remove_probe = null;

	/** @var (\Closure(): array<int,array<string,mixed>>)|null */
	public static ?\Closure $evaluate_alerts = null;

	private function __construct() {}

	/**
	 * Evaluate the ordered seven-result report.
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
			...$fleet,
		];
	}

	/** @return list<HealthResult> */
	private static function unavailable_fleet_results(): array {
		$message = 'Fleet state could not be evaluated because the runtime base directory is unavailable.';
		return [
			self::result( Alerts::FAMILY_WORKER_LIVENESS, 'Worker liveness', self::STATUS_RECOMMENDED, $message ),
			self::result( Alerts::FAMILY_CONSUMER_LAG, 'Consumer lag', self::STATUS_RECOMMENDED, $message ),
			self::result( Alerts::FAMILY_DEAD_LETTERS, 'Dead letters', self::STATUS_RECOMMENDED, $message ),
		];
	}

	/**
	 * @param HealthStatus $status Canonical result status.
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
	 * @param array<int,mixed> $alerts Alerts evaluator output.
	 * @return list<HealthResult>
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
	 * @param array<array-key,mixed> $alert Alert evaluator row.
	 */
	private static function required_alert_string( array $alert, string $field ): string {
		if ( ! \array_key_exists( $field, $alert ) || ! \is_string( $alert[ $field ] ) || '' === $alert[ $field ] ) {
			// phpcs:ignore WordPress.Security.EscapeOutput.ExceptionNotEscaped -- Plain-text internal contract diagnostic; presentation layers escape report content.
			throw new \UnexpectedValueException( "Health alert requires a non-empty string {$field}" );
		}
		return $alert[ $field ];
	}

	/**
	 * @param list<NormalizedAlert> $group Alerts in this result family.
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

	/** @return array<int,array<string,mixed>> */
	private static function current_alerts(): array {
		$evaluate = self::$evaluate_alerts ?? static fn (): array => Alerts::evaluate();
		return $evaluate();
	}

	/**
	 * Run an add/read/delete probe through the selected production backend.
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

	/** @return HealthResult */
	private static function cache_failure( string $name, string $operation ): array {
		return self::result(
			self::CACHE_ID,
			self::CACHE_LABEL,
			self::STATUS_CRITICAL,
			"Cache backend {$name} add/read/delete round trip failed during {$operation}; transient coordination, command sessions, and SSE slot leases are unreliable."
		);
	}

	/** @return HealthResult */
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

	/** @return HealthResult */
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

	/** @return HealthResult */
	private static function ownership_mismatch( string $path, int $owner, int $uid ): array {
		return self::result( 'ownership', 'Ownership', self::STATUS_CRITICAL, "Runtime directory {$path} is owned by uid {$owner}, but this process runs as uid {$uid}. Recover with: chown -R <webuser> {$path}" );
	}

	/**
	 * Housekeeping runs as an ordinary job on the `Job_Worker` pool, so an
	 * active fleet with no pool loses retention, orphan reaping, alert emission,
	 * the delayed-jobs sweep and every `newspack_nodes/periodic`
	 * subscriber — silently, while every other check stays green. Derived from
	 * the parsed graphs, never a topology name.
	 *
	 * @return HealthResult
	 */
	private static function housekeeping(): array {
		try {
			$active = Bootstrap::get_topologies();
			$pools  = Restart_Planner::topologies_for( [ 'Job_Worker' ] );
		} catch ( \Throwable $e ) {
			return self::result( 'housekeeping', 'Housekeeping', self::STATUS_RECOMMENDED, 'Housekeeping could not be evaluated: ' . $e->getMessage() );
		}
		if ( [] === $active ) {
			return self::result( 'housekeeping', 'Housekeeping', self::STATUS_GOOD, 'No topology is active, so there is nothing to keep house for.' );
		}
		if ( [] === $pools ) {
			return self::result(
				'housekeeping',
				'Housekeeping',
				self::STATUS_CRITICAL,
				'No active topology declares a Job_Worker, so housekeeping never runs: '
				. 'log retention, orphan partition/IPC reaping, alert emission, the delayed-jobs '
				. 'sweep and every newspack_nodes/periodic subscriber are all stopped. '
				. 'Recover with: wp nodes activate job-worker'
			);
		}
		return self::result( 'housekeeping', 'Housekeeping', self::STATUS_GOOD, 'Housekeeping runs on the job pool declared by: ' . \implode( ', ', $pools ) . '.' );
	}

	/**
	 * Return the worst canonical status in a report.
	 *
	 * @param list<array{status:string}> $results Report results, validated here.
	 * @return HealthStatus
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
