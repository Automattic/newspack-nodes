<?php
/**
 * Community_Source_Demo_Node: emits canned "community news" items on a TICK request.
 *
 * @package Example_AI_Newsletter
 */

namespace Example_AI_Newsletter;

use Newspack_Nodes\Node;
use Newspack_Nodes\Message;

\defined( 'ABSPATH' ) || exit;

class Community_Source_Demo_Node extends Node {

	/**
	 * The ONE seam a real source replaces: return ingest items. Toy = canned.
	 *
	 * @return array<int,array<string,string>>
	 */
	protected function items(): array {
		return [
			[ 'title' => 'Reader forum hits 10k members', 'url' => 'https://example.test/c1', 'body' => 'The publisher community forum crossed ten thousand members this week.' ],
			[ 'title' => 'Local meetup recap', 'url' => 'https://example.test/c2', 'body' => 'Highlights from the latest in-person reader meetup downtown.' ],
			[ 'title' => 'Volunteer spotlight', 'url' => 'https://example.test/c3', 'body' => 'A community moderator shares why they give their time.' ],
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
		$count = 0;
		foreach ( $this->items() as $item ) {
			$msg                   = Message::new_message();
			$msg[ Message::TYPE ]  = Message::TM_STRUCT;
			$msg[ Message::FROM ]  = $this->name;
			$msg[ Message::VALUE ] = [ 'source' => 'community' ] + $item;
			// parent::fill stamps TO from a connect_node-set target, then forwards to sink.
			parent::fill( $msg );
			++$count;
		}

		if ( null === $this->sink ) {
			return;
		}
		$verb  = \strtoupper( \trim( \is_scalar( $message[ Message::VALUE ] ) ? (string) $message[ Message::VALUE ] : '' ) );
		$reply                   = Message::new_message();
		$reply[ Message::TYPE ]  = Message::TM_STRUCT | Message::TM_RESPONSE;
		$reply[ Message::FROM ]  = $this->name;
		$reply[ Message::TO ]    = $message[ Message::FROM ];
		$reply[ Message::ID ]    = $message[ Message::ID ];
		$reply[ Message::KEY ]   = $message[ Message::KEY ];
		$reply[ Message::VALUE ] = [ 'verb' => $verb, 'data' => [ 'emitted' => $count ] ];
		$this->sink->fill( $reply );
	}

	public static function node_schema(): array {
		return \array_merge( parent::node_schema(), [
			'category'     => 'Source',
			'description'  => 'Emits canned publisher-community news items on a TICK request (request_node community TICK).',
			'arguments'    => [],
			'requests'     => [
				[
					'name'        => 'TICK',
					'description' => 'Emit the current batch of items. Trigger with `request_node community TICK`.',
					'reply_shape' => '{ emitted }',
				],
			],
			'accepts_fill' => true,
			'has_target'   => true,
		] );
	}
}
