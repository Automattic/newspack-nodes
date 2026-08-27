<?php
/**
 * HTTP_Out: non-blocking outbound command egress. The push-side counterpart of
 * HTTP_In. fill() buffers each message verbatim (all 7 fields cross) and arms a
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
 * CLASS API (request scope, blocking). `probe_command()` is the same protocol
 * over one synchronous request, for an operator action that must return a
 * verdict now — Vault_CI `test`, Aggregator_CI `probe`. Same idiom as
 * `Topic_Node`/`Partition_Node`: the Node owns its domain and exposes a
 * request-scope entry point beside the event-loop one.
 *
 * This lived in `Service_CI_Node` — the abstract verb-table base — where ten of
 * the twelve service interpreters inherited a spoke HTTP client they never
 * call, along with a publicly reassignable `$http_call` on the base of every
 * one of them. It was also a SECOND copy of this protocol, already drifted: it
 * never learned the Bearer token this side accepts, so a token-only spoke was
 * reachable by the graph and unreachable by the operator's own connectivity
 * check. One owner, two transports.
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes;

\defined( 'ABSPATH' ) || exit;

class HTTP_Out_Node extends Timer_Node {
	use Schema_Reflection;

	/** Outbound request timeout (seconds). */
	public const REQUEST_TIMEOUT = 15;

	/** Cap on a spoke's reply body; it is buffered into the PHP heap. */
	public const MAX_REPLY_BYTES = 8388608;

	/** Spoke endpoints appended to the Vault url. */
	public const COMMAND_PATH = '/wp-json/newspack-nodes/v1/command';
	public const AUTH_PATH    = '/wp-json/newspack-nodes/v1/auth';

	/**
	 * `wp_remote_post` seam for the BLOCKING class API. Lazily defaulted at the
	 * call site (a Closure can't be a constant-expression property default).
	 * Tests reassign to capture outbound args + inject canned responses without
	 * short-circuiting the URL composition and response classification around
	 * it, so that path runs as real production code under test.
	 *
	 * Signature: `function ( string $url, array $args ): array|\WP_Error`.
	 *
	 * @var \Closure(string, array<string,mixed>): (array<string,mixed>|\WP_Error)|null
	 */
	public static ?\Closure $http_call = null;

	/**
	 * libcurl dispatch seam. Lazily-defaulted to a closure that creates the easy
	 * handle and applies $opts via curl_setopt_array (the Event_Framework owns the
	 * shared multi + the add). Tests reassign to capture $opts without transferring —
	 * so the envelope-build, auth-header assembly, and SSL/timeout opts run as real
	 * production code.
	 *
	 * Signature: `function ( array $opts ): \CurlHandle|false`.
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

	/** @var array<int,array<int,mixed>> Packed messages buffered between fill() and the next fire(). */
	protected array $batch = [];

	/** Whether the one-shot flush timer is already armed; gates re-arming without coupling to Timer_Node internals. */
	protected bool $batch_timer_armed = false;

	/** @var array<int,array{handle:\CurlHandle,vault_id:string,url:string,kind:string}> Easy-handle id → context for completion attribution. Holds the handle so it isn't GC'd (a freed handle's spl_object_id is reused, colliding keys). */
	protected array $inflight = [];

	/** Vault id whose url + credentials this node POSTs to. */
	protected string $vault_id = '';

	/** One handshake at a time; a held batch must not fan out N /auth POSTs. */
	protected bool $auth_in_flight = false;

	/**
	 * Reply bodies accumulated by the write callback, keyed by easy-handle id.
	 *
	 * Cleared wherever the handle is dropped, never where the body is read: a
	 * transport error never reads one, and a buffer outliving its handle is
	 * appended to by whichever new handle inherits that reused id.
	 *
	 * @var array<int,string>
	 */
	private static array $bodies = [];

	/** Tachikoma-parity: no-arg ctor. Positional config arrives via arguments(); no I/O here (ADR-5). */
	public function __construct() {
		parent::__construct();
	}

	/** Assign vault_id from the positional token via the schema; gated on a non-empty string. */
	public function arguments( ?array $args = null ): array {
		if ( null === $args ) {
			return parent::arguments();
		}
		$this->parse_schema_args( $args );
		return $args;
	}

	/**
	 * Buffer the incoming message and arm a one-shot flush timer; the actual
	 * POST happens on the next drain tick in fire(). Never blocks and never
	 * resolves the Vault (fire() does that once per batch).
	 *
	 * @param array<int,mixed> $message The 7-field positional message array.
	 */
	public function fill( array $message ): void {
		++$this->counter;
		$this->batch[] = $message;

		if ( ! $this->batch_timer_armed ) {
			$this->set_timer( 0, true );
			$this->batch_timer_armed = true;
		}
	}

	/**
	 * One-shot flush: resolve the spoke from the Vault once, join the buffered
	 * envelopes into one JSONL body, assemble auth + SSL opts, and enqueue a single
	 * POST on the shared multi via the dispatch seam. Non-blocking: the transfer is
	 * driven by the Event_Framework drain, never here.
	 *
	 * Public (widens Timer_Node's protected fire()) so the EF can invoke the flush
	 * directly and tests can drive one tick without a live event loop.
	 */
	public function fire(): void {
		$batch                   = $this->batch;
		$this->batch             = [];
		$this->batch_timer_armed = false;
		$established             = Command_Auth::has_session( $this->vault_id );
		// No session: handshake now, or waiting for traffic deadlocks.
		if ( [] === $batch && $established ) {
			return;
		}

		$server = Vault::get_instance()->get( $this->vault_id );
		$url    = \is_array( $server ) ? \rtrim( Core::as_string( $server['url'] ?? '' ), '/' ) : '';
		if ( '' === $url ) {
			$this->drop_batch( $batch, 'no Vault entry / url' );
			return;
		}

		// Refuse plaintext spoke when operator requires HTTPS; drop batch.
		if ( self::https_required( $url ) ) {
			$this->drop_batch( $batch, 'vault_require_ssl set but url is not https' );
			return;
		}

		// Held, not dropped: no session means a minter cannot sign for it.
		if ( ! \is_array( $server ) ) {
			return;
		}
		if ( ! $established ) {
			$this->batch = \array_merge( $batch, $this->batch );
			$this->request_session( $server, $url );
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

		$this->send( $server, $url . self::COMMAND_PATH, $body, 'command' );
	}

	/**
	 * Report a batch we could not deliver. Silent on an empty one: a session-less
	 * tick reaches this path with nothing queued and has nothing to report.
	 *
	 * @param array<int,array<int,mixed>> $batch  The undelivered envelopes.
	 * @param string                        $reason Why they could not be sent.
	 */
	private function drop_batch( array $batch, string $reason ): void {
		if ( [] === $batch ) {
			return;
		}
		$this->print_less_often( $reason, '; dropping ', (string) \count( $batch ), ' message(s)' );
	}

	/**
	 * Establish the command session with this spoke. HTTP_Out runs the handshake
	 * because it already holds the credentials and the multi registration; the
	 * minters that will sign for the spoke have neither. It never signs itself.
	 *
	 * @param array<string,mixed> $server Decrypted vault entry.
	 */
	private function request_session( array $server, string $url ): void {
		if ( $this->auth_in_flight ) {
			return;
		}
		$this->auth_in_flight = true;
		$this->send( $server, $url . self::AUTH_PATH, '', 'auth' );
	}

	/**
	 * Assemble the opts, dispatch on the shared multi, and record the handle under
	 * its kind so the completion callback knows what it is answering.
	 *
	 * @param array<string,mixed> $server Decrypted vault entry.
	 */
	private function send( array $server, string $endpoint, string $body, string $kind ): void {
		$headers       = [ 'Content-Type: text/plain; charset=UTF-8' ];
		$authorization = self::authorization( $server );
		if ( '' !== $authorization ) {
			$headers[] = 'Authorization: ' . $authorization;
		}

		$verify = self::verify_ssl();
		$opts   = [
			\CURLOPT_URL            => $endpoint,
			\CURLOPT_POST           => true,
			\CURLOPT_POSTFIELDS     => $body,
			\CURLOPT_HTTPHEADER     => $headers,
			\CURLOPT_RETURNTRANSFER => true,
			\CURLOPT_TIMEOUT        => self::REQUEST_TIMEOUT,
			\CURLOPT_SSL_VERIFYPEER => $verify,
			\CURLOPT_SSL_VERIFYHOST => $verify ? 2 : 0,
			// MAXFILESIZE needs a declared length; the callback does the work.
			\CURLOPT_MAXFILESIZE    => self::MAX_REPLY_BYTES,
			\CURLOPT_WRITEFUNCTION  => self::body_cap(),
		];

		$dispatch = self::$curl_dispatch ?? static function ( array $o ): \CurlHandle|false {
			// phpcs:disable WordPress.WP.AlternativeFunctions.curl_curl_init, WordPress.WP.AlternativeFunctions.curl_curl_setopt_array
			$ch = \curl_init();
			if ( false === $ch ) {
				return false;
			}
			\curl_setopt_array( $ch, $o );
			return $ch;
			// phpcs:enable
		};

		$easy = $dispatch( $opts );
		if ( ! $easy instanceof \CurlHandle ) {
			$this->print_less_often( "curl_init failed" );
			if ( 'auth' === $kind ) {
				$this->auth_in_flight = false;
			}
			return;
		}
		// Hold handle to avoid GC; freed ids get reused and collide keys.
		$this->inflight[ \spl_object_id( $easy ) ] = [
			'handle'   => $easy,
			'vault_id' => $this->vault_id,
			'url'      => $endpoint,
			'kind'     => $kind,
		];
		Event_Framework::instance()->register_curl_easy( $this, $easy );
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

		$id = \spl_object_id( $easy );

		$kind = Core::as_string( $this->inflight[ $id ]['kind'] ?? 'command' );

		$result = $info['result'] ?? \CURLE_OK;
		if ( \CURLE_OK !== $result ) {
			$this->print_less_often( 'transport error ', (string) $result );
			if ( 'auth' === $kind ) {
				$this->auth_in_flight = false;
			}
		} elseif ( 'auth' === $kind ) {
			$res = $this->read_result( $easy );
			$this->on_session_reply( $res['code'], $res['body'] );
		} else {
			$res = $this->read_result( $easy );
			if ( 200 !== $res['code'] ) {
				// 401: dead handle. Drop it or we re-sign with it forever.
				if ( 401 === $res['code'] ) {
					Command_Auth::forget_session( $this->vault_id );
				}
				if ( 202 !== $res['code'] ) {
					$this->print_less_often( 'HTTP ', (string) $res['code'] );
				}
			} elseif ( null !== $this->sink && '' !== $res['body'] ) {
				foreach ( \explode( "\n", $res['body'] ) as $line ) {
					if ( '' === $line ) {
						continue;
					}
					// unpacked() throws on a bad line; skip, keep batch.
					try {
						$reply = Message::unpacked( $line );
					} catch ( \InvalidArgumentException $e ) {
						$this->print_less_often( "malformed reply line" );
						continue;
					}
					// HTTP_In prepends _output/ to FROM; strip it.
					$to = Core::as_string( $reply[ Message::TO ] );
					if ( \str_starts_with( $to, '_output/' ) ) {
						$reply[ Message::TO ] = \substr( $to, \strlen( '_output/' ) );
					}
					++$this->counter;
					if ( $this->accept_inbound( $reply ) ) {
						$this->sink?->fill( $reply );
					}
				}
			}
		}

		$this->detach( $easy );
		unset( $this->inflight[ $id ], self::$bodies[ $id ] );
	}

	/**
	 * Adopt the session the spoke issued, then re-arm the held batch. A refusal
	 * only clears the in-flight flag: the batch stays put and the next fill or
	 * tick retries, since discarding traffic over a transient handshake failure
	 * is worse than waiting.
	 */
	private function on_session_reply( int $code, string $body ): void {
		$this->auth_in_flight = false;
		if ( 200 !== $code ) {
			$this->print_less_often( 'auth refused by spoke: HTTP ', (string) $code );
			return;
		}
		[ $handle, $key ] = self::session_from_body( $body );
		if ( '' === $handle || '' === $key ) {
			$this->print_less_often( 'spoke returned a malformed session' );
			return;
		}
		Command_Auth::remember_session( $this->vault_id, $handle, $key );
		if ( [] !== $this->batch && ! $this->batch_timer_armed ) {
			$this->set_timer( 0, true );
			$this->batch_timer_armed = true;
		}
	}

	/**
	 * Wire-inbound discipline, following Tachikoma Socket.pm:852-862.
	 *
	 * Everything arriving takes our name on its FROM, so what comes in carries a
	 * path back out through us: a reply from `foo` reads `remote:austin/foo`
	 * here, which routes, where bare `foo` names a node this graph lacks.
	 * Inbound only — a command going out has not been anywhere yet, and stamping
	 * it would tell the remote our name is part of its own address. Through
	 * `stamp_message`, like every transport that stamps — the sibling is
	 * `Remote_Link_Node::deliver_downstream()` — and its two guards are the
	 * point: an overflowing path is dropped by the boundary that overflowed it,
	 * which can name itself, not by the Router a layer later, which cannot.
	 *
	 * A reply — TM_RESPONSE or TM_ERROR — self-routes by the TO the remote echoed
	 * off our own FROM breadcrumb. Anything else on the reply leg is the remote
	 * addressing OUR graph, and `target` decides what that means: unaddressed
	 * output (a `log` broadcast, say) belongs to the target, while an addressed
	 * non-reply arriving while a target is set is the remote picking its own
	 * destination inside us — refused. With no target neither arm engages.
	 *
	 * @param array<int,mixed> $reply Reply Message, mutated in place.
	 * @return bool True if the reply may be forwarded to the sink.
	 */
	private function accept_inbound( array &$reply ): bool {
		$type = Core::int( $reply[ Message::TYPE ], 0 );
		$to   = Core::as_string( $reply[ Message::TO ] );
		// Socket.pm:853, through the guarded method; see the docblock.
		if ( ! $this->stamp_message( $reply, $this->name ) ) {
			return false;
		}
		// A directed error is a reply too; undirected output is the target's.
		if ( '' !== $to && $type & ( Message::TM_RESPONSE | Message::TM_ERROR ) ) {
			return true;
		}
		// Single-valued, like Tachikoma's owner; the array form is Tee's.
		$target = $this->target();
		if ( ! \is_string( $target ) || '' === $target ) {
			return true;
		}
		if ( '' !== $to ) {
			$this->drop_message( $reply, "message addressed while target is set to {$target}" );
			return false;
		}
		$reply[ Message::TO ] = $target;
		return true;
	}

	/**
	 * A libcurl write callback that buffers the reply and aborts once it passes
	 * MAX_REPLY_BYTES — returning anything but the chunk length makes libcurl
	 * fail the transfer. Buffers per handle, and read_result() reads it back:
	 * setting WRITEFUNCTION supersedes RETURNTRANSFER's own buffering.
	 *
	 * @return \Closure(mixed, string): int
	 */
	private static function body_cap(): \Closure {
		return static function ( $easy, string $chunk ) : int {
			$key = \is_object( $easy ) ? \spl_object_id( $easy ) : 0;
			$len = \strlen( $chunk );
			$has = \strlen( self::$bodies[ $key ] ?? '' );
			if ( $has + $len > self::MAX_REPLY_BYTES ) {
				return 0; // short write: libcurl aborts the transfer
			}
			self::$bodies[ $key ] = ( self::$bodies[ $key ] ?? '' ) . $chunk;
			return $len;
		};
	}

	/**
	 * Read a completed handle's HTTP code + body. Routes through the $curl_result
	 * seam when set (tests inject a synthetic result); otherwise reads libcurl
	 * directly. The typed return narrows the seam's mixed result at this boundary.
	 * Reads the buffer without clearing it; the caller owns that lifetime.
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
		$key  = \spl_object_id( $easy );
		$body = self::$bodies[ $key ] ?? (string) \curl_multi_getcontent( $easy );
		return [
			'code' => \curl_getinfo( $easy, \CURLINFO_HTTP_CODE ),
			'body' => $body,
		];
		// phpcs:enable
	}

	/**
	 * Teardown: detach every in-flight easy handle (unregistered from the shared
	 * multi, freed when its last reference drops), then drop the pending batch.
	 * @api Used by substrate.
	 */
	public function remove_node(): void {
		$this->batch = [];
		foreach ( $this->inflight as $id => $context ) {
			$this->detach( $context['handle'] );
			unset( $this->inflight[ $id ], self::$bodies[ $id ] );
		}
		parent::remove_node();
	}

	/** Unregister an easy handle from the shared multi. Idempotent. */
	protected function detach( \CurlHandle $easy ): void {
		Event_Framework::instance()->unregister_curl_easy( $easy );
	}
	/**
	 * POST a packed TM_COMMAND to a spoke's `/command` and return the reply's
	 * decoded `payload`. Blocking, for an operator action that needs a verdict
	 * in-band. Throws on any failure (WP_Error, non-200, non-JSON body,
	 * TM_ERROR, missing/non-array payload). Callers whitelist the payload
	 * themselves — this never surfaces raw remote JSON.
	 *
	 * @param string                  $dest      Vault server id — the session identity.
	 * @param array<array-key,mixed> $server    Decrypted vault server config.
	 * @param string                  $to        Target node path on the spoke.
	 * @param string                  $verb      Command verb name.
	 * @param list<string>            $verb_args Argument tail (Command_Args grammar).
	 * @return array<array-key,mixed> The reply's `payload` array.
	 * @throws \RuntimeException On any transport, auth, or envelope failure.
	 */
	public static function probe_command( string $dest, array $server, string $to, string $verb, array $verb_args = [] ): array {
		$base = \rtrim( Core::as_string( $server['url'] ?? '' ), '/' );
		if ( self::https_required( $base ) ) {
			throw new \RuntimeException( 'vault_require_ssl is set but the server url is not https' );
		}

		self::establish_session( $dest, $server, $base );

		$message = self::command_message( $to, $verb, $verb_args );
		Command_Auth::sign_for( $dest, $message );

		$response = self::blocking_post(
			$base . self::COMMAND_PATH,
			self::request_args( $server, Message::packed( $message ) )
		);
		if ( $response instanceof \WP_Error ) {
			throw new \RuntimeException( 'could not connect to server' );
		}
		$code = \wp_remote_retrieve_response_code( $response );
		if ( 200 !== $code ) {
			throw new \RuntimeException( \esc_html( "HTTP {$code} response from server" ) );
		}
		return self::payload_of( \wp_remote_retrieve_body( $response ) );
	}

	/**
	 * The reply `payload` from a JSONL `/command` body: the last line carrying
	 * a struct VALUE wins; other lines are noise.
	 *
	 * @param string $body The raw response body.
	 * @return array<array-key,mixed>
	 * @throws \RuntimeException When the body carries no usable reply.
	 */
	private static function payload_of( string $body ): array {
		$envelope = null;
		foreach ( \explode( "\n", $body ) as $line ) {
			if ( '' === \trim( $line ) ) {
				continue;
			}
			$decoded = \json_decode( $line, true, 16 );
			if ( \is_array( $decoded ) && isset( $decoded[ Message::VALUE ] ) && \is_array( $decoded[ Message::VALUE ] ) ) {
				$envelope = $decoded;
			}
		}
		if ( null === $envelope ) {
			throw new \RuntimeException( 'server returned malformed command envelope' );
		}
		if ( Core::num_int( $envelope[ Message::TYPE ] ?? 0 ) & Message::TM_ERROR ) {
			throw new \RuntimeException( 'server returned TM_ERROR for probe' );
		}
		$value = $envelope[ Message::VALUE ];
		if ( ! \array_key_exists( 'payload', $value ) ) {
			throw new \RuntimeException( 'server returned malformed command response' );
		}
		$payload = $value['payload'];
		$out     = '' === $payload ? [] : $payload;
		if ( ! \is_array( $out ) ) {
			throw new \RuntimeException( 'server returned non-array command payload' );
		}
		return $out;
	}

	/**
	 * Mint the `/command` request Message using substrate primitives only.
	 * Returns the Message rather than a packed line so the caller can sign it —
	 * this is the mint site, and only a mint site may sign.
	 *
	 * @param string       $to   Target node path.
	 * @param string       $verb Command verb name.
	 * @param list<string> $args Argument tail (Command_Args grammar).
	 * @return array<int,mixed> The 7-field positional Message.
	 */
	private static function command_message( string $to, string $verb, array $args = [] ): array {
		$message                   = Message::new_message();
		$message[ Message::TYPE ]  = Message::TM_COMMAND;
		$message[ Message::FROM ]  = Node_Names::HTTP;
		$message[ Message::TO ]    = $to;
		$message[ Message::VALUE ] = [ 'name' => $verb, 'arguments' => $args ];
		return $message;
	}

	/**
	 * Establish the command session with a spoke. First contact is itself a
	 * command, so /auth has to come first. Idempotent per process. No session,
	 * no probe: ingress does not sign, so an unsigned probe is refused anyway,
	 * and failing here names the cause instead of surfacing it as an
	 * unexplained refusal from the far side.
	 *
	 * @param string                  $dest   Vault server id.
	 * @param array<array-key,mixed> $server Decrypted vault server config.
	 * @param string                  $base   Spoke base url, already checked.
	 * @throws \RuntimeException When the spoke will not issue a session.
	 */
	private static function establish_session( string $dest, array $server, string $base ): void {
		if ( Command_Auth::has_session( $dest ) ) {
			return;
		}
		$response = self::blocking_post( $base . self::AUTH_PATH, self::request_args( $server, '' ) );
		if ( $response instanceof \WP_Error || 200 !== \wp_remote_retrieve_response_code( $response ) ) {
			throw new \RuntimeException( 'server refused to issue a command session' );
		}
		[ $handle, $key ] = self::session_from_body( Core::as_string( \wp_remote_retrieve_body( $response ) ) );
		if ( '' === $handle || '' === $key ) {
			throw new \RuntimeException( 'server returned a malformed command session' );
		}
		Command_Auth::remember_session( $dest, $handle, $key );
	}

	/**
	 * The `[ handle, key ]` a `/auth` body issued, both '' when it issued none.
	 * One reading for both transports — the async half logs and holds its batch,
	 * the blocking half throws, and only that disposition differs.
	 *
	 * @param string $body Raw `/auth` response body.
	 * @return array{0:string,1:string}
	 */
	private static function session_from_body( string $body ): array {
		$issued = \json_decode( $body, true, 8 );
		if ( ! \is_array( $issued ) ) {
			return [ '', '' ];
		}
		return [ Core::as_string( $issued['handle'] ?? '' ), Core::as_string( $issued['key'] ?? '' ) ];
	}

	/**
	 * Outbound WP-HTTP args for either endpoint on the blocking path: bounds,
	 * TLS posture, stored credentials.
	 *
	 * @param array<array-key,mixed> $server Decrypted vault server config.
	 * @param string                  $body   Request body.
	 * @return array<string,mixed>
	 */
	private static function request_args( array $server, string $body ): array {
		$args = [
			// 5s bound: UI blocks on the probe; 1s misses slow spokes.
			// phpcs:ignore WordPressVIPMinimum.Performance.RemoteRequestTimeout.timeout_timeout
			'timeout'             => 5,
			'sslverify'           => self::verify_ssl(),
			'redirection'         => 0,
			'limit_response_size' => 1048576,
			'headers'             => [ 'Content-Type' => 'text/plain; charset=UTF-8' ],
			'body'                => $body,
		];
		$authorization = self::authorization( $server );
		if ( '' !== $authorization ) {
			$args['headers']['Authorization'] = $authorization;
		}
		return $args;
	}

	/**
	 * POST through the `$http_call` seam on the blocking path.
	 *
	 * @param string              $url  Absolute endpoint url.
	 * @param array<string,mixed> $args WP HTTP args.
	 * @return array<string,mixed>|\WP_Error
	 */
	private static function blocking_post( string $url, array $args ) {
		$call = self::$http_call ?? static function ( string $u, array $a ) {
			/** @var array{method?: string, timeout?: float, redirection?: int, httpversion?: string, user-agent?: string, reject_unsafe_urls?: bool, blocking?: bool, headers?: array<string,mixed>|string, body?: array<string,mixed>|string, sslverify?: bool} $a -- WP HTTP args shape; loose `array` param widens it. */
			return \wp_remote_post( $u, $a );
		};
		return $call( $url, $args );
	}

	/**
	 * Whether this url violates the `vault_require_ssl` posture. The push side
	 * drops the batch with its own diagnostic; the blocking side throws.
	 *
	 * @param string $url The spoke base url.
	 * @return bool True when the operator requires https and this url is not.
	 */
	public static function https_required( string $url ): bool {
		return self::require_ssl() && ! \str_starts_with( $url, 'https://' );
	}

	/**
	 * The operator's posture itself: are plaintext spokes refused? Distinct
	 * from `https_required()`, which asks whether ONE url violates it —
	 * SSE_In takes the policy, because it drives CURLOPT_PROTOCOLS.
	 */
	public static function require_ssl(): bool {
		return (bool) Config::value( 'vault_require_ssl' );
	}

	/** Whether to verify the spoke's TLS certificate. Read by every transport. */
	public static function verify_ssl(): bool {
		return (bool) Config::value( 'vault_verify_ssl' );
	}

	/**
	 * The credential header value for a spoke, or '' when it needs none. Basic
	 * wins over Bearer: a config carrying both means the operator set a username
	 * and password, which is the more specific statement.
	 *
	 * @param array<array-key,mixed> $server Decrypted vault server config.
	 * @return string e.g. `Basic <base64 of user:pass>`, or ''.
	 */
	private static function authorization( array $server ): string {
		return Vault::credential_header_for( $server );
	}

	/**
	 * Run the handshake if this spoke has no session yet.
	 *
	 * A minter that cannot sign must call this instead of simply skipping: the
	 * handshake used to need a queued batch to trigger it, and every minter
	 * refuses to queue without a session, so neither side could ever move.
	 */
	public function ensure_session(): void {
		if ( ! Command_Auth::has_session( $this->vault_id ) ) {
			$this->fire();
		}
	}

	/**
	 * Which spoke this egress speaks for. A minter resolves the target node at
	 * fill time and asks, because the node name and the vault id are independent
	 * — the live hub names one `settings:tw0` for vault id `tw0`.
	 * @api Read by minters that sign per destination.
	 */
	public function vault_id(): string {
		return $this->vault_id;
	}

	/** @api Resolved by make_node; consumed by topology wiring + later slices. */
	public static function node_schema(): array {
		return [
			'category'    => 'I/O',
			'description' => 'Outbound: POSTs each message as a TM_COMMAND to a remote spoke /command (non-blocking).',
			'has_target'  => true,
			'arguments'   => [
				[ 'name' => 'vault_id', 'type' => 'vault_id', 'required' => true, 'description' => 'Which spoke to connect to — a Vault-registered server (URL + credentials).' ],
			],
			'commands'    => [],
			'requests'    => [],
		];
	}

}
