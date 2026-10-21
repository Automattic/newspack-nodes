<?php
/**
 * Table_Client: the asking half of the Table protocol.
 *
 * A node sends a request TO a Table with its own name as FROM. In-process
 * delivery is synchronous, so every reply has reached the node's `fill()` —
 * which hands it here first — before the send returns. One exchange is in
 * flight per asker, so the address is the whole correlation (ADR-7).
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes;

\defined( 'ABSPATH' ) || exit;

/**
 * Asks Tables for one node, and keeps what they answer.
 *
 * The asker's `fill()` calls `accepts()` first and returns on true. A reply
 * from the Table the ask in flight awaits is collected; a message from any
 * other Table the asker names — late, or never asked — is dropped aloud,
 * because a Table's reply is never the asker's input.
 *
 * @phpstan-import-type Row_Op from Sqlite_Arm
 */
final class Table_Client {

	/** @var array<string,true> Every Table this asker names; a message FROM one is never its input. */
	private array $tables = [];

	/** The Table the ask in flight awaits, or null between asks. */
	private ?string $awaiting = null;

	/** @var list<array<int,mixed>> What the ask in flight has collected. */
	private array $collected = [];

	/**
	 * Bind the client to the one node that asks through it.
	 *
	 * @api A node asking Tables: `Crawler_Node`, and event-logger-nodes' stats builder.
	 * @param Node         $asker  FROM, and the sink the ask leaves through.
	 * @param list<string> $tables Tables the asker names before it asks them.
	 */
	public function __construct( private readonly Node $asker, array $tables = [] ) {
		foreach ( $tables as $table ) {
			$this->tables[ $table ] = true;
		}
	}

	/**
	 * `SMOVE`: move up to `$count` members of `$from` into `$to`. A set that
	 * cannot be named is refused with a rate-limited line and asks nothing; a
	 * move naming one set twice is for the Table to refuse, and fails. The move
	 * failed on a TM_ERROR, a missing count, a count the set messages miss, or
	 * a set that is not a TM_STRUCT list of `[ member, value ]` pairs.
	 *
	 * @api A node moving members between sets: the Crawler_Node.
	 * @param string   $table  The Table's registered name.
	 * @param string   $from   Set key taken from.
	 * @param string   $to     Set key moved into.
	 * @param int      $count  Most members, from 1 to `Table_Node::MAX_MEMBERS_LIMIT`.
	 * @param ?bool    $failed Set true when the move did not answer.
	 * @param-out bool $failed
	 * @return list<string> The members moved, lowest first.
	 * @throws \LogicException When an ask is in flight already.
	 * @throws \RuntimeException When the asker has no name or no sink.
	 */
	public function move_members( string $table, string $from, string $to, int $count, ?bool &$failed = null ): array {
		$failed = false;
		if ( [] === $this->nameable( [ $from ] ) || [] === $this->nameable( [ $to ] ) ) {
			Core::print_less_often( 'Table_Client: a move needs two nameable sets' );
			return [];
		}
		$sets     = [];
		$answered = null;
		foreach ( $this->ask( $table, Message::TM_REQUEST, "SMOVE {$count} {$from} {$to}\n" ) as $reply ) {
			$type = Core::num_int( $reply[ Message::TYPE ] );
			if ( 0 !== ( $type & Message::TM_ERROR ) ) {
				$failed = true;
				return [];
			}
			if ( 0 !== ( $type & Message::TM_INFO ) ) {
				$answered = 1 === \preg_match( '/^SMOVE (\d+)\n?$/D', Core::as_string( $reply[ Message::VALUE ], '' ), $m ) ? (int) $m[1] : null;
				continue;
			}
			$sets[] = $reply;
		}
		$value = $sets[0][ Message::VALUE ] ?? null;
		if ( \count( $sets ) !== $answered || ( [] !== $sets && ( 0 === ( Core::num_int( $sets[0][ Message::TYPE ] ) & Message::TM_STRUCT ) || ! \is_array( $value ) || ! \array_is_list( $value ) ) ) ) {
			$failed = true;
			return [];
		}
		$moved = [];
		foreach ( \is_array( $value ) ? $value : [] as $pair ) {
			if ( ! \is_array( $pair ) || ! \array_is_list( $pair ) || 2 !== \count( $pair ) ) {
				$failed = true;
				return [];
			}
			$moved[ Core::as_string( $pair[0], '' ) ] = true;
		}
		return \array_map( 'strval', \array_keys( $moved ) );
	}

	/**
	 * `SREM`: delete members of one set.
	 *
	 * @api A node moving members between sets: the Crawler_Node.
	 * @param string       $table   The Table's registered name.
	 * @param string       $set_key Set key.
	 * @param list<string> $members Members.
	 * @return list<string> The members that were there to delete.
	 * @throws \LogicException When an ask is in flight already.
	 * @throws \RuntimeException When the asker has no name or no sink.
	 */
	public function remove_members( string $table, string $set_key, array $members ): array {
		if ( [] === $this->nameable( [ $set_key ] ) ) {
			return [];
		}
		return $this->write_keys( $table, 'SREM', [ $set_key ], $members );
	}

	/**
	 * `ADD`: each item only where its key is absent. A key already present is
	 * left out of the answer; a write the Table refuses or leaves unanswered
	 * answers none and sets `$failed`, so the two never read alike.
	 *
	 * @api A node asking Tables: the Crawler_Node.
	 * @param string                                    $table  The Table's registered name.
	 * @param array<array-key,array{0: mixed, 1?: int}> $items  Key => [ value, ttl ].
	 * @param ?bool                                     $failed Set true when the write did not answer.
	 * @param-out bool                                  $failed
	 * @return list<string> The keys added.
	 * @throws \LogicException When an ask is in flight already.
	 * @throws \RuntimeException When the asker has no name or no sink.
	 */
	public function add_multi( string $table, array $items, ?bool &$failed = null ): array {
		$failed = false;
		return $this->write_struct( $table, 'ADD', $items, $failed );
	}

	/**
	 * `SADD`: each set's members, every set under `$ttl`; a re-added member's
	 * value and expiry are replaced.
	 *
	 * @api A node asking Tables: the Crawler_Node.
	 * @param string                                   $table The Table's registered name.
	 * @param array<array-key,array<array-key,mixed>> $sets  Set key => [ member => value ].
	 * @param int                                      $ttl   Seconds each member lives, at least 1.
	 * @return list<string> The set keys that landed.
	 * @throws \LogicException When an ask is in flight already.
	 * @throws \RuntimeException When the asker has no name or no sink.
	 */
	public function add_members( string $table, array $sets, int $ttl ): array {
		return $this->write_struct( $table, 'SADD', \array_map( static fn ( array $members ): array => [ $members, $ttl ], $sets ) );
	}

	/**
	 * A structured write: `ADD` or `SADD`, under TM_REQUEST|TM_STRUCT.
	 *
	 * @param string                 $table  The Table's registered name.
	 * @param string                 $verb   `ADD` or `SADD`.
	 * @param array<array-key,mixed> $items  Key => [ value, ttl ].
	 * @param bool                   $failed Set true when the write did not answer.
	 * @return list<string> The keys the write took effect on.
	 * @throws \LogicException When an ask is in flight already.
	 * @throws \RuntimeException When the asker has no name or no sink.
	 */
	private function write_struct( string $table, string $verb, array $items, bool &$failed = false ): array {
		if ( [] === $items ) {
			return [];
		}
		return $this->written( $verb, $this->ask( $table, Message::TM_REQUEST | Message::TM_STRUCT, [ $verb => $items ] ), $failed );
	}

	/**
	 * `ROWS`: one batch of row ops, written in one transaction by a
	 * Row_Table, which answers as every Table write does. Its answer reaches
	 * the asker's `fill()`, which hands it to `accepts()`; a refusal, or no
	 * answer, raises, since a row the batch named may be gone.
	 *
	 * @api A node writing row tables: event-logger-nodes' stats builder.
	 * @param string                 $table The Row_Table's registered name.
	 * @param list<Row_Op> $batch `[ op, table, row, then?, ids? ]` each, as `Sqlite_Arm::write_rows()` takes them.
	 * @throws \LogicException When an ask is in flight already.
	 * @throws \RuntimeException When the Row_Table refuses the batch or does
	 *                           not answer, or the asker has no name or no sink.
	 */
	public function write_rows( string $table, array $batch ): void {
		if ( [] === $batch ) {
			return;
		}
		$replies = $this->ask( $table, Message::TM_REQUEST | Message::TM_STRUCT, [ 'ROWS' => $batch ] );
		foreach ( $replies as $reply ) {
			if ( 0 !== ( Core::num_int( $reply[ Message::TYPE ] ) & Message::TM_ERROR ) ) {
				throw new \RuntimeException( \esc_html( "Table_Client: {$table} refused ROWS: " . \trim( Core::as_string( $reply[ Message::VALUE ], '' ) ) ) );
			}
		}
		$failed = false;
		$this->written( 'ROWS', $replies, $failed );
		if ( $failed ) {
			throw new \RuntimeException( \esc_html( "Table_Client: {$table} did not answer ROWS" ) );
		}
	}

	/**
	 * `RM`: delete each key.
	 *
	 * @api A node asking Tables: `Crawler_Node`.
	 * @param string       $table The Table's registered name.
	 * @param list<string> $keys  Keys.
	 * @return list<string> The keys that were there to delete.
	 * @throws \LogicException When an ask is in flight already.
	 * @throws \RuntimeException When the asker has no name or no sink.
	 */
	public function remove( string $table, array $keys ): array {
		return $this->write_keys( $table, 'RM', [], $keys );
	}

	/**
	 * A string write naming keys: `SREM <set_key>` or `RM`.
	 *
	 * @param string       $table The Table's registered name.
	 * @param string       $verb  `SREM` or `RM`.
	 * @param list<string> $args  The verb's arguments ahead of the keys.
	 * @param list<string> $keys  Keys.
	 * @return list<string> The keys the write took effect on.
	 * @throws \LogicException When an ask is in flight already.
	 * @throws \RuntimeException When the asker has no name or no sink.
	 */
	private function write_keys( string $table, string $verb, array $args, array $keys ): array {
		$keys = $this->nameable( $keys );
		if ( [] === $keys ) {
			return [];
		}
		return $this->written( $verb, $this->ask( $table, Message::TM_REQUEST, \implode( ' ', [ $verb, ...$args, ...$keys ] ) . "\n" ) );
	}

	/**
	 * Send one request and return what it collected. Delivery is synchronous,
	 * so the exchange closes when the send returns, answered or not, and each
	 * refusal (a TM_ERROR) is logged with its text.
	 *
	 * @param string                     $table The Table's registered name.
	 * @param int                        $type  The request's TYPE.
	 * @param string|array<string,mixed> $value The request's VALUE.
	 * @return list<array<int,mixed>>
	 * @throws \LogicException When an ask is in flight already.
	 * @throws \RuntimeException When the asker has no name or no sink.
	 */
	private function ask( string $table, int $type, string|array $value ): array {
		$asker = $this->asker->name();
		if ( '' === $asker ) {
			// A reply goes TO the asker's name; an unnamed one would get none.
			throw new \RuntimeException( \esc_html( "Table_Client: an unnamed asker cannot ask {$table}" ) );
		}
		if ( null !== $this->awaiting ) {
			throw new \LogicException( \esc_html( "Table_Client: {$asker} asked {$table} while an ask of {$this->awaiting} was in flight" ) );
		}
		$sink = $this->asker->sink() ?? throw new \RuntimeException( \esc_html( "Table_Client: {$asker} has no sink" ) );

		$request                   = Message::new_message();
		$request[ Message::TYPE ]  = $type;
		$request[ Message::FROM ]  = $asker;
		$request[ Message::TO ]    = $table;
		$request[ Message::VALUE ] = $value;
		$this->tables[ $table ]    = true;
		$this->awaiting            = $table;
		try {
			$sink->fill( $request );
			foreach ( $this->collected as $reply ) {
				if ( 0 !== ( Core::num_int( $reply[ Message::TYPE ] ) & Message::TM_ERROR ) ) {
					Core::print_less_often( "Table_Client: {$table} refused an ask from {$asker}", ' — ' . \trim( Core::as_string( $reply[ Message::VALUE ], '' ) ) );
				}
			}
			return $this->collected;
		} finally {
			$this->awaiting  = null;
			$this->collected = [];
		}
	}

	/**
	 * The keys a write's TM_RESPONSE names; none, and failed, when no response
	 * came.
	 *
	 * @param string                 $verb    The verb the response names.
	 * @param list<array<int,mixed>> $replies What the ask collected.
	 * @param bool                   $failed  Set true when no response came.
	 * @return list<string>
	 */
	private function written( string $verb, array $replies, bool &$failed = false ): array {
		foreach ( $replies as $reply ) {
			if ( 0 === ( Core::num_int( $reply[ Message::TYPE ] ) & Message::TM_RESPONSE ) ) {
				continue;
			}
			$words = \preg_split( '/\s+/', \trim( Core::as_string( $reply[ Message::VALUE ], '' ) ), -1, \PREG_SPLIT_NO_EMPTY ) ?: [];
			if ( $verb === ( $words[0] ?? '' ) ) {
				return \array_slice( $words, 1 );
			}
		}
		$failed = true;
		return [];
	}

	/**
	 * The keys a string request can name, each once, as strings.
	 *
	 * @param list<string> $keys Keys.
	 * @return list<string>
	 */
	private function nameable( array $keys ): array {
		$out = [];
		foreach ( $keys as $key ) {
			if ( Cache_Backend::refuses_key( $key ) ) {
				Core::print_less_often( 'Table_Client: a key holding whitespace cannot be named' );
				continue;
			}
			$out[ $key ] = true;
		}
		// An all-digit key comes back from array_keys() as an int.
		return \array_map( 'strval', \array_keys( $out ) );
	}

	/**
	 * Take a message a Table sent: collect the awaited Table's reply, and
	 * swallow any other Table's with a rate-limited line.
	 *
	 * @api A node asking Tables: `Crawler_Node`, and event-logger-nodes' stats builder.
	 * @param array<int,mixed> $message Any message the asker received.
	 * @return bool True when a Table sent the message, so it is not the asker's input.
	 */
	public function accepts( array $message ): bool {
		$from = Core::as_string( $message[ Message::FROM ], '' );
		if ( null !== $this->awaiting && $from === $this->awaiting ) {
			$this->collected[] = $message;
			return true;
		}
		if ( ! isset( $this->tables[ $from ] ) ) {
			return false;
		}
		Core::print_less_often( 'Table_Client: dropped a reply no ask awaits', " — {$from} to {$this->asker->name()}" );
		return true;
	}
}
