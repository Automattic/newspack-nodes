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
	use Sidecar;

	/**
	 * Offsetlog as an exact keyframe timeline for time-travel: segment_size=1 forces one
	 * checkpoint = one segment = one frame, uniformly for stateless readers (small offset
	 * records) and stateful/snapshot ones (offset + cache). Partition's do_rotate() adopts
	 * the still-empty newest segment on the first commit, then rotates to a fresh segment
	 * on every later commit (current_size ≥ 1 > the 1-byte threshold) — so segment_size=1
	 * produces no empty-segment spam.
	 *
	 * Retention is the three-rule scheme (see Partition_Node): keep at least 10 keyframes
	 * and a count target of 30, holding anything younger than 5 minutes even when over the
	 * count, pruning anything older than 15 minutes back down to the floor, and a hard cap
	 * of 60 that bounds a very hot cursor whose keyframes are all younger than 5 minutes.
	 */
	public const OFFSETLOG_SEGMENT_SIZE = 1;
	public const OFFSETLOG_MIN_SEGMENTS = 10;
	public const OFFSETLOG_NUM_SEGMENTS = 30;
	public const OFFSETLOG_MIN_LIFETIME = 300;
	public const OFFSETLOG_LIFETIME     = 900;
	public const OFFSETLOG_MAX_SEGMENTS = 60;

	/** Durable offsetlog Partition; null until built (ephemeral nodes skip it). */
	protected ?Partition_Node $offsetlog = null;

	/**
	 * Durable read-cursor dir. An ARGUMENT, not a Config read: an offsetlog is a
	 * reader's cursor, so a topology must be able to write the path — that's what
	 * lets it carry `<topology>` and keeps two fleets pulling one spoke partition
	 * off each other's cursor. Empty disables checkpointing.
	 */
	protected string $offsetlog_dir = '';

	/** Where the offsetlog lives. Override to derive an implicit dir. */
	protected function offsetlog_dir(): string {
		return $this->offsetlog_dir;
	}

	/** What it answers to. Override to qualify the name (e.g. by remote partition). */
	protected function offsetlog_name(): string {
		return '' !== $this->name ? "{$this->name}:offsetlog" : '';
	}

	/**
	 * Build + register the offsetlog Partition once (idempotent). The sidecar inherits
	 * its patron's sink, which make_node always sets to _command_interpreter — flow is
	 * steered by target(), so a sink is control-plane, and the offsetlog's belongs there.
	 */
	protected function ensure_offsetlog(): ?Partition_Node {
		if ( null !== $this->offsetlog ) {
			return $this->offsetlog;
		}
		$dir = $this->offsetlog_dir();
		if ( '' === $dir ) {
			return null;
		}
		$this->offsetlog = $this->make_sidecar( $dir, $this->offsetlog_name(), [
			self::OFFSETLOG_SEGMENT_SIZE,
			self::OFFSETLOG_MIN_SEGMENTS,
			self::OFFSETLOG_NUM_SEGMENTS,
			self::OFFSETLOG_MIN_LIFETIME,
			self::OFFSETLOG_LIFETIME,
			self::OFFSETLOG_MAX_SEGMENTS,
		] );
		return $this->offsetlog;
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
