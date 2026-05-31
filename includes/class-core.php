<?php
/**
 * Core: global registries + clock + closing queue + stderr.
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes;

\defined( 'ABSPATH' ) || exit;

class Core {
	/** @var array<string,object> */
	public static array $nodes_by_name = [];

	/** @var float Microsecond-resolution timestamp; updated by the event loop or in tests. */
	public static float $now = 0.0;

	/** Process start time, stamped each Core::reset(); the `uptime` verb subtracts it from $now. */
	public static float $init_time = 0.0;

	public static bool $shutting_down = false;

	/**
	 * Deferred-cleanup queue; public so the hot drain loop can shift it without a method frame.
	 *
	 * @var array<int, callable>
	 */
	public static array $closing = [];

	/** @var array<string,string> Process-global Shell variable map. */
	public static array $var = [];

	/**
	 * Topology `<ns:key>` token resolvers, registered at boot.
	 *
	 * Each namespace owner registers its own resolver; there is no merged
	 * config array. Process-lifetime (NOT cleared by reset(), like namespace
	 * registrations).
	 *
	 * @var array<string,callable> ns => callable(string $key): mixed
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

	/** Monotonic counter for shell message IDs; reset by Core::reset(). */
	private static int $msg_counter = 0;

	public static function reset(): void {
		self::$nodes_by_name     = [];
		self::$shutting_down     = false;
		self::$closing           = [];
		self::$recent_log        = [];
		self::$recent_log_timers = [];
		self::$msg_counter       = 0;
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
		self::$stderr_handler = static function ( string $msg ): void {
			$sink = self::$nodes_by_name[ Node_Names::REPL ]
				?? self::$nodes_by_name[ Node_Names::SSE ]
				?? self::$nodes_by_name[ Node_Names::OUTPUT ]
				?? null;
			if ( null !== $sink ) {
				$m                       = Message::new_message();
				$m[ Message::TYPE ]      = Message::TM_BYTESTREAM;
				$m[ Message::TIMESTAMP ] = self::$now;
				$m[ Message::VALUE ]     = $msg;
				$sink->fill( $m );
				return;
			}
			// phpcs:ignore WordPress.PHP.DevelopmentFunctions.error_log_error_log
			\error_log( \rtrim( $msg ) );
		};
		self::$now       = \microtime( true );
		self::$init_time = self::$now;
	}

	/** Pre-increment monotonic message-id counter. */
	public static function msg_counter(): int {
		return ++self::$msg_counter;
	}

	/** Register a topology `<ns:key>` token resolver for namespace $ns (last writer wins). */
	public static function register_config_namespace( string $ns, callable $resolver ): void {
		self::$config_resolvers[ $ns ] = $resolver;
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
		return (string) $value;
	}

	public static function register_node( string $name, object $node ): void {
		self::$nodes_by_name[ $name ] = $node;
	}

	public static function unregister_node( string $name ): void {
		unset( self::$nodes_by_name[ $name ] );
	}

	public static function node( string $name ): ?object {
		return self::$nodes_by_name[ $name ] ?? null;
	}

	/** Tear down every registered node; snapshots the registry first so unregister doesn't mutate the iteration source. */
	public static function cleanup_all_nodes(): void {
		$nodes = self::$nodes_by_name;
		foreach ( $nodes as $node ) {
			if ( \method_exists( $node, 'remove_node' ) ) {
				try {
					$node->remove_node();
				} catch ( \Throwable $e ) {
					// Best-effort: one node's failure shouldn't block the rest.
					self::stderr( 'cleanup_all_nodes: ' . $e->getMessage() );
				}
			}
		}
	}

	public static function push_closing( callable $cb ): void {
		self::$closing[] = $cb;
	}

	public static function run_closing(): void {
		while ( ! empty( self::$closing ) ) {
			$cb = \array_shift( self::$closing );
			$cb();
		}
	}

	public static function set_stderr_handler( callable $h ): void {
		self::$stderr_handler = $h;
	}

	/** Emit once at the 10th identical occurrence; suppress otherwise (re-windowed by prune_logs). */
	public static function print_least_often( string $text ): void {
		// Key by log_midfix so Core and named Nodes share recent_log_timers
		// without colliding on identical raw text (Tachikoma keys on the midfix).
		$key = self::log_midfix( $text );
		$row = self::$recent_log_timers[ $key ] ?? null;
		if ( null !== $row ) {
			++$row['count'];
			if ( 10 === $row['count'] ) {
				self::stderr( $text );
			}
		} else {
			$row = [ 'timestamp' => self::$now, 'count' => 1, ];
		}
		self::$recent_log_timers[ $key ] = $row;
	}

	/** Emit text on first sight; suppress identical text thereafter (re-windowed by prune_logs). */
	public static function print_less_often( string $text ): void {
		$key = self::log_midfix( $text );
		$row = self::$recent_log_timers[ $key ] ?? null;
		if ( null !== $row ) {
			++$row['count'];
		} else {
			self::stderr( $text );
			$row = [ 'timestamp' => self::$now, 'count' => 1, ];
		}
		self::$recent_log_timers[ $key ] = $row;
	}

	/**
	 * Per-line timestamp + process-identity prefix (Tachikoma Node::log_prefix,
	 * root/job branch): "%Y-%m-%d %H:%M:%S %Z <hostname> <argv0>[<pid>]: ".
	 *
	 * With no message, returns the bare prefix. With a message, chomps a
	 * trailing newline, prepends the prefix to every line, and appends one
	 * trailing newline — matching Perl's `s{^}{$prefix}mg` multiline substitute.
	 */
	public static function log_prefix( ?string $msg = null ): string {
		$prefix = \gmdate( 'Y-m-d H:i:s' ) . ' UTC '
			. ( \gethostname() ?: 'unknown' ) . ' '
			. self::argv0() . '[' . \getmypid() . ']: ';
		if ( null === $msg ) {
			return $prefix;
		}
		$msg = \rtrim( $msg, "\n" );
		// Prepend the prefix to the start of every line (Perl m///mg).
		$msg = $prefix . \str_replace( "\n", "\n" . $prefix, $msg );
		return $msg . "\n";
	}

	/**
	 * Per-node mid-line tag (Tachikoma Node::log_midfix). Core is
	 * process-global with no node name, so the midfix is always empty — it
	 * returns "" with no args, or the message unchanged (chomped + one newline)
	 * with a message. The per-node tag lives on Node, which has a name.
	 */
	public static function log_midfix( ?string $msg = null ): string {
		if ( null === $msg ) {
			return '';
		}
		return \rtrim( $msg, "\n" ) . "\n";
	}

	/** Process identity for log_prefix (Perl $0): worker type when set, else SAPI. Public so Node::log_midfix can apply the $0-starts-with-name guard. */
	public static function argv0(): string {
		if ( isset( $_SERVER['NEWSPACK_NODES_WORKER_TYPE'] ) && '' !== $_SERVER['NEWSPACK_NODES_WORKER_TYPE'] ) {
			// phpcs:ignore WordPress.Security.ValidatedSanitizedInput.InputNotSanitized -- env var is set by SpawnController after HMAC auth.
			return \sanitize_text_field( \wp_unslash( (string) $_SERVER['NEWSPACK_NODES_WORKER_TYPE'] ) );
		}
		return \PHP_SAPI;
	}

	public static function stderr( string $text ): void {
		if ( '' === $text ) {
			return;
		}
		if ( self::$in_stderr ) {
			// Re-entry guard: go straight to error_log to avoid recursion.
			// phpcs:ignore WordPress.PHP.DevelopmentFunctions.error_log_error_log
			\error_log( \rtrim( $text ) );
			return;
		}
		self::$in_stderr = true;
		try {
			// Already-dated lines are assumed pre-prefixed (Tachikoma's
			// /^\d{4}-\d\d-\d\d/ guard) — write verbatim to avoid double
			// prefixing on re-log paths. Otherwise apply prefix + midfix.
			if ( 1 === \preg_match( '/^\d{4}-\d\d-\d\d/', $text ) ) {
				$line = \rtrim( $text, "\n" ) . "\n";
			} else {
				$line = self::log_prefix( self::log_midfix( $text ) );
			}
			self::$recent_log[] = $line;
			// Bounded tail for the REPL (Tachikoma caps @RECENT_LOG at 100).
			while ( \count( self::$recent_log ) > 100 ) {
				\array_shift( self::$recent_log );
			}
			( self::$stderr_handler )( $line );
		} finally {
			// Reset even if the handler throws, else stderr latches to fallback forever.
			self::$in_stderr = false;
		}
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
