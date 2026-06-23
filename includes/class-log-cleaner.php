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

		// Each bucket is already a `name => partition` map: its KEYS are the
		// declared dir names the sweep keeps, so it doubles as the membership set.
		if ( null !== $declared['logs'] && ! empty( $declared['logs'] ) ) {
			self::sweep( "{$base_dir}/logs", $declared['logs'], $base_dir, $deleted );
		}

		if ( null !== $declared['offsets'] && ! empty( $declared['offsets'] ) ) {
			self::sweep( "{$base_dir}/offsets", $declared['offsets'], $base_dir, $deleted );
		}

		return $deleted;
	}

	/**
	 * Single-pass declared-set collector. Resolves each config ROOT once and loops
	 * the operator's ACTIVE topology set (`Bootstrap::get_topologies()` — the same
	 * source the supervisor spawns from) once, filling both buckets UNIFORMLY. Driving
	 * retention off the active set rather than the on-disk `.tsl` glob means a
	 * superseded-but-shipped topology's logs AND offsetlogs are reclaimed once it's
	 * deactivated (no live worker's dirs are at risk — anything spawning is, by
	 * definition, in the active set). A `null` bucket is a fail-closed sentinel: its
	 * root is unresolvable, so the caller MUST skip that sweep (the producer union
	 * cannot mask it). The log bucket additionally unions the PHP-registered producers
	 * (firehose/jobintake × clamped config num_partitions) — substrate logs with no
	 * consumer-offset of their own, hence log-only.
	 *
	 * Each non-null bucket is a `concrete dir name => enumerated partition index`
	 * map (the partition comes from the resolver's enumeration loop, never parsed
	 * out of a name); the whitelisted non-.tsl logs are partition 0.
	 *
	 * @return array{logs: array<string,int>|null, offsets: array<string,int>|null}
	 */
	private static function declared_dirs(): array {
		$logs_root    = Core::resolve_config_token( 'config', 'logs_dir' );
		$offsets_root = Core::resolve_config_token( 'config', 'offsets_dir' );

		$logs    = [];
		$offsets = [];
		foreach ( \array_keys( Bootstrap::get_topologies() ) as $name ) {
			$resolved = Topology_Registry::resolved_resource_dirs( $name, Bootstrap::num_partitions_for( $name ) );
			foreach ( $resolved['logs'] as $dir => $partition ) {
				$logs[ $dir ] ??= $partition;
			}
			foreach ( $resolved['offsets'] as $dir => $partition ) {
				$offsets[ $dir ] ??= $partition;
			}
		}

		if ( '' !== $logs_root ) {
			foreach ( self::producer_log_dirs() as $dir => $partition ) {
				$logs[ $dir ] ??= $partition;
			}
			// The substrate's auto-mounted probe log (Worker_Base::mount_topic_probe)
			// is declared by no .tsl — whitelist it so the orphan sweep spares it.
			// Only ride along when a real declared set already exists: topicprobe
			// must not by itself flip the empty→non-empty fail-closed gate (which
			// skips the sweep before the app/topologies are registered).
			if ( ! empty( $logs ) ) {
				$logs[ Worker_Base::TOPICPROBE_LOG_DIR ] ??= 0;
				$logs[ Settings_Event_Writer::SETTINGS_LOG_DIR ] ??= 0;
			}
		}

		return [
			'logs'    => '' === $logs_root ? null : $logs,
			'offsets' => '' === $offsets_root ? null : $offsets,
		];
	}

	/**
	 * Concrete log dir names for the request-scope PHP producers: each
	 * `newspack_nodes/registered_log_producers` basename expanded over the
	 * clamped global config num_partitions in ELN's fixed `{producer}.p{N}`
	 * writer layout (exactly what Log_Manager / Job_Intake write). Shared by the
	 * GC's declared set and the Workers dashboard catalog so both read one source.
	 *
	 * @return array<string,int> `concrete dir name => enumerated partition index`.
	 */
	public static function producer_log_dirs(): array {
		$cfg_np = self::config_num_partitions();
		$dirs   = [];
		foreach ( self::registered_producers() as $producer ) {
			for ( $p = 0; $p < $cfg_np; $p++ ) {
				$dirs[ "{$producer}.p{$p}" ] = $p;
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

	/**
	 * Delete every first-level dir under `$dir` whose basename is not in `$declared`.
	 *
	 * Layout-agnostic: keep is by set-membership against the resolver's concrete
	 * dir names — no `.p{N}` regex. `GLOB_ONLYDIR` skips files (a Log's flat
	 * `{file}.{seg}` segments sit at the first level as files, not dirs).
	 *
	 * @param string             $dir      Directory to sweep (e.g. `{base}/logs`).
	 * @param array<string,int>  $declared `name => partition` map; membership is by KEY.
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
		return \array_keys( self::declared_dirs()['logs'] ?? [] );
	}

	/**
	 * Same declared LOG set as `declared_log_dirs()`, but as the
	 * `concrete dir name => enumerated partition index` map (the partition comes
	 * from the resolver's enumeration loop, never parsed out of a name). The
	 * dashboard catalog stamps each log entry with this real partition so it
	 * joins logs[] to consumers[] on `${name}#${partition}`. An unresolvable
	 * `<config:logs_dir>` root yields `[]` (same fail-closed behavior).
	 *
	 * @return array<string,int>
	 */
	public static function declared_log_partitions(): array {
		return self::declared_dirs()['logs'] ?? [];
	}
}
