<?php
/**
 * Core: global registries + clock + stderr.
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes;

\defined( 'ABSPATH' ) || exit;

class Core {

	/** @var array<string,Node> Registered nodes keyed by name; every entry is a Node ($this from Node::name()). */
	public static array $nodes_by_name = [];

	/** @var float Microsecond-resolution timestamp; updated by the event loop or in tests. */
	public static float $now = 0.0;

	/** Process start time, stamped each Core::reset(); the `uptime` verb subtracts it from $now. */
	public static float $init_time = 0.0;

	public static bool $shutting_down = false;

	/** @var array<string,string> Process-global Shell variable map. */
	public static array $var = [];

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

	/** Process-global shared Memcached handle; set once by the application bootstrap, null when unconfigured. */
	public static ?\Memcached $memd = null;

	/** @var array<string> */
	public static array $recent_log = [];

	/** @var array<string,array{timestamp:float,count:int}> */
	public static array $recent_log_timers = [];

	/** @var float Seconds before a rate-limiter entry is eligible for pruning. */
	public static float $log_timeout = 60;

	/** @var callable */
	private static $stderr_handler;

	/** Re-entry guard for stderr(); the default handler can recurse via _repl write failures. */
	private static bool $in_stderr = false;

	// Single substitution rule for a partition-token template: both `<partition>`
	// angle and `{partition}` curly → $p, then `<ns:key>` config tokens. Shared by
	// the topology loader's resolved_resource_dirs and Aggregator_CI status keys so
	// the GC dirs and the dashboard read the identical concrete paths.
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
			self::print_less_often( "resolve_config_token: unknown namespace <{$ns}:{$key}>" );
			return '';
		}
		$value = $resolver( $key );
		if ( null === $value ) {
			self::print_less_often( "resolve_config_token: <{$ns}:{$key}> resolver returned null" );
			return '';
		}
		if ( ! \is_scalar( $value ) ) {
			self::print_less_often( "resolve_config_token: <{$ns}:{$key}> resolver returned non-scalar" );
			return '';
		}
		return (string) $value;
	}

	/** Emit text on first sight; suppress identical text thereafter (re-windowed by prune_logs). */
	public static function print_less_often( string $text ): void {
		$row = self::$recent_log_timers[ $text ] ?? null;
		if ( null !== $row ) {
			++$row['count'];
		} else {
			self::stderr( $text );
			$row = [ 'timestamp' => self::$now, 'count' => 1, ];
		}
		self::$recent_log_timers[ $text ] = $row;
	}

	public static function stderr( string $text ): void {
		if ( '' === $text ) {
			return;
		}
		// Already-dated lines are assumed pre-prefixed (Tachikoma's
		// /^\d{4}-\d\d-\d\d/ guard) — write verbatim to avoid double
		// prefixing on re-log paths. Otherwise apply prefix.
		if ( 1 === \preg_match( '/^\d{4}-\d\d-\d\d/', $text ) ) {
			$line = \rtrim( $text, "\n" ) . "\n";
		} else {
			$line = self::log_prefix( $text );
		}
		self::$recent_log[] = $line;
		// Bounded tail for the REPL (Tachikoma caps @RECENT_LOG at 100).
		while ( \count( self::$recent_log ) > 100 ) {
			\array_shift( self::$recent_log );
		}
		self::_stderr( $line );
	}

	/**
	 * Per-line timestamp + process-identity prefix (Tachikoma Node::log_prefix,
	 * root/job branch): "%Y-%m-%d %H:%M:%S %Z <hostname> <argv0>[<pid>]: ".
	 *
	 * With no message, returns the bare prefix. With a message, chomps a
	 * trailing newline, prepends the prefix to every line, and appends one
	 * trailing newline — matching Perl's `s{^}{$prefix}mg` multiline substitute.
	 */
	public static function log_prefix( ?string $message = null ): string {
		$prefix = \gmdate( 'Y-m-d H:i:s' ) . ' UTC '
			. ( \gethostname() ?: 'unknown' ) . ' '
			. self::argv0() . '[' . \getmypid() . ']: ';
		if ( null === $message ) {
			return $prefix;
		}
		$message = \rtrim( $message, "\n" );
		// Prepend the prefix to the start of every line (Perl m///mg).
		$message = $prefix . \str_replace( "\n", "\n" . $prefix, $message );
		return $message . "\n";
	}

	/** Process identity for log_prefix (Perl $0): worker type when set, else SAPI. Public so Node::log_midfix can apply the $0-starts-with-name guard. */
	public static function argv0(): string {
		if ( isset( $_SERVER['NEWSPACK_NODES_WORKER_TYPE'] ) && \is_scalar( $_SERVER['NEWSPACK_NODES_WORKER_TYPE'] ) && '' !== $_SERVER['NEWSPACK_NODES_WORKER_TYPE'] ) {
			// phpcs:ignore WordPress.Security.ValidatedSanitizedInput.InputNotSanitized -- env var is set by SpawnController after HMAC auth.
			return \sanitize_text_field( \wp_unslash( (string) $_SERVER['NEWSPACK_NODES_WORKER_TYPE'] ) );
		}
		return \PHP_SAPI;
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
			// Reset even if the handler throws, else stderr latches to fallback forever.
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
		// $config_resolvers is process-lifetime (like namespace registrations) — not cleared.
		self::$memd              = null;
		// Default handler: stderr is a BROADCAST. Route it to whichever reply sink
		// THIS process wired — the worker's `_repl` output partition, a REPL
		// `_output` Dumper, the SSE-stream `_sse` egress, or the `_output` response
		// writer (POST /command, where it rides back in the JSONL body) — so the
		// line surfaces at the session. Each process registers exactly one, so a
		// line never doubles. Else error_log.
		self::set_stderr_handler( static function ( string $message ): void {
			$sink = self::$nodes_by_name[ Node_Names::REPL ]
				?? self::$nodes_by_name[ Node_Names::SSE ]
				?? self::$nodes_by_name[ Node_Names::OUTPUT ]
				?? null;
			if ( null !== $sink ) {
				$m                       = Message::new_message();
				$m[ Message::TYPE ]      = Message::TM_BYTESTREAM;
				$m[ Message::TIMESTAMP ] = self::$now;
				$m[ Message::VALUE ]     = $message;
				$sink->fill( $m );
				return;
			}
			// phpcs:ignore WordPress.PHP.DevelopmentFunctions.error_log_error_log
			\error_log( \rtrim( $message ) );
		} );
		self::$now       = \microtime( true );
		self::$init_time = self::$now;
	}

	public static function set_stderr_handler( callable $h ): void {
		self::$stderr_handler = $h;
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
	public static function as_string( mixed $value ): string {
		return \is_scalar( $value ) ? (string) $value : '';
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

	/** Evict rate-limiter entries older than the timeout so stale messages re-emit (per Router tick). */
	public static function prune_logs(): void {
		foreach ( self::$recent_log_timers as $key => $row ) {
			if ( self::$now - $row['timestamp'] > self::$log_timeout ) {
				unset( self::$recent_log_timers[ $key ] );
			}
		}
	}
}

Core::reset();
