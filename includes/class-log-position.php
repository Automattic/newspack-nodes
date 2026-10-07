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
		return \is_array( $at ) && isset( $at['segment'], $at['length'] )
			? [ 'segment' => $at['segment'], 'offset' => $at['offset'], 'length' => $at['length'] ]
			: null;
	}

	/**
	 * Read a position, or a breadcrumb with its length. Every number is a
	 * canonical decimal, so a sign, padding or another base names no
	 * position. Null for anything else, and each caller states its own
	 * refusal.
	 *
	 * @param string $position A position or breadcrumb, as `format()` writes it, or a word.
	 * @return array{segment?:int,offset:int,length?:int}|string|null The place, the word, or null.
	 */
	public static function parse( string $position ): array|string|null {
		if ( isset( self::WORDS[ $position ] ) ) {
			return $position;
		}
		$fields = \explode( ':', $position );
		if ( \count( $fields ) < 2 || \count( $fields ) > 3 ) {
			return null;
		}
		$segment = '' === $fields[0] ? null : Core::canonical_decimal( $fields[0] );
		$offset  = Core::canonical_decimal( $fields[1] );
		$length  = isset( $fields[2] ) ? Core::canonical_decimal( $fields[2] ) : null;
		if ( null === $offset || ( '' !== $fields[0] && null === $segment ) || ( isset( $fields[2] ) && null === $length ) ) {
			return null;
		}
		$at = null === $segment ? [ 'offset' => $offset ] : [ 'segment' => $segment, 'offset' => $offset ];
		return null === $length ? $at : $at + [ 'length' => $length ];
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
