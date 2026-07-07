<?php
namespace Newspack_Nodes\Tests;

use Newspack_Nodes\Dumper_Node;
use Newspack_Nodes\Message;

// Extends Dumper_Node (itself a Node) so it satisfies `instanceof Dumper_Node`
// gates — e.g. Shell::stdout() routes builtin output to the `_output` node only
// when it is a Dumper. fill() is overridden to capture the raw Message instead
// of rendering, so tests assert on the message, not on rendered terminal text.
class Capture_Sink_Node extends Dumper_Node {
	/** @var array<int,array> */
	public array $captured = [];

	public function fill( array $message ): void {
		++$this->counter;
		$size = Message::packed_size( $message );
		if ( $size > $this->largest_msg_sent ) {
			$this->largest_msg_sent = $size;
		}
		$this->captured[] = $message;
	}

	public static function node_schema(): array {
		return [
			'category'    => 'Hidden',
			'description' => 'Test fixture — captures messages in-memory for assertions.',
			'arguments'        => [],
			'commands'       => [],
		];
	}
}
