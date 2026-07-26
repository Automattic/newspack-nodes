<?php
/**
 * Service_CI: base class for substrate + application service interpreters.
 *
 * Hoists the two verb-helper seams that every interpreter built on the M3 +
 * M2 dispatch path duplicates verbatim — `require_manage_options` and
 * `require_valid_name`. Subclasses extend Service_CI instead of
 * CommandInterpreter and reach for the helpers via `self::` inside
 * their verb closures.
 *
 * The helpers are `protected static`. The legitimate callers are
 * subclass verb-table closures using `self::method()` — `self::` resolves
 * at compile time inside the closure's containing method, so static
 * closures (which can't `use ($this)`) still find them. No instance method
 * exists; the helpers don't need one.
 *
 * Lives at `includes/class-service-ci.php` rather than `includes/rest/`
 * because it's substrate infrastructure — both REST-facing interpreters and
 * non-REST callers can inherit. Mirrors `class-command-interpreter.php`'s
 * location.
 *
 * Service_CI is inheritance-only. It has no verbs of its own; as an abstract
 * base it is never make_node'd, and its inherited Hidden category keeps it out
 * of the editor's class palette.
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes;

\defined( 'ABSPATH' ) || exit;

abstract class Service_CI_Node extends Command_Interpreter_Node {

	/**
	 * `wp_remote_post` seam shared by every Service CI that probes a spoke's
	 * `/command` endpoint (Vault_CI `test`, Aggregator_CI `probe`). Lazily
	 * defaulted at the call site (a Closure can't be a constant-expression
	 * property default). Tests reassign in bootstrap to capture outbound args +
	 * inject canned responses without short-circuiting the URL composition +
	 * response-classification path. See `~/.claude/rules/test-seams.md`.
	 *
	 * Signature: `function ( string $url, array $args ): array|\WP_Error`.
	 *
	 * @var \Closure(string, array<string, mixed>): (array<string, mixed>|\WP_Error)|null
	 */
	public static ?\Closure $http_call = null;

	/** Spoke endpoints this class talks to. */
	private const COMMAND_PATH = '/wp-json/newspack-nodes/v1/command';
	private const AUTH_PATH    = '/wp-json/newspack-nodes/v1/auth';

	/**
	 * Derive the dispatch table from the concrete subclass's node_schema() so each
	 * verb is declared ONCE. Late static binding reads the subclass schema; the base
	 * Command_Interpreter_Node has no ctor, so there's nothing to chain.
	 */
	public function __construct() {
		parent::__construct();
		$this->commands( self::commands_from_schema( static::node_schema() ) );
	}

	/**
	 * POST a packed TM_COMMAND to a spoke's `/command` endpoint with stored Basic
	 * Auth and return the reply's decoded `payload` array. Throws a
	 * RuntimeException on any failure (WP_Error, non-200, non-JSON body, TM_ERROR,
	 * missing/ non-array payload). Callers whitelist the returned payload
	 * themselves — this helper never surfaces raw remote JSON.
	 *
	 * @param string               $dest      Vault server id — the session identity.
	 * @param array<string, mixed> $server    Decrypted vault server config (url, auth_*).
	 * @param string               $to        Target node path on the spoke.
	 * @param string               $verb      Command verb name.
	 * @param list<string>         $verb_args Argument tail (Command_Args grammar).
	 * @return array<array-key, mixed> The reply's `payload` array.
	 */
	protected static function probe_command( string $dest, array $server, string $to, string $verb, array $verb_args = [] ): array {
		$base = \rtrim( Core::as_string( $server['url'] ?? '' ), '/' );

		// Refuse before the stored password hits the wire (cf HTTP_Out::fire).
		if ( Config::value( 'vault_require_ssl' ) && ! \str_starts_with( $base, 'https://' ) ) {
			throw new \RuntimeException( 'vault_require_ssl is set but the server url is not https' );
		}

		self::establish_session( $dest, $server, $base );

		$message = self::command_message( $to, $verb, $verb_args );
		Command_Auth::sign_for( $dest, $message );

		$response = self::post( $base . self::COMMAND_PATH, self::request_args( $server, Message::packed( $message ) ) );

		if ( $response instanceof \WP_Error ) {
			throw new \RuntimeException( 'could not connect to server' );
		}
		$code = \wp_remote_retrieve_response_code( $response );
		if ( 200 !== $code ) {
			throw new \RuntimeException( \esc_html( "HTTP {$code} response from server" ) );
		}

		// Pick the reply (struct VALUE) from the JSONL stream; skip noise.
		$envelope = null;
		foreach ( \explode( "\n", \wp_remote_retrieve_body( $response ) ) as $line ) {
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
		$body    = '' === $payload ? [] : $payload;
		if ( ! \is_array( $body ) ) {
			throw new \RuntimeException( 'server returned non-array command payload' );
		}
		return $body;
	}

	/**
	 * Mint the `/command` request Message for a spoke probe, using substrate
	 * primitives only (mirror of the JS CommandClient + HTTP_In decode). Returns
	 * the Message rather than a packed line so the caller can sign it — this is
	 * the mint site, and only a mint site may sign.
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
	 * command — `discovery get` is a TM_COMMAND the spoke's interpreter
	 * authorizes — so /auth has to come first. Idempotent per process.
	 *
	 * No session, no probe. Ingress no longer signs, so an unsigned probe is
	 * refused anyway — failing here names the real cause instead of surfacing it
	 * as an unexplained refusal from the far side.
	 *
	 * @param string              $dest   Vault server id — the session identity.
	 * @param array<string,mixed> $server Decrypted vault server config.
	 * @throws \RuntimeException When the spoke will not issue a session.
	 */
	private static function establish_session( string $dest, array $server, string $base ): void {
		if ( Command_Auth::has_session( $dest ) ) {
			return;
		}
		$response = self::post( $base . self::AUTH_PATH, self::request_args( $server, '' ) );
		if ( $response instanceof \WP_Error || 200 !== \wp_remote_retrieve_response_code( $response ) ) {
			throw new \RuntimeException( 'server refused to issue a command session' );
		}
		$issued = \json_decode( \wp_remote_retrieve_body( $response ), true, 8 );
		$handle = \is_array( $issued ) ? Core::as_string( $issued['handle'] ?? '' ) : '';
		$key    = \is_array( $issued ) ? Core::as_string( $issued['key'] ?? '' ) : '';
		if ( '' === $handle || '' === $key ) {
			throw new \RuntimeException( 'server returned a malformed command session' );
		}
		Command_Auth::remember_session( $dest, $handle, $key );
	}

	/**
	 * Shared outbound args for both spoke endpoints: the bounds, the TLS posture,
	 * and the stored Basic credentials. One place so /auth and /command cannot
	 * drift apart the way `vault_require_ssl` did.
	 *
	 * @param array<string,mixed> $server Decrypted vault server config.
	 * @return array<string,mixed>
	 */
	private static function request_args( array $server, string $body ): array {
		$args = [
			// 5s bound: UI blocks on the probe; 1s misses slow spokes.
			// phpcs:ignore WordPressVIPMinimum.Performance.RemoteRequestTimeout.timeout_timeout
			'timeout'             => 5,
			'sslverify'           => (bool) Config::value( 'vault_verify_ssl' ),
			'redirection'         => 0,
			'limit_response_size' => 1048576,
			'headers'             => [ 'Content-Type' => 'text/plain; charset=UTF-8' ],
			'body'                => $body,
		];

		$username = Core::as_string( $server['auth_username'] ?? '' );
		$password = Core::as_string( $server['auth_password'] ?? '' );
		if ( '' !== $username && '' !== $password ) {
			// phpcs:ignore WordPress.PHP.DiscouragedPHPFunctions.obfuscation_base64_encode -- HTTP Basic Auth.
			$args['headers']['Authorization'] = 'Basic ' . \base64_encode( $username . ':' . $password );
		}
		return $args;
	}

	/**
	 * POST through the `$http_call` seam, so the arg assembly and response
	 * classification around it run as real production code under test.
	 *
	 * @param array<string,mixed> $args
	 * @return array<string,mixed>|\WP_Error
	 */
	private static function post( string $url, array $args ) {
		$call = self::$http_call ?? static function ( string $u, array $a ) {
			/** @var array{method?: string, timeout?: float, redirection?: int, httpversion?: string, user-agent?: string, reject_unsafe_urls?: bool, blocking?: bool, headers?: array<string, mixed>|string, body?: array<string, mixed>|string, sslverify?: bool} $a -- WP HTTP args shape; loose `array` param widens it. */
			return \wp_remote_post( $u, $a );
		};
		return $call( $url, $args );
	}

	/**
	 * Build the interpreter dispatch table (verb name => handler closure) from a node_schema.
	 * Only `verbs[]` entries carry handlers (commands); `requests[]` are answered by
	 * the node's own fill(), so they contribute no dispatch entry.
	 *
	 * A named verb without a callable handler is a schema bug: it would show in the
	 * catalog yet dispatch to nothing ("unknown command" at runtime). We emit ONE
	 * rate-limited warning naming the verb + concrete class, then skip it — keeping
	 * the table to verbs that are actually dispatchable. `is_callable` (not Closure)
	 * is intentional: string/array callables are legitimately dispatchable.
	 *
	 * EVERY derived handler is wrapped to call require_manage_options() before the
	 * original handler runs. Gate-by-default: there are no public Service CI verbs,
	 * so authorization lives here once instead of per-verb. The wrapper is
	 * variadic-transparent — it preserves the handler's exact call signature
	 * ( Command_Interpreter_Node, array, array ) — and self::require_manage_options()
	 * resolves through late static binding inside the closure.
	 *
	 * @param array<string,mixed> $schema
	 * @return array<string,callable>
	 */
	private static function commands_from_schema( array $schema ): array {
		$table    = [];
		$commands = $schema['commands'] ?? [];
		if ( ! \is_array( $commands ) ) {
			return $table;
		}
		foreach ( $commands as $verb ) {
			if ( ! \is_array( $verb ) ) {
				continue;
			}
			$verb_name = $verb['name'] ?? '';
			$name      = Core::as_string( $verb_name );
			if ( '' === $name ) {
				continue;
			}
			if ( ! isset( $verb['handler'] ) || ! \is_callable( $verb['handler'] ) ) {
				Core::print_less_often(
					'Service_CI: verb "',
					$name,
					'" on ' . static::class . ' has no callable handler; skipping'
				);
				continue;
			}
			$handler        = $verb['handler'];
			$role           = Core::as_string( $verb['capability'] ?? Capabilities::MANAGE, Capabilities::MANAGE );
			$table[ $name ] = static function ( ...$args ) use ( $handler, $role ) {
				Capabilities::require( $role );
				return $handler( ...$args );
			};
		}
		// Pre-seed a gated help; base commands() would inject an ungated one.
		if ( ! isset( $table['help'] ) ) {
			$table['help'] = static function ( Command_Interpreter_Node $self, array $args = [], array $envelope = [] ): string {
				self::require_manage_options();
				return $self->default_help();
			};
		}
		return $table;
	}

	/**
	 * Authorisation gate — the manage role via the Capabilities map.
	 * CommandInterpreter::interpret() catches the throw and wraps it as
	 * TM_COMMAND|TM_ERROR.
	 */
	protected static function require_manage_options(): void {
		Capabilities::require( Capabilities::MANAGE );
	}

	/**
	 * A verb carrying a structured blob (`save <name> <tsl…>` / `<name>
	 * <positions-json>`) receives it as a discrete slot: the producer places the
	 * whole body — newlines and all — in the second token. So the name is the
	 * first token and the body is the second, unambiguously (no rest-of-line
	 * splitting to guess at). A lone token yields an empty body.
	 *
	 * @param list<string> $args
	 * @return array{0:string,1:string} [ name, body ]
	 */
	protected static function split_first_token( array $args ): array {
		return [ $args[0] ?? '', $args[1] ?? '' ];
	}

	/**
	 * Build a slice-verb handler from a shape callable, so a CI's read-only slice verbs are
	 * 2–3 lines that share one memoized read instead of each repeating the json-encode dance.
	 *
	 * The returned handler matches the verb-handler signature ( Command_Interpreter_Node, array,
	 * array ) — for a Service_CI verb the interpreter IS this node — passes that node to $shape,
	 * and JSON-encodes whatever $shape returns. The shape closure reads the CI's memoized
	 * snapshot (e.g. `$ci->items()`) and returns the one slice it owns. Authorization stays
	 * central: commands_from_schema() wraps every handler with require_manage_options(), so the
	 * slice handler never self-gates.
	 *
	 * @param callable $shape A `function ( Command_Interpreter_Node $ci ): mixed` returning the slice payload.
	 * @return \Closure The verb handler closure.
	 */
	protected static function slice_verb( callable $shape ): \Closure {
		return static function ( Command_Interpreter_Node $self, array $args = [], array $envelope = [] ) use ( $shape ): string {
			return (string) \wp_json_encode( $shape( $self ) );
		};
	}

	/**
	 * Validate a name token (the first positional argument) against $pattern.
	 * Defaults to `[a-zA-Z0-9_-]+` — the shape Layouts_CI and Topologies_CI
	 * both require. Callers needing a wider charset pass a custom pattern.
	 *
	 * @param string $name    Name token — the first argument token ($args[0]).
	 * @param string $pattern Regex with delimiters; default is the common file-name-safe pattern.
	 * @return string The validated name.
	 */
	protected static function require_valid_name(
		string $name,
		string $pattern = '/^[a-zA-Z0-9_-]+$/'
	): string {
		if ( ! \preg_match( $pattern, $name ) ) {
			throw new \RuntimeException(
				\esc_html( "invalid name: must match $pattern" )
			);
		}
		return $name;
	}
}
