<?php
/**
 * Alerts: the substrate's fleet-health evaluator.
 *
 * ONE place computes the operator-facing alert conditions — worker down,
 * consumer lag climbing, dead-letter growth — from the SAME snapshot
 * Workers_CI already builds (lock-dir heartbeats, the TopicProbe cursor log,
 * the on-disk quarantine dirs). It re-implements none of those reads.
 *
 * Three consumers of the result: WP Site Health tests + the admin notice call
 * the pure `evaluate()`; `emit()` journals each alert into the substrate's
 * `alerts.p0` partition (rate-limited) for delivery consumers and dashboards
 * to tail. Thresholds are Config_System settings, read live each invocation
 * (none of the three call sites holds them in memory across a worker's
 * lifetime).
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes;

use Newspack_Nodes\Rest\Workers_CI_Node;

\defined( 'ABSPATH' ) || exit;

class Alerts {

	/** A degraded condition an operator should look at. */
	public const SEVERITY_WARNING = 'warning';

	/** A worker/supervisor that was running has stopped — needs attention now. */
	public const SEVERITY_CRITICAL = 'critical';

	/** A previously journaled condition that is no longer present. */
	public const SEVERITY_RESOLVED = 'resolved';

	/** Transient gate name for emit()'s rate limit. */
	private const EMIT_GATE = 'newspack_nodes_alerts_emitted';

	/** Option holding the last-journaled state (alert key => severity). */
	private const STATE_OPTION = 'newspack_nodes_alerts_state';

	/** Journal dir basename; Log_Cleaner spares `{basename}.p{N}` via Bootstrap. */
	public const LOG_BASENAME = 'alerts';

	/** @var Partition_Node|null Process-cached anonymous alerts.p0 journal writer. */
	private static ?Partition_Node $journal = null;

	/**
	 * Compute the current alerts (pure — no side effects). Each alert is
	 * `{ key, severity, message, ... }`; `key` is stable per condition so a
	 * consumer can dedupe.
	 *
	 * @return array<int,array<string,mixed>>
	 */
	public static function evaluate(): array {
		$meta   = Workers_CI_Node::collect_dump_metadata();
		$alerts = [];

		foreach ( Core::arr( $meta['workers'] ?? [] ) as $worker ) {
			$alert = self::worker_alert( Core::arr( $worker ) );
			if ( null !== $alert ) {
				$alerts[] = $alert;
			}
		}

		$supervisor = Core::arr( $meta['supervisor'] ?? [] );
		// Never-heartbeated supervisor stays silent (cron not yet fired).
		if ( 'dead' === ( $supervisor['status'] ?? '' ) && null !== ( $supervisor['heartbeat_age'] ?? null ) ) {
			$age      = Core::as_int( $supervisor['heartbeat_age'] );
			$alerts[] = [
				'key'      => 'supervisor_down',
				'severity' => self::SEVERITY_CRITICAL,
				'message'  => "Supervisor stopped heartbeating {$age}s ago.",
			];
		}

		$lag_threshold = Core::num_int( Config::value( 'alert_lag_threshold' ) );
		foreach ( Core::arr( $meta['consumers'] ?? [] ) as $consumer ) {
			$consumer = Core::arr( $consumer );
			$distance = Core::num_int( $consumer['distance'] ?? 0 );
			if ( $distance <= $lag_threshold ) {
				continue;
			}
			$reader   = Core::as_string( $consumer['reader'] ?? '' );
			$source   = Core::as_string( $consumer['source'] ?? '' );
			$alerts[] = [
				'key'      => "consumer_lag:{$reader}",
				'severity' => self::SEVERITY_WARNING,
				'message'  => "Consumer {$reader} is {$distance} bytes behind on {$source}.",
				'reader'   => $reader,
				'distance' => $distance,
			];
		}

		$deadletter_threshold = Core::num_int( Config::value( 'alert_deadletter_threshold' ) );
		foreach ( Core::arr( $meta['deadletter_by_reader'] ?? [] ) as $reader => $count ) {
			$reader = Core::as_string( $reader );
			$count  = Core::as_int( $count );
			if ( $count <= $deadletter_threshold ) {
				continue;
			}
			$alerts[] = [
				'key'      => "deadletter:{$reader}",
				'severity' => self::SEVERITY_WARNING,
				'message'  => "{$count} dead-letter segment(s) quarantined for {$reader}; replay or clear them.",
				'reader'   => $reader,
				'count'    => $count,
			];
		}

		return $alerts;
	}

	/**
	 * Alert for one worker liveness row, or null when it's healthy. A dead
	 * worker that was previously alive (stale heartbeat) is critical; one that
	 * never started is a warning (it may still be spawning).
	 *
	 * @param array<array-key,mixed> $worker Liveness row from collect_dump_metadata.
	 * @return array<string,mixed>|null
	 */
	private static function worker_alert( array $worker ): ?array {
		if ( 'dead' !== ( $worker['status'] ?? '' ) ) {
			return null;
		}
		$type      = Core::as_string( $worker['type'] ?? '' );
		$partition = Core::as_int( $worker['partition'] ?? 0 );
		$label     = "{$type}.p{$partition}";
		if ( true === ( $worker['stale'] ?? false ) ) {
			$age = Core::as_int( $worker['heartbeat_age'] ?? 0 );
			return [
				'key'       => "worker_down:{$label}",
				'severity'  => self::SEVERITY_CRITICAL,
				'message'   => "Worker {$label} stopped heartbeating {$age}s ago.",
				'type'      => $type,
				'partition' => $partition,
			];
		}
		return [
			'key'       => "worker_missing:{$label}",
			'severity'  => self::SEVERITY_WARNING,
			'message'   => "Worker {$label} is not running.",
			'type'      => $type,
			'partition' => $partition,
		];
	}

	/**
	 * Worst severity across a list: critical if any critical, else warning if
	 * any warning, else '' (empty list / no alerts).
	 *
	 * @param array<int,array<string,mixed>> $alerts
	 */
	public static function worst_severity( array $alerts ): string {
		$worst = '';
		foreach ( $alerts as $alert ) {
			$severity = Core::as_string( $alert['severity'] ?? '' );
			if ( self::SEVERITY_CRITICAL === $severity ) {
				return self::SEVERITY_CRITICAL;
			}
			if ( self::SEVERITY_WARNING === $severity ) {
				$worst = self::SEVERITY_WARNING;
			}
		}
		return $worst;
	}

	/**
	 * Journal alert TRANSITIONS into `alerts.p0` — a row when a condition
	 * raises or changes severity, and a `resolved` row when it clears. A
	 * persisting condition journals nothing: the journal records state
	 * changes, not heartbeats. Hooked to the supervisor's periodic tick; the
	 * transient gate is a flap backstop (at most one batch per interval), and
	 * the last-journaled state advances only on a successful write, so a
	 * gated or failed tick reconciles on the next open window. Entries mirror
	 * the errors family (`{ n, k:'alert', m, ts }`) plus `severity`; KEY is
	 * the alert's stable key. The write is throw-guarded: a rotate-lock
	 * timeout or unwritable dir must never unwind the supervisor tick.
	 */
	public static function emit(): void {
		if ( \function_exists( 'get_transient' ) && \function_exists( 'set_transient' ) ) {
			// Best-effort throttle window, not content dedup (TOCTOU OK).
			if ( false !== \get_transient( self::EMIT_GATE ) ) {
				return;
			}
			\set_transient( self::EMIT_GATE, 1, Core::num_int( Config::value( 'alert_emit_interval' ) ) );
		}
		$current = [];
		foreach ( self::evaluate() as $alert ) {
			$current[ Core::as_string( $alert['key'] ?? '' ) ] = $alert;
		}
		$last = \function_exists( 'get_option' ) ? Core::arr( \get_option( self::STATE_OPTION, [] ) ) : [];

		$rows = [];
		foreach ( $current as $key => $alert ) {
			$severity = Core::as_string( $alert['severity'] ?? '' );
			if ( ( $last[ $key ] ?? null ) !== $severity ) {
				$rows[ $key ] = [
					'm'        => Core::as_string( $alert['message'] ?? '' ),
					'severity' => $severity,
				];
			}
		}
		foreach ( \array_keys( $last ) as $key ) {
			if ( ! isset( $current[ $key ] ) ) {
				$rows[ $key ] = [
					'm'        => "resolved: {$key}",
					'severity' => self::SEVERITY_RESOLVED,
				];
			}
		}
		if ( [] === $rows ) {
			return;
		}
		try {
			$journal = self::journal();
			// Real clock: the supervisor loop never refreshes Core::$now.
			$ts = \microtime( true );
			foreach ( $rows as $key => $row ) {
				$message                       = Message::new_message();
				$message[ Message::TYPE ]      = Message::TM_STRUCT;
				$message[ Message::FROM ]      = 'alerts';
				$message[ Message::TIMESTAMP ] = $ts;
				$message[ Message::KEY ]       = (string) $key;
				$message[ Message::VALUE ]     = [
					'n'        => 1,
					'k'        => 'alert',
					'm'        => $row['m'],
					'ts'       => $ts,
					'severity' => $row['severity'],
				];
				$journal->fill( $message );
			}
			$journal->flush();
			// Advance only after a durable write; failures retry next window.
			if ( \function_exists( 'update_option' ) ) {
				\update_option(
					self::STATE_OPTION,
					\array_map(
						static fn ( array $alert ): string => Core::as_string( $alert['severity'] ?? '' ),
						$current
					),
					false
				);
			}
		} catch ( \Throwable $e ) {
			// phpcs:ignore WordPress.PHP.DevelopmentFunctions.error_log_error_log
			\error_log( 'Alerts::emit journal write failed: ' . $e->getMessage() );
		}
	}

	/**
	 * Build (once) the anonymous `alerts.p0` Partition. Path argument ONLY:
	 * geometry comes from the schema's `<config:*>` defaults — the same source
	 * ELN's `alerts:partition` TSL line resolves, so both writers on this dir
	 * agree by construction. Never pass geometry literals here or in TSL.
	 */
	private static function journal(): Partition_Node {
		if ( null !== self::$journal ) {
			return self::$journal;
		}
		$partition = new Partition_Node();
		$partition->arguments( [ Config::get_logs_directory() . '/' . self::LOG_BASENAME . '.p0' ] );
		self::$journal = $partition;
		return $partition;
	}

	/**
	 * Drop the cached writer. Only tests need this — the process-lifetime cache
	 * is correct in production (the logs dir is stable).
	 *
	 * @api Used by tests.
	 */
	public static function reset(): void {
		self::$journal?->remove_node();
		self::$journal = null;
	}
}
