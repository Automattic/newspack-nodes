<?php
/**
 * File_Writer: the fail-loud whole-buffer write behind every segment append.
 *
 * `write_all()` puts every byte of a buffer on a handle and reports how many
 * actually landed, so a short write stays visible instead of becoming silent
 * data loss. That number is what lets `Partition_Node::flush()` truncate the
 * torn record off and dead-letter the messages that never made it, which is the
 * substrate's rule that a short write is quarantined, never swallowed.
 *
 * The trait reaches into two `Node` members, so only a Node may `use` it, and
 * only a file-writing one has reason to: `Partition_Node` uses it and `Log_Node`
 * inherits it, while a logic node has no business carrying an fwrite retry loop.
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes;

\defined( 'ABSPATH' ) || exit;

trait File_Writer {

	/**
	 * Refused writes tolerated within one `write_all()` call before it gives up
	 * and reports the short write. The budget covers the call rather than each
	 * stall: only a refusal spends it, and a partial write that lands bytes never
	 * refunds it. Bounding it is what stops a full disk from spinning the
	 * single-threaded drain loop forever.
	 */
	protected const MAX_WRITE_ATTEMPTS = 5;

	/**
	 * libc fwrite seam, one slot per class that `use`s the trait, lazily
	 * defaulted to the real call. `self::` binds it to the using class, so
	 * assigning `Partition_Node::$fwrite` diverts `Log_Node`'s writes as well.
	 * Tests assign a byte-budget closure that tears a record mid-write, which
	 * runs the truncate-and-quarantine recovery as real production code.
	 * Signature: `function (resource $fh, string $bytes): int|false`.
	 *
	 * @var (\Closure(resource, string): (int|false))|null
	 */
	public static ?\Closure $fwrite = null;

	/**
	 * Write every byte of $bytes to $fh, retrying a refused write until the
	 * MAX_WRITE_ATTEMPTS budget is spent and then emitting one rate-limited line.
	 * The happy path is a single fwrite.
	 *
	 * The return is the bytes that landed rather than a success flag, because
	 * `Partition_Node::flush()` advances `current_size` and its index offsets by
	 * that number, and a count overstating the write would point index entries
	 * past the end of a torn segment. Landed bytes also advance the
	 * `$bytes_written` counter `Node` declares and nothing else in the substrate
	 * moves. A closed or unwritable handle takes the same loud path as a full
	 * disk, because the default seam returns false for a non-resource instead of
	 * raising a TypeError.
	 *
	 * @param resource    $fh      Open, writable handle.
	 * @param string      $bytes   Bytes to write.
	 * @param string|null $context Path or label for the failure line; cold path only.
	 * @return int Bytes written, equal to strlen( $bytes ) on full success.
	 */
	protected function write_all( $fh, string $bytes, ?string $context = null ): int {
		$total     = \strlen( $bytes );
		$remaining = $bytes;
		$attempts  = 0;
		// phpcs:ignore WordPress.WP.AlternativeFunctions.file_system_operations_fwrite, WordPressVIPMinimum.Functions.RestrictedFunctions.file_ops_fwrite
		$call = self::$fwrite ?? static fn ( mixed $write_fh, string $chunk ): int|false => \is_resource( $write_fh ) ? @\fwrite( $write_fh, $chunk ) : false;
		while ( '' !== $remaining ) {
			$written = $call( $fh, $remaining );
			if ( false === $written || 0 === $written ) {
				if ( ++$attempts >= static::MAX_WRITE_ATTEMPTS ) {
					$where = ( null === $context || '' === $context ) ? '' : " for $context";
					$this->print_less_often( 'write stalled after ', (string) $attempts, ' attempts', $where );
					break;
				}
				continue;
			}
			$this->bytes_written += $written;
			$remaining            = \substr( $remaining, $written );
		}
		return $total - \strlen( $remaining );
	}
}
