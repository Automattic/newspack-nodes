<?php
/**
 * Line_Fitter: the last-moment PIPE_BUF fit for a partition-bound emit.
 *
 * A partition that has not lifted the 4KB cap (ADR-4) refuses an oversize
 * record — `Partition_Node::fill()` drops it whole — so trimming here is what
 * preserves the entry: a fitted line keeps its head, a dropped one is gone.
 * Callers fit last, immediately before handing the message to the sink.
 * `Job_Probe_Node` fits every jobstats record, and the event logger fits its
 * error entries, its completed-request summaries and its in-flight gyroscope
 * rows.
 *
 * The fit measures PACKED bytes, because a character clip is only a proxy for
 * the byte boundary: `Message::packed()` escapes a multibyte character to six
 * bytes and an astral one to twelve. An upstream character cap is a first pass
 * and never the guarantee — `Job_Worker_Node` clips its stat message at
 * `MAX_STAT_MESSAGE_LEN` to bound the accumulator, and `Job_Probe_Node` still
 * fits the packed record here.
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
	 * Fit a message's PACKED line, newline included, within
	 * `Partition_Node::MAX_LINE_SIZE` by halving the trimmable VALUE string
	 * fields named in `$fields`. Returns the fitting message, or null when no
	 * listed field is left to cut — callers drop that loud with
	 * `print_less_often()` rather than emit oversize.
	 *
	 * The `+ 1` is the newline `Partition_Node::serialize_record()` appends to
	 * the packed JSON; the cap governs that whole record, which is why
	 * measurement runs on packed bytes rather than on the VALUE strings the
	 * caller can see. Halving counts characters, so a cut never splits a
	 * multibyte character into bytes the encoder has to substitute.
	 *
	 * A field is halved repeatedly until the record fits or the field empties,
	 * and only then does the next one open. So `$fields` is a sacrifice order:
	 * put the most expendable field first. Fields outside the list are never
	 * touched — a bulk field that isn't listed forces the drop no matter how
	 * much is trimmed around it. List string fields only: a listed number is
	 * read as a string and written back as one, and a listed array or object
	 * reads as empty and is skipped like a spent field.
	 *
	 * An oversize message whose VALUE is not an array returns null — a
	 * TM_BYTESTREAM string VALUE has no named fields to cut. An empty
	 * `$fields` also returns null, even for a message already under the cap;
	 * every caller passes a non-empty list.
	 *
	 * @api Consumed by sibling plugins (event-logger-nodes).
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
				// Missing, spent or non-scalar: nothing to cut; try the next.
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
