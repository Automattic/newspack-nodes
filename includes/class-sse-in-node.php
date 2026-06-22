<?php
/**
 * SSE_In: generic inbound SSE pull. A passive, hidden, programmatically-configured
 * source node — the substrate counterpart of the old ELN Remote_Source SSE
 * internals, minus the durable/aggregator concerns.
 *
 * It owns one cURL multi handle (registered with the Event_Framework), one easy
 * handle (the SSE GET), one in-memory `{segment_id, offset}` cursor, and one SSE
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

	public const MAX_BUFFER_SIZE = 10485760; // 10MB
	public const MAX_EVENT_SIZE  = 10485760; // 10MB

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

	private bool $verify_ssl    = true;
	private bool $require_https  = false;

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
	/** @var array{segment_id:int, offset:int} Read cursor. */
	private array $position        = [ 'segment_id' => 0, 'offset' => 0 ];
	private float $last_event_time = 0.0;
	private int   $current_backoff = self::INITIAL_BACKOFF;
	private float $last_attempt    = 0.0;
	private bool  $connected       = false;
	private ?string $last_error    = null;
	private ?int  $last_http_code  = null;
	private ?int  $last_sse_heartbeat = null;

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
	public function fill( array &$message ): void {
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

		if ( $this->require_https && \stripos( $this->url, 'https://' ) !== 0 ) {
			$this->last_error = 'refusing non-HTTPS URL';
			$this->print_less_often( "non-HTTPS URL refused: {$this->url}" );
			$this->increase_backoff();
			return false;
		}

		$multi = $this->ensure_multi();

		$endpoint = $this->url . '/wp-json/newspack-nodes/v1/messages/stream';
		$params   = [
			'subscribe' => $this->subscribe,
		];
		if ( $this->position['segment_id'] > 0 || $this->position['offset'] > 0 ) {
			// Substrate's parse_positions expects a JSON-encoded object keyed by
			// subscription topic → partition index → `{seg, off}`. `$subscribe` is
			// `<topic>.p<N>`; split it back into the topic + partition the wire
			// expects (only one entry — one connection per subscription).
			[ $topic, $partition ] = $this->split_subscribe();
			$params['positions']   = (string) \wp_json_encode(
				[
					$topic => [
						$partition => [
							'seg' => $this->position['segment_id'],
							'off' => $this->position['offset'],
						],
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
			\CURLOPT_PROTOCOLS      => $this->require_https ? \CURLPROTO_HTTPS : ( \CURLPROTO_HTTPS | \CURLPROTO_HTTP ),
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
			return false;
		}

		// Reset per-connection state.
		$this->buffer          = '';
		$this->current_event   = [ 'event' => '', 'data' => '' ];
		$this->last_event_time = $now;
		$this->connected          = true;
		$this->last_error         = null;
		$this->last_http_code     = null;
		$this->last_sse_heartbeat = null;
		$this->handle             = $ch;
		$this->last_attempt    = $now;
		$this->slot            = null;
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

	/**
	 * Split `<topic>.p<N>` into [topic, partition-index].
	 *
	 * @return array{0:string,1:int}
	 */
	private function split_subscribe(): array {
		if ( 1 === \preg_match( '/^(.*)\.p(\d+)$/', $this->subscribe, $m ) ) {
			return [ $m[1], (int) $m[2] ];
		}
		return [ $this->subscribe, 0 ];
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
		$len = \strlen( $bytes );
		if ( 0 === $len ) {
			return 0;
		}
		if ( null === $this->last_http_code ) {
			$code                 = \curl_getinfo( $handle, \CURLINFO_HTTP_CODE );
			$this->last_http_code = $code > 0 ? $code : null;
			if ( 200 === $this->last_http_code ) {
				$this->last_error = null;
			}
		}
		return $this->process_sse_chunk( $bytes ) ? $len : 0;
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
			$this->print_less_often( "disconnected: {$this->last_error}" );
		} elseif ( 200 !== $http_code && 0 !== $http_code ) {
			$this->last_error = "HTTP {$http_code}";
			$this->print_less_often( "HTTP {$http_code}" );
		} else {
			$this->last_error = 'Connection closed by server';
		}

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
		$this->buffer .= $bytes;

		if ( \strlen( $this->buffer ) > self::MAX_BUFFER_SIZE ) {
			$this->last_error = 'Buffer overflow (no newline in ' . self::MAX_BUFFER_SIZE . ' bytes)';
			$this->buffer     = '';
			$this->connected  = false;
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
				if ( '' !== $this->current_event['data'] ) {
					$this->current_event['data'] .= "\n";
				}
				$this->current_event['data'] .= $value;
				if ( \strlen( $this->current_event['data'] ) > self::MAX_EVENT_SIZE ) {
					$this->last_error    = 'Event data overflow (' . self::MAX_EVENT_SIZE . ' bytes)';
					$this->current_event = [ 'event' => '', 'data' => '' ];
					$this->connected     = false;
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

		$message = \json_decode( $raw_data, true, 16 );

		// The remote's messages-stream emits periodic `heartbeat` events when a
		// stream is idle-but-live. Record the receipt (not forwarded).
		if ( 'heartbeat' === $type ) {
			$this->last_event_time    = Core::$now ?: \microtime( true );
			$this->last_sse_heartbeat = (int) Core::$now;
			return true;
		}

		// `/messages/stream` data lines are `msg` events carrying a 7-field
		// Message; any other event type is silently ignored.
		if ( 'msg' === $type && \is_array( $message ) && \count( $message ) === 7 ) {
			return $this->dispatch_message( \array_values( $message ) );
		}

		return true;
	}

	/**
	 * Dispatch a parsed message (7-field array).
	 *
	 * The only message inspected is the substrate's bookkeeping `connected` frame
	 * (KEY = 'connected', VALUE = `{slot, ...}`), which feeds local slot/connection
	 * state and is NOT forwarded. Everything else is forwarded. Per-message
	 * position rides `ID = "seg:off"` (Consumer stamps at emit).
	 *
	 * @param array<int,mixed> $message 7-field Message array.
	 */
	private function dispatch_message( array $message ): bool {
		$id_raw  = $message[ Message::ID ];
		$key_raw = $message[ Message::KEY ];
		$id      = \is_scalar( $id_raw ) ? (string) $id_raw : '';
		$key     = \is_scalar( $key_raw ) ? (string) $key_raw : '';
		$value   = $message[ Message::VALUE ];

		// Position from message ID — `{segment_id}:{offset}` shape. Empty ID
		// (e.g. the connected message) is a no-op. The ctype check is defensive:
		// `(int)` on a non-numeric string silently returns 0, resetting the cursor.
		if ( '' !== $id ) {
			$colon = \strpos( $id, ':' );
			if ( false !== $colon ) {
				$seg_str = \substr( $id, 0, $colon );
				$off_str = \substr( $id, $colon + 1 );
				if ( \ctype_digit( $seg_str ) && \ctype_digit( $off_str ) ) {
					$this->position = [
						'segment_id' => (int) $seg_str,
						'offset'     => (int) $off_str,
					];
				}
			}
		}

		// `connected` message is the substrate's bookkeeping handshake — capture
		// slot, mark connected, do NOT forward.
		if ( 'connected' === $key && \is_array( $value ) && isset( $value['slot'] ) ) {
			$slot_raw        = $value['slot'];
			$this->slot      = \is_scalar( $slot_raw ) ? (int) $slot_raw : 0;
			$pid_raw         = $value['pid'] ?? null;
			$this->session_pid = \is_scalar( $pid_raw ) ? (int) $pid_raw : null;
			$this->connected = true;
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
			$message[ Message::TO ] = \is_string( $this->target ) ? $this->target : '';
		}
		$this->stamp_message( $message, $this->name );

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
		$this->print_less_often( "stale ({$stale_seconds}s) — reconnecting" );

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
	 * directly. `$subscribe` is the full `<remote_topic>.p<partition>` string;
	 * `$source` is the Vault server id stamped into forwarded VALUEs as `_source`.
	 *
	 * @param string             $url           Base URL (no trailing slash).
	 * @param string             $auth_username Application-Password user (Basic auth).
	 * @param string             $auth_password Application-Password secret.
	 * @param string             $auth_token    Optional Bearer token fallback.
	 * @param string             $subscribe     Subscription name (`<topic>.p<N>`).
	 * @param array{segment_id?:int,offset?:int} $positions Initial cursor.
	 * @param string             $source        Vault server id stamped as `_source`.
	 * @param bool               $verify_ssl    Verify the remote SSL cert.
	 * @param bool               $require_https Refuse non-HTTPS remote URLs.
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
		bool $require_https   = false
	): void {
		$this->url           = \rtrim( $url, '/' );
		$this->auth_username = $auth_username;
		$this->auth_password = $auth_password;
		$this->auth_token    = $auth_token;
		$this->subscribe     = $subscribe;
		$this->verify_ssl    = $verify_ssl;
		$this->require_https = $require_https;
		$this->position      = [
			'segment_id' => \max( 0, $positions['segment_id'] ?? 0 ),
			'offset'     => \max( 0, $positions['offset'] ?? 0 ),
		];
	}

	/**
	 * Restore last-committed position. Called by the patron before `maybe_connect()`.
	 *
	 * @api Dynamic entrypoint.
	 */
	public function restore_position( int $segment_id, int $offset ): void {
		$this->position = [
			'segment_id' => \max( 0, $segment_id ),
			'offset'     => \max( 0, $offset ),
		];
	}

	/**
	 * Current in-memory cursor.
	 *
	 * @api Dynamic entrypoint.
	 * @return array{segment_id:int,offset:int}
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
	 * @return array{connected:bool,last_http_code:?int,last_error:?string,current_backoff:int,last_sse_heartbeat:?int}
	 */
	public function connection(): array {
		return [
			'connected'          => $this->connected,
			'last_http_code'     => $this->last_http_code,
			'last_error'         => $this->last_error,
			'current_backoff'    => $this->current_backoff,
			'last_sse_heartbeat' => $this->last_sse_heartbeat,
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
