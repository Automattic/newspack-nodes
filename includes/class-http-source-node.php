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
 *
 * A glob pair learns its stamps from the spoke's `raw-logs list_logs`
 * catalog, asked on the tick an EOF poll after each answer.
 */
class HTTP_Source_Node extends Remote_Broker_Node {

	/** Seconds a reader at the end, or refused, waits before asking again. */
	public const EOF_POLL_SECONDS = 5;

	/** One reader's share of a POST's reply: its largest record and an envelope. */
	public const READER_REPLY_BYTES = Partition_Node::MAX_LARGE_LINE_SIZE + 65536;

	/**
	 * The earliest wall-clock the next `list_logs` ask may go out: a request
	 * timeout past an ask, an EOF poll past its answer.
	 */
	private float $catalog_due = 0.0;

	/** When the latest catalog ask went out, for its round trip and the status; 0 before any. */
	private float $catalog_sent_at = 0.0;

	/**
	 * The latest answered catalog ask: when, and its round trip in seconds.
	 *
	 * @var array{at:float,rtt:float}|null
	 */
	private ?array $catalog_answered = null;

	/** What the spoke said refusing the latest catalog ask; null once one answers. */
	private ?string $catalog_refusal = null;

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
	 * names, or one whose partition owns no pair, builds no channel and
	 * writes no snapshot.
	 */
	protected function housekeep(): void {
		if ( [] === $this->pairs ) {
			return;
		}
		$http = $this->sized_channel();
		if ( null === $http ) {
			return;
		}
		foreach ( $this->reader_walk() as $child ) {
			$child->fetch_when_due();
		}
		$this->ask_catalog( $http );
		$this->publish_status( $http );
	}

	/**
	 * While a glob pair stands, ask the spoke for its catalog FROM this
	 * broker's name: one ask at a time, an EOF poll after the last answer,
	 * and again once a lost one is as old as HTTP_Out's own timeout.
	 *
	 * @param HTTP_Out_Node $http The command channel.
	 */
	private function ask_catalog( HTTP_Out_Node $http ): void {
		if ( ! $this->has_glob_pair() || Core::$now < $this->catalog_due ) {
			return;
		}
		$message = $this->mint( $this->name, Remote_Consumer_Node::RAW_LOGS_SERVICE, 'list_logs', [] );
		if ( null !== $message ) {
			$this->catalog_due     = Core::$now + HTTP_Out_Node::REQUEST_TIMEOUT;
			$this->catalog_sent_at = Core::$now;
			$http->fill( $message );
		}
	}

	/** Whether any pair's source is a glob, whose stamps only the catalog names. */
	private function has_glob_pair(): bool {
		foreach ( $this->pairs as [ 'source' => $source ] ) {
			if ( Log_Discovery::is_glob( $source ) ) {
				return true;
			}
		}
		return false;
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
	 * both brokers alike, from the round trips the spoke answered, a reader's
	 * fetch or this broker's catalog: `connected` while one was answered within
	 * four EOF polls; the latest answer and its round trip, in milliseconds as
	 * the Status tab reads it; the latest fetch or catalog ask sent; when the
	 * soonest waiting reader asks again; the torn lines every block skipped;
	 * and one error, the first of three that stands: the patron's last
	 * transfer, a refused catalog, a reader's refused fetch. A transfer's
	 * error outranks a refusal as a stream's outranks a heartbeat's in
	 * `Remote_Source`, and the broker's own ask outranks one reader's. It
	 * fills no stream, backoff or slot heartbeat, which keep the base's blanks.
	 *
	 * @param HTTP_Out_Node $http The command channel.
	 */
	protected function publish_status( HTTP_Out_Node $http ): void {
		$answered = $this->catalog_answered['at'] ?? null;
		$rtt      = $this->catalog_answered['rtt'] ?? null;
		$sent     = 0.0 < $this->catalog_sent_at ? $this->catalog_sent_at : null;
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
		$this->write_status( [
			'connected'               => null !== $answered && Core::$now - $answered <= 4 * self::EOF_POLL_SECONDS,
			'last_connection_attempt' => null === $sent ? null : (int) $sent,
			'last_http_code'          => $outcome['code'],
			'last_error'              => $outcome['error']
				?? self::refusal_line( 'Discovery', $this->catalog_refusal, 'list_logs refused' )
				?? self::refusal_line( 'Block fetch', $refused, 'read_block refused' ),
			'scheduled_reconnect_at'  => null === $next ? null : (int) \ceil( $next ),
			'unparseable_lines'       => $skipped,
			'last_response'           => null === $answered ? null : (int) $answered,
			'last_rtt'                => null === $rtt ? null : self::round_trip_ms( $rtt ),
		] );
	}

	/**
	 * One refusal as `last_error` shows it, its reason bounded; null when
	 * nothing was refused.
	 *
	 * @param string      $what     What the spoke refused.
	 * @param string|null $reason   The spoke's refusal text, or null.
	 * @param string      $fallback The reason when the text names none.
	 */
	private static function refusal_line( string $what, ?string $reason, string $fallback ): ?string {
		return null === $reason ? null : "{$what} refused: " . self::failure_reason( $reason, $fallback );
	}

	/**
	 * A live reader drained, or asked for a step or a fetch: let it fetch.
	 *
	 * @param Remote_Consumer_Node $child The reader that drained.
	 */
	public function refill( Remote_Consumer_Node $child ): void {
		$child->fetch();
	}

	/**
	 * Drop the channel and every request it carried, this broker's catalog
	 * ask included, which goes again on the next tick.
	 */
	protected function drop_patrons(): void {
		parent::drop_patrons();
		$this->catalog_due = 0.0;
	}

	/** Nothing to reconnect: each fetch states its reader's own position. */
	public function restream(): void {}

	/**
	 * The spoke's catalog, the one reply this broker asks for FROM itself:
	 * a reader for each key a pair claims, through the one builder, which
	 * `MAX_READERS` caps for globs. A key no pair claims is the catalog's
	 * business, not a stray line, so it builds nothing and says nothing; a
	 * refusal is said rate-limited. Either way the next ask waits an EOF poll.
	 *
	 * @param array<int,mixed> $message The reply, TM_COMMAND|TM_RESPONSE or |TM_ERROR.
	 */
	protected function settle_reply( array $message ): void {
		$value = Core::arr( $message[ Message::VALUE ] );
		if ( 'list_logs' !== ( $value['name'] ?? null ) ) {
			return;
		}
		$this->catalog_due = Core::$now + self::EOF_POLL_SECONDS;
		$rows              = $value['payload'] ?? null;
		if ( ! \is_array( $rows ) ) {
			$this->catalog_refusal = Core::as_string( $rows );
			$this->print_less_often( 'list_logs refused: ', self::failure_reason( $rows, 'list_logs refused' ) );
			return;
		}
		$this->catalog_refusal = null;
		$this->catalog_answered = [ 'at' => Core::$now, 'rtt' => Core::$now - $this->catalog_sent_at ];
		foreach ( $rows as $row ) {
			$key = Core::arr( $row )['key'] ?? null;
			if ( \is_string( $key ) && null !== $this->pair_for( $key ) ) {
				$this->consumer_for( $key );
			}
		}
	}

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
