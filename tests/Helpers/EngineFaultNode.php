<?php
namespace Newspack_Nodes\Tests;

use Newspack_Nodes\Node;

/**
 * A node whose graph facts raise an engine TypeError, so a topology making
 * one does not read, and the reader sees an `\Error` where a refusal stood.
 */
final class Engine_Fault_Node extends Node {

	public static function graph_facts( array $args, array $commands ): array {
		return ( static fn ( int $n ): array => [ 'n' => $n ] )( 'kea-6604' );
	}
}
