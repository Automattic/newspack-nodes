<?php
/**
 * Summarizer_Demo_Node: turns one item into one summary. Knows nothing about sources.
 *
 * @package Example_AI_Newsletter
 */

namespace Example_AI_Newsletter;

use Newspack_Nodes\Node;
use Newspack_Nodes\Message;

\defined( 'ABSPATH' ) || exit;

class Summarizer_Demo_Node extends Node {

	/**
	 * The ONE seam a real summarizer replaces: item -> one-line summary. Toy = deterministic template.
	 *
	 * @param array<string,mixed> $item
	 */
	protected function summarize( array $item ): string {
		$title = \is_string( $item['title'] ?? null ) ? $item['title'] : '(untitled)';
		$body  = \is_string( $item['body'] ?? null ) ? $item['body'] : '';
		return $title . ' — ' . \mb_substr( $body, 0, 80 );
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
		$item['summary'] = $this->summarize( $item );

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
			'description'  => 'Summarizes one item; emits the item plus a summary. Source-agnostic.',
			'arguments'    => [],
			'commands'     => [],
			'accepts_fill' => true,
			'has_target'   => true,
		];
	}
}
