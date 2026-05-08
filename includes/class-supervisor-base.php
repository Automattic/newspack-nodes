<?php
/**
 * SupervisorBase: spawn coordination logic without I/O.
 *
 * Lift-adapted from event-logger's class-supervisor-base.php. Pure-data methods
 * so tests can drive without spawning real subprocesses.
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes;

\defined( 'ABSPATH' ) || exit;

class SupervisorBase {
	public const MIN_SPAWN_INTERVAL_S = 15;

	protected string $base_dir;
	/** @var array<string,float> Key: "{type}|{partition}", value: timestamp. */
	protected array $last_spawn_time = [];

	public function __construct( string $base_dir ) {
		$this->base_dir = \rtrim( $base_dir, '/' );
	}

	public function lock_path( string $type, int $partition ): string {
		return "{$this->base_dir}/locks/{$type}.p{$partition}.lock.d";
	}

	public function worker_needs_spawn( array $worker, float $now ): bool {
		$type      = $worker['type'];
		$partition = $worker['partition'];
		$stale     = $worker['stale_timeout'] ?? Lock::STALE_TIMEOUT;

		$dir = $this->lock_path( $type, $partition );
		if ( ! \is_dir( $dir ) ) {
			return true;
		}
		$hb    = "{$dir}/heartbeat";
		$mtime = @\filemtime( $hb );
		if ( $mtime === false ) {
			return true;
		}
		if ( ( $now - $mtime ) > $stale ) {
			return true;
		}
		return false;
	}

	public function record_spawn( string $type, int $partition, float $when ): void {
		$this->last_spawn_time[ "{$type}|{$partition}" ] = $when;
	}

	public function is_recently_spawned( string $type, int $partition, float $now ): bool {
		$key  = "{$type}|{$partition}";
		$last = $this->last_spawn_time[ $key ] ?? 0.0;
		return ( $now - $last ) < self::MIN_SPAWN_INTERVAL_S;
	}
}
