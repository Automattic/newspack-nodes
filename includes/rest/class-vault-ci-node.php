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
 * A read never carries the password. `public_shape()` is the one projection
 * both reading verbs return, and it says what else it keeps and why. A write
 * never acts on its own consequences: it announces on
 * `newspack_nodes/vault/changed`, and `fire_changed()` names the listeners.
 *
 * `test` is the only verb that leaves the site. Its POST and JSONL parse are
 * `HTTP_Out_Node::probe_command()`, shared with `Aggregator_CI`; what this
 * class owns there is the whitelist over what comes back.
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

/**
 * The six `vault` verbs over the substrate credential store, each declared
 * once in `node_schema()` and gated there by `Service_CI_Node`.
 */
class Vault_CI_Node extends Service_CI_Node {

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
			$out[ $id ] = self::public_shape( (string) $id, $config, $registry );
		}
		return $out;
	}

	/**
	 * `get` verb handler — one server's public shape, by id.
	 *
	 * @param list<string> $args Verb argument tokens; the id is the first positional.
	 * @return array<string,mixed> The public server record.
	 * @throws \RuntimeException When no entry claims that id.
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
	 * @param string              $id       Server id.
	 * @param array<string,mixed> $config   Stored server config.
	 * @param Vault               $registry Backing vault.
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
	 * `add` verb handler — register a server under the id the first positional
	 * names; returns that id.
	 *
	 * The pinned check the other mutating verbs run is unnecessary here: a
	 * config-file entry occupies its id in the merged view, so `assert_free_id()`
	 * refuses it as taken before the store ever sees it.
	 *
	 * @param list<string> $args Verb argument tokens: `<id> --url=<url> [--auth_username=<u>] [--auth_password=<p>]`.
	 * @return array<string,mixed> The stored id, as `[ 'id' => <id> ]`.
	 * @throws \RuntimeException When the id is malformed or taken, or the store refuses the entry.
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
	 * Build the complete three-key blob `add` stores, defaulting an absent
	 * option to ''.
	 *
	 * `Vault::add()` stores exactly this projection and carries nothing over
	 * from a previous entry, so the blob has to be whole; `partial_config()` is
	 * the deliberate opposite, for the same reason.
	 *
	 * @param array<string,string|true> $opts Parsed `--key=value` options.
	 * @return array<string,mixed> The url, auth_username and auth_password triple.
	 */
	private static function extract_server_config( array $opts ): array {
		return [
			'url'           => (string) ( $opts['url']           ?? '' ),
			'auth_username' => (string) ( $opts['auth_username'] ?? '' ),
			'auth_password' => (string) ( $opts['auth_password'] ?? '' ),
		];
	}

	/**
	 * `update` verb handler — merge the options actually present into an
	 * existing entry, moving it when `--new_id` names somewhere else. Returns
	 * the id the entry now carries.
	 *
	 * @param list<string> $args Verb argument tokens: `<id> [--new_id=<id>] [--url=<url>] [--auth_username=<u>] [--auth_password=<p>]`.
	 * @return array<string,mixed> The entry's id after the write, as `[ 'id' => <id> ]`.
	 * @throws \RuntimeException When the id is absent or unknown, the config file
	 *                           pins the entry, the new id is unusable, or the
	 *                           store refuses the write.
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
	 * @throws \RuntimeException When `--new_id` is a bare flag, malformed, or taken.
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
	 * `delete` verb handler — remove a server; returns the id it had.
	 *
	 * @param list<string> $args Verb argument tokens; the id is the first positional.
	 * @return array<string,mixed> The removed id, as `[ 'id' => <id> ]`.
	 * @throws \RuntimeException When no entry claims that id, the config file pins
	 *                           it, or the store refuses the write.
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
	 * Refuse an entry the config file pins. `update` and `delete` both ask,
	 * because the store refuses both for this reason and a bare `false` cannot
	 * say which reason it was.
	 *
	 * @param string $id       Server id.
	 * @param Vault  $registry Backing vault.
	 * @throws \RuntimeException When the config file pins the entry.
	 */
	private static function assert_not_pinned( string $id, Vault $registry ): void {
		if ( $registry->is_config_server( $id ) ) {
			throw new \RuntimeException( \esc_html( "pinned by the config file, so it cannot be changed here: {$id}" ) );
		}
	}

	/**
	 * Announce a Vault mutation, so nothing here has to act on its consequences.
	 *
	 * `Bootstrap` listens twice: it forgets the spoke's command session, and it
	 * asks every Remote_Link and Remote_Source worker holding those credentials
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
	 * @param list<string> $args Verb argument tokens; the id is the first positional.
	 * @return array<string,mixed> The sanitised probe response.
	 * @throws \RuntimeException When no entry claims that id, or the spoke does not answer usably.
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
	 * Ask a spoke's `discovery` node what it is running, over the shared
	 * blocking probe, and whitelist the answer:
	 *   { id, status: 'connected', response: {registered_hooks, custom_events, lag} }
	 *
	 * `status` is a constant because every failure throws inside
	 * `HTTP_Out_Node::probe_command()` — an unreachable host, a non-200, a body
	 * carrying no reply. An operator asking whether a spoke answers gets a
	 * verdict, not a field to interpret.
	 *
	 * Three keys survive the whitelist, each coerced to the type it claims. A
	 * spoke answers with whatever it likes, and forwarding that verbatim would
	 * give a remote a say in what this site renders.
	 *
	 * @param string              $id     Server id, which also picks the session key the command is signed under.
	 * @param array<string,mixed> $server Decrypted server config from the registry.
	 * @return array<string,mixed> Sanitised probe response.
	 * @throws \RuntimeException When the spoke cannot be reached or does not answer usably.
	 */
	private static function probe_remote( string $id, array $server ): array {
		$body = HTTP_Out_Node::probe_command( $id, $server, 'discovery', 'get' );

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
	 * Pull the one required positional id out of the argument tokens, refusing
	 * when it is absent.
	 *
	 * `get`, `delete` and `test` take nothing else. `update` parses its own
	 * tokens, because it reads the options in the same pass.
	 *
	 * @param list<string> $args Verb argument tokens.
	 * @return string Server id.
	 * @throws \RuntimeException When no positional id is present.
	 */
	private static function positional_id( array $args ): string {
		$id = Command_Args::parse( $args )['positional'][0] ?? '';
		if ( '' === $id ) {
			throw new \RuntimeException( 'id required' );
		}
		return $id;
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
