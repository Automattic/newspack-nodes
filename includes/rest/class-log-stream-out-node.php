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

class Log_Stream_Out_Node extends SSE_Out_Node {

	public const ROUTE = '/log/stream';

	/**
	 * Resolve a registry NAME to one `Tail` — never a path, so there is no
	 * traversal surface. No offsetlog/deadletter: the browser holds the resume
	 * cursor (`positions`, keyed by registry name, round-trips the same
	 * `{segment, offset}` shape as `/messages/stream`; in file mode the inode
	 * simply occupies the segment slot).
	 *
	 * @param string                      $sub       Registry name.
	 * @param array<array-key,mixed>|null $positions Saved positions, keyed by name.
	 *
	 * @return array<int,Tail_Node>
	 *
	 * @throws \InvalidArgumentException When `$sub` is not a registry name.
	 */
	public function open_subscription( string $sub, ?array $positions ): array {
		$registry = Log_Sources::registry();
		if ( ! isset( $registry[ $sub ] ) ) {
			$known = \implode( ', ', \array_keys( $registry ) );
			throw new \InvalidArgumentException( \esc_html(
				"unknown log source: \"{$sub}\" (known: " . ( '' === $known ? 'none' : $known ) . ')'
			) );
		}
		$entry = $registry[ $sub ];
		$tail  = new Tail_Node();
		$tail->arguments( [ $entry['path'], '', '', $entry['mode'] ] );
		$tail->next_offset(
			isset( $positions[ $sub ] ) ? self::position_arg( $positions[ $sub ] ) : 'end'
		);
		$tail->set_stamp_as( $sub );
		return [ $tail ];
	}
}
