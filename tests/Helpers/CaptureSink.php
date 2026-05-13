<?php
namespace Newspack_Nodes\Tests;

use Newspack_Nodes\Message;
use Newspack_Nodes\Node;

class CaptureSink extends Node {
	/** @var array<int,array> */
	public array $captured = [];

	public function fill( array &$message ): void {
		++$this->counter;
		$size = Message::value_size( $message );
		if ( $size > $this->largest_msg_sent ) {
			$this->largest_msg_sent = $size;
		}
		$this->captured[] = $message;
	}
}
