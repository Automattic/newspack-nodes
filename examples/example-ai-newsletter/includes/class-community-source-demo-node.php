<?php
/**
 * The walkthrough's second source, which demonstrates fan-in: two nodes point
 * their target at one summarizer, and no node between them merges the streams.
 *
 * @package Example_AI_Newsletter
 */

namespace Example_AI_Newsletter;

use Newspack_Nodes\Node;
use Newspack_Nodes\Message;

\defined( 'ABSPATH' ) || exit;

/**
 * Emits canned publisher-community items on a TICK request.
 *
 * Near-identical to `Releases_Source_Demo_Node` by design: the walkthrough's
 * point is that a second author needs only the item contract — a TM_STRUCT
 * message carrying `{ source, title, url, body }` — plus one `connect_node`
 * line. `docs/writing-a-real-plugin.md` shows the abstract `Source_Node` that
 * collapses the duplication once three connectors share it.
 */
class Community_Source_Demo_Node extends Node {

	/**
	 * Runs the TICK batch on any TM_REQUEST and ignores every other type.
	 *
	 * TICK is a runtime trigger, so it arrives as a TM_REQUEST handled here in
	 * fill(), never as a TM_COMMAND verb — that flag carries startup and
	 * administration. A source mints messages and consumes none, so every other
	 * type falls through.
	 *
	 * @param array<int,mixed> $message Incoming request Message.
	 */
	public function fill( array $message ): void {
		$type = \is_numeric( $message[ Message::TYPE ] ) ? (int) $message[ Message::TYPE ] : 0;
		if ( $type & Message::TM_REQUEST ) {
			$this->handle_request( $message );
		}
	}

	/**
	 * Emits each item as its own TM_STRUCT message, then replies with the count.
	 *
	 * The per-item emits are fire-and-forget: nothing acks them and nothing
	 * waits (ADR-3). Every TM_REQUEST runs the batch — the VALUE verb goes
	 * unread, because TICK is the only request the schema declares. The reply
	 * echoes the request's ID and KEY, matching `Consumer_Node::handle_request`.
	 *
	 * @param array<int,mixed> $message Incoming request Message.
	 */
	private function handle_request( array $message ): void {
		$emitted = 0;
		foreach ( $this->items() as $item ) {
			$response                   = Message::new_message();
			$response[ Message::TYPE ]  = Message::TM_STRUCT;
			$response[ Message::FROM ]  = $this->name;
			$response[ Message::VALUE ] = [ 'source' => 'community' ] + $item;
			// parent::fill stamps TO from the target and sinks; $this recurses.
			parent::fill( $response );
			++$emitted;
		}
		// TO=FROM addresses the reply, as Consumer_Node::handle_request does.
		$reply                   = Message::new_message();
		$reply[ Message::TYPE ]  = Message::TM_STRUCT | Message::TM_RESPONSE;
		$reply[ Message::FROM ]  = $this->name;
		$reply[ Message::TO ]    = $message[ Message::FROM ];
		$reply[ Message::ID ]    = $message[ Message::ID ];
		$reply[ Message::KEY ]   = $message[ Message::KEY ];
		$reply[ Message::VALUE ] = [ 'emitted' => $emitted ];
		parent::fill( $reply );
	}

	/**
	 * The one seam a real source replaces: the batch of items to ingest.
	 *
	 * Canned data keeps the walkthrough deterministic. A real source fetches
	 * here — a feed, an API, a table — and returns the same shape. It does not
	 * set the `source` key: `handle_request()` stamps that onto every item, so
	 * an override cannot forget it.
	 *
	 * @return array<int,array<string,string>> Items keyed `title`, `url` and `body`.
	 */
	protected function items(): array {
		return [
			[ 'title' => 'Reader forum hits 10k members', 'url' => 'https://example.test/c1', 'body' => 'The publisher community forum crossed ten thousand members this week.' ],
			[ 'title' => 'Local meetup recap', 'url' => 'https://example.test/c2', 'body' => 'Highlights from the latest in-person reader meetup downtown.' ],
			[ 'title' => 'Volunteer spotlight', 'url' => 'https://example.test/c3', 'body' => 'A community moderator shares why they give their time.' ],
		];
	}

	/**
	 * Declares the node for `make_node`, the console palette and the Inspector.
	 *
	 * The `requests` entry is what draws the Inspector's TICK button and what
	 * `help Community_Source_Demo` prints.
	 *
	 * @return array<string,mixed>
	 */
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
