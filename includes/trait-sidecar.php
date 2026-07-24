<?php
/**
 * Sidecar: build a hidden Partition that belongs to a node.
 *
 * The offsetlog and the dead-letter queue are the same thing wearing different
 * geometry — a named, patron-linked Partition that a node owns, whose dir is an
 * ARGUMENT (empty disables it) and whose sink is its patron's. This is that
 * shape, once.
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes;

\defined( 'ABSPATH' ) || exit;

trait Sidecar {

	/**
	 * Build a sidecar Partition: named, patron-linked, geometry applied, sinking
	 * where its patron sinks. That last part is the whole routing story — make_node
	 * sinks every node into _command_interpreter and flow is steered by target(), so
	 * inheriting the patron's sink IS how a sidecar's replies get back out.
	 *
	 * @param string             $dir      Segment directory.
	 * @param string             $name     Node name; '' leaves it unnamed.
	 * @param array<int, int>    $geometry segment_size, then the five retention axes
	 *                                     (min_segments, num_segments, min_lifetime, lifetime, max_segments).
	 */
	protected function make_sidecar( string $dir, string $name, array $geometry ): Partition_Node {
		$partition = new Partition_Node();
		if ( '' !== $name ) {
			$partition->name( $name );
		}
		$partition->patron( $this );
		$partition->arguments( \array_map( '\strval', [ $dir, ...$geometry ] ) );
		$partition->sink( $this->sink );
		// A sidecar quarantining its own writes would recurse ([159]).
		$partition->without_write_deadletter();
		return $partition;
	}
}
