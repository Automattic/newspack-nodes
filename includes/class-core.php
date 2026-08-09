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
	 * Command-surface policy for this process, modeled on Tachikoma's
	 * `secure_level`.
	 *
	 * `null` means there is no command surface at all — a graph-only script
	 * (`wp nodes ingest`, `wp nodes reqgrep`) composes nodes and never names an
	 * interpreter, so it has no policy to declare and is never warned about one.
	 * Naming an interpreter arms it to 0: a surface exists and nobody has said
	 * what policy it is under. `insecure` declares -1; `secure` climbs 1..3,
	 * each level removing management verbs. Tachikoma's level 0 also disables
	 * signing (RSA over ~10k startup commands is slow) and seals the network
	 * because of it; our HMAC costs microseconds, so 0 is only the undeclared
	 * state here.
	 */
	public static ?int $secure_level = null;

	/**
	 * Whether the spawn POST verifies the TLS peer and hostname. True by
	 * default; Bootstrap lowers it from `spawn_verify_ssl` for deployments
	 * fronted by a self-signed internal certificate. Config is a layer above
	 * Core, so it is injected rather than read.
	 */
	public static bool $verify_spawn_tls = true;

	/**
	 * libcurl-call seam. Lazily-defaulted at the call site to a closure wrapping
	 * the real libcurl call. Tests reassign in bootstrap to capture POST bodies
	 * without short-circuiting the curl_init / curl_setopt_array / errno-
	 * classification path — that lets the suite cover the real setopt + error-
	 * classification logic. Shared by Spawn_Coordinator (spawn fan-out) and Worker_Base
	 * (self-respawn): one helper, one seam, single source of truth.
	 *
	 * Signature: `function (\CurlHandle $ch, array $body): mixed`.
	 *
	 * @var \Closure(\CurlHandle, array<string,mixed>): mixed|null
	 */
	public static ?\Closure $curl_exec = null;

	/** Memoized `home_url()` host for the log midfix; cleared by reset(). */
	private static string $log_host = '';

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
	/**
	 * Budget for the fire-and-forget spawn POST, in milliseconds — total AND
	 * connect, since the total covers the connect phase and the smaller bites
	 * first. Long enough to WRITE the request, never long enough to await the
	 * reply: that is the whole contract. At 10ms it did not reach the write —
	 * on any site with a real certificate TCP landed in under a millisecond but
	 * the TLS handshake finished around 17ms, so curl aborted mid-handshake and
	 * the fleet never started. It failed in total silence, because nothing
	 * reached the access log and CURLE_OPERATION_TIMEDOUT counts as success.
	 * The abort at 250ms is the design working: the request is already delivered
	 * and the server runs on under ignore_user_abort.
	 */
	private const SPAWN_POST_TIMEOUT_MS = 250;

	/**
	 * Resolve `<partition>` (and `<topology>`, when the fleet is known) in a path
	 * template. `<topology>` names the FLEET — see Topology_Loader.
	 *
	 * @param string      $template Path template.
	 * @param int         $p        Partition index.
	 * @param string|null $topology Fleet name, or null to leave `<topology>` alone.
	 */
	public static function resolve_partition_template( string $template, int $p, ?string $topology = null ): string {
		$out = \str_replace( [ '<partition>', '{partition}' ], (string) $p, $template );
		if ( null !== $topology ) {
			$out = \str_replace( [ '<topology>', '{topology}' ], $topology, $out );
		}
		return self::resolve_config_tokens( $out );
	}

	/** Resolve every `<ns:key>` token in $path via resolve_config_token; $strict throws on an unresolvable token instead of ''. */
	public static function resolve_config_tokens( string $path, bool $strict = false ): string {
		return (string) \preg_replace_callback(
			'/<([a-zA-Z_]\w*):([a-zA-Z_]\w*)>/',
			static fn ( array $m ): string => self::resolve_config_token( $m[1], $m[2], $strict ),
			$path
		);
	}

	/**
	 * Resolve a `<ns:key>` topology token via its namespace resolver.
	 *
	 * Non-strict (shell interpolation, GC / dashboard path resolution): an
	 * unresolvable token becomes '' with a rate-limited warning — a resolver that
	 * RETURNS '' owns the key and its value is just empty. Strict (schema-arg
	 * defaults) throws instead, so a wrong-namespace or typo'd token — the
	 * <config:is_hub> footgun — fails loud at construction rather than silently
	 * coercing to a feature-off default. Owned-empty ('') never throws; only an
	 * unregistered namespace, a resolver returning null (key not owned), or a
	 * non-scalar result is "unresolvable".
	 */
	public static function resolve_config_token( string $ns, string $key, bool $strict = false ): string {
		$resolver = self::$config_resolvers[ $ns ] ?? null;
		if ( null === $resolver ) {
			if ( $strict ) {
				throw new \RuntimeException( \esc_html( "unresolvable config token <{$ns}:{$key}>: unknown namespace" ) );
			}
			self::print_less_often( 'resolve_config_token: unknown namespace ', "<{$ns}:{$key}>" );
			return '';
		}
		$value = $resolver( $key );
		if ( null === $value ) {
			if ( $strict ) {
				throw new \RuntimeException( \esc_html( "unresolvable config token <{$ns}:{$key}>: not owned by its namespace" ) );
			}
			self::print_less_often( 'resolve_config_token: resolver returned null for ', "<{$ns}:{$key}>" );
			return '';
		}
		if ( ! \is_scalar( $value ) ) {
			if ( $strict ) {
				throw new \RuntimeException( \esc_html( "unresolvable config token <{$ns}:{$key}>: resolved to a non-scalar" ) );
			}
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
	 * Run the stderr handler for one line, and fire the `newspack_nodes/stderr`
	 * firehose action beside it. Both run under the $in_stderr re-entry guard: a
	 * listener that itself calls stderr() hits this guard and short-circuits to
	 * error_log, so it can't recurse or re-fire the action. Worker-context
	 * listeners must write via a Topic/Partition directly, never back through
	 * stderr(). The function_exists gate keeps Core loadable in WP-less bootstraps.
	 */
	public static function _stderr( string $text, bool $raw = false ): void {
		if ( self::$in_stderr ) {
			// Re-entry guard: go straight to error_log to avoid recursion.
			// phpcs:ignore WordPress.PHP.DevelopmentFunctions.error_log_error_log
			\error_log( \rtrim( $text ) );
			return;
		}
		self::$in_stderr = true;
		try {
			if ( \function_exists( 'do_action' ) ) {
				try {
					\do_action( 'newspack_nodes/stderr', $text );
				} catch ( \Throwable $e ) {
					// A listener can't break the last-resort diagnostic path.
					// phpcs:ignore WordPress.PHP.DevelopmentFunctions.error_log_error_log
					\error_log( 'newspack_nodes/stderr listener threw: ' . $e->getMessage() );
				}
			}
			// Extra args are ignored by handlers that declare only $text.
			( self::$stderr_handler )( $text, $raw );
		} finally {
			// Reset even if handler throws, else stderr latches to fallback.
			self::$in_stderr = false;
		}
	}

	/**
	 * Per-line process-identity midfix.
	 *
	 * With no text, returns the bare midfix. With text, chomps a
	 * trailing newline, prepends the midfix to every line, and appends one
	 * trailing newline.
	 */
	public static function log_midfix( ?string $text = null ): string {
		$uptime = (int) ( Core::$now - Core::$init_time );
		$midfix = self::log_host() . ' '
			. self::argv0() . '[' . \getmypid() . '][' . $uptime . 's]: ';
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
	 * Site identity for the log midfix — the host of `home_url()`.
	 *
	 * @longform `gethostname()` names the MACHINE, and on shared hosting that is
	 * a pool box every site on it reports identically
	 * (`pool195-106-36.bur.atomicsites.net`), so an aggregated log cannot tell
	 * whose worker wrote a line. The site's own host can. Memoized because
	 * `home_url()` reads an option and runs filters, and this is on every logged
	 * line; falls back to the machine name before WordPress is loaded.
	 */
	private static function log_host(): string {
		if ( '' !== self::$log_host ) {
			return self::$log_host;
		}
		$host = '';
		if ( \function_exists( 'home_url' ) && \function_exists( 'wp_parse_url' ) ) {
			$host = Core::as_string( \wp_parse_url( \home_url(), \PHP_URL_HOST ) );
		}
		self::$log_host = '' !== $host ? $host : ( \gethostname() ?: 'unknown' );
		return self::$log_host;
	}

	public static function reset(): void {
		self::$nodes_by_name     = [];
		self::$shutting_down     = false;
		self::$recent_log        = [];
		self::$recent_log_timers = [];
		self::$in_stderr         = false;
		self::$var               = [];
		self::$memd              = null;
		self::$secure_level      = null;
		self::$log_host          = '';
		self::set_stderr_handler( static function ( string $text, bool $raw = false ): void {
			$sink = self::$nodes_by_name[ Node_Names::REPL ]
				?? self::$nodes_by_name[ Node_Names::SSE ]
				?? self::$nodes_by_name[ Node_Names::OUTPUT ]
				?? null;
			if ( null !== $sink ) {
				$message                       = Message::new_message();
				$message[ Message::TYPE ]      = Message::TM_BYTESTREAM;
				$message[ Message::TIMESTAMP ] = self::$now;
				// $raw = caller composed it; error_log stamps its own.
				$message[ Message::VALUE ]     = $raw ? $text : self::log_prefix( $text );
				$sink->fill( $message );
			}
			// phpcs:ignore WordPress.PHP.DevelopmentFunctions.error_log_error_log
			\error_log( \rtrim( $text ) );
		} );
		self::$init_time = self::right_now();
		// Drop the timer set too, else an orphaned node's armed timer survives.
		Event_Framework::reset();
	}

	/**
	 * The one fresh-clock call site (Tachikoma's $Tachikoma::Right_Now). Reads the
	 * live hi-res clock, refreshes the cached per-tick clock as a side benefit, and
	 * returns it. Inside the drain loop read Core::$now directly (the loop refreshes
	 * it per tick); call this only where a genuinely fresh timestamp is needed
	 * outside the drain (request/CLI scope) or where a blocking job has frozen $now.
	 */
	public static function right_now(): float {
		self::$now = \microtime( true );
		return self::$now;
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

	public static function set_stderr_handler( callable $h ): void {
		self::$stderr_handler = $h;
	}

	/**
	 * Raw-curl fire-and-forget POST. Bypasses wp_remote_post (Requests floors timeout at 1s);
	 * CURLOPT_NOSIGNAL + a sub-second TIMEOUT_MS means CURLE_OPERATION_TIMEDOUT is expected and counted as success.
	 *
	 * @param array<string,mixed> $body POST body.
	 * @return string|null Error string on failure, null on success.
	 */
	public static function fire_and_forget_post( string $url, array $body ): ?string {
		if ( '' === $url ) {
			return 'empty url';
		}
		if ( ! \function_exists( 'curl_init' ) ) {
			return 'curl extension not available';
		}
		// phpcs:disable WordPress.WP.AlternativeFunctions.curl_curl_init,WordPress.WP.AlternativeFunctions.curl_curl_setopt_array,WordPress.WP.AlternativeFunctions.curl_curl_exec,WordPress.WP.AlternativeFunctions.curl_curl_errno,WordPress.WP.AlternativeFunctions.curl_curl_error,WordPress.WP.AlternativeFunctions.curl_curl_getinfo -- raw curl is intentional. wp_remote_post() routes through Requests, whose Curl transport at src/Transport/Curl.php:427 does `max( (int) $timeout, 1 )` and clamps any sub-second timeout up to 1 full second — defeating this helper's sub-second CURLOPT_TIMEOUT_MS fire-and-forget contract. Raw curl is the only path that honors a sub-second timeout.
		$ch = \curl_init();
		if ( false === $ch ) {
			return 'curl_init failed';
		}
		$fields = \http_build_query( $body );
		\curl_setopt_array( $ch, self::post_curl_options( $url, $fields ) );
		// Default ignores $body (in POSTFIELDS); arg only matters to mocks.
		$exec = self::$curl_exec ?? static fn ( \CurlHandle $h, array $b ) => \curl_exec( $h );
		$exec( $ch, $body );
		$err = self::classify_post_result(
			\curl_errno( $ch ),
			\curl_getinfo( $ch, \CURLINFO_SIZE_UPLOAD_T ),
			\strlen( $fields ),
			\curl_error( $ch )
		);
		// phpcs:enable WordPress.WP.AlternativeFunctions
		return $err;
	}

	/**
	 * Classify a fire-and-forget result. Split out so the rule is assertable
	 * without a transport seam, as post_curl_options is for the option set.
	 *
	 * A timeout counts as success only once the WHOLE body is on the wire —
	 * hanging up then is the entire contract. Timing out before that means the
	 * request never landed, and calling it success is how a too-small budget
	 * strands a fleet in silence: nothing in the access log because nothing
	 * arrived, nothing in the error log because the timeout "worked". Elapsed
	 * time cannot draw that line — `pretransfer` marks where the transfer STARTS,
	 * so it reads a half-sent body as delivered. Bytes uploaded can.
	 *
	 * @param int    $errno    curl_errno().
	 * @param int    $uploaded CURLINFO_SIZE_UPLOAD_T; body bytes actually sent.
	 * @param int    $expected Body length that had to go out.
	 * @param string $error    curl_error().
	 * @return string|null Error string on failure, null on success.
	 */
	private static function classify_post_result( int $errno, int $uploaded, int $expected, string $error ): ?string {
		if ( 0 === $errno ) {
			return null;
		}
		if ( \CURLE_OPERATION_TIMEDOUT === $errno ) {
			// Partway is not delivery; only a whole body honors the contract.
			return $uploaded >= $expected
				? null
				: \sprintf( 'timed out after %d of %d bytes were sent: %s', $uploaded, $expected, $error );
		}
		return $error;
	}

	/**
	 * Options for the fire-and-forget spawn POST. Split out so the option set is
	 * assertable without a transport seam.
	 *
	 * @param string $url    Target URL.
	 * @param string $fields Already query-encoded body.
	 * @return array<int,mixed>
	 */
	private static function post_curl_options( string $url, string $fields ): array {
		return [
			\CURLOPT_URL               => $url,
			\CURLOPT_POST              => true,
			\CURLOPT_POSTFIELDS        => $fields,
			\CURLOPT_NOSIGNAL          => true,
			\CURLOPT_TIMEOUT_MS        => self::SPAWN_POST_TIMEOUT_MS,
			\CURLOPT_CONNECTTIMEOUT_MS => self::SPAWN_POST_TIMEOUT_MS,
			\CURLOPT_RETURNTRANSFER    => false,
			\CURLOPT_HEADER            => false,
			\CURLOPT_SSL_VERIFYHOST    => self::$verify_spawn_tls ? 2 : 0,
			\CURLOPT_SSL_VERIFYPEER    => self::$verify_spawn_tls,
		];
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
	 * @param array<array-key,mixed> $default
	 * @return array<array-key,mixed>
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

	/**
	 * Whether a node class fans out — keeps a target LIST rather than one target.
	 *
	 * The capability is the `Fanout_Targets` trait, NOT descent from `Tee_Node`:
	 * the minters that sign one command per spoke (Settings_Sync, ELN's
	 * Discovery_Collector) are Timer_Node subclasses that use the trait. Asking
	 * about the base class calls them single-target, and the graph then collapses
	 * every connect_node after the first.
	 *
	 * @param class-string|string $fqcn Fully-qualified class name.
	 */
	public static function class_fans_out( string $fqcn ): bool {
		if ( ! \class_exists( $fqcn ) ) {
			return false;
		}
		for ( $class = $fqcn; false !== $class; $class = \get_parent_class( $class ) ) {
			if ( \in_array( Fanout_Targets::class, \class_uses( $class ) ?: [], true ) ) {
				return true;
			}
		}
		return false;
	}

	public static function node( string $name ): ?Node {
		return self::$nodes_by_name[ $name ] ?? null;
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
