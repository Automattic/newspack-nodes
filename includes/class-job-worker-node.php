<?php
/**
 * Job Worker
 *
 * Consumes normalized job entries (from jobs.log, written by an application's
 * JobRouter) and dispatches to registered handlers.
 *
 * Two handler maps, registered independently:
 *   - local_handlers  — for entries with k='job'        (every node's own
 *                       JobWorker dispatches here)
 *   - remote_handlers — for entries with k='remote_job' (a hub's JobWorker
 *                       dispatches here after incoming spoke `k:"job"` lines are
 *                       rewritten to `k:"remote_job"`)
 *
 * A handler can register on either or both. Registering on both is the
 * pattern for jobs that should run locally on every node AND have a
 * (possibly different) handler invoked centrally on the hub for entries
 * aggregated from spokes — same handler name, two independent callables.
 *
 * Plugins typically register via WP filters at plugin load:
 *   add_filter( 'newspack_nodes/job_handlers',        ... );
 *   add_filter( 'newspack_nodes/remote_job_handlers', ... );
 * The job-workers topology runs apply_filters and feeds the result via
 * set_local_handler / set_remote_handler.
 *
 * Per-job request context (suspending a parent logger, rewriting $_SERVER to a
 * synthetic /jobs/{handler} URL, etc.) is NOT a substrate concern: fill() fires
 * `newspack_nodes/job_worker/{before,after}_job` actions around each handler so
 * applications can hook their own context. The cleanup action runs in a finally
 * block, even if the handler throws.
 *
 * SECURITY:
 * - Handler names must match HANDLER_NAME_PATTERN
 * - Parameters validated for type/size; handlers MUST validate content
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes;

if ( ! \defined( 'ABSPATH' ) ) {
	exit;
}

/**
 * Job Worker class.
 */
class Job_Worker_Node extends Node {
	use Schema_Reflection;

	public const HANDLER_NAME_PATTERN = '/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/';
	public const MAX_JOB_SIZE         = 10485760;

	/** Maximum JSON decode depth to prevent stack-exhaustion attacks. */
	public const MAX_JSON_DEPTH = 64;

	/** Default cache-flush interval in jobs. */
	public const CACHE_FLUSH_INTERVAL = 50;

	/** Default stale-timeout hint for long-running JobWorker pipelines. */
	public const DEFAULT_STALE_TIMEOUT = 600;

	/** Default max-runtime hint (matches DEFAULT_STALE_TIMEOUT for symmetry). */
	public const DEFAULT_MAX_RUNTIME = 600;

	/** Memory watermark — request restart when memory_get_usage crosses this fraction. */
	public const MEMORY_WATERMARK_PCT = 0.80;

	/** @var array<string,callable> */
	private array $local_handlers = [];
	/** @var array<string,callable> */
	private array $remote_handlers = [];
	private int $jobs_executed = 0;
	private int $jobs_since_cache_flush = 0;

	/** @var callable|null */
	private $between_jobs_cb = null;

	/** Latched true when a per-job memory check crossed the watermark. */
	private bool $memory_pressure = false;

	protected int $cache_flush_interval = self::CACHE_FLUSH_INTERVAL;
	protected int $stale_timeout        = self::DEFAULT_STALE_TIMEOUT;
	protected int $max_runtime          = self::DEFAULT_MAX_RUNTIME;

	/** Tachikoma-parity: no-arg ctor. Positional config arrives via arguments(). */
	public function __construct() {
		parent::__construct();

		// Handler maps are eager init, not config — a JobWorker with
		// no handlers is dead weight. By the time a worker's TSL is
		// evaluated, plugins_loaded has fired, so every registered
		// `newspack_nodes/{job,remote_job}_handlers` filter is in
		// place. Eager-load avoids the operator having to remember a
		// `cmd job-worker:config load_handlers` line in every TSL
		// file that uses JobWorker.
		$this->load_handlers_from_filters();
	}

	/**
	 * Store the raw string, parse positional tokens via parse_schema_args()
	 * (cache_flush_interval / stale_timeout / max_runtime), then clamp each knob
	 * to >= 1 to match the legacy ctor's `max(1, ...)`.
	 *
	 * @param string|null $args
	 * @return string
	 */
	public function arguments( ?string $args = null ): string {
		if ( null === $args ) {
			return parent::arguments();
		}
		$this->parse_schema_args( $args );
		$this->cache_flush_interval = \max( 1, $this->cache_flush_interval );
		$this->stale_timeout        = \max( 1, $this->stale_timeout );
		$this->max_runtime          = \max( 1, $this->max_runtime );
		return $args;
	}

	public function fill( array &$message ): void {
		++$this->counter;
		/** @var int $type */
		$type = $message[ Message::TYPE ];
		if ( $type & Message::TM_REQUEST ) {
			$this->handle_request( $message );
			return;
		}
		if ( ! ( $type & Message::TM_STRUCT ) ) {
			return;
		}
		$entry = $message[ Message::VALUE ];
		if ( ! \is_array( $entry ) ) {
			return;
		}
		$encoded = \wp_json_encode( $entry );
		if ( false !== $encoded && \strlen( $encoded ) > self::MAX_JOB_SIZE ) {
			Core::print_less_often( 'JobWorker: oversized entry, skipping' );
			return;
		}
		// Canonical jobs.log / jobintake.log entry: {k, handler, parameters, ts}.
		// `k` is the firehose category field ('job' | 'remote_job'); Job_Intake
		// writes it verbatim and Job_Router carries it through unrenamed.
		$kind = $entry['k'] ?? '';
		if ( 'job' !== $kind && 'remote_job' !== $kind ) {
			return;
		}
		/** @var int|float|string|bool|null $raw_handler */
		$raw_handler = $entry['handler'] ?? '';
		$handler     = (string) $raw_handler;
		if ( ! \preg_match( self::HANDLER_NAME_PATTERN, $handler ) ) {
			Core::print_less_often( "JobWorker: invalid handler name: $handler" );
			return;
		}
		$handlers = ( 'remote_job' === $kind ) ? $this->remote_handlers : $this->local_handlers;
		if ( ! isset( $handlers[ $handler ] ) ) {
			Core::print_less_often( "JobWorker: no $kind handler registered for: $handler" );
			return;
		}
		$parameters = $entry['parameters'] ?? [];

		// Per-job discipline. Applications hook request-scoped context (suspend a
		// parent logger, rewrite $_SERVER, etc.) onto these actions. before_job
		// fires INSIDE the try so a misbehaving listener can neither skip the
		// after_job cleanup (which would leave a suspended app logger un-resumed)
		// nor escape fill() into the un-caught Consumer drain (which would crash
		// the whole batch). The after_job action always fires — gc/cache cleanup
		// must run MOST when a job misbehaves, since that's when leaks accumulate
		// fastest.
		try {
			\do_action( 'newspack_nodes/job_worker/before_job', $handler );
			( $handlers[ $handler ] )( $parameters );
		} catch ( \Throwable $e ) {
			Core::print_less_often( "JobWorker: job $handler threw: " . $e->getMessage() );
		} finally {
			\do_action( 'newspack_nodes/job_worker/after_job', $handler );
		}
		++$this->jobs_executed;
		++$this->jobs_since_cache_flush;

		// Force a GC cycle every job. Reference-counted GC can't break cycles
		// immediately; explicit collection delays the watermark trip.
		\gc_collect_cycles();

		// Periodic object-cache flush extends per-process runtime by orders of
		// magnitude on workloads that fan out wp_query under handler control.
		if ( $this->jobs_since_cache_flush >= $this->cache_flush_interval ) {
			if ( \function_exists( 'wp_cache_flush' ) ) {
				\wp_cache_flush();
			}
			$this->set_state(
				'CACHE_FLUSH',
				[ 'jobs' => $this->cache_flush_interval ]
			);
			$this->jobs_since_cache_flush = 0;
		}

		// Memory watermark check. If we cross 80% of memory_limit, latch the
		// pressure flag — topology code reads memory_pressure() in its drain
		// predicate and exits cleanly so the supervisor respawns.
		if ( $this->is_memory_high() && ! $this->memory_pressure ) {
			$this->set_state( 'MEMORY_PRESSURE', [ 'usage' => \memory_get_usage( true ) ] );
			$this->memory_pressure = true;
		}

		if ( null !== $this->between_jobs_cb ) {
			// Pass the counter so the callback owns cadence decisions.
			( $this->between_jobs_cb )( $this->jobs_executed );
		}
	}

	/**
	 * @param array<int, mixed> $message
	 */
	private function handle_request( array $message ): void {
		if ( null === $this->sink ) {
			throw new \RuntimeException( 'Job_Worker::fill requires a wired sink' );
		}
		/** @var int|float|string|bool|null $raw_value */
		$raw_value = $message[ Message::VALUE ];
		$value     = (string) $raw_value;
		$verb      = \strtoupper( \explode( ' ', \trim( $value ), 2 )[0] );

		if ( 'GET_HEALTH' === $verb ) {
			$mem_limit = $this->memory_limit_bytes();
			$mem_used  = \memory_get_usage( true );
			$payload   = [
				'memory_used_mb'           => (int) \round( $mem_used / 1048576, 1 ),
				'memory_limit_mb'          => $mem_limit > 0 ? (int) \round( $mem_limit / 1048576, 1 ) : -1,
				'memory_pressure'          => $this->memory_pressure,
				'jobs_since_cache_flush'   => $this->jobs_since_cache_flush,
				'cache_flush_interval'     => $this->cache_flush_interval,
				'local_handler_count'      => \count( $this->local_handlers ),
				'remote_handler_count'     => \count( $this->remote_handlers ),
				'counter'                  => $this->counter,
			];
		} else {
			$payload = [ 'error' => "unknown request verb: {$verb}" ];
		}

		$reply                   = Message::new_message();
		$reply[ Message::TYPE ]  = Message::TM_STRUCT | Message::TM_RESPONSE;
		$reply[ Message::FROM ]  = $this->name;
		$reply[ Message::TO ]    = $message[ Message::FROM ];
		$reply[ Message::ID ]    = $message[ Message::ID ];
		$reply[ Message::KEY ]   = $message[ Message::KEY ];
		$reply[ Message::VALUE ] = [ 'verb' => $verb, 'data' => $payload ];
		$this->sink->fill( $reply );
	}

	private function memory_limit_bytes(): int {
		$ini = \ini_get( 'memory_limit' );
		if ( '-1' === $ini ) {
			return -1;
		}
		$num = (int) $ini;
		switch ( \strtolower( \substr( $ini, -1 ) ) ) {
			case 'g':
				$num *= 1024 * 1024 * 1024;
				break;
			case 'm':
				$num *= 1024 * 1024;
				break;
			case 'k':
				$num *= 1024;
				break;
		}
		return $num;
	}

	/**
	 * Whether memory_get_usage(true) has crossed MEMORY_WATERMARK_PCT of
	 * memory_limit. Returns false if memory_limit is unlimited (-1).
	 */
	public function is_memory_high(): bool {
		$limit = $this->memory_limit_bytes();
		if ( $limit <= 0 ) {
			return false;
		}
		return \memory_get_usage( true ) >= ( $limit * self::MEMORY_WATERMARK_PCT );
	}

	private function validate_handler_name( string $name ): void {
		if ( ! \preg_match( self::HANDLER_NAME_PATTERN, $name ) ) {
			throw new \InvalidArgumentException( \esc_html( "invalid handler name: $name" ) );
		}
	}

	/** Register a handler that runs for k='job' entries (every node). */
	public function set_local_handler( string $name, callable $cb ): void {
		$this->validate_handler_name( $name );
		$this->local_handlers[ $name ] = $cb;
	}

	/** Register a handler that runs for k='remote_job' entries (hub only). */
	public function set_remote_handler( string $name, callable $cb ): void {
		$this->validate_handler_name( $name );
		$this->remote_handlers[ $name ] = $cb;
	}

	/**
	 * Backward-compatible alias for set_local_handler. Pre-split callers
	 * registered everything as a single handler set.
	 */
	public function register_handler( string $name, callable $cb ): void {
		$this->set_local_handler( $name, $cb );
	}

	public function has_local_handler( string $name ): bool {
		return isset( $this->local_handlers[ $name ] );
	}

	public function has_remote_handler( string $name ): bool {
		return isset( $this->remote_handlers[ $name ] );
	}

	public function has_handler( string $name ): bool {
		return $this->has_local_handler( $name ) || $this->has_remote_handler( $name );
	}

	/**
	 * Load handlers from the standard WordPress filters. Called by the
	 * job-workers topology after make_node so plugins that register via
	 * add_filter('newspack_nodes/{job,remote_job}_handlers', ...) get picked up.
	 */
	public function load_handlers_from_filters(): void {
		if ( ! \function_exists( 'apply_filters' ) ) {
			return;
		}
		$local = \apply_filters( 'newspack_nodes/job_handlers', [] );
		if ( \is_array( $local ) ) {
			foreach ( $local as $name => $cb ) {
				if ( \is_string( $name ) && \is_callable( $cb ) && \preg_match( self::HANDLER_NAME_PATTERN, $name ) ) {
					$this->local_handlers[ $name ] = $cb;
				}
			}
		}
		$remote = \apply_filters( 'newspack_nodes/remote_job_handlers', [] );
		if ( \is_array( $remote ) ) {
			foreach ( $remote as $name => $cb ) {
				if ( \is_string( $name ) && \is_callable( $cb ) && \preg_match( self::HANDLER_NAME_PATTERN, $name ) ) {
					$this->remote_handlers[ $name ] = $cb;
				}
			}
		}
	}

	/**
	 * Register a between-jobs callback that fires after every job. Pass null to
	 * clear. The callback receives the jobs_executed counter as its single arg
	 * so it can decide its own cadence.
	 */
	public function set_between_jobs_callback( ?callable $cb ): void {
		$this->between_jobs_cb = $cb;
	}

	public function jobs_executed(): int {
		return $this->jobs_executed;
	}

	/** Stale-timeout hint exposed for topology config. */
	public function get_stale_timeout(): int {
		return $this->stale_timeout;
	}

	/** Max-runtime hint exposed for topology config. */
	public function get_max_runtime(): int {
		return $this->max_runtime;
	}

	/**
	 * Whether a previous job's memory check tripped the watermark. Topology
	 * code (or the worker's drain predicate) reads this to decide whether to
	 * exit cleanly so the supervisor can respawn into a fresh process.
	 */
	public function memory_pressure(): bool {
		return $this->memory_pressure;
	}

	public static function node_schema(): array {
		return [
			'category'    => 'Control',
			'description' => 'Consumes jobs.log entries and dispatches to registered handlers.',
			'arguments'        => [
				[ 'name' => 'cache_flush_interval', 'type' => 'int', 'default' => self::CACHE_FLUSH_INTERVAL ],
				[ 'name' => 'stale_timeout',        'type' => 'int', 'default' => self::DEFAULT_STALE_TIMEOUT ],
				[ 'name' => 'max_runtime',          'type' => 'int', 'default' => self::DEFAULT_MAX_RUNTIME ],
			],
			'commands'       => [],
			'requests'    => [
				[
					'name'        => 'GET_HEALTH',
					'description' => 'Memory pressure + handler counts + cache-flush progress.',
					'reply_shape' => '{ memory_used_mb, memory_limit_mb, memory_pressure, jobs_since_cache_flush, cache_flush_interval, local_handler_count, remote_handler_count, counter }',
				],
			],
			'has_target'  => false,
		];
	}
}
