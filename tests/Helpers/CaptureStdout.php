<?php
namespace Newspack_Nodes\Tests;

use Newspack_Nodes\Message;
use Newspack_Nodes\Stdout_Node;

// Extends Stdout_Node so it satisfies the `instanceof Stdout_Node` gate in
// Shell_Node::stdout(), which routes builtin output to `_stdout`. fill() is
// overridden to capture the raw Message instead of fwriting it, so tests assert
// on the message rather than on terminal bytes.
class Capture_Stdout_Node extends Stdout_Node {
	/** @var array<int,array> */
	public array $captured = [];

	/** The paired `_output` Dumper, for tests that assert on its dial. */
	public ?\Newspack_Nodes\Dumper_Node $dumper = null;

	public function __construct() {
		parent::__construct( \fopen( 'php://memory', 'w+' ) );
	}

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
			'description' => 'Test fixture — captures `_stdout` messages in-memory for assertions.',
			'arguments'   => [],
			'commands'    => [],
		];
	}
}
