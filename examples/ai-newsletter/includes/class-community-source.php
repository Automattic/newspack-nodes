<?php
/**
 * Community_Source_Node: emits canned "community news" items on `tick`.
 *
 * @package Newspack_AI_Newsletter
 */

namespace Newspack_AI_Newsletter;

use Newspack_Nodes\Node;
use Newspack_Nodes\Message;
use Newspack_Nodes\Command_Interpreter_Node;

\defined( 'ABSPATH' ) || exit;

class Community_Source_Node extends Node {

	public function __construct() {
		$ci = new Command_Interpreter_Node();
		$ci->patron( $this );
		$ci->commands( $this->config_verbs() );
		$this->attach_interpreter( $ci );
	}

	/** The ONE seam a real source replaces: return ingest items. Toy = canned. */
	protected function items(): array {
		return [
			[ 'title' => 'Reader forum hits 10k members', 'url' => 'https://example.test/c1', 'body' => 'The publisher community forum crossed ten thousand members this week.' ],
			[ 'title' => 'Local meetup recap', 'url' => 'https://example.test/c2', 'body' => 'Highlights from the latest in-person reader meetup downtown.' ],
			[ 'title' => 'Volunteer spotlight', 'url' => 'https://example.test/c3', 'body' => 'A community moderator shares why they give their time.' ],
		];
	}

	/** `tick` handler: emit each item as a TM_STRUCT message, tagged with this source. */
	public function cmd_tick(): string {
		$count = 0;
		foreach ( $this->items() as $item ) {
			$msg                   = Message::new_message();
			$msg[ Message::TYPE ]  = Message::TM_STRUCT;
			$msg[ Message::FROM ]  = $this->name;
			$msg[ Message::VALUE ] = [ 'source' => 'community' ] + $item;
			$this->sink?->fill( $msg );
			++$count;
		}
		return "emitted $count item(s)";
	}

	/** @return array<string,callable> */
	private function config_verbs(): array {
		return [
			'tick' => function ( Command_Interpreter_Node $self, string $args ) {
				return $this->cmd_tick();
			},
		];
	}

	public static function node_schema(): array {
		return [
			'category'     => 'Source',
			'description'  => 'Emits canned publisher-community news items on tick.',
			'ctor'         => [],
			'verbs'        => [
				[ 'name' => 'tick', 'description' => 'Emit the current batch of items.', 'args' => [] ],
			],
			'accepts_fill' => false,
			'has_target'   => true,
		];
	}
}
