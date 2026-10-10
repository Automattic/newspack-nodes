<?php
/**
 * Vault_CI: the command surface the Vault admin tab and the REPL reach the
 * credential store through.
 *
 * Six verbs sit over `Vault`: `list` and `get` read, `add`, `update` and
 * `delete` write, and `test` proves a spoke still answers. Every one of them
 * gates at MANAGE — no verb declares a `capability`, and `Service_CI_Node`
 * hands an undeclared verb the strictest role rather than the loosest.
 *
 * `add` and `update` declare `password` `'secret' => true`, the only secret
 * arguments in the system, so the command line a dispatch wrapper logs masks
 * it wherever it binds. Both refuse a `url` that
 * `Vault::url_carries_credentials()` refuses: a credential goes in `user` and
 * `password`.
 *
 * A read never carries the password. `public_shape()` is the one projection
 * both reading verbs return, and it says what else it keeps and why. A write
 * never acts on its own consequences: it announces on
 * `newspack_nodes/vault/changed`, and `fire_changed()` names the listeners.
 *
 * `test` is the only verb that leaves the site. Its POST and JSONL parse are
 * `HTTP_Out_Node::probe_command()`, shared with `Aggregator_CI`; what this
 * class owns there is the verdict it reduces the spoke's reply to.
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes\Rest;

use Newspack_Nodes\Core;
use Newspack_Nodes\Service_CI_Node;
use Newspack_Nodes\HTTP_Out_Node;
use Newspack_Nodes\Vault;

\defined( 'ABSPATH' ) || exit;

/**
 * The six `vault` verbs over the substrate credential store, each declared
 * once in `node_schema()` and gated there by `Service_CI_Node`.
 */
class Vault_CI_Node extends Service_CI_Node {

	/**
	 * Credential arg name => stored config key. An operator types `user` and
	 * `password`; the store, the node arguments and the wire keep the `auth_`
	 * spelling. The two config builders write through this one declaration.
	 */
	private const CREDENTIAL_OPTION_TO_KEY = [
		'user'     => 'auth_username',
		'password' => 'auth_password',
	];

	/**
	 * Verb arg name => stored config key, for the four fields `add` and
	 * `update` write. One declaration serves both the whole blob and the partial
	 * one; `url` and `group` are the same word on both sides.
	 */
	private const OPTION_TO_KEY = [ 'url' => 'url', 'group' => 'group' ] + self::CREDENTIAL_OPTION_TO_KEY;

	/**
	 * `list` verb handler — every registered server in its public shape,
	 * keyed by id.
	 *
	 * @return array<array-key,array<string,mixed>> Keys are array-key, not string: PHP coerces a numeric id to int.
	 */
	public static function cmd_list(): array {
		$registry = Vault::fresh();
		$out = [];
		/** @var array<string,mixed> $config */
		foreach ( $registry->get_all() as $id => $config ) {
			$out[ $id ] = self::public_shape( (string) $id, $config );
		}
		return $out;
	}

	/**
	 * `get` verb handler — one server's public shape, by id.
	 *
	 * @param array<array-key,mixed> $args Bound verb arguments: id.
	 * @return array<string,mixed> The public server record.
	 * @throws \RuntimeException When no entry claims that id.
	 */
	public static function cmd_get( array $args ): array {
		$registry = Vault::fresh();
		$id       = Core::as_string( $args['id'] );
		$server   = $registry->get( $id );
		if ( null === $server ) {
			throw new \RuntimeException( \esc_html( "server not found: {$id}" ) );
		}
		return self::public_shape( $id, $server );
	}

	/**
	 * Project a stored server config into its public dashboard shape. Strips the
	 * password and adds the computed `has_credentials` flag. The username
	 * stays: it is half an address, not a secret, and an edit form cannot
	 * offer to change what it cannot show — which holds only while every
	 * vault verb is MANAGE by construction. Declaring one READ discloses it.
	 *
	 * @param string              $id     Server id.
	 * @param array<string,mixed> $config Stored server config.
	 * @return array<string,mixed> Public server record.
	 */
	private static function public_shape( string $id, array $config ): array {
		return [
			'id'              => $id,
			'url'             => Core::as_string( $config['url'] ?? '' ),
			'auth_username'   => Core::as_string( $config['auth_username'] ?? '' ),
			'has_credentials' => ! empty( $config['auth_username'] ) && ! empty( $config['auth_password'] ),
			'group'           => Core::as_string( $config['group'] ?? '' ),
		];
	}

	/**
	 * `add` verb handler — register a server under `id`; returns that id.
	 *
	 * @param array<array-key,mixed> $args Bound verb arguments: id, url, and the optional group, user, password.
	 * @return array<string,mixed> The stored id, as `[ 'id' => <id> ]`.
	 * @throws \RuntimeException When the id is malformed or taken, the group is
	 *                           malformed, the url carries credentials, or the
	 *                           store refuses the entry.
	 */
	public static function cmd_add( array $args ): array {
		$id       = Core::as_string( $args['id'] );
		$opts     = self::given( $args );
		$registry = Vault::fresh();
		self::assert_free_id( $id, $registry );
		self::assert_valid_group( $opts );
		self::assert_url_without_credentials( $opts['url'] ?? '', 'url' );
		$config = self::extract_server_config( $opts );
		if ( ! $registry->add( $id, $config ) ) {
			// Registry rejected (bad/non-HTTPS URL) or hit MAX_SERVERS.
			throw new \RuntimeException( 'add failed: check URL format (must be HTTPS) and registry capacity' );
		}
		self::fire_changed( $id, 'added' );
		return [ 'id' => $id ];
	}

	/**
	 * Build the complete four-key blob `add` stores, defaulting an absent
	 * option to ''.
	 *
	 * `Vault::add()` stores exactly this projection and carries nothing over
	 * from a previous entry, so the blob has to be whole; `partial_config()` is
	 * the deliberate opposite, for the same reason.
	 *
	 * @param array<string,string> $opts The given args, from `given()`.
	 * @return array<string,mixed> The url, group, auth_username and auth_password quad.
	 */
	private static function extract_server_config( array $opts ): array {
		$config = [];
		foreach ( self::OPTION_TO_KEY as $option => $key ) {
			$config[ $key ] = $opts[ $option ] ?? '';
		}
		return $config;
	}

	/**
	 * `update` verb handler — merge the args actually given into an existing
	 * entry, moving it when `new_id` names somewhere else. Returns the id the
	 * entry now carries.
	 *
	 * @param array<array-key,mixed> $args Bound verb arguments: id, and the optional new_id, url, group, user, password.
	 * @return array<string,mixed> The entry's id after the write, as `[ 'id' => <id> ]`.
	 * @throws \RuntimeException When the id is unknown, the new id or the group is
	 *                           unusable, the url it would store carries
	 *                           credentials or will not parse, or the store
	 *                           refuses the write.
	 */
	public static function cmd_update( array $args ): array {
		$id       = Core::as_string( $args['id'] );
		$opts     = self::given( $args );
		$registry = Vault::fresh();
		$existing = $registry->get( $id );
		if ( null === $existing ) {
			throw new \RuntimeException( \esc_html( "server not found: {$id}" ) );
		}
		$new_id = self::renamed_to( null === $args['new_id'] ? null : Core::as_string( $args['new_id'] ), $id, $registry );
		self::assert_valid_group( $opts );
		self::assert_url_without_credentials( $opts['url'] ?? Core::as_string( $existing['url'] ?? '' ), isset( $opts['url'] ) ? 'url' : 'stored url' );
		$partial = self::partial_config( $opts );
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
	 * The stored fields among the bound args that were actually given: an
	 * absent arg binds null and is left out, so `update` leaves its field
	 * untouched and `add` stores ''.
	 *
	 * @param array<array-key,mixed> $args Bound verb arguments.
	 * @return array<string,string> Arg name => given value, for the `OPTION_TO_KEY` names.
	 */
	private static function given( array $args ): array {
		$given = [];
		foreach ( \array_keys( self::OPTION_TO_KEY ) as $name ) {
			if ( null !== ( $args[ $name ] ?? null ) ) {
				$given[ $name ] = Core::as_string( $args[ $name ] );
			}
		}
		return $given;
	}

	/**
	 * The id `update` was asked to move an entry to, checked against everything
	 * the store would otherwise refuse without saying why. Returns '' when the
	 * entry keeps the id it has.
	 *
	 * @param string|null $named    The `new_id` arg; null when none was given.
	 * @param string      $id       The entry's current id.
	 * @param Vault       $registry Backing vault.
	 * @return string The new id, or '' for no rename.
	 * @throws \RuntimeException When `new_id` is malformed or taken.
	 */
	private static function renamed_to( ?string $named, string $id, Vault $registry ): string {
		// Absent asks for no rename; present and unusable is a refusal.
		if ( null === $named || $named === $id ) {
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
	 * @throws \RuntimeException When the id is malformed or an entry already holds it.
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
	 * Refuse a `group` the store would reject, naming it, where the store
	 * answers only `false`. An absent or empty group joins no group.
	 *
	 * @param array<string,string> $opts The given args, from `given()`.
	 * @throws \RuntimeException When the group breaks the `Vault::is_valid_id()` rule.
	 */
	private static function assert_valid_group( array $opts ): void {
		$group = $opts['group'] ?? '';
		if ( '' !== $group && ! Vault::is_valid_id( $group ) ) {
			throw new \RuntimeException( \esc_html( "invalid group: {$group}" ) );
		}
	}

	/**
	 * Refuse the url a write would store when `Vault::url_carries_credentials()`
	 * says it may carry a credential, which the store would refuse with a bare
	 * `false`, saying where one goes instead. The URL is not echoed: its
	 * userinfo is the secret. `$which` names where the url came from.
	 *
	 * @param string $url   The url the write would store.
	 * @param string $which `url` for the given arg, `stored url` for the entry's own.
	 * @throws \RuntimeException When the url carries userinfo or will not parse.
	 */
	private static function assert_url_without_credentials( string $url, string $which ): void {
		if ( Vault::url_carries_credentials( $url ) ) {
			throw new \RuntimeException( \esc_html( "{$which} carries credentials or will not parse: pass --url without them, the username as --user and the password as --password" ) );
		}
	}

	/**
	 * Build the partial-update blob from `update`'s given args: only the keys
	 * ACTUALLY PRESENT in $opts are included, so an absent arg leaves the stored
	 * field untouched.
	 *
	 * @param array<string,string> $opts The given args, from `given()`.
	 * @return array<string,mixed> Partial config for registry->update().
	 */
	private static function partial_config( array $opts ): array {
		$partial = [];
		foreach ( self::OPTION_TO_KEY as $option => $key ) {
			if ( isset( $opts[ $option ] ) ) {
				$partial[ $key ] = $opts[ $option ];
			}
		}
		return $partial;
	}

	/**
	 * `delete` verb handler — remove a server; returns the id it had.
	 *
	 * @param array<array-key,mixed> $args Bound verb arguments: id.
	 * @return array<string,mixed> The removed id, as `[ 'id' => <id> ]`.
	 * @throws \RuntimeException When no entry claims that id, or the store refuses the write.
	 */
	public static function cmd_delete( array $args ): array {
		$registry = Vault::fresh();
		$id       = Core::as_string( $args['id'] );
		if ( null === $registry->get( $id ) ) {
			throw new \RuntimeException( \esc_html( "server not found: {$id}" ) );
		}
		if ( ! $registry->remove( $id ) ) {
			throw new \RuntimeException( 'delete failed' );
		}
		self::fire_changed( $id, 'removed' );
		return [ 'id' => $id ];
	}

	/**
	 * Announce a Vault mutation, so nothing here has to act on its consequences.
	 *
	 * `Bootstrap` listens twice: it forgets the spoke's command session, and it
	 * asks every broker and Vault_Group worker holding those credentials
	 * to reload. Applications add their own listeners — settings sync, a fleet
	 * restart — without this class knowing they exist.
	 *
	 * A listener receives only as many arguments as it declared, so the third
	 * reaches whoever wants the name a rename retired and nobody else.
	 *
	 * The guard is what lets the store run where WordPress is not loaded, as
	 * `Vault`'s own `function_exists` ladders do; the announcement is skipped
	 * there rather than fatal.
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
	 * `test` verb handler — probe a stored spoke and report whether it answers.
	 *
	 * @param array<array-key,mixed> $args Bound verb arguments: id.
	 * @return array{id:string,status:string} The probe verdict.
	 * @throws \RuntimeException When no entry claims that id, or the spoke does not answer usably.
	 */
	public static function cmd_test( array $args ): array {
		$registry = Vault::fresh();
		$id       = Core::as_string( $args['id'] );
		$server   = $registry->get( $id );
		if ( null === $server ) {
			throw new \RuntimeException( \esc_html( "server not found: {$id}" ) );
		}
		return self::probe_remote( $id, $server );
	}

	/**
	 * Ask a spoke's `status` node whether it answers, over the shared blocking
	 * probe, and reduce the reply to a verdict: { id, status: 'connected' }.
	 *
	 * `status` is a constant because every failure throws inside
	 * `HTTP_Out_Node::probe_command()` — an unreachable host, a non-200, a body
	 * carrying no reply. An operator asking whether a spoke answers gets a
	 * verdict, not a field to interpret.
	 *
	 * `Status_CI` is the substrate's own health probe, mounted unconditionally,
	 * so the verb reaches a spoke whatever consumer plugins it does or does not
	 * carry. A spoke whose substrate predates that node answers `status` with a
	 * TM_ERROR and fails this verb — a mixed-version fleet is the normal state,
	 * so read a failure against the spoke's substrate version before reading it
	 * as a bad credential. Nothing the spoke sent is forwarded: no caller reads
	 * a field off this verb, and a remote gets no say in what this site
	 * renders.
	 *
	 * @param string              $id     Server id, which also picks the session key the command is signed under.
	 * @param array<string,mixed> $server Decrypted server config from the registry.
	 * @return array{id:string,status:string} The probe verdict.
	 * @throws \RuntimeException When the spoke cannot be reached or does not answer usably.
	 */
	private static function probe_remote( string $id, array $server ): array {
		HTTP_Out_Node::probe_command( $id, $server, 'status', 'get' );

		return [
			'id'     => $id,
			'status' => 'connected',
		];
	}

	/**
	 * Declare the verb surface once: the console palette, `help` and the
	 * dispatch table `Service_CI_Node` builds all read this.
	 *
	 * No verb declares a `capability`, so all six gate at MANAGE. Lowering
	 * `list` or `get` to READ would put `auth_username` in front of a role that
	 * cannot otherwise read the vault; `public_shape()` carries the argument.
	 *
	 * `arguments` is empty: `make_node` hands this node nothing, and the
	 * per-verb `args` are what the console renders.
	 *
	 * @api Used by substrate.
	 * @return array<string,mixed>
	 */
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
					'handler'     => static fn ( Vault_CI_Node $self, array $args, array $envelope = [] ): array => self::cmd_get( $args ),
				],
				[
					'name'        => 'add',
					'description' => 'Add a new server under an id and an https url (manage_options).',
					'args'        => [
						[ 'name' => 'id', 'type' => 'string', 'required' => true ],
						[ 'name' => 'url', 'type' => 'string', 'required' => true ],
						[ 'name' => 'group', 'type' => 'string', 'required' => false ],
						[ 'name' => 'user', 'type' => 'string', 'required' => false ],
						[ 'name' => 'password', 'type' => 'string', 'required' => false, 'secret' => true ],
					],
					'handler'     => static fn ( Vault_CI_Node $self, array $args, array $envelope = [] ): array => self::cmd_add( $args ),
				],
				[
					'name'        => 'update',
					'description' => 'Partial-update of an existing server, renamed by new_id (manage_options).',
					'args'        => [
						[ 'name' => 'id', 'type' => 'string', 'required' => true ],
						[ 'name' => 'new_id', 'type' => 'string', 'required' => false ],
						[ 'name' => 'url', 'type' => 'string', 'required' => false ],
						[ 'name' => 'group', 'type' => 'string', 'required' => false ],
						[ 'name' => 'user', 'type' => 'string', 'required' => false ],
						[ 'name' => 'password', 'type' => 'string', 'required' => false, 'secret' => true ],
					],
					'handler'     => static fn ( Vault_CI_Node $self, array $args, array $envelope = [] ): array => self::cmd_update( $args ),
				],
				[
					'name'        => 'delete',
					'description' => 'Remove a server (manage_options).',
					'args'        => [
						[ 'name' => 'id', 'type' => 'string', 'required' => true ],
					],
					'handler'     => static fn ( Vault_CI_Node $self, array $args, array $envelope = [] ): array => self::cmd_delete( $args ),
				],
				[
					'name'        => 'test',
					'description' => "Probe a spoke's /command status endpoint with stored Basic Auth (manage_options).",
					'args'        => [
						[ 'name' => 'id', 'type' => 'string', 'required' => true ],
					],
					'handler'     => static fn ( Vault_CI_Node $self, array $args, array $envelope = [] ): array => self::cmd_test( $args ),
				],
			],
		] );
	}

}
