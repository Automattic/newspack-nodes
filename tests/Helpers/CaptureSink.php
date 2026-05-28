<?php
namespace Newspack_Nodes\Tests;

use Newspack_Nodes\Message;
use Newspack_Nodes\Node;

class Capture_Sink_Node extends Node {
	/** @var array<int,array> */
	public array $captured = [];

	public function fill( array &$message ): void {
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
