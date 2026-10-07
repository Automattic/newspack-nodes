<?php
/**
 * SSE_In: generic inbound SSE pull. A passive, hidden, programmatically-configured
 * source node.
 *
 * It owns one easy handle (the SSE GET) registered on the Event_Framework's shared
 * cURL multi, one in-memory `{segment, offset}` cursor, and one SSE connection's
 * worth of parser state. It is a *source*: `fill()` only counts, because nothing
 * upstream sends to it. Delivery is the `on_message` seam ONLY — each `data:` payload
 * reaches the patron RAW, byte-identical to the remote's on-disk encoding, and the
 * patron owns unpacking, FROM stamping, target and the sink fill. This node reads
 * neither `sink` nor `target`.
 *
 * It is passive: it owns NO timer. Inbound bytes flow via the Event_Framework's
 * cURL polling (`start_curl` + `on_curl_done`, like HTTP_Out).
 * Connect / reconnect / stale are driven by a *patron* calling `maybe_connect()`
 * and `check_stale()`. The patron owns durable position persistence and any status
 * memcache write — SSE_In keeps only the in-memory cursor + connection state.
 *
 * The wire is `SSE_Out`'s: six event types — `connected`, `msg`, `heartbeat`,
 * `retry`, `disconnect` and `unparseable_lines` — each carrying one packed
 * 7-field Message.
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes;

\defined( 'ABSPATH' ) || exit;

// phpcs:disable WordPress.WP.AlternativeFunctions.curl_curl_getinfo
// phpcs:disable WordPress.WP.AlternativeFunctions.curl_curl_error
// phpcs:disable WordPress.WP.AlternativeFunctions.curl_curl_strerror
// cURL is required for SSE multiplexing — wp_remote_get() can't do it.

/**
 * SSE_In node — `make_node SSE_In <name>` takes no arguments; the patron
 * configures it through `configure()`.
 *
 * @implements Curl_Owner<null>
 */
class SSE_In_Node extends Node implements Curl_Owner {
	/** Seconds allowed to connect. The transfer itself is untimed (CURLOPT_TIMEOUT 0). */
	public const CONNECT_TIMEOUT   = 5;

	/**
	 * Seconds of total silence `check_stale()` reads as a dead stream. SSE_Out
	 * heartbeats every 2 seconds, so only a broken link reaches this.
	 */
	public const HEARTBEAT_TIMEOUT = 45;

	/** Reconnect-delay floor in seconds; any received event resets the delay here. */
	public const INITIAL_BACKOFF   = 1;

	/** Reconnect-delay ceiling in seconds; `increase_backoff()` doubles up to it. */
	public const MAX_BACKOFF       = 30;

	/** Ceiling on unconsumed buffered bytes: 32 MiB without a newline is a broken peer. */
	public const MAX_BUFFER_SIZE   = 33554432;

	/** Ceiling on one event's accumulated `data:`, 32 MiB. Either overflow retires the lease. */
	public const MAX_EVENT_SIZE    = 33554432;

	/**
	 * Delivery seam, set by the patron. Every `msg` SSE event hands its RAW `data:`
	 * payload — the packed line, byte-identical to the remote's on-disk encoding — to
	 * this closure; `Remote_Source_Node` appends that line to the buffer its
	 * `Durable_Reader` drains. A null seam drops the event.
	 *
	 * Signature: `function ( string $raw ): void`.
	 *
	 * @var \Closure|null
	 */
	public ?\Closure $on_message        = null;

	/**
	 * Handshake seam, set by the patron. The spoke's `connected` envelope names, in
	 * CURSORS, where each stream actually begins, which is how a tail or sentinel
	 * seek resolves; this hands every `stamp => {segment?, offset}` pair to the
	 * patron, which owns the cursors. An envelope naming none (an older spoke)
	 * calls nothing.
	 *
	 * Signature: `function ( array $cursors ): void`.
	 *
	 * @var \Closure|null
	 */
	public ?\Closure $on_connected      = null;

	/**
	 * Request seam, set by the patron. Called when a connect is about to go out,
	 * before the request reads the streams, so the patron can state them past
	 * everything it already holds.
	 *
	 * Signature: `function (): void`.
	 *
	 * @var \Closure|null
	 */
	public ?\Closure $on_connecting     = null;

	/**
	 * Skip seam, set by the patron. An `unparseable_lines` frame names, in
	 * CURSORS, where the spoke's readers stand past the torn lines they skipped;
	 * this hands every `stamp => {segment?, offset}` pair to the patron, which
	 * owns the cursors, so a reopen resumes past those lines instead of counting
	 * them again.
	 *
	 * Signature: `function ( array $cursors ): void`.
	 *
	 * @var \Closure|null
	 */
	public ?\Closure $on_skipped        = null;

	/** Application-Password secret, paired with `$auth_username` for Basic auth. */
	protected string $auth_password     = '';

	/** Bearer token, reached only when there is no username and password. */
	protected string $auth_token        = '';

	/** Application-Password user for Basic auth against the remote. */
	protected string $auth_username     = '';

	/** Ask the remote to read this subscription with the multi-writer seal-grace. */
	protected bool $multi_writer        = false;

	/** Remote base URL without a trailing slash; the stream path is appended at connect. */
	protected string $url               = '';

	/** Received bytes not yet consumed as whole lines. */
	private string $buffer              = '';

	/** The LEASE: true only past the `connected` handshake, never at open. */
	private bool   $connected           = false;

	/** When the `connected` handshake landed; only the clean-EOF diagnostic reads it. */
	private ?float $connected_at        = null;

	/** Seconds that must pass after `$last_attempt` before `maybe_connect()` reopens. */
	private int    $current_backoff     = self::INITIAL_BACKOFF;

	/** @var array{event:string,data:string} Current SSE event accumulator. */
	private array  $current_event       = [ 'event' => '', 'data' => '' ];

	/** Active easy handle when connected, null otherwise. Registered on the Event_Framework's shared multi. */
	private ?\CurlHandle $handle        = null;

	/** When the last open was attempted; 0.0 before the first, and the backoff starts here. */
	private float   $last_attempt       = 0.0;

	/** Why the stream last failed, or null when it never has. `connection()` publishes it. */
	private ?string $last_error         = null;

	/** When the last event of any kind arrived; `check_stale()` measures silence from it. */
	private float   $last_event_time    = 0.0;

	/** HTTP status of the current transfer, read once its first byte arrives. */
	private ?int    $last_http_code     = null;

	/** Wall-second of the last `heartbeat` event, for the patron's status display. */
	private ?int    $last_sse_heartbeat = null;

	/** Lines the spoke skipped as unparseable, summed across every connection. */
	private int     $unparseable_lines  = 0;

	/**
	 * Subscriptions the next connect asks for, as the patron last stated them.
	 *
	 * @var list<string>
	 */
	private array $subscribe            = [];

	/**
	 * Where each stamp the next connect states begins: a `{segment?, offset}`,
	 * a `Consumer_Node::SEEK_*` sentinel, or `SSE_Out_Node::SKIP`. A file-mode
	 * source that has not seen its generation yet carries no `segment`.
	 *
	 * @var array<string,array{segment?:int,offset:int}|int|string>
	 */
	private array $positions            = [];

	/** Reopen delay the server advertised — `retry` event or field; null = none. */
	private ?int  $server_retry_ms      = null;

	/** Wall-second this stream is due back after a scheduled close; null = not waiting on one. */
	private ?int  $scheduled_reconnect_at = null;

	/** Refuse a non-HTTPS URL outright rather than connecting to it. */
	private bool  $require_ssl          = false;

	/** Lease owner captured from the `connected` handshake. */
	private ?int  $owner                = null;

	/** Slot index the remote's pool leased to this stream, from the handshake. */
	private ?int  $slot                 = null;

	/**
	 * Machine key of a terminal `disconnect` event, such as `slot_lease_lost`.
	 * Retained with the reason so the close path can tell an end the server
	 * ordered from a transport failure.
	 */
	private ?string $terminal_disconnect_key    = null;

	/** Operator-facing reason from a terminal `disconnect`; becomes `$last_error` at close. */
	private ?string $terminal_disconnect_reason = null;

	/**
	 * The TLS opts the patron resolved with the destination.
	 *
	 * @var array<int,bool|int>
	 */
	private array $tls_opts             = [];

	/** Tachikoma-parity: no-arg ctor. Config arrives via configure(); no I/O here (ADR-5). */
	public function __construct() {
		parent::__construct();
	}

	/**
	 * Node contract. SSE_In is a *source* — like Tail, it generates messages from
	 * an external stream, but it hands them to the `on_message` seam rather than a
	 * sink. It doesn't accept upstream messages. The counter still advances, so a
	 * message misrouted here shows up in `ls -c` instead of vanishing.
	 *
	 * @api Dynamic entrypoint.
	 * @param array<int,mixed> $message The 7-field positional message array.
	 */
	public function fill( array $message ): void {
		++$this->counter;
	}

	/**
	 * Open an easy handle when there is none and the backoff window has passed.
	 * Builds the stream URL from the streams the patron stated, adds the credential
	 * header, clears every per-connection field, and starts the transfer on the
	 * Event_Framework's shared multi. A refusal — a non-HTTPS URL under
	 * `$require_ssl`, or `curl_init()` failing — records `$last_error`, doubles the
	 * backoff and reports DISCONNECTED.
	 *
	 * @api Dynamic entrypoint.
	 * @return bool True when a handle was opened.
	 */
	public function maybe_connect(): bool {
		if ( $this->handle instanceof \CurlHandle ) {
			return false;
		}

		$now = Core::$now ?: Core::right_now();
		if ( $this->last_attempt > 0.0 && ( $now - $this->last_attempt ) < $this->current_backoff ) {
			return false;
		}

		if ( null !== $this->on_connecting ) {
			( $this->on_connecting )();
		}
		// Nothing to pull is no request, and no refusal worth recording.
		if ( [] === $this->subscribe ) {
			return false;
		}

		if ( $this->require_ssl && \stripos( $this->url, 'https://' ) !== 0 ) {
			$this->last_error = 'refusing non-HTTPS URL';
			$this->stderr( "ERROR: disconnected - non-HTTPS URL refused: {$this->url}" );
			$this->increase_backoff();
			$this->set_state( 'DISCONNECTED', $this->last_error ?? '' );
			return false;
		}

		$endpoint = $this->url . '/wp-json/newspack-nodes/v1/messages/stream';
		$params   = [ 'subscribe' => \implode( ',', $this->subscribe ) ];
		if ( $this->multi_writer ) {
			$params['multi_writer'] = '1';
		}
		// Always sent: omission means tail, so {0,0} would be unaskable.
		$params['positions'] = (string) \wp_json_encode( $this->positions );
		$endpoint .= ( false === \strpos( $endpoint, '?' ) ? '?' : '&' ) . \http_build_query( $params );

		$headers = [
			'Accept: text/event-stream',
			'Cache-Control: no-cache',
			// Lets the far end's slot pool honour `sse_reserved_slots`.
			'X-Newspack-Nodes-Pull: 1',
		];
		$authorization = Vault::credential_header(
			$this->auth_username,
			$this->auth_password,
			$this->auth_token
		);
		if ( '' !== $authorization ) {
			$headers[] = 'Authorization: ' . $authorization;
		}

		$opts = [
			\CURLOPT_URL            => $endpoint,
			\CURLOPT_RETURNTRANSFER => false,
			\CURLOPT_FOLLOWLOCATION => false,
			\CURLOPT_TIMEOUT        => 0,
			\CURLOPT_CONNECTTIMEOUT => self::CONNECT_TIMEOUT,
			\CURLOPT_HTTPHEADER     => $headers,
			\CURLOPT_PROTOCOLS      => $this->require_ssl ? \CURLPROTO_HTTPS : ( \CURLPROTO_HTTPS | \CURLPROTO_HTTP ),
			\CURLOPT_WRITEFUNCTION  => function ( \CurlHandle $h, string $bytes ): int {
				return $this->on_curl_data( $h, $bytes );
			},
		] + $this->tls_opts;

		$ch = Event_Framework::instance()->start_curl( $this, $opts, null );
		if ( null === $ch ) {
			$this->last_error = 'curl_init failed';
			$this->increase_backoff();
			$this->set_state( 'DISCONNECTED', $this->last_error ?? '' );
			return false;
		}

		// Reset per-connection state.
		$this->buffer             = '';
		$this->current_event      = [ 'event' => '', 'data' => '' ];
		$this->last_event_time    = $now;
		$this->connected          = false;
		$this->last_error         = null;
		$this->last_http_code     = null;
		$this->last_sse_heartbeat = null;
		$this->server_retry_ms    = null;
		$this->scheduled_reconnect_at = null;
		$this->handle             = $ch;
		$this->last_attempt       = $now;
		$this->connected_at       = null;
		$this->owner              = null;
		$this->slot               = null;
		$this->terminal_disconnect_key    = null;
		$this->terminal_disconnect_reason = null;
		// Opened; awaiting 'connected' handshake (CONNECTED replaces this).
		$this->set_state( 'CONNECTING', \implode( ',', $this->subscribe ) );
		return true;
	}

	/**
	 * CURLOPT_WRITEFUNCTION callback. Returning fewer bytes than libcurl handed over
	 * aborts the transfer, so a parser refusal returns 0 and every other path returns
	 * the full length. Bytes from a handle this node has already detached are
	 * swallowed rather than parsed: the stream state they belong to is gone.
	 *
	 * @api Dynamic entrypoint.
	 * @param \CurlHandle $handle The handle libcurl is writing from.
	 * @param string      $bytes  The chunk received.
	 * @return int Bytes consumed, or 0 to abort the transfer.
	 */
	public function on_curl_data( \CurlHandle $handle, string $bytes ): int {
		if ( $handle !== $this->handle ) {
			return \strlen( $bytes );
		}
		$length = \strlen( $bytes );
		if ( 0 === $length ) {
			return 0;
		}
		if ( null === $this->last_http_code ) {
			$code                 = \curl_getinfo( $handle, \CURLINFO_HTTP_CODE );
			$this->last_http_code = $code > 0 ? $code : null;
			if ( 200 === $this->last_http_code ) {
				$this->last_error = null;
			}
		}
		return $this->process_sse_chunk( $bytes ) ? $length : 0;
	}

	/**
	 * The stream ended. Reconnect/backoff on completion — except for a clean
	 * EOF from a server that advertised `retry:`, which is the close it
	 * scheduled and not a failure at all (see `schedule_reconnect`). The handle
	 * is read for its final status and libcurl's error detail, which a stream
	 * has no buffered body to carry.
	 *
	 * @api Called by the Event_Framework.
	 * @param \CurlHandle $handle  The stream's easy handle, released after this returns.
	 * @param int         $result  The transfer's CURLE_* code.
	 * @param null        $context The stream starts under none.
	 */
	public function on_curl_done( \CurlHandle $handle, int $result, mixed $context ): void {
		$observed_http_code = \curl_getinfo( $handle, \CURLINFO_HTTP_CODE );
		if ( $observed_http_code > 0 ) {
			$this->last_http_code = $observed_http_code;
		}
		$http_code = $this->last_http_code ?? 0;

		// Keep local parser/size errors ahead of transport errors.
		if ( null === $this->last_error ) {
			if (
				null !== $this->terminal_disconnect_key
				&& null !== $this->terminal_disconnect_reason
			) {
				$this->last_error = 'Server closed stream: ' . $this->terminal_disconnect_reason;
			} elseif ( \CURLE_OK === $result && 200 === $http_code && null !== $this->server_retry_ms ) {
				$this->schedule_reconnect( $this->server_retry_ms );
				return;
			} elseif ( \CURLE_OK !== $result ) {
				$curl_description = \curl_strerror( $result );
				$description      = self::safe_diagnostic_text(
					null === $curl_description ? 'Unknown cURL error' : $curl_description
				);
				$detail           = self::safe_diagnostic_text( \curl_error( $handle ) );
				$this->last_error = "cURL error {$result} ({$description})"
					. ( '' !== $detail ? ": {$detail}" : '' );
			} elseif ( 200 !== $http_code ) {
				$this->last_error = "HTTP {$http_code}";
			} else {
				$this->last_error = $this->clean_eof_error();
			}
		}

		$this->stderr( "ERROR: disconnected - {$this->last_error}" );
		$this->set_state( 'DISCONNECTED', $this->last_error );
		$this->detach_handle();
		$this->increase_backoff();
	}

	/**
	 * Append a chunk to the buffer and parse every complete line out of it. Public so
	 * patrons and tests can drive the parser without cURL.
	 *
	 * @api Dynamic entrypoint.
	 * @param string $bytes Raw wire bytes.
	 * @return bool False when the buffer overflowed or a line was fatal.
	 */
	public function process_sse_chunk( string $bytes ): bool {
		// bytes_read counts wire bytes; JS counts only msg data — not a bug.
		$this->bytes_read += \strlen( $bytes );
		$this->buffer     .= $bytes;

		if ( \strlen( $this->buffer ) > self::MAX_BUFFER_SIZE ) {
			$error            = 'Buffer overflow (no newline in ' . self::MAX_BUFFER_SIZE . ' bytes)';
			$this->last_error = $error;
			$this->buffer     = '';
			$this->retire_lease();
			$this->set_state( 'ERROR', $error );
			$this->stderr( "ERROR: {$error}" );
			return false;
		}

		// Consume ONCE; a rewrite per line is quadratic in the line count.
		$pos = 0;
		try {
			while ( false !== ( $newline_pos = \strpos( $this->buffer, "\n", $pos ) ) ) {
				$line = \rtrim( \substr( $this->buffer, $pos, $newline_pos - $pos ), "\r" );
				$pos  = $newline_pos + 1;
				if ( ! $this->parse_sse_line( $line ) ) {
					return false;
				}
			}
			return true;
		} finally {
			if ( $pos > 0 ) {
				$this->buffer = \substr( $this->buffer, $pos );
			}
		}
	}

	/**
	 * Consume one SSE line: a blank line dispatches the accumulated event, a leading
	 * colon is a comment, and `event`, `retry` and `data` accumulate. Any other field
	 * name is ignored, per the SSE spec.
	 *
	 * @param string $line One line, already stripped of its trailing CR.
	 * @return bool False when the event data overflowed.
	 */
	private function parse_sse_line( string $line ): bool {
		if ( '' === $line ) {
			return $this->dispatch_event();
		}

		$colon_pos = \strpos( $line, ':' );
		if ( false === $colon_pos || 0 === $colon_pos ) {
			// Comment line (`: keepalive`) — ignore per SSE spec.
			return true;
		}

		$field = \substr( $line, 0, $colon_pos );
		$value = \substr( $line, $colon_pos + 1 );
		if ( isset( $value[0] ) && ' ' === $value[0] ) {
			$value = \substr( $value, 1 );
		}

		switch ( $field ) {
			case 'event':
				$this->current_event['event'] = $value;
				break;
			case 'retry':
				// Our SSE_Out sends an EVENT; this covers plain-SSE servers.
				$this->server_retry_ms = Core::canonical_decimal( $value ) ?? $this->server_retry_ms;
				break;
			case 'data':
				$this->current_event['data'] .= $value;
				if ( \strlen( $this->current_event['data'] ) > self::MAX_EVENT_SIZE ) {
					$error               = 'Event data overflow (' . self::MAX_EVENT_SIZE . ' bytes)';
					$this->last_error    = $error;
					$this->current_event = [ 'event' => '', 'data' => '' ];
					$this->retire_lease();
					$this->set_state( 'ERROR', $error );
					$this->stderr( "ERROR: {$error}" );
					return false;
				}
				break;
		}
		return true;
	}

	/**
	 * Dispatch the accumulated event and clear the accumulator. `msg` hands its RAW
	 * payload to `on_message`; `connected`, `heartbeat`, `retry`, `disconnect` and
	 * `unparseable_lines` are bookkeeping this node consumes; an unknown type is
	 * ignored. Every event resets
	 * the backoff and refreshes liveness, so a talking stream never ages into
	 * `check_stale()`.
	 *
	 * @return bool False when the event was fatal to the connection.
	 */
	private function dispatch_event(): bool {
		$type     = $this->current_event['event'];
		$raw_data = $this->current_event['data'];
		$this->current_event = [ 'event' => '', 'data' => '' ];

		// Default `event:` (no field at all) is allowed for the test path.
		if ( '' === $type && '' === $raw_data ) {
			return true;
		}

		// Any successful event receipt resets backoff and refreshes liveness.
		$this->current_backoff = self::INITIAL_BACKOFF;
		$this->last_event_time = Core::$now ?: Core::right_now();

		// An EVENT, not the `retry:` field: the client owns reconnect.
		if ( 'retry' === $type ) {
			try {
				$message = Message::unpacked( $raw_data );
			} catch ( \InvalidArgumentException $e ) {
				// Per the SSE spec a malformed retry is ignored, not an error.
				return true;
			}
			$advertised = Core::canonical_decimal( $message[ Message::VALUE ] );
			// 0 is a schedule: a lifetime close sends it to reopen at once.
			if ( null !== $advertised ) {
				$this->server_retry_ms = $advertised;
			}
			return true;
		}

		// Heartbeats prove liveness — record receipt, return before unpack.
		if ( 'heartbeat' === $type ) {
			$this->last_sse_heartbeat = (int) ( Core::$now ?: Core::right_now() );
			return true;
		}

		// 'connected' handshake: unpack, capture slot/owner, don't forward.
		if ( 'connected' === $type ) {
			try {
				$message = Message::unpacked( $raw_data );
			} catch ( \InvalidArgumentException $e ) {
				return $this->reject_connected( 'unparseable connected frame' );
			}
			return $this->handle_connected( $message );
		}

		// Retain the terminal machine key + display reason; consume the event.
		if ( 'disconnect' === $type ) {
			try {
				$message = Message::unpacked( $raw_data );
			} catch ( \InvalidArgumentException $e ) {
				$error            = 'unparseable disconnect frame';
				$this->last_error = $error;
				$this->retire_lease();
				$this->set_state( 'ERROR', $error );
				$this->stderr( "ERROR: {$error}" );
				return false;
			}
			$key    = $message[ Message::KEY ];
			$reason = $message[ Message::VALUE ];
			if (
				! \is_string( $key )
				|| '' === \trim( $key )
				|| ! \is_string( $reason )
				|| '' === \trim( $reason )
			) {
				$error            = 'malformed disconnect envelope';
				$this->last_error = $error;
				$this->retire_lease();
				$this->set_state( 'ERROR', $error );
				$this->stderr( "ERROR: {$error}" );
				return false;
			}
			$terminal_key    = self::safe_diagnostic_text( $key );
			$terminal_reason = self::safe_diagnostic_text( $reason );

			$this->terminal_disconnect_key    = $terminal_key;
			$this->terminal_disconnect_reason = $terminal_reason;
			$this->retire_lease();
			$this->set_state( 'DISCONNECTING', $terminal_reason );
			return true;
		}

		if ( 'unparseable_lines' === $type ) {
			return $this->handle_unparseable( $raw_data );
		}

		// 'msg' hands RAW payload to owner; its forward_line owns unparse/DLQ.
		if ( 'msg' === $type ) {
			$this->largest_msg_sent = \max( $this->largest_msg_sent, \strlen( $raw_data ) );
			$this->counter++;
			if ( null !== $this->on_message ) {
				( $this->on_message )( $raw_data );
			}
			return true;
		}

		return true;
	}

	/**
	 * Handle the substrate's bookkeeping `connected` handshake — its own SSE event
	 * type (mirrors `heartbeat`). Capture slot and owner from the flat
	 * `KEY VALUE` envelope, mark connected, and do NOT forward. Required numeric
	 * values use canonical decimal form so the owner cannot be lossy-coerced.
	 *
	 * @param array<int,mixed> $message 7-field Message array.
	 * @return bool False when the envelope was rejected.
	 */
	private function handle_connected( array $message ): bool {
		$value = $message[ Message::VALUE ];
		if ( ! \is_string( $value ) ) {
			return $this->reject_connected( 'malformed connected envelope (non-string value)' );
		}
		$info = self::flat_info( $value );
		if ( null === $info ) {
			return $this->reject_connected( 'malformed connected envelope' );
		}

		$slot = Core::canonical_decimal( $info['SLOT'] ?? null );
		if ( null === $slot ) {
			return $this->reject_connected( 'connected envelope missing or invalid SLOT' );
		}
		$owner = Core::canonical_decimal( $info['OWNER'] ?? null, false );
		if ( null === $owner ) {
			return $this->reject_connected( 'connected envelope missing or invalid OWNER' );
		}
		$this->slot        = $slot;
		$this->owner       = $owner;
		$this->connected   = true;
		$this->connected_at = Core::$now ?: Core::right_now();
		// OWNER is a fencing token; omit it from debug/state payloads and logs.
		$this->set_state( 'CONNECTED', "SLOT {$slot}" );
		$cursors = self::cursors_of( Core::as_string( $info['CURSORS'] ?? '' ) );
		if ( [] !== $cursors && null !== $this->on_connected ) {
			( $this->on_connected )( $cursors );
		}
		return true;
	}

	/**
	 * Add one `unparseable_lines` frame to the running count, published as
	 * UNPARSEABLE_LINES, and hand the patron where the spoke's readers now
	 * stand. The spoke's readers keep no cursor, so a torn line is skipped
	 * rather than ending the stream, and this frame is how the hub learns of
	 * it. A frame whose COUNT is not a positive decimal is reported as an ERROR
	 * and counts nothing, but leaves the stream up, as the browser twin does.
	 *
	 * @param string $raw_data The frame's packed Message.
	 * @return bool Always true: no frame of this type ends the connection.
	 */
	private function handle_unparseable( string $raw_data ): bool {
		try {
			$value = Message::unpacked( $raw_data )[ Message::VALUE ];
		} catch ( \InvalidArgumentException $e ) {
			$value = null;
		}
		$info  = self::flat_info( \is_string( $value ) ? $value : '' ) ?? [];
		$count = Core::canonical_decimal( $info['COUNT'] ?? null );
		if ( null === $count || 0 === $count ) {
			$this->set_state( 'ERROR', 'malformed unparseable_lines frame' );
			$this->print_less_often( 'ERROR: dropped a malformed unparseable_lines frame' );
			return true;
		}
		$this->unparseable_lines += $count;
		$this->set_state( 'UNPARSEABLE_LINES', (string) $this->unparseable_lines );
		$cursors = self::cursors_of( $info['CURSORS'] ?? '' );
		if ( [] !== $cursors && null !== $this->on_skipped ) {
			( $this->on_skipped )( $cursors );
		}
		return true;
	}

	/**
	 * Split a flat TM_INFO VALUE — space-separated `KEY VALUE` pairs, the shape of
	 * the `connected` envelope and the `unparseable_lines` frame — into a map.
	 *
	 * @param string $value The frame's VALUE.
	 * @return array<string,string>|null Each KEY to the token after it, or null when a KEY has no VALUE.
	 */
	private static function flat_info( string $value ): ?array {
		$tokens = \preg_split( '/ +/', \trim( $value ) );
		if ( false === $tokens || 0 !== \count( $tokens ) % 2 ) {
			return null;
		}
		$info = [];
		for ( $i = 0, $count = \count( $tokens ); $i < $count; $i += 2 ) {
			$info[ $tokens[ $i ] ] = $tokens[ $i + 1 ];
		}
		return $info;
	}

	/**
	 * Every `stamp=segment:offset` pair of a frame's CURSORS token. A file-mode
	 * source whose generation is not known yet writes `stamp=:offset`, so its
	 * entry carries no `segment`; a pair whose numbers are not canonical
	 * decimals is skipped.
	 *
	 * @param string $token The token, empty when the spoke sent none.
	 * @return array<string,array{segment?:int,offset:int}>
	 */
	private static function cursors_of( string $token ): array {
		$cursors = [];
		foreach ( \explode( ',', $token ) as $pair ) {
			[ $stamp, $position ] = \array_pad( \explode( '=', $pair, 2 ), 2, '' );
			[ $segment, $offset ] = \array_pad( \explode( ':', $position, 2 ), 2, null );
			$offset               = Core::canonical_decimal( $offset );
			if ( '' === $stamp || null === $offset ) {
				continue;
			}
			if ( '' === $segment ) {
				$cursors[ $stamp ] = [ 'offset' => $offset ];
				continue;
			}
			$segment = Core::canonical_decimal( $segment );
			if ( null !== $segment ) {
				$cursors[ $stamp ] = [ 'segment' => $segment, 'offset' => $offset ];
			}
		}
		return $cursors;
	}

	/**
	 * Reject a malformed connected handshake without retaining a partial lease.
	 *
	 * @param string $reason Operator-facing rejection reason.
	 * @return bool Always false, so the caller aborts the transfer.
	 */
	private function reject_connected( string $reason ): bool {
		$this->connected_at = null;
		$this->retire_lease();
		$this->last_error  = $reason;
		$this->set_state( 'ERROR', $reason );
		$this->stderr( "ERROR: {$reason}" );
		return false;
	}

	/**
	 * Single-line, bounded text safe for operator diagnostics.
	 *
	 * @param string $text Raw text from libcurl or the remote.
	 * @return string Control characters collapsed to spaces, trimmed to 512 bytes.
	 */
	private static function safe_diagnostic_text( string $text ): string {
		$clean = \preg_replace( '/[\x00-\x1F\x7F]+/', ' ', $text );
		$clean = \trim( null === $clean ? '' : $clean );
		if ( \strlen( $clean ) > 512 ) {
			$clean = \substr( $clean, 0, 509 ) . '...';
		}
		return $clean;
	}

	/**
	 * Factual clean-EOF message, augmented only by a valid handshake's context.
	 *
	 * @return string The error text `on_curl_done()` records and reports.
	 */
	private function clean_eof_error(): string {
		$error = 'HTTP 200 SSE stream ended without a server disconnect reason';
		if ( null === $this->connected_at ) {
			return $error;
		}
		$now      = Core::$now ?: Core::right_now();
		$duration = \max( 0.0, $now - $this->connected_at );
		return $error . ' (connected ' . \number_format( $duration, 2, '.', '' ) . 's)';
	}

	/**
	 * Reconnect-on-stale check. Driven by the patron (no timer here). Gated on
	 * the HANDLE rather than the lease: a socket that opened and then went
	 * silent before its handshake is exactly what this watchdog is for, and
	 * CURLOPT_TIMEOUT is 0, so nothing else covers that window.
	 *
	 * @api Dynamic entrypoint.
	 */
	public function check_stale(): void {
		if ( ! ( $this->handle instanceof \CurlHandle ) ) {
			return;
		}
		$now     = Core::$now ?: Core::right_now();
		$elapsed = $now - $this->last_event_time;
		if ( $elapsed <= self::HEARTBEAT_TIMEOUT ) {
			return;
		}
		$stale_seconds    = (int) $elapsed;
		$this->last_error = "Stale connection (no events for {$stale_seconds}s)";
		$this->stderr( "ERROR: reconnecting - stale ({$stale_seconds}s)" );
		$this->set_state( 'RECONNECTING', $this->last_error );

		$this->detach_handle();
		$this->increase_backoff();
	}

	/**
	 * A close the server scheduled with `retry:`. Hold the advertised delay from
	 * THIS moment — a long-lived stream has already outrun a delay measured from
	 * its connect — and leave the failure state untouched: no error, no doubling
	 * backoff, nothing a dashboard reads as a dead link. A delay of 0 reopens on
	 * the next tick.
	 *
	 * @param int $retry_ms The advertised reopen delay.
	 */
	private function schedule_reconnect( int $retry_ms ): void {
		$seconds = \min( self::MAX_BACKOFF, (int) \ceil( $retry_ms / 1000 ) );
		$this->set_state( 'RECONNECTING', "scheduled reconnect in {$seconds}s" );
		$this->detach_handle();
		$this->current_backoff        = $seconds;
		$this->last_attempt           = Core::$now ?: Core::right_now();
		$this->scheduled_reconnect_at = (int) $this->last_attempt + $seconds;
	}

	/** Double the reconnect delay, clamped to `INITIAL_BACKOFF`..`MAX_BACKOFF`. */
	private function increase_backoff(): void {
		$this->current_backoff = \min( self::MAX_BACKOFF, \max( self::INITIAL_BACKOFF, $this->current_backoff * 2 ) );
	}

	/**
	 * Teardown: disconnect (unregisters the easy handle off the shared multi + drops it).
	 *
	 * @api Dynamic entrypoint.
	 */
	public function remove_node(): void {
		$this->disconnect();
		parent::remove_node();
	}

	/**
	 * Force-disconnect. Called externally by the patron on teardown.
	 *
	 * @api Dynamic entrypoint.
	 */
	public function disconnect(): void {
		$this->detach_handle();
	}

	/**
	 * Detach the active handle: unregister it off the shared multi (so the drain
	 * loop won't spin on a dead fd), then drop the reference. Idempotent.
	 */
	private function detach_handle(): void {
		$handle = $this->handle;
		if ( $handle instanceof \CurlHandle ) {
			Event_Framework::instance()->unregister_curl_easy( $handle );
			$this->handle = null;
		}
		$this->retire_lease();
	}

	/** Make a disconnected stream's lease immediately ineligible for heartbeat. */
	private function retire_lease(): void {
		$this->connected = false;
		$this->owner     = null;
		$this->slot      = null;
	}

	/**
	 * Backpressure valve — ARM: re-add the easy handle to the shared multi so its socket
	 * is serviced again, resuming the paused transfer. No-op without a live handle.
	 * The dual of disarm(); a buffering owner (Remote_Source) calls this when its buffer runs
	 * dry of complete lines.
	 *
	 * @api Support for the Remote_Source Durable_Reader valve.
	 */
	public function arm(): void {
		// Only register with a live handle; arming while disconnected respins.
		if ( $this->handle instanceof \CurlHandle ) {
			Event_Framework::instance()->register_curl_easy( $this, $this->handle, null );
		}
	}

	/**
	 * Backpressure valve — DISARM: remove the easy handle from the shared multi. libcurl
	 * stops reading it (the handle stays open), so the kernel recv buffer fills, the TCP
	 * window closes, and the remote SSE server blocks on write. Real end-to-end backpressure.
	 * A buffering owner calls this once its buffer holds a line.
	 *
	 * @api Support for the Remote_Source Durable_Reader valve.
	 */
	public function disarm(): void {
		if ( $this->handle instanceof \CurlHandle ) {
			Event_Framework::instance()->unregister_curl_easy( $this->handle );
		}
	}

	/**
	 * Programmatic configuration entry point for the patron. Sets every field
	 * directly and touches no socket, so it takes effect at the next connect.
	 * What to pull arrives separately, through `streams()`.
	 *
	 * @param string              $url           Base URL (no trailing slash).
	 * @param string              $auth_username Application-Password user (Basic auth).
	 * @param string              $auth_password Application-Password secret.
	 * @param string              $auth_token    Optional Bearer token fallback.
	 * @param array<int,bool|int> $tls_opts      The TLS opts `Vault::tls_opts()` resolved.
	 * @param bool                $require_ssl   Refuse non-HTTPS remote URLs.
	 */
	public function configure(
		string $url,
		string $auth_username = '',
		string $auth_password = '',
		string $auth_token    = '',
		array $tls_opts       = [],
		bool $require_ssl     = false
	): void {
		$this->url           = \rtrim( $url, '/' );
		$this->auth_username = $auth_username;
		$this->auth_password = $auth_password;
		$this->auth_token    = $auth_token;
		$this->tls_opts      = $tls_opts;
		$this->require_ssl   = $require_ssl;
	}

	/**
	 * State what the next connect asks for. The patron calls it from
	 * `on_connecting`, so a request carries where each stream stands at the
	 * moment it goes out; nothing here keeps or advances a cursor.
	 *
	 * @param list<string>                                             $subscribe Subscriptions, in order.
	 * @param array<string,array{segment?:int,offset:int}|int|string> $positions Per-stamp starting point.
	 */
	public function streams( array $subscribe, array $positions ): void {
		$this->subscribe = $subscribe;
		$this->positions = $positions;
	}

	/**
	 * Ask the remote to read this subscription with the multi-writer seal-grace
	 * (`Consumer_Node::SEAL_GRACE_SECONDS`), for a log its own request processes
	 * append to. Carried as a connect-time query parameter, so a change reaches
	 * the far-side reader only on the next stream — the patron drops the current
	 * one to make that happen.
	 *
	 * @param bool $flag Whether the remote reader applies the seal-grace.
	 */
	public function set_multi_writer( bool $flag ): void {
		$this->multi_writer = $flag;
	}

	/**
	 * Slot captured from the `connected` handshake.
	 *
	 * @api Dynamic entrypoint.
	 * @return int|null The leased slot index, or null while unconnected.
	 */
	public function slot(): ?int {
		return $this->slot;
	}

	/**
	 * Lease owner captured from the `connected` handshake.
	 *
	 * @api Dynamic entrypoint.
	 * @return int|null The fencing token, or null while unconnected.
	 */
	public function owner(): ?int {
		return $this->owner;
	}

	/**
	 * Connection-state snapshot for the patron. `connected` is the LEASE — true
	 * only past the `connected` handshake; an open handle still awaiting it is
	 * `connecting`, which is neither up nor a failure. `scheduled_reconnect_at`
	 * is the explicit "closed on purpose, back at T" reading — a null
	 * `last_error` also means "never attempted", so idleness gets a field of its
	 * own rather than being inferred from the absence of a failure.
	 *
	 * @api Dynamic entrypoint.
	 * @return array{connected:bool,connecting:bool,last_http_code:?int,last_error:?string,current_backoff:int,last_sse_heartbeat:?int,last_attempt:?int,scheduled_reconnect_at:?int,unparseable_lines:int}
	 */
	public function connection(): array {
		return [
			'connected'              => $this->connected,
			'connecting'             => $this->handle instanceof \CurlHandle && ! $this->connected,
			'last_http_code'         => $this->last_http_code,
			'last_error'             => $this->last_error,
			'current_backoff'        => $this->current_backoff,
			'last_sse_heartbeat'     => $this->last_sse_heartbeat,
			'last_attempt'           => $this->last_attempt > 0.0 ? (int) $this->last_attempt : null,
			'scheduled_reconnect_at' => $this->scheduled_reconnect_at,
			'unparseable_lines'      => $this->unparseable_lines,
		];
	}

	/**
	 * The active easy handle, for tests asserting connect and teardown.
	 *
	 * @api Used by tests.
	 * @return \CurlHandle|null The live handle, or null while disconnected.
	 */
	public function test_get_handle(): ?\CurlHandle {
		return $this->handle;
	}

	/**
	 * Palette entry for the topology console. Hidden because a patron builds this
	 * node rather than an operator, and it accepts no fill.
	 *
	 * @api Dynamic entrypoint.
	 * @return array<string,mixed>
	 */
	public static function node_schema(): array {
		return [
			'category'     => 'I/O',
			'hidden'       => true,
			'description'  => 'Passive inbound SSE pull. Configured programmatically by a patron node.',
			'arguments'    => [],
			'commands'     => [],
			'requests'     => [],
			'accepts_fill' => false,
		];
	}
}
