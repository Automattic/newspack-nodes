<?php
/**
 * Tail: durable, segmented file follower.
 *
 * A Tail is a Consumer that reads a Log's {file}.{seg} segments (a file layout,
 * via a Log_Node source) and emits the raw bytes per buffer_mode (line / block /
 * binary, wrapped as TM_BYTESTREAM) instead of unpacking packed Messages.
 * Everything else — the durable offsetlog cursor (resume-after-restart), snapshot
 * co-commit, live-position publish, behind/ETA, checkpoint cadence, and
 * segment-roll follow — is inherited from Consumer_Node. A fresh Tail with no
 * durable cursor defaults to END (only bytes appended after start), which is the
 * fix for the old every-restart full re-read.
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes;

\defined( 'ABSPATH' ) || exit;

class Tail_Node extends Consumer_Node {

	/** Source log base path; segments are {source_file}.0, {source_file}.1, … */
	protected string $source_file = '';

	/** line-buffered (one msg/line) | block-buffered (one msg up to last NL) | binary (raw chunk). */
	protected string $buffer_mode = 'line-buffered';

	/** Seam: read a Log ({file}.{seg}), not a Partition ({dir}/{seg}.log). */
	protected function make_source(): Partition_Node {
		return new Log_Node();
	}

	/** Seam: Tail's args are source_file + offsetlog_dir. */
	protected function resolve_args(): array {
		return [ $this->source_file, $this->offsetlog_dir ];
	}

	/** Seam: a fresh Tail with no durable cursor starts at END. */
	protected function default_offset(): ?string {
		return 'end';
	}

	/**
	 * Deframe/emit seam (overrides Consumer's Message-unpacking drain): emit the
	 * buffered bytes per buffer_mode as TM_BYTESTREAM VALUEs and advance the cursor
	 * by what was emitted. binary = the whole buffer; line-buffered = one message
	 * per complete line; block-buffered = everything up to the last newline in one
	 * message. A trailing partial line carries forward in $buffer (line/block).
	 */
	protected function drain_buffer(): void {
		if ( '' === $this->buffer ) {
			return;
		}

		if ( 'binary' === $this->buffer_mode ) {
			$bytes             = $this->buffer;
			$this->buffer      = '';
			$this->cursor_off += \strlen( $bytes );
			$this->emit_bytes( $bytes );
			return;
		}

		$nl = \strrpos( $this->buffer, "\n" );
		if ( false === $nl ) {
			// No complete line yet. DoS guard: a single line can't grow past the cap.
			if ( \strlen( $this->buffer ) > self::MAX_LINE_BUFFER_SIZE ) {
				$this->print_less_often(
					\sprintf( 'Tail: line buffer exceeded %d bytes at seg %d - discarding', self::MAX_LINE_BUFFER_SIZE, $this->cursor_seg )
				);
				$this->set_state( 'OVERFLOW', [ 'seg' => $this->cursor_seg, 'off' => $this->cursor_off, 'limit' => self::MAX_LINE_BUFFER_SIZE ] );
				$this->cursor_off += \strlen( $this->buffer );
				$this->buffer      = '';
			}
			return;
		}

		$complete         = \substr( $this->buffer, 0, $nl + 1 );
		$this->buffer     = \substr( $this->buffer, $nl + 1 );
		$this->cursor_off += \strlen( $complete );

		if ( 'block-buffered' === $this->buffer_mode ) {
			$this->emit_bytes( $complete );
			return;
		}
		foreach ( \explode( "\n", \rtrim( $complete, "\n" ) ) as $line ) {
			$this->emit_bytes( $line . "\n" );
		}
	}

	/** Mint a TM_BYTESTREAM carrying raw bytes (FROM-stamped at this I/O boundary) and forward. */
	private function emit_bytes( string $bytes ): void {
		$size = \strlen( $bytes );
		if ( $size > $this->largest_msg_sent ) {
			$this->largest_msg_sent = $size;
		}
		$msg                       = Message::new_message();
		$msg[ Message::TYPE ]      = Message::TM_BYTESTREAM;
		$msg[ Message::TIMESTAMP ] = Core::$now;
		$msg[ Message::FROM ]      = '' !== $this->stamp_override ? $this->stamp_override : $this->name;
		$msg[ Message::VALUE ]     = $bytes;
		parent::fill( $msg );
	}

	public static function node_schema(): array {
		return \array_merge( parent::node_schema(), [
			'description' => 'Tails a Log\'s {file}.{seg} segments; emits raw bytes per buffer_mode to its sink.',
			'arguments'   => [
				[ 'name' => 'source_file',   'type' => 'string', 'required' => true ],
				[ 'name' => 'offsetlog_dir', 'type' => 'string', 'default' => '' ],
				[
					'name'    => 'buffer_mode',
					'type'    => 'string',
					'default' => 'line-buffered',
					'enum'    => [ 'line-buffered', 'block-buffered', 'binary' ],
				],
			],
		] );
	}
}
