<?php
/**
 * Insights_CI_Demo_Node: the dashboard's server-side read. It reads the latest offsetlog
 * snapshot the Consumer co-commits (the digest's save_state cache) and serves it as three
 * small verbs — `counts`, `top`, `accumulated` — one slice each, so the dashboard can fetch
 * each independently (one Fetcher per verb, batched into one POST per tick). Durable,
 * synchronous, no live-worker dependency.
 *
 * @package Example_AI_Newsletter
 */

namespace Example_AI_Newsletter;

use Newspack_Nodes\Core;
use Newspack_Nodes\Service_CI_Node;
use Newspack_Nodes\Partition_Node;
use Newspack_Nodes\Config;

\defined( 'ABSPATH' ) || exit;

class Insights_CI_Demo_Node extends Service_CI_Node {

	private const TOP_N = 10;

	/**
	 * Offsetlog-read seam. Lazily-defaulted to read_snapshot_items(); tests reassign it
	 * to count reads without short-circuiting the real glob/merge path. The memoized
	 * items() resolves and invokes it at most once per request.
	 *
	 * Signature: `function ( string $offsets_dir ): array<int,array<array-key,mixed>>`.
	 *
	 * @var \Closure|null
	 */
	public static ?\Closure $read_items = null;

	/**
	 * Per-request memo of the flattened snapshot items; null until items() reads once.
	 *
	 * @var array<int,array<array-key,mixed>>|null
	 */
	private ?array $items_cache = null;

	/**
	 * Read the offsetlog snapshot ONCE per request and memoize the flattened items, so the
	 * three batched slice verbs share a single read instead of globbing + unpacking thrice.
	 *
	 * @return array<int,array<array-key,mixed>>
	 */
	private function items(): array {
		if ( null !== $this->items_cache ) {
			return $this->items_cache;
		}
		$read = self::$read_items ?? static fn ( string $dir ): array => self::read_snapshot_items( $dir );
		$raw  = $read( Config::get_offsets_directory() );
		$items = [];
		foreach ( Core::arr( $raw ) as $item ) {
			if ( \is_array( $item ) ) {
				$items[] = $item;
			}
		}
		$this->items_cache = $items;
		return $this->items_cache;
	}

	/**
	 * Read every `example-scored.p*` offset dir's latest snapshot and flatten the digest
	 * caches into one items list. `example-scored` (not bare `scored`) isolates this demo;
	 * MUST match the topology paths. The glob + per-dir cache descent is the substrate's
	 * Partition_Node::read_latest_snapshot_cache; this just pins the demo's glob.
	 *
	 * @return array<int,array<array-key,mixed>>
	 */
	public static function read_snapshot_items( string $offsets_dir ): array {
		return Partition_Node::read_latest_snapshot_cache( $offsets_dir, 'example-scored.p*', 'digest' );
	}

	/**
	 * Count items per source.
	 *
	 * @param array<int,array<array-key,mixed>> $items
	 * @return array<string,int>
	 */
	private static function shape_sources( array $items ): array {
		$sources = [];
		foreach ( $items as $item ) {
			$source             = \is_string( $item['source'] ?? null ) ? $item['source'] : '?';
			$sources[ $source ] = ( $sources[ $source ] ?? 0 ) + 1;
		}
		return $sources;
	}

	/**
	 * Top-N items by score, descending, shaped to { source, title, score }.
	 *
	 * @param array<int,array<array-key,mixed>> $items
	 * @return array<int,array<string,mixed>>
	 */
	private static function shape_top( array $items ): array {
		\usort(
			$items,
			static fn ( array $a, array $b ): int => Core::num_float( $b['score'] ?? null ) <=> Core::num_float( $a['score'] ?? null )
		);
		$top = [];
		foreach ( \array_slice( $items, 0, self::TOP_N ) as $item ) {
			$top[] = [
				'source' => $item['source'] ?? '?',
				'title'  => $item['title'] ?? '',
				'score'  => Core::num_float( $item['score'] ?? null ),
			];
		}
		return $top;
	}

	public static function node_schema(): array {
		// @longform Service_CI_Node::slice_verb() builds each handler: it
		// passes this node (the interpreter IS the CI for a Service_CI verb)
		// to the shape and JSON-encodes the result. commands_from_schema()
		// wraps every handler with require_manage_options(), so the gate is
		// centralized there — no per-slice gate needed.
		return \array_merge( parent::node_schema(), [
			'category'    => 'Service',
			'description' => 'Reads the scored-pipeline offsetlog snapshot; serves the dashboard insights slices.',
			'commands'    => [
				[
					'name'        => 'counts',
					'description' => 'Return per-source item counts: { sources: { source: count } }.',
					'args'        => [],
					'handler'     => self::slice_verb( static fn ( self $ci ): array => [ 'sources' => self::shape_sources( $ci->items() ) ] ),
				],
				[
					'name'        => 'top',
					'description' => 'Return the top-10 items by score: { top: [ { source, title, score } ] }.',
					'args'        => [],
					'handler'     => self::slice_verb( static fn ( self $ci ): array => [ 'top' => self::shape_top( $ci->items() ) ] ),
				],
				[
					'name'        => 'accumulated',
					'description' => 'Return the total accumulated item count: { accumulated: N }.',
					'args'        => [],
					'handler'     => self::slice_verb( static fn ( self $ci ): array => [ 'accumulated' => \count( $ci->items() ) ] ),
				],
			],
		] );
	}
}
