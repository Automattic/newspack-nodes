<?php
/**
 * Vault
 *
 * Singleton credential store for remote server configurations stored in WordPress options.
 * Servers are stored in the 'newspack_nodes_vault' option as an associative array.
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes;

if ( ! \defined( 'ABSPATH' ) ) {
	exit;
}

/**
 * Vault class.
 */
class Vault {

	/**
	 * Prefix marking encrypted values (distinguishes from legacy plaintext).
	 */
	public const ENCRYPTED_PREFIX = '$enc$';

	/**
	 * Maximum number of servers in the registry.
	 */
	public const MAX_SERVERS = 100;

	/**
	 * WP option name for storing server configurations.
	 */
	public const OPTION_KEY = 'newspack_nodes_vault';

	/**
	 * Whitelisted config keys for partial-update merge.
	 */
	private const ALLOWED_KEYS = [ 'url', 'auth_username', 'auth_password' ];

	/**
	 * Singleton instance.
	 *
	 * @var Vault|null
	 */
	private static ?Vault $instance = null;

	/**
	 * Cached merged servers (config-file defaults + WP option overlay).
	 *
	 * @var array<string,array<string,mixed>>|null
	 */
	private ?array $servers = null;

	/**
	 * Public constructor — kept public for direct instantiation in tests.
	 */
	public function __construct() {
		// Intentionally empty.
	}

	/**
	 * Get enabled servers — now an alias for get_all().
	 *
	 * The stored `enabled` boolean was removed: a spoke is "enabled" by being
	 * present in the Vault (wired into the graph). Kept as a named method so
	 * callers that express the "enabled spokes" intent stay readable.
	 *
	 * @api
	 * @return array<array-key,array<string,mixed>> Keys are array-key (not string): PHP coerces numeric server-id keys to int.
	 */
	public function get_enabled(): array {
		return $this->get_all();
	}

	/**
	 * Get a specific server by ID.
	 *
	 * @api
	 * @param string $id Server ID.
	 * @return array<string,mixed>|null Server config or null if not found.
	 */
	public function get( string $id ): ?array {
		$servers = $this->get_all();
		return $servers[ $id ] ?? null;
	}

	/**
	 * Add a new server (full overwrite if the caller supplies a complete config).
	 *
	 * Returns false if:
	 *  - id format invalid
	 *  - id already exists in the merged view
	 *  - registry at capacity
	 *  - validation fails (URL, credentials)
	 *
	 * @api
	 * @param string $id     Server ID (alphanumeric, hyphen, underscore; 1-64 chars).
	 * @param array<string,mixed>  $config Server configuration.
	 */
	public function add( string $id, array $config ): bool {
		if ( ! self::is_valid_id( $id ) ) {
			return false;
		}
		$all = $this->get_all();
		if ( isset( $all[ $id ] ) ) {
			return false;
		}
		if ( \count( $all ) >= self::MAX_SERVERS ) {
			return false;
		}
		$validated = $this->validate_config( $config );
		if ( null === $validated ) {
			return false;
		}

		$wp_servers        = $this->get_wp_servers();
		$wp_servers[ $id ] = $validated;

		// update_option() false on failure/no-op; re-read to verify.
		self::write_option( $wp_servers );
		$this->servers = null;

		$verify = $this->get_wp_servers();
		if ( ! isset( $verify[ $id ] ) ) {
			return false;
		}

		$this->audit( 'added', $id, \array_keys( $validated ) );
		return true;
	}

	/**
	 * Partial-update an existing server, optionally under a NEW id. Whitelists
	 * keys, merges with current config, then validates the result.
	 *
	 * The id is a field like any other on an edit form, so a rename rides the
	 * same call rather than a verb of its own: both halves land in ONE option
	 * write, and a refused move applies nothing. The entry carries every stored
	 * key across, validated or not — the operator editing a spoke never retypes
	 * a credential, and never silently loses one this projection cannot see.
	 *
	 * Config-file servers are fully immutable — URL and credentials are pinned
	 * by the file, so update() is a no-op (returns false) for those entries.
	 *
	 * @api
	 * @param string $id      Server ID.
	 * @param array<string,mixed>  $partial Partial configuration to merge.
	 * @param string $new_id  Id to move the entry to; '' keeps the current one.
	 */
	public function update( string $id, array $partial, string $new_id = '' ): bool {
		if ( ! self::is_valid_id( $id ) ) {
			return false;
		}
		$all = $this->get_all();
		if ( ! isset( $all[ $id ] ) ) {
			return false;
		}

		// Config-file servers are fully immutable.
		if ( $this->is_config_server( $id ) ) {
			return false;
		}

		// The entry keeps its id unless a valid, unclaimed one is asked for.
		$target   = '' === $new_id ? $id : $new_id;
		$renaming = $target !== $id;
		if ( $renaming && ( ! self::is_valid_id( $target ) || isset( $all[ $target ] ) ) ) {
			return false;
		}

		// Whitelist keys before merge.
		$partial = \array_intersect_key( $partial, \array_flip( self::ALLOWED_KEYS ) );

		$merged    = \array_merge( $all[ $id ], $partial );
		$validated = $this->validate_config( $merged );
		if ( null === $validated ) {
			return false;
		}

		$wp_servers = $this->get_wp_servers();
		if ( $renaming ) {
			// One write does the move; no reader sees both ids or neither.
			unset( $wp_servers[ $id ] );
		}
		// `+` carries stored keys the projection can't see, `token` among them.
		$wp_servers[ $target ] = $validated + $merged;

		self::write_option( $wp_servers );
		$this->servers = null;

		$verify = $this->get_wp_servers();
		if ( ! isset( $verify[ $target ] ) || ( $renaming && isset( $verify[ $id ] ) ) ) {
			return false;
		}

		if ( $renaming ) {
			$this->audit( 'renamed', $target, \array_keys( $partial ), "from={$id}" );
		} else {
			$this->audit( 'updated', $id, \array_keys( $partial ) );
		}
		return true;
	}

	/**
	 * Validate and sanitize a full server configuration.
	 *
	 * @param array<string,mixed> $config Raw configuration.
	 * @return array<string,mixed>|null Validated configuration or null if invalid.
	 */
	private function validate_config( array $config ): ?array {
		// URL is required, must be string, must be HTTPS.
		if ( empty( $config['url'] ) || ! \is_string( $config['url'] ) ) {
			return null;
		}
		$url = \function_exists( 'esc_url_raw' )
			? \esc_url_raw( $config['url'] )
			: $config['url'];
		if ( '' === $url ) {
			return null;
		}
		if ( 0 !== \strpos( $url, 'https://' ) ) {
			return null;
		}

		$validated = [
			'url'           => \rtrim( $url, '/' ),
			'auth_username' => '',
			'auth_password' => '',
		];

		// auth_username — sanitize + 256-byte cap.
		if ( ! empty( $config['auth_username'] ) && \is_string( $config['auth_username'] ) ) {
			$username = \function_exists( 'sanitize_text_field' )
				? \sanitize_text_field( $config['auth_username'] )
				: \trim( \preg_replace( '/[\x00-\x1f\x7f]/', '', $config['auth_username'] ) ?? '' );
			if ( \strlen( $username ) > 256 ) {
				$username = \substr( $username, 0, 256 );
			}
			$validated['auth_username'] = $username;
		}

		// auth_password — strip control chars, 256-byte cap, encrypt.
		if ( ! empty( $config['auth_password'] ) && \is_string( $config['auth_password'] ) ) {
			$password = $config['auth_password'];
			if ( 0 !== \strpos( $password, self::ENCRYPTED_PREFIX ) ) {
				// New plaintext password — sanitize, cap, encrypt.
				$password = \preg_replace( '/[\x00-\x1f\x7f]/', '', $password ) ?? '';
				if ( \strlen( $password ) > 256 ) {
					$password = \substr( $password, 0, 256 );
				}
				$password = self::encrypt( $password );
			} else {
				// Already encrypted — verify it decrypts; reject if not.
				$decrypted = self::decrypt( $password );
				if ( '' === $decrypted ) {
					$password = '';
				}
			}
			$validated['auth_password'] = $password;
		}

		return $validated;
	}

	/**
	 * Encrypt a string for storage.
	 *
	 * Returns the wire-format string (`$enc$<base64>`) on success, or empty on
	 * failure / empty input.
	 *
	 * @param string $plaintext Value to encrypt.
	 */
	private static function encrypt( string $plaintext ): string {
		if ( '' === $plaintext || ! \function_exists( 'sodium_crypto_secretbox' ) ) {
			return '';
		}
		$nonce      = \random_bytes( SODIUM_CRYPTO_SECRETBOX_NONCEBYTES );
		$ciphertext = \sodium_crypto_secretbox( $plaintext, $nonce, self::encryption_key() );
		// phpcs:ignore WordPress.PHP.DiscouragedPHPFunctions.obfuscation_base64_encode -- binary-safe storage.
		return self::ENCRYPTED_PREFIX . \base64_encode( $nonce . $ciphertext );
	}

	/**
	 * Remove a server.
	 *
	 * Config-file servers can't be removed via the API — they reappear on next
	 * read. Returns false for those entries.
	 *
	 * @api
	 * @param string $id Server ID.
	 */
	public function remove( string $id ): bool {
		if ( ! self::is_valid_id( $id ) ) {
			return false;
		}
		$all = $this->get_all();
		if ( ! isset( $all[ $id ] ) ) {
			return false;
		}
		if ( $this->is_config_server( $id ) ) {
			return false;
		}

		$wp_servers = $this->get_wp_servers();
		unset( $wp_servers[ $id ] );

		self::write_option( $wp_servers );
		$this->servers = null;

		$verify = $this->get_wp_servers();
		if ( isset( $verify[ $id ] ) ) {
			return false;
		}

		$this->audit( 'removed', $id, [] );
		return true;
	}

	/**
	 * Append an audit-trail entry to PHP error_log.
	 *
	 * Goes to error_log (not LogManager) intentionally: avoids feedback loops if
	 * the log pipeline itself is unhealthy.
	 *
	 * @param string $action Verb: added | updated | renamed | removed | registered.
	 * @param string $id     Server ID acted upon.
	 * @param array<string>  $fields Field names (sanitized — never values).
	 * @param string $detail One extra `key=value` token, for what $id cannot say.
	 */
	private function audit( string $action, string $id, array $fields, string $detail = '' ): void {
		$user_id  = \function_exists( 'get_current_user_id' ) ? \get_current_user_id() : 0;
		$ts       = \gmdate( 'c' );
		$fieldstr = empty( $fields ) ? '' : ' fields=' . \implode( ',', $fields );
		$detail   = '' === $detail ? '' : " {$detail}";
		Core::stderr(
			\sprintf(
				'[NewspackNodes] Vault %s id=%s user=%d ts=%s%s%s',
				$action,
				$id,
				$user_id,
				$ts,
				$fieldstr,
				$detail
			)
		);
	}

	/**
	 * Persist the WP-managed server map.
	 *
	 * Uses 3-arg form when WP's full update_option is available (the third arg
	 * marks the option as non-autoloaded so it doesn't bloat every request's
	 * option cache); falls back to 2-arg for stripped-down test stubs.
	 *
	 * @param array<array-key,mixed> $wp_servers Map of id => validated config.
	 */
	private static function write_option( array $wp_servers ): void {
		$arity = self::update_option_arity();
		if ( $arity >= 3 ) {
			\update_option( self::OPTION_KEY, $wp_servers, false );
		} else {
			\update_option( self::OPTION_KEY, $wp_servers );
		}
	}

	/**
	 * Reflect on update_option once to determine its parameter count.
	 *
	 * Production WP defines a 3-arg update_option (option, value, autoload).
	 * Test bootstraps may define a 2-arg fake. Cached for the process.
	 */
	private static function update_option_arity(): int {
		/** @var int|null $arity */
		static $arity = null;
		if ( null === $arity ) {
			try {
				$arity = ( new \ReflectionFunction( 'update_option' ) )->getNumberOfParameters();
			} catch ( \ReflectionException $e ) {
				$arity = 2;
			}
		}
		return $arity;
	}

	/**
	 * Get only the WP-option-managed servers (excludes config-file defaults).
	 *
	 * Write paths use this so we never accidentally persist a config-file
	 * default into the WP option (would shadow file changes forever).
	 *
	 * @return array<array-key,mixed>
	 */
	private function get_wp_servers(): array {
		$option = \get_option( self::OPTION_KEY, [] );
		return Core::arr( $option );
	}

	/**
	 * Check whether a server ID originates from the config file.
	 *
	 * Reads file-only defaults via `Config::load_config_defaults()` to avoid the
	 * circular case where `load_config()` would merge the WP option into
	 * `vault` and make every WP-option server look like a config server.
	 *
	 * @api
	 * @param string $id Server ID.
	 * @return bool True if the server is defined in the config file.
	 */
	public function is_config_server( string $id ): bool {
		$defaults = \Newspack_Nodes\Config::load_config_defaults();
		$file     = $defaults['vault'] ?? [];
		return \is_array( $file ) && isset( $file[ $id ] );
	}

	/**
	 * Get all servers.
	 *
	 * Merges config file defaults with WordPress option values.
	 * WordPress option values override config file defaults.
	 *
	 * @api
	 * @return array<array-key,array<string,mixed>> Associative array of vault id => config. Keys are
	 *                                                 array-key (not string) because PHP coerces numeric
	 *                                                 server-id keys to int — callers must not assume string.
	 */
	public function get_all(): array {
		if ( null === $this->servers ) {
			// Read file defaults DIRECTLY; load_config cache zombies deletes.
			$config_defaults = \Newspack_Nodes\Config::load_config_defaults()['vault'] ?? [];
			if ( ! \is_array( $config_defaults ) ) {
				$config_defaults = [];
			}

			// Get WordPress option (may override config defaults).
			$option = \get_option( self::OPTION_KEY, null );

			if ( \is_array( $option ) ) {
				// Use `+` not array_merge (renumbers int server-id keys).
				$merged = $option + $config_defaults;
			} else {
				// No (or non-array) option - use config defaults.
				$merged = $config_defaults;
			}

			// Normalize: file entries skip validate_config; may lack keys.
			$normalized = [];
			foreach ( $merged as $id => $server ) {
				if ( ! \is_array( $server ) ) {
					continue;
				}
				/** @var array<string,mixed> $server — config map is string-keyed by design. */
				$server += [
					'url'           => '',
					'auth_username' => '',
					'auth_password' => '',
				];
				// Decrypt credentials (encrypted or legacy plaintext).
				$pw = $server['auth_password'];
				if ( '' !== $pw && \is_scalar( $pw ) ) {
					$server['auth_password'] = self::decrypt( (string) $pw );
				}
				$normalized[ (string) $id ] = $server;
			}
			$this->servers = $normalized;
		}
		return $this->servers;
	}

	/**
	 * Decrypt a stored value.
	 *
	 * Handles both encrypted (prefixed) and legacy plaintext values. A pre-
	 * encryption row passes through unchanged so spoke upgrades don't break.
	 *
	 * @param string $stored Stored value (may be encrypted or plaintext).
	 * @return string Decrypted plaintext, original value if not encrypted, or empty on decrypt failure.
	 */
	private static function decrypt( string $stored ): string {
		// No ENCRYPTED_PREFIX = plaintext; else base64_decode nukes spaces.
		if ( 0 !== \strpos( $stored, self::ENCRYPTED_PREFIX ) ) {
			return $stored;
		}
		if ( ! \function_exists( 'sodium_crypto_secretbox_open' ) ) {
			return '';
		}
		// phpcs:ignore WordPress.PHP.DiscouragedPHPFunctions.obfuscation_base64_decode -- binary-safe storage.
		$decoded = \base64_decode( \substr( $stored, \strlen( self::ENCRYPTED_PREFIX ) ), true );
		if ( false === $decoded || \strlen( $decoded ) < SODIUM_CRYPTO_SECRETBOX_NONCEBYTES ) {
			return '';
		}
		$nonce      = \substr( $decoded, 0, SODIUM_CRYPTO_SECRETBOX_NONCEBYTES );
		$ciphertext = \substr( $decoded, SODIUM_CRYPTO_SECRETBOX_NONCEBYTES );
		$plaintext  = \sodium_crypto_secretbox_open( $ciphertext, $nonce, self::encryption_key() );
		return false === $plaintext ? '' : $plaintext;
	}

	/**
	 * Derive a 32-byte encryption key from `wp_salt('auth')`.
	 *
	 * @return string 32-byte key for sodium_crypto_secretbox.
	 */
	private static function encryption_key(): string {
		return \sodium_crypto_generichash( \wp_salt( 'auth' ), '', SODIUM_CRYPTO_SECRETBOX_KEYBYTES );
	}

	public static function is_valid_id( string $id ): bool {
		return 1 === \preg_match( '/^[a-zA-Z0-9_-]{1,64}$/', $id );
	}

	/**
	 * `credential_header()` for a decrypted server config entry.
	 *
	 * @param array<array-key,mixed> $server Decrypted vault server config.
	 * @return string The header value, or ''.
	 */
	public static function credential_header_for( array $server ): string {
		return self::credential_header(
			Core::as_string( $server['auth_username'] ?? '' ),
			Core::as_string( $server['auth_password'] ?? '' ),
			Core::as_string( $server['token'] ?? '' )
		);
	}

	/**
	 * THE `Authorization` header value for a spoke's stored credentials, or ''
	 * when it needs none. Basic wins over Bearer: a config carrying both means
	 * the operator set a username and password, which is the more specific
	 * statement.
	 *
	 * Lives on the Vault because the Vault owns credentials. Three transports
	 * reach a spoke — HTTP_Out (push), SSE_In (pull) and HTTP_Out's blocking
	 * probe — and each spelled this rule itself, so they could disagree about
	 * what a stored credential means. One of them already did: the blocking
	 * probe never learned the Bearer token, leaving a token-only spoke
	 * reachable by the graph and unreachable by the operator's own test.
	 *
	 * @param string $user  Stored username.
	 * @param string $pass  Stored password.
	 * @param string $token Stored bearer token.
	 * @return string e.g. `Basic <base64 of user:pass>`, or ''.
	 */
	public static function credential_header( string $user, string $pass, string $token = '' ): string {
		if ( '' !== $user && '' !== $pass ) {
			// phpcs:ignore WordPress.PHP.DiscouragedPHPFunctions.obfuscation_base64_encode -- HTTP Basic Auth.
			return 'Basic ' . \base64_encode( $user . ':' . $pass );
		}
		return '' === $token ? '' : 'Bearer ' . $token;
	}

	/**
	 * The singleton with its in-process cache dropped — for request-scope
	 * readers (service CIs) that must see writes from earlier in the same
	 * request.
	 *
	 * @api
	 */
	public static function fresh(): Vault {
		$instance = self::get_instance();
		$instance->reset_cache();
		return $instance;
	}

	/**
	 * Singleton accessor.
	 *
	 * @api
	 */
	public static function get_instance(): Vault {
		if ( null === self::$instance ) {
			self::$instance = new self();
		}
		return self::$instance;
	}

	/**
	 * Reset the in-process cache so the next read rebuilds from disk + option.
	 *
	 * Long-running workers (JobWorker) call this between jobs so post-admin
	 * updates are visible without a process restart.
	 *
	 * @api
	 */
	public function reset_cache(): void {
		$this->servers = null;
	}

	/**
	 * Drop the singleton's memoized entries. Wired to Config::RESET_ACTION, the
	 * one signal every process-lifetime cache answers to — without it a worker
	 * that read the Vault once serves those credentials until it recycles, so a
	 * rotated password reconnects a healthy spoke with the old one.
	 */
	public static function reset(): void {
		self::$instance?->reset_cache();
	}
}
