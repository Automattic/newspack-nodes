<?php
/**
 * Remote_Source: a self-sufficient, topology-visible SSE-pull aggregation node.
 *
 * Extends Remote_Link with the one concern that distinguishes durable aggregation
 * from a transient channel: a per-node offsetlog (`<offsets_dir>/<name>.<remote_partition>`,
 * keyed by NODE NAME). It restores the committed `{seg,off}` cursor into SSE_In
 * before connect (the `restore_position` seam) and commits the live cursor every
 * ~COMMIT_INTERVAL seconds (the `persist_cursor` seam). Everything else — the
 * SSE_In + HTTP_Out patrons, the heartbeat, the status snapshot, the tick — is the
 * Remote_Link base.
 *
 * Credentials + URL come from the Vault entry resolved by `<vault-id>`; a missing
 * entry leaves the node disconnected (no mis-configured patrons created).
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes;

\defined( 'ABSPATH' ) || exit;

class Remote_Source_Node extends Remote_Link_Node {

	/** Offsetlog commit cadence (seconds). */
	private const COMMIT_INTERVAL = 5;

	/** Durable per-node offsetlog (`<offsets_dir>/<name>.<remote_partition>`). */
	private ?Partition_Node $offsetlog = null;

	private float $last_commit_time = 0.0;

	/**
	 * Read the latest committed `{seg,off}` line from the offsetlog into a position
	 * array seeding SSE_In before connect. Empty on a fresh offsetlog.
	 *
	 * @return array{segment_id?:int,offset?:int}
	 */
	protected function restore_position(): array {
		$offsetlog = $this->ensure_offsetlog();
		if ( null === $offsetlog ) {
			return [];
		}
		$segments = $offsetlog->get_segments( true );
		if ( empty( $segments ) ) {
			return [];
		}
		$last    = \end( $segments );
		$content = $offsetlog->read_at( $last['id'], 0, $last['size'] );
		if ( '' === $content && \count( $segments ) > 1 ) {
			$prev    = $segments[ \count( $segments ) - 2 ];
			$content = $offsetlog->read_at( $prev['id'], 0, $prev['size'] );
		}
		if ( '' === $content ) {
			return [];
		}
		$lines = \explode( "\n", \rtrim( $content, "\n" ) );
		try {
			$message = Message::unpacked( \end( $lines ) );
		} catch ( \InvalidArgumentException $e ) {
			$this->print_less_often( "ignoring unparseable offsetlog entry: {$e->getMessage()}" );
			return [];
		}
		$value = $message[ Message::VALUE ];
		if ( ! \is_array( $value ) ) {
			return [];
		}
		$seg = $value['seg'] ?? 0;
		$off = $value['off'] ?? 0;
		return [
			'segment_id' => \is_scalar( $seg ) ? (int) $seg : 0,
			'offset'     => \is_scalar( $off ) ? (int) $off : 0,
		];
	}

	/** Write the SSE_In cursor to the offsetlog every ~COMMIT_INTERVAL seconds. */
	protected function persist_cursor(): void {
		$now = Core::$now ?: \microtime( true );
		if ( $this->last_commit_time > 0.0 && ( $now - $this->last_commit_time ) < self::COMMIT_INTERVAL ) {
			return;
		}
		$this->last_commit_time = $now;
		$this->commit_offsetlog();
	}

	// =========================================================================
	// Durable offsetlog — per-node, keyed by NODE NAME.
	// =========================================================================

	/** Ensure the per-node offsetlog Partition exists + is registered. Idempotent. */
	private function ensure_offsetlog(): ?Partition_Node {
		if ( null !== $this->offsetlog ) {
			return $this->offsetlog;
		}
		if ( '' === $this->name ) {
			return null;
		}
		$offsets_dir = Config::get_offsets_directory();
		if ( '' === $offsets_dir ) {
			return null;
		}
		$dir = "{$offsets_dir}/{$this->name}.{$this->remote_partition}";
		if ( ! \is_dir( $dir ) ) {
			// phpcs:ignore WordPressVIPMinimum.Functions.RestrictedFunctions.directory_mkdir
			@\mkdir( $dir, 0755, true );
		}
		$offsetlog = new Partition_Node();
		$offsetlog->name( "{$this->name}:{$this->remote_partition}:offsetlog" );
		$offsetlog->patron( $this );
		$ci = Core::node( Node_Names::COMMAND_INTERPRETER );
		if ( null === $offsetlog->sink() && null !== $ci ) {
			$offsetlog->sink( $ci );
		}
		$offsetlog->arguments( $dir );
		$this->offsetlog = $offsetlog;
		return $offsetlog;
	}

	/** Write a single `{seg,off,_ts}` JSONL line covering this node's cursor. */
	private function commit_offsetlog(): void {
		if ( null === $this->sse_in ) {
			return;
		}
		$offsetlog = $this->ensure_offsetlog();
		if ( null === $offsetlog ) {
			return;
		}
		$pos                           = $this->sse_in->position();
		$message                       = Message::new_message();
		$message[ Message::TYPE ]      = Message::TM_STRUCT;
		$message[ Message::TIMESTAMP ] = Core::$now;
		$message[ Message::VALUE ]     = [
			'seg' => $pos['segment_id'],
			'off' => $pos['offset'],
			'_ts' => (int) Core::$now,
		];
		$offsetlog->fill( $message );
		$offsetlog->flush();
	}

	/**
	 * Teardown: tear down the offsetlog, then the patrons + self via the base.
	 *
	 * @api Dynamic entrypoint.
	 */
	public function remove_node(): void {
		$this->offsetlog?->remove_node();
		$this->offsetlog = null;
		parent::remove_node();
	}

	/**
	 * @api Dynamic entrypoint.
	 * @return array<string,mixed>
	 */
	public static function node_schema(): array {
		return \array_merge( parent::node_schema(), [
			'description' => 'Self-sufficient SSE-pull aggregation source for one spoke partition (Vault-resolved).',
		] );
	}
}
