<?php
/**
 * Fanout_Targets: a target LIST that prunes itself on use.
 *
 * `Node::connect_node()` assigns a single target — correct for a node with one
 * next hop. A node that fans out needs many, and needs dead ones to disappear:
 * a spoke gets removed, an egress node gets renamed, and the entry must not
 * linger. Liveness is therefore a property of READING the list, not of a
 * separate sweep — `live_targets()` prunes and writes back on every call, so
 * there is no way to consume the list and skip the prune.
 *
 * That coupling is the point. Tee, Tap and the minters that sign one command per
 * spoke all reach the list through this one method; a private copy that forgot
 * to prune would keep minting — and signing — commands addressed at nodes that
 * no longer exist.
 *
 * What is deliberately NOT here: the dispatch loop. Tee prepends the remaining
 * path so routing continues past the hop; Tap hard-addresses and then passes the
 * original through. Both attempt every target, defer the throwable `outranks()`
 * selects, and re-throw it after the loop (ADR-14). Those are different
 * contracts, not one contract with a flag.
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes;

\defined( 'ABSPATH' ) || exit;

/**
 * Fan-out mixin: the target LIST, and the failure contract every fan-out shares.
 *
 * Using the trait IS the declaration that a node fans out — `Core::class_fans_out()`
 * tests for it rather than for descent from `Tee_Node`, because the minters that
 * sign one command per spoke are `Timer_Node` subclasses. A user therefore holds
 * a target LIST, and every `connect_node()` after the first accumulates.
 */
trait Fanout_Targets {

	/**
	 * Get or set the target LIST, narrowing `Node::target()`'s scalar-or-array
	 * answer to a list. Normalizing on read is what keeps a fan-out from ever
	 * reporting the scalar `''` that Node initializes: a user would otherwise
	 * have to remember a constructor line, and forgetting it stays invisible
	 * until something reads `target()` directly.
	 *
	 * @param string|array<int,string>|null $value New target (null = getter).
	 * @return list<string> Every target, in connect order.
	 */
	public function target( $value = null ) {
		$this->target = Node::target_list( null !== $value ? $value : $this->target );
		return $this->target;
	}

	/**
	 * Add a target, accumulating where `Node::connect_node()` replaces, and
	 * ignoring a name the list already holds.
	 *
	 * The list is normalized first because the field may still hold the scalar a
	 * graph assigned before the first connect (`arguments()` can carry one in).
	 *
	 * @param string $target Path stamped into an empty TO.
	 */
	public function connect_node( string $target ): void {
		$this->target = Node::target_list( $this->target );
		if ( ! \in_array( $target, $this->target, true ) ) {
			$this->target[] = $target;
		}
	}

	/**
	 * Remove one target; an empty name clears the list, as does a field still
	 * holding the base class's scalar — one target offers no single entry to
	 * remove, so clearing it matches `Node::disconnect_node()`.
	 *
	 * @param string $target The entry to remove; an empty name clears the list.
	 */
	public function disconnect_node( string $target = '' ): void {
		if ( ! \is_array( $this->target ) || '' === $target ) {
			$this->target = [];
			return;
		}
		$this->target = \array_values( \array_filter( $this->target, static fn ( $t ): bool => $t !== $target ) );
	}

	/**
	 * Address a message at one target, keeping whatever path remains routable:
	 * Router peels the head, so the remainder continues past this hop.
	 *
	 * Tee and every minter that fans out address this way. Tap does not — it hard-
	 * addresses each copy at the bare target and drops the remainder — which is
	 * why the dispatch loops stay separate rather than becoming one loop with a
	 * flag.
	 *
	 * @param string $target    The target this copy is addressed at.
	 * @param string $remainder What the incoming TO held; empty when it carried none.
	 * @return string `<target>/<remainder>`, or the target alone when the remainder is empty.
	 */
	protected function target_path( string $target, string $remainder ): string {
		return '' === $remainder ? $target : $target . '/' . $remainder;
	}

	/**
	 * Whether a newly-caught throwable should displace the one already deferred.
	 *
	 * A fan-out attempts every target and re-throws afterwards, so several may
	 * fail in one pass and only one can escape. The winner is the one whose
	 * handling is safest, because that choice moves the consumer cursor. A plain
	 * `Worker_Should_Stop` replays the message and the cursor stays put;
	 * `Worker_Should_Stop_Clean` commits past it; anything else is poison, which
	 * dead-letters and advances too.
	 *
	 * Advancing past a message that needed a replay loses it; replaying a clean
	 * one is a duplicate, which at-least-once tolerates. So a plain stop outranks
	 * both, in either arrival order, and `tests/unit/TeeStopPrecedenceTest.php`
	 * pins that (ADR-14).
	 *
	 * @param \Throwable      $candidate The throwable this target just raised.
	 * @param \Throwable|null $deferred  What the loop already holds; null until the first failure.
	 * @return bool True when `$candidate` should take the deferred slot.
	 */
	protected function outranks( \Throwable $candidate, ?\Throwable $deferred ): bool {
		if ( null === $deferred ) {
			return true;
		}
		return $candidate instanceof Worker_Should_Stop
			&& ( ! ( $deferred instanceof Worker_Should_Stop )
				|| $deferred instanceof Worker_Should_Stop_Clean );
	}

	/**
	 * The targets that still resolve, pruned in place. A target is alive when the
	 * HEAD segment of its path names a live node — Router peels the rest, so
	 * `spoke/settings` survives as long as `spoke` does.
	 *
	 * CONNECT order is preserved, and that is contractual: a consumer may depend
	 * on an earlier target having been fully delivered before a later one is.
	 * The JS port says the same, where `addSliceFetcher` rests on it.
	 *
	 * @return list<string> The targets whose head still resolves, in connect order.
	 */
	protected function live_targets(): array {
		// Inline array test, not Core::arr, so phpstan narrows the property.
		$targets = \is_array( $this->target ) ? $this->target : [];
		$alive   = [];
		foreach ( $targets as $t ) {
			[ $head ] = Message::split_first( Core::as_string( $t ) );
			if ( null !== Core::node( $head ) ) {
				$alive[] = Core::as_string( $t );
			}
		}
		$this->target = $alive;
		return $alive;
	}
}
