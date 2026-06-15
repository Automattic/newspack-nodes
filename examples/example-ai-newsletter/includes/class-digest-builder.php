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
	use \Newspack_Nodes\Schema_Reflection;

	/** @var array<int,array<array-key,mixed>> Accumulated summarized items (array-key: they round-trip through offsetlog JSON). */
	private array $items = [];

	/** Wire the sibling {name}:config interpreter so the `flush` verb is dispatchable. */
	public function __construct() {
		parent::__construct();
		$this->auto_wire_interpreter();
	}

	public function fill( array &$message ): void {
		/** @var int $type */
		$type = $message[ Message::TYPE ];
		if ( 0 === ( $type & Message::TM_STRUCT ) ) {
			return;
		}
		$value = $message[ Message::VALUE ];
		if ( ! \is_array( $value ) ) {
			return;
		}
		/** @var array<string,mixed> $value */
		$this->items[] = $value;
		++$this->counter;
	}

	/** `flush` handler: render accumulated summaries to markdown, emit, clear. */
	public function cmd_flush(): string {
		$lines = [ '# Newsletter draft', '' ];
		foreach ( $this->items as $item ) {
			$summary = $item['summary'] ?? '';
			$lines[] = '- ' . ( \is_string( $summary ) ? $summary : '' );
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

	/**
	 * Snapshot contract: the accumulated items the Consumer co-commits into its
	 * offsetlog (via `set_snapshot_node digest`), so a respawned worker restores
	 * this in lockstep with the cursor. Bounded — keep the digest small.
	 *
	 * @return array{items: array<int,array<array-key,mixed>>}
	 */
	public function save_state(): array {
		return [ 'items' => $this->items ];
	}

	/**
	 * Restore the accumulated items from a snapshot cache. Tolerates a malformed
	 * payload (resets to empty, drops non-array items) rather than fataling a
	 * fresh worker on boot.
	 *
	 * @param array<string,mixed> $state
	 */
	public function restore_state( array $state ): void {
		$this->items = [];
		$items       = $state['items'] ?? null;
		if ( ! \is_array( $items ) ) {
			return;
		}
		foreach ( $items as $item ) {
			if ( \is_array( $item ) ) {
				$this->items[] = $item;
			}
		}
	}

	public static function node_schema(): array {
		return \array_merge( parent::node_schema(), [
			'category'     => 'Transform',
			'description'  => 'Accumulates summaries; flush emits a markdown newsletter draft.',
			'arguments'    => [],
			'commands'     => [
				[
					'name'        => 'flush',
					'description' => 'Emit the accumulated draft and clear.',
					'args'        => [],
					// Dispatched via the {node}:config interpreter (auto_wire_interpreter() in __construct).
					'handler'     => static function ( Command_Interpreter_Node $interpreter, string $args ): string {
						/** @var self $patron */
						$patron = $interpreter->patron();
						return $patron->cmd_flush();
					},
				],
			],
			'accepts_fill' => true,
			'has_target'   => true,
		] );
	}
}
