<?php
/**
 * Vault_CI: command-dispatch for the substrate Vault credential store.
 *
 * Verbs:
 *   list   — all registered servers as a map keyed by id.
 *   get    — a single server record by id.
 *   add    — add a new server. Auth-gated on manage_options.
 *   update — partial-update of an existing server. Auth-gated on manage_options.
 *   delete — remove a server. Auth-gated on manage_options.
 *   test   — probe the remote server's discovery endpoint with stored Basic
 *            Auth, return a sanitised subset of the response. Auth-gated on
 *            manage_options.
 *
 * Public list/get shape: `{ id, url, has_credentials, is_config }` — never
 * credentials. Mutating verbs fire the `newspack_nodes/vault/changed` action so
 * applications can react (settings-sync, supervisor restart, etc.) without the
 * substrate knowing those application concerns.
 *
 * Test seam: `Vault_CI::$http_call` is a static `\Closure` that defaults to
 * `\wp_remote_post` at the call site. Tests reassign in their bootstrap to
 * capture without short-circuiting the rest of the URL composition +
 * response-classification path. See `~/.claude/rules/test-seams.md`.
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes\Rest;

use Newspack_Nodes\Command_Args;
use Newspack_Nodes\Config;
use Newspack_Nodes\Core;
use Newspack_Nodes\Message;
use Newspack_Nodes\Node_Names;
use Newspack_Nodes\Service_CI_Node;
use Newspack_Nodes\Vault;

\defined( 'ABSPATH' ) || exit;

class Vault_CI_Node extends Service_CI_Node {

	/**
	 * `wp_remote_post` seam used by the `test` verb. Lazily-defaulted to a
	 * closure that wraps the real WordPress call (can't default a Closure
	 * on a class property — must be a constant expression). Tests reassign
	 * to capture outbound args + inject canned responses.
	 *
	 * Signature: `function ( string $url, array $args ): array|\WP_Error`.
	 *
	 * @var \Closure(string, array<string, mixed>): (array<string, mixed>|\WP_Error)|null
	 */
	public static ?\Closure $http_call = null;
	/**
	 * `list` verb handler — registered servers (public shape).
	 *
	 * @return array<int|string, mixed>
	 */
	public static function cmd_list(): array {
		$registry = Vault::fresh();
		$out = [];
		/** @var array<string, mixed> $config */
		foreach ( $registry->get_all() as $id => $config ) {
			$out[ $id ] = self::public_shape( (string) $id, $config, $registry );
		}
		return $out;
	}

	/**
	 * `get` verb handler — one server's public shape by id.
	 *
	 * @param string $args Verb argument.
	 *
	 * @return array<int|string, mixed>
	 */
	public static function cmd_get( string $args ): array {
		$registry = Vault::fresh();
		$id       = self::positional_id( $args );
		$server   = $registry->get( $id );
		if ( null === $server ) {
			throw new \RuntimeException( \esc_html( "server not found: {$id}" ) );
		}
		return self::public_shape( $id, $server, $registry );
	}

	/**
	 * Project a stored server config into its public dashboard shape. Strips
	 * credentials and adds computed `has_credentials` + `is_config` flags.
	 *
	 * @param string               $id     Server id.
	 * @param array<string, mixed> $config Stored server config.
	 * @param Vault                $registry Backing vault.
	 * @return array<string, mixed> Public server record.
	 */
	private static function public_shape( string $id, array $config, Vault $registry ): array {
		/** @var int|float|string|bool|null $raw_url */
		$raw_url = $config['url'] ?? '';
		return [
			'id'              => $id,
			'url'             => (string) $raw_url,
			'has_credentials' => ! empty( $config['auth_username'] ) && ! empty( $config['auth_password'] ),
			'is_config'       => $registry->is_config_server( $id ),
		];
	}

	/**
	 * `add` verb handler — register a server; returns its id.
	 *
	 * @param string $args Verb argument.
	 *
	 * @return array<string,mixed>
	 */
	public static function cmd_add( string $args ): array {
		$parsed = Command_Args::parse( $args );
		$opts   = $parsed['options'];
		$id     = $parsed['positional'][0] ?? '';
		if ( ! Vault::is_valid_id( $id ) ) {
			throw new \RuntimeException( 'invalid server id' );
		}
		$registry = Vault::fresh();
		if ( null !== $registry->get( $id ) ) {
			throw new \RuntimeException( \esc_html( "server already exists: {$id}" ) );
		}
		$config = self::extract_server_config( $opts );
		if ( ! $registry->add( $id, $config ) ) {
			// Registry rejected (bad/non-HTTPS URL) or hit MAX_SERVERS.
			throw new \RuntimeException( 'add failed: check URL format (must be HTTPS) and registry capacity' );
		}
		self::fire_changed( $id, 'added' );
		return [ 'id' => $id ];
	}

	/**
	 * Build the canonical full server-config blob from `add`'s parsed options,
	 * defaulting missing fields to the same shape validate_config expects.
	 *
	 * @param array<string,string|true> $opts Parsed `--key=value` options.
	 * @return array<string, mixed> Server-config blob ready for registry->add().
	 */
	private static function extract_server_config( array $opts ): array {
		return [
			'url'           => (string) ( $opts['url']           ?? '' ),
			'auth_username' => (string) ( $opts['auth_username'] ?? '' ),
			'auth_password' => (string) ( $opts['auth_password'] ?? '' ),
		];
	}

	/**
	 * `update` verb handler — update a server; returns its id.
	 *
	 * @param string $args Verb argument.
	 *
	 * @return array<string,mixed>
	 */
	public static function cmd_update( string $args ): array {
		$parsed = Command_Args::parse( $args );
		$id     = $parsed['positional'][0] ?? '';
		if ( '' === $id ) {
			throw new \RuntimeException( 'id required' );
		}
		$registry = Vault::fresh();
		$existing = $registry->get( $id );
		if ( null === $existing ) {
			throw new \RuntimeException( \esc_html( "server not found: {$id}" ) );
		}
		// Partial update: an absent --key leaves the stored field alone.
		$partial = self::partial_config( $parsed['options'] );
		if ( ! $registry->update( $id, $partial ) ) {
			throw new \RuntimeException( 'update failed' );
		}
		self::fire_changed( $id, 'updated' );
		return [ 'id' => $id ];
	}

	/**
	 * Build the partial-update blob from `update`'s parsed options: only the
	 * keys ACTUALLY PRESENT in $opts are included, so an absent --key leaves the
	 * stored field untouched.
	 *
	 * @param array<string,string|true> $opts Parsed `--key=value` options.
	 * @return array<string, mixed> Partial config for registry->update().
	 */
	private static function partial_config( array $opts ): array {
		$partial = [];
		foreach ( [ 'url', 'auth_username', 'auth_password' ] as $key ) {
			if ( isset( $opts[ $key ] ) ) {
				$partial[ $key ] = (string) $opts[ $key ];
			}
		}
		return $partial;
	}

	/**
	 * `delete` verb handler — remove a server; returns its id.
	 *
	 * @param string $args Verb argument.
	 *
	 * @return array<string,mixed>
	 */
	public static function cmd_delete( string $args ): array {
		$registry = Vault::fresh();
		$id       = self::positional_id( $args );
		if ( null === $registry->get( $id ) ) {
			throw new \RuntimeException( \esc_html( "server not found: {$id}" ) );
		}
		if ( ! $registry->remove( $id ) ) {
			// Config-file servers reach here.
			throw new \RuntimeException( 'delete failed' );
		}
		self::fire_changed( $id, 'removed' );
		return [ 'id' => $id ];
	}

	/**
	 * Announce a Vault mutation so applications can react (settings-sync,
	 * supervisor restart, etc.) without the substrate knowing those concerns.
	 *
	 * @param string $id     Server id.
	 * @param string $action added|updated|removed.
	 */
	private static function fire_changed( string $id, string $action ): void {
		if ( \function_exists( 'do_action' ) ) {
			\do_action( 'newspack_nodes/vault/changed', $id, $action );
		}
	}

	/**
	 * `test` verb handler — probe a remote server's reachability.
	 *
	 * @param string $args Verb argument.
	 *
	 * @return array<int|string, mixed>
	 */
	public static function cmd_test( string $args ): array {
		$registry = Vault::fresh();
		$id       = self::positional_id( $args );
		$server   = $registry->get( $id );
		if ( null === $server ) {
			throw new \RuntimeException( \esc_html( "server not found: {$id}" ) );
		}
		return self::probe_remote( $id, $server );
	}

	/**
	 * HTTP probe of a remote spoke's discovery endpoint with stored Basic Auth.
	 * Returns the response shape:
	 *   { id, status: 'connected', response: {registered_hooks, custom_events, lag} }
	 * Throws a RuntimeException with a short error string on any failure
	 * (WP_Error, non-200, non-JSON body).
	 *
	 * @param string               $id     Server id.
	 * @param array<string, mixed> $server Decrypted server config from the registry.
	 * @return array<string, mixed> Sanitised probe response.
	 */
	private static function probe_remote( string $id, array $server ): array {
		$cfg        = Config::load_config();
		$verify_ssl = ! isset( $cfg['vault_verify_ssl'] ) || (bool) $cfg['vault_verify_ssl'];

		// discovery.get via /command; build the body via the shared primitive.
		/** @var int|float|string|bool|null $raw_server_url */
		$raw_server_url = $server['url'];
		$url            = \rtrim( (string) $raw_server_url, '/' ) . '/wp-json/newspack-nodes/v1/command';
		$args = [
			// 5s bound: UI blocks on the probe; 1s misses slow spokes.
			// phpcs:ignore WordPressVIPMinimum.Performance.RemoteRequestTimeout.timeout_timeout
			'timeout'             => 5,
			'sslverify'           => $verify_ssl,
			'redirection'         => 0,
			'limit_response_size' => 1048576,
			'headers'             => [ 'Content-Type' => 'text/plain; charset=UTF-8' ],
			'body'                => self::command_body( 'discovery', 'get', '' ),
		];

		/** @var int|float|string|bool|null $raw_username */
		$raw_username = $server['auth_username'] ?? '';
		/** @var int|float|string|bool|null $raw_password */
		$raw_password = $server['auth_password'] ?? '';
		$username     = (string) $raw_username;
		$password     = (string) $raw_password;
		if ( '' !== $username && '' !== $password ) {
			// phpcs:ignore WordPress.PHP.DiscouragedPHPFunctions.obfuscation_base64_encode -- HTTP Basic Auth.
			$args['headers']['Authorization'] = 'Basic ' . \base64_encode( $username . ':' . $password );
		}

		$call = self::$http_call ?? static function ( string $u, array $a ) {
			/** @var array{method?: string, timeout?: float, redirection?: int, httpversion?: string, user-agent?: string, reject_unsafe_urls?: bool, blocking?: bool, headers?: array<string, mixed>|string, body?: array<string, mixed>|string, sslverify?: bool} $a -- WP HTTP args shape; loose `array` param widens it. */
			return \wp_remote_post( $u, $a );
		};
		$response = $call( $url, $args );

		if ( $response instanceof \WP_Error ) {
			throw new \RuntimeException( 'could not connect to server' );
		}

		$code = \wp_remote_retrieve_response_code( $response );
		if ( 200 !== $code ) {
			throw new \RuntimeException( \esc_html( "HTTP {$code} response from server" ) );
		}

		// One decode of the whole Message yields payload; NO second decode.
		$envelope = \json_decode( \wp_remote_retrieve_body( $response ), true, 16 );
		if ( ! \is_array( $envelope ) || ! \array_key_exists( Message::VALUE, $envelope ) ) {
			throw new \RuntimeException( 'server returned malformed command envelope' );
		}
		$raw_type = $envelope[ Message::TYPE ] ?? 0;
		if ( Core::num_int( $raw_type ) & Message::TM_ERROR ) {
			throw new \RuntimeException( 'server returned TM_ERROR for discovery probe' );
		}
		$value = $envelope[ Message::VALUE ];
		if ( ! \is_array( $value ) || ! \array_key_exists( 'payload', $value ) ) {
			throw new \RuntimeException( 'server returned malformed command response' );
		}
		$payload = $value['payload'];
		$body    = '' === $payload ? [] : $payload;
		if ( ! \is_array( $body ) ) {
			throw new \RuntimeException( 'server returned non-JSON discovery payload' );
		}

		// Whitelist what we surface so we never proxy arbitrary remote JSON.
		$safe = [];
		if ( isset( $body['registered_hooks'] ) && \is_array( $body['registered_hooks'] ) ) {
			$safe['registered_hooks'] = \array_values(
				\array_map( 'sanitize_text_field', \array_filter( $body['registered_hooks'], 'is_string' ) )
			);
		}
		if ( isset( $body['custom_events'] ) && \is_array( $body['custom_events'] ) ) {
			$safe['custom_events'] = \array_values(
				\array_map( 'sanitize_text_field', \array_filter( $body['custom_events'], 'is_string' ) )
			);
		}
		if ( isset( $body['lag'] ) ) {
			/** @var int|float|string|bool|null $raw_lag */
			$raw_lag     = $body['lag'];
			$safe['lag'] = (int) $raw_lag;
		}

		return [
			'id'       => $id,
			'status'   => 'connected',
			'response' => $safe,
		];
	}

	/**
	 * Build a packed /command request body for the spoke probe, using substrate
	 * primitives only (mirror of the JS CommandClient + HTTP_In decode).
	 *
	 * @param string $to   Target node path.
	 * @param string $verb Command verb name.
	 * @param string $args Argument tail (Command_Args grammar).
	 * @return string Packed Message JSONL line.
	 */
	private static function command_body( string $to, string $verb, string $args = '' ): string {
		$message                   = Message::new_message();
		$message[ Message::TYPE ]  = Message::TM_COMMAND;
		$message[ Message::FROM ]  = Node_Names::HTTP;
		$message[ Message::TO ]    = $to;
		$message[ Message::VALUE ] = [ 'name' => $verb, 'arguments' => $args ];
		return Message::packed( $message );
	}

	/**
	 * Pull the single required positional id out of the args string, throwing
	 * 'id required' when absent. Used by get/delete/test/update.
	 *
	 * @param string $args Verb arguments string.
	 * @return string Server id.
	 */
	private static function positional_id( string $args ): string {
		$id = Command_Args::parse( $args )['positional'][0] ?? '';
		if ( '' === $id ) {
			throw new \RuntimeException( 'id required' );
		}
		return $id;
	}

	/** @api Used by the substrate to provide UI etc. */
	public static function node_schema(): array {
		return \array_merge( parent::node_schema(), [
			'category'    => 'Service',
			'description' => 'Vault credential store: list / get / add / update / delete / test spokes.',
			'arguments'   => [],
			'commands'    => [
				[
					'name'        => 'list',
					'description' => 'All registered servers as a map keyed by id.',
					'args'        => [],
					'handler'     => static fn ( Vault_CI_Node $self, string $args, array $envelope = [] ): array => self::cmd_list(),
				],
				[
					'name'        => 'get',
					'description' => 'A single server record by id.',
					'args'        => [
						[ 'name' => 'id', 'type' => 'string', 'required' => true ],
					],
					'handler'     => static fn ( Vault_CI_Node $self, string $args, array $envelope = [] ): array => self::cmd_get( $args ),
				],
				[
					'name'        => 'add',
					'description' => 'Add a new server (manage_options).',
					'args'        => [
						[ 'name' => 'id', 'type' => 'string', 'required' => true ],
						[ 'name' => 'url', 'type' => 'string', 'required' => true ],
						[ 'name' => 'auth_username', 'type' => 'string', 'required' => false ],
						[ 'name' => 'auth_password', 'type' => 'string', 'required' => false ],
					],
					'handler'     => static fn ( Vault_CI_Node $self, string $args, array $envelope = [] ): array => self::cmd_add( $args ),
				],
				[
					'name'        => 'update',
					'description' => 'Partial-update of an existing server (manage_options).',
					'args'        => [
						[ 'name' => 'id', 'type' => 'string', 'required' => true ],
						[ 'name' => 'url', 'type' => 'string', 'required' => false ],
						[ 'name' => 'auth_username', 'type' => 'string', 'required' => false ],
						[ 'name' => 'auth_password', 'type' => 'string', 'required' => false ],
					],
					'handler'     => static fn ( Vault_CI_Node $self, string $args, array $envelope = [] ): array => self::cmd_update( $args ),
				],
				[
					'name'        => 'delete',
					'description' => 'Remove a server (manage_options).',
					'args'        => [
						[ 'name' => 'id', 'type' => 'string', 'required' => true ],
					],
					'handler'     => static fn ( Vault_CI_Node $self, string $args, array $envelope = [] ): array => self::cmd_delete( $args ),
				],
				[
					'name'        => 'test',
					'description' => "Probe a spoke's /command discovery endpoint with stored Basic Auth (manage_options).",
					'args'        => [
						[ 'name' => 'id', 'type' => 'string', 'required' => true ],
					],
					'handler'     => static fn ( Vault_CI_Node $self, string $args, array $envelope = [] ): array => self::cmd_test( $args ),
				],
			],
		] );
	}

}
