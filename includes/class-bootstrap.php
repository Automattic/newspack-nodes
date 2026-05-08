<?php
/**
 * Bootstrap: plugin-level glue.
 *
 * Reads the `newspack_nodes/topologies` filter and expands it to a flat list of
 * worker descriptors (one per partition).
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes;

\defined( 'ABSPATH' ) || exit;

class Bootstrap {
	public static function get_topologies(): array {
		return (array) \apply_filters( 'newspack_nodes/topologies', [] );
	}

	public static function expand_workers(): array {
		$topologies = self::get_topologies();
		$workers    = [];
		foreach ( $topologies as $type => $config ) {
			$count = (int) ( $config['num_partitions'] ?? 1 );
			for ( $p = 0; $p < $count; ++$p ) {
				$workers[] = [
					'type'          => $type,
					'partition'     => $p,
					'topology'      => $config['topology'] ?? '',
					'stale_timeout' => $config['stale_timeout'] ?? Lock::STALE_TIMEOUT,
				];
			}
		}
		return $workers;
	}
}
