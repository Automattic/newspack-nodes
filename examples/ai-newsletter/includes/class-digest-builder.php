<?php
/**
 * Digest_Builder_Node: accumulates summaries; `flush` emits a markdown draft.
 *
 * @package Newspack_AI_Newsletter
 */

namespace Newspack_AI_Newsletter;

use Newspack_Nodes\Node;
use Newspack_Nodes\Message;
use Newspack_Nodes\Command_Interpreter_Node;

\defined( 'ABSPATH' ) || exit;

class Digest_Builder_Node extends Node {

	/** @var array<int,array<string,mixed>> Accumulated summarized items. */
	private array $items = [];

	public function __construct() {
		$ci = new Command_Interpreter_Node();
		$ci->patron( $this );
		$ci->commands( $this->config_verbs() );
		$this->attach_interpreter( $ci );
	}

	public function fill( array &$message ): void {
		if ( 0 === ( $message[ Message::TYPE ] & Message::TM_STRUCT ) ) {
			return;
		}
		$this->items[] = $message[ Message::VALUE ];
		++$this->counter;
	}

	/** `flush` handler: render accumulated summaries to markdown, emit, clear. */
	public function cmd_flush(): string {
		$lines = [ '# Newsletter draft', '' ];
		foreach ( $this->items as $item ) {
			$lines[] = '- ' . ( $item['summary'] ?? '' );
		}
		$draft = \implode( "\n", $lines ) . "\n";

		$msg                   = Message::new_message();
		$msg[ Message::TYPE ]  = Message::TM_BYTESTREAM;
		$msg[ Message::FROM ]  = $this->name;
		$msg[ Message::VALUE ] = $draft;
		// parent::fill stamps TO from a connect_node-set target, then forwards to sink.
		parent::fill( $msg );

		$n           = \count( $this->items );
		$this->items = [];
		return "flushed $n summary(ies)";
	}

	/** @return array<string,callable> */
	private function config_verbs(): array {
		return [
			'flush' => function ( Command_Interpreter_Node $self, string $args ) {
				return $this->cmd_flush();
			},
		];
	}

	public static function node_schema(): array {
		return [
			'category'     => 'Transform',
			'description'  => 'Accumulates summaries; flush emits a markdown newsletter draft.',
			'ctor'         => [],
			'commands'        => [
				[ 'name' => 'flush', 'description' => 'Emit the accumulated draft and clear.', 'args' => [] ],
			],
			'accepts_fill' => true,
			'has_target'   => true,
		];
	}
}
