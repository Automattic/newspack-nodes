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
 * class owns there is the verdict it reduces the spoke's reply to.
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
	 * Credential option name => stored config key. An operator types `--user=`
	 * and `--password=`; the store, the node arguments and the wire keep the
	 * `auth_` spelling. This one declaration is what the parser accepts and what
	 * the two config builders write, so a rename here moves all three.
	 */
	private const CREDENTIAL_OPTION_TO_KEY = [
		'user'     => 'auth_username',
		'password' => 'auth_password',
	];

	/**
	 * Verb option name => stored config key, for the three fields `add` and
	 * `update` write. One declaration serves both the whole blob and the partial
	 * one; `url` is the same word on both sides.
	 */
	private const OPTION_TO_KEY = [ 'url' => 'url' ] + self::CREDENTIAL_OPTION_TO_KEY;

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
	 * @param list<string> $args Verb argument tokens: `<id> --url=<url> [--user=<u>] [--password=<p>]`.
	 * @return array<string,mixed> The stored id, as `[ 'id' => <id> ]`.
	 * @throws \RuntimeException When an option is not one this verb reads or
	 *                           carries no value, the url is absent, the id is
	 *                           malformed or taken, or the store refuses the entry.
	 */
	public static function cmd_add( array $args ): array {
		$parsed = Command_Args::parse( $args );
		$opts   = self::assert_known_options( $parsed['options'], \array_keys( self::OPTION_TO_KEY ) );
		if ( ! isset( $opts['url'] ) ) {
			throw new \RuntimeException( 'url required: write --url=<https url>' );
		}
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
	 * @param array<string,string> $opts Checked `--key=value` options.
	 * @return array<string,mixed> The url, auth_username and auth_password triple.
	 */
	private static function extract_server_config( array $opts ): array {
		$config = [];
		foreach ( self::OPTION_TO_KEY as $option => $key ) {
			$config[ $key ] = $opts[ $option ] ?? '';
		}
		return $config;
	}

	/**
	 * `update` verb handler — merge the options actually present into an
	 * existing entry, moving it when `--new_id` names somewhere else. Returns
	 * the id the entry now carries.
	 *
	 * @param list<string> $args Verb argument tokens: `<id> [--new_id=<id>] [--url=<url>] [--user=<u>] [--password=<p>]`.
	 * @return array<string,mixed> The entry's id after the write, as `[ 'id' => <id> ]`.
	 * @throws \RuntimeException When an option is not one this verb reads or carries
	 *                           no value, the id is absent or unknown, the config file
	 *                           pins the entry, the new id is unusable, or the store
	 *                           refuses the write.
	 */
	public static function cmd_update( array $args ): array {
		$parsed = Command_Args::parse( $args );
		$opts   = self::assert_known_options( $parsed['options'], [ 'new_id', ...\array_keys( self::OPTION_TO_KEY ) ] );
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
		$new_id = self::renamed_to( $opts, $id, $registry );
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
	 * The id `update` was asked to move an entry to, checked against everything
	 * the store would otherwise refuse without saying why. Returns '' when the
	 * entry keeps the id it has.
	 *
	 * @param array<string,string> $opts     Checked `--key=value` options.
	 * @param string               $id       The entry's current id.
	 * @param Vault                $registry Backing vault.
	 * @return string The new id, or '' for no rename.
	 * @throws \RuntimeException When `--new_id` is malformed or taken.
	 */
	private static function renamed_to( array $opts, string $id, Vault $registry ): string {
		// Absent asks for no rename; present and unusable is a refusal.
		if ( ! isset( $opts['new_id'] ) ) {
			return '';
		}
		$named = $opts['new_id'];
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
	 * @param array<string,string> $opts Checked `--key=value` options.
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
	 * Refuse any option the verb cannot act on, naming it and the ones it takes.
	 *
	 * `Command_Args::parse()` admits any `--key=value`, and the schema's `args`
	 * list is palette and help metadata that nothing validates against — so an
	 * option the handler never looks up is dropped and the write reports
	 * success. That is silent in opposite directions: `add` stores an empty
	 * field and answers with the id it registered, and `update` reads the
	 * absence as "leave it alone" and answers a save that changed nothing. A
	 * typo, a stale spelling and an invented flag are one bug, so one rule
	 * catches all three, ahead of any lookup or write.
	 *
	 * The known set is what the verb actually READS, never what the schema
	 * renders: `id` is a positional, so `--id=` is as inert as any other
	 * unrecognized option and is refused with them.
	 *
	 * A known option carrying NO value is the same silent write in a second
	 * costume. `Command_Args::parse()` reads a bare `--key` as boolean true, and
	 * every option in the known set names a value — a stored field, or the id an
	 * entry moves to — so a shell that ate the value or an operator who forgot
	 * it otherwise casts to the literal '1' and stores that as the credential.
	 *
	 * @param array<string,string|true> $opts  Parsed `--key=value` options.
	 * @param list<string>              $known Option names this verb reads, each carrying a value.
	 * @return array<string,string> The same options, every value a string.
	 * @throws \RuntimeException When an option is not one the verb reads, or carries no value.
	 */
	private static function assert_known_options( array $opts, array $known ): array {
		$unknown = \array_diff( \array_keys( $opts ), $known );
		if ( [] !== $unknown ) {
			throw new \RuntimeException( \esc_html(
				'unknown option --' . \implode( ', --', $unknown )
				. '; this verb takes --' . \implode( ', --', $known )
			) );
		}
		$checked = [];
		foreach ( $opts as $option => $value ) {
			if ( ! \is_string( $value ) ) {
				throw new \RuntimeException( \esc_html( "--{$option} needs a value: write --{$option}=<value>" ) );
			}
			$checked[ $option ] = $value;
		}
		return $checked;
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
	 * @return array{id:string,status:string} The probe verdict.
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
					'description' => 'Add a new server; --url is required (manage_options).',
					'args'        => [
						[ 'name' => 'id', 'type' => 'string', 'required' => true ],
						[ 'name' => 'url', 'type' => 'string', 'required' => false ],
						[ 'name' => 'user', 'type' => 'string', 'required' => false ],
						[ 'name' => 'password', 'type' => 'string', 'required' => false ],
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
						[ 'name' => 'user', 'type' => 'string', 'required' => false ],
						[ 'name' => 'password', 'type' => 'string', 'required' => false ],
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
					'description' => "Probe a spoke's /command status endpoint with stored Basic Auth (manage_options).",
					'args'        => [
						[ 'name' => 'id', 'type' => 'string', 'required' => true ],
					],
					'handler'     => static fn ( Vault_CI_Node $self, array $args, array $envelope = [] ): array => self::cmd_test( self::arg_strings( $args ) ),
				],
			],
		] );
	}

}
