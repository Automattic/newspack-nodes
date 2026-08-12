<?php
/**
 * Line_Fitter
 *
 * The shared packed-size fit for any emit bound for a partition that doesn't
 * lift the PIPE_BUF cap (ELN's errors / completed / gyroscope; the substrate's
 * own probe records — all uniformly ≤PIPE_BUF atomic).
 * A character clip is only a proxy for the byte boundary (a multibyte char
 * JSON-escapes to up to 6 bytes), so callers that clip for display still route
 * the packed message through here before writing.
 *
 * `Partition_Node::fill()` drops an oversize record outright, so trimming here
 * is what preserves the entry: a fitted line keeps its head, a dropped one is
 * gone. Callers fit last, immediately before handing the message to the sink.
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes;

\defined( 'ABSPATH' ) || exit;

/**
 * Byte-exact size fit for a message bound for a PIPE_BUF-capped Partition.
 *
 * Stateless and static: one measure-and-halve loop, no configuration.
 */
final class Line_Fitter {

	/**
	 * Fit a message's PACKED line (+ newline) under Partition_Node::MAX_LINE_SIZE
	 * by halving each trimmable VALUE string field in `$fields` order until it fits
	 * (mb-aware). Returns the fitting message, or null when no listed field is left
	 * to cut — callers drop that loud (print_less_often), never emitting oversize.
	 *
	 * The `+ 1` is the newline `Partition_Node::serialize_record()` appends to the
	 * packed JSON; the cap governs that whole record, which is why measurement runs
	 * on packed bytes rather than on the VALUE strings the caller can see.
	 *
	 * A field is halved repeatedly until the record fits or the field empties, and
	 * only then does the next one open. So `$fields` is a sacrifice order: put the
	 * most expendable field first. Fields outside the list are never touched — a
	 * bulk field that isn't listed forces the drop no matter how much is trimmed
	 * around it.
	 *
	 * An oversize message whose VALUE is not an array returns null untouched — a
	 * TM_BYTESTREAM string VALUE has no named fields to cut. An empty `$fields`
	 * also returns null, even for a message already under the cap; every caller
	 * passes a non-empty list.
	 *
	 * @param array<int,mixed>   $message The minted message.
	 * @param list<string|int>   $fields  Trimmable VALUE keys, in halving order.
	 *                                    Ints address a POSITIONAL record
	 *                                    (Jobstats_Record); strings a named one.
	 * @return array<int,mixed>|null The fitting message, or null to drop.
	 */
	public static function fit( array $message, array $fields ): ?array {
		foreach ( $fields as $field ) {
			while ( Message::packed_size( $message ) + 1 > Partition_Node::MAX_LINE_SIZE ) {
				$value = $message[ Message::VALUE ];
				if ( ! \is_array( $value ) ) {
					return null;
				}
				$s = Core::as_string( $value[ $field ] ?? '' );
				// Missing or spent field: nothing left to halve, try the next.
				if ( '' === $s ) {
					break;
				}
				$value[ $field ]           = \mb_substr( $s, 0, \intdiv( \mb_strlen( $s ), 2 ) );
				$message[ Message::VALUE ] = $value;
			}
			if ( Message::packed_size( $message ) + 1 <= Partition_Node::MAX_LINE_SIZE ) {
				return $message;
			}
		}
		return null;
	}
}
