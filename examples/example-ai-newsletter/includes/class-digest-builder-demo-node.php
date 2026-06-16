<?php
/**
 * Digest_Builder_Demo_Node: accumulates summaries; a FLUSH request emits a markdown draft.
 *
 * @package Example_AI_Newsletter
 */

namespace Example_AI_Newsletter;

use Newspack_Nodes\Node;
use Newspack_Nodes\Message;

\defined( 'ABSPATH' ) || exit;

class Digest_Builder_Demo_Node extends Node {

	/** @var array<int,array<array-key,mixed>> Accumulated summarized items (array-key: they round-trip through offsetlog JSON). */
	private array $items = [];

	/**
	 * FLUSH is a runtime trigger: a TM_REQUEST handled here in fill() (NOT a
	 * TM_COMMAND verb — that flag is for startup/admin). A TM_STRUCT message is
	 * data to accumulate; everything else is ignored.
	 *
	 * @param array<int, mixed> $message Message reference.
	 */
	public function fill( array &$message ): void {
		$type = \is_numeric( $message[ Message::TYPE ] ) ? (int) $message[ Message::TYPE ] : 0;
		if ( $type & Message::TM_REQUEST ) {
			$this->handle_request( $message );
			return;
		}
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

	/**
	 * FLUSH handler: render accumulated summaries to markdown, emit, clear, then reply with the count.
	 *
	 * @param array<int, mixed> $message Incoming request Message.
	 */
	private function handle_request( array $message ): void {
		$lines = [ '# Newsletter draft', '' ];
		foreach ( $this->items as $item ) {
			$summary = $item['summary'] ?? '';
			$lines[] = '- ' . ( \is_string( $summary ) ? $summary : '' );
		}
		$draft = \implode( "\n", $lines ) . "\n";

		$response                   = Message::new_message();
		$response[ Message::TYPE ]  = Message::TM_BYTESTREAM;
		$response[ Message::FROM ]  = $this->name;
		$response[ Message::VALUE ] = $draft;
		// parent::fill stamps TO from a connect_node-set target, then forwards to sink.
		parent::fill( $response );
		$this->items = [];
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
			'description'  => 'Accumulates summaries; a FLUSH request emits a markdown newsletter draft (request_node digest FLUSH).',
			'arguments'    => [],
			'requests'     => [
				[
					'name'        => 'FLUSH',
					'description' => 'Emit the accumulated draft and clear. Trigger with `request_node digest FLUSH`.',
					'reply_shape' => '{ flushed }',
				],
			],
			'accepts_fill' => true,
			'has_target'   => true,
		] );
	}
}
