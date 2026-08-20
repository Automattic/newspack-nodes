<?php
/**
 * Vault_CI: command-dispatch for the substrate Vault credential store.
 *
 * Verbs:
 *   list   — all registered servers as a map keyed by id.
 *   get    — a single server record by id.
 *   add    — add a new server. Auth-gated on manage_options.
 *   update — partial-update of an existing server, which `--new_id` also
 *            renames. Auth-gated on manage_options.
 *   delete — remove a server. Auth-gated on manage_options.
 *   test   — probe the remote server's discovery endpoint with stored Basic
 *            Auth, return a sanitised subset of the response. Auth-gated on
 *            manage_options.
 *
 * Public list/get shape: `{ id, url, auth_username, has_credentials, is_config }`
 * — never the password. Mutating verbs fire the `newspack_nodes/vault/changed` action so
 * applications can react (settings-sync, fleet restart, etc.) without the
 * substrate knowing those application concerns.
 *
 * The `test` verb's spoke POST + JSONL parse is the shared
 * `HTTP_Out_Node::probe_command()` (with its `$http_call` test seam); this
 * class only whitelists the returned discovery payload.
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes\Rest;

use Newspack_Nodes\Command_Args;
use Newspack_Nodes\Core;
use Newspack_Nodes\Service_CI_Node;
use Newspack_Nodes\HTTP_Out_Node;
use Newspack_Nodes\Vault;

\defined( 'ABSPATH' ) || exit;

class Vault_CI_Node extends Service_CI_Node {

	/**
	 * `list` verb handler — registered servers (public shape).
	 *
	 * @return array<int|string,mixed>
	 */
	public static function cmd_list(): array {
		$registry = Vault::fresh();
		$out = [];
		/** @var array<string,mixed> $config */
		foreach ( $registry->get_all() as $id => $config ) {
			$out[ $id ] = self::public_shape( (string) $id, $config, $registry );
		}
		return $out;
	}

	/**
	 * `get` verb handler — one server's public shape by id.
	 *
	 * @param list<string> $args Verb argument.
	 *
	 * @return array<int|string,mixed>
	 */
	public static function cmd_get( array $args ): array {
		$registry = Vault::fresh();
		$id       = self::positional_id( $args );
		$server   = $registry->get( $id );
		if ( null === $server ) {
			throw new \RuntimeException( \esc_html( "server not found: {$id}" ) );
		}
		return self::public_shape( $id, $server, $registry );
	}

	/**
	 * Project a stored server config into its public dashboard shape. Strips the
	 * password and adds computed `has_credentials` + `is_config` flags. The
	 * username stays: it is half an address, not a secret, and an edit form
	 * cannot offer to change what it cannot show — which holds only while every
	 * vault verb is MANAGE by construction. Declaring one READ discloses it.
	 *
	 * @param string               $id     Server id.
	 * @param array<string,mixed> $config Stored server config.
	 * @param Vault                $registry Backing vault.
	 * @return array<string,mixed> Public server record.
	 */
	private static function public_shape( string $id, array $config, Vault $registry ): array {
		return [
			'id'              => $id,
			'url'             => Core::as_string( $config['url'] ?? '' ),
			'auth_username'   => Core::as_string( $config['auth_username'] ?? '' ),
			'has_credentials' => ! empty( $config['auth_username'] ) && ! empty( $config['auth_password'] ),
			'is_config'       => $registry->is_config_server( $id ),
		];
	}

	/**
	 * `add` verb handler — register a server; returns its id.
	 *
	 * @param list<string> $args Verb argument.
	 *
	 * @return array<string,mixed>
	 */
	public static function cmd_add( array $args ): array {
		$parsed = Command_Args::parse( $args );
		$opts   = $parsed['options'];
		$id       = $parsed['positional'][0] ?? '';
		$registry = Vault::fresh();
		self::assert_free_id( $id, $registry );
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
	 * @return array<string,mixed> Server-config blob ready for registry->add().
	 */
	private static function extract_server_config( array $opts ): array {
		return [
			'url'           => (string) ( $opts['url']           ?? '' ),
			'auth_username' => (string) ( $opts['auth_username'] ?? '' ),
			'auth_password' => (string) ( $opts['auth_password'] ?? '' ),
		];
	}

	/**
	 * `update` verb handler — update a server; returns its id, which `--new_id`
	 * may have just changed.
	 *
	 * @param list<string> $args Verb argument.
	 *
	 * @return array<string,mixed>
	 */
	public static function cmd_update( array $args ): array {
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
		self::assert_not_pinned( $id, $registry );
		$new_id = self::renamed_to( $parsed['options'], $id, $registry );
		// Partial update: an absent --key leaves the stored field alone.
		$partial = self::partial_config( $parsed['options'] );
		if ( ! $registry->update( $id, $partial, $new_id ) ) {
			throw new \RuntimeException( 'update failed' );
		}
		if ( '' === $new_id ) {
			self::fire_changed( $id, 'updated' );
			return [ 'id' => $id ];
		}
		// ONE announcement: two read alike, and each reloads the whole vault.
		self::fire_changed( $new_id, 'renamed', $id );
		return [ 'id' => $new_id ];
	}

	/**
	 * The id `update` was asked to move an entry to, checked against everything
	 * the store would otherwise refuse without saying why. Returns '' when the
	 * entry keeps the id it has.
	 *
	 * @param array<string,string|true> $opts     Parsed `--key=value` options.
	 * @param string                    $id       The entry's current id.
	 * @param Vault                     $registry Backing vault.
	 * @return string The new id, or '' for no rename.
	 */
	private static function renamed_to( array $opts, string $id, Vault $registry ): string {
		// Absent asks for no rename; present and unusable is a refusal.
		if ( ! isset( $opts['new_id'] ) ) {
			return '';
		}
		$named = $opts['new_id'];
		if ( ! \is_string( $named ) ) {
			throw new \RuntimeException( 'invalid server id' );
		}
		if ( $named === $id ) {
			return '';
		}
		self::assert_free_id( $named, $registry );
		return $named;
	}

	/**
	 * Refuse an id that is malformed or already spoken for, in the operator's
	 * words rather than the store's bare `false`.
	 *
	 * @param string $id       Id being claimed.
	 * @param Vault  $registry Backing vault.
	 */
	private static function assert_free_id( string $id, Vault $registry ): void {
		if ( ! Vault::is_valid_id( $id ) ) {
			throw new \RuntimeException( 'invalid server id' );
		}
		if ( null !== $registry->get( $id ) ) {
			throw new \RuntimeException( \esc_html( "server already exists: {$id}" ) );
		}
	}

	/**
	 * Build the partial-update blob from `update`'s parsed options: only the
	 * keys ACTUALLY PRESENT in $opts are included, so an absent --key leaves the
	 * stored field untouched.
	 *
	 * @param array<string,string|true> $opts Parsed `--key=value` options.
	 * @return array<string,mixed> Partial config for registry->update().
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
	 * @param list<string> $args Verb argument.
	 *
	 * @return array<string,mixed>
	 */
	public static function cmd_delete( array $args ): array {
		$registry = Vault::fresh();
		$id       = self::positional_id( $args );
		if ( null === $registry->get( $id ) ) {
			throw new \RuntimeException( \esc_html( "server not found: {$id}" ) );
		}
		self::assert_not_pinned( $id, $registry );
		if ( ! $registry->remove( $id ) ) {
			throw new \RuntimeException( 'delete failed' );
		}
		self::fire_changed( $id, 'removed' );
		return [ 'id' => $id ];
	}

	/**
	 * Refuse an entry the config file pins. Both mutating verbs ask, because the
	 * store refuses both for this reason and neither can say so from a `false`.
	 *
	 * @param string $id       Server id.
	 * @param Vault  $registry Backing vault.
	 */
	private static function assert_not_pinned( string $id, Vault $registry ): void {
		if ( $registry->is_config_server( $id ) ) {
			throw new \RuntimeException( \esc_html( "pinned by the config file, so it cannot be changed here: {$id}" ) );
		}
	}

	/**
	 * Announce a Vault mutation so applications can react (settings-sync,
	 * fleet restart, etc.) without the substrate knowing those concerns.
	 *
	 * A listener receives only as many arguments as it declared, so the third
	 * reaches whoever wants the name a rename retired and nobody else.
	 *
	 * @param string $id       Server id, as it stands after the change.
	 * @param string $action   added|updated|renamed|removed.
	 * @param string $previous The id a rename moved away from, else ''.
	 */
	private static function fire_changed( string $id, string $action, string $previous = '' ): void {
		if ( \function_exists( 'do_action' ) ) {
			\do_action( 'newspack_nodes/vault/changed', $id, $action, $previous );
		}
	}

	/**
	 * `test` verb handler — probe a remote server's reachability.
	 *
	 * @param list<string> $args Verb argument.
	 *
	 * @return array<int|string,mixed>
	 */
	public static function cmd_test( array $args ): array {
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
	 * The POST + JSONL parse is `HTTP_Out_Node::probe_command()`; this method only
	 * whitelists the discovery payload so we never proxy arbitrary remote JSON.
	 *
	 * @param string               $id     Server id.
	 * @param array<string,mixed> $server Decrypted server config from the registry.
	 * @return array<string,mixed> Sanitised probe response.
	 */
	private static function probe_remote( string $id, array $server ): array {
		$body = HTTP_Out_Node::probe_command( $id, $server, 'discovery', 'get' );

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
	 * Pull the single required positional id out of the args string, throwing
	 * 'id required' when absent. Used by get/delete/test/update.
	 *
	 * @param list<string> $args Verb arguments string.
	 * @return string Server id.
	 */
	private static function positional_id( array $args ): string {
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
					'handler'     => static fn ( Vault_CI_Node $self, array $args, array $envelope = [] ): array => self::cmd_list(),
				],
				[
					'name'        => 'get',
					'description' => 'A single server record by id.',
					'args'        => [
						[ 'name' => 'id', 'type' => 'string', 'required' => true ],
					],
					'handler'     => static fn ( Vault_CI_Node $self, array $args, array $envelope = [] ): array => self::cmd_get( self::arg_strings( $args ) ),
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
					'handler'     => static fn ( Vault_CI_Node $self, array $args, array $envelope = [] ): array => self::cmd_add( self::arg_strings( $args ) ),
				],
				[
					'name'        => 'update',
					'description' => 'Partial-update of an existing server, renamed by --new_id (manage_options).',
					'args'        => [
						[ 'name' => 'id', 'type' => 'string', 'required' => true ],
						[ 'name' => 'new_id', 'type' => 'string', 'required' => false ],
						[ 'name' => 'url', 'type' => 'string', 'required' => false ],
						[ 'name' => 'auth_username', 'type' => 'string', 'required' => false ],
						[ 'name' => 'auth_password', 'type' => 'string', 'required' => false ],
					],
					'handler'     => static fn ( Vault_CI_Node $self, array $args, array $envelope = [] ): array => self::cmd_update( self::arg_strings( $args ) ),
				],
				[
					'name'        => 'delete',
					'description' => 'Remove a server (manage_options).',
					'args'        => [
						[ 'name' => 'id', 'type' => 'string', 'required' => true ],
					],
					'handler'     => static fn ( Vault_CI_Node $self, array $args, array $envelope = [] ): array => self::cmd_delete( self::arg_strings( $args ) ),
				],
				[
					'name'        => 'test',
					'description' => "Probe a spoke's /command discovery endpoint with stored Basic Auth (manage_options).",
					'args'        => [
						[ 'name' => 'id', 'type' => 'string', 'required' => true ],
					],
					'handler'     => static fn ( Vault_CI_Node $self, array $args, array $envelope = [] ): array => self::cmd_test( self::arg_strings( $args ) ),
				],
			],
		] );
	}

}
