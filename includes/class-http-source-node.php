<?php
/**
 * HTTP_Source: a broker that fetches its readers' streams in blocks over `/command`.
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes;

\defined( 'ABSPATH' ) || exit;

/**
 * Pulls a spoke's logs as `Remote_Source` does — the same sources, roots and
 * reader per stamp — but each reader fetches its own `raw-logs read_block`
 * over this broker's `HTTP_Out` instead of riding one SSE stream, so the
 * broker holds no slot from the spoke's `SSE_Slot_Pool` and sends no slot
 * heartbeat. A reader asks again at once while it holds at most one fetch,
 * so one fetch drains while the next is in flight. A reader at the end of
 * the log, or one the spoke refused, waits the broker's retry interval and
 * then asks on the broker's tick. When the first reader's wait at the end
 * of its log ends, every other reader waiting at the end of its log asks
 * too, so they ask together. A reader the spoke refused waits its full
 * interval. Every reader asking in one tick rides one POST, so the
 * patron's reply cap counts the readers, each at one whole record's share.
 *
 * A glob source learns its stamps from the spoke's `raw-logs list_logs`
 * catalog, asked on the tick a retry interval after each answer.
 */
class HTTP_Source_Node extends Remote_Broker_Node {

	/** One reader's share of a POST's reply: its largest record and an envelope. */
	public const READER_REPLY_BYTES = Partition_Node::MAX_LARGE_LINE_SIZE + 65536;

	/**
	 * Milliseconds a reader at the end, or refused, waits before asking again,
	 * and the catalog between asks: the `retry_ms` positional, `http_retry_ms`
	 * by default.
	 */
	protected int $retry_ms = 0;

	/**
	 * The earliest wall-clock the next `list_logs` ask may go out: a request
	 * timeout past an ask, a retry interval past its answer.
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
	 * Refuse a `retry_ms` of 0, which would spin the poll; the schema refuses
	 * the rest.
	 *
	 * @api Dynamic entrypoint.
	 * @param list<string>|null $args Positional tokens, or null to read them.
	 * @return list<string>
	 * @throws \InvalidArgumentException When `retry_ms` is 0, or a token the schema refuses.
	 */
	public function arguments( ?array $args = null ): array {
		if ( null !== $args && 0 === $this->schema_values( $args )['retry_ms'] ) {
			$this->refuse_argument( "retry_ms wants at least 1, got '0'" );
		}
		return parent::arguments( $args );
	}

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
	 * One tick's housekeeping, after the exact sources' readers are built: size
	 * the channel's reply cap, end the wait of every reader at the end of its
	 * log once any one reader's wait falls due, so they share one POST and
	 * stay in step after it, and publish the status. A reader the spoke
	 * refused waits its full interval. A broker no Vault entry
	 * names, or one whose partition owns no source, builds no channel and
	 * writes no snapshot.
	 */
	protected function housekeep(): void {
		if ( [] === $this->sources ) {
			return;
		}
		$http = $this->sized_channel();
		if ( null === $http ) {
			return;
		}
		$retry   = $this->retry_seconds();
		$readers = \iterator_to_array( $this->reader_walk(), false );
		$ended   = \array_filter( $readers, static fn ( Remote_Consumer_Node $child ): bool => ! $child->refused() && $child->waited( $retry ) );
		foreach ( $readers as $child ) {
			$child->fetch_when_due( [] !== $ended && ! $child->refused() ? 0.0 : $retry );
		}
		$this->ask_catalog( $http );
		$this->publish_status( $http );
	}

	/**
	 * While a glob source stands, ask the spoke for its catalog FROM this
	 * broker's name: one ask at a time, a retry interval after the last answer,
	 * and again once a lost one is as old as HTTP_Out's own timeout.
	 *
	 * @param HTTP_Out_Node $http The command channel.
	 */
	private function ask_catalog( HTTP_Out_Node $http ): void {
		if ( ! $this->has_glob_source() || Core::$now < $this->catalog_due ) {
			return;
		}
		$message = $this->mint( $this->name, Remote_Consumer_Node::RAW_LOGS_SERVICE, 'list_logs', [] );
		if ( null !== $message ) {
			$this->catalog_due     = Core::$now + HTTP_Out_Node::REQUEST_TIMEOUT;
			$this->catalog_sent_at = Core::$now;
			$http->fill( $message );
		}
	}

	/** Whether any source is a glob, whose stamps only the catalog names. */
	private function has_glob_source(): bool {
		foreach ( $this->sources as [ 'source' => $source ] ) {
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
	 * The status snapshot, under `Remote_Source`'s keys, so a dashboard reads
	 * both brokers alike. It is built from the round trips the spoke answered,
	 * whether a reader's fetch or this broker's catalog ask:
	 *
	 * - `connected` while one was answered within four retry intervals of
	 *   now, or of the latest request while one is out, and `connecting`
	 *   while a request is out and the broker is not connected;
	 * - the latest answer, as `last_response` and as the server heartbeat,
	 *   with its round trip in milliseconds, as the Status tab reads it;
	 * - the latest fetch or catalog ask sent, and when the soonest waiting
	 *   reader asks again;
	 * - the retry interval as the backoff, in whole seconds as SSE_In counts;
	 * - one error, the first that stands of three: the patron's last
	 *   transfer, a refused catalog, and a reader's refused fetch. A
	 *   transfer's error outranks a refusal, as a stream's outranks a
	 *   heartbeat's in `Remote_Source`, and the broker's own ask outranks one
	 *   reader's.
	 *
	 * @param HTTP_Out_Node $http The command channel.
	 */
	protected function publish_status( HTTP_Out_Node $http ): void {
		$answered = $this->catalog_answered['at'] ?? null;
		$rtt      = $this->catalog_answered['rtt'] ?? null;
		$sent     = 0.0 < $this->catalog_sent_at ? $this->catalog_sent_at : null;
		$out      = null !== $sent && $sent > ( $answered ?? -\INF ) && Core::$now - $sent < HTTP_Out_Node::REQUEST_TIMEOUT;
		$next     = null;
		$refused  = null;
		foreach ( $this->reader_walk() as $child ) {
			$stats    = $child->fetch_stats();
			$refused ??= $stats['refused'];
			$out       = $out || $child->fetching();
			if ( null !== $stats['sent_at'] ) {
				$sent = \max( $sent ?? $stats['sent_at'], $stats['sent_at'] );
			}
			if ( null !== $stats['answered_at'] && $stats['answered_at'] > ( $answered ?? -\INF ) ) {
				$answered = $stats['answered_at'];
				$rtt      = $stats['rtt'];
			}
			if ( null !== $stats['waiting_since'] ) {
				$next = \min( $next ?? \INF, $stats['waiting_since'] + $this->retry_seconds() );
			}
		}
		$outcome   = $http->last_outcome();
		$since     = $out && null !== $sent ? $sent : Core::$now;
		$connected = null !== $answered && $since - $answered <= 4 * $this->retry_seconds();
		$this->write_status( [
			'connected'               => $connected,
			'connecting'              => ! $connected && $out,
			'last_connection_attempt' => null === $sent ? null : (int) $sent,
			'last_http_code'          => $outcome['code'],
			'last_error'              => $outcome['error']
				?? self::refusal_line( 'Discovery', $this->catalog_refusal, 'list_logs refused' )
				?? self::refusal_line( 'Block fetch', $refused, 'read_block refused' ),
			'current_backoff'         => (int) \ceil( $this->retry_seconds() ),
			'last_sse_heartbeat'      => null === $answered ? null : (int) $answered,
			'scheduled_reconnect_at'  => null === $next ? null : (int) \ceil( $next ),
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
	 * The spoke's catalog, the one reply this broker asks for FROM itself:
	 * a reader for each key a source claims, through the one builder, which
	 * `MAX_READERS` caps for globs. A key no source claims is the catalog's
	 * business, not a stray line, so it builds nothing and says nothing; a
	 * refusal is said rate-limited. Either way the next ask waits a retry interval.
	 *
	 * @param array<int,mixed> $message The reply, TM_COMMAND|TM_RESPONSE or |TM_ERROR.
	 */
	protected function settle_reply( array $message ): void {
		$value = Core::arr( $message[ Message::VALUE ] );
		if ( 'list_logs' !== ( $value['name'] ?? null ) ) {
			return;
		}
		$this->catalog_due = Core::$now + $this->retry_seconds();
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
			if ( \is_string( $key ) && null !== $this->source_for( $key ) ) {
				$this->consumer_for( $key );
			}
		}
	}

	/** The retry interval in seconds, as the clock reads it. */
	private function retry_seconds(): float {
		return $this->retry_ms / 1000;
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

	/** The replies HTTP_Out has delivered, as `Remote_Source` reports SSE_In's messages. */
	public function counter(): int {
		return null !== $this->http_out ? $this->http_out->replies() : parent::counter();
	}

	/** HTTP_Out's tally: the broker holds no socket of its own to read. */
	public function bytes_read(): int {
		return $this->http_out?->bytes_read() ?? 0;
	}

	/** The largest reply HTTP_Out has delivered. */
	public function largest_msg_sent(): int {
		return $this->http_out?->largest_reply() ?? 0;
	}

	/**
	 * Palette entry: `Remote_Source`'s arguments and verbs over block fetches,
	 * and the optional `retry_ms`.
	 *
	 * @api Dynamic entrypoint.
	 * @return array<string,mixed>
	 */
	public static function node_schema(): array {
		$schema = parent::node_schema();
		return \array_merge( $schema, [
			'category'    => 'I/O',
			'description' => 'HTTP-pull broker: a durable reader per source `add_source` names, each fetching blocks of up to 4 MiB from a spoke over /command (Vault-resolved); holds no SSE slot.',
			'arguments'   => [
				...Core::arr( $schema['arguments'] ),
				[ 'name' => 'retry_ms', 'type' => 'int', 'required' => false, 'default' => '<config:http_retry_ms>', 'description' => 'Milliseconds a reader at the end of its log, or refused, waits before asking again, and the catalog between asks; at least 1. Defaults to http_retry_ms.' ],
			],
		] );
	}
}
