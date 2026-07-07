<?php
/**
 * SSE_In: generic inbound SSE pull. A passive, hidden, programmatically-configured
 * source node — the substrate counterpart of the old ELN Remote_Source SSE
 * internals, minus the durable/aggregator concerns.
 *
 * It owns one cURL multi handle (registered with the Event_Framework), one easy
 * handle (the SSE GET), one in-memory `{segment, offset}` cursor, and one SSE
 * connection's worth of parser state. It is a *source*: `fill()` is a no-op
 * (it doesn't receive messages); it parses Messages off the SSE feed and forwards
 * them to its sink with TO=target.
 *
 * It is passive: it owns NO timer. Inbound bytes flow via the Event_Framework's
 * cURL polling (`register_curl_handle` + `on_curl_message`, like HTTP_Out).
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
// phpcs:disable WordPress.WP.AlternativeFunctions.curl_curl_close
// phpcs:disable WordPress.WP.AlternativeFunctions.curl_curl_error
// phpcs:disable WordPress.WP.AlternativeFunctions.curl_curl_multi_init
// phpcs:disable WordPress.WP.AlternativeFunctions.curl_curl_multi_add_handle
// phpcs:disable WordPress.WP.AlternativeFunctions.curl_curl_multi_remove_handle
// phpcs:disable WordPress.WP.AlternativeFunctions.curl_curl_multi_close
// Note: cURL is required for SSE multiplexing — wp_remote_get() doesn't support it.

class SSE_In_Node extends Node {

	// ----- Reconnect / liveness tuning (mirrors the old Remote_Source). -----

	public const MAX_BACKOFF        = 30;
	public const INITIAL_BACKOFF    = 1;
	public const CONNECT_TIMEOUT    = 5;
	public const HEARTBEAT_TIMEOUT  = 45;

	// ----- Memory / size guards. -----

	public const MAX_BUFFER_SIZE = 33554432; // 32MB
	public const MAX_EVENT_SIZE  = 33554432; // 32MB

	/**
	 * libcurl dispatch seam. Lazily-defaulted to a closure that creates the easy
	 * handle, applies $opts via curl_setopt_array, and adds it to the multi.
	 * Tests reassign to capture $opts without transferring — so the URL build,
	 * auth-header assembly, and SSL/timeout opts run as real production code.
	 *
	 * Signature: `function ( \CurlMultiHandle $multi, array $opts ): \CurlHandle|false`.
	 *
	 * @var \Closure|null
	 */
	public static ?\Closure $curl_dispatch = null;

	protected string $url           = '';
	protected string $auth_username = '';
	protected string $auth_password = '';
	protected string $auth_token    = '';
	protected string $subscribe     = '';

	private bool $verify_ssl   = true;
	private bool $require_ssl  = false;

	/** Owned multi handle, registered with the Event_Framework. */
	private ?\CurlMultiHandle $multi = null;

	/** Active easy handle when connected, null otherwise. */
	private ?\CurlHandle $handle = null;

	private string $buffer = '';
	/** @var array{event:string, data:string} Current SSE event accumulator. */
	private array $current_event   = [ 'event' => '', 'data' => '' ];
	private ?int  $slot            = null;
	/** Session pid snooped from the `connected` handshake (Remote_IPC's reply-FROM pivot). */
	private ?int  $session_pid    = null;
	/** @var array{segment:int, offset:int} Read cursor. */
	private array $position        = [ 'segment' => 0, 'offset' => 0 ];
	private float $last_event_time = 0.0;
	private int   $current_backoff = self::INITIAL_BACKOFF;
	private float $last_attempt    = 0.0;
	private bool  $connected       = false;
	private ?string $last_error    = null;
	private ?int  $last_http_code  = null;
	private ?int  $last_sse_heartbeat = null;

	/**
	 * Poison hook. The patron (Remote_Source) sets this to route an unparseable
	 * frame's raw bytes into its DLQ. Signature: `function ( string $raw ): void`.
	 *
	 * @var \Closure|null
	 */
	public ?\Closure $on_poison = null;

	/** Tachikoma-parity: no-arg ctor. Config arrives via configure(); no I/O here (ADR-5). */
	public function __construct() {
		parent::__construct();
	}

	/**
	 * Node contract. SSE_In is a *source* — like Tail, it generates messages from
	 * an external stream and pushes them down its sink. It doesn't accept upstream
	 * messages.
	 *
	 * @api Dynamic entrypoint.
	 * @param array<int, mixed> $message The 7-field positional message array.
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

		$now = Core::$now ?: \microtime( true );
		if ( $this->last_attempt > 0.0 && ( $now - $this->last_attempt ) < $this->current_backoff ) {
			return false;
		}

		if ( $this->require_ssl && \stripos( $this->url, 'https://' ) !== 0 ) {
			$this->last_error = 'refusing non-HTTPS URL';
			$this->print_less_often( "ERROR: disconnected - non-HTTPS URL refused: {$this->url}" );
			$this->increase_backoff();
			$this->set_state( 'DISCONNECTED', $this->last_error ?? '' );
			return false;
		}

		$multi = $this->ensure_multi();

		$endpoint = $this->url . '/wp-json/newspack-nodes/v1/messages/stream';
		$params   = [
			'subscribe' => $this->subscribe,
		];
		if ( $this->position['segment'] > 0 || $this->position['offset'] > 0 ) {
			// Positions are a FLAT `{ <concrete-dir>: {segment,offset} }` map keyed by the
			// partition's directory name. `$subscribe` IS that dir name
			// (`<topic>.p<N>`, one connection per partition), so key by it directly —
			// `open_subscription` seeds `$positions[$dir]`.
			$params['positions'] = (string) \wp_json_encode(
				[
					$this->subscribe => [
						'segment' => $this->position['segment'],
						'offset' => $this->position['offset'],
					],
				]
			);
		}
		$endpoint .= ( false === \strpos( $endpoint, '?' ) ? '?' : '&' ) . \http_build_query( $params );

		$headers = [
			'Accept: text/event-stream',
			'Cache-Control: no-cache',
		];
		if ( '' !== $this->auth_username && '' !== $this->auth_password ) {
			// phpcs:ignore WordPress.PHP.DiscouragedPHPFunctions.obfuscation_base64_encode -- HTTP Basic Auth.
			$headers[] = 'Authorization: Basic ' . \base64_encode( $this->auth_username . ':' . $this->auth_password );
		} elseif ( '' !== $this->auth_token ) {
			$headers[] = 'Authorization: Bearer ' . $this->auth_token;
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

		$dispatch = self::$curl_dispatch ?? static function ( \CurlMultiHandle $m, array $o ): \CurlHandle|false {
			$ch = \curl_init();
			if ( false === $ch ) {
				return false;
			}
			\curl_setopt_array( $ch, $o );
			$result = \curl_multi_add_handle( $m, $ch );
			if ( 0 !== $result ) {
				\curl_close( $ch );
				return false;
			}
			return $ch;
		};

		$ch = $dispatch( $multi, $opts );
		if ( ! $ch instanceof \CurlHandle ) {
			$this->last_error = 'curl_init / multi_add failed';
			$this->increase_backoff();
			$this->set_state( 'DISCONNECTED', $this->last_error ?? '' );
			return false;
		}

		// Reset per-connection state.
		$this->buffer             = '';
		$this->current_event      = [ 'event' => '', 'data' => '' ];
		$this->last_event_time    = $now;
		$this->connected          = true;
		$this->last_error         = null;
		$this->last_http_code     = null;
		$this->last_sse_heartbeat = null;
		$this->handle             = $ch;
		$this->last_attempt       = $now;
		$this->slot               = null;
		// Stream opened; awaiting the `connected` handshake. CONNECTED replaces
		// this when it arrives, DISCONNECTED / RECONNECTING / ERROR on trouble.
		$this->set_state( 'CONNECTING', $this->subscribe );
		return true;
	}

	// =========================================================================
	// cURL lifecycle
	// =========================================================================

	/** Ensure the owned multi handle exists and is registered. Idempotent. */
	private function ensure_multi(): \CurlMultiHandle {
		if ( null !== $this->multi ) {
			return $this->multi;
		}
		$multi       = \curl_multi_init();
		$this->multi = $multi;
		Event_Framework::instance()->register_curl_handle( $this, $multi );
		return $multi;
	}

	// =========================================================================
	// Event_Framework callbacks (cURL multi)
	// =========================================================================

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
	 * this node's multi. Reconnect/backoff on completion.
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
			// Stale or foreign handle — best-effort cleanup.
			if ( $handle instanceof \CurlHandle ) {
				if ( null !== $this->multi ) {
					@\curl_multi_remove_handle( $this->multi, $handle );
				}
				@\curl_close( $handle );
			}
			return;
		}

		$result               = $info['result'] ?? \CURLE_OK;
		$http_code            = \curl_getinfo( $handle, \CURLINFO_HTTP_CODE );
		$err                  = \curl_error( $handle );
		$this->last_http_code = $http_code > 0 ? $http_code : null;

		if ( \CURLE_OK !== $result ) {
			$this->last_error = "cURL error {$result}: {$err}";
		} elseif ( 200 !== $http_code && 0 !== $http_code ) {
			$this->last_error = "HTTP {$http_code}";
		} else {
			$this->last_error = 'Connection closed by server';
		}

		$this->print_less_often( 'ERROR: disconnected - ' . $this->last_error );
		$this->set_state( 'DISCONNECTED', $this->last_error );
		$this->detach_handle();
		$this->increase_backoff();
	}

	// =========================================================================
	// SSE parsing
	// =========================================================================

	/**
	 * Parse a chunk of SSE bytes off the buffer. Returns false on overflow.
	 * Public so patrons / tests can drive the parser without cURL.
	 *
	 * @api Dynamic entrypoint.
	 */
	public function process_sse_chunk( string $bytes ): bool {
		// Read boundary: every wire byte consumed off the stream (framing + data +
		// heartbeat/connected events). The JS SSE_In can only count `msg` event DATA
		// (EventSource hides framing + non-msg events), so its bytes_read is smaller —
		// an inherent transport gap, not a parity bug.
		$this->bytes_read += \strlen( $bytes );
		$this->buffer     .= $bytes;

		if ( \strlen( $this->buffer ) > self::MAX_BUFFER_SIZE ) {
			$this->last_error = 'Buffer overflow (no newline in ' . self::MAX_BUFFER_SIZE . ' bytes)';
			$this->buffer     = '';
			$this->connected  = false;
			$this->set_state( 'ERROR', $this->last_error );
			$this->print_less_often( 'ERROR: ' . $this->last_error );
			return false;
		}

		while ( false !== ( $newline_pos = \strpos( $this->buffer, "\n" ) ) ) {
			$line         = \substr( $this->buffer, 0, $newline_pos );
			$this->buffer = \substr( $this->buffer, $newline_pos + 1 );
			$line         = \rtrim( $line, "\r" );
			if ( ! $this->parse_sse_line( $line ) ) {
				return false;
			}
		}
		return true;
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
			case 'data':
				$this->current_event['data'] .= $value;
				if ( \strlen( $this->current_event['data'] ) > self::MAX_EVENT_SIZE ) {
					$this->last_error    = 'Event data overflow (' . self::MAX_EVENT_SIZE . ' bytes)';
					$this->current_event = [ 'event' => '', 'data' => '' ];
					$this->connected     = false;
					$this->set_state( 'ERROR', $this->last_error );
					$this->print_less_often( 'ERROR: ' . $this->last_error );
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
		$this->last_event_time = Core::$now ?: \microtime( true );

		// Heartbeats prove liveness only — record receipt and return BEFORE unpack (not routed).
		if ( 'heartbeat' === $type ) {
			$this->last_sse_heartbeat = (int) ( Core::$now ?: \microtime( true ) );
			return true;
		}

		try {
			$message = Message::unpacked( $raw_data );
		} catch ( \InvalidArgumentException $e ) {
			// A torn frame won't unpack — quarantine the raw bytes via the patron's DLQ, keep draining.
			if ( null !== $this->on_poison ) {
				( $this->on_poison )( $raw_data );
			}
			$this->last_error = 'unparseable SSE frame';
			$this->print_less_often( 'ERROR: ' . $this->last_error );
			return true;
		}

		// `/messages/stream` data lines are `msg` events carrying a 7-field Message
		// (unpacked() guaranteed the shape above); any other event type is ignored.
		if ( 'msg' === $type ) {
			$this->largest_msg_sent = \max( $this->largest_msg_sent, \strlen( $raw_data ) );
			return $this->dispatch_message( $message );
		}

		return true;
	}

	/**
	 * Dispatch a parsed message (7-field array).
	 *
	 * The only message inspected is the substrate's bookkeeping `connected` frame
	 * (KEY = 'connected', VALUE = `{slot, ...}`), which feeds local slot/connection
	 * state and is NOT forwarded. Everything else is forwarded. Per-message resume
	 * position rides `ID = "segment:offset:length"` (the remote Consumer stamps it at emit).
	 *
	 * @param array<int,mixed> $message 7-field Message array.
	 * @return bool
	 */
	private function dispatch_message( array $message ): bool {
		$id_raw  = $message[ Message::ID ];
		$key_raw = $message[ Message::KEY ];
		$id      = Core::as_string( $id_raw );
		$key     = Core::as_string( $key_raw );
		$value   = $message[ Message::VALUE ];

		// Resume at the exclusive next-read offset+length: the remote stamped the on-disk
		// length in the breadcrumb, so this is the exact next-record boundary (the client
		// cannot derive it from the re-stamped wire bytes). Empty/non-breadcrumb ID = no-op.
		if ( '' !== $id ) {
			$parts = \explode( ':', $id );
			if ( 3 === \count( $parts ) && \ctype_digit( $parts[0] ) && \ctype_digit( $parts[1] ) && \ctype_digit( $parts[2] ) ) {
				$this->position = [
					'segment' => (int) $parts[0],
					'offset'     => (int) $parts[1] + (int) $parts[2],
				];
			}
		}

		// `connected` message is the substrate's bookkeeping handshake — capture
		// slot, mark connected, do NOT forward.
		if ( 'connected' === $key && \is_string( $value ) ) {
			$pairs             = \array_chunk( \explode( ' ', $value ), 2 );
			$info              = \array_column( $pairs, 1, 0 );
			$slot_raw          = $info['SLOT'] ?? null;
			$this->slot        = \is_scalar( $slot_raw ) ? (int) $slot_raw : null;
			$pid_raw           = $info['PID'] ?? null;
			$this->session_pid = \is_scalar( $pid_raw ) ? (int) $pid_raw : null;
			// A handshake with no PID is malformed — report it and DON'T mark
			// connected (mirrors the JS SseIn; the pivot reply-FROM needs the pid).
			if ( null === $this->session_pid ) {
				$this->last_error = 'connected envelope missing PID';
				$this->set_state( 'ERROR', $this->last_error );
				$this->print_less_often( 'ERROR: ' . $this->last_error );
				return true;
			}
			$this->connected   = true;
			$this->set_state( 'CONNECTED', $value );
			return true;
		}
		if ( 'connected' === $key ) {
			// Malformed handshake: `connected` key but a non-string VALUE (TM_INFO
			// values are strings). Don't forward it; report for visibility.
			$this->last_error = 'malformed connected envelope (non-string value)';
			$this->set_state( 'ERROR', $this->last_error );
			$this->print_less_often( 'ERROR: ' . $this->last_error );
			return true;
		}

		$this->forward( $message );
		return true;
	}

	/**
	 * Forward a parsed message to the sink with TO=target.
	 *
	 * @param array<int,mixed> $message 7-field Message array.
	 */
	private function forward( array $message ): void {
		if ( null === $this->sink ) {
			throw new \RuntimeException( 'SSE_In::forward requires a wired sink' );
		}

		if ( $this->target ) {
			$message[ Message::TO ] = Core::as_string( $this->target );
		}
		// Honor a false stamp (FROM over MAX_FROM_SIZE / empty name): DROP the message
		// rather than forward an unstamped one the downstream would then misroute. The
		// cursor breadcrumb already advanced, so one bad record can't wedge the stream.
		if ( ! $this->stamp_message( $message, $this->name ) ) {
			$this->print_less_often( 'dropping stream message: FROM exceeded MAX_FROM_SIZE' );
			return;
		}

		++$this->counter;
		$this->sink->fill( $message );
	}

	// =========================================================================
	// Stale check
	// =========================================================================

	/**
	 * Reconnect-on-stale check. Driven by the patron (no timer here).
	 *
	 * @api Dynamic entrypoint.
	 */
	public function check_stale(): void {
		if ( ! $this->connected || ! ( $this->handle instanceof \CurlHandle ) ) {
			return;
		}
		$now     = Core::$now ?: \microtime( true );
		$elapsed = $now - $this->last_event_time;
		if ( $elapsed <= self::HEARTBEAT_TIMEOUT ) {
			return;
		}
		$stale_seconds    = (int) $elapsed;
		$this->last_error = "Stale connection (no events for {$stale_seconds}s)";
		$this->print_less_often( "ERROR: reconnecting - stale ({$stale_seconds}s)" );
		$this->set_state( 'RECONNECTING', $this->last_error );

		$this->detach_handle();
		$this->increase_backoff();
	}

	private function increase_backoff(): void {
		$this->current_backoff = \min( self::MAX_BACKOFF, \max( self::INITIAL_BACKOFF, $this->current_backoff * 2 ) );
	}

	/**
	 * Teardown: disconnect, then unregister from the Event_Framework + close the
	 * multi. Unregister BEFORE closing (mirrors HTTP_Out_Node::remove_node).
	 *
	 * @api Dynamic entrypoint.
	 */
	public function remove_node(): void {
		$this->disconnect();
		$multi = $this->multi;
		if ( null !== $multi ) {
			Event_Framework::instance()->unregister_curl_handle( $this );
			@\curl_multi_close( $multi );
			$this->multi = null;
		}
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
	 * Detach the active handle from the multi + close it. Idempotent.
	 * Order matters: curl_multi_remove_handle() MUST run before curl_close().
	 */
	private function detach_handle(): void {
		if ( ! ( $this->handle instanceof \CurlHandle ) ) {
			return;
		}
		if ( null !== $this->multi ) {
			@\curl_multi_remove_handle( $this->multi, $this->handle );
		}
		@\curl_close( $this->handle );
		$this->handle    = null;
		$this->connected = false;
	}

	/**
	 * Programmatic configuration entry point for the patron. Sets every field
	 * directly. `$subscribe` is the full `<remote_topic>.p<partition>` string.
	 * `$source` is currently unused — reserved (the _source provenance stamping it
	 * once fed was dropped in the SSE rework); kept positional for call-site stability.
	 *
	 * @param string             $url           Base URL (no trailing slash).
	 * @param string             $auth_username Application-Password user (Basic auth).
	 * @param string             $auth_password Application-Password secret.
	 * @param string             $auth_token    Optional Bearer token fallback.
	 * @param string             $subscribe     Subscription name (`<topic>.p<N>`).
	 * @param array{segment?:int,offset?:int} $positions Initial cursor.
	 * @param string             $source        Unused/reserved (formerly the _source server id).
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
		string $source        = '',
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
	}

	/**
	 * Restore last-committed position. Called by the patron before `maybe_connect()`.
	 *
	 * @api Dynamic entrypoint.
	 */
	public function restore_position( int $segment, int $offset ): void {
		$this->position = [
			'segment' => \max( 0, $segment ),
			'offset'     => \max( 0, $offset ),
		];
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
	 * Session pid captured from the `connected` handshake. Null until connected.
	 * Remote_IPC stamps it into the reply-FROM pivot (`_sse:{pid}/{node}`).
	 *
	 * @api Dynamic entrypoint.
	 */
	public function pid(): ?int {
		return $this->session_pid;
	}

	/**
	 * Connection-state snapshot for the patron.
	 *
	 * @api Dynamic entrypoint.
	 * @return array{connected:bool,last_http_code:?int,last_error:?string,current_backoff:int,last_sse_heartbeat:?int,last_attempt:?int}
	 */
	public function connection(): array {
		return [
			'connected'          => $this->connected,
			'last_http_code'     => $this->last_http_code,
			'last_error'         => $this->last_error,
			'current_backoff'    => $this->current_backoff,
			'last_sse_heartbeat' => $this->last_sse_heartbeat,
			'last_attempt'       => $this->last_attempt > 0.0 ? (int) $this->last_attempt : null,
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
