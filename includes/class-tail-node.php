<?php
/**
 * Tail: durable, segmented file follower.
 *
 * A Tail is a Consumer that reads a Log's {file}.{seg} segments (a file layout, via
 * a Log_Node source) and emits each complete line's raw bytes as a TM_BYTESTREAM
 * instead of unpacking packed Messages — by overriding the single per-line emit seam,
 * forward_line(). Everything else — the buffer/cursor scan, the durable offsetlog
 * cursor (resume-after-restart), snapshot co-commit, live-position publish, behind/ETA,
 * checkpoint cadence, and segment-roll follow — is inherited from Consumer_Node. A fresh
 * Tail with no durable cursor defaults to END (only bytes appended after start).
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes;

\defined( 'ABSPATH' ) || exit;

class Tail_Node extends Consumer_Node {

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
	 * The buffer/cursor scan that hands us each line stays in Consumer::drain_buffer(), so a
	 * Tail also gets line_mode (one line per poll) for free. $abs_offset is unused: a Tail
	 * mints a fresh byte message rather than carrying the producer's seg:offset breadcrumb.
	 *
	 * @param string $line       One complete line (without its trailing newline).
	 * @param int    $abs_offset The line's start offset (unused here).
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
		$message[ Message::VALUE ]     = $bytes;
		parent::fill( $message );
	}

	public static function node_schema(): array {
		return \array_merge( parent::node_schema(), [
			'description' => 'Tails a Log\'s {file}.{seg} segments; emits each line as raw TM_BYTESTREAM bytes to its sink.',
			// Override Consumer's source_dir naming (Tail's property is source_file), but
			// keep the inherited optional deadletter_dir so a Tail can quarantine poison too.
			'arguments'   => [
				[ 'name' => 'source_file',    'type' => 'string', 'required' => true ],
				[ 'name' => 'offsetlog_dir',  'type' => 'string', 'default' => '' ],
				[ 'name' => 'deadletter_dir', 'type' => 'string', 'default' => '' ],
			],
		] );
	}
}
