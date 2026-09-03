<?php
/**
 * Log_Stream_Out: the `GET /log/stream` SSE controller. Mirrors
 * `/messages/stream` exactly on the wire — same packed `msg` events,
 * `connected` envelope, heartbeat, slot pool — differing only in what a
 * subscription resolves to: a fixed `Log_Sources` registry NAME opened as a
 * `Tail` reader (file or segmented mode) instead of a Consumer. A caller can
 * never supply a path; registry sources are fixed for the life of a stream
 * (no globs — Tail's missing-file grace covers appear/rotate/truncate).
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes\Rest;

use Newspack_Nodes\Log_Sources;
use Newspack_Nodes\Tail_Node;

\defined( 'ABSPATH' ) || exit;

/**
 * Every wire concern — framing, heartbeat cadence, flush, slot pool, the
 * drain loop — is inherited untouched. Wire behaviour added here rather than
 * in `SSE_Out_Node` costs the parity that lets one client read both streams.
 */
class Log_Stream_Out_Node extends SSE_Out_Node {

	/**
	 * The route `register_routes()` registers under `REST_NAMESPACE`, replacing
	 * the parent's `/messages/stream`.
	 *
	 * @var non-falsy-string
	 */
	public const ROUTE = '/log/stream';

	/**
	 * Resolve a registry NAME to one `Tail` — never a path, so there is no
	 * traversal surface. `Log_Sources::open_tail()` picks the reader class from
	 * the entry's mode and hands it the path alone, leaving it without an
	 * offsetlog or a dead-letter dir: the browser holds the resume cursor.
	 *
	 * That cursor (`positions`, keyed by the registry name this stamps as FROM)
	 * round-trips the same `{segment, offset}` shape as `/messages/stream`; in
	 * file mode the inode occupies the segment slot. A name arriving with no
	 * saved position opens at the live tail.
	 *
	 * An unknown name raises the one teaching error `Log_Sources` phrases for
	 * the REPL and the stream alike, trimmed of the trailing newline a REPL
	 * line carries and an exception message does not.
	 *
	 * @param string                      $sub       Registry name.
	 * @param array<array-key,mixed>|null $positions Saved positions, keyed by registry name.
	 *
	 * @return array<int,Tail_Node> Exactly one reader: a name resolves to one source.
	 *
	 * @throws \InvalidArgumentException When `$sub` is not a registry name.
	 */
	public function open_subscription( string $sub, ?array $positions ): array {
		$registry = Log_Sources::registry();
		if ( ! isset( $registry[ $sub ] ) ) {
			throw new \InvalidArgumentException( \esc_html( \rtrim( Log_Sources::unknown_source( $registry, $sub ), "\n" ) ) );
		}
		$tail = Log_Sources::open_tail( $registry[ $sub ] );
		$tail->next_offset(
			isset( $positions[ $sub ] ) ? self::position_arg( $positions[ $sub ] ) : 'end'
		);
		$tail->set_stamp_as( $sub );
		return [ $tail ];
	}
}
