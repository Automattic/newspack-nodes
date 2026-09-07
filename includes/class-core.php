<?php
/**
 * Holds what a node needs from the process it runs in — the registry it is
 * dispatched through, the tick clock, the diagnostic path — so a graph wired
 * at runtime never has to thread any of it down the chain. Beside those sit the
 * process-wide helpers no single node owns: `<ns:key>` token resolution, the
 * mixed-value read family, the raw-curl spawn POST, and the rule that decides a
 * property name reads as a credential.
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes;

\defined( 'ABSPATH' ) || exit;

/**
 * The PHP counterpart of Tachikoma's `Tachikoma.pm` package globals:
 * `%Tachikoma::Nodes`, `$Tachikoma::Now`, `$Tachikoma::Right_Now` and the
 * `@RECENT_LOG` ring.
 *
 * Every member is process-scoped and lives no longer than the request or the
 * worker that set it. `reset()` returns the class to boot state, and this file
 * calls it on load, so requiring the plugin is enough to have a usable Core; a
 * suite calls it between cases for the same reason.
 */
class Core {

	/**
	 * Property-name substrings whose value is a credential. dump_node() reflects
	 * EVERY property, so any node holding one of these would otherwise print the
	 * raw secret to the REPL / logs — redacted here for every node by default.
	 * Deliberately excludes bare `auth` so `auth_username` / `authorize` survive.
	 */
	private const SECRET_NAME_PATTERNS = [ 'password', 'passwd', 'secret', 'token', 'credential', 'api_key', 'apikey', 'private_key' ];

	/**
	 * Topology `<ns:key>` token resolvers, keyed by namespace and registered at
	 * boot through `register_config_namespace()`.
	 *
	 * Each namespace owner registers its own resolver; there is no merged config
	 * array. `reset()` leaves the map alone, because a registration made once at
	 * boot has nothing left to re-register it, and dropping it would leave every
	 * `<ns:key>` token unresolvable.
	 *
	 * @var array<string,callable(string):mixed>
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
	 * each level removing management verbs. Tachikoma's 0 means something else:
	 * there `Command::sign()` returns unsigned and `Socket::accept_connection()`
	 * refuses every inbound connection. Here 0 is only the undeclared state.
	 */
	public static ?int $secure_level = null;

	/**
	 * Whether the substrate's internal loopback requests — the spawn POST here
	 * and `Health_Probe_Client`'s fetch — verify the TLS peer and hostname.
	 * Bootstrap sets it from `spawn_verify_ssl`, which defaults to true and is
	 * turned off only for a deployment fronted by a self-signed internal
	 * certificate. Config is a layer above Core, so it is injected rather than
	 * read.
	 */
	public static bool $verify_spawn_tls = true;

	/**
	 * libcurl-call seam. Lazily-defaulted at the call site to a closure wrapping
	 * the real libcurl call. Tests reassign it in bootstrap to capture POST
	 * bodies while the curl_init, curl_setopt_array and errno-classification
	 * path around it keeps running as production code. `Spawn_Coordinator`
	 * (spawn fan-out) and `Worker_Base` (self-respawn) reach it through the one
	 * `fire_and_forget_post()`.
	 *
	 * Signature: `function (\CurlHandle $ch, array $body): mixed`.
	 *
	 * @var \Closure(\CurlHandle, array<string,mixed>): mixed|null
	 */
	public static ?\Closure $curl_exec = null;

	/** Memoized `home_url()` host for the log midfix; cleared by reset(). */
	private static string $log_host = '';

	/** Process start time, stamped each Core::reset(); log_midfix() and the `uptime` verb subtract it from $now. */
	public static float $init_time = 0.0;

	/** @var float Seconds before a rate-limiter entry is eligible for pruning. */
	public static float $log_timeout = 60;

	/**
	 * The one process-wide Memcached handle, built by the substrate's own
	 * `Bootstrap::init_memcached()` from `memcache_servers` so that no substrate
	 * path waits on an application plugin to populate it. Null when no server is
	 * configured, and deliberately not a stub handle, so a caller can tell the
	 * two apart.
	 *
	 * Most consumers reach it through `Cache_Backend`, which falls back to APCu,
	 * so the null alone fails nobody. Only once NEITHER tier answers does
	 * `Command_Auth` refuse a command as an unverifiable single-use nonce, or
	 * `SSE_Slot_Pool` withhold a lease. `wp nodes stop` reads the null directly,
	 * to warn that its in-flight-spawn check cannot see PHP-FPM's timestamps.
	 *
	 * A CONFIGURED server still yields a handle when it is down, because
	 * `addServer()` never connects.
	 */
	public static ?\Memcached $memd = null;

	/** @var array<string,Node> Registered nodes keyed by name; every entry is a Node ($this from Node::name()). */
	public static array $nodes_by_name = [];

	/** @var float Microsecond-resolution timestamp; refreshed per tick through right_now(), pinned directly in tests. */
	public static float $now = 0.0;

	/** @var array<string> The 100 most recent stderr lines; `dmesg` dumps them. */
	public static array $recent_log = [];

	/** @var array<string,float> Category → first-seen timestamp; pruned by prune_logs. */
	public static array $recent_log_timers = [];

	/** Set by the SIGTERM / SIGINT handler; the drain loop breaks on it. */
	public static bool $shutting_down = false;

	/** @var array<string,string> Process-global Shell variable map. */
	public static array $var = [];

	/** Re-entry guard for stderr(); the default handler can recurse via _repl write failures. */
	private static bool $in_stderr = false;

	/**
	 * The one sink `_stderr()` hands each line to. `reset()` installs the
	 * production default — the REPL, SSE or `_output` node when one of them is
	 * registered, plus `error_log` either way — and tests replace it through
	 * `set_stderr_handler()` to capture lines.
	 *
	 * Signature: `function (string $text, bool $raw = false): void`.
	 *
	 * @var callable
	 */
	private static $stderr_handler;

	/**
	 * Budget for the fire-and-forget spawn POST, in milliseconds — total AND
	 * connect, since the total covers the connect phase and the smaller bites
	 * first. Long enough to WRITE the request, never long enough to await the
	 * reply: that is the whole contract, and the abort at 250ms is it working —
	 * the request is already delivered and the server runs on under
	 * ignore_user_abort.
	 *
	 * The TLS handshake sets the floor. On a site with a real certificate TCP
	 * lands in under a millisecond but the handshake finishes around 17ms, so a
	 * budget near that aborts mid-handshake and the fleet never starts. Nothing
	 * reaches the access log either, because nothing arrived; the only reason
	 * that is not silent as well is `classify_post_result()`, which refuses to
	 * call a half-sent body delivered.
	 */
	private const SPAWN_POST_TIMEOUT_MS = 250;

	/**
	 * Resolve `<partition>` (and `<topology>`, when the fleet is known) in a path
	 * template, then every `<ns:key>` config token in the result. `<topology>`
	 * names the FLEET — see Topology_Loader. Both tokens are also accepted in
	 * the brace spelling, `{partition}` and `{topology}`.
	 *
	 * @param string      $template Path template.
	 * @param int         $p        Partition index.
	 * @param string|null $topology Fleet name, or null to leave `<topology>` alone.
	 * @return string Concrete path.
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
	 *
	 * @throws \RuntimeException In strict mode, on an unresolvable token.
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
	 *
	 * This static form keys PROCESS-wide, so two callers passing the same $text
	 * share one entry. `Node::print_less_often()` keys the same
	 * `$recent_log_timers` map by the midfixed text, so each node throttles on
	 * its own.
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

	/**
	 * The one entry point for a diagnostic line: stamp the process midfix, keep
	 * a timestamped copy in the `dmesg` ring, and hand the midfixed line to the
	 * handler, which stamps its own timestamp. An empty string is dropped rather
	 * than stamped, so the ring holds only real lines.
	 */
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
	 * Per-line process-identity midfix: `<site host> <argv0>[<pid>][<uptime>s]: `.
	 *
	 * With no text, returns the bare midfix. With text, chomps a
	 * trailing newline, prepends the midfix to every line, and appends one
	 * trailing newline.
	 */
	public static function log_midfix( ?string $text = null ): string {
		$uptime = (int) ( Core::$now - Core::$init_time );
		return self::apply_midfix(
			self::log_host() . ' ' . self::argv0() . '[' . \getmypid() . '][' . $uptime . 's]: ',
			$text
		);
	}

	/** Process identity for log_midfix: worker type when set, else SAPI. Public so Node::log_midfix can apply the $0-starts-with-name guard. */
	public static function argv0(): string {
		if ( isset( $_SERVER['NEWSPACK_NODES_WORKER_TYPE'] ) && \is_scalar( $_SERVER['NEWSPACK_NODES_WORKER_TYPE'] ) && '' !== $_SERVER['NEWSPACK_NODES_WORKER_TYPE'] ) {
			// phpcs:ignore WordPress.Security.ValidatedSanitizedInput.InputNotSanitized -- env var is set by Spawn_Controller after HMAC auth, or by Bootstrap on the reconcile pass.
			return \sanitize_text_field( \wp_unslash( (string) $_SERVER['NEWSPACK_NODES_WORKER_TYPE'] ) );
		}
		return \PHP_SAPI;
	}

	/**
	 * Site identity for the log midfix — the host of `home_url()`.
	 *
	 * `gethostname()` names the MACHINE, and on shared hosting that is a pool
	 * box every site on it reports identically
	 * (`pool195-106-36.bur.atomicsites.net`), so an aggregated log cannot tell
	 * whose worker wrote a line. The site's own host can. Memoized because
	 * `home_url()` reads an option and runs filters, and this is on every
	 * logged line; falls back to the machine name before WordPress is loaded.
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

	/**
	 * Stamp $midfix on the start of every LINE of $text (Perl m///mg), chomped
	 * and re-terminated with exactly one newline; null $text yields the bare
	 * midfix. The ONE application rule — Core names the process and Node names
	 * the node, but they format the result identically.
	 */
	public static function apply_midfix( string $midfix, ?string $text ): string {
		if ( null === $text ) {
			return $midfix;
		}
		$text = \rtrim( $text, "\n" );
		return $midfix . \str_replace( "\n", "\n" . $midfix, $text ) . "\n";
	}

	/**
	 * Return the class to per-run boot state — the node registry, the shutdown
	 * flag, the log ring and its rate-limiter timers, the stderr re-entry guard,
	 * the Shell vars, the memcached handle, the secure-level declaration, the
	 * memoized log host, and Cache_Backend's memoized site, salt and machine —
	 * then reinstall the default stderr handler and restamp `$init_time`.
	 * `Event_Framework::reset()` goes with it, so an orphaned node's armed timer
	 * cannot outlive the graph that armed it.
	 *
	 * Four members survive, because they are process wiring rather than per-run
	 * state: `$config_resolvers`, `$curl_exec`, `$verify_spawn_tls` and
	 * `$log_timeout`.
	 */
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
		Cache_Backend::$site     = '';
		Cache_Backend::$salt     = null;
		Cache_Backend::$machine  = '';
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
		Event_Framework::reset();
	}

	/**
	 * The one production writer of `Core::$now` (Tachikoma's
	 * $Tachikoma::Right_Now); tests pin the property directly. Reads the live
	 * hi-res clock, refreshes the cached per-tick clock as a side benefit, and
	 * returns it. Inside the drain loop read Core::$now directly
	 * (the loop refreshes it per tick); call this only where a genuinely fresh
	 * timestamp is needed outside the drain (request/CLI scope), or where a
	 * blocking job has frozen $now.
	 */
	public static function right_now(): float {
		self::$now = \microtime( true );
		return self::$now;
	}

	/**
	 * Per-line timestamp prefix: `Y-m-d H:i:s UTC `.
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
		$text = $prefix . \str_replace( "\n", "\n" . $prefix, $text );
		return $text . "\n";
	}

	/** Replace the sink `_stderr()` writes to; `$stderr_handler` carries the signature. */
	public static function set_stderr_handler( callable $h ): void {
		self::$stderr_handler = $h;
	}

	/**
	 * Raw-curl fire-and-forget POST. Bypasses wp_remote_post (Requests floors timeout at 1s);
	 * CURLOPT_NOSIGNAL + a sub-second TIMEOUT_MS means CURLE_OPERATION_TIMEDOUT is expected, and
	 * `classify_post_result()` counts it as success once the whole body is on the wire.
	 *
	 * @param string              $url  Target URL.
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
		// phpcs:disable WordPress.WP.AlternativeFunctions.curl_curl_init,WordPress.WP.AlternativeFunctions.curl_curl_setopt_array,WordPress.WP.AlternativeFunctions.curl_curl_exec,WordPress.WP.AlternativeFunctions.curl_curl_errno,WordPress.WP.AlternativeFunctions.curl_curl_error,WordPress.WP.AlternativeFunctions.curl_curl_getinfo -- raw curl is intentional. wp_remote_post() routes through Requests, whose Curl transport at src/Transport/Curl.php:431 does `$timeout = max($options['timeout'], 1)` and clamps any sub-second timeout up to 1 full second — defeating this helper's sub-second CURLOPT_TIMEOUT_MS fire-and-forget contract. Raw curl is the only path that honors a sub-second timeout.
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

	/**
	 * The first-level dir `$concrete` occupies under `$root` — the unit both the
	 * log GC's declared set and `Topology_Analyzer`'s per-dir `segment_size`
	 * overrides are keyed by, since a nested layout
	 * (`<config:logs_dir>/req/3`) is retained and swept as `req`. `''` when
	 * `$concrete` lies outside `$root`, which is not a failed expansion: a
	 * template may legitimately resolve elsewhere. A `$root` of `''` or `/`
	 * yields `''` for every path.
	 */
	public static function first_level_dir( string $concrete, string $root ): string {
		$prefix = \rtrim( $root, '/' ) . '/';
		if ( '/' === $prefix || 0 !== \strpos( $concrete, $prefix ) ) {
			return '';
		}
		return \explode( '/', \substr( $concrete, \strlen( $prefix ) ) )[0];
	}

	/** True while the stderr handler is on the stack; `Event_Framework::stop_check()` reads it to skip a log-write stop. */
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

	/**
	 * Canonical scalar→string read of a mixed Message field; a non-scalar
	 * (array, object, null) takes $default, '' unless the caller says otherwise.
	 *
	 * @api Consumed by sibling plugins.
	 */
	public static function as_string( mixed $value, string $default = '' ): string {
		return \is_scalar( $value ) ? (string) $value : $default;
	}

	/**
	 * Canonical scalar→int read of a mixed field; a non-scalar (array, object,
	 * null) takes $default, 0 unless the caller says otherwise.
	 *
	 * @api Consumed by sibling plugins.
	 */
	public static function as_int( mixed $value, int $default = 0 ): int {
		return \is_scalar( $value ) ? (int) $value : $default;
	}

	/**
	 * Canonical scalar→float read of a mixed field; a non-scalar takes $default,
	 * 0.0 unless the caller says otherwise.
	 *
	 * @api Consumed by sibling plugins.
	 */
	public static function as_float( mixed $value, float $default = 0.0 ): float {
		return \is_scalar( $value ) ? (float) $value : $default;
	}

	/**
	 * String passthrough: the value itself when it IS a string, $default
	 * otherwise. No casting — unlike as_string(), an int/bool never
	 * stringifies (the rejection is load-bearing at pattern/keyword reads).
	 *
	 * @api Consumed by sibling plugins.
	 */
	public static function str( mixed $value, string $default = '' ): string {
		return \is_string( $value ) ? $value : $default;
	}

	/**
	 * Array passthrough: the value itself when it IS an array, $default
	 * otherwise.
	 *
	 * @api Consumed by sibling plugins.
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
	 * @api Consumed by sibling plugins.
	 */
	public static function int( mixed $value, int $default = 0 ): int {
		return \is_int( $value ) ? $value : $default;
	}

	/**
	 * Strict numeric→int read for ARITHMETIC paths: anything non-numeric
	 * (bool, 'abc', '12abc', null, array) takes $default — 0 unless the caller
	 * says otherwise, so corrupt data can never inflate a sum. Use as_int() for
	 * lenient cast-style reads.
	 *
	 * @api Consumed by sibling plugins.
	 */
	public static function num_int( mixed $value, int $default = 0 ): int {
		return \is_numeric( $value ) ? (int) $value : $default;
	}

	/**
	 * Strict numeric→float read for ARITHMETIC paths; see num_int().
	 *
	 * @api Consumed by sibling plugins.
	 */
	public static function num_float( mixed $value, float $default = 0.0 ): float {
		return \is_numeric( $value ) ? (float) $value : $default;
	}

	/**
	 * REFUSING read of an operator- or wire-supplied integer: a non-negative
	 * int, or a canonical non-negative decimal string inside PHP's range, else
	 * null. A negative int is refused with everything else — it stringifies and
	 * then fails the same pattern.
	 *
	 * The other families all resolve to a number, so a typo picks one silently:
	 * `as_int('abc')` and `num_int('abc')` both return 0, naming partition 0.
	 * Null is a refusal the caller reports — `WP_CLI::error()` on a flag, a throw
	 * in a verb — so `--partition=2m` says so instead of restarting p2.
	 *
	 * @param mixed $value      Raw token.
	 * @param bool  $allow_zero Whether '0' is acceptable.
	 * @return int|null The parsed value, or null when the token is not canonical.
	 */
	public static function canonical_decimal( mixed $value, bool $allow_zero = true ): ?int {
		$token = \is_int( $value ) ? (string) $value : $value;
		if ( ! \is_string( $token ) ) {
			return null;
		}
		$pattern = $allow_zero ? '/^(?:0|[1-9][0-9]*)$/' : '/^[1-9][0-9]*$/';
		if ( 1 !== \preg_match( $pattern, $token ) ) {
			return null;
		}
		$max = (string) \PHP_INT_MAX;
		if (
			\strlen( $token ) > \strlen( $max )
			|| ( \strlen( $token ) === \strlen( $max ) && \strcmp( $token, $max ) > 0 )
		) {
			return null;
		}
		return (int) $token;
	}

	/** Bind $name in the process registry; `Node::name()` is the only caller. */
	public static function register_node( string $name, Node $node ): void {
		self::$nodes_by_name[ $name ] = $node;
	}

	/**
	 * Free $name in the process registry. Unbinding is separable from teardown —
	 * `Node::name()` uses it mid-rename, and `SSE_Out_Node` drops its `_sse`
	 * mapping while the controller instance lives on — so this touches the
	 * registry only, never the node.
	 */
	public static function unregister_node( string $name ): void {
		unset( self::$nodes_by_name[ $name ] );
	}

	/**
	 * Whether a node class fans out — keeps a target LIST rather than one target.
	 *
	 * The capability is the `Fanout_Targets` trait, NOT descent from `Tee_Node`:
	 * the minters that sign one command per spoke (`Settings_Sync_Node`, ELN's
	 * `Discovery_Collector_Node`) are Timer_Node subclasses that use the trait.
	 * Asking about the base class calls them single-target, and the graph then
	 * collapses every connect_node after the first.
	 *
	 * @param class-string|string $fqcn Fully-qualified class name.
	 * @return bool True when the class or an ancestor uses `Fanout_Targets`.
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

	/**
	 * The node bound to $name, or null — the lookup behind the interpreter's
	 * verbs, Timer_Node finding `_router`, and every node that addresses a peer
	 * by name. Router_Node reads `$nodes_by_name` directly on the dispatch path.
	 */
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
