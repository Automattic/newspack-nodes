<?php
/**
 * Station_Pages: the station's four composed pages — Overview, Jobs, Tables
 * and Aggregator — on the composition layer.
 *
 * Each page lays out a context under `newspack-nodes/`, whose default layout
 * is `layouts/station/<page>.html` and which admits every shared block, plus
 * the three blocks the substrate owns for what no shared block shows: the
 * topology rows, a probe log's identity table and the spokes' server cards.
 * `Composition::declare_substrate_blocks()` declares them with the shared
 * blocks. A station load sets `page_data()` before the station bundle, as
 * an inline script of its own, so the tab bundles that render after it read
 * it from one global no other bundle's localize replaces, and
 * loads the layout editor of the page `?edit=` names, the Overview's, Jobs'
 * and Tables' from the `station-editor` bundle, the Aggregator's from the
 * `aggregator-editor` bundle, because each page's blocks come from the tab
 * bundle that draws them.
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes;

\defined( 'ABSPATH' ) || exit;

/**
 * The station's contexts, its blocks and its page data.
 */
final class Station_Pages {

	/** The global a station load sets to `page_data()`. */
	public const GLOBAL = 'NewspackNodesStationPages';

	/** The editor bundle drawing the blocks of the Overview, Jobs and Tables. */
	public const DASHBOARDS_EDITOR = 'newspack-nodes-station-editor';

	/** The editor bundle drawing the Aggregator's blocks. */
	public const AGGREGATOR_EDITOR = 'newspack-nodes-aggregator-editor';

	/** Each composed station page => the context it lays out. */
	public const PAGES = [
		'station-overview'   => 'newspack-nodes/station-overview',
		'station-jobs'       => 'newspack-nodes/station-jobs',
		'station-tables'     => 'newspack-nodes/station-tables',
		'station-aggregator' => 'newspack-nodes/station-aggregator',
	];

	/**
	 * The most blocks one station layout holds: the Overview's default of
	 * seventeen, room to spare for a curator's own, each block reading a
	 * source the page shares with every block on that source.
	 */
	private const MAX_BLOCKS = 64;

	/** The shared blocks every station context admits. */
	private const ADMITS = [
		'newspack-nodes/stats',
		'newspack-nodes/time-chart',
		'newspack-nodes/table',
		'newspack-nodes/log-stream',
		'newspack-nodes/sparkline',
		'newspack-nodes/section',
	];

	/**
	 * The blocks the substrate owns on its station pages. Block name =>
	 * declaration, as `Composition::FILTER` takes one.
	 */
	public const BLOCKS = [
		'newspack-nodes/topology-rows' => [
			'title'      => 'Topology rows',
			'contexts'   => [ 'newspack-nodes/station-overview' ],
			'attributes' => [],
			'multiple'   => false,
		],
		'newspack-nodes/probe-table'   => [
			'title'      => 'Probe table',
			'contexts'   => [ 'newspack-nodes/station-overview', 'newspack-nodes/station-jobs', 'newspack-nodes/station-tables' ],
			'attributes' => [
				'source' => [
					'type'    => 'string',
					'enum'    => [ 'nodes/jobstats', 'nodes/tablestats' ],
					'default' => 'nodes/jobstats',
				],
			],
		],
		'newspack-nodes/server-cards'  => [
			'title'      => 'Server cards',
			'contexts'   => [ 'newspack-nodes/station-aggregator' ],
			'attributes' => [],
			'multiple'   => false,
		],
	];

	/**
	 * Set the page data ahead of the station bundle `$handle`, escaped for a
	 * script element, then load the layout editor of the page `?edit=`
	 * names, for a `tune` caller alone.
	 *
	 * @param string $handle    The station bundle's script handle.
	 * @param string $build_dir The plugin's build directory.
	 * @param string $build_url Its URL.
	 * @throws \LogicException Through `Composition`, on a declaration that breaks a rule.
	 * @throws \RuntimeException When the page data will not encode, or an editor's pattern no longer validates.
	 * @throws \InvalidArgumentException Through `Capabilities::cap_for()`, on a broken capability map.
	 */
	public static function enqueue( string $handle, string $build_dir, string $build_url ): void {
		$json = \wp_json_encode( self::page_data(), \JSON_HEX_TAG | \JSON_HEX_AMP | \JSON_UNESCAPED_SLASHES );
		if ( false === $json ) {
			throw new \RuntimeException( 'the station page data will not encode as JSON' );
		}
		\wp_add_inline_script( $handle, 'window.' . self::GLOBAL . " = {$json};", 'before' );
		$aggregator = \array_intersect_key( self::PAGES, [ 'station-aggregator' => true ] );
		Composition::enqueue_editor( \array_diff_key( self::PAGES, $aggregator ), self::DASHBOARDS_EDITOR, "{$build_dir}/station-editor", "{$build_url}/station-editor" );
		Composition::enqueue_editor( $aggregator, self::AGGREGATOR_EDITOR, "{$build_dir}/aggregator-editor", "{$build_url}/aggregator-editor" );
	}

	/**
	 * What a station page reads: whether the caller may curate its layout
	 * and read a refusal's own words, and every context's layout or its
	 * refusal.
	 *
	 * @return array{canTune: bool, canManage: bool, compositions: array<string,mixed>}
	 * @throws \LogicException When a context is not declared.
	 * @throws \InvalidArgumentException Through `Capabilities::cap_for()`, on a broken capability map.
	 */
	public static function page_data(): array {
		return [
			'canTune'      => Capabilities::can( Capabilities::TUNE ),
			'canManage'    => Capabilities::can( Capabilities::MANAGE ),
			'compositions' => Composition_Store::page_data( \array_values( self::PAGES ) ),
		];
	}

	/**
	 * Each station context's declaration, as `Composition::FILTER` takes one.
	 *
	 * @return array<string,array{default: string, max_blocks: int, admits: list<string>}>
	 */
	public static function contexts(): array {
		$contexts = [];
		foreach ( self::PAGES as $page => $context ) {
			$contexts[ $context ] = [
				'default'    => \dirname( __DIR__ ) . "/layouts/station/{$page}.html",
				'max_blocks' => self::MAX_BLOCKS,
				'admits'     => self::ADMITS,
			];
		}
		return $contexts;
	}
}
