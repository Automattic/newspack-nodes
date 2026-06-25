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

use Newspack_Nodes\Service_CI_Node;
use Newspack_Nodes\Command_Interpreter_Node;
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

	/** Coerce an untrusted (JSON-sourced) score to float; non-numeric → 0.0. */
	private static function to_float( mixed $value ): float {
		return \is_numeric( $value ) ? (float) $value : 0.0;
	}

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
		foreach ( \is_array( $raw ) ? $raw : [] as $item ) {
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
	 * MUST match the topology paths.
	 *
	 * @return array<int,array<array-key,mixed>>
	 */
	public static function read_snapshot_items( string $offsets_dir ): array {
		$dirs = \glob( \rtrim( $offsets_dir, '/' ) . '/example-scored.p*', \GLOB_ONLYDIR );
		if ( false === $dirs || [] === $dirs ) {
			return [];
		}
		$items = [];
		foreach ( $dirs as $dir ) {
			foreach ( self::read_cache_items( $dir ) as $item ) {
				$items[] = $item;
			}
		}
		return $items;
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
			static fn ( array $a, array $b ): int => self::to_float( $b['score'] ?? null ) <=> self::to_float( $a['score'] ?? null )
		);
		$top = [];
		foreach ( \array_slice( $items, 0, self::TOP_N ) as $item ) {
			$top[] = [
				'source' => $item['source'] ?? '?',
				'title'  => $item['title'] ?? '',
				'score'  => self::to_float( $item['score'] ?? null ),
			];
		}
		return $top;
	}

	/**
	 * Read the latest snapshot record of one offset dir and return its cache['items'].
	 * Mirrors CLI::read_offsetlog_entry — newest segment, last line, unpack VALUE.
	 *
	 * @return array<int,array<array-key,mixed>>
	 */
	private static function read_cache_items( string $offset_dir ): array {
		$value = Partition_Node::read_latest_value_at( $offset_dir );
		$cache = \is_array( $value ) && \is_array( $value['cache'] ?? null ) ? $value['cache'] : [];
		$items = $cache['items'] ?? null;
		if ( ! \is_array( $items ) ) {
			return [];
		}
		$out = [];
		foreach ( $items as $item ) {
			if ( \is_array( $item ) ) {
				$out[] = $item;
			}
		}
		return $out;
	}

	public static function node_schema(): array {
		// A Service_CI verb runs on the CI itself — the interpreter passed to each handler IS this node.
		// Service_CI_Node::commands_from_schema() wraps every handler with require_manage_options(),
		// so the gate is centralized there — no per-slice gate needed.
		$slice = static fn ( callable $shape ): \Closure => static function ( Command_Interpreter_Node $interpreter, string $args ) use ( $shape ): string {
			/** @var self $ci */
			$ci = $interpreter;
			return (string) \wp_json_encode( $shape( $ci ) );
		};
		return \array_merge( parent::node_schema(), [
			'category'    => 'Service',
			'description' => 'Reads the scored-pipeline offsetlog snapshot; serves the dashboard insights slices.',
			'commands'    => [
				[
					'name'        => 'counts',
					'description' => 'Return per-source item counts: { sources: { source: count } }.',
					'args'        => [],
					'handler'     => $slice( static fn ( self $ci ): array => [ 'sources' => self::shape_sources( $ci->items() ) ] ),
				],
				[
					'name'        => 'top',
					'description' => 'Return the top-10 items by score: { top: [ { source, title, score } ] }.',
					'args'        => [],
					'handler'     => $slice( static fn ( self $ci ): array => [ 'top' => self::shape_top( $ci->items() ) ] ),
				],
				[
					'name'        => 'accumulated',
					'description' => 'Return the total accumulated item count: { accumulated: N }.',
					'args'        => [],
					'handler'     => $slice( static fn ( self $ci ): array => [ 'accumulated' => \count( $ci->items() ) ] ),
				],
			],
		] );
	}
}
