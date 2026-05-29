<?php
/**
 * Releases_Source_Node: emits canned "release notes" items on `tick`.
 *
 * @package Newspack_AI_Newsletter
 */

namespace Newspack_AI_Newsletter;

use Newspack_Nodes\Node;
use Newspack_Nodes\Message;
use Newspack_Nodes\Command_Interpreter_Node;

\defined( 'ABSPATH' ) || exit;

class Releases_Source_Node extends Node {

	/** The ONE seam a real source replaces: return ingest items. Toy = canned. */
	protected function items(): array {
		return [
			[ 'title' => 'Roundup Block ships', 'url' => 'https://example.test/r1', 'body' => 'AI summarizes selected posts into a draft.' ],
			[ 'title' => 'Editorial Assistant GA', 'url' => 'https://example.test/r2', 'body' => 'Inline AI assistance in the editor.' ],
		];
	}

	/** `tick` handler: emit each item as a TM_STRUCT message, tagged with this source. */
	public function cmd_tick(): string {
		$count = 0;
		foreach ( $this->items() as $item ) {
			$msg                   = Message::new_message();
			$msg[ Message::TYPE ]  = Message::TM_STRUCT;
			$msg[ Message::FROM ]  = $this->name;
			$msg[ Message::VALUE ] = [ 'source' => 'releases' ] + $item;
			// parent::fill stamps TO from a connect_node-set target, then forwards to sink.
			parent::fill( $msg );
			++$count;
		}
		return "emitted $count item(s)";
	}

	public static function node_schema(): array {
		return \array_merge( parent::node_schema(), [
			'category'     => 'Source',
			'description'  => 'Emits canned release-notes items on tick.',
			'arguments'    => [],
			'commands'     => [
				[
					'name'        => 'tick',
					'description' => 'Emit the current batch of items.',
					'args'        => [],
					// Auto-wired into the sibling `{node}:config` CI by Node::__construct().
					'handler'     => static fn ( Command_Interpreter_Node $ci, string $args ): string => $ci->patron()->cmd_tick(),
				],
			],
			'accepts_fill' => false,
			'has_target'   => true,
		] );
	}
}
