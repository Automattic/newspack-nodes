<?php
/**
 * Offsetlog_Cursor: the durable per-node offsetlog cursor (time travel).
 *
 * Owns the offsetlog Partition's I/O + lifecycle — NOT the frame SCHEMA. The
 * committed record's VALUE is whatever the using class decides (Consumer commits
 * {seg,off,attempts,...,cache}; Remote_Source commits {seg,off,_ts}); this trait
 * just mints/fills/flushes that VALUE and reads the newest one back. Shared by
 * Consumer_Node and Remote_Source_Node — the read-with-empty-tail→prev-segment
 * fallback was near-duplicated in both before this.
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes;

\defined( 'ABSPATH' ) || exit;

trait Offsetlog_Cursor {

	/** Durable offsetlog Partition; null until built (ephemeral nodes skip it). */
	protected ?Partition_Node $offsetlog = null;

	/**
	 * Build + register the offsetlog Partition once (idempotent). Each caller owns
	 * its own dir/name derivation and wires the partition's sink afterward — the
	 * sink target differs (Consumer shares its data sink; Remote_Source routes to
	 * the command interpreter), so it is deliberately left out of here.
	 *
	 * @param string $dir          Segment directory. Empty → null (no durable cursor).
	 * @param string $name         Node name for the partition; '' leaves it unnamed (named later).
	 * @param int    $segment_size Bytes per segment before rotation.
	 * @param int    $num_segments Retained segment count.
	 */
	protected function ensure_offsetlog( string $dir, string $name, int $segment_size, int $num_segments ): ?Partition_Node {
		if ( null !== $this->offsetlog ) {
			return $this->offsetlog;
		}
		if ( '' === $dir ) {
			return null;
		}
		$offsetlog = new Partition_Node();
		if ( '' !== $name ) {
			$offsetlog->name( $name );
		}
		$offsetlog->patron( $this );
		// Retention: min_segments floor, max_segments = retained count.
		$offsetlog->arguments( \implode( ' ', [ $dir, $segment_size, Partition_Node::DEFAULT_MIN_SEGMENTS, $num_segments ] ) );
		$this->offsetlog = $offsetlog;
		return $offsetlog;
	}

	/**
	 * Read the newest committed frame's VALUE, or null when there's nothing to
	 * resume from. Reads the last segment; when its tail is empty (a
	 * rotated-but-unwritten newest segment) it falls back to the prior segment,
	 * then unpacks the last parseable line. Returns the raw VALUE array — each
	 * caller reads its own fields out of it.
	 *
	 * @return array<array-key, mixed>|null
	 */
	protected function read_last_offsetlog_frame(): ?array {
		if ( null === $this->offsetlog ) {
			return null;
		}
		$segments = $this->offsetlog->get_segments( true );
		if ( empty( $segments ) ) {
			return null;
		}
		$last    = \end( $segments );
		$content = $this->offsetlog->read_at( $last['id'], 0, $last['size'] );
		if ( '' === $content && \count( $segments ) > 1 ) {
			$prev    = $segments[ \count( $segments ) - 2 ];
			$content = $this->offsetlog->read_at( $prev['id'], 0, $prev['size'] );
		}
		if ( '' === $content ) {
			return null;
		}
		$lines = \array_filter( \explode( "\n", $content ), static fn ( $l ) => '' !== $l );
		if ( empty( $lines ) ) {
			return null;
		}
		try {
			$message = Message::unpacked( \end( $lines ) );
		} catch ( \InvalidArgumentException $e ) {
			$this->print_less_often( 'ignoring unparseable offsetlog entry: ', $e->getMessage() );
			return null;
		}
		$value = $message[ Message::VALUE ];
		return \is_array( $value ) ? $value : null;
	}

	/**
	 * Commit one frame: mint a TM_STRUCT Message stamped FROM this node, carry the
	 * caller's VALUE, fill the offsetlog and flush synchronously (don't wait on the
	 * Partition's PIPE_BUF threshold — a cursor frame must be durable now).
	 *
	 * @param array<array-key, mixed> $value The caller-owned frame schema.
	 */
	protected function commit_offsetlog_frame( array $value ): void {
		if ( null === $this->offsetlog ) {
			return;
		}
		$message                       = Message::new_message();
		$message[ Message::TYPE ]      = Message::TM_STRUCT;
		$message[ Message::TIMESTAMP ] = Core::$now;
		$message[ Message::FROM ]      = $this->name;
		$message[ Message::VALUE ]     = $value;
		$this->offsetlog->fill( $message );
		$this->offsetlog->flush();
	}
}
