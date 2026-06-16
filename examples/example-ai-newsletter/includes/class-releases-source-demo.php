<?php
/**
 * Releases_Source_Demo_Node: emits canned "release notes" items on a TICK request.
 *
 * @package Example_AI_Newsletter
 */

namespace Example_AI_Newsletter;

use Newspack_Nodes\Node;
use Newspack_Nodes\Message;

\defined( 'ABSPATH' ) || exit;

class Releases_Source_Demo_Node extends Node {

	/**
	 * The ONE seam a real source replaces: return ingest items. Toy = canned.
	 *
	 * @return array<int,array<string,string>>
	 */
	protected function items(): array {
		return [
			[ 'title' => 'Roundup Block ships', 'url' => 'https://example.test/r1', 'body' => 'AI summarizes selected posts into a draft.' ],
			[ 'title' => 'Editorial Assistant GA', 'url' => 'https://example.test/r2', 'body' => 'Inline AI assistance in the editor.' ],
		];
	}

	/**
	 * TICK is a runtime trigger: a TM_REQUEST handled here in fill() (NOT a
	 * TM_COMMAND verb — that flag is for startup/admin). Any other type is
	 * ignored; a source mints, it doesn't consume.
	 *
	 * @param array<int, mixed> $message Incoming request Message.
	 */
	public function fill( array &$message ): void {
		$type = \is_numeric( $message[ Message::TYPE ] ) ? (int) $message[ Message::TYPE ] : 0;
		if ( $type & Message::TM_REQUEST ) {
			$this->handle_request( $message );
		}
	}

	/**
	 * TICK handler: emit each item as a TM_STRUCT message, then reply with the count.
	 *
	 * @param array<int, mixed> $message Incoming request Message.
	 */
	private function handle_request( array $message ): void {
		foreach ( $this->items() as $item ) {
			$response                   = Message::new_message();
			$response[ Message::TYPE ]  = Message::TM_STRUCT;
			$response[ Message::FROM ]  = $this->name;
			$response[ Message::VALUE ] = [ 'source' => 'releases' ] + $item;
			// parent::fill stamps TO from a connect_node-set target, then forwards to sink.
			parent::fill( $response );
		}
	}

	public static function node_schema(): array {
		return \array_merge( parent::node_schema(), [
			'category'     => 'Source',
			'description'  => 'Emits canned release-notes items on a TICK request (request_node releases TICK).',
			'arguments'    => [],
			'requests'     => [
				[
					'name'        => 'TICK',
					'description' => 'Emit the current batch of items. Trigger with `request_node releases TICK`.',
					'reply_shape' => '{ emitted }',
				],
			],
			'accepts_fill' => true,
			'has_target'   => true,
		] );
	}
}
