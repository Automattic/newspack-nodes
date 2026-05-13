<?php
/**
 * Log: file-writing node — inverse of Tail.
 *
 * Appends each fill()'d message's VALUE to a regular file. Designed for
 * human-readable structured-text logs (e.g. application audit trails) where
 * the on-disk shape is the producer's payload, not the packed Message
 * envelope Partition uses.
 *
 * Append vs overwrite, optional size-based rotation, and a `rotate` TM_REQUEST
 * for external scheduler-driven nightly rotation. Mirrors Tachikoma::Nodes::Log.
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes;

\defined( 'ABSPATH' ) || exit;

class Log extends Node {
	public const MODE_APPEND    = 'append';
	public const MODE_OVERWRITE = 'overwrite';

	protected string $filename;
	protected string $mode;
	protected int $max_size;
	protected int $max_rotations;
	protected int $size = 0;
	/** @var resource|null */
	protected $fh = null;

	public function __construct(
		string $filename,
		string $mode = self::MODE_APPEND,
		int $max_size = 0,
		int $max_rotations = 0
	) {
		$this->filename      = $filename;
		$this->mode          = $mode;
		$this->max_size      = \max( 0, $max_size );
		$this->max_rotations = \max( 0, $max_rotations );
		// Log node writes to operator-configured paths (base_dir-relative or
		// caller-supplied) — not WP-managed storage.
		// phpcs:ignore WordPress.WP.AlternativeFunctions.file_system_operations_fopen
		$this->fh            = \fopen( $filename, self::MODE_OVERWRITE === $mode ? 'wb' : 'ab' );
		// Track in-progress size so max_size triggers auto-rotate. Append-
		// mode reopens may pick up a non-zero start offset.
		$this->size = ( self::MODE_APPEND === $mode && \is_resource( $this->fh ) )
			? (int) \ftell( $this->fh )
			: 0;
		// Round-trip ctor args via Node::$arguments so dump_config emits a
		// `make_node Log <name> <filename> <mode> <max_size> <max_rotations>`
		// line that re-creates this instance.
		$this->arguments = "{$this->filename} {$this->mode} {$this->max_size} {$this->max_rotations}";
	}

	public function fill( array &$message ): void {
		++$this->counter;
		$type = $message[ Message::TYPE ];

		if ( $type & Message::TM_ERROR ) {
			return;
		}
		if ( $type & Message::TM_EOF ) {
			// Overwrite mode is single-shot: close the file and remove the
			// node when the producer signals end-of-stream. Append mode
			// keeps the FD open — more data may arrive later.
			if ( self::MODE_OVERWRITE === $this->mode ) {
				$this->remove_node();
			}
			return;
		}
		if ( $type & Message::TM_REQUEST ) {
			$value = (string) $message[ Message::VALUE ];
			// Single recognized verb today: `rotate`. Mirrors Tachikoma
			// Log.pm's `rotate` request handler.
			if ( 'rotate' === $value || 0 === \strpos( $value, 'rotate ' ) ) {
				$this->rotate();
			}
			return;
		}
		$value      = (string) $message[ Message::VALUE ];
		$this->size += \strlen( $value );
		// phpcs:ignore WordPressVIPMinimum.Functions.RestrictedFunctions.file_ops_fwrite
		\fwrite( $this->fh, $value );
		// Auto-rotate after the write so the bytes that pushed us over the
		// limit are preserved in the rotated file rather than starting the
		// new one. max_size=0 disables auto-rotation.
		if ( $this->max_size > 0 && $this->size > $this->max_size ) {
			$this->rotate();
		}
	}

	/**
	 * Close the current file, rename it with a timestamp suffix, then reopen
	 * the original path so subsequent writes start a fresh file. Mirrors
	 * Tachikoma Log.pm:rotate.
	 */
	public function rotate(): void {
		if ( \is_resource( $this->fh ) ) {
			\fclose( $this->fh );
			$this->fh = null;
		}
		// Rotation suffix is a server-local timestamp; gmdate would be UTC
		// which is harder to correlate with operator timezones when reading
		// rotated logs on disk.
		// phpcs:ignore WordPress.DateTime.RestrictedFunctions.date_date
		$rotated_name = $this->filename . '-' . \date( 'Y-m-d-H:i:s' ) . '-' . Core::msg_counter();
		// phpcs:disable WordPressVIPMinimum.Functions.RestrictedFunctions.file_ops_rename, WordPress.WP.AlternativeFunctions.file_system_operations_fopen
		@\rename( $this->filename, $rotated_name );
		$this->fh   = \fopen( $this->filename, self::MODE_OVERWRITE === $this->mode ? 'wb' : 'ab' );
		// phpcs:enable
		$this->size = 0;
		$this->set_state( 'ROTATED', [ 'rotated_to' => $rotated_name ] );
		$this->prune_rotated();
	}

	/**
	 * Keep only the `max_rotations` most-recent rotated siblings; unlink
	 * the rest. mtime-ordered (not filename-ordered) so the prune contract
	 * survives any future change to the rotated-name format. max_rotations=0
	 * disables pruning — operator drives cleanup externally.
	 *
	 * Sibling discovery uses `glob({filename}-*)`, which matches anything in
	 * the same directory whose name starts with the exact `{filename}-`
	 * prefix. Unrelated files (`error.log`, `app.log`, `notes.txt`) are
	 * untouched. Don't store unrelated files under the same prefix —
	 * `out.log-keep_forever` would be eligible for pruning.
	 */
	protected function prune_rotated(): void {
		if ( $this->max_rotations <= 0 ) {
			return;
		}
		$rotated = \glob( $this->filename . '-*' ) ?: [];
		if ( \count( $rotated ) <= $this->max_rotations ) {
			return;
		}
		\usort(
			$rotated,
			static fn( $a, $b ) => \filemtime( $a ) <=> \filemtime( $b )
		);
		// Oldest are at the head; drop the tail-N keepers and unlink the rest.
		$to_delete = \array_slice( $rotated, 0, \count( $rotated ) - $this->max_rotations );
		foreach ( $to_delete as $path ) {
			// phpcs:ignore WordPressVIPMinimum.Functions.RestrictedFunctions.file_ops_unlink
			@\unlink( $path );
		}
		if ( ! empty( $to_delete ) ) {
			$this->set_state(
				'PRUNED',
				[ 'removed' => \count( $to_delete ), 'kept' => $this->max_rotations ]
			);
		}
	}

	public function remove_node(): void {
		if ( \is_resource( $this->fh ) ) {
			\fclose( $this->fh );
			$this->fh = null;
		}
		parent::remove_node();
	}
}
