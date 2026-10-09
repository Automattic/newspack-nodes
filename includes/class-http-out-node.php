<?php
/**
 * HTTP_Out: non-blocking outbound command egress, the push-side counterpart of
 * HTTP_In. `fill()` buffers each message verbatim — all seven fields cross —
 * and arms a one-shot timer; on the next drain tick `fire()` POSTs the whole
 * batch as one JSONL body to a remote spoke's `/command`, on the
 * Event_Framework's cURL-multi, so neither `fill()` nor `fire()` blocks.
 * `on_transfer_done()` forwards each reply Message in a 200 body to the sink,
 * where it self-routes by TO=FROM through `_command_interpreter` and then
 * `_router` (ADR-7). The JS mirror is `src/runtime/http-out-node.js`.
 *
 * Batching one POST per tick rather than one per fill lets settings-sync emit N
 * per-setting commands on a single timer tick and ride to the spoke together.
 *
 * Credentials resolve from the Vault by server id: Basic Auth, or a Bearer
 * token when the entry lacks a username or a password. The push side looks the
 * entry up itself; `probe_command()` is handed one, and both its callers read
 * it out of the Vault first.
 *
 * `probe_command()` runs the same protocol on the blocking WP-HTTP transport,
 * for an operator action that must return a verdict now — Vault_CI `test`,
 * Aggregator_CI `probe`. Same idiom as `Topic_Node` and `Partition_Node`: the
 * Node owns its domain and exposes a request-scope entry point beside the
 * event-loop one. One owner is what keeps the two transports agreeing on what a
 * stored credential means and on how a session is established.
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes;

\defined( 'ABSPATH' ) || exit;

/**
 * @implements Curl_Owner<array{context:string,body:\Closure(): string}>
 */
class HTTP_Out_Node extends Timer_Node implements Curl_Owner {
	use Schema_Reflection;

	/** @use Curl_Transfer<string> */
	use Curl_Transfer;

	/** Transfer timeout for one non-blocking POST, in seconds; the blocking class API bounds itself tighter. */
	public const REQUEST_TIMEOUT = 15;

	/**
	 * Spoke endpoints appended to the Vault url. `COMMAND_PATH` takes the
	 * batched JSONL body; `AUTH_PATH` issues the command session that signs it.
	 */
	public const COMMAND_PATH = '/wp-json/newspack-nodes/v1/command';
	public const AUTH_PATH    = '/wp-json/newspack-nodes/v1/auth';

	/**
	 * `wp_remote_post` seam for the BLOCKING class API. Lazily defaulted at the
	 * call site (a Closure cannot be a constant-expression property default).
	 * Tests reassign it to capture the outbound args and inject a canned
	 * response without short-circuiting the url composition and the response
	 * classification around it, so that path runs as real production code.
	 *
	 * Signature: `function ( string $url, array $args ): array|\WP_Error`.
	 *
	 * @var \Closure(string, array<string,mixed>): (array<string,mixed>|\WP_Error)|null
	 */
	public static ?\Closure $http_call = null;

	/** @var array<int,array<int,mixed>> Message arrays buffered between fill() and the next fire(), which packs them. */
	protected array $batch = [];

	/** Whether the one-shot flush timer is already armed; gates re-arming without coupling to Timer_Node internals. */
	protected bool $batch_timer_armed = false;

	/** Vault id whose url and credentials this node POSTs to. */
	protected string $vault_id = '';

	/**
	 * Whole paths a message from the remote may address, as a set.
	 *
	 * A reply self-routes on the TO the remote echoed off our own FROM
	 * breadcrumb — but the remote sets the type bit that makes it a reply, so
	 * without this it also picks the destination, and every node sinks into
	 * `_command_interpreter` and then `_router` (ADR-7). Empty admits nothing
	 * addressed: an undeclared link is a closed one. `Remote_Link_Node` seeds
	 * its own name, so a patron's heartbeat needs no declaration.
	 *
	 * @var array<string,true>
	 */
	protected array $reply_allowlist = [];

	/** This node's cap on one reply body; a broker fetching blocks raises it. */
	private int $reply_cap = self::MAX_REPLY_BYTES;

	/**
	 * The last transfer to complete, /auth included: its HTTP status, null on a
	 * transport error, and the error, null once a 200 or 202 answers.
	 *
	 * @var array{code:?int,error:?string}
	 */
	private array $last_outcome = [ 'code' => null, 'error' => null ];

	/** One handshake at a time; a held batch must not fan out N /auth POSTs. */
	protected bool $auth_in_flight = false;

	/**
	 * Tachikoma-parity: no-arg ctor. Wires the sibling `:config` interpreter that
	 * carries `allow_replies_to`; positional config arrives via arguments(); no
	 * I/O here (ADR-5).
	 */
	public function __construct() {
		parent::__construct();
		$this->auto_wire_interpreter();
	}

	/**
	 * Buffer the incoming message and arm a one-shot flush timer; the actual
	 * POST happens on the next drain tick in fire(). Never blocks and never
	 * resolves the Vault (fire() does that once per batch).
	 *
	 * An error crosses the wire like anything else, a Router bounce included:
	 * a remote sender learns its message never routed only by receiving one.
	 * `Router_Node::send_error()` returns on a message that is already
	 * TM_ERROR, so the far side answers a bounce with nothing and it stops
	 * after one hop — the loop is closed where the bounce is born, not here.
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
	 * envelopes into one JSONL body, assemble the auth and SSL opts, and enqueue
	 * a single POST on the shared multi through the dispatch seam. Non-blocking
	 * — the Event_Framework drain runs the transfer, never this method.
	 *
	 * A batch is DROPPED when the spoke cannot be addressed at all: no Vault
	 * entry, no url, or a plaintext url while `vault_require_ssl` stands. It is
	 * HELD when only the session is missing, since discarding traffic over a
	 * handshake the pending `/auth` reply may well complete is the worse trade.
	 * A session-less tick runs the handshake even with nothing queued, because
	 * every minter refuses to queue without a session — waiting for traffic to
	 * trigger the handshake deadlocks both sides.
	 *
	 * Public, widening Timer_Node's protected `fire()`, so a test can drive one
	 * flush without a live event loop. The Event_Framework itself reaches it
	 * through `fire_cb()`, like every other timer.
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
		$url    = Vault::url_of( $server );
		if ( null === $server || '' === $url ) {
			$this->drop_batch( $batch, 'no Vault entry / url' );
			return;
		}

		if ( Vault::https_required( $url ) ) {
			$this->drop_batch( $batch, 'vault_require_ssl set but url is not https' );
			return;
		}
		// Held, not dropped: the /auth reply re-arms this flush.
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
	 * Report an undelivered batch, rate-limited. Silent on an empty one: a
	 * session-less tick reaches this path with nothing queued, and an empty
	 * batch has nothing to report.
	 *
	 * @param array<int,array<int,mixed>> $batch  The undelivered envelopes.
	 * @param string                      $reason Why they could not be sent.
	 */
	private function drop_batch( array $batch, string $reason ): void {
		if ( [] === $batch ) {
			return;
		}
		$this->print_less_often( $reason, '; dropping ', (string) \count( $batch ), ' message(s)' );
	}

	/**
	 * Establish the command session with this spoke, one handshake at a time.
	 * HTTP_Out runs it because it already holds the credentials and the multi
	 * registration; the minters that will sign for the spoke have neither. It
	 * never signs anything itself — signing belongs to the mint site (ADR-15).
	 *
	 * @param array<string,mixed> $server Decrypted vault entry.
	 * @param string              $url    Spoke base url, without a trailing slash.
	 */
	private function request_session( array $server, string $url ): void {
		if ( $this->auth_in_flight ) {
			return;
		}
		$this->auth_in_flight = true;
		$this->send( $server, $url . self::AUTH_PATH, '', 'auth' );
	}

	/**
	 * Assemble the opts and start the transfer, recording its kind so the
	 * completion knows what it is answering. A failed dispatch releases the
	 * auth flag; without that the node holds a handshake that never completes
	 * and never attempts another.
	 *
	 * @param array<string,mixed> $server   Decrypted vault entry.
	 * @param string              $endpoint Absolute spoke url: base plus path.
	 * @param string              $body     JSONL batch, or '' for a handshake.
	 * @param string              $kind     'command' or 'auth'; steers completion handling.
	 */
	private function send( array $server, string $endpoint, string $body, string $kind ): void {
		$headers       = [ 'Content-Type: text/plain; charset=UTF-8' ];
		$authorization = Vault::credential_header_for( $server );
		if ( '' !== $authorization ) {
			$headers[] = 'Authorization: ' . $authorization;
		}

		$opts = [
			\CURLOPT_URL        => $endpoint,
			\CURLOPT_POST       => true,
			\CURLOPT_POSTFIELDS => $body,
			\CURLOPT_HTTPHEADER => $headers,
			\CURLOPT_TIMEOUT    => self::REQUEST_TIMEOUT,
		] + Vault::tls_opts();
		if ( $this->start_transfer( $opts, $kind ) ) {
			return;
		}
		$this->print_less_often( 'curl_init failed' );
		if ( 'auth' === $kind ) {
			$this->auth_in_flight = false;
		}
	}

	/**
	 * One completed POST. A handle recorded as `auth` goes to
	 * `on_session_reply()`. A command handle forwards each reply Message in a
	 * 200 body to the sink, where it self-routes by TO=FROM through
	 * `_command_interpreter` and then `_router`; the JS mirror is `_post` in
	 * `src/runtime/http-out-node.js`. Transport errors and non-200 codes are
	 * reported rate-limited — bar HTTP_In's 202, which acks an async dispatch
	 * instead of reporting a failure. Every reply line is attempted, and what
	 * any of them threw is raised after the last.
	 *
	 * @param int                         $result The transfer's CURLE_* code.
	 * @param array{code:int,body:string} $res    The reply's status and body.
	 * @param string                      $kind   'command' or 'auth', as send() recorded it.
	 * @throws \Throwable Every reply's failure, combined, raised after the last reply.
	 */
	protected function on_transfer_done( int $result, array $res, mixed $kind ): void {
		if ( \CURLE_OK !== $result ) {
			$this->print_less_often( 'transport error ', (string) $result );
			// phpcs:ignore WordPress.WP.AlternativeFunctions.curl_curl_strerror
			$this->last_outcome = [ 'code' => null, 'error' => "cURL error {$result} (" . \curl_strerror( $result ) . ')' ];
			if ( 'auth' === $kind ) {
				$this->auth_in_flight = false;
			}
			return;
		}
		$code               = $res['code'];
		$error              = 200 === $code || 202 === $code ? null : "HTTP {$code}";
		$this->last_outcome = [ 'code' => $code, 'error' => $error ];
		if ( 'auth' === $kind ) {
			$this->on_session_reply( $code, $res['body'] );
			return;
		}
		if ( null !== $error ) {
			// 401: the spoke dropped this handle; every send now fails.
			if ( 401 === $code ) {
				Command_Auth::forget_session( $this->vault_id );
			}
			$this->print_less_often( 'HTTP ', (string) $code );
		} elseif ( 200 === $code && null !== $this->sink && '' !== $res['body'] ) {
			$caught = Worker_Should_Stop::attempt_each(
				\explode( "\n", $res['body'] ),
				fn ( string $line ) => $this->deliver_reply( $line )
			);
			Worker_Should_Stop::raise( $caught );
		}
	}

	/**
	 * Hand one line of a 200 body to the sink as a reply Message: a blank line
	 * is the body's trailing newline. A line that will not unpack throws, and
	 * the caller raises it after delivering the rest of the body.
	 *
	 * @param string $line One line of the reply body.
	 * @throws \InvalidArgumentException When the line is not a packed Message.
	 */
	private function deliver_reply( string $line ): void {
		if ( '' === $line ) {
			return;
		}
		$reply = Message::unpacked( $line );
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

	/**
	 * Adopt the session the spoke issued, then re-arm the held batch. A refusal
	 * only clears the in-flight flag: the batch stays put until the next `fill()`
	 * or a minter's `ensure_session()` retries, since discarding traffic over a
	 * handshake failure that may be transient is worse than waiting.
	 *
	 * @param int    $code HTTP status the `/auth` POST returned.
	 * @param string $body Raw `/auth` response body.
	 */
	private function on_session_reply( int $code, string $body ): void {
		$this->auth_in_flight = false;
		if ( 200 !== $code ) {
			$error = self::error_code_from_body( $body );
			$this->print_less_often( 'auth failed at spoke: HTTP ', (string) $code, '' === $error ? '' : " {$error}" );
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
	 * The `code` a spoke's WP_Error body names, so the hub's log says WHY
	 * `/auth` failed — `session_store_unavailable` is the spoke's cache, not a
	 * refused credential. '' when the body names none. The spoke writes this
	 * text, so only a WP_Error-shaped code of 1-64 word characters is echoed.
	 *
	 * @param string $body Raw `/auth` response body.
	 * @return string The error code, or ''.
	 */
	private static function error_code_from_body( string $body ): string {
		$error = \json_decode( $body, true, 8 );
		$code  = \is_array( $error ) ? Core::as_string( $error['code'] ?? '' ) : '';
		return 1 === \preg_match( '/^\w{1,64}\z/', $code ) ? $code : '';
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
	 * off our own FROM breadcrumb, so an ADDRESSED message is the remote naming a
	 * node inside our graph, and every node sinks into `_command_interpreter` and
	 * then `_router` (ADR-7), so whatever it names is reached. `allow_replies_to`
	 * is therefore the whole gate and bounds anything addressed, whatever type
	 * bits ride with it: the remote sets those bits, so keying off them let a
	 * spoke pick its arm out of the allowlist. It matches the WHOLE path, so a
	 * declaration admits one destination rather than a subtree. Nothing declared
	 * means nothing addressed passes. Unaddressed output — a `log` broadcast, say — is the
	 * target's, and with no target it goes on to the sink as it stands.
	 *
	 * @param array<int,mixed> $reply Reply Message, mutated in place.
	 * @return bool True if the reply may be forwarded to the sink.
	 */
	private function accept_inbound( array &$reply ): bool {
		$to = Core::as_string( $reply[ Message::TO ] );
		// Socket.pm:852, through the guarded method; see the docblock.
		if ( ! $this->stamp_message( $reply, $this->name ) ) {
			return false;
		}
		if ( '' !== $to ) {
			return $this->admit_addressed( $reply );
		}
		// Single-valued, like Tachikoma's owner; the array form is Tee's.
		$target = $this->target();
		if ( \is_string( $target ) && '' !== $target ) {
			$reply[ Message::TO ] = $target;
		}
		return true;
	}

	/**
	 * POST a packed TM_COMMAND to a spoke's `/command` and return the reply's
	 * decoded `payload`. Blocking, for an operator action that needs a verdict
	 * in-band: a plaintext url under `vault_require_ssl`, a spoke that will not
	 * issue a session, a WP_Error, a non-200, a body carrying no command
	 * envelope, a TM_ERROR reply and a missing or non-array payload all throw,
	 * so a caller never has to read a verdict out of a returned value. The
	 * caller whitelists the payload itself, which keeps raw remote JSON off our
	 * surfaces.
	 *
	 * @param string                 $dest      Vault server id — the session identity.
	 * @param array<array-key,mixed> $server    Decrypted vault server config.
	 * @param string                 $to        Target node path on the spoke.
	 * @param string                 $verb      Command verb name.
	 * @param list<string>           $verb_args Argument tail (Command_Args grammar).
	 * @return array<array-key,mixed> The reply's `payload` array.
	 * @throws \RuntimeException On any transport, auth, or envelope failure.
	 */
	public static function probe_command( string $dest, array $server, string $to, string $verb, array $verb_args = [] ): array {
		$base = Vault::url_of( $server );
		if ( Vault::https_required( $base ) ) {
			throw new \RuntimeException( 'vault_require_ssl is set but the server url is not https' );
		}

		self::establish_session( $dest, $server, $base );

		$message = self::command_message( Node_Names::HTTP, $to, $verb, $verb_args );
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
	 * Build one command bound for a spoke, unsigned. Returns the Message rather
	 * than a packed line so the minter can sign it — only a mint site may sign
	 * (ADR-15). The blocking probe names the `_http` boundary as FROM, because
	 * it reads its reply off the response body instead of routing it;
	 * `Command_Auth::mint_for()` names the node the reply returns to.
	 *
	 * @api `Command_Auth::mint_for()` builds every signed per-spoke command here.
	 * @param string       $from Where the reply returns.
	 * @param string       $to   Target node path.
	 * @param string       $verb Command verb name.
	 * @param list<string> $args Argument tail (Command_Args grammar).
	 * @return array<int,mixed> The 7-field positional Message.
	 */
	public static function command_message( string $from, string $to, string $verb, array $args ): array {
		$message                   = Message::new_message();
		$message[ Message::TYPE ]  = Message::TM_COMMAND;
		$message[ Message::FROM ]  = $from;
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
	 * @param string                 $dest   Vault server id.
	 * @param array<array-key,mixed> $server Decrypted vault server config.
	 * @param string                 $base   Spoke base url, already checked.
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
	 * The `[ handle, secret ]` a `/auth` body issued, both '' when it issued none.
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
		return [ Core::as_string( $issued['handle'] ?? '' ), Core::as_string( $issued['secret'] ?? '' ) ];
	}

	/**
	 * Outbound WP-HTTP args for either endpoint on the blocking path: bounds,
	 * TLS posture, stored credentials.
	 *
	 * @param array<array-key,mixed> $server Decrypted vault server config.
	 * @param string                 $body   Request body.
	 * @return array<string,mixed>
	 */
	private static function request_args( array $server, string $body ): array {
		$args = [
			// 5s bound: the UI blocks on the probe and 1s misses slow spokes.
			// phpcs:ignore WordPressVIPMinimum.Performance.RemoteRequestTimeout.timeout_timeout
			'timeout'             => 5,
			'sslverify'           => Vault::verify_ssl(),
			'redirection'         => 0,
			'limit_response_size' => 1048576,
			'headers'             => [ 'Content-Type' => 'text/plain; charset=UTF-8' ],
			'body'                => $body,
		];
		$authorization = Vault::credential_header_for( $server );
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
			/** @var array{method?:string,timeout?:float,redirection?:int,httpversion?:string,user-agent?:string,reject_unsafe_urls?:bool,blocking?:bool,headers?:array<string,mixed>|string,body?:array<string,mixed>|string,sslverify?:bool} $a -- WP HTTP args shape; loose `array` param widens it. */
			return \wp_remote_post( $u, $a );
		};
		return $call( $url, $args );
	}

	/**
	 * Admit an ADDRESSED inbound message only to a destination `allow_replies_to`
	 * declares, in full; anything else is dropped with one throttled audit line.
	 *
	 * @api The stream leg asks too, through `Remote_Link_Node::admit_inbound()`,
	 *      so one declaration bounds every inbound leg of a channel.
	 * @param array<int,mixed> $message The 7-field positional message array, TO non-empty.
	 * @return bool True when the message may go on.
	 */
	public function admit_addressed( array $message ): bool {
		if ( isset( $this->reply_allowlist[ Core::as_string( $message[ Message::TO ] ) ] ) ) {
			return true;
		}
		// Constant: drop_message keys its throttle on the reason.
		$this->drop_message( $message, 'addressed outside allow_replies_to' );
		return false;
	}

	/**
	 * Raise the cap on one reply body, never below `MAX_REPLY_BYTES`.
	 *
	 * @api A broker sets it from its reader count.
	 * @param int $bytes The most one POST's reply may carry.
	 */
	public function set_reply_cap( int $bytes ): void {
		$this->reply_cap = \max( self::MAX_REPLY_BYTES, $bytes );
	}

	/** This node's cap. */
	protected function reply_cap(): int {
		return $this->reply_cap;
	}

	/**
	 * The last transfer to complete, for a broker's status snapshot.
	 *
	 * @api A broker reads it for its status.
	 * @return array{code:?int,error:?string}
	 */
	public function last_outcome(): array {
		return $this->last_outcome;
	}

	/**
	 * Teardown: drop the pending batch, then release every in-flight easy
	 * handle, which unregisters it from the shared multi and frees it once the
	 * last reference goes.
	 *
	 * @api Used by substrate.
	 */
	public function remove_node(): void {
		$this->batch = [];
		$this->release_all();
		parent::remove_node();
	}

	/**
	 * Run the handshake when this spoke has no session yet.
	 *
	 * A minter that cannot sign calls this rather than simply skipping its push.
	 * Every minter refuses to queue without a session, so nothing else would ask
	 * for one and both sides would sit still.
	 */
	public function ensure_session(): void {
		if ( ! Command_Auth::has_session( $this->vault_id ) ) {
			$this->fire();
		}
	}

	/**
	 * Which spoke this egress speaks for. A minter resolves the target node at
	 * fill time and asks, because the node name and the vault id are
	 * independent: an operator writes `make_node HTTP_Out <name> <vault-id>` and
	 * names the node whatever reads best in the graph.
	 *
	 * @api Read by minters that sign per destination.
	 * @return string The Vault server id this node POSTs to.
	 */
	public function vault_id(): string {
		return $this->vault_id;
	}

	/**
	 * Declare a path a reply from the remote may address.
	 *
	 * The WHOLE path, matched exactly. A declared `settings-sync` admits a TO of
	 * `settings-sync` and nothing else — not `settings-sync/x`, and not
	 * `_router/settings-sync`. Matching the head instead would make one
	 * declaration a prefix rule, and `_router` peels the head and dispatches on
	 * the rest, so `allow_replies_to _router` would have re-opened the whole
	 * graph through the list that exists to bound it. A remote that legitimately
	 * answers on a deeper path is declared at that path.
	 *
	 * @api Topology `allow_replies_to`, and Remote_Link seeding its patron.
	 * @param string $path Reply destination to admit, in full.
	 */
	public function allow_replies_to( string $path ): void {
		$path = \trim( $path );
		if ( '' !== $path ) {
			$this->reply_allowlist[ $path ] = true;
		}
	}

	/**
	 * `allow_replies_to` verb handler: declare a reply destination on the patron.
	 *
	 * @param Command_Interpreter_Node $interpreter The auto-wired `:config` sidecar.
	 * @param array<array-key,mixed>   $args        Bound verb arguments: path.
	 * @return string
	 * @throws \RuntimeException When the path is blank.
	 */
	public static function cmd_allow_replies_to( Command_Interpreter_Node $interpreter, array $args ): string {
		$path = \trim( Core::as_string( $args['path'] ) );
		if ( '' === $path ) {
			throw new \RuntimeException( 'usage: allow_replies_to <path>' );
		}
		/** @var self $patron */
		$patron = $interpreter->patron();
		$patron->allow_replies_to( $path );
		return "ok\n";
	}

	/**
	 * Replay the declared reply destinations, so the round trip rebuilds them.
	 *
	 * @api Used by substrate.
	 */
	public function dump_config(): string {
		$out = parent::dump_config();
		foreach ( \array_keys( $this->reply_allowlist ) as $path ) {
			$out .= $this->config_line( 'allow_replies_to', Core::as_string( $path ) );
		}
		return $out;
	}

	/**
	 * @api Dynamic entrypoint.
	 * @return array<string,mixed>
	 */
	public static function node_schema(): array {
		return [
			'category'    => 'I/O',
			'description' => 'Outbound: POSTs each message as a TM_COMMAND to a remote spoke /command (non-blocking).',
			'has_target'  => true,
			'arguments'   => [
				[ 'name' => 'vault_id', 'type' => 'vault_id', 'required' => true, 'description' => 'Which spoke to connect to — a Vault-registered server (URL + credentials).' ],
			],
			'commands'    => [
				[
					'name'        => 'allow_replies_to',
					'description' => 'Admit a reply from the remote addressed to this path. Empty admits nothing addressed: the remote sets the bit that makes a message a reply, so an undeclared link would let it pick any node in this graph.',
					'args'        => [
						[ 'name' => 'path', 'type' => 'string', 'required' => true ],
					],
					'handler'     => static fn ( Command_Interpreter_Node $interpreter, array $args ): string => self::cmd_allow_replies_to( $interpreter, $args ),
					// One call per destination: the console renders a row each.
					'multiple'    => true,
				],
			],
			'requests'    => [],
		];
	}

}
