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
 * An entry whose node answers `Node::members()` with a list stands for those
 * members: `live_targets()` expands it to one delivered target per member,
 * which is how a minter signs one command per spoke through a single
 * `connect_node( $group )` rather than one per spoke.
 *
 * The minters' dispatch loop IS here, as `send_signed()`: each mints its own
 * command per spoke, so they share one contract. Tee's and Tap's loops are
 * not. Tee prepends the remaining path so routing continues past the hop; Tap
 * hard-addresses and then passes the original through. Both attempt every
 * target, defer the throwable `outranks()` selects, and re-throw it after the
 * loop (ADR-14). Those are different contracts, not one contract with a flag.
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
	 * Mint one `<verb>` command per live target, addressed `<target>/<to>` and
	 * signed under that spoke's own session key, then fill it into the sink.
	 * Drops silently when the node has no sink.
	 *
	 * Signing happens per spoke because the key chosen IS the destination
	 * binding (ADR-15): one command re-addressed to N spokes after the mint
	 * would verify nowhere. A spoke with no session yet is skipped AND asked to
	 * handshake, since every minter refuses to queue unsigned and nothing else
	 * would ask. The skip is logged only past the first 30 seconds of uptime,
	 * while a session still being established is not worth a line.
	 *
	 * @param string       $to        Path below each spoke target the command addresses.
	 * @param string       $verb      Command name the spoke's interpreter runs.
	 * @param list<string> $arguments Command argument tokens.
	 */
	protected function send_signed( string $to, string $verb, array $arguments ): void {
		$sink = $this->sink;
		if ( null === $sink ) {
			return;
		}
		foreach ( $this->live_targets() as $target ) {
			$egress = $this->egress_for( $target );
			$spoke  = $egress?->vault_id() ?? '';
			if ( '' === $spoke || ! Command_Auth::has_session( $spoke ) ) {
				if ( (int) ( Core::$now - Core::$init_time ) > 30 ) {
					$this->print_less_often( 'no session for ', $target, '; skipping' );
				}
				// Skipping alone deadlocks: someone must ask for the handshake.
				$egress?->ensure_session();
				continue;
			}
			$out                   = Message::new_message();
			$out[ Message::TYPE ]  = Message::TM_COMMAND;
			$out[ Message::FROM ]  = $this->name;
			$out[ Message::TO ]    = $this->target_path( $target, $to );
			$out[ Message::VALUE ] = [
				'name'      => $verb,
				'arguments' => $arguments,
			];
			Command_Auth::sign_for( $spoke, $out );
			$sink->fill( $out );
		}
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
		return Message::join_path( $target, $remainder );
	}

	/**
	 * The targets that still resolve, pruned in place and with every entry
	 * standing for members expanded into them. A target is alive when the
	 * HEAD segment of its path names a live node — Router peels the rest, so
	 * `spoke/settings` survives as long as `spoke` does. The STORED list keeps
	 * the group's own name; only the returned list is expanded, which is how a
	 * minter signs one command per spoke through a group with one `connect_node`.
	 *
	 * CONNECT order is preserved, and that is contractual: a consumer may depend
	 * on an earlier target having been fully delivered before a later one is.
	 * The JS port says the same, where `addSliceFetcher` rests on it.
	 *
	 * @return list<string> The targets whose head still resolves, in connect
	 *                       order, group entries expanded to their members.
	 */
	protected function live_targets(): array {
		// Inline array test, not Core::arr, so phpstan narrows the property.
		$targets   = \is_array( $this->target ) ? $this->target : [];
		$alive     = [];
		$delivered = [];
		foreach ( $targets as $t ) {
			$target = Core::as_string( $t );
			$paths  = $this->delivered_paths( $target );
			if ( null !== $paths ) {
				$alive[] = $target;
				\array_push( $delivered, ...$paths );
			}
		}
		$this->target = $alive;
		return $delivered;
	}

	/**
	 * The paths one target delivers to, resolving its head once: each member's
	 * name carrying the rest when the head stands for members, the target
	 * itself when it stands for itself, and null when the head is gone.
	 *
	 * @param string $target A target, possibly a `<node>/<rest>` path.
	 * @return list<string>|null
	 */
	private function delivered_paths( string $target ): ?array {
		[ $head, $rest ] = Message::split_first( $target );
		$node            = Core::node( $head );
		if ( null === $node ) {
			return null;
		}
		$members = $node->members();
		return null === $members ? [ $target ] : \array_map( static fn ( Node $member ): string => Message::join_path( $member->name(), $rest ), $members );
	}

	/**
	 * Every member of every target standing for members: the destinations it
	 * writes that its stored target list names only by group (ADR-19).
	 *
	 * @return list<string>
	 */
	protected function extra_targets(): array {
		$out = [];
		foreach ( Node::target_list( $this->target ) as $target ) {
			$paths = $this->delivered_paths( Core::as_string( $target ) ) ?? [];
			if ( [ $target ] !== $paths ) {
				\array_push( $out, ...$paths );
			}
		}
		return $out;
	}

	/**
	 * The HTTP_Out a target names, or null; a target may be a path, so resolve
	 * its head. Every minter that signs per spoke asks here.
	 *
	 * @param string $target The live target, possibly a `<node>/<rest>` path.
	 */
	protected function egress_for( string $target ): ?HTTP_Out_Node {
		[ $head ] = Message::split_first( $target );
		$node     = Core::node( $head );
		return $node instanceof HTTP_Out_Node ? $node : null;
	}
}
