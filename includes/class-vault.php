<?php
/**
 * Vault: the credentials for every spoke this site connects OUT to.
 *
 * `HTTP_Out_Node` and `Remote_Link_Node` each name a Vault id and resolve that
 * spoke's URL and Authorization header here, so one store answers "how do I
 * reach this server" for the whole graph. `Sessions` is the mirror — it holds
 * the command sessions this site issues to callers coming IN.
 *
 * Two sources feed one view. `newspack-nodes-config.php` pins the entries an
 * operator deploys beside the code; the `newspack_nodes_vault` option holds the
 * ones the Vault tab writes, and wins wherever an id appears in both. A file
 * entry is immutable through this API, because a stored override would shadow
 * the file forever and outlive the deploy that changed it.
 *
 * Passwords are sealed at rest under a key derived from `wp_salt( 'auth' )` and
 * opened on the way out, so every caller holds plaintext and the option never
 * does.
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes;

if ( ! \defined( 'ABSPATH' ) ) {
	exit;
}

/**
 * The merged registry, memoized for the life of the process.
 *
 * That memo is why `reset_cache()` and `reset()` exist: a worker runs about ten
 * minutes, so with no drop signal it keeps serving a password the operator has
 * already rotated. `Config::RESET_ACTION` is that signal.
 */
class Vault {

	/**
	 * Marks a stored value as encrypted. A value without it is plaintext, which
	 * is what lets `decrypt()` run over every entry unconditionally.
	 */
	public const ENCRYPTED_PREFIX = '$enc$';

	/**
	 * Ceiling `add()` enforces against the merged count. It bounds what the admin
	 * UI can write; a config file declaring more is not refused, because that file
	 * is the operator's own deploy.
	 */
	public const MAX_SERVERS = 100;

	/**
	 * WP option holding the operator-written half of the registry.
	 * Non-autoloaded; `write_option()` says why.
	 */
	public const OPTION_KEY = 'newspack_nodes_vault';

	/** The config-array key the same registry occupies; see Config's token resolver. */
	public const CONFIG_KEY = 'vault';

	/**
	 * The only keys `update()` takes from a caller. Everything else in the partial
	 * is dropped before the merge, so a form post cannot reach a stored key this
	 * class does not manage.
	 */
	private const ALLOWED_KEYS = [ 'url', 'auth_username', 'auth_password' ];

	/**
	 * Singleton instance.
	 *
	 * @var Vault|null
	 */
	private static ?Vault $instance = null;

	/**
	 * Memoized merged view: config-file defaults under the WP option overlay,
	 * credentials already decrypted. Null until the first read builds it.
	 *
	 * @var array<string,array<string,mixed>>|null
	 */
	private ?array $servers = null;

	/**
	 * Public so a caller can hold its own instance rather than the singleton.
	 * The class does no construction work; every read builds itself lazily.
	 */
	public function __construct() {
		// Intentionally empty.
	}

	/**
	 * Every server in the Vault, under the name that reads as intent.
	 *
	 * A spoke is enabled by being present — wired into the graph — so no stored
	 * flag decides it and this is an alias for `get_all()`. It keeps a name of its
	 * own so a caller expressing "the enabled spokes" stays readable.
	 *
	 * @api
	 * @return array<array-key,array<string,mixed>> Keys are array-key, not string: PHP coerces a numeric server id to int.
	 */
	public function get_enabled(): array {
		return $this->get_all();
	}

	/**
	 * One server from the merged view, credentials decrypted.
	 *
	 * @api
	 * @param string $id Server id.
	 * @return array<string,mixed>|null The config, or null when no entry claims that id.
	 */
	public function get( string $id ): ?array {
		$servers = $this->get_all();
		return $servers[ $id ] ?? null;
	}

	/**
	 * Register a new server.
	 *
	 * The stored entry is exactly `validate_config()`'s three-key projection.
	 * Unlike `update()`, nothing is carried over from what was there before,
	 * because a new id has nothing to carry.
	 *
	 * Refuses, returning false, when the id is malformed, the id already exists in
	 * the merged view, the registry sits at `MAX_SERVERS`, the config fails
	 * validation, or the write does not survive the re-read that verifies it.
	 *
	 * @api
	 * @param string              $id     Server id (letters, digits, hyphen, underscore; 1-64 chars).
	 * @param array<string,mixed> $config Server configuration.
	 * @return bool True when the entry is stored.
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
	 * @param string              $id      Server id.
	 * @param array<string,mixed> $partial Partial configuration to merge.
	 * @param string              $new_id  Id to move the entry to; '' keeps the current one.
	 * @return bool True when the entry is stored under its target id.
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
	 * Project a raw configuration onto the three keys this class manages,
	 * sanitized, with the password sealed.
	 *
	 * A missing, non-string or non-HTTPS URL refuses the whole config: plain HTTP
	 * would put the credential on the wire in the clear. The username goes through
	 * `sanitize_text_field()`, or a control-character strip where WordPress is not
	 * loaded; the password is stripped of control characters. Both cap at 256
	 * bytes.
	 *
	 * A password arriving with `ENCRYPTED_PREFIX` is one the caller read back out
	 * of storage, so it is verified rather than re-sealed, and dropped when it no
	 * longer opens under the current key.
	 *
	 * @param array<string,mixed> $config Raw configuration.
	 * @return array<string,mixed>|null The url, auth_username and auth_password triple, or null when invalid.
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
	 * Seal a value for storage as `$enc$<base64 of nonce and ciphertext>`.
	 *
	 * Empty input, or a site without libsodium, yields the empty string, and the
	 * caller stores that: such a site holds no password rather than a plaintext
	 * one.
	 *
	 * @param string $plaintext Value to encrypt.
	 * @return string The prefixed wire format, or '' when nothing was sealed.
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
	 * Delete an option-backed server.
	 *
	 * A config-file entry is refused: the file still declares it, so the delete
	 * would report success and the entry would reappear on the next read.
	 *
	 * @api
	 * @param string $id Server id.
	 * @return bool True when the entry is gone from the option.
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
	 * Journal one credential mutation through `Core::stderr()`.
	 *
	 * The substrate's own diagnostic path, never the event logger: an audit line
	 * has to survive the log pipeline being the unhealthy thing, and this one
	 * reaches `error_log` plus the REPL's `dmesg` ring either way.
	 *
	 * Field NAMES only, never values — a log is exactly where a credential must
	 * not appear.
	 *
	 * @param string        $action Verb: added, updated, renamed or removed.
	 * @param string        $id     Server id acted upon.
	 * @param array<string> $fields Names of the fields written.
	 * @param string        $detail One extra `key=value` token, for what $id cannot say.
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
	 *
	 * @return int Parameters `update_option()` declares; 2 when reflection fails.
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
	 * The option-backed half of the registry, without the config-file defaults.
	 *
	 * Every write path reads through this, so a config-file default is never
	 * copied into the option — a copy would shadow the file's own value forever.
	 *
	 * @return array<array-key,mixed>
	 */
	private function get_wp_servers(): array {
		$option = \get_option( self::OPTION_KEY, [] );
		return Core::arr( $option );
	}

	/**
	 * Whether a server id originates from the config file.
	 *
	 * Reads file-only defaults via `Config::load_config_defaults()` to avoid the
	 * circular case where `load_config()` would merge the WP option into
	 * `vault` and make every WP-option server look like a config server.
	 *
	 * @api
	 * @param string $id Server id.
	 * @return bool True when the config file declares the server.
	 */
	public function is_config_server( string $id ): bool {
		$defaults = \Newspack_Nodes\Config::load_config_defaults();
		$file     = $defaults['vault'] ?? [];
		return \is_array( $file ) && isset( $file[ $id ] );
	}

	/**
	 * The whole registry: config-file defaults under the WP option, every entry
	 * filled out to the three managed keys and its password opened.
	 *
	 * The merge is `+`, not `array_merge()`, which would renumber an integer
	 * server id. Memoized for the process, so `reset_cache()` is the only way back
	 * to the file and the option.
	 *
	 * @api
	 * @return array<array-key,array<string,mixed>> Map of vault id => config. Keys are
	 *                                              array-key, not string, because PHP coerces a
	 *                                              numeric server id to int — callers must not
	 *                                              assume string.
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
				// Decrypt; an unprefixed value passes through as plaintext.
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
	 * Open a stored value.
	 *
	 * A value without `ENCRYPTED_PREFIX` is plaintext and passes through
	 * untouched. That is what lets an operator write a credential into the config
	 * file by hand, and it is why the prefix is checked before any base64 decode,
	 * which would eat the spaces out of a passphrase.
	 *
	 * @param string $stored Stored value, sealed or plain.
	 * @return string The plaintext, the input itself when it carries no prefix, or '' when it will not open.
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
	 * Derive the secretbox key from `wp_salt( 'auth' )`.
	 *
	 * The salt IS the key, so rotating `AUTH_KEY` or `AUTH_SALT` leaves every
	 * stored password unopenable and each spoke needs its credential retyped.
	 *
	 * @return string 32-byte key for `sodium_crypto_secretbox()`.
	 */
	private static function encryption_key(): string {
		return \sodium_crypto_generichash( \wp_salt( 'auth' ), '', SODIUM_CRYPTO_SECRETBOX_KEYBYTES );
	}

	/**
	 * Whether a string may name a Vault entry.
	 *
	 * The id becomes an array key in the option, a bare token in the audit line,
	 * and a segment of a message path — a Test button mints FROM
	 * `vault:test:in/<id>` and reads the echo back off it. Excluding `/`,
	 * whitespace and quotes is what keeps all three unquoted.
	 *
	 * @param string $id Candidate server id.
	 * @return bool True for 1-64 characters of letters, digits, hyphen and underscore.
	 */
	public static function is_valid_id( string $id ): bool {
		return 1 === \preg_match( '/^[a-zA-Z0-9_-]{1,64}$/', $id );
	}

	/**
	 * `credential_header()` reached with a whole decrypted entry, so a caller
	 * holding the record does not spell the three key names itself.
	 *
	 * @param array<array-key,mixed> $server Decrypted vault server config.
	 * @return string The header value, or '' when the entry carries no credential.
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
	 * probe — and a rule spelled three times is a rule they can disagree about:
	 * a probe that skips the Bearer token leaves a token-only spoke reachable by
	 * the graph and unreachable by the operator's own Test button.
	 *
	 * @param string $user  Stored username.
	 * @param string $pass  Stored password.
	 * @param string $token Stored bearer token.
	 * @return string `Basic <base64 of user:pass>`, `Bearer <token>`, or ''.
	 */
	public static function credential_header( string $user, string $pass, string $token = '' ): string {
		if ( '' !== $user && '' !== $pass ) {
			// phpcs:ignore WordPress.PHP.DiscouragedPHPFunctions.obfuscation_base64_encode -- HTTP Basic Auth.
			return 'Basic ' . \base64_encode( $user . ':' . $pass );
		}
		return '' === $token ? '' : 'Bearer ' . $token;
	}

	/**
	 * The singleton with its memo dropped — for request-scope readers (the
	 * service CIs) that must see a write from earlier in the same request.
	 *
	 * @api
	 * @return Vault The singleton, guaranteed to read through to storage next.
	 */
	public static function fresh(): Vault {
		$instance = self::get_instance();
		$instance->reset_cache();
		return $instance;
	}

	/**
	 * Singleton accessor, building the instance on first call.
	 *
	 * @api
	 * @return Vault The process-wide instance.
	 */
	public static function get_instance(): Vault {
		if ( null === self::$instance ) {
			self::$instance = new self();
		}
		return self::$instance;
	}

	/**
	 * Drop the memo so the next read rebuilds from the config file and the option.
	 *
	 * `fresh()` calls it for a request-scope reader that must see a write from
	 * earlier in the same request; `reset()` calls it on the config-reload signal,
	 * which is how a running worker picks up a rotated credential.
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
