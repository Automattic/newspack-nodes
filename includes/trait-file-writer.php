<?php
/**
 * File_Writer: the substrate's fail-loud durable-write primitive.
 *
 * Only file-writing nodes (Log, Partition) `use` this — a logic node has no
 * business carrying an fwrite retry loop. write_all() never silently swallows a
 * stalled write: it retries short writes, counts a write_failure, and emits one
 * rate-limited line. Increments the shared $bytes_written counter (declared on
 * Node, populated only by I/O nodes) and reads $this->print_less_often().
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes;

\defined( 'ABSPATH' ) || exit;

trait File_Writer {

	/** Retry budget for a short/failed write before write_all() gives up and counts a failure. */
	protected const MAX_WRITE_ATTEMPTS = 5;

	/**
	 * The fail-loud write seam: write every byte of $bytes to $fh, retrying short
	 * writes up to MAX_WRITE_ATTEMPTS, and on a stall (disk full / broken pipe)
	 * count a write_failure and emit one rate-limited line — a failed write is
	 * never silently swallowed. Returns the bytes that actually landed so the
	 * caller advances its size/offset by the real amount, never drifting against
	 * the file. The happy path is one fwrite.
	 *
	 * @param resource    $fh      Open, writable handle.
	 * @param string      $bytes   Bytes to write.
	 * @param string|null $context Path/label for the failure line (cold path only).
	 * @return int Bytes written (== strlen( $bytes ) on full success).
	 */
	protected function write_all( $fh, string $bytes, ?string $context = null ): int {
		$total     = \strlen( $bytes );
		$remaining = $bytes;
		$attempts  = 0;
		while ( '' !== $remaining ) {
			// phpcs:ignore WordPress.WP.AlternativeFunctions.file_system_operations_fwrite, WordPressVIPMinimum.Functions.RestrictedFunctions.file_ops_fwrite
			$written = @\fwrite( $fh, $remaining );
			if ( false === $written || 0 === $written ) {
				if ( ++$attempts >= static::MAX_WRITE_ATTEMPTS ) {
					$where = ( null === $context || '' === $context ) ? '' : " for $context";
					$this->print_less_often( "write stalled after $attempts attempts$where" );
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
