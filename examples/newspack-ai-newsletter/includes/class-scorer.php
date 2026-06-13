<?php
/**
 * Scorer_Node: assigns a notional priority score to one item. Knows nothing about sources
 * beyond a per-source weight. The ONE seam a real scorer replaces is score().
 *
 * @package Newspack_AI_Newsletter
 */

namespace Newspack_AI_Newsletter;

use Newspack_Nodes\Node;
use Newspack_Nodes\Message;

\defined( 'ABSPATH' ) || exit;

class Scorer_Node extends Node {

	/** Per-source base weight; unknown sources score 1.0. */
	private const SOURCE_WEIGHT = [
		'releases'  => 5.0,
		'community' => 3.0,
	];

	/** Title keywords that bump priority, +1.0 each (case-insensitive). */
	private const KEYWORDS = [ 'award', 'launch', 'ships', 'GA', 'million', '10k' ];

	/**
	 * The ONE seam a real scorer replaces: item -> notional priority score.
	 * Deterministic: source weight + a +1.0 bump per matched title keyword.
	 *
	 * @param array<string,mixed> $item
	 */
	protected function score( array $item ): float {
		$source = \is_string( $item['source'] ?? null ) ? $item['source'] : '';
		$base   = self::SOURCE_WEIGHT[ $source ] ?? 1.0;
		$title  = \is_string( $item['title'] ?? null ) ? $item['title'] : '';
		$bump   = 0.0;
		foreach ( self::KEYWORDS as $kw ) {
			// Whole-word, case-insensitive — so 'GA' doesn't match "Garage" nor 'award' "awarded".
			if ( 1 === \preg_match( '/\b' . \preg_quote( $kw, '/' ) . '\b/i', $title ) ) {
				$bump += 1.0;
			}
		}
		return \round( $base + $bump, 1 );
	}

	public function fill( array &$message ): void {
		/** @var int $type */
		$type = $message[ Message::TYPE ];
		if ( 0 === ( $type & Message::TM_STRUCT ) ) {
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
		// parent::fill (base, not $this — would recurse) stamps TO from target, increments the counter, and forwards to sink.
		parent::fill( $out );
	}

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
