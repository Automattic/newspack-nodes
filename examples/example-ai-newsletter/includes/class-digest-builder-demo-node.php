<?php
/**
 * The digest pipeline's accumulator, and the walkthrough's worked example of the
 * two contracts a stateful node honors: a TM_REQUEST runtime trigger, and a
 * save_state/restore_state snapshot the Consumer co-commits with its cursor.
 *
 * @package Example_AI_Newsletter
 */

namespace Example_AI_Newsletter;

use Newspack_Nodes\Core;
use Newspack_Nodes\Node;
use Newspack_Nodes\Message;
use Newspack_Nodes\Schema_Reflection;

\defined( 'ABSPATH' ) || exit;

/**
 * Accumulates each scored item the Consumer tails in, and emits one markdown draft
 * when a FLUSH request arrives.
 *
 * Nothing reaches the sink between flushes — the request is what produces output.
 * Those held items are the only record of work the Consumer has already read, so
 * they ride its offsetlog frame as a snapshot (`add_snapshot_node digest` in the
 * topology): a respawned worker restores the digest in lockstep with the cursor
 * instead of dropping everything read since the last flush.
 *
 * A draft can exceed PIPE_BUF, so the topology lifts the 4KB write cap on
 * `digest:log` with `void_warranty` (ADR-4).
 */
class Digest_Builder_Demo_Node extends Node {
	use Schema_Reflection;

	/**
	 * Accumulated summarized items, oldest first, emptied by every flush.
	 *
	 * The inner keys are `array-key` rather than `string` because the items
	 * round-trip through the offsetlog's JSON, and a numeric-looking key comes
	 * back from `json_decode` as an int.
	 *
	 * @var array<int,array<array-key,mixed>>
	 */
	private array $items = [];

	/**
	 * Answer a TM_REQUEST, accumulate a TM_STRUCT item, ignore everything else.
	 *
	 * FLUSH is a runtime trigger, so it arrives as a TM_REQUEST rather than as a
	 * TM_COMMAND verb on the `:config` interpreter: commands build and
	 * administer a graph, requests drive one that already runs.
	 * `answer_request()` answers it from the schema. A TM_STRUCT whose VALUE is
	 * not an array is dropped rather than accumulated, because the renderer
	 * reads `summary` off each item. The numeric guard casts TYPE before the
	 * bitwise test, so a TYPE that is not numeric reads as 0 and matches no
	 * gate.
	 *
	 * @param array<int,mixed> $message The 7-field positional message array.
	 */
	public function fill( array $message ): void {
		if ( $this->answer_request( $message ) ) {
			return;
		}
		$type = \is_numeric( $message[ Message::TYPE ] ) ? (int) $message[ Message::TYPE ] : 0;
		if ( ! ( $type & Message::TM_STRUCT ) ) {
			return;
		}
		$value = $message[ Message::VALUE ];
		if ( ! \is_array( $value ) ) {
			return;
		}
		/** @var array<string,mixed> $value */
		$this->items[] = $value;
		// parent::fill does the counting, and this branch never calls it.
		++$this->counter;
	}

	/**
	 * Render the accumulated summaries to markdown, emit the draft, clear, then
	 * report the number flushed.
	 *
	 * An item whose `summary` is missing or not a string renders as an empty
	 * bullet rather than being skipped.
	 *
	 * The draft leaves with an empty TO, which is what lets parent::fill stamp it
	 * from `target` and hand it to the sink. The returned count is the reply's
	 * `data`.
	 *
	 * @return array{flushed:int} The FLUSH reply data.
	 */
	private function flush(): array {
		$lines = [ '# Newsletter draft', '' ];
		foreach ( $this->items as $item ) {
			$summary = $item['summary'] ?? '';
			$lines[] = '- ' . Core::str( $summary );
		}
		$draft   = \implode( "\n", $lines ) . "\n";
		$flushed = \count( $this->items );

		$response                   = Message::new_message();
		$response[ Message::TYPE ]  = Message::TM_BYTESTREAM;
		$response[ Message::FROM ]  = $this->name;
		$response[ Message::VALUE ] = $draft;
		parent::fill( $response );
		$this->items = [];
		return [ 'flushed' => $flushed ];
	}

	/**
	 * The snapshot the Consumer co-commits into its offsetlog frame beside the
	 * cursor (`add_snapshot_node digest`), so a respawned worker restores these
	 * items at the position they were read from.
	 *
	 * Keep the digest bounded: every checkpoint the Consumer writes carries this
	 * whole payload, however many items have accumulated since the last flush.
	 *
	 * The `items` key is a second contract. `Insights_CI_Demo_Node` reads it back
	 * off the committed frame through the substrate's
	 * `Partition_Node::read_latest_snapshot_cache()`, so the Publisher Insights
	 * dashboard renders without reaching a live worker.
	 *
	 * @return array{items: array<int,array<array-key,mixed>>}
	 */
	public function save_state(): array {
		return [ 'items' => $this->items ];
	}

	/**
	 * Restore the accumulated items from an offsetlog snapshot frame.
	 *
	 * Empties the list first and skips every non-array entry, so a malformed
	 * frame costs the digest rather than the boot of the worker reading it.
	 *
	 * @param array<string,mixed> $state A save_state() payload decoded from the frame.
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

	/**
	 * The palette entry, plus the FLUSH declaration that `help Digest_Builder_Demo`
	 * prints and the topology console renders as an Inspector button. It sits under
	 * `requests` rather than `commands`, which is what makes that button send
	 * `request_node` rather than `command_node`.
	 *
	 * @return array<string,mixed>
	 */
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
					'handler'     => static fn ( self $node ): array => $node->flush(),
				],
			],
			'accepts_fill' => true,
			'has_target'   => true,
		] );
	}
}
