<?php
/**
 * HTTP_Out: non-blocking outbound command egress. The push-side counterpart of
 * HTTP_In. fill() buffers each message as a packed TM_COMMAND envelope and arms a
 * one-shot timer; on the next drain tick fire() POSTs the whole batch as a single
 * JSONL body to a remote spoke's /command on the Event_Framework's cURL-multi
 * (neither fill() nor fire() blocks). on_curl_message() forwards each reply Message
 * in the 200 body to $this->sink — replies self-route by TO=FROM through
 * _command_interpreter → _router (modeled on src/runtime/http-out-node.js).
 *
 * Batching one POST per tick (not per fill) lets settings-sync emit N per-setting
 * commands on one timer tick and have them ride to the spoke in a single request.
 *
 * Credentials resolve from the Vault by server id; Basic Auth (or legacy Bearer
 * token). Never takes a raw URL/credential.
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes;

\defined( 'ABSPATH' ) || exit;

class HTTP_Out_Node extends Timer_Node {
	use Schema_Reflection;

	/** Outbound request timeout (seconds). */
	public const REQUEST_TIMEOUT = 15;

	/** Spoke /command endpoint path appended to the Vault url. */
	private const COMMAND_PATH = '/wp-json/newspack-nodes/v1/command';

	/**
	 * libcurl dispatch seam. Lazily-defaulted to a closure that creates the easy
	 * handle, applies $opts via curl_setopt_array, and adds it to the multi.
	 * Tests reassign to capture $opts without transferring — so the envelope-build,
	 * auth-header assembly, and SSL/timeout opts run as real production code.
	 *
	 * Signature: `function ( \CurlMultiHandle $multi, array $opts ): \CurlHandle|false`.
	 *
	 * @var \Closure|null
	 */
	public static ?\Closure $curl_dispatch = null;

	/**
	 * libcurl result-read seam. Lazily-defaulted to a closure returning the easy
	 * handle's HTTP code + response body. Tests reassign to inject a synthetic
	 * result so the classification + JSONL-unpack + reply-forwarding run as real
	 * production code without a network transfer.
	 *
	 * Signature: `function ( \CurlHandle $easy ): array{ code:int, body:string }`.
	 *
	 * @var \Closure|null
	 */
	public static ?\Closure $curl_result = null;

	/** Vault server id whose url + credentials this node POSTs to. */
	protected string $server_id = '';

	/** @var \CurlMultiHandle|null Owned multi handle; created + registered lazily on first fill(). */
	protected ?\CurlMultiHandle $multi = null;

	/** @var array<int,array{handle:\CurlHandle,server_id:string,url:string}> Easy-handle id → context for completion attribution. Holds the handle so it isn't GC'd (a freed handle's spl_object_id is reused, colliding keys). */
	protected array $inflight = [];

	/** @var array<int,array<int,mixed>> Packed TM_COMMAND envelopes buffered between fill() and the next fire(). */
	protected array $batch = [];

	/** Whether the one-shot flush timer is already armed; gates re-arming without coupling to Timer_Node internals. */
	protected bool $batch_timer_armed = false;

	/** Tachikoma-parity: no-arg ctor. Positional config arrives via arguments(); no I/O here (ADR-5). */
	public function __construct() {
		parent::__construct();
	}

	/** Assign server_id from the positional token via the schema; gated on a non-empty string. */
	public function arguments( ?string $args = null ): string {
		if ( null === $args ) {
			return parent::arguments();
		}
		$this->parse_schema_args( $args );
		return $args;
	}

	/**
	 * Buffer the incoming message as a packed TM_COMMAND envelope and arm a one-shot
	 * flush timer; the actual POST happens on the next drain tick in fire(). Never
	 * blocks and never resolves the Vault (fire() does that once per batch).
	 *
	 * @param array<int, mixed> $message The 7-field positional message array.
	 */
	public function fill( array &$message ): void {
		++$this->counter;

		// Preserve the caller's FROM (a heartbeat minted with FROM=<remote-source>
		// keeps it so the spoke's reply can route back); fall back to _http only
		// when the caller left FROM empty (settings-sync's fire-and-forget path).
		$from = Core::as_string( $message[ Message::FROM ] );

		$envelope                   = Message::new_message();
		$envelope[ Message::TYPE ]  = Message::TM_COMMAND;
		$envelope[ Message::FROM ]  = '' !== $from ? $from : Node_Names::HTTP;
		$envelope[ Message::TO ]    = Core::as_string( $message[ Message::TO ] );
		$envelope[ Message::VALUE ] = $message[ Message::VALUE ];
		$this->batch[]              = $envelope;

		if ( ! $this->batch_timer_armed ) {
			$this->set_timer( 0, true );
			$this->batch_timer_armed = true;
		}
	}

	/**
	 * One-shot flush: resolve the spoke from the Vault once, join the buffered
	 * envelopes into one JSONL body, assemble auth + SSL opts, and enqueue a single
	 * POST on the owned multi via the dispatch seam. Non-blocking: the transfer is
	 * driven by the Event_Framework drain, never here.
	 *
	 * Public (widens Timer_Node's protected fire()) so the EF can invoke the flush
	 * directly and tests can drive one tick without a live event loop.
	 */
	public function fire(): void {
		$batch                   = $this->batch;
		$this->batch             = [];
		$this->batch_timer_armed = false;
		if ( [] === $batch ) {
			return;
		}

		$server = Vault::get_instance()->get( $this->server_id );
		$url    = \is_array( $server ) ? \rtrim( Core::as_string( $server['url'] ?? '' ), '/' ) : '';
		if ( '' === $url ) {
			$dropped = \count( $batch );
			$this->print_less_often( "no Vault entry / url; dropping {$dropped} message(s)" );
			return;
		}

		$cfg = Config::load_config();
		// Refuse a plaintext spoke when the operator requires HTTPS (mirrors the
		// legacy heartbeat HTTPS guard): drop the batch, no POST.
		if ( ( $cfg['vault_require_https'] ?? false ) && ! \str_starts_with( $url, 'https://' ) ) {
			$dropped = \count( $batch );
			$this->print_less_often( "vault_require_https set but url is not https; dropping {$dropped} message(s)" );
			return;
		}

		$body = '';
		foreach ( $batch as $envelope ) {
			$packed                  = Message::packed( $envelope );
			$size                    = \strlen( $packed );
			$this->bytes_written    += $size;
			$this->largest_msg_sent  = \max( $this->largest_msg_sent, $size );
			$body                   .= $packed . "\n";
		}

		$headers = [ 'Content-Type: text/plain; charset=UTF-8' ];
		$user    = Core::as_string( $server['auth_username'] ?? '' );
		$pass    = Core::as_string( $server['auth_password'] ?? '' );
		$token   = Core::as_string( $server['token'] ?? '' );
		if ( '' !== $user && '' !== $pass ) {
			// phpcs:ignore WordPress.PHP.DiscouragedPHPFunctions.obfuscation_base64_encode -- HTTP Basic Auth.
			$headers[] = 'Authorization: Basic ' . \base64_encode( $user . ':' . $pass );
		} elseif ( '' !== $token ) {
			$headers[] = 'Authorization: Bearer ' . $token;
		}

		// Mirror Vault_CI_Node::probe_remote: verify on unless explicitly disabled.
		$verify = ! isset( $cfg['vault_verify_ssl'] ) || (bool) $cfg['vault_verify_ssl'];
		$opts   = [
			\CURLOPT_URL            => $url . self::COMMAND_PATH,
			\CURLOPT_POST           => true,
			\CURLOPT_POSTFIELDS     => $body,
			\CURLOPT_HTTPHEADER     => $headers,
			\CURLOPT_RETURNTRANSFER => true,
			\CURLOPT_TIMEOUT        => self::REQUEST_TIMEOUT,
			\CURLOPT_SSL_VERIFYPEER => $verify,
			\CURLOPT_SSL_VERIFYHOST => $verify ? 2 : 0,
		];

		$multi    = $this->ensure_multi();
		$dispatch = self::$curl_dispatch ?? static function ( \CurlMultiHandle $m, array $o ): \CurlHandle|false {
			// phpcs:disable WordPress.WP.AlternativeFunctions.curl_curl_init, WordPress.WP.AlternativeFunctions.curl_curl_setopt_array, WordPress.WP.AlternativeFunctions.curl_curl_multi_add_handle
			$ch = \curl_init();
			if ( false === $ch ) {
				return false;
			}
			\curl_setopt_array( $ch, $o );
			\curl_multi_add_handle( $m, $ch );
			return $ch;
			// phpcs:enable
		};

		$easy = $dispatch( $multi, $opts );
		if ( ! $easy instanceof \CurlHandle ) {
			$this->print_less_often( "curl_init failed" );
			return;
		}
		// Keep the handle alive in $inflight: a freed handle's spl_object_id is
		// reused, so dropping it would collide the next enqueue's key.
		$this->inflight[ \spl_object_id( $easy ) ] = [
			'handle'    => $easy,
			'server_id' => $this->server_id,
			'url'       => $url,
		];
	}

	/** Owned multi handle, registered with the Event_Framework. Idempotent (mirrors Remote_Source::ensure_multi). */
	protected function ensure_multi(): \CurlMultiHandle {
		if ( null !== $this->multi ) {
			return $this->multi;
		}
		// phpcs:ignore WordPress.WP.AlternativeFunctions.curl_curl_multi_init
		$multi       = \curl_multi_init();
		$this->multi = $multi;
		Event_Framework::instance()->register_curl_handle( $this, $multi );
		return $multi;
	}

	/**
	 * Event_Framework completion callback (drain_curl_multi → CURLMSG_DONE).
	 * Forwards each reply Message in a 200 body to the sink (each self-routes by
	 * TO=FROM through _command_interpreter → _router; ports src/runtime/http-out-node.js
	 * _post), rate-limits non-200 / transport errors, and always detaches the handle.
	 * @api Used by substrate.
	 *
	 * @param array{msg?:int, handle?:\CurlHandle, result?:int} $info
	 */
	public function on_curl_message( array $info ): void {
		if ( \CURLMSG_DONE !== ( $info['msg'] ?? 0 ) ) {
			return;
		}
		$easy = $info['handle'] ?? null;
		if ( ! ( $easy instanceof \CurlHandle ) ) {
			return;
		}

		$id        = \spl_object_id( $easy );
		$server_id = $this->inflight[ $id ]['server_id'] ?? $this->server_id;

		$result = $info['result'] ?? \CURLE_OK;
		if ( \CURLE_OK !== $result ) {
			$this->print_less_often( "transport error {$result}" );
		} else {
			$res = $this->read_result( $easy );
			if ( 200 !== $res['code'] ) {
				if ( 202 !== $res['code'] ) {
					$this->print_less_often( "HTTP {$res['code']}" );
				}
			} elseif ( null !== $this->sink && '' !== $res['body'] ) {
				foreach ( \explode( "\n", $res['body'] ) as $line ) {
					if ( '' === $line ) {
						continue;
					}
					// Message::unpacked() throws on a non-positional line; skip it
					// rate-limited rather than aborting the rest of the batch.
					try {
						$reply = Message::unpacked( $line );
					} catch ( \InvalidArgumentException $e ) {
						$this->print_less_often( "malformed reply line" );
						continue;
					}
					// The spoke's HTTP_In prepends _output/ to the FROM it echoes;
					// a worker graph has no _output, so strip it so TO=<remote-source>
					// routes correctly through _command_interpreter → _router.
					$to = Core::as_string( $reply[ Message::TO ] );
					if ( \str_starts_with( $to, '_output/' ) ) {
						$reply[ Message::TO ] = \substr( $to, \strlen( '_output/' ) );
					}
					++$this->counter;
					$this->sink?->fill( $reply );
				}
			}
		}

		$this->detach( $easy );
		unset( $this->inflight[ $id ] );
	}

	/**
	 * Read a completed handle's HTTP code + body. Routes through the $curl_result
	 * seam when set (tests inject a synthetic result); otherwise reads libcurl
	 * directly. The typed return narrows the seam's mixed result at this boundary.
	 *
	 * @return array{code:int, body:string}
	 */
	private function read_result( \CurlHandle $easy ): array {
		$seam = self::$curl_result;
		if ( null !== $seam ) {
			$res  = $seam( $easy );
			$code = \is_array( $res ) && isset( $res['code'] ) && \is_int( $res['code'] ) ? $res['code'] : 0;
			$body = \is_array( $res ) && isset( $res['body'] ) && \is_string( $res['body'] ) ? $res['body'] : '';
			return [
				'code' => $code,
				'body' => $body,
			];
		}
		// phpcs:disable WordPress.WP.AlternativeFunctions.curl_curl_getinfo, WordPress.WP.AlternativeFunctions.curl_curl_multi_getcontent
		return [
			'code' => \curl_getinfo( $easy, \CURLINFO_HTTP_CODE ),
			'body' => (string) \curl_multi_getcontent( $easy ),
		];
		// phpcs:enable
	}

	/**
	 * Teardown: detach every in-flight easy handle (removed from the multi before
	 * it closes), then unregister from the Event_Framework and close the multi.
	 * Unregister BEFORE closing the multi (mirrors Remote_Source_Node::remove_node).
	 * @api Used by substrate.
	 */
	public function remove_node(): void {
		$this->batch = [];
		foreach ( $this->inflight as $id => $context ) {
			$this->detach( $context['handle'] );
			unset( $this->inflight[ $id ] );
		}
		$multi = $this->multi;
		if ( null !== $multi ) {
			Event_Framework::instance()->unregister_curl_handle( $this );
			// phpcs:disable WordPress.WP.AlternativeFunctions.curl_curl_multi_close
			@\curl_multi_close( $multi );
			// phpcs:enable
			$this->multi = null;
		}
		parent::remove_node();
	}

	/** Remove an easy handle from the multi + close it. Idempotent (order: remove before close). */
	protected function detach( \CurlHandle $easy ): void {
		// phpcs:disable WordPress.WP.AlternativeFunctions.curl_curl_multi_remove_handle, WordPress.WP.AlternativeFunctions.curl_curl_close
		if ( null !== $this->multi ) {
			@\curl_multi_remove_handle( $this->multi, $easy );
		}
		@\curl_close( $easy );
		// phpcs:enable
	}

	/** @api Resolved by make_node; consumed by topology wiring + later slices. */
	public static function node_schema(): array {
		return [
			'category'    => 'I/O',
			'description' => 'Outbound: POSTs each message as a TM_COMMAND to a remote spoke /command (non-blocking).',
			'has_target'  => false,
			'arguments'   => [
				[ 'name' => 'server_id', 'type' => 'string', 'required' => true ],
			],
			'commands'    => [],
			'requests'    => [],
		];
	}
}
