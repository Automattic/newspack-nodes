<?php
/**
 * Table_Probe: the Table-stats sweep. See Probe_Node for the sweep itself.
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes;

\defined( 'ABSPATH' ) || exit;

/**
 * Table_Probe: the Table-stats sweep, measuring what Tachikoma's BufferProbe
 * measures of a store — what each operation did, how long it took, what
 * failed and how much the store holds — and reporting it as Probe_Node does,
 * one self-contained window per Table. Each named Table yields one
 * `Tablestats_Record`; a mount yields none.
 *
 * `topologies/table-probe.tsl` declares it beside the `tablestats.p0` log,
 * and a topology declaring Tables includes that file.
 */
class Table_Probe_Node extends Probe_Node {

	/**
	 * Claim every Table in this process.
	 *
	 * @param Node $node A node from this process's registry.
	 * @return array<int,array<int,mixed>> One Tablestats_Record, or none.
	 */
	protected function probe( Node $node ): array {
		return $node instanceof Table_Node ? $node->probe_stats() : [];
	}

	/**
	 * Topology console manifest: the `Monitor` palette entry and the one
	 * `interval_s` positional, which `Probe_Node::arguments()` parses.
	 *
	 * @return array<string,mixed>
	 */
	public static function node_schema(): array {
		return \array_merge( parent::node_schema(), [
			'category'    => 'Monitor',
			'description' => 'Sweeps every Table in this process every N seconds; emits one per-operation window (calls, keys, bytes, ms, errors) per Table into the tablestats log.',
			'arguments'   => [
				[ 'name' => 'interval_s', 'type' => 'int', 'default' => self::DEFAULT_INTERVAL_S, 'description' => 'Sweep cadence in seconds between Table-stats snapshots; empty or absent defaults to 15.' ],
			],
		] );
	}
}
