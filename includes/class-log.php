<?php
/**
 * Log: file-writing node — appends each fill()'d message's VALUE (the producer's payload, not the packed envelope) to a file.
 *
 * Append vs overwrite, optional size-based rotation, and a `rotate` TM_REQUEST. Mirrors Tachikoma::Nodes::Log.
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes;

\defined( 'ABSPATH' ) || exit;

class Log_Node extends Node {
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
		// Operator-configured paths, not WP-managed storage. Create the parent
		// dir so a configured path under a not-yet-existing directory writes
		// instead of silently failing on a bad fopen (e.g. an example topology's
		// /tmp/<plugin>/out.log before anything else has made the dir).
		$dir = \dirname( $filename );
		if ( '' !== $dir && '.' !== $dir && ! \is_dir( $dir ) ) {
			// phpcs:ignore WordPressVIPMinimum.Functions.RestrictedFunctions.directory_mkdir
			@\mkdir( $dir, 0755, true );
		}
		// phpcs:ignore WordPress.WP.AlternativeFunctions.file_system_operations_fopen
		$this->fh            = \fopen( $filename, self::MODE_OVERWRITE === $mode ? 'wb' : 'ab' );
		// Track size so max_size triggers auto-rotate; append-mode reopens may start non-zero.
		$this->size = ( self::MODE_APPEND === $mode && \is_resource( $this->fh ) )
			? (int) \ftell( $this->fh )
			: 0;
		// Round-trip ctor args via Node::$arguments for dump_config.
		$this->arguments = "{$this->filename} {$this->mode} {$this->max_size} {$this->max_rotations}";
	}

	public function fill( array &$message ): void {
		++$this->counter;
		$type = $message[ Message::TYPE ];

		if ( $type & Message::TM_ERROR ) {
			return;
		}
		if ( $type & Message::TM_EOF ) {
			// Overwrite mode is single-shot; append mode keeps the FD open for later data.
			if ( self::MODE_OVERWRITE === $this->mode ) {
				$this->remove_node();
			}
			return;
		}
		if ( $type & Message::TM_REQUEST ) {
			$value = (string) $message[ Message::VALUE ];
			if ( 'rotate' === $value || 0 === \strpos( $value, 'rotate ' ) ) {
				$this->rotate();
			}
			return;
		}
		// No open handle (mkdir/fopen failed — bad path or permissions). Warn
		// once per window instead of fatally fwrite()-ing to a non-resource.
		if ( ! \is_resource( $this->fh ) ) {
			Core::print_less_often( "Log: cannot write to {$this->filename} (no open file handle)" );
			return;
		}
		$value                = (string) $message[ Message::VALUE ];
		$write_len            = \strlen( $value );
		$this->size          += $write_len;
		$this->bytes_written += $write_len;
		if ( $write_len > $this->largest_msg_sent ) {
			$this->largest_msg_sent = $write_len;
		}
		// phpcs:ignore WordPressVIPMinimum.Functions.RestrictedFunctions.file_ops_fwrite
		\fwrite( $this->fh, $value );
		// Rotate AFTER the write so the over-limit bytes land in the rotated file; max_size=0 disables.
		if ( $this->max_size > 0 && $this->size > $this->max_size ) {
			$this->rotate();
		}
	}

	/** Close, rename with a timestamp suffix, reopen the original path for a fresh file. Mirrors Tachikoma Log.pm:rotate. */
	public function rotate(): void {
		if ( \is_resource( $this->fh ) ) {
			\fclose( $this->fh );
			$this->fh = null;
		}
		// Server-local timestamp (not gmdate) to match operator timezones when reading rotated logs.
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

	/** Keep the `max_rotations` newest rotated siblings (mtime-ordered), unlink the rest; max_rotations=0 disables. Globs `{filename}-*`, so don't co-locate other files there. */
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

	public static function node_schema(): array {
		return \array_merge( parent::node_schema(), [
			'category'    => 'I/O',
			'description' => 'Append-only file writer with rotation by line count.',
			'ctor'        => [
				[ 'name' => 'filename',      'type' => 'string', 'required' => true ],
				[ 'name' => 'mode',          'type' => 'string', 'default' => self::MODE_APPEND, 'enum' => [ self::MODE_APPEND, self::MODE_OVERWRITE ] ],
				[ 'name' => 'max_size',      'type' => 'int',    'default' => 0 ],
				[ 'name' => 'max_rotations', 'type' => 'int',    'default' => 0 ],
			],
			'commands'       => [],
			'requests'    => [
				[
					'name'        => 'rotate',
					'description' => 'Rotate the log file: close current, rename to {filename}-{ts}, reopen.',
				],
			],
			'has_target'  => false,
		] );
	}
}
