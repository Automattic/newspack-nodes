<?php
/**
 * Alerts: the substrate's fleet-health evaluator and journal.
 *
 * ONE place computes the operator-facing alert conditions — worker down,
 * consumer lag climbing, dead-letter growth — from the SAME snapshot
 * Workers_CI already builds (lock-dir heartbeats, the Topic_Probe cursor log,
 * the on-disk quarantine dirs). It re-implements none of those reads.
 *
 * Site Health and the admin notice call the read-only `evaluate()`. The fleet's
 * periodic sweep calls `emit()`, which journals each transition into the
 * substrate's `alerts.p0` partition for delivery consumers and dashboards to
 * tail; a producer outside that sweep — Job_Worker's batch completion — writes
 * its row through `journal_event()`. Thresholds are Config_System settings read
 * live on every call, so raising one takes effect without restarting a worker.
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes;

use Newspack_Nodes\Rest\Workers_CI_Node;

\defined( 'ABSPATH' ) || exit;

/**
 * Fleet-health alerts: `evaluate()` reads the conditions, `emit()` journals the
 * transitions between them.
 *
 * Every row this class mints declares a `family` and a `severity` from the
 * constants below. `Health_Checks::fleet_results()` buckets by family — the
 * value doubles as the Site Health result id — and refuses a row declaring
 * none, so the taxonomy is stated once at mint time instead of reconstructed
 * from the `key` prefix in a second file.
 */
class Alerts {

	/** A configured worker is not running: it never started, or it stopped heartbeating. */
	public const FAMILY_WORKER_LIVENESS = 'worker-liveness';

	/** A consumer trails its source by more than `alert_lag_threshold` bytes. */
	public const FAMILY_CONSUMER_LAG = 'consumer-lag';

	/** Quarantined segments for one reader exceed `alert_deadletter_threshold`. */
	public const FAMILY_DEAD_LETTERS = 'dead-letters';

	/** Attention, not urgency: consumer lag, dead letters, a worker that never started. */
	public const SEVERITY_WARNING = 'warning';

	/** A worker that was running has stopped — needs attention now. */
	public const SEVERITY_CRITICAL = 'critical';

	/**
	 * A previously journaled condition that has cleared. Journal-only:
	 * `evaluate()` never mints one, and `Health_Checks` refuses the severity.
	 */
	public const SEVERITY_RESOLVED = 'resolved';

	/** Transient gate holding emit() to one journal batch per `alert_emit_interval`. */
	private const EMIT_GATE = 'newspack_nodes_alerts_emitted';

	/**
	 * Option holding the last-journaled severity per alert key. Diffing the
	 * current evaluation against it is what makes a transition; without it every
	 * sweep re-journals conditions that have not changed.
	 */
	private const STATE_OPTION = 'newspack_nodes_alerts_state';

	/** Journal dir basename; `log_dir_template()` appends the `.p0` partition. */
	public const LOG_BASENAME = 'alerts';

	/** @var Partition_Node|null Process-cached anonymous alerts.p0 journal writer. */
	private static ?Partition_Node $journal = null;

	/**
	 * Journal alert TRANSITIONS into `alerts.p0` — a row when a condition
	 * raises or changes severity, and a `resolved` row when it clears. A
	 * persisting condition journals nothing: the journal records state
	 * changes, not heartbeats. Hooked to the fleet's periodic sweep, and silent
	 * while a deploy hold stands. The transient gate is a flap backstop (at most
	 * one batch per `alert_emit_interval`), and the last-journaled state
	 * advances only on a successful write, so a gated or failed tick reconciles
	 * on the next open window. Entries mirror the errors family
	 * (`{ n, k:'alert', m, ts }`) plus `severity`; KEY is the alert's stable
	 * key. The write is throw-guarded: a rotate-lock timeout or unwritable dir
	 * must never unwind the sweep.
	 */
	public static function emit(): void {
		// Held: a partial evaluate() would journal false `resolved:` rows.
		if ( self::fleet_is_held() ) {
			return;
		}
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
			foreach ( $rows as $key => $row ) {
				self::journal_event( (string) $key, $row['m'], $row['severity'] );
			}
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
			Core::stderr( 'Alerts::emit journal write failed: ' . $e->getMessage() );
		}
	}

	/**
	 * Journal one row into alerts.p0 — the errors-family entry shape plus
	 * `severity`, KEY = a stable per-condition key so consumers can dedupe.
	 * Used by emit()'s transition rows and by non-fleet event producers
	 * (Job_Worker batch completion). Throws on write failure; callers own
	 * the swallow-or-not decision.
	 *
	 * @api Cross-class journal entry point.
	 * @param string $key      Stable condition key (e.g. `batch:{id}`).
	 * @param string $text     Human-readable one-liner (short by construction; PIPE_BUF-safe).
	 * @param string $severity One of the SEVERITY_* constants.
	 */
	public static function journal_event( string $key, string $text, string $severity ): void {
		// Fresh read: a caller outside the drain may hold a frozen Core::$now.
		$ts                            = Core::right_now();
		$message                       = Message::new_message();
		$message[ Message::TYPE ]      = Message::TM_STRUCT;
		$message[ Message::FROM ]      = 'alerts';
		$message[ Message::TIMESTAMP ] = $ts;
		$message[ Message::KEY ]       = $key;
		$message[ Message::VALUE ]     = [
			'n'        => 1,
			'k'        => 'alert',
			'm'        => $text,
			'ts'       => $ts,
			'severity' => $severity,
		];
		$journal                       = self::journal();
		$journal->fill( $message );
		$journal->flush();
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
		$partition->arguments( [ self::log_dir_template( Config::get_logs_directory() ) ] );
		self::$journal = $partition;
		return $partition;
	}

	/**
	 * Dir template for the alerts journal — the one place its layout is written.
	 * Bootstrap registers it with the log GC and `journal()` writes through it.
	 * No partition token: every worker on the fleet journals into the same
	 * `alerts.p0`, so the GC declares that one dir rather than a fan-out of
	 * `alerts.p1`+ nothing ever writes.
	 *
	 * @param string $logs_dir Resolved logs directory, or the `<config:logs_dir>` token when registration must not touch the filesystem.
	 */
	public static function log_dir_template( string $logs_dir = '<config:logs_dir>' ): string {
		return \rtrim( $logs_dir, '/' ) . '/' . self::LOG_BASENAME . '.p0';
	}

	/**
	 * Compute the current alerts. Reads only — the journal and the state option
	 * belong to `emit()`. Each row is `{ key, family, severity, message, ... }`,
	 * where `key` is stable per condition so a consumer can dedupe and the tail
	 * carries the per-family detail: `reader` + `distance` for lag, `reader` +
	 * `count` for dead letters, `type` + `partition` for a worker.
	 *
	 * @return array<int,array<string,mixed>>
	 */
	public static function evaluate(): array {
		// Held suppresses only what the STOP caused; dead letters predate it.
		$held   = self::fleet_is_held();
		$meta   = Workers_CI_Node::collect_dump_metadata();
		$alerts = [];

		foreach ( $held ? [] : Core::arr( $meta['workers'] ?? [] ) as $worker ) {
			$alert = self::worker_alert( Core::arr( $worker ) );
			if ( null !== $alert ) {
				$alerts[] = $alert;
			}
		}

		$lag_threshold = Core::num_int( Config::value( 'alert_lag_threshold' ) );
		foreach ( $held ? [] : Core::arr( $meta['consumers'] ?? [] ) as $consumer ) {
			$consumer = Core::arr( $consumer );
			$distance = Core::num_int( $consumer['distance'] ?? 0 );
			if ( $distance <= $lag_threshold ) {
				continue;
			}
			$reader   = Core::as_string( $consumer['reader'] ?? '' );
			$source   = Core::as_string( $consumer['source'] ?? '' );
			$alerts[] = [
				'key'      => "consumer_lag:{$reader}",
				'family'   => self::FAMILY_CONSUMER_LAG,
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
				'family'   => self::FAMILY_DEAD_LETTERS,
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
		// An on-demand worker with nothing to do is the feature working.
		if ( true === ( $worker['idle'] ?? false ) ) {
			return null;
		}
		$type      = Core::as_string( $worker['type'] ?? '' );
		$partition = Core::as_int( $worker['partition'] ?? 0 );
		$label     = "{$type}.p{$partition}";
		if ( true === ( $worker['stale'] ?? false ) ) {
			$age = Core::as_int( $worker['heartbeat_age'] ?? 0 );
			return [
				'key'       => "worker_down:{$label}",
				'family'    => self::FAMILY_WORKER_LIVENESS,
				'severity'  => self::SEVERITY_CRITICAL,
				'message'   => "Worker {$label} stopped heartbeating {$age}s ago.",
				'type'      => $type,
				'partition' => $partition,
			];
		}
		return [
			'key'       => "worker_missing:{$label}",
			'family'    => self::FAMILY_WORKER_LIVENESS,
			'severity'  => self::SEVERITY_WARNING,
			'message'   => "Worker {$label} is not running.",
			'type'      => $type,
			'partition' => $partition,
		];
	}

	/** Whether an operator is holding the fleet down for a deploy. */
	private static function fleet_is_held(): bool {
		return Spawn_Coordinator::hold() > 0;
	}

	/**
	 * Worst severity across a list: critical if any critical, else warning if
	 * any warning, else '' (empty list / no alerts).
	 *
	 * @param array<int,array<string,mixed>> $alerts Alert rows carrying a `severity`.
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
