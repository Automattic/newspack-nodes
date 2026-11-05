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
 * @phpstan-import-type Row_Delete from Sqlite_Arm
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
	 * `SMOVE`: move up to `$count` members of `$from` into `$to`, asking
	 * nothing of a set that cannot be named; a refusal, or a reply read() or
	 * the pair check finds wrong, fails.
	 *
	 * @api A node moving members between sets: the Frontier.
	 * @param string   $table  The Table's registered name.
	 * @param string   $from   Set key taken from.
	 * @param string   $to     Set key moved into.
	 * @param int      $count  Most members, from 1 to `Table_Node::MAX_MEMBERS_LIMIT`.
	 * @param ?bool    $failed Set true when the move did not answer.
	 * @param-out bool $failed
	 * @return list<array{0: string, 1: mixed}> The members moved, lowest first, each with its value.
	 * @throws \LogicException When an ask is in flight already.
	 * @throws \RuntimeException When the asker has no name or no sink.
	 */
	public function move_members( string $table, string $from, string $to, int $count, ?bool &$failed = null ): array {
		$failed = false;
		if ( [] === $this->nameable( [ $from ] ) || [] === $this->nameable( [ $to ] ) ) {
			Core::print_less_often( 'Table_Client: a move needs two nameable sets' );
			return [];
		}
		$sets  = $this->read( $table, 'SMOVE', "{$count} {$from} {$to}" );
		$value = $sets[0][ Message::VALUE ] ?? null;
		if ( null === $sets || ( [] !== $sets && ( 0 === ( Core::num_int( $sets[0][ Message::TYPE ] ) & Message::TM_STRUCT ) || ! \is_array( $value ) || ! \array_is_list( $value ) ) ) ) {
			$failed = true;
			return [];
		}
		$moved = [];
		foreach ( \is_array( $value ) ? $value : [] as $pair ) {
			if ( ! \is_array( $pair ) || ! \array_is_list( $pair ) || 2 !== \count( $pair ) ) {
				$failed = true;
				return [];
			}
			$moved[] = [ Core::as_string( $pair[0], '' ), $pair[1] ];
		}
		return $moved;
	}

	/**
	 * `SREM`: delete members of one set. A write the Table refuses or leaves
	 * unanswered removes none and sets `$failed`.
	 *
	 * @api A node moving members between sets: the Frontier.
	 * @param string       $table   The Table's registered name.
	 * @param string       $set_key Set key.
	 * @param list<string> $members Members.
	 * @param ?bool        $failed  Set true when the write did not answer.
	 * @param-out bool     $failed
	 * @return list<string> The members that were there to delete.
	 * @throws \LogicException When an ask is in flight already.
	 * @throws \RuntimeException When the asker has no name or no sink.
	 */
	public function remove_members( string $table, string $set_key, array $members, ?bool &$failed = null ): array {
		$failed = false;
		if ( [] === $this->nameable( [ $set_key ] ) ) {
			return [];
		}
		return $this->write_keys( $table, 'SREM', [ $set_key ], $members, $failed );
	}

	/**
	 * `GET`: the value the Table holds for a key, or null when it holds none.
	 * A key that cannot be named asks nothing. The read failed on a TM_ERROR,
	 * a missing count, or a count the value messages miss, so a failure never
	 * reads as an absent key.
	 *
	 * @api A node reading keyed rows: newspack-intelligence's feed.
	 * @param string   $table  The Table's registered name.
	 * @param string   $key    Key.
	 * @param ?bool    $failed Set true when the read did not answer.
	 * @param-out bool $failed
	 * @return mixed An array for a stored array, a string otherwise; null for none.
	 * @throws \LogicException When an ask is in flight already.
	 * @throws \RuntimeException When the asker has no name or no sink.
	 */
	public function get( string $table, string $key, ?bool &$failed = null ): mixed {
		$failed = false;
		if ( [] === $this->nameable( [ $key ] ) ) {
			return null;
		}
		$values = $this->read( $table, 'GET', $key );
		$failed = null === $values;
		return $values[0][ Message::VALUE ] ?? null;
	}

	/**
	 * `SCARD`: how many members of one set start with `$prefix`, every member
	 * with none. A set or a prefix that cannot be named holds none and asks
	 * nothing; a refusal, no answer, or an answer that is not one string
	 * TM_BYTESTREAM keyed by the set and holding a whole number answers null,
	 * so a failure never reads as an empty set.
	 *
	 * @api A node counting its work: the Frontier.
	 * @param string $table   The Table's registered name.
	 * @param string $set_key Set key.
	 * @param string $prefix  What each member counted starts with; '' for all.
	 * @return int|null The members counted; null when the Table did not answer.
	 * @throws \LogicException When an ask is in flight already.
	 * @throws \RuntimeException When the asker has no name or no sink.
	 */
	public function count_members( string $table, string $set_key, string $prefix = '' ): ?int {
		if ( [] === $this->nameable( [ $set_key ] ) || ( '' !== $prefix && [] === $this->nameable( [ $prefix ] ) ) ) {
			return 0;
		}
		$counted = $this->read( $table, 'SCARD', \rtrim( "{$set_key} {$prefix}" ) );
		$reply   = $counted[0] ?? null;
		if ( null === $reply || 0 === ( Core::num_int( $reply[ Message::TYPE ] ) & Message::TM_BYTESTREAM ) || $set_key !== $reply[ Message::KEY ] || ! \is_string( $reply[ Message::VALUE ] ) ) {
			return null;
		}
		return Core::canonical_decimal( $reply[ Message::VALUE ] );
	}

	/**
	 * Ask a read and collect its data replies, the messages its `VERB <n>`
	 * TM_INFO counts.
	 *
	 * @param string $table The Table's registered name.
	 * @param string $verb  `GET`, `SCARD` or `SMOVE`.
	 * @param string $args  The verb's arguments.
	 * @return list<array<int,mixed>>|null Null on a TM_ERROR, a missing count, or a count the data replies miss.
	 * @throws \LogicException When an ask is in flight already.
	 * @throws \RuntimeException When the asker has no name or no sink.
	 */
	private function read( string $table, string $verb, string $args ): ?array {
		$data     = [];
		$answered = null;
		foreach ( $this->ask( $table, Message::TM_REQUEST, "{$verb} {$args}\n" ) as $reply ) {
			$type = Core::num_int( $reply[ Message::TYPE ] );
			if ( 0 !== ( $type & Message::TM_ERROR ) ) {
				return null;
			}
			if ( 0 !== ( $type & Message::TM_INFO ) ) {
				$answered = 1 === \preg_match( "/^{$verb} (\\d+)\\n?$/D", Core::as_string( $reply[ Message::VALUE ], '' ), $m ) ? (int) $m[1] : null;
				continue;
			}
			$data[] = $reply;
		}
		return \count( $data ) === $answered ? $data : null;
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
	 * @param list<Row_Op|Row_Delete> $batch `[ op, table, row, then?, ids? ]` each, a delete's row column => value, as `Sqlite_Arm::write_rows()` takes them.
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
	 * @param list<string> $keys   Keys.
	 * @param bool         $failed Set true when the write did not answer.
	 * @return list<string> The keys the write took effect on.
	 * @throws \LogicException When an ask is in flight already.
	 * @throws \RuntimeException When the asker has no name or no sink.
	 */
	private function write_keys( string $table, string $verb, array $args, array $keys, bool &$failed = false ): array {
		$keys = $this->nameable( $keys );
		if ( [] === $keys ) {
			return [];
		}
		return $this->written( $verb, $this->ask( $table, Message::TM_REQUEST, \implode( ' ', [ $verb, ...$args, ...$keys ] ) . "\n" ), $failed );
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
	 * The keys a write's TM_RESPONSE names; none, and failed, when the response
	 * never came.
	 *
	 * @param string                 $verb    The verb the response names.
	 * @param list<array<int,mixed>> $replies What the ask collected.
	 * @param bool                   $failed  Set true when the response never
	 *                                        came.
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
		Core::print_less_often( 'Table_Client: dropped a reply that is not awaited by any ask', " — {$from} to {$this->asker->name()}" );
		return true;
	}
}
