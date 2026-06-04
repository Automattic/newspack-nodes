<?php
/**
 * Tail: generic file follower. poll() reads new bytes and emits per buffer_mode; inode + size-shrink rotation detection.
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes;

\defined( 'ABSPATH' ) || exit;

class Tail_Node extends Timer_Node {
	public const READ_CHUNK = 65536;

	/** Hard cap on cross-poll trailing-line buffer (20MB); DoS guard against a no-newline file ballooning line_remainder until OOM. */
	public const MAX_LINE_BUFFER_SIZE = 20971520;

	/** Re-arm interval at EOF (idle backoff). */
	public const POLL_INTERVAL_EOF_MS = 100;

	/** Re-arm interval when the file has unread bytes. 0 = next event-loop iteration. */
	public const POLL_INTERVAL_BUSY_MS = 0;

	protected string $filename     = '';
	protected string $buffer_mode  = 'line-buffered';
	private int $position          = 0;
	private ?int $inode            = null;
	private string $line_remainder = '';

	/** True once the last poll consumed everything available. */
	protected bool $at_eof = true;

	/**
	 * Tachikoma-parity: no-arg ctor. Positional config arrives via `arguments()`,
	 * which the base setter parses against `node_schema()['arguments']`. The
	 * override below kicks off the EOF-cadence poll timer.
	 */
	public function __construct() {
		parent::__construct();
	}

	/**
	 * Setter chains through the base schema walker (which assigns filename /
	 * buffer_mode from positional tokens), then arms the poll timer.
	 *
	 * @param string|null $args
	 * @return string
	 */
	public function arguments( ?string $args = null ): string {
		if ( null === $args ) {
			return parent::arguments();
		}
		$result = parent::arguments( $args );
		if ( '' === $args ) {
			return $result;
		}
		// fire() re-arms with set_timer(0)/(100) based on bytes available.
		$this->set_timer( self::POLL_INTERVAL_EOF_MS, true );
		return $result;
	}

	public function poll(): void {
		\clearstatcache( true, $this->filename );
		if ( ! \file_exists( $this->filename ) ) {
			return;
		}

		$stat = @\stat( $this->filename );
		if ( false === $stat ) {
			return;
		}
		$current_inode = $stat['ino'];
		$current_size  = $stat['size'];

		if ( null !== $this->inode && $current_inode !== $this->inode ) {
			$this->position       = 0;
			$this->line_remainder = '';
			$this->set_state( 'ROTATED', [ 'inode' => $current_inode ] );
		}
		if ( $current_size < $this->position ) {
			$this->position       = 0;
			$this->line_remainder = '';
			$this->set_state( 'TRUNCATED', [ 'size' => $current_size ] );
		}
		$this->inode = $current_inode;

		if ( $current_size <= $this->position ) {
			$this->at_eof = true;
			return;
		}

		// WP_Filesystem can't tail incrementally — need fopen/fread directly.
		// phpcs:disable WordPress.WP.AlternativeFunctions.file_system_operations_fopen, WordPress.WP.AlternativeFunctions.file_system_operations_fread
		$fh = @\fopen( $this->filename, 'r' );
		if ( false === $fh ) {
			$this->at_eof = true;
			return;
		}
		\fseek( $fh, $this->position );
		// Bound per-poll read to READ_CHUNK so a multi-MB append doesn't block the loop; later polls drain the rest.
		$bytes = \fread( $fh, \min( self::READ_CHUNK, \max( 1, $current_size - $this->position ) ) );
		\fclose( $fh );
		// phpcs:enable
		if ( false === $bytes || '' === $bytes ) {
			$this->at_eof = true;
			return;
		}
		$read_len         = \strlen( $bytes );
		$this->position  += $read_len;
		$this->bytes_read += $read_len;

		// at_eof iff we drained the tail this poll; a READ_CHUNK-capped read leaves more waiting (busy mode).
		$this->at_eof = ( $this->position >= $current_size );

		$this->emit( $bytes );
	}

	private function emit( string $bytes ): void {
		switch ( $this->buffer_mode ) {
			case 'binary':
				// No line awareness: emit bytes as-is (lines may split across messages).
				$this->emit_message( $bytes );
				return;
			case 'block-buffered':
				// DoS guard: bound line_remainder.
				if ( \strlen( $this->line_remainder ) + \strlen( $bytes ) > self::MAX_LINE_BUFFER_SIZE ) {
					$this->print_less_often(
						\sprintf(
							'Tail: line buffer exceeded %d bytes for %s - discarding',
							self::MAX_LINE_BUFFER_SIZE,
							$this->filename
						)
					);
					$this->line_remainder = '';
					$nl                   = \strpos( $bytes, "\n" );
					if ( false !== $nl ) {
						$this->line_remainder = \substr( $bytes, $nl + 1 );
					}
					return;
				}
				// Emit up to (and including) the LAST newline; trailing partial carries forward so a chunk boundary never splits a line.
				$buf = $this->line_remainder . $bytes;
				$nl  = \strrpos( $buf, "\n" );
				if ( false === $nl ) {
					$this->line_remainder = $buf;
					return;
				}
				$this->emit_message( \substr( $buf, 0, $nl + 1 ) );
				$this->line_remainder = \substr( $buf, $nl + 1 );
				return;
			case 'line-buffered':
			default:
				// DoS guard: over-cap means a corrupt no-newline source; discard remainder and resync at the next newline.
				if ( \strlen( $this->line_remainder ) + \strlen( $bytes ) > self::MAX_LINE_BUFFER_SIZE ) {
					$this->print_less_often(
						\sprintf(
							'Tail: line buffer exceeded %d bytes for %s - discarding',
							self::MAX_LINE_BUFFER_SIZE,
							$this->filename
						)
					);
					$this->line_remainder = '';
					$nl                   = \strpos( $bytes, "\n" );
					if ( false !== $nl ) {
						$this->line_remainder = \substr( $bytes, $nl + 1 );
					}
					return;
				}
				$buf                  = $this->line_remainder . $bytes;
				$lines                = \explode( "\n", $buf );
				$this->line_remainder = \array_pop( $lines );
				foreach ( $lines as $line ) {
					$this->emit_message( $line . "\n" );
				}
				return;
		}
	}

	private function emit_message( string $value ): void {
		$msg                       = Message::new_message();
		$msg[ Message::TYPE ]      = Message::TM_BYTESTREAM;
		$msg[ Message::TIMESTAMP ] = Core::$now;
		$msg[ Message::FROM ]      = $this->name;
		$msg[ Message::VALUE ]     = $value;
		// Route through parent::fill so a connect_node-set target gets stamped into TO; otherwise TO='' and Router can't dispatch.
		parent::fill( $msg );
	}

	/** Timer-driven: poll, emit, then re-arm at 0ms (more bytes) or 100ms (at EOF idle). */
	protected function fire(): void {
		$this->poll();
		$next_ms = $this->at_eof ? self::POLL_INTERVAL_EOF_MS : self::POLL_INTERVAL_BUSY_MS;
		$this->set_timer( $next_ms, true );
	}

	public static function node_schema(): array {
		return \array_merge( parent::node_schema(), [
			'category'    => 'I/O',
			'description' => 'Polls a file for appended bytes; emits each line to its sink.',
			'arguments'        => [
				[ 'name' => 'filename',    'type' => 'string', 'required' => true ],
				[
					'name'    => 'buffer_mode',
					'type'    => 'string',
					'default' => 'line-buffered',
					'enum'    => [ 'line-buffered', 'block-buffered', 'binary' ],
				],
			],
			'accepts_fill' => false,
		] );
	}
}
