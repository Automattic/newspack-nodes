<?php
/**
 * Tail: durable follower of a Log's `{file}.{seg}` segments.
 *
 * Reads through the inherited Consumer/Log/Partition read model — resume,
 * snapshot co-commit, segment-roll and all — differing from Consumer only in
 * three seams it declares below: it reads a `Log` (`{file}.{seg}`) rather than a
 * `Partition` (`{dir}/{seg}.log`), its first argument is a source FILE base
 * rather than a dir, and a fresh Tail with no durable cursor starts at END.
 * Each complete line's raw bytes are emitted as a TM_BYTESTREAM by
 * `forward_line()`.
 *
 * `File_Tail_Node` is the sibling that follows a SINGLE filename with `tail -F`
 * logrotate semantics. It is a subclass rather than a mode flag on this class:
 * the two share the Buffered_Pump line-assembly spine and the durable offsetlog
 * cursor, and differ only in the byte source.
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes;

\defined( 'ABSPATH' ) || exit;

class Tail_Node extends Consumer_Node {

	/**
	 * Registry mode tokens `Log_Sources` entries carry, and the reader class
	 * each resolves to. They describe a SOURCE, not a flag on this node —
	 * `Log_Sources::open_tail()` is what turns one into a reader.
	 */
	public const MODE_SEGMENTED = 'segmented';
	public const MODE_FILE      = 'file';

	/** Source log base path; segments are {source_file}.0, {source_file}.1, … */
	protected string $source_file = '';

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
	 * Emit seam (overrides Consumer's Message-unpacking forward): emit one complete line's
	 * raw bytes — newline restored — as a TM_BYTESTREAM, FROM-stamped at this I/O boundary.
	 * The buffer/cursor scan that hands us each line stays in Buffered_Pump::drain_buffer(),
	 * so both source shapes reuse it (and both get line_mode for free). The ID carries this
	 * Tail's OWN position breadcrumb — `segment:offset:length` (in File_Tail the inode rides
	 * the segment slot) — which the browser seek tracker reads for its Replay→Live flip;
	 * the empty default silently disabled that flip for every Tail-fed stream.
	 *
	 * @param string $line       One complete line (without its trailing newline).
	 * @param int    $abs_offset The line's start offset within the current segment/generation.
	 */
	protected function forward_line( string $line, int $abs_offset ): void {
		$bytes = $line . "\n";
		$size  = \strlen( $bytes );
		if ( $size > $this->largest_msg_sent ) {
			$this->largest_msg_sent = $size;
		}
		$message                       = Message::new_message();
		$message[ Message::TYPE ]      = Message::TM_BYTESTREAM;
		$message[ Message::TIMESTAMP ] = Core::$now;
		$message[ Message::FROM ]      = '' !== $this->stamp_override ? $this->stamp_override : $this->name;
		$message[ Message::ID ]        = "{$this->cursor_segment}:{$abs_offset}:{$size}";
		$message[ Message::VALUE ]     = $bytes;
		parent::fill( $message );
	}

	public static function node_schema(): array {
		$schema = parent::node_schema();
		// Only the source argument differs; the rest are Consumer's verbatim.
		$arguments      = Core::arr( $schema['arguments'] ?? [] );
		$arguments[0]   = [
			'name'        => 'source_file',
			'type'        => 'string',
			'required'    => true,
			'description' => 'Base path of the Log to poll ({source_file}.0, .1, …). Each complete line is emitted.',
		];
		return \array_merge( $schema, [
			'description' => 'Tails a Log\'s {file}.{seg} segments; emits each line as raw TM_BYTESTREAM bytes to its sink.',
			'arguments'   => \array_values( $arguments ),
		] );
	}
}
