<?php
/**
 * Summarizer_Demo_Node: the summarize stage of the example digest pipeline. One
 * item arrives, and the same item leaves carrying a summary line.
 *
 * The `_Demo` suffix keeps the shell name distinct from the `Summarizer` that
 * newspack-intelligence registers: `resolve_class()` walks the registered
 * namespaces in order and caches the first `{prefix}Summarizer_Node` it finds, so
 * one shared name would hand both topologies whichever plugin registered first.
 *
 * @package Example_AI_Newsletter
 */

namespace Example_AI_Newsletter;

use Newspack_Nodes\Core;
use Newspack_Nodes\Node;
use Newspack_Nodes\Message;

\defined( 'ABSPATH' ) || exit;

/**
 * A transform that knows nothing about sources: a TM_STRUCT item arrives, gains a
 * `summary` key, and goes on to the sink. That source-agnosticism is what lets
 * `releases` and `community` both fan into one summarizer, and it confines a real
 * summarizer — an LLM call, say — to summarize().
 */
class Summarizer_Demo_Node extends Node {

	/**
	 * Summarize the incoming item and emit it as a fresh TM_STRUCT message stamped
	 * FROM this node. A message that is not TM_STRUCT, or whose VALUE is not an
	 * array, is ignored: a pure transform carries no verbs and no requests.
	 *
	 * The fresh message leaves with an empty TO, which `parent::fill()` stamps from
	 * `target` when one is wired — `connect_node summarizer scorer` in the example
	 * topology — before forwarding to the sink.
	 *
	 * @param array<int,mixed> $message The inbound message.
	 */
	public function fill( array $message ): void {
		/** @var int $type */
		$type = $message[ Message::TYPE ];
		if ( ! ( $type & Message::TM_STRUCT ) ) {
			return;
		}
		$item = $message[ Message::VALUE ];
		if ( ! \is_array( $item ) ) {
			return;
		}
		/** @var array<string,mixed> $item */
		$item['summary'] = $this->summarize( $item );

		$out                   = Message::new_message();
		$out[ Message::TYPE ]  = Message::TM_STRUCT;
		$out[ Message::FROM ]  = $this->name;
		$out[ Message::VALUE ] = $item;
		// parent::fill — base, not $this, which would recurse.
		parent::fill( $out );
	}

	/**
	 * The ONE seam a real summarizer replaces. The demo builds the line from a
	 * template — the title, an em dash, and the first 80 characters of the body —
	 * so the example pipeline runs with no API key and no network. An absent or
	 * non-string title reads as `(untitled)`, and an absent or non-scalar body as
	 * the empty string. The body is copied verbatim, so a newline inside those 80
	 * characters reaches the digest, which renders each summary as one bullet.
	 *
	 * @param array<string,mixed> $item Item to summarize.
	 * @return string The summary line.
	 */
	protected function summarize( array $item ): string {
		$title = \is_string( $item['title'] ?? null ) ? $item['title'] : '(untitled)';
		$body  = Core::as_string( $item['body'] ?? null );
		return $title . ' — ' . \mb_substr( $body, 0, 80 );
	}

	/**
	 * Topology-console manifest: the palette tile and the node's configuration
	 * form. The node declares no positional arguments and no verbs, so wiring is
	 * its whole configuration.
	 *
	 * @return array<string,mixed>
	 */
	public static function node_schema(): array {
		return [
			'category'     => 'Transform',
			'description'  => 'Summarizes one item; emits the item plus a summary. Source-agnostic.',
			'arguments'    => [],
			'commands'     => [],
			'accepts_fill' => true,
			'has_target'   => true,
		];
	}
}
