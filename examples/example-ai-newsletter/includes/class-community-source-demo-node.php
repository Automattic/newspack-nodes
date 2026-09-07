<?php
/**
 * The walkthrough's second source: on a TICK request it emits canned
 * publisher-community items toward `summarizer`, which `releases` already
 * feeds. A second wire into one node is all fan-in takes — nothing between
 * them merges the streams.
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
 * message carrying `{ source, title, url, body }` — plus the two topology
 * lines, `make_node` and `connect_node`. The substrate's
 * `docs/writing-a-real-plugin.md` shows the abstract `Source_Node` that
 * collapses the duplication once three connectors share it.
 */
class Community_Source_Demo_Node extends Node {

	/**
	 * Runs the TICK batch on any TM_REQUEST and ignores every other type.
	 *
	 * TICK is a runtime trigger, so it arrives as a TM_REQUEST handled here in
	 * fill(), never as a TM_COMMAND verb — that flag carries startup and
	 * administration. A source mints messages and consumes none, so anything else
	 * is dropped rather than forwarded to the sink. A TYPE that is not numeric
	 * reads as 0 and matches no flag.
	 *
	 * @param array<int,mixed> $message The 7-field positional message array.
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
	 * @param array<int,mixed> $message The TICK request.
	 */
	private function handle_request( array $message ): void {
		$emitted = 0;
		foreach ( $this->items() as $item ) {
			$response                   = Message::new_message();
			$response[ Message::TYPE ]  = Message::TM_STRUCT;
			$response[ Message::FROM ]  = $this->name;
			$response[ Message::VALUE ] = [ 'source' => 'community' ] + $item;
			// parent::fill stamps TO from the target; our fill() would drop it.
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
	 * Canned data keeps the walkthrough deterministic, and the suite asserts a
	 * TICK reports an `emitted` of 3. A real source fetches here — a feed, an
	 * API, a table — and returns the same shape. It leaves the `source` key
	 * alone: `handle_request()` unions that in ahead of the item, so an override
	 * can neither forget it nor change it.
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
	 * Describes the node for the console palette, the Inspector and `help`.
	 *
	 * The `requests` entry draws the Inspector's TICK button and the REQUESTS
	 * row of `help Community_Source_Demo`. `accepts_fill` stays true because the
	 * request itself arrives at `fill()`, and no `commands` entry is declared,
	 * since a runtime trigger never becomes a TM_COMMAND verb.
	 *
	 * @return array<string,mixed> The base schema with this node's entries merged over it.
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
