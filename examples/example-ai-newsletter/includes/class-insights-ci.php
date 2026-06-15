<?php
/**
 * Insights_CI_Node: the dashboard's server-side read. Its `insights` verb reads the
 * latest offsetlog snapshot the Consumer co-commits (the digest's save_state cache)
 * and returns a shaped model — durable, synchronous, no live-worker dependency.
 *
 * @package Newspack_AI_Newsletter
 */

namespace Newspack_AI_Newsletter;

use Newspack_Nodes\Service_CI_Node;
use Newspack_Nodes\Command_Interpreter_Node;
use Newspack_Nodes\Partition_Node;
use Newspack_Nodes\Config;

\defined( 'ABSPATH' ) || exit;

class Insights_CI_Node extends Service_CI_Node {

	private const TOP_N = 10;

	/** Coerce an untrusted (JSON-sourced) score to float; non-numeric → 0.0. */
	private static function to_float( mixed $value ): float {
		return \is_numeric( $value ) ? (float) $value : 0.0;
	}

	/** JSON model for the `insights` verb; resolves the live offsets dir from Config. */
	public function build_insights_json(): string {
		$model = self::read_insights_model( Config::get_offsets_directory() );
		return (string) \wp_json_encode( $model );
	}

	/**
	 * Testable core: read every `scored.p*` offset dir's latest snapshot, merge the
	 * digest caches, and shape { sources:{name:count}, top:[{source,title,score}], accumulated:N }.
	 *
	 * @return array{sources: array<string,int>, top: array<int,array<string,mixed>>, accumulated: int}
	 */
	public static function read_insights_model( string $offsets_dir ): array {
		$empty = [ 'sources' => [], 'top' => [], 'accumulated' => 0 ];
		$dirs  = \glob( \rtrim( $offsets_dir, '/' ) . '/scored.p*', \GLOB_ONLYDIR );
		if ( false === $dirs || [] === $dirs ) {
			return $empty;
		}

		$items = [];
		foreach ( $dirs as $dir ) {
			foreach ( self::read_cache_items( $dir ) as $item ) {
				$items[] = $item;
			}
		}
		if ( [] === $items ) {
			return $empty;
		}

		$sources = [];
		foreach ( $items as $item ) {
			$source             = \is_string( $item['source'] ?? null ) ? $item['source'] : '?';
			$sources[ $source ] = ( $sources[ $source ] ?? 0 ) + 1;
		}

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

		return [ 'sources' => $sources, 'top' => $top, 'accumulated' => \count( $items ) ];
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
		return \array_merge( parent::node_schema(), [
			'category'    => 'Service',
			'description' => 'Reads the scored-pipeline offsetlog snapshot; serves the dashboard insights model.',
			'commands'    => [
				[
					'name'        => 'insights',
					'description' => 'Return the current Publisher Insights model (sources, top, accumulated).',
					'args'        => [],
					'handler'     => static function ( Command_Interpreter_Node $interpreter, string $args ): string {
						self::require_manage_options();
						// A Service_CI verb runs on the CI itself — the interpreter IS this node.
						/** @var self $ci */
						$ci = $interpreter;
						return $ci->build_insights_json();
					},
				],
			],
		] );
	}
}
