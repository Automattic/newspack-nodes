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
use Newspack_Nodes\Schema_Reflection;

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
	use Schema_Reflection;

	/**
	 * Answer a TM_REQUEST and ignore every other type.
	 *
	 * TICK drives an already-running graph, so it arrives as a TM_REQUEST
	 * rather than as a TM_COMMAND verb on a sibling interpreter; TM_COMMAND is
	 * the startup and administration plane. `answer_request()` answers it from
	 * the schema. A source mints messages and consumes none, so anything that
	 * is not a request is dropped.
	 *
	 * @param array<int,mixed> $message The 7-field positional message array.
	 */
	public function fill( array $message ): void {
		$this->answer_request( $message );
	}

	/**
	 * Emit each item as its own TM_STRUCT message and report the count.
	 *
	 * The items go out fire-and-forget: nothing acknowledges them (ADR-3) and
	 * `fill()` returns nothing to inspect (ADR-13). The returned count is the
	 * reply's `data`.
	 *
	 * @return array{emitted:int} The TICK reply data.
	 */
	private function tick(): array {
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
		return [ 'emitted' => $emitted ];
	}

	/**
	 * Return the batch to emit.
	 *
	 * This is the ONE seam a real source replaces: override it with an HTTP
	 * fetch or a feed parse and the rest of the node is unchanged. Leave the
	 * `source` key out — `tick()` stamps it on, and its value wins
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
	 * Declaring the `requests` entry is the whole wiring TICK needs: it names
	 * the `handler`, and it gives the Inspector a TM_REQUEST button firing what
	 * the REPL types as `request_node releases TICK`. `accepts_fill` stays true
	 * because the node acts on a message arriving at `fill()` — the request
	 * itself — though it only ever mints items. It declares no `commands`, since
	 * a runtime trigger never becomes a TM_COMMAND verb.
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
					'handler'     => static fn ( self $node ): array => $node->tick(),
				],
			],
			'accepts_fill' => true,
			'has_target'   => true,
		] );
	}
}
