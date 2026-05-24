<?php
/**
 * Summarizer_Node: turns one item into one summary. Knows nothing about sources.
 *
 * @package Newspack_AI_Newsletter
 */

namespace Newspack_AI_Newsletter;

use Newspack_Nodes\Node;
use Newspack_Nodes\Message;

\defined( 'ABSPATH' ) || exit;

class Summarizer_Node extends Node {

	/** The ONE seam a real summarizer replaces: item -> one-line summary. Toy = deterministic template. */
	protected function summarize( array $item ): string {
		$title = $item['title'] ?? '(untitled)';
		$body  = $item['body'] ?? '';
		return $title . ' — ' . \mb_substr( $body, 0, 80 );
	}

	public function fill( array &$message ): void {
		if ( 0 === ( $message[ Message::TYPE ] & Message::TM_STRUCT ) ) {
			return;
		}
		$item            = $message[ Message::VALUE ];
		$item['summary'] = $this->summarize( $item );

		$out                   = Message::new_message();
		$out[ Message::TYPE ]  = Message::TM_STRUCT;
		$out[ Message::FROM ]  = $this->name;
		$out[ Message::VALUE ] = $item;
		++$this->counter;
		$this->sink?->fill( $out );
	}

	public static function node_schema(): array {
		return [
			'category'     => 'Transform',
			'description'  => 'Summarizes one item; emits the item plus a summary. Source-agnostic.',
			'ctor'         => [],
			'verbs'        => [],
			'accepts_fill' => true,
			'has_target'   => true,
		];
	}
}
