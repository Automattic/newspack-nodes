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

	/** Default cache-flush interval in jobs. */
	public const CACHE_FLUSH_INTERVAL = 50;

	public const HANDLER_NAME_PATTERN = '/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/';
	public const MAX_JOB_SIZE         = Job_Intake::MAX_JOB_SIZE;

	/** Cap on the durable last-run message so a jobstats record stays under PIPE_BUF. */
	public const MAX_STAT_MESSAGE_LEN = 1024;

	protected int $cache_flush_interval = self::CACHE_FLUSH_INTERVAL;
	/** @api Used by unit tests. */
	private int $jobs_executed = 0;
	private int $jobs_since_cache_flush = 0;

	/**
	 * Per-identity job-stats accumulator. Keyed by `handler:id` (top-level `id`
	 * present) or `handler`; each entry holds cumulative counters + last-run detail.
	 * The Job_Probe sweeps it via probe_stats() into the durable jobstats.p0 log.
	 *
	 * @var array<string,array{handler:string,runs:int,errors:int,duration_ms:float,queue_ms:float,items_ok:int,items_err:int,last_ts:int,last_duration_ms:int,last_status:string,last_message:string}>
	 */
	private array $job_stats = [];

	/** @var array<string,callable> */
	private array $local_handlers = [];

	/** @var array<string,callable> */
	private array $remote_handlers = [];

	/** Tachikoma-parity: no-arg ctor. Positional config arrives via arguments(). */
	public function __construct() {
		parent::__construct();

		// Eager-load handlers: plugins_loaded has fired by TSL eval time.
		$this->load_handlers_from_filters();
	}

	/**
	 * Store the raw string, parse positional tokens via parse_schema_args()
	 * (cache_flush_interval), then clamp each knob
	 * to a minimum of 1.
	 *
	 * @param list<string>|null $args
	 * @return list<string>
	 */
	public function arguments( ?array $args = null ): array {
		if ( null === $args ) {
			return parent::arguments();
		}
		$this->parse_schema_args( $args );
		$this->cache_flush_interval = \max( 1, $this->cache_flush_interval );
		return $args;
	}

	public function fill( array $message ): void {
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
		// Entry carries kind k (job or remote_job), handler, parameters, ts.
		$kind = $entry['k'] ?? '';
		if ( 'job' !== $kind && 'remote_job' !== $kind ) {
			return;
		}
		/** @var int|float|string|bool|null $raw_handler */
		$raw_handler = $entry['handler'] ?? '';
		$handler     = (string) $raw_handler;
		if ( ! \preg_match( self::HANDLER_NAME_PATTERN, $handler ) ) {
			$this->print_less_often( 'JobWorker: invalid handler name: ', $handler );
			return;
		}
		$handlers = ( 'remote_job' === $kind ) ? $this->remote_handlers : $this->local_handlers;
		if ( ! isset( $handlers[ $handler ] ) ) {
			if ( 'job' === $kind ) {
				$this->print_less_often( 'no job handler registered for: ', $handler );
			}
			return;
		}
		$parameters = $entry['parameters'] ?? [];

		// Identity: top-level `id` distinguishes jobs sharing one handler name.
		$id  = Core::as_string( $entry['id'] ?? '', '' );
		$key = ( '' !== $id ) ? "{$handler}:{$id}" : $handler;
		$ts  = Core::num_float( $entry['ts'] ?? 0, 0.0 );

		// Apps hook request context on before/after_job; asymmetry deliberate.
		$before_ok = false;
		$outcome   = null;
		try {
			try {
				\do_action( 'newspack_nodes/job_worker/before_job', $handler );
				$before_ok = true;
			} catch ( Worker_Should_Stop $e ) {
				throw $e;
			} catch ( \Throwable $e ) {
				// before_job listener crash must not kill batch; swallow, skip.
				$this->print_less_often( 'before_job listener threw: ', $e->getMessage() );
			}
			if ( $before_ok ) {
				$started  = \microtime( true );
				$queue_ms = $ts > 0 ? \max( 0.0, ( $started - $ts ) * 1000 ) : 0.0;
				try {
					$result  = ( $handlers[ $handler ] )( $parameters );
					$outcome = $this->classify_outcome( $result );
				} catch ( Worker_Should_Stop $e ) {
					// Cooperative stop is not a job failure: record nothing.
					throw $e;
				} catch ( \Throwable $e ) {
					// Poison: record first — the throw skips post-try.
					$outcome = [ 'status' => 'error', 'message' => $e->getMessage(), 'items_ok' => 0, 'items_err' => 0 ];
					$this->record_job_stats( $key, $handler, $started, $queue_ms, $outcome );
					throw $e;
				}
				$this->record_job_stats( $key, $handler, $started, $queue_ms, $outcome );
			}
		} finally {
			// after_job always fires; swallow throw so it can't mask the error.
			try {
				\do_action( 'newspack_nodes/job_worker/after_job', $handler, $outcome );
			} catch ( \Throwable $e ) {
				$this->print_less_often( 'after_job listener threw: ', $e->getMessage() );
			}
		}
		++$this->jobs_executed;
		++$this->jobs_since_cache_flush;

		// Force GC each job; refcount GC can't break cycles immediately.
		\gc_collect_cycles();

		// Periodic cache flush extends runtime on wp_query-heavy handlers.
		if ( $this->jobs_since_cache_flush >= $this->cache_flush_interval ) {
			if ( \function_exists( 'wp_cache_flush' ) ) {
				\wp_cache_flush();
			}
			$this->set_state( 'CACHE_FLUSH', (string) $this->cache_flush_interval );
			$this->jobs_since_cache_flush = 0;
		}
	}

	/**
	 * Classify a handler's return value into an outcome, honoring the pyrobase-cron
	 * contract verbatim: `success_count` defaults to -1 (the "no stats reported"
	 * sentinel) and `error_count` to 0. all-errors-no-items → error; any errors with
	 * items → success "Completed with errors"; else a plain success. The -1 sentinel
	 * never pollutes the items total (clamped to 0).
	 *
	 * @param mixed $result The handler's return value (often null / void).
	 * @return array{status:string,message:string,items_ok:int,items_err:int}
	 */
	private function classify_outcome( mixed $result ): array {
		$stats         = ( \is_array( $result ) && isset( $result['stats'] ) && \is_array( $result['stats'] ) ) ? $result['stats'] : [];
		$success_count = Core::as_int( $stats['success_count'] ?? -1, -1 );
		$error_count   = Core::as_int( $stats['error_count'] ?? 0, 0 );

		if ( $error_count > 0 && 0 === $success_count ) {
			$status  = 'error';
			$message = "Job failed: {$error_count} error(s), no items processed";
		} elseif ( $error_count > 0 ) {
			$status    = 'success';
			$processed = \max( 0, $success_count ); // Clamp the -1 sentinel out of the display.
			$message   = "Completed with errors: {$processed} processed, {$error_count} error(s)";
		} else {
			$status  = 'success';
			$message = 'Job completed successfully';
		}

		return [
			'status'    => $status,
			'message'   => $message,
			'items_ok'  => \max( 0, $success_count ),
			'items_err' => $error_count,
		];
	}

	/**
	 * Fold one run's outcome + duration into the per-identity accumulator. Cumulative
	 * counters (never deltas) — the Job_Probe emits them raw and readers derive rates.
	 *
	 * @param string                                                                 $key      Job identity (`handler:id` or `handler`).
	 * @param string                                                                 $handler  Handler name.
	 * @param float                                                                  $started  microtime() at handler dispatch.
	 * @param float                                                                  $queue_ms Queue latency (start − enqueue ts), ms.
	 * @param array{status:string,message:string,items_ok:int,items_err:int}         $outcome  Classified outcome.
	 */
	private function record_job_stats( string $key, string $handler, float $started, float $queue_ms, array $outcome ): void {
		$duration_ms = ( \microtime( true ) - $started ) * 1000;
		$s           = $this->job_stats[ $key ] ?? [
			'handler'          => $handler,
			'runs'             => 0,
			'errors'           => 0,
			'duration_ms'      => 0.0,
			'queue_ms'         => 0.0,
			'items_ok'         => 0,
			'items_err'        => 0,
			'last_ts'          => 0,
			'last_duration_ms' => 0,
			'last_status'      => '',
			'last_message'     => '',
		];

		++$s['runs'];
		if ( 'error' === $outcome['status'] ) {
			++$s['errors'];
		}
		$s['duration_ms']     += $duration_ms;
		$s['queue_ms']        += $queue_ms;
		$s['items_ok']        += $outcome['items_ok'];
		$s['items_err']       += $outcome['items_err'];
		$s['last_ts']          = (int) Core::$now;
		$s['last_duration_ms'] = (int) \round( $duration_ms );
		$s['last_status']      = $outcome['status'];
		$s['last_message']     = \mb_substr( $outcome['message'], 0, self::MAX_STAT_MESSAGE_LEN );

		$this->job_stats[ $key ] = $s;
	}

	/**
	 * Probe seam: the accumulator as a LIST of positional Jobstats_Record snapshots
	 * (one per identity), for the Job_Probe to sweep into jobstats.p0. Mirrors
	 * Consumer_Node::probe_stats(), which yields ONE record; a worker owns many
	 * identities, so this yields many. Empty until the first job runs.
	 *
	 * @return array<int,array<int,int|string>> Jobstats_Record-indexed positional arrays.
	 */
	public function probe_stats(): array {
		$records = [];
		foreach ( $this->job_stats as $key => $s ) {
			$record                                    = [];
			$record[ Jobstats_Record::KEY ]            = $key;
			$record[ Jobstats_Record::HANDLER ]        = $s['handler'];
			$record[ Jobstats_Record::RUNS ]           = $s['runs'];
			$record[ Jobstats_Record::ERRORS ]         = $s['errors'];
			$record[ Jobstats_Record::DURATION_MS ]    = (int) \round( $s['duration_ms'] );
			$record[ Jobstats_Record::QUEUE_MS ]       = (int) \round( $s['queue_ms'] );
			$record[ Jobstats_Record::ITEMS_OK ]       = $s['items_ok'];
			$record[ Jobstats_Record::ITEMS_ERR ]      = $s['items_err'];
			$record[ Jobstats_Record::LAST_TS ]        = $s['last_ts'];
			$record[ Jobstats_Record::LAST_DURATION_MS ] = $s['last_duration_ms'];
			$record[ Jobstats_Record::LAST_STATUS ]    = $s['last_status'];
			$record[ Jobstats_Record::LAST_MESSAGE ]   = $s['last_message'];
			$records[] = $record;
		}
		return $records;
	}

	/**
	 * @param array<int, mixed> $message
	 */
	private function handle_request( array $message ): void {
		if ( null === $this->sink ) {
			throw new \RuntimeException( 'fill requires a wired sink' );
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
				[ 'name' => 'cache_flush_interval', 'type' => 'int', 'default' => self::CACHE_FLUSH_INTERVAL, 'description' => 'Jobs processed between wp_cache_flush() calls (default 50); clamped to a minimum of 1.' ],
			],
			'commands'       => [],
			'requests'    => [
				[
					'name'        => 'GET_HEALTH',
					'description' => 'Memory usage + handler counts + cache-flush progress.',
					'reply_shape' => '{ memory_used_mb, memory_limit_mb, jobs_since_cache_flush, cache_flush_interval, local_handler_count, remote_handler_count, counter }',
				],
			],
			'has_target'  => false,
		];
	}
}
