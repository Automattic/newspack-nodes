<?php
/**
 * Server-side read behind the Publisher Insights dashboard.
 *
 * All three dashboard panels are answered from one durable source: the newest
 * snapshot the `example-scored` Consumer co-commits into its offsetlog, which
 * carries `Digest_Builder_Demo`'s accumulated items (its `save_state()` cache).
 * Reading committed state off disk keeps the page synchronous and free of any
 * live-worker dependency — a dashboard request never has to reach the fleet, and
 * it renders exactly what the last commit held.
 *
 * @package Example_AI_Newsletter
 */

namespace Example_AI_Newsletter;

use Newspack_Nodes\Core;
use Newspack_Nodes\Service_CI_Node;
use Newspack_Nodes\Partition_Node;
use Newspack_Nodes\Config;

\defined( 'ABSPATH' ) || exit;

/**
 * Publisher Insights service interpreter: one slice verb per dashboard panel.
 *
 * `counts`, `top` and `accumulated` each return a single slice rather than one
 * blob, so the dashboard runs one Fetcher per panel and every reply lands on the
 * Fetcher that minted it — the address IS the correlation (ADR-7), and no panel
 * waits on another's data. The split costs no extra requests: the browser's
 * HTTP_Out batches a tick's three commands into one POST.
 */
class Insights_CI_Demo_Node extends Service_CI_Node {

	/** How many items the `top` verb returns, highest score first. */
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
	 * Flatten every `example-scored.p*` offsetlog's latest snapshot into one items list.
	 *
	 * The glob and the per-directory cache descent belong to the substrate's
	 * `Partition_Node::read_latest_snapshot_cache()`; this pins the demo's glob.
	 * `example-scored` rather than a bare `scored` isolates the example's data from a real
	 * plugin's log in the same substrate directory, so the pattern MUST match the paths the
	 * topology declares.
	 *
	 * @param string $offsets_dir Substrate offsets directory holding the per-partition offsetlogs.
	 * @return array<int,array<array-key,mixed>> Digest items from every partition, in glob order.
	 */
	public static function read_snapshot_items( string $offsets_dir ): array {
		return Partition_Node::read_latest_snapshot_cache( $offsets_dir, 'example-scored.p*', 'digest' );
	}

	/**
	 * Count items per source. An item whose `source` is missing or non-string counts
	 * under `?` rather than being dropped, so the totals still add up to the item count.
	 *
	 * @param array<int,array<array-key,mixed>> $items Snapshot items.
	 * @return array<string,int> Source name => item count.
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
	 * A missing or non-numeric score reads as 0.0 through Core::num_float(), so the
	 * comparison never sees a null and an unscored item still sorts.
	 *
	 * @param array<int,array<array-key,mixed>> $items Snapshot items.
	 * @return array<int,array<string,mixed>> At most TOP_N items, highest score first.
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

	/**
	 * Palette entry plus the three slice verbs the dashboard polls.
	 *
	 * `Service_CI_Node::slice_verb()` builds each handler: it hands the interpreter — for
	 * a Service_CI verb that IS this node — to the shape closure and JSON-encodes what the
	 * closure returns. Every shape reads `items()`, so the three verbs of one batch share
	 * a single offsetlog read.
	 *
	 * Authorization belongs to the base class, which wraps each handler in the capability
	 * its schema declares. These three declare none, so all of them require MANAGE, and a
	 * per-verb gate here would only stack a second check.
	 *
	 * @return array<string,mixed>
	 */
	public static function node_schema(): array {
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
