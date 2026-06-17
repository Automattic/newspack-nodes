<?php
/**
 * Log_Cleaner: log-only GC for orphan flat-layout data dirs.
 *
 * Sweeps first-level `logs/*` and `offsets/*` dirs against a config-declared set
 * (topology .tsl declarations resolved layout-agnostically + PHP-registered
 * producers). The declared set is built by substituting the `<partition>` token
 * (wherever it sits in a declared path) over 0..N-1, so there is no `.p{N}`
 * regex. Liveness-free: it does NOT read worker locks, lock dirs, ipc dirs, or
 * live-worker descriptors — worker/topology lifecycle (the "orange") lives in
 * Supervisor.
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes;

\defined( 'ABSPATH' ) || exit;

class Log_Cleaner {

	/**
	 * Remove first-level `logs/*` + `offsets/*` dirs not in the config-declared set.
	 *
	 * Two independent fail-closed gates protect live data:
	 *  - If the `<config:logs_dir>` / `<config:offsets_dir>` ROOT can't resolve ('',
	 *    e.g. the token namespace isn't registered in this context), that sweep is
	 *    skipped — regardless of the producer union. Otherwise the topology dirs would
	 *    be absent from the declared set while the producer names kept it non-empty,
	 *    and the sweep would delete every topology dir (mass data loss).
	 *  - If a root resolves but its declared set is still empty (app not loaded), that
	 *    sweep is skipped rather than wiping live data.
	 *
	 * @param string $base_dir Base data directory.
	 * @return array<int,string> Absolute paths of the directories removed.
	 */
	public static function cleanup_orphan_partitions( string $base_dir ): array {
		$base_dir = \rtrim( $base_dir, '/' );
		$deleted  = [];

		$declared = self::declared_dirs();

		if ( null !== $declared['logs'] && ! empty( $declared['logs'] ) ) {
			self::sweep( "{$base_dir}/logs", \array_flip( $declared['logs'] ), $base_dir, $deleted );
		}

		if ( null !== $declared['offsets'] && ! empty( $declared['offsets'] ) ) {
			self::sweep( "{$base_dir}/offsets", \array_flip( $declared['offsets'] ), $base_dir, $deleted );
		}

		return $deleted;
	}

	/**
	 * Single-pass declared-set collector. Resolves each config ROOT once and loops
	 * `Topology_Registry::list()` once, filling both buckets. A `null` bucket is a
	 * fail-closed sentinel: its root is unresolvable, so the caller MUST skip that
	 * sweep (the producer union cannot mask it). The log bucket additionally unions
	 * the PHP-registered producers (firehose/jobintake × clamped config num_partitions).
	 *
	 * @return array{logs: array<int,string>|null, offsets: array<int,string>|null}
	 */
	private static function declared_dirs(): array {
		$logs_root    = Core::resolve_config_token( 'config', 'logs_dir' );
		$offsets_root = Core::resolve_config_token( 'config', 'offsets_dir' );

		$logs    = [];
		$offsets = [];
		foreach ( Topology_Registry::list() as $name ) {
			$resolved = Topology_Registry::resolved_resource_dirs( $name, Bootstrap::num_partitions_for( $name ) );
			foreach ( $resolved['logs'] as $dir ) {
				$logs[ $dir ] = true;
			}
			foreach ( $resolved['offsets'] as $dir ) {
				$offsets[ $dir ] = true;
			}
		}

		if ( '' !== $logs_root ) {
			foreach ( self::producer_log_dirs() as $dir ) {
				$logs[ $dir ] = true;
			}
		}

		return [
			'logs'    => '' === $logs_root ? null : \array_keys( $logs ),
			'offsets' => '' === $offsets_root ? null : \array_keys( $offsets ),
		];
	}

	/**
	 * Delete every first-level dir under `$dir` whose basename is not in `$declared`.
	 *
	 * Layout-agnostic: keep is by set-membership against the resolver's concrete
	 * dir names — no `.p{N}` regex. `GLOB_ONLYDIR` skips files (a Log's flat
	 * `{file}.{seg}` segments sit at the first level as files, not dirs).
	 *
	 * @param string             $dir      Directory to sweep (e.g. `{base}/logs`).
	 * @param array<string,int>  $declared Declared dir names flipped to a set.
	 * @param string             $base_dir Jail root for delete_directory_recursive.
	 * @param array<int,string>  $deleted  Accumulator, appended in place when a dir is gone.
	 */
	private static function sweep( string $dir, array $declared, string $base_dir, array &$deleted ): void {
		foreach ( @\glob( "{$dir}/*", \GLOB_ONLYDIR ) ?: [] as $path ) {
			if ( isset( $declared[ \basename( $path ) ] ) ) {
				continue;
			}
			Supervisor_Base::delete_directory_recursive( $path, $base_dir );
			if ( ! \is_dir( $path ) ) {
				$deleted[] = $path;
			}
		}
	}

	/**
	 * Declared LOG dir names: every on-disk topology's resolved first-level log
	 * dirs (`Topology_Registry::resolved_resource_dirs`, layout-agnostic — the
	 * `<partition>` token may sit anywhere in the path), expanded over its
	 * SPAWN-aligned partition count (`Bootstrap::num_partitions_for`), unioned
	 * with each PHP-registered producer (`newspack_nodes/registered_log_producers`)
	 * expanded over the global config num_partitions in ELN's fixed `{producer}.p{N}`
	 * writer layout. An unresolvable `<config:logs_dir>` root yields `[]` (the GC
	 * fail-closes; the diagnostic verb shows nothing declared).
	 *
	 * @return array<int,string>
	 */
	public static function declared_log_dirs(): array {
		return self::declared_dirs()['logs'] ?? [];
	}

	/**
	 * Concrete log dir names for the request-scope PHP producers: each
	 * `newspack_nodes/registered_log_producers` basename expanded over the
	 * clamped global config num_partitions in ELN's fixed `{producer}.p{N}`
	 * writer layout (exactly what Log_Manager / Job_Intake write). Shared by the
	 * GC's declared set and the Workers dashboard catalog so both read one source.
	 *
	 * @return array<int,string>
	 */
	public static function producer_log_dirs(): array {
		$cfg_np = self::config_num_partitions();
		$dirs   = [];
		foreach ( self::registered_producers() as $producer ) {
			for ( $p = 0; $p < $cfg_np; $p++ ) {
				$dirs[] = "{$producer}.p{$p}";
			}
		}
		return $dirs;
	}

	/** Global config num_partitions, clamped [1, MAX_PARTITIONS] (mirrors Bootstrap::num_partitions_for). */
	private static function config_num_partitions(): int {
		$cfg = Config::load_config();
		$raw = $cfg['num_partitions'] ?? 1;
		return \max( 1, \min( Supervisor_Base::MAX_PARTITIONS, (int) ( \is_scalar( $raw ) ? $raw : 1 ) ) );
	}

	/**
	 * Non-empty string producer basenames from the registration filter.
	 *
	 * @return array<int,string>
	 */
	private static function registered_producers(): array {
		$producers = \apply_filters( 'newspack_nodes/registered_log_producers', [] );
		if ( ! \is_array( $producers ) ) {
			return [];
		}
		$out = [];
		foreach ( $producers as $producer ) {
			if ( \is_string( $producer ) && '' !== $producer ) {
				$out[ $producer ] = true;
			}
		}
		return \array_keys( $out );
	}
}
