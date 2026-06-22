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
 * The worker eager-loads both filters in its constructor via
 * load_handlers_from_filters().
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
	/** @api Used by unit tests. */
	private int $jobs_executed = 0;
	private int $jobs_since_cache_flush = 0;

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
			$this->print_less_often( 'oversized entry, skipping' );
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
			$this->print_less_often( "JobWorker: invalid handler name: {$handler}" );
			return;
		}
		$handlers = ( 'remote_job' === $kind ) ? $this->remote_handlers : $this->local_handlers;
		if ( ! isset( $handlers[ $handler ] ) ) {
			$this->print_less_often( "no {$kind} handler registered for: {$handler}" );
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
		} catch ( Worker_Should_Stop $e ) {
			// pump()'s stop must escape the Throwable swallow below; after_job still runs.
			throw $e;
		} catch ( \Throwable $e ) {
			$this->print_less_often( "job {$handler} threw: " . $e->getMessage() );
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
			$this->set_state( 'CACHE_FLUSH', (string) $this->cache_flush_interval );
			$this->jobs_since_cache_flush = 0;
		}

		// Memory watermark check. If we cross 80% of memory_limit, latch the
		// pressure flag and emit the MEMORY_PRESSURE set_state event (also
		// surfaced in GET_HEALTH) so the supervisor can respawn into a fresh
		// process. Latched so the event fires once per pressure episode.
		if ( $this->is_memory_high() && ! $this->memory_pressure ) {
			$this->set_state( 'MEMORY_PRESSURE', \implode( ' ', [ 'USAGE', \memory_get_usage( true ) ] ) );
			$this->memory_pressure = true;
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
