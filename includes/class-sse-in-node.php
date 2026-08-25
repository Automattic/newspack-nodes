<?php
/**
 * SSE_In: generic inbound SSE pull. A passive, hidden, programmatically-configured
 * source node.
 *
 * It owns one easy handle (the SSE GET) registered on the Event_Framework's shared
 * cURL multi, one in-memory `{segment, offset}` cursor, and one SSE connection's
 * worth of parser state. It is a *source*: `fill()` is a no-op (it doesn't receive
 * messages). Delivery is the `on_message` seam ONLY — each `data:` payload is handed
 * to the patron RAW, byte-identical to the remote's on-disk encoding, and the patron
 * owns unpacking, FROM stamping, target and the sink fill. This node reads neither
 * `sink` nor `target`; `node_schema()` declares no `has_target` for the same reason.
 *
 * It is passive: it owns NO timer. Inbound bytes flow via the Event_Framework's
 * cURL polling (`register_curl_easy` + `on_curl_message`, like HTTP_Out).
 * Connect / reconnect / stale are driven by a *patron* calling `maybe_connect()`
 * and `check_stale()`. The patron owns durable position persistence and any status
 * memcache write — SSE_In keeps only the in-memory cursor + connection state.
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes;

\defined( 'ABSPATH' ) || exit;

// phpcs:disable WordPress.WP.AlternativeFunctions.curl_curl_init
// phpcs:disable WordPress.WP.AlternativeFunctions.curl_curl_setopt_array
// phpcs:disable WordPress.WP.AlternativeFunctions.curl_curl_getinfo
// phpcs:disable WordPress.WP.AlternativeFunctions.curl_curl_error
// phpcs:disable WordPress.WP.AlternativeFunctions.curl_curl_strerror
// cURL is required for SSE multiplexing — wp_remote_get() can't do it.

class SSE_In_Node extends Node {
	public const CONNECT_TIMEOUT   = 5;
	public const HEARTBEAT_TIMEOUT = 45;
	public const INITIAL_BACKOFF   = 1;

	public const MAX_BACKOFF       = 30;

	/** Hard ceilings on the stream buffer and on one event: 32 MB each. */
	public const MAX_BUFFER_SIZE   = 33554432;
	public const MAX_EVENT_SIZE    = 33554432;

	/**
	 * libcurl dispatch seam. Lazily-defaulted to a closure that creates the easy
	 * handle and applies $opts via curl_setopt_array (the Event_Framework owns the
	 * shared multi + the add). Tests reassign to capture $opts without transferring —
	 * so the URL build, auth-header assembly, and SSL/timeout opts run as real
	 * production code.
	 *
	 * Signature: `function ( array $opts ): \CurlHandle|false`.
	 *
	 * @var \Closure|null
	 */
	public static ?\Closure $curl_dispatch = null;

	/**
	 * Delivery seam. The owner (patron) sets this; every `msg` SSE event hands its RAW
	 * `data:` payload (the packed line, byte-identical to the remote's on-disk encoding)
	 * to it. Remote_Source implements it as an append
	 * the raw line to its Durable_Reader buffer. A null seam drops the event.
	 * Signature: `function ( string $raw ): void`.
	 *
	 * @var \Closure|null
	 */
	public ?\Closure $on_message        = null;
	protected string $auth_password     = '';
	protected string $auth_token        = '';
	protected string $auth_username     = '';
	protected string $subscribe         = '';

	/** Ask the remote to read this subscription with the multi-writer seal-grace. */
	protected bool $multi_writer        = false;

	protected string $url               = '';

	private string $buffer              = '';
	/** The LEASE: true only past the `connected` handshake, never at open. */
	private bool   $connected           = false;
	private ?float $connected_at        = null;
	private int    $current_backoff     = self::INITIAL_BACKOFF;
	/** @var array{event:string, data:string} Current SSE event accumulator. */
	private array  $current_event       = [ 'event' => '', 'data' => '' ];

	/** Active easy handle when connected, null otherwise. Registered on the Event_Framework's shared multi. */
	private ?\CurlHandle $handle        = null;
	private float   $last_attempt       = 0.0;
	private ?string $last_error         = null;
	private float   $last_event_time    = 0.0;
	private ?int    $last_http_code     = null;
	private ?int    $last_sse_heartbeat = null;

	/** @var array{segment:int, offset:int} Read cursor. */
	private array $position             = [ 'segment' => 0, 'offset' => 0 ];
	/** Whether $position is a real place we were put, vs the never-seeded default. */
	private bool  $position_set         = false;
	/** A SEEK sentinel to ask for instead of $position; the remote resolves it. */
	private ?int  $pending_seek         = null;
	/** Reopen delay the server advertised — `retry` event or field; null = none. */
	private ?int  $server_retry_ms      = null;
	/** Wall-second this stream is due back after a scheduled close; null = not waiting on one. */
	private ?int  $scheduled_reconnect_at = null;
	private bool  $require_ssl          = false;
	/** Lease owner captured from the `connected` handshake. */
	private ?int  $owner                = null;
	/** Session pid snooped from the `connected` handshake; scopes a reply-FROM. */
	private ?int  $session_pid          = null;
	private ?int  $slot                 = null;
	private ?string $terminal_disconnect_key    = null;
	private ?string $terminal_disconnect_reason = null;

	private bool $verify_ssl            = true;

	/** Tachikoma-parity: no-arg ctor. Config arrives via configure(); no I/O here (ADR-5). */
	public function __construct() {
		parent::__construct();
	}

	/**
	 * Node contract. SSE_In is a *source* — like Tail, it generates messages from
	 * an external stream, but it hands them to the `on_message` seam rather than a
	 * sink. It doesn't accept upstream messages.
	 *
	 * @api Dynamic entrypoint.
	 * @param array<int,mixed> $message The 7-field positional message array.
	 */
	public function fill( array $message ): void {
		++$this->counter;
	}

	/**
	 * Open an easy handle if currently disconnected and outside backoff.
	 *
	 * @api Dynamic entrypoint.
	 * @return bool true if a handle was opened.
	 */
	public function maybe_connect(): bool {
		if ( $this->handle instanceof \CurlHandle ) {
			return false;
		}

		$now = Core::$now ?: Core::right_now();
		if ( $this->last_attempt > 0.0 && ( $now - $this->last_attempt ) < $this->current_backoff ) {
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
		$params   = [
			'subscribe' => $this->subscribe,
		];
		if ( $this->multi_writer ) {
			$params['multi_writer'] = '1';
		}
		// Stated, never implied: omission meant "tail", so {0,0} was unaskable.
		$params['positions'] = (string) \wp_json_encode(
			[
				// Keyed by partition dir = $subscribe (<topic>.p<N>).
				$this->subscribe => $this->pending_seek ?? (
					$this->position_set
						? [
							'segment' => $this->position['segment'],
							'offset' => $this->position['offset'],
						]
						: Consumer_Node::SEEK_END
				),
			]
		);
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
			\CURLOPT_SSL_VERIFYPEER => $this->verify_ssl,
			\CURLOPT_SSL_VERIFYHOST => $this->verify_ssl ? 2 : 0,
			\CURLOPT_PROTOCOLS      => $this->require_ssl ? \CURLPROTO_HTTPS : ( \CURLPROTO_HTTPS | \CURLPROTO_HTTP ),
			\CURLOPT_WRITEFUNCTION  => function ( \CurlHandle $h, string $bytes ): int {
				return $this->on_curl_data( $h, $bytes );
			},
		];

		$dispatch = self::$curl_dispatch ?? static function ( array $o ): \CurlHandle|false {
			$ch = \curl_init();
			if ( false === $ch ) {
				return false;
			}
			\curl_setopt_array( $ch, $o );
			return $ch;
		};

		$ch = $dispatch( $opts );
		if ( ! $ch instanceof \CurlHandle ) {
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
		$this->session_pid        = null;
		$this->slot               = null;
		$this->terminal_disconnect_key    = null;
		$this->terminal_disconnect_reason = null;
		Event_Framework::instance()->register_curl_easy( $this, $ch );
		// Opened; awaiting 'connected' handshake (CONNECTED replaces this).
		$this->set_state( 'CONNECTING', $this->subscribe );
		return true;
	}

	/**
	 * CURLOPT_WRITEFUNCTION callback. Returns bytes-consumed or 0 to abort.
	 *
	 * @api Dynamic entrypoint.
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
	 * Called by Event_Framework when curl_multi_info_read returns CURLMSG_DONE for
	 * this node's easy handle. Reconnect/backoff on completion — except for a
	 * clean EOF from a server that advertised `retry:`, which is the close it
	 * scheduled and not a failure at all (see `schedule_reconnect`).
	 *
	 * @api Dynamic entrypoint.
	 * @param array{msg?:int, handle?:\CurlHandle, result?:int} $info
	 */
	public function on_curl_message( array $info ): void {
		if ( ! isset( $info['msg'] ) || \CURLMSG_DONE !== $info['msg'] ) {
			return;
		}
		$handle = $info['handle'] ?? null;
		if ( ! ( $handle instanceof \CurlHandle ) || $handle !== $this->handle ) {
			// Stale handle — best-effort cleanup off the shared multi.
			if ( $handle instanceof \CurlHandle ) {
				Event_Framework::instance()->unregister_curl_easy( $handle );
			}
			return;
		}

		$result             = $info['result'] ?? \CURLE_OK;
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
	 * Parse a chunk of SSE bytes off the buffer. Returns false on overflow.
	 * Public so patrons / tests can drive the parser without cURL.
	 *
	 * @api Dynamic entrypoint.
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
			// 0 is "no schedule", not a schedule of zero.
			if ( null !== $advertised && $advertised > 0 ) {
				$this->server_retry_ms = $advertised;
			}
			return true;
		}

		// Heartbeats prove liveness — record receipt, return before unpack.
		if ( 'heartbeat' === $type ) {
			$this->last_sse_heartbeat = (int) ( Core::$now ?: Core::right_now() );
			return true;
		}

		// 'connected' handshake: unpack, capture slot/pid, don't forward.
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
	 * type (mirrors `heartbeat`). Capture slot, owner, and session pid from the flat
	 * `KEY VALUE` envelope, mark connected, and do NOT forward. Required numeric
	 * values use canonical decimal form so the owner cannot be lossy-coerced.
	 *
	 * @param array<int,mixed> $message 7-field Message array.
	 * @return bool
	 */
	private function handle_connected( array $message ): bool {
		$value = $message[ Message::VALUE ];
		if ( ! \is_string( $value ) ) {
			return $this->reject_connected( 'malformed connected envelope (non-string value)' );
		}
		$tokens = \preg_split( '/ +/', \trim( $value ) );
		if ( false === $tokens || 0 !== \count( $tokens ) % 2 ) {
			return $this->reject_connected( 'malformed connected envelope' );
		}
		$info = [];
		for ( $i = 0, $count = \count( $tokens ); $i < $count; $i += 2 ) {
			$info[ $tokens[ $i ] ] = $tokens[ $i + 1 ];
		}

		$slot = Core::canonical_decimal( $info['SLOT'] ?? null );
		if ( null === $slot ) {
			return $this->reject_connected( 'connected envelope missing or invalid SLOT' );
		}
		$owner = Core::canonical_decimal( $info['OWNER'] ?? null, false );
		if ( null === $owner ) {
			return $this->reject_connected( 'connected envelope missing or invalid OWNER' );
		}
		$pid = Core::canonical_decimal( $info['PID'] ?? null, false );
		if ( null === $pid ) {
			return $this->reject_connected( 'connected envelope missing or invalid PID' );
		}

		$this->slot        = $slot;
		$this->owner       = $owner;
		$this->session_pid = $pid;
		$this->connected   = true;
		$this->connected_at = Core::$now ?: Core::right_now();
		// OWNER is a fencing token; omit it from debug/state payloads and logs.
		$this->set_state( 'CONNECTED', "PID {$pid} SLOT {$slot}" );
		return true;
	}

	/** Reject a malformed connected handshake without retaining a partial lease. */
	private function reject_connected( string $reason ): bool {
		$this->session_pid = null;
		$this->connected_at = null;
		$this->retire_lease();
		$this->last_error  = $reason;
		$this->set_state( 'ERROR', $reason );
		$this->stderr( "ERROR: {$reason}" );
		return false;
	}

	/** Single-line, bounded text safe for operator diagnostics. */
	private static function safe_diagnostic_text( string $text ): string {
		$clean = \preg_replace( '/[\x00-\x1F\x7F]+/', ' ', $text );
		$clean = \trim( null === $clean ? '' : $clean );
		if ( \strlen( $clean ) > 512 ) {
			$clean = \substr( $clean, 0, 509 ) . '...';
		}
		return $clean;
	}

	/** Factual clean-EOF message, augmented only by a valid handshake's context. */
	private function clean_eof_error(): string {
		$error = 'HTTP 200 SSE stream ended without a server disconnect reason';
		if ( null === $this->session_pid || null === $this->connected_at ) {
			return $error;
		}
		$now      = Core::$now ?: Core::right_now();
		$duration = \max( 0.0, $now - $this->connected_at );
		return $error . ' (remote PID ' . $this->session_pid
			. ', connected ' . \number_format( $duration, 2, '.', '' ) . 's)';
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
	 * backoff, nothing a dashboard reads as a dead link.
	 *
	 * @param int $retry_ms The advertised reopen delay.
	 */
	private function schedule_reconnect( int $retry_ms ): void {
		$seconds = \max( self::INITIAL_BACKOFF, \min( self::MAX_BACKOFF, (int) \ceil( $retry_ms / 1000 ) ) );
		$this->set_state( 'RECONNECTING', "scheduled reconnect in {$seconds}s" );
		$this->detach_handle();
		$this->current_backoff        = $seconds;
		$this->last_attempt           = Core::$now ?: Core::right_now();
		$this->scheduled_reconnect_at = (int) $this->last_attempt + $seconds;
	}

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
	 * is serviced again, resuming the paused transfer. No-op until connected (no handle yet).
	 * The dual of disarm(); a buffering owner (Remote_Source) calls this when its buffer runs
	 * dry of complete lines.
	 *
	 * @api Support for the Remote_Source Durable_Reader valve.
	 */
	public function arm(): void {
		// Only register with a live handle; arming while disconnected respins.
		if ( $this->handle instanceof \CurlHandle ) {
			Event_Framework::instance()->register_curl_easy( $this, $this->handle );
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
	 * directly. `$subscribe` is the full `<remote_topic>.p<partition>` string.
	 *
	 * @param string             $url           Base URL (no trailing slash).
	 * @param string             $auth_username Application-Password user (Basic auth).
	 * @param string             $auth_password Application-Password secret.
	 * @param string             $auth_token    Optional Bearer token fallback.
	 * @param string             $subscribe     Subscription name (`<topic>.p<N>`).
	 * @param array{segment?:int,offset?:int} $positions Initial cursor.
	 * @param bool               $verify_ssl    Verify the remote SSL cert.
	 * @param bool               $require_ssl   Refuse non-HTTPS remote URLs.
	 */
	public function configure(
		string $url,
		string $auth_username = '',
		string $auth_password = '',
		string $auth_token    = '',
		string $subscribe     = '',
		array $positions      = [],
		bool $verify_ssl      = true,
		bool $require_ssl     = false
	): void {
		$this->url           = \rtrim( $url, '/' );
		$this->auth_username = $auth_username;
		$this->auth_password = $auth_password;
		$this->auth_token    = $auth_token;
		$this->subscribe     = $subscribe;
		$this->verify_ssl    = $verify_ssl;
		$this->require_ssl   = $require_ssl;
		$this->position      = [
			'segment' => \max( 0, $positions['segment'] ?? 0 ),
			'offset'     => \max( 0, $positions['offset'] ?? 0 ),
		];
		// An empty restore is "nowhere yet", which is NOT the same as 0:0.
		$this->position_set  = isset( $positions['segment'] ) || isset( $positions['offset'] );
	}

	/**
	 * Ask the remote to read this subscription with the multi-writer seal-grace
	 * (`Consumer_Node::SEAL_GRACE_SECONDS`), for a log its own request processes
	 * append to. Carried as a connect-time query parameter, so a change reaches
	 * the far-side reader only on the next stream — the patron drops the current
	 * one to make that happen.
	 */
	public function set_multi_writer( bool $flag ): void {
		$this->multi_writer = $flag;
	}

	/**
	 * Restore last-committed position. Called by the patron before `maybe_connect()`.
	 *
	 * @api Dynamic entrypoint.
	 */
	public function restore_position( int $segment, int $offset ): void {
		$this->position      = [
			'segment' => \max( 0, $segment ),
			'offset'     => \max( 0, $offset ),
		];
		$this->position_set  = true;
		// A real place supersedes a pending seek — the seek got us here.
		$this->pending_seek  = null;
	}

	/**
	 * Ask the remote for a SEEK rather than a byte position (`Consumer_Node::SEEK_*`).
	 * A pull source has no segments of its own, so it cannot resolve `end` or `recent`
	 * locally; it forwards the sentinel to the side that holds the log. Held until the
	 * first forwarded record replaces it with a real position.
	 */
	public function seek( int $sentinel ): void {
		$this->pending_seek = $sentinel;
	}

	/** True while a seek sentinel is waiting for the spoke to resolve it. */
	public function has_pending_seek(): bool {
		return null !== $this->pending_seek;
	}

	/**
	 * Current in-memory cursor.
	 *
	 * @api Dynamic entrypoint.
	 * @return array{segment:int,offset:int}
	 */
	public function position(): array {
		return $this->position;
	}

	/**
	 * Slot captured from the `connected` handshake.
	 *
	 * @api Dynamic entrypoint.
	 */
	public function slot(): ?int {
		return $this->slot;
	}

	/**
	 * Lease owner captured from the `connected` handshake.
	 *
	 * @api Dynamic entrypoint.
	 */
	public function owner(): ?int {
		return $this->owner;
	}

	/**
	 * Session pid captured from the `connected` handshake. Null until connected.
	 * A caller stamps it into the reply-FROM (`_sse:{pid}/{node}`).
	 *
	 * @api Dynamic entrypoint.
	 */
	public function pid(): ?int {
		return $this->session_pid;
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
	 * @return array{connected:bool,connecting:bool,last_http_code:?int,last_error:?string,current_backoff:int,last_sse_heartbeat:?int,last_attempt:?int,scheduled_reconnect_at:?int}
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
		];
	}

	/** @api Used by tests. */
	public function test_get_handle(): ?\CurlHandle {
		return $this->handle;
	}

	/**
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
