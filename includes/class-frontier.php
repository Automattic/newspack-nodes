<?php
/**
 * Frontier: a work set kept in a node's own durable Table, or in the process.
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes;

\defined( 'ABSPATH' ) || exit;

/**
 * The work a node has yet to finish: a member is `add()`ed to `pending`,
 * `take()`n into `inflight` and gone once `settle()`d, in the owner's durable
 * Table or, with none, in the process; one writer per partition.
 */
final class Frontier {

	/** The set of members added and not yet taken. */
	public const PENDING = 'pending';

	/** The set of members taken and not yet settled. */
	public const INFLIGHT = 'inflight';

	/** Seconds a member waits in either set: one year, past any pass. */
	public const MEMBER_TTL = 31536000;

	/** Whether `inflight` has been returned to `pending` since this process built the frontier. */
	private bool $recovered = false;

	/** Whether `pending` may hold members; while false a take asks nothing. */
	private bool $pending_may_hold = true;

	/** @var array<array-key,mixed> Members added and not yet taken, by member, for a frontier with no Table. */
	private array $pending = [];

	/** @var array<array-key,mixed> Members this process took and has not settled, by member. */
	private array $inflight = [];

	/** @var list<string> Members settled since the Table last removed any. */
	private array $settled = [];

	/**
	 * Bind the frontier to its owner's client and Table, or to neither, to
	 * keep both sets in the process.
	 *
	 * @api A node keeping work: `Crawler_Node`, and newspack-intelligence's sources.
	 * @param Table_Client|null       $tables The owner's client, which its `fill()` hands every message first.
	 * @param (\Closure(): string)|null $table  The durable Table's name, read at each ask so it follows a rename.
	 */
	public function __construct( private readonly ?Table_Client $tables = null, private readonly ?\Closure $table = null ) {
	}

	/**
	 * Put members in `pending`, in the Table for MEMBER_TTL; a member already
	 * there has its value and expiry replaced.
	 *
	 * @api A node keeping work.
	 * @param array<string,mixed> $members Member => value.
	 * @return bool Whether `pending` took them.
	 * @throws \LogicException When the owner's client has an ask in flight.
	 * @throws \RuntimeException When the owner has no name or no sink.
	 */
	public function add( array $members ): bool {
		$backing = $this->backing();
		if ( null === $backing ) {
			$this->pending = \array_replace( $this->pending, $members );
			return true;
		}
		$landed                 = [] !== $backing[0]->add_members( $backing[1], [ self::PENDING => $members ], self::MEMBER_TTL );
		$this->pending_may_hold = $this->pending_may_hold || $landed;
		return $landed;
	}

	/**
	 * Owe a recovery, as a new process does, for an owner that dropped its work
	 * in flight.
	 *
	 * @api A node keeping work.
	 * @throws \LogicException When the owner's client has an ask in flight.
	 * @throws \RuntimeException When the owner has no name or no sink.
	 */
	public function restart(): void {
		$this->flush();
		$this->recovered = false;
	}

	/**
	 * Empty both sets, and answer every member they held.
	 *
	 * @api A node keeping work.
	 * @return list<string>
	 * @throws \LogicException When the owner's client has an ask in flight.
	 * @throws \RuntimeException When the owner has no name or no sink.
	 */
	public function drain(): array {
		do {
			$page = $this->take( Table_Node::MAX_MEMBERS_LIMIT );
		} while ( Table_Node::MAX_MEMBERS_LIMIT === \count( $page ) );
		$members = \array_map( 'strval', \array_keys( $this->inflight ) );
		$this->settle( $members );
		$this->flush();
		return $members;
	}

	/**
	 * Take members out of `inflight`: their work is done.
	 *
	 * @api A node keeping work.
	 * @param list<string> $members Members.
	 */
	public function settle( array $members ): void {
		$this->inflight = \array_diff_key( $this->inflight, \array_flip( $members ) );
		$this->settled  = [ ...$this->settled, ...$members ];
	}

	/**
	 * Move up to `$count` members, the Table's lowest first in one `SMOVE`,
	 * from `pending` to `inflight`, once what was settled is removed and any
	 * recovery owed has finished.
	 *
	 * @api A node keeping work.
	 * @param int $count Most members, up to `Table_Node::MAX_MEMBERS_LIMIT`; below 1 takes none.
	 * @return list<array{0: string, 1: mixed}> The members taken, each with its value.
	 * @throws \LogicException When the owner's client has an ask in flight.
	 * @throws \RuntimeException When the owner has no name or no sink.
	 */
	public function take( int $count ): array {
		$this->flush();
		$this->recovered = $this->recovered || $this->recover();
		if ( ! $this->recovered || ! $this->pending_may_hold || $count < 1 ) {
			return [];
		}
		$backing = $this->backing();
		if ( null === $backing ) {
			$taken         = \array_slice( $this->pending, 0, $count, true );
			$this->pending = \array_diff_key( $this->pending, $taken );
		} else {
			$moved                  = $backing[0]->move_members( $backing[1], self::PENDING, self::INFLIGHT, $count, $failed );
			$this->pending_may_hold = $failed || \count( $moved ) === $count;
			$taken                  = \array_column( $moved, 1, 0 );
		}
		$this->inflight = \array_replace( $this->inflight, $taken );
		$pairs          = [];
		foreach ( $taken as $member => $value ) {
			$pairs[] = [ (string) $member, $value ];
		}
		return $pairs;
	}

	/**
	 * How many members of one set start with `$prefix`, every member with
	 * none, once what was settled is removed and any recovery owed has
	 * finished, as before a take: one `SCARD` of the Table, or a count of the
	 * process's own sets for a frontier with no Table.
	 *
	 * @api A node keeping work, and a view of how much it has left.
	 * @param string $state  `PENDING` or `INFLIGHT`.
	 * @param string $prefix What each member counted starts with; '' for all.
	 * @return int|null The members counted; null when the Table did not
	 *                  answer the count or the recovery before it.
	 * @throws \InvalidArgumentException On a state that is neither set.
	 * @throws \LogicException When the owner's client has an ask in flight.
	 * @throws \RuntimeException When the owner has no name or no sink.
	 */
	public function count( string $state, string $prefix = '' ): ?int {
		if ( self::PENDING !== $state && self::INFLIGHT !== $state ) {
			throw new \InvalidArgumentException( \esc_html( "Frontier: no set {$state}; count " . self::PENDING . ' or ' . self::INFLIGHT ) );
		}
		$this->flush();
		$this->recovered = $this->recovered || $this->recover();
		if ( ! $this->recovered ) {
			return null;
		}
		$backing = $this->backing();
		if ( null !== $backing ) {
			return $backing[0]->count_members( $backing[1], $state, $prefix );
		}
		$members = \array_keys( self::PENDING === $state ? $this->pending : $this->inflight );
		return \count( \array_filter( $members, static fn ( int|string $member ): bool => \str_starts_with( (string) $member, $prefix ) ) );
	}

	/**
	 * Return every member in `inflight` to `pending`.
	 *
	 * @return bool Whether the recovery finished; a move the Table does not
	 *              answer leaves it owed to the next take.
	 */
	private function recover(): bool {
		$backing = $this->backing();
		if ( null === $backing ) {
			$this->pending += $this->inflight;
		} else {
			do {
				$moved = \count( $backing[0]->move_members( $backing[1], self::INFLIGHT, self::PENDING, Table_Node::MAX_MEMBERS_LIMIT, $failed ) );
				if ( $failed ) {
					return false;
				}
				$this->pending_may_hold = $this->pending_may_hold || 0 < $moved;
			} while ( Table_Node::MAX_MEMBERS_LIMIT === $moved );
		}
		$this->inflight = [];
		return true;
	}

	/**
	 * Remove the members settled since the last flush from the Table's
	 * `inflight`, in one `SREM`: what an owner's clean stop calls. An `SREM`
	 * the Table refuses or leaves unanswered keeps them owed to the next.
	 *
	 * @api A node keeping work, from its `shutdown_sweep()`.
	 * @throws \LogicException When the owner's client has an ask in flight.
	 * @throws \RuntimeException When the owner has no name or no sink.
	 */
	public function flush(): void {
		$backing = [] === $this->settled ? null : $this->backing();
		$failed  = false;
		if ( null !== $backing ) {
			$backing[0]->remove_members( $backing[1], self::INFLIGHT, $this->settled, $failed );
		}
		if ( ! $failed ) {
			$this->settled = [];
		}
	}

	/**
	 * The owner's client and its Table's name; null for a frontier with no
	 * Table.
	 *
	 * @return array{0: Table_Client, 1: string}|null
	 */
	private function backing(): ?array {
		return null === $this->tables || null === $this->table ? null : [ $this->tables, ( $this->table )() ];
	}
}
