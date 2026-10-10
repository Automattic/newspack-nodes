<?php
/**
 * HTTP_Source: a broker that fetches its readers' streams in blocks over `/command`.
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes;

\defined( 'ABSPATH' ) || exit;

/**
 * Pulls a spoke's logs as `Remote_Source` does — the same pairs, roots and
 * reader per stamp — but each reader fetches its own `raw-logs read_block`
 * over this broker's `HTTP_Out` instead of riding one SSE stream, so the
 * broker holds no slot from the spoke's `SSE_Slot_Pool` and sends no slot
 * heartbeat. A reader holding under `Log_Sources::BLOCK_BYTES` asks again
 * at once; one at the end, or refused, waits `EOF_POLL_SECONDS` for this
 * broker's tick, so readers due in one second ask together. Every reader
 * asking in one tick rides one POST, so the patron's reply cap counts the
 * readers, each at one whole record's share.
 */
class HTTP_Source_Node extends Remote_Broker_Node {

	/** Seconds a reader at the end, or refused, waits before asking again. */
	public const EOF_POLL_SECONDS = 5;

	/** One reader's share of a POST's reply: its largest record and an envelope. */
	public const READER_REPLY_BYTES = Partition_Node::MAX_LARGE_LINE_SIZE + 65536;

	/**
	 * Size the reply cap to every reader as each read goes out, so a reader
	 * built since the tick, and a channel rebuilt since, count before it.
	 *
	 * @param Remote_Consumer_Node $child The reader asking.
	 * @param string               $verb  `read_message` or `read_block`.
	 * @param list<string>         $args  The verb's argument tokens, which the reply echoes.
	 * @return bool True once the command is queued.
	 */
	public function send_read( Remote_Consumer_Node $child, string $verb, array $args ): bool {
		$this->sized_channel();
		return parent::send_read( $child, $verb, $args );
	}

	/**
	 * One tick's housekeeping, after the exact pairs' readers are built: size
	 * the channel's reply cap, end every wait fallen due, so readers due in one
	 * second share one POST, and publish the status. A broker no Vault entry
	 * names has no channel and writes no snapshot.
	 */
	protected function housekeep(): void {
		$http = $this->sized_channel();
		if ( null === $http ) {
			return;
		}
		foreach ( $this->reader_walk() as $child ) {
			$child->fetch_when_due();
		}
		$this->publish_status( $http );
	}

	/**
	 * The command channel, its reply cap raised to one share per reader; null
	 * while no Vault entry names the spoke.
	 */
	private function sized_channel(): ?HTTP_Out_Node {
		$http = $this->ensure_channel();
		$http?->set_reply_cap( \iterator_count( $this->reader_walk() ) * self::READER_REPLY_BYTES );
		return $http;
	}

	/**
	 * The status snapshot, under `Remote_Source`'s keys so a dashboard reads
	 * both brokers alike, from the readers' fetches: `connected` while one was
	 * answered within four EOF polls; the latest answer and its round trip, in
	 * milliseconds as the Status tab reads it; the latest fetch sent; when the
	 * soonest waiting reader asks again; the torn lines every block skipped;
	 * and the patron's last transfer, whose error outranks a reader's refused
	 * fetch, as a stream's error outranks a heartbeat's refusal in
	 * `Remote_Source`. No stream, backoff or slot heartbeat.
	 *
	 * @param HTTP_Out_Node $http The command channel.
	 */
	protected function publish_status( HTTP_Out_Node $http ): void {
		$answered = null;
		$rtt      = null;
		$sent     = null;
		$next     = null;
		$skipped  = 0;
		$refused  = null;
		foreach ( $this->reader_walk() as $child ) {
			$stats    = $child->fetch_stats();
			$skipped += $stats['skipped'];
			$refused ??= $stats['refused'];
			if ( null !== $stats['sent_at'] ) {
				$sent = \max( $sent ?? $stats['sent_at'], $stats['sent_at'] );
			}
			if ( null !== $stats['answered_at'] && $stats['answered_at'] > ( $answered ?? -\INF ) ) {
				$answered = $stats['answered_at'];
				$rtt      = $stats['rtt'];
			}
			if ( null !== $stats['fetch_after'] ) {
				$next = \min( $next ?? $stats['fetch_after'], $stats['fetch_after'] );
			}
		}
		$outcome = $http->last_outcome();
		$refusal = null === $refused ? null : 'Block fetch refused: ' . self::failure_reason( $refused, 'read_block refused' );
		$this->write_status( [
			'connected'               => null !== $answered && Core::$now - $answered <= 4 * self::EOF_POLL_SECONDS,
			'connecting'              => false,
			'last_connection_attempt' => null === $sent ? null : (int) $sent,
			'last_http_code'          => $outcome['code'],
			'last_error'              => $outcome['error'] ?? $refusal,
			'current_backoff'         => null,
			'last_sse_heartbeat'      => null,
			'scheduled_reconnect_at'  => null === $next ? null : (int) \ceil( $next ),
			'unparseable_lines'       => $skipped,
			'last_response'           => null === $answered ? null : (int) $answered,
			'last_rtt'                => null === $rtt ? null : self::round_trip_ms( $rtt ),
		] );
	}

	/**
	 * A live reader drained, or asked for a step or a fetch: let it fetch.
	 *
	 * @param Remote_Consumer_Node $child The reader that drained.
	 */
	public function refill( Remote_Consumer_Node $child ): void {
		$child->fetch();
	}

	/** Nothing to reconnect: each fetch states its reader's own position. */
	public function restream(): void {}

	/**
	 * A reply to the broker's own name: it sends nothing FROM itself, so
	 * none is owed and each is dropped.
	 *
	 * @param array<int,mixed> $message The reply, TM_COMMAND|TM_RESPONSE or |TM_ERROR.
	 */
	protected function settle_reply( array $message ): void {}

	/**
	 * Palette entry: `Remote_Source`'s arguments and verbs over block fetches.
	 *
	 * @api Dynamic entrypoint.
	 * @return array<string,mixed>
	 */
	public static function node_schema(): array {
		return \array_merge( parent::node_schema(), [
			'category'    => 'I/O',
			'description' => 'HTTP-pull broker: a durable reader per `source:target` pair, each fetching 1 MiB blocks from a spoke over /command (Vault-resolved); holds no SSE slot.',
		] );
	}
}
