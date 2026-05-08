<?php
/**
 * Consumer: Partition-aware reader with offsetlog checkpointing.
 *
 * Generalizes existing LogReader. Reads new entries from a Partition's segment
 * series; commits {seg, off} to its offsetlog (which is itself a single-partition
 * Partition under offsets/{reader}/p0/) on checkpoint.
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes;

\defined( 'ABSPATH' ) || exit;

class Consumer extends Node {
	protected string $source_base_dir;
	protected int $source_partition;
	protected string $offsetlog_dir;
	protected Partition $source;
	protected Partition $offsetlog;

	protected int $cursor_seg = 0;
	protected int $cursor_off = 0;

	public function __construct(
		string $source_base_dir,
		int $source_partition,
		string $offsetlog_base_dir
	) {
		$this->source_base_dir  = \rtrim( $source_base_dir, '/' );
		$this->source_partition = $source_partition;
		$this->offsetlog_dir    = \rtrim( $offsetlog_base_dir, '/' );

		$this->source    = new Partition( $this->source_base_dir, $this->source_partition );
		$this->offsetlog = new Partition( $this->offsetlog_dir, 0 );
		$this->offsetlog->allow_large_writes(); // Offsetlog entries with large state can exceed 4KB.

		$this->load_offsetlog();
	}

	/**
	 * Read the newest offsetlog entry to seed the cursor.
	 * Format: JSONL with {seg, off, ts}.
	 */
	protected function load_offsetlog(): void {
		$segments = $this->offsetlog->get_segments( true );
		if ( empty( $segments ) ) {
			return;
		}
		$newest = \end( $segments );
		$bytes  = $this->offsetlog->read_at( $newest['id'], 0, $newest['size'] );
		$lines  = \array_filter( \explode( "\n", $bytes ), static fn ( $l ) => $l !== '' );
		if ( empty( $lines ) ) {
			return;
		}
		$last = \json_decode( \end( $lines ), true );
		if ( \is_array( $last ) && isset( $last['seg'], $last['off'] ) ) {
			$this->cursor_seg = (int) $last['seg'];
			$this->cursor_off = (int) $last['off'];
		}
	}

	/**
	 * Read new bytes since the last cursor; emit a TM_BYTESTREAM per line; advance cursor.
	 * KEY = "{seg}:{offset}" so the offsetlog can checkpoint by segment+offset.
	 */
	public function poll(): void {
		$segments = $this->source->get_segments( true );
		foreach ( $segments as $s ) {
			if ( $s['id'] < $this->cursor_seg ) {
				continue;
			}
			$start = ( $s['id'] === $this->cursor_seg ) ? $this->cursor_off : 0;
			$len   = $s['size'] - $start;
			if ( $len <= 0 ) {
				continue;
			}
			$bytes = $this->source->read_at( $s['id'], $start, $len );
			if ( $bytes === '' ) {
				continue;
			}
			// Line-buffered emission: split, drop trailing partial, emit each complete line.
			$lines = \explode( "\n", $bytes );
			$pending_remainder = \array_pop( $lines ); // Last partial (may be empty).
			$consumed = 0;
			foreach ( $lines as $line ) {
				$consumed += \strlen( $line ) + 1; // +1 for the \n.
				$msg                       = Message::new_message();
				$msg[ Message::TYPE ]      = Message::TM_BYTESTREAM;
				$msg[ Message::TIMESTAMP ] = Core::$right_now;
				$msg[ Message::FROM ]      = $this->name;
				$msg[ Message::KEY ]       = "{$s['id']}:" . ( $start + $consumed - \strlen( $line ) - 1 );
				$msg[ Message::VALUE ]     = $line . "\n";
				$this->sink?->fill( $msg );
			}
			$this->cursor_seg = $s['id'];
			$this->cursor_off = $start + $consumed;
		}
	}

	/**
	 * Append a {seg, off, ts} JSONL entry to the offsetlog so a future Consumer instance can resume.
	 */
	public function checkpoint(): void {
		$entry = \json_encode(
			[
				'seg' => $this->cursor_seg,
				'off' => $this->cursor_off,
				'ts'  => Core::$right_now,
			]
		);
		$this->offsetlog->write( $entry . "\n" );
	}

	public function fill( array &$message ): void {
		++$this->counter;
		// Consumer is poll-driven (Timer-fed in the runtime). fill() forwards to sink.
		$this->sink?->fill( $message );
	}
}
