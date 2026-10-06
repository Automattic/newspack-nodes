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
	 * @api A node asking Tables: event-logger-nodes' `Stats_Store`.
	 * @param Node         $asker  FROM, and the sink the ask leaves through.
	 * @param list<string> $tables Tables the asker names before it asks them.
	 */
	public function __construct( private readonly Node $asker, array $tables = [] ) {
		foreach ( $tables as $table ) {
			$this->tables[ $table ] = true;
		}
	}

	/**
	 * `MGET`: the values `$table` holds, by key; absent keys are absent.
	 * An all-digit key comes back as an int array key, as PHP casts it.
	 *
	 * @api A node asking Tables: event-logger-nodes' `Stats_Store`.
	 * @param string       $table  The Table's registered name.
	 * @param list<string> $keys   Keys.
	 * @param ?bool        $failed Set true when the read did not answer.
	 * @param-out bool     $failed
	 * @return array<array-key,mixed>
	 * @throws \LogicException When an ask is in flight already.
	 * @throws \RuntimeException When the asker has no name or no sink.
	 */
	public function get_multi( string $table, array $keys, ?bool &$failed = null ): array {
		$failed = false;
		$keys   = $this->nameable( $keys );
		if ( [] === $keys ) {
			return [];
		}
		$found = [];
		foreach ( $this->counted( 'MGET', $this->ask( $table, Message::TM_REQUEST, 'MGET ' . \implode( ' ', $keys ) . "\n" ), $failed ) as $reply ) {
			$found[ Core::as_string( $reply[ Message::KEY ], '' ) ] = $reply[ Message::VALUE ];
		}
		return $found;
	}

	/**
	 * `SMEMBERS`: each set's live members by set key then member, in member
	 * order, or null for a set holding more than `$limit`; a set with no live
	 * member is absent. An all-digit set key or member comes back as an int
	 * array key, as PHP casts it.
	 *
	 * @api A node asking Tables: event-logger-nodes' search index.
	 * @param string       $table    The Table's registered name.
	 * @param list<string> $set_keys Set keys.
	 * @param int          $limit    Most members a set may hold and be answered,
	 *                               from 1 to `Table_Node::MAX_MEMBERS_LIMIT`.
	 * @param ?bool        $failed   Set true when the read did not answer.
	 * @param-out bool     $failed
	 * @return array<array-key,array<array-key,mixed>|null>
	 * @throws \LogicException When an ask is in flight already.
	 * @throws \RuntimeException When the asker has no name or no sink.
	 */
	public function members( string $table, array $set_keys, int $limit, ?bool &$failed = null ): array {
		$failed   = false;
		$set_keys = $this->nameable( $set_keys );
		if ( [] === $set_keys ) {
			return [];
		}
		$found = [];
		$over  = Table_Node::OVER_LIMIT . " {$limit}\n";
		foreach ( $this->counted( 'SMEMBERS', $this->ask( $table, Message::TM_REQUEST, "SMEMBERS {$limit} " . \implode( ' ', $set_keys ) . "\n" ), $failed ) as $reply ) {
			$members = self::member_map( $reply, $over );
			if ( false === $members ) {
				$failed = true;
				return [];
			}
			$found[ Core::as_string( $reply[ Message::KEY ], '' ) ] = $members;
		}
		return $found;
	}

	/**
	 * Every live member of one set, read `SSCAN` page by page, each page
	 * asking from the cursor the last named, so a set of any size reads
	 * whole however `Table_Node::MAX_MEMBERS_LIMIT` caps one page. A set that
	 * cannot be named is refused with a rate-limited line and asks nothing. An
	 * all-digit member comes back as an int array key, as PHP casts it.
	 *
	 * @api A node reading a set past one page: event-logger-nodes' bucket index.
	 * @param string   $table   The Table's registered name.
	 * @param string   $set_key Set key.
	 * @param int      $page    Most members one page answers, from 1 to
	 *                          `Table_Node::MAX_MEMBERS_LIMIT`.
	 * @param ?bool    $failed  Set true when any page did not answer.
	 * @param-out bool $failed
	 * @return array<array-key,mixed> Member => value, in member order; none
	 *                                when a page failed, which never reads as
	 *                                a short set.
	 * @throws \LogicException When an ask is in flight already.
	 * @throws \RuntimeException When the asker has no name or no sink.
	 */
	public function all_members( string $table, string $set_key, int $page, ?bool &$failed = null ): array {
		$failed = false;
		if ( [] === $this->nameable( [ $set_key ] ) ) {
			return [];
		}
		$all    = [];
		$cursor = '';
		do {
			$asked = "SSCAN {$page} {$set_key}" . ( '' === $cursor ? '' : " {$cursor}" ) . "\n";
			foreach ( $this->counted( 'SSCAN', $this->ask( $table, Message::TM_REQUEST, $asked ), $failed, $cursor ) as $reply ) {
				$members = self::member_map( $reply, '' );
				if ( ! \is_array( $members ) ) {
					$failed = true;
					return [];
				}
				$all += $members;
			}
			if ( $failed ) {
				return [];
			}
		} while ( '' !== $cursor );
		return $all;
	}

	/**
	 * `SMOVE`: move up to `$count` members of `$from` into `$to`. A set that
	 * cannot be named is refused with a rate-limited line and asks nothing; a
	 * move naming one set twice is the Table's to refuse, and fails.
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
		foreach ( $this->counted( 'SMOVE', $this->ask( $table, Message::TM_REQUEST, "SMOVE {$count} {$from} {$to}\n" ), $failed ) as $reply ) {
			$members = self::member_map( $reply, '' );
			if ( ! \is_array( $members ) ) {
				$failed = true;
				return [];
			}
			return \array_map( 'strval', \array_keys( $members ) );
		}
		return [];
	}

	/**
	 * One set's SMEMBERS answer: a TM_STRUCT list of `[ member, value ]`
	 * pairs, or the over-limit marker naming the limit asked.
	 *
	 * @param array<int,mixed> $reply The set's message.
	 * @param string           $over  The marker the asked limit gives.
	 * @return array<array-key,mixed>|null|false Member => value, null past the
	 *                                           limit, false for anything else.
	 */
	private static function member_map( array $reply, string $over ): array|null|false {
		$value = $reply[ Message::VALUE ];
		if ( 0 === ( Core::num_int( $reply[ Message::TYPE ] ) & Message::TM_STRUCT ) ) {
			return $over === $value ? null : false;
		}
		if ( ! \is_array( $value ) || ! \array_is_list( $value ) ) {
			return false;
		}
		$members = [];
		foreach ( $value as $pair ) {
			if ( ! \is_array( $pair ) || ! \array_is_list( $pair ) || 2 !== \count( $pair ) ) {
				return false;
			}
			$members[ Core::as_string( $pair[0], '' ) ] = $pair[1];
		}
		return $members;
	}

	/**
	 * A read's value messages; none and failed on a TM_ERROR, no count, or a
	 * count they miss. An `SSCAN` count may name the next page's cursor.
	 *
	 * @param string                 $verb    The verb the count names.
	 * @param list<array<int,mixed>> $replies What the ask collected.
	 * @param bool                   $failed  Set true when the read did not answer.
	 * @param string                 $cursor  Set to the cursor the count names, or ''.
	 * @return list<array<int,mixed>>
	 */
	private function counted( string $verb, array $replies, bool &$failed, string &$cursor = '' ): array {
		$values = [];
		$count  = null;
		$cursor = '';
		$next   = 'SSCAN' === $verb ? '(?: (' . \preg_quote( Table_Node::AFTER, '/' ) . '\\S*))?' : '';
		foreach ( $replies as $reply ) {
			$type = Core::num_int( $reply[ Message::TYPE ] );
			if ( 0 !== ( $type & Message::TM_ERROR ) ) {
				$failed = true;
				return [];
			}
			if ( 0 !== ( $type & Message::TM_INFO ) ) {
				$count  = 1 === \preg_match( "/^{$verb} (\\d+){$next}\\n?$/D", Core::as_string( $reply[ Message::VALUE ], '' ), $m ) ? (int) $m[1] : null;
				$cursor = $m[2] ?? '';
				continue;
			}
			$values[] = $reply;
		}
		if ( \count( $values ) !== $count ) {
			$failed = true;
			return [];
		}
		return $values;
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
	 * `MSET`: each item under its TTL, or the Table's.
	 *
	 * @api A node asking Tables: event-logger-nodes' `Stats_Store`.
	 * @param string                                    $table The Table's registered name.
	 * @param array<array-key,array{0: mixed, 1?: int}> $items Key => [ value, ttl ].
	 * @return list<string> The keys that landed.
	 * @throws \LogicException When an ask is in flight already.
	 * @throws \RuntimeException When the asker has no name or no sink.
	 */
	public function set_multi( string $table, array $items ): array {
		return $this->write_struct( $table, 'MSET', $items );
	}

	/**
	 * `ADD`: each item only where its key is absent.
	 *
	 * @api A node asking Tables: event-logger-nodes' `Stats_Store`.
	 * @param string                                    $table The Table's registered name.
	 * @param array<array-key,array{0: mixed, 1?: int}> $items Key => [ value, ttl ].
	 * @return list<string> The keys added.
	 * @throws \LogicException When an ask is in flight already.
	 * @throws \RuntimeException When the asker has no name or no sink.
	 */
	public function add_multi( string $table, array $items ): array {
		return $this->write_struct( $table, 'ADD', $items );
	}

	/**
	 * `SADD`: each set's members, every set under `$ttl`; a re-added member's
	 * value and expiry are replaced.
	 *
	 * @api A node asking Tables: event-logger-nodes' search index.
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
	 * A structured write: `MSET`, `ADD` or `SADD`, under TM_REQUEST|TM_STRUCT.
	 *
	 * @param string                 $table The Table's registered name.
	 * @param string                 $verb  `MSET`, `ADD` or `SADD`.
	 * @param array<array-key,mixed> $items Key => [ value, ttl ].
	 * @return list<string> The keys the write took effect on.
	 * @throws \LogicException When an ask is in flight already.
	 * @throws \RuntimeException When the asker has no name or no sink.
	 */
	private function write_struct( string $table, string $verb, array $items ): array {
		if ( [] === $items ) {
			return [];
		}
		return $this->written( $verb, $this->ask( $table, Message::TM_REQUEST | Message::TM_STRUCT, [ $verb => $items ] ) );
	}

	/**
	 * `TOUCH`: move each key's expiry to `$ttl` from now.
	 *
	 * @api A node asking Tables: event-logger-nodes' `Stats_Store`.
	 * @param string       $table The Table's registered name.
	 * @param int          $ttl   Seconds from now.
	 * @param list<string> $keys  Keys.
	 * @return list<string> The keys that were there to touch.
	 * @throws \LogicException When an ask is in flight already.
	 * @throws \RuntimeException When the asker has no name or no sink.
	 */
	public function touch( string $table, int $ttl, array $keys ): array {
		return $this->write_keys( $table, 'TOUCH', [ (string) $ttl ], $keys );
	}

	/**
	 * `RM`: delete each key.
	 *
	 * @api A node asking Tables: event-logger-nodes' `Stats_Store`.
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
	 * A string write naming keys: `TOUCH <ttl>` or `RM`.
	 *
	 * @param string       $table The Table's registered name.
	 * @param string       $verb  `TOUCH` or `RM`.
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
	 * The keys a write's TM_RESPONSE names; none when no response came.
	 *
	 * @param string                 $verb    The verb the response names.
	 * @param list<array<int,mixed>> $replies What the ask collected.
	 * @return list<string>
	 */
	private function written( string $verb, array $replies ): array {
		foreach ( $replies as $reply ) {
			if ( 0 === ( Core::num_int( $reply[ Message::TYPE ] ) & Message::TM_RESPONSE ) ) {
				continue;
			}
			$words = \preg_split( '/\s+/', \trim( Core::as_string( $reply[ Message::VALUE ], '' ) ), -1, \PREG_SPLIT_NO_EMPTY ) ?: [];
			if ( $verb === ( $words[0] ?? '' ) ) {
				return \array_slice( $words, 1 );
			}
		}
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
	 * @api A node asking Tables: event-logger-nodes' `Stats_Store`.
	 * @param array<int,mixed> $message Any message the asker received.
	 * @return bool True when the message was a Table's, and so not the asker's input.
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
