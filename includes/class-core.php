<?php
/**
 * Core: global registries + clock + stderr + fire-and-forget POST.
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes;

\defined( 'ABSPATH' ) || exit;

class Core {

	/**
	 * Property-name substrings whose value is a credential. dump_node() reflects
	 * EVERY property, so any node holding one of these would otherwise print the
	 * raw secret to the REPL / logs — redacted here for every node by default.
	 * Deliberately excludes bare `auth` so `auth_username` / `authorize` survive.
	 */
	private const SECRET_NAME_PATTERNS = [ 'password', 'passwd', 'secret', 'token', 'credential', 'api_key', 'apikey', 'private_key' ];

	/**
	 * Topology `<ns:key>` token resolvers, registered at boot.
	 *
	 * Each namespace owner registers its own resolver; there is no merged
	 * config array. Process-lifetime (NOT cleared by reset(), like namespace
	 * registrations).
	 *
	 * @var array<string,callable(string):mixed> ns => callable(string $key): mixed
	 */
	public static array $config_resolvers = [];

	/**
	 * libcurl-call seam. Lazily-defaulted at the call site to a closure wrapping
	 * the real libcurl call. Tests reassign in bootstrap to capture POST bodies
	 * without short-circuiting the curl_init / curl_setopt_array / errno-
	 * classification path — that lets the suite cover the real setopt + error-
	 * classification logic. Shared by Supervisor (spawn fan-out) and Worker_Base
	 * (self-respawn): one helper, one seam, single source of truth.
	 *
	 * Signature: `function (\CurlHandle $ch, array $body): mixed`.
	 *
	 * @var \Closure(\CurlHandle, array<string, mixed>): mixed|null
	 */
	public static ?\Closure $curl_exec = null;

	/** Process start time, stamped each Core::reset(); the `uptime` verb subtracts it from $now. */
	public static float $init_time = 0.0;

	/** @var float Seconds before a rate-limiter entry is eligible for pruning. */
	public static float $log_timeout = 60;

	/** Process-global shared Memcached handle; set once by the application bootstrap, null when unconfigured. */
	public static ?\Memcached $memd = null;

	/** @var array<string,Node> Registered nodes keyed by name; every entry is a Node ($this from Node::name()). */
	public static array $nodes_by_name = [];

	/** @var float Microsecond-resolution timestamp; updated by the event loop or in tests. */
	public static float $now = 0.0;

	/** @var array<string> */
	public static array $recent_log = [];

	/** @var array<string,float> Category → first-seen timestamp; pruned by prune_logs. */
	public static array $recent_log_timers = [];

	public static bool $shutting_down = false;

	/** @var array<string,string> Process-global Shell variable map. */
	public static array $var = [];

	/** Re-entry guard for stderr(); the default handler can recurse via _repl write failures. */
	private static bool $in_stderr = false;

	/** @var callable */
	private static $stderr_handler;

	public static function resolve_partition_template( string $template, int $p ): string {
		return self::resolve_config_tokens(
			\str_replace( [ '<partition>', '{partition}' ], (string) $p, $template )
		);
	}

	/** Resolve every `<ns:key>` token in $path via resolve_config_token; an unknown token becomes ''. */
	public static function resolve_config_tokens( string $path ): string {
		return (string) \preg_replace_callback(
			'/<([a-zA-Z_]\w*):([a-zA-Z_]\w*)>/',
			static fn ( array $m ): string => self::resolve_config_token( $m[1], $m[2] ),
			$path
		);
	}

	/** Resolve a `<ns:key>` topology token via its namespace resolver; '' (with a rate-limited warning) if the ns isn't registered or returns null. */
	public static function resolve_config_token( string $ns, string $key ): string {
		$resolver = self::$config_resolvers[ $ns ] ?? null;
		if ( null === $resolver ) {
			self::print_less_often( 'resolve_config_token: unknown namespace ', "<{$ns}:{$key}>" );
			return '';
		}
		$value = $resolver( $key );
		if ( null === $value ) {
			self::print_less_often( 'resolve_config_token: resolver returned null for ', "<{$ns}:{$key}>" );
			return '';
		}
		if ( ! \is_scalar( $value ) ) {
			self::print_less_often( 'resolve_config_token: resolver returned non-scalar for ', "<{$ns}:{$key}>" );
			return '';
		}
		return (string) $value;
	}

	/**
	 * Emit on first sight, then suppress (re-windowed by prune_logs). The
	 * throttle key is $text — the stable FIRST arg — ONLY; $extra is variable
	 * payload printed on the first occurrence but never folded into the key, so
	 * a flood of one category with differing values (Tachikoma's `$text, @extra`)
	 * collapses to one line instead of one per distinct value.
	 */
	public static function print_less_often( string $text, string ...$extra ): void {
		$timestamp = self::$recent_log_timers[ $text ] ?? null;
		if ( null === $timestamp ) {
			self::stderr( $text . \implode( '', $extra ) );
			self::$recent_log_timers[ $text ] = self::$now;
		}
	}

	public static function stderr( string $text ): void {
		if ( '' === $text ) {
			return;
		}
		$line = self::log_midfix( $text );
		self::$recent_log[] = self::log_prefix( $line );
		// Bounded tail for the REPL (Tachikoma caps @RECENT_LOG at 100).
		while ( \count( self::$recent_log ) > 100 ) {
			\array_shift( self::$recent_log );
		}
		self::_stderr( $line );
	}

	/**
	 * Per-line process-identity midfix.
	 *
	 * With no text, returns the bare midfix. With text, chomps a
	 * trailing newline, prepends the midfix to every line, and appends one
	 * trailing newline.
	 */
	public static function log_midfix( ?string $text = null ): string {
		$midfix = ( \gethostname() ?: 'unknown' ) . ' '
			. self::argv0() . '[' . \getmypid() . ']: ';
		if ( null === $text ) {
			return $midfix;
		}
		$text = \rtrim( $text, "\n" );
		// Prepend the midfix to the start of every line (Perl m///mg).
		$text = $midfix . \str_replace( "\n", "\n" . $midfix, $text );
		return $text . "\n";
	}

	/** Process identity for log_midfix: worker type when set, else SAPI. Public so Node::log_midfix can apply the $0-starts-with-name guard. */
	public static function argv0(): string {
		if ( isset( $_SERVER['NEWSPACK_NODES_WORKER_TYPE'] ) && \is_scalar( $_SERVER['NEWSPACK_NODES_WORKER_TYPE'] ) && '' !== $_SERVER['NEWSPACK_NODES_WORKER_TYPE'] ) {
			// phpcs:ignore WordPress.Security.ValidatedSanitizedInput.InputNotSanitized -- env var is set by SpawnController after HMAC auth.
			return \sanitize_text_field( \wp_unslash( (string) $_SERVER['NEWSPACK_NODES_WORKER_TYPE'] ) );
		}
		return \PHP_SAPI;
	}

	/**
	 * Per-line timestamp prefix.
	 *
	 * With no text, returns the bare prefix. With text, chomps a
	 * trailing newline, prepends the prefix to every line, and appends one
	 * trailing newline.
	 */
	public static function log_prefix( ?string $text = null ): string {
		$prefix = \gmdate( 'Y-m-d H:i:s' ) . ' UTC ';
		if ( null === $text ) {
			return $prefix;
		}
		$text = \rtrim( $text, "\n" );
		// Prepend the prefix to the start of every line (Perl m///mg).
		$text = $prefix . \str_replace( "\n", "\n" . $prefix, $text );
		return $text . "\n";
	}

	public static function _stderr( string $text ): void {
		if ( self::$in_stderr ) {
			// Re-entry guard: go straight to error_log to avoid recursion.
			// phpcs:ignore WordPress.PHP.DevelopmentFunctions.error_log_error_log
			\error_log( \rtrim( $text ) );
			return;
		}
		self::$in_stderr = true;
		try {
			( self::$stderr_handler )( $text );
		} finally {
			// Reset even if handler throws, else stderr latches to fallback.
			self::$in_stderr = false;
		}
	}

	/** Tear down every registered node; snapshots the registry first so unregister doesn't mutate the iteration source. */
	public static function cleanup_all_nodes(): void {
		$nodes = self::$nodes_by_name;
		foreach ( $nodes as $node ) {
			try {
				$node->remove_node();
			} catch ( \Throwable $e ) {
				// Best-effort: one node's failure shouldn't block the rest.
				self::stderr( 'cleanup_all_nodes: ' . $e->getMessage() );
			}
		}
	}

	public static function reset(): void {
		self::$nodes_by_name     = [];
		self::$shutting_down     = false;
		self::$recent_log        = [];
		self::$recent_log_timers = [];
		self::$in_stderr         = false;
		self::$var               = [];
		self::$memd              = null;
		self::set_stderr_handler( static function ( string $text ): void {
			$sink = self::$nodes_by_name[ Node_Names::REPL ]
				?? self::$nodes_by_name[ Node_Names::SSE ]
				?? self::$nodes_by_name[ Node_Names::OUTPUT ]
				?? null;
			if ( null !== $sink ) {
				$message                       = Message::new_message();
				$message[ Message::TYPE ]      = Message::TM_BYTESTREAM;
				$message[ Message::TIMESTAMP ] = self::$now;
				$message[ Message::VALUE ]     = self::log_prefix( $text );
				$sink->fill( $message );
			}
			// phpcs:ignore WordPress.PHP.DevelopmentFunctions.error_log_error_log
			\error_log( \rtrim( $text ) );
		} );
		self::$now       = \microtime( true );
		self::$init_time = self::$now;
		// Drop the timer set too, else an orphaned node's armed timer survives.
		Event_Framework::reset();
	}

	public static function set_stderr_handler( callable $h ): void {
		self::$stderr_handler = $h;
	}

	/** True while the stderr handler is on the stack; pump() reads it to skip a log-write stop. */
	public static function in_stderr(): bool {
		return self::$in_stderr;
	}

	/** Register a topology `<ns:key>` token resolver for namespace $ns (last writer wins). */
	public static function register_config_namespace( string $ns, callable $resolver ): void {
		self::$config_resolvers[ $ns ] = $resolver;
	}

	/**
	 * Perl length()-style presence: false for null and '', true for '0'.
	 *
	 * @phpstan-assert-if-true non-empty-string $s
	 */
	public static function has_value( ?string $s ): bool {
		return null !== $s && '' !== $s;
	}

	/** Canonical scalar→string read of a mixed Message field; '' for non-scalars (arrays/objects/null). */
	public static function as_string( mixed $value, string $default = '' ): string {
		return \is_scalar( $value ) ? (string) $value : $default;
	}

	/** Canonical scalar→int read of a mixed field; 0 for non-scalars (arrays/objects/null). */
	public static function as_int( mixed $value, int $default = 0 ): int {
		return \is_scalar( $value ) ? (int) $value : $default;
	}

	/**
	 * Canonical scalar→float read of a mixed field; 0.0 for non-scalars.
	 *
	 * @api Consumed by sibling plugins (event-logger-nodes, ai-newsletter).
	 */
	public static function as_float( mixed $value, float $default = 0.0 ): float {
		return \is_scalar( $value ) ? (float) $value : $default;
	}

	/**
	 * String passthrough: the value itself when it IS a string, $default
	 * otherwise. No casting — unlike as_string(), an int/bool never
	 * stringifies (the rejection is load-bearing at pattern/keyword reads).
	 *
	 * @api Consumed by sibling plugins (event-logger-nodes, ai-newsletter).
	 */
	public static function str( mixed $value, string $default = '' ): string {
		return \is_string( $value ) ? $value : $default;
	}

	/**
	 * Array passthrough: the value itself when it IS an array, $default
	 * otherwise.
	 *
	 * @api Consumed by sibling plugins (event-logger-nodes, ai-newsletter).
	 *
	 * @param array<array-key, mixed> $default
	 * @return array<array-key, mixed>
	 */
	public static function arr( mixed $value, array $default = [] ): array {
		return \is_array( $value ) ? $value : $default;
	}

	/**
	 * Int passthrough: the value itself when it IS an int, $default otherwise.
	 * No coercion — unlike num_int(), a numeric string or float never
	 * converts (exact-int is the right strictness for wire TYPE fields).
	 *
	 * @api Consumed by sibling plugins (event-logger-nodes, ai-newsletter).
	 */
	public static function int( mixed $value, int $default = 0 ): int {
		return \is_int( $value ) ? $value : $default;
	}

	/**
	 * Strict numeric→int read for ARITHMETIC paths: anything non-numeric
	 * (bool, 'abc', '12abc', null, array) contributes exactly 0, so corrupt
	 * data can never inflate a sum. Use as_int() for lenient cast-style reads.
	 *
	 * @api Consumed by sibling plugins (event-logger-nodes, ai-newsletter).
	 */
	public static function num_int( mixed $value, int $default = 0 ): int {
		return \is_numeric( $value ) ? (int) $value : $default;
	}

	/**
	 * Strict numeric→float read for ARITHMETIC paths; see num_int().
	 *
	 * @api Consumed by sibling plugins (event-logger-nodes, ai-newsletter).
	 */
	public static function num_float( mixed $value, float $default = 0.0 ): float {
		return \is_numeric( $value ) ? (float) $value : $default;
	}

	public static function register_node( string $name, Node $node ): void {
		self::$nodes_by_name[ $name ] = $node;
	}

	public static function unregister_node( string $name ): void {
		unset( self::$nodes_by_name[ $name ] );
	}

	public static function node( string $name ): ?Node {
		return self::$nodes_by_name[ $name ] ?? null;
	}

	/**
	 * Raw-curl fire-and-forget POST. Bypasses wp_remote_post (Requests floors timeout at 1s);
	 * CURLOPT_NOSIGNAL + TIMEOUT_MS=10 means CURLE_OPERATION_TIMEDOUT is expected and counted as success.
	 *
	 * @param array<string, mixed> $body POST body.
	 * @return string|null Error string on failure, null on success.
	 */
	public static function fire_and_forget_post( string $url, array $body ): ?string {
		if ( '' === $url ) {
			return 'empty url';
		}
		if ( ! \function_exists( 'curl_init' ) ) {
			return 'curl extension not available';
		}
		// phpcs:disable WordPress.WP.AlternativeFunctions.curl_curl_init,WordPress.WP.AlternativeFunctions.curl_curl_setopt_array,WordPress.WP.AlternativeFunctions.curl_curl_exec,WordPress.WP.AlternativeFunctions.curl_curl_errno,WordPress.WP.AlternativeFunctions.curl_curl_error,WordPress.WP.AlternativeFunctions.curl_curl_close -- raw curl is intentional. wp_remote_post() routes through Requests, whose Curl transport at src/Transport/Curl.php:427 does `max( (int) $timeout, 1 )` and clamps any sub-second timeout up to 1 full second — defeating this helper's CURLOPT_TIMEOUT_MS=10 fire-and-forget contract. Raw curl is the only path that honors the 10ms timeout.
		$ch = \curl_init();
		if ( false === $ch ) {
			return 'curl_init failed';
		}
		\curl_setopt_array( $ch, [
			\CURLOPT_URL               => $url,
			\CURLOPT_POST              => true,
			\CURLOPT_POSTFIELDS        => \http_build_query( $body ),
			\CURLOPT_NOSIGNAL          => true,
			\CURLOPT_TIMEOUT_MS        => 10,
			\CURLOPT_CONNECTTIMEOUT_MS => 10,
			\CURLOPT_RETURNTRANSFER    => false,
			\CURLOPT_HEADER            => false,
			\CURLOPT_SSL_VERIFYHOST    => 0,
			\CURLOPT_SSL_VERIFYPEER    => false,
		] );
		// Default ignores $body (in POSTFIELDS); arg only matters to mocks.
		$exec = self::$curl_exec ?? static fn ( \CurlHandle $h, array $b ) => \curl_exec( $h );
		$exec( $ch, $body );
		$errno = \curl_errno( $ch );
		$err   = ( 0 === $errno || \CURLE_OPERATION_TIMEDOUT === $errno ) ? null : \curl_error( $ch );
		\curl_close( $ch );
		// phpcs:enable WordPress.WP.AlternativeFunctions
		return $err;
	}

	/** Evict rate-limiter entries older than the timeout so stale messages re-emit (per Router tick). */
	public static function prune_logs(): void {
		foreach ( self::$recent_log_timers as $key => $timestamp ) {
			if ( self::$now - $timestamp > self::$log_timeout ) {
				unset( self::$recent_log_timers[ $key ] );
			}
		}
	}

	/** True if the property name reads as a credential (see SECRET_NAME_PATTERNS). */
	public static function is_secret_property( string $name ): bool {
		$lower = \strtolower( $name );
		foreach ( self::SECRET_NAME_PATTERNS as $needle ) {
			if ( false !== \strpos( $lower, $needle ) ) {
				return true;
			}
		}
		return false;
	}
}

Core::reset();
