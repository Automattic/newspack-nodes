<?php
/**
 * Sidecar: build a hidden Partition that belongs to a node.
 *
 * The offsetlog and the dead-letter queue are the same thing wearing different
 * geometry — a patron-linked Partition that a node owns, whose dir is an
 * ARGUMENT (empty disables it) and whose sink is its patron's. This is that
 * shape, once, for the two traits that reach it: `Durable_Reader` builds the
 * offsetlog, `Dead_Letter_Queue` the quarantine. A using class must be a Node,
 * because the sidecar takes `$this` as its patron and copies the patron's own
 * sink. What happens to a sibling AFTER it is built — the slot it is published
 * into, the name collision check and the rename, sink and teardown cascades —
 * is the base Node's `publish_sibling()`.
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes;

\defined( 'ABSPATH' ) || exit;

trait Sidecar {

	/**
	 * Build an UNNAMED sidecar Partition: patron-linked, geometry applied, and
	 * seeded with the patron's current sink. This trait BUILDS; it does not
	 * maintain. The name comes from the slot it is published into —
	 * `publish_sibling( 'offsetlog' | 'deadletter', $sidecar )`, then assign
	 * the property — and keeping that name, the sink and teardown in step with
	 * the patron afterwards is the base Node's four cascades, which the
	 * publish enrols it in.
	 *
	 * Spell every geometry position: an omitted one takes the Partition
	 * schema's `<config:*>` default, which hands a sidecar whatever retention an
	 * operator picked for the data partitions.
	 *
	 * @param string    $dir      Segment directory — the Partition's first
	 *                            positional argument; segments land at
	 *                            `{dir}/{seg}.log`.
	 * @param list<int> $geometry segment_size, then the five retention axes
	 *                            (min_segments, num_segments, max_segments,
	 *                            min_lifetime, lifetime).
	 * @return Partition_Node The sidecar, built but not yet published.
	 */
	protected function make_sidecar( string $dir, array $geometry ): Partition_Node {
		$partition = new Partition_Node();
		$partition->patron( $this );
		$partition->arguments( \array_map( '\strval', [ $dir, ...$geometry ] ) );
		// Sole assignment when arguments() replays after the sink is wired.
		$partition->sink( $this->sink );
		// A sidecar quarantining its own writes would recurse ([159]).
		$partition->without_write_deadletter();
		return $partition;
	}

}
