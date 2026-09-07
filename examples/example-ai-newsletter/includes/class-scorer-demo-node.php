<?php
/**
 * Ranking stage of the example digest pipeline: it adds a `score` field to every item. The
 * Publisher Insights dashboard's `top` slice ranks by that field; the digest carries it
 * along without reading it.
 *
 * The `_Demo` suffix keeps the shell name `Scorer_Demo` clear of the bare `Scorer` that
 * newspack-intelligence's `Scorer_Node` claims, and both plugins can be active in one
 * WordPress. `make_node` resolves a type through the first registered namespace holding a
 * `{$type}_Node`, so one shared name would hand both topologies whichever plugin
 * registered first.
 *
 * @package Example_AI_Newsletter
 */

namespace Example_AI_Newsletter;

use Newspack_Nodes\Core;
use Newspack_Nodes\Node;
use Newspack_Nodes\Message;

\defined( 'ABSPATH' ) || exit;

/**
 * A transform on the uniform `fill()` contract (ADR-1): take one struct item, add one
 * field, forward it. It reads `source` and `title` and nothing else, which is what lets
 * the `releases` and `community` items fan through one scorer, and it confines a real
 * scorer to `score()`.
 */
class Scorer_Demo_Node extends Node {

	/** Per-source base weight; an unknown source falls back to 1.0. */
	private const SOURCE_WEIGHT = [
		'releases'  => 5.0,
		'community' => 3.0,
	];

	/** Title keywords worth +1.0 each, matched whole-word and case-insensitively. */
	private const KEYWORDS = [ 'award', 'launch', 'ships', 'GA', 'million', '10k' ];

	/**
	 * Score one item and forward it. A message that is not TM_STRUCT, or whose VALUE is
	 * not an array, is dropped rather than passed along: it cannot carry a `score`, and
	 * the durable `scored:partition` log downstream is what the dashboard's `top` slice
	 * ranks. The two guards are a whitelist, so a TM_INFO control signal — a source's
	 * DONE, say — dies here too; this example mints none.
	 *
	 * The scored item leaves as a fresh message rather than as a mutation of the inbound
	 * one, so TYPE is exactly TM_STRUCT and FROM is this node's own name.
	 * `parent::fill()` then stamps TO from `target` and forwards to the sink (ADR-7).
	 *
	 * @param array<int,mixed> $message The 7-field positional message array.
	 */
	public function fill( array $message ): void {
		/** @var int $type */
		$type = $message[ Message::TYPE ];
		if ( ! ( $type & Message::TM_STRUCT ) ) {
			return;
		}
		$item = $message[ Message::VALUE ];
		if ( ! \is_array( $item ) ) {
			return;
		}
		/** @var array<string,mixed> $item */
		$item['score'] = $this->score( $item );

		$out                   = Message::new_message();
		$out[ Message::TYPE ]  = Message::TM_STRUCT;
		$out[ Message::FROM ]  = $this->name;
		$out[ Message::VALUE ] = $item;
		// parent::fill — base, not $this, which would recurse.
		parent::fill( $out );
	}

	/**
	 * The ONE seam a real scorer replaces: it turns one item into a notional priority
	 * score. An LLM call belongs here, and nothing else in the file changes when it
	 * arrives.
	 *
	 * The toy is deterministic — the source weight plus 1.0 for each matched title
	 * keyword, rounded to one decimal, with no clock and no randomness — so the suite
	 * asserts exact scores rather than ranges. A missing or non-scalar `source` or
	 * `title` reads as the empty string, so an item carrying neither scores 1.0.
	 *
	 * @param array<string,mixed> $item The item to score.
	 * @return float The item's priority score.
	 */
	protected function score( array $item ): float {
		$source = Core::as_string( $item['source'] ?? null );
		$base   = self::SOURCE_WEIGHT[ $source ] ?? 1.0;
		$title  = Core::as_string( $item['title'] ?? null );
		$bump   = 0.0;
		foreach ( self::KEYWORDS as $kw ) {
			// Whole-word and case-insensitive: 'GA' must not match "Garage".
			if ( 1 === \preg_match( '/\b' . \preg_quote( $kw, '/' ) . '\b/i', $title ) ) {
				$bump += 1.0;
			}
		}
		return \round( $base + $bump, 1 );
	}

	/**
	 * Topology-console manifest: the palette tile and the node's argument form. The weight
	 * table is a constant rather than a constructor argument, so the form carries nothing
	 * to configure, and a pure transform declares no verbs.
	 *
	 * @return array<string,mixed>
	 */
	public static function node_schema(): array {
		return [
			'category'     => 'Transform',
			'description'  => 'Assigns a notional priority score to one item; source-agnostic.',
			'arguments'    => [],
			'commands'     => [],
			'accepts_fill' => true,
			'has_target'   => true,
		];
	}
}
