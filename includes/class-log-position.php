<?php
/**
 * Log_Position: the one writer and the one reader of a read position (ADR-30).
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes;

\defined( 'ABSPATH' ) || exit;

/**
 * Where a reader stands in a log, as text: `<segment>:<offset>`, the
 * segment-less `:<offset>` of a file source whose generation is not known
 * yet, or one of `WORDS`, a seek the reader resolves for itself. A record's
 * ID breadcrumb is the same grammar carrying the record's length,
 * `<segment>:<offset>:<length>`. A reader's `cursor_position()`, a record's
 * ID, a `CURSORS` entry and `read_message`'s argument all speak it, and
 * `tests/fixtures/log-positions.json` holds `format()` and `parse()` to the
 * browser's `formatPosition()` and `parsePosition()`.
 */
final class Log_Position {

	/**
	 * Each seek word and the `Consumer_Node::SEEK_*` sentinel it aliases. The
	 * numbers are what travels on the wire; `sentinel()` and `word()` read this
	 * one table in each direction.
	 */
	public const WORDS = [
		'start'  => Consumer_Node::SEEK_START,
		'recent' => Consumer_Node::SEEK_RECENT,
		'end'    => Consumer_Node::SEEK_END,
	];

	/**
	 * The whole grammar of a place: an optional segment, an offset and an
	 * optional length, each a canonical decimal, so a sign, padding or another
	 * base names no position.
	 */
	private const GRAMMAR = '/^(0|[1-9][0-9]*)?:(0|[1-9][0-9]*)(?::(0|[1-9][0-9]*))?$/D';

	/**
	 * A record's ID breadcrumb, `segment:offset:length`, or null when the ID
	 * is anything else: a place with no segment or no length, a word, or a
	 * command reply's opaque ID. A File_Tail's breadcrumb carries its inode in
	 * the segment slot, so it reads the same way.
	 *
	 * @param string $id A record's Message ID.
	 * @return array{segment:int,offset:int,length:int}|null
	 */
	public static function crumb( string $id ): ?array {
		$at = self::parse( $id );
		return isset( $at['segment'], $at['length'] ) ? $at : null;
	}

	/**
	 * Read a position, or a breadcrumb with its length, through one anchored
	 * match. A number past `PHP_INT_MAX` names no position either. Null for
	 * anything else, a word included: the caller that speaks the words looks
	 * them up in `WORDS`, and each caller states its own refusal.
	 *
	 * @param string $position A position or breadcrumb, as `format()` writes it.
	 * @return array{segment?:int,offset:int,length?:int}|null The place, or null.
	 */
	public static function parse( string $position ): ?array {
		if ( 1 !== \preg_match( self::GRAMMAR, $position, $fields, \PREG_UNMATCHED_AS_NULL ) ) {
			return null;
		}
		$at = [];
		foreach ( [ 'segment' => 1, 'offset' => 2, 'length' => 3 ] as $key => $index ) {
			$field = $fields[ $index ] ?? null;
			if ( null === $field ) {
				continue;
			}
			// A canonical decimal reads back unchanged only when it fits.
			$number = (int) $field;
			if ( (string) $number !== $field ) {
				return null;
			}
			$at[ $key ] = $number;
		}
		return $at;
	}

	/**
	 * The word a sentinel resolves from, so a seek travels as the word a
	 * remote reader resolves for itself; null for a number no word names.
	 *
	 * @param int $sentinel A seek sentinel.
	 * @return string|null A key of `WORDS`, or null.
	 */
	public static function word( int $sentinel ): ?string {
		$word = \array_search( $sentinel, self::WORDS, true );
		return false === $word ? null : $word;
	}

	/**
	 * Resolve a scalar position to its seek sentinel: a word to its
	 * `Consumer_Node::SEEK_*`, a number to itself, and an unknown word to
	 * `SEEK_START`, which is `Consumer_Node::next_offset()`'s default case.
	 *
	 * @param string|int|float $position A sentinel or a word.
	 * @return int A SEEK_* constant, or the numeric position itself.
	 */
	public static function sentinel( $position ): int {
		return \is_string( $position ) && isset( self::WORDS[ $position ] )
			? self::WORDS[ $position ]
			: Core::num_int( $position, Consumer_Node::SEEK_START );
	}

	/**
	 * Write a position, or with a length, a record's breadcrumb. A null
	 * segment is a generation not known yet, which states the offset alone:
	 * segment 0 names a real segment, or a foreign inode to a file source.
	 *
	 * @param int|null $segment The segment, or a file source's inode; null when unknown.
	 * @param int      $offset  The next byte to read, or a record's first.
	 * @param int|null $length  A record's length in bytes; null for a position.
	 * @return string `{segment}:{offset}`, `:{offset}`, or either with `:{length}`.
	 */
	public static function format( ?int $segment, int $offset, ?int $length ): string {
		return ( null === $segment ? '' : (string) $segment ) . ":{$offset}" . ( null === $length ? '' : ":{$length}" );
	}
}
