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
 * That coupling is the point. Tee and Tap each carried a byte-identical copy of
 * the prune inside `fill()`; the minters that sign one command per spoke need
 * the same list, and a copy that forgot to prune would keep minting — and
 * signing — commands addressed at nodes that no longer exist.
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

trait Fanout_Targets {

	/**
	 * Get/set the target LIST. Normalizes on read so a fan-out never reports the
	 * scalar `''` that Node initializes: consumers would otherwise each have to
	 * remember a constructor line, and forgetting it is invisible until someone
	 * reads target() directly.
	 *
	 * @param string|array<int,string>|null $value New target (null = getter).
	 * @return list<string>
	 */
	public function target( $value = null ) {
		$this->target = Node::target_list( null !== $value ? $value : $this->target );
		return $this->target;
	}

	/**
	 * Add a target. Accumulates rather than replaces, and tolerates a scalar
	 * target assigned before the first connect (a graph may `arguments()` one in).
	 */
	public function connect_node( string $target ): void {
		$this->target = Node::target_list( $this->target );
		if ( ! \in_array( $target, $this->target, true ) ) {
			$this->target[] = $target;
		}
	}

	/** Remove one target; an empty name clears the list. */
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
	 * addresses and discards the remainder — which is why the dispatch loops stay
	 * separate rather than becoming one loop with a flag.
	 */
	protected function target_path( string $target, string $remainder ): string {
		return '' === $remainder ? $target : $target . '/' . $remainder;
	}

	/**
	 * Whether a newly-caught throwable should displace the one already deferred.
	 *
	 * A fan-out attempts every target and re-throws afterwards, so several may
	 * fail in one pass and only one can escape. The winner is the one whose
	 * handling is safest, because that choice moves the consumer cursor:
	 *
	 *   plain Worker_Should_Stop  → replay the message (cursor stays)
	 *   Worker_Should_Stop_Clean  → commit PAST it (cursor advances)
	 *   anything else             → poison, dead-letter, cursor advances
	 *
	 * Advancing past a message that needed a replay loses it; replaying a clean
	 * one is a duplicate, which at-least-once tolerates. So a plain stop outranks
	 * both. See tests/unit/TeeStopPrecedenceTest.php — this reverses an earlier
	 * deliberate rule and carries a named revert signal.
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
	 * @return list<string>
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
