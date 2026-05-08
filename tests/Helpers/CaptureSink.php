<?php
namespace Newspack_Nodes\Tests;

use Newspack_Nodes\Node;

class CaptureSink extends Node {
	/** @var array<int,array> */
	public array $captured = [];

	public function fill( array &$message ): void {
		++$this->counter;
		$this->captured[] = $message;
	}
}
