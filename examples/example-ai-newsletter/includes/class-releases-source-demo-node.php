<?php
/**
 * One of the two ingest sources at the head of the AI-newsletter example
 * pipeline: on a TICK request it emits canned release-notes items toward
 * `summarizer`.
 *
 * @package Example_AI_Newsletter
 */

namespace Example_AI_Newsletter;

use Newspack_Nodes\Node;
use Newspack_Nodes\Message;

\defined( 'ABSPATH' ) || exit;

/**
 * Releases source for the `example-ai-newsletter` topology.
 *
 * Every class in this example carries a `_Demo` suffix so the walkthrough and a
 * real plugin built from it stay distinct while both are active in one
 * WordPress. A shell name is the class name minus `_Node` (ADR-10), and two
 * classes sharing one resolve as one everywhere: `make_node` builds whichever
 * registered namespace prefix answers first, and the console keys both its
 * palette tile and its Inspector lookup by that name.
 */
class Releases_Source_Demo_Node extends Node {

	/**
	 * Run the TICK batch on any TM_REQUEST and ignore every other type.
	 *
	 * TICK drives an already-running graph, so it arrives as a TM_REQUEST
	 * handled here rather than as a TM_COMMAND verb on a sibling interpreter;
	 * TM_COMMAND is the startup and administration plane. A TYPE that is not
	 * numeric reads as 0 and matches no flag.
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
	 * Emit each item as its own TM_STRUCT message, then reply with the count.
	 *
	 * The items go out fire-and-forget: nothing acknowledges them (ADR-3) and
	 * `fill()` returns nothing to inspect (ADR-13). The request gets one reply,
	 * echoing the ID and KEY it carried. Each item is built in a fresh message
	 * rather than by reassigning the request, because the reply reads that
	 * request's FROM, ID and KEY after the loop. Every TM_REQUEST emits — TICK
	 * is the one verb the schema declares, so the VALUE goes unread.
	 *
	 * @param array<int,mixed> $message The TICK request.
	 */
	private function handle_request( array $message ): void {
		$emitted = 0;
		foreach ( $this->items() as $item ) {
			$response                   = Message::new_message();
			$response[ Message::TYPE ]  = Message::TM_STRUCT;
			$response[ Message::FROM ]  = $this->name;
			$response[ Message::VALUE ] = [ 'source' => 'releases' ] + $item;
			// parent::fill stamps TO from the target; our fill() would drop it.
			parent::fill( $response );
			++$emitted;
		}
		// TO=FROM is the whole correlation; no table of pending asks (ADR-7).
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
	 * Return the batch to emit.
	 *
	 * This is the ONE seam a real source replaces: override it with an HTTP
	 * fetch or a feed parse and the rest of the node is unchanged. Leave the
	 * `source` key out — `handle_request()` stamps it on, and its value wins
	 * the union, so an override can neither omit it nor change it. Canned items
	 * keep the walkthrough deterministic, and the suite asserts a TICK reports
	 * an `emitted` of 2.
	 *
	 * @return array<int,array<string,string>> Items keyed `title`, `url` and `body`.
	 */
	protected function items(): array {
		return [
			[ 'title' => 'Roundup Block ships', 'url' => 'https://example.test/r1', 'body' => 'AI summarizes selected posts into a draft.' ],
			[ 'title' => 'Editorial Assistant GA', 'url' => 'https://example.test/r2', 'body' => 'Inline AI assistance in the editor.' ],
		];
	}

	/**
	 * Describe the node for the console palette, the Inspector and `help`.
	 *
	 * Declaring the `requests` entry is the whole wiring TICK needs: it gives
	 * the Inspector a TM_REQUEST button firing what the REPL types as
	 * `request_node releases TICK`. `accepts_fill` stays true because the node
	 * acts on a message arriving at `fill()` — the request itself — though it
	 * only ever mints items. It declares no `commands`, since a runtime trigger
	 * never becomes a TM_COMMAND verb.
	 *
	 * @return array<string,mixed> The base schema with this node's entries merged over it.
	 */
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
