<?php
/**
 * Log_Cleaner: log-only GC for orphan flat-layout data dirs.
 *
 * Sweeps first-level `logs/*` and `offsets/*` dirs against a config-declared set
 * (topology .tsl declarations + PHP-registered producers, both stating their own
 * layout as a path template). The declared set is built by substituting the
 * `<partition>` token — wherever it sits in a declared path — over 0..N-1, so
 * there is no `.p{N}` regex and no layout this class spells itself.
 *
 * Liveness-free: it reads no worker lock, lock dir, ipc dir or live-worker
 * descriptor. A dir survives because config declares it, never because a
 * process holds it; worker and topology lifecycle — lock-dir reconcile,
 * orphan-ipc reaping — belongs to Fleet_Node and Spawn_Coordinator.
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes;

\defined( 'ABSPATH' ) || exit;

/**
 * Builds the declared set, then deletes the first-level data dirs missing from
 * it. `Bootstrap::reconcile_fleet()` sweeps on the minute WP-Cron pass and
 * `wp nodes gc` sweeps on demand, while `Workers_CI_Node` builds both the
 * dashboard log catalog and its `cleanup_status` diagnostic from the same
 * declared set — so what the dashboard lists and what the GC spares cannot
 * drift.
 *
 * Deletion is irreversible and a skipped sweep costs only disk, so every
 * degraded input fails CLOSED: a declared set that cannot be built completely
 * comes back as `null` and skips its sweep, rather than being swept against a
 * partial set in which live dirs read as orphans.
 */
class Log_Cleaner {

	/** Undeclared dirs younger than this (newest inner mtime) are spared. */
	public const DELETE_GRACE_S = 3600;

	/**
	 * Remove first-level `logs/*` + `offsets/*` dirs not in the config-declared set.
	 *
	 * A bucket is swept only when it is both non-null and non-empty. `null` marks
	 * a degraded declared set — an unresolvable `<config:logs_dir>` /
	 * `<config:offsets_dir>` root, an active topology that will not resolve, an
	 * unreadable `.tsl`, or a producer template declaring no dir under the logs
	 * root — and nothing else in the union can mask it: an unresolvable logs root
	 * leaves the producer names holding the set non-empty while every topology dir
	 * is absent from it, so the sweep would delete them all. Empty means the app
	 * has not loaded its topologies yet, which is equally no reason to delete.
	 *
	 * @param string $base_dir Base data directory.
	 * @param int    $grace    Seconds of quiet an undeclared dir needs before it is
	 *                         swept; 0 sweeps it however recently it was written.
	 * @return array<int,string> Absolute paths of the directories removed.
	 */
	public static function cleanup_orphan_partitions( string $base_dir, int $grace = self::DELETE_GRACE_S ): array {
		$base_dir = \rtrim( $base_dir, '/' );
		$deleted  = [];

		$declared = self::declared_dirs();

		// Each bucket's KEYS are the declared dir names to keep (membership).
		if ( null !== $declared['logs'] && ! empty( $declared['logs'] ) ) {
			self::sweep( "{$base_dir}/logs", $declared['logs'], $base_dir, $deleted, $grace );
		}

		if ( null !== $declared['offsets'] && ! empty( $declared['offsets'] ) ) {
			self::sweep( "{$base_dir}/offsets", $declared['offsets'], $base_dir, $deleted, $grace );
		}

		return $deleted;
	}

	/**
	 * Delete every first-level dir under `$dir` whose basename is not in `$declared`.
	 *
	 * Keeping is set-membership on the concrete dir names the resolver produced,
	 * so this method spells no layout of its own. `GLOB_ONLYDIR` skips files,
	 * which is what spares a Log's flat `{file}.{seg}` segments — they sit at the
	 * first level as files, not dirs.
	 *
	 * @param string             $dir      Directory to sweep (e.g. `{base}/logs`).
	 * @param array<string,int>  $declared `name => partition` map; membership is by KEY.
	 * @param string             $base_dir Jail root for delete_directory_recursive.
	 * @param array<int,string>  $deleted  Accumulator, appended in place when a dir is gone.
	 * @param int                $grace    Required seconds of quiet; 0 disables the wait.
	 */
	private static function sweep( string $dir, array $declared, string $base_dir, array &$deleted, int $grace ): void {
		foreach ( @\glob( "{$dir}/*", \GLOB_ONLYDIR ) ?: [] as $path ) {
			if ( isset( $declared[ \basename( $path ) ] ) ) {
				continue;
			}
			// Grace: a recently-written dir is never a true orphan (deploys).
			if ( $grace > 0 && \time() - self::newest_mtime( $path ) < $grace ) {
				continue;
			}
			Spawn_Coordinator::delete_directory_recursive( $path, $base_dir );
			if ( ! \is_dir( $path ) ) {
				$deleted[] = $path;
			}
		}
	}

	/**
	 * Newest mtime across a dir and its first-level entries. Appends touch
	 * segment FILES (not the dir), so the dir mtime alone under-reports life.
	 */
	private static function newest_mtime( string $path ): int {
		$newest = (int) @\filemtime( $path );
		foreach ( @\glob( "{$path}/*" ) ?: [] as $entry ) {
			$newest = \max( $newest, (int) @\filemtime( $entry ) );
		}
		return $newest;
	}

	/**
	 * The names the log sweep keeps, as a plain list: every ACTIVE topology's
	 * resolved first-level log dirs (`Topology_Analyzer::resolved_resource_dirs`)
	 * expanded over that topology's SPAWN-aligned partition count
	 * (`Bootstrap::num_partitions_for`), unioned with each PHP-registered producer
	 * template (`newspack_nodes/registered_log_producers`) expanded the same way
	 * over the global config num_partitions, plus the settings log. The
	 * `cleanup_status` diagnostic diffs it against what is on disk to name the
	 * orphans, and a degraded declared set yields `[]` — nothing declared rather
	 * than a partial truth.
	 *
	 * @return array<int,string>
	 */
	public static function declared_log_dirs(): array {
		return \array_keys( self::declared_dirs()['logs'] ?? [] );
	}

	/**
	 * The same declared LOG set as `declared_log_dirs()`, as the `concrete dir
	 * name => enumerated partition index` map — the partition comes from the
	 * resolver's enumeration loop, never parsed out of a name. The dashboard
	 * catalog stamps each log entry with this real partition so it joins `logs[]`
	 * to `consumers[]` on `${name}#${partition}`; a hardcoded 0 there would meet
	 * the consumer rows on partition 0 alone. A degraded declared set yields `[]`.
	 *
	 * @return array<string,int>
	 */
	public static function declared_log_partitions(): array {
		return self::declared_dirs()['logs'] ?? [];
	}

	/**
	 * Single-pass declared-set collector. Resolves each config ROOT once and loops
	 * the operator's ACTIVE topology set (`Bootstrap::get_topologies()` — the same
	 * source the fleet spawns from) once, filling both buckets UNIFORMLY. Driving
	 * retention off the active set rather than the on-disk `.tsl` glob means a
	 * superseded-but-shipped topology's logs AND offsetlogs are reclaimed once it's
	 * deactivated; no live worker's dirs are at risk, because anything spawning is
	 * by definition in the active set. The log bucket additionally unions the
	 * PHP-registered producer templates (firehose / jobintake / … × clamped config
	 * num_partitions) and the settings log — logs with no consumer-offset of their
	 * own, hence log-only.
	 *
	 * A `null` bucket is the fail-closed sentinel the caller MUST skip its sweep
	 * on. An unresolvable config root nulls its own bucket; an active topology
	 * name that neither resolves nor synthesizes, an unreadable `.tsl`, and a
	 * producer template declaring no dir under the logs root null BOTH. All four
	 * leave live dirs out of a set other contributors keep non-empty, which is
	 * the shape that deletes data.
	 *
	 * Each non-null bucket is a `concrete dir name => enumerated partition index`
	 * map (the partition comes from the resolver's enumeration loop, never parsed
	 * out of a name); the whitelisted settings log is partition 0.
	 *
	 * @return array{logs: array<string,int>|null, offsets: array<string,int>|null}
	 */
	private static function declared_dirs(): array {
		$logs_root    = Core::resolve_config_token( 'config', 'logs_dir' );
		$offsets_root = Core::resolve_config_token( 'config', 'offsets_dir' );

		$logs    = [];
		$offsets = [];
		$active  = Bootstrap::get_topologies();

		// @longform get_topologies() silently DROPS an active-option name it
		// cannot resolve or synthesize. Mid-deploy — the plugin torn down, the
		// option intact — the declared set loses that plugin's dirs, and
		// sweeping against it deletes live logs.
		$raw = Config::value( 'topologies' );
		foreach ( ( \is_array( $raw ) ? $raw : [] ) as $name ) {
			if ( \is_string( $name ) && '' !== $name && ! isset( $active[ $name ] ) ) {
				Core::print_less_often( 'Log_Cleaner: skipping sweep: active topology unresolvable: ', $name );
				return [
					'logs'    => null,
					'offsets' => null,
				];
			}
		}

		foreach ( \array_keys( $active ) as $name ) {
			try {
				$resolved = Topology_Analyzer::resolved_resource_dirs( $name, Bootstrap::num_partitions_for( $name ) );
			} catch ( \RuntimeException $e ) {
				// Unreadable topology: partial sets read logs as orphans.
				Core::print_less_often( 'Log_Cleaner: skipping sweep: topology unreadable: ', $name . ': ' . $e->getMessage() );
				return [
					'logs'    => null,
					'offsets' => null,
				];
			}
			foreach ( $resolved['logs'] as $dir => $partition ) {
				$logs[ $dir ] ??= $partition;
			}
			foreach ( $resolved['offsets'] as $dir => $partition ) {
				$offsets[ $dir ] ??= $partition;
			}
		}

		if ( '' !== $logs_root ) {
			$producers = self::producer_log_dirs();
			if ( null === $producers ) {
				return [
					'logs'    => null,
					'offsets' => null,
				];
			}
			foreach ( $producers as $dir => $partition ) {
				$logs[ $dir ] ??= $partition;
			}
			// Whitelist the auto-mounted settings log (only if a set exists).
			if ( ! empty( $logs ) ) {
				$logs[ Settings_Event_Writer::SETTINGS_LOG_DIR ] ??= 0;
			}
		}

		return [
			'logs'    => '' === $logs_root ? null : $logs,
			'offsets' => '' === $offsets_root ? null : $offsets,
		];
	}

	/**
	 * Concrete log dir names for the request-scope PHP producers, feeding the log
	 * bucket of `declared_dirs()`. Each registered value is a PATH TEMPLATE in the
	 * same vocabulary a `.tsl` write_set entry uses
	 * (`<config:logs_dir>/firehose.p<partition>`), expanded over the clamped
	 * global config num_partitions through the one shared resolver and reduced to
	 * its first-level dir — so a producer owns its own layout and the token may
	 * sit anywhere, exactly as `Topology_Analyzer::resolved_resource_dirs` treats
	 * a declared topology. A template carrying no partition token collapses to one
	 * dir: `alerts.p0` is pinned across the fleet on purpose.
	 *
	 * `null` is the fail-closed sentinel: a registered template that lands under
	 * no logs dir across the whole partition range declares nothing, so that
	 * producer's live dirs are in NO declared set while a topology keeps the set
	 * non-empty — and the sweep would delete them. Every other degraded input
	 * here fails closed; this one must too.
	 *
	 * @return array<string,int>|null `concrete dir name => enumerated partition index`.
	 */
	public static function producer_log_dirs(): ?array {
		$root   = Core::resolve_config_token( 'config', 'logs_dir' );
		$cfg_np = self::config_num_partitions();
		$dirs   = [];
		foreach ( self::registered_producers() as $template ) {
			$produced = false;
			for ( $p = 0; $p < $cfg_np; $p++ ) {
				$first = Core::first_level_dir( Core::resolve_partition_template( $template, $p ), $root );
				if ( '' === $first ) {
					continue;
				}
				$produced       = true;
				$dirs[ $first ] ??= $p;
			}
			if ( ! $produced ) {
				Core::print_less_often( 'Log_Cleaner: skipping sweep: producer template declares no dir under the logs root: ', $template );
				return null;
			}
		}
		return $dirs;
	}

	/**
	 * Non-empty string producer path templates from the registration filter,
	 * deduplicated: two plugins registering one template declare one dir.
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

	/** Global config num_partitions — THE accessor, so the declared set and every producer agree. */
	private static function config_num_partitions(): int {
		return Bootstrap::global_num_partitions();
	}
}
