<?php
/**
 * Tail: generic file follower.
 *
 * Constructor takes filename + buffer_mode (line-buffered/block-buffered/binary).
 * poll() reads new bytes since last read and emits per buffer_mode rules.
 * Inode + size-shrink rotation detection on each poll.
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes;

\defined( 'ABSPATH' ) || exit;

class Tail extends Node {
	public const READ_CHUNK = 65536;

	/**
	 * Hard cap on cross-poll trailing-line buffer (20MB). Protects against DoS from
	 * a runaway file with no newlines — without this, line_remainder can balloon
	 * unboundedly until the worker OOMs.
	 */
	public const MAX_LINE_BUFFER_SIZE = 20971520;

	private string $filename;
	private string $buffer_mode;
	private int $position = 0;
	private ?int $inode = null;
	private string $line_remainder = '';

	public function __construct( string $filename, string $buffer_mode = 'line-buffered' ) {
		$this->filename    = $filename;
		$this->buffer_mode = $buffer_mode;
	}

	public function poll(): void {
		\clearstatcache( true, $this->filename );
		if ( ! \file_exists( $this->filename ) ) {
			return;
		}

		$stat = @\stat( $this->filename );
		if ( $stat === false ) {
			return;
		}
		$current_inode = $stat['ino'];
		$current_size  = $stat['size'];

		// Rotation: inode changed.
		if ( $this->inode !== null && $current_inode !== $this->inode ) {
			$this->position       = 0;
			$this->line_remainder = '';
		}
		// Truncation: size shrank.
		if ( $current_size < $this->position ) {
			$this->position       = 0;
			$this->line_remainder = '';
		}
		$this->inode = $current_inode;

		if ( $current_size <= $this->position ) {
			return;
		}

		$fh = @\fopen( $this->filename, 'r' );
		if ( $fh === false ) {
			return;
		}
		\fseek( $fh, $this->position );
		// Bound per-poll syscall to READ_CHUNK so a multi-MB append doesn't block
		// the event loop in a single fread. Subsequent polls drain the rest.
		$bytes = \fread( $fh, \min( self::READ_CHUNK, $current_size - $this->position ) );
		\fclose( $fh );
		if ( $bytes === false || $bytes === '' ) {
			return;
		}
		$this->position += \strlen( $bytes );

		$this->emit( $bytes );
	}

	private function emit( string $bytes ): void {
		switch ( $this->buffer_mode ) {
			case 'binary':
				$this->emit_message( $bytes );
				return;
			case 'block-buffered':
				$this->emit_message( $bytes );
				return;
			case 'line-buffered':
			default:
				// DoS guard: if appending would exceed MAX_LINE_BUFFER_SIZE, the source
				// isn't producing newlines (corrupt). Discard remainder + advance to next
				// newline boundary so we recover at a clean line break.
				if ( \strlen( $this->line_remainder ) + \strlen( $bytes ) > self::MAX_LINE_BUFFER_SIZE ) {
					Core::print_less_often(
						\sprintf(
							'Tail: line buffer exceeded %d bytes for %s - discarding',
							self::MAX_LINE_BUFFER_SIZE,
							$this->filename
						)
					);
					$this->line_remainder = '';
					$nl                   = \strpos( $bytes, "\n" );
					if ( false !== $nl ) {
						// Drop everything up through the newline; carry tail as remainder.
						$tail = \substr( $bytes, $nl + 1 );
						$this->line_remainder = $tail;
					}
					return;
				}
				$buf                  = $this->line_remainder . $bytes;
				$lines                = \explode( "\n", $buf );
				$this->line_remainder = (string) \array_pop( $lines );
				foreach ( $lines as $line ) {
					$this->emit_message( $line . "\n" );
				}
				return;
		}
	}

	private function emit_message( string $value ): void {
		$msg                       = Message::new_message();
		$msg[ Message::TYPE ]      = Message::TM_BYTESTREAM;
		$msg[ Message::TIMESTAMP ] = Core::$right_now;
		$msg[ Message::FROM ]      = $this->name;
		$msg[ Message::VALUE ]     = $value;
		$this->sink?->fill( $msg );
	}

	public function fill( array &$message ): void {
		++$this->counter;
		// Tail is poll-driven; fill() forwards.
		$this->sink?->fill( $message );
	}
}
