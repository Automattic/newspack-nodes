<?php
/**
 * Job Intake
 *
 * Provides an interface for import/cron processes to queue large (>PIPE_BUF)
 * jobs. Jobs written here land in jobintake.log; a topology's Consumer drains
 * them into jobs.log for the Job_Worker pool.
 *
 * Locking happens per-Partition inside `Partition::allow_large_writes()` —
 * one writer per partition, multiple partitions can write in parallel.
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes;

if ( ! \defined( 'ABSPATH' ) ) {
	exit;
}

/**
 * Job Intake class.
 *
 * @api Large-write job ingress. Consumed by sibling plugins (event-logger-nodes,
 *      nuclear-gyrobase, pyrobase) and the stock `job-intake.tsl` topology.
 */
class Job_Intake {

	/** Log basename Job_Intake writes; Bootstrap registers it as a GC-protected producer. */
	public const LOG_BASENAME = 'jobintake';

	/**
	 * Log basename for the small-job ingress. The PIPE_BUF-atomic counterpart to
	 * LOG_BASENAME: no write lock, so a job-router can tail jobs alone instead of
	 * the whole firehose. Bootstrap registers it as a GC-protected producer.
	 */
	public const FEED_BASENAME = 'jobfeed';

	/**
	 * Segment rotation threshold for FEED_BASENAME, against Partition's 64 MiB
	 * default. Every logged request can write here and a job-router only reads
	 * the recent tail, so small segments keep retention cheap.
	 */
	public const FEED_SEGMENT_SIZE = 1048576;

	/**
	 * Basename of the single delayed-jobs partition (hardwired `.p0`, the
	 * alerts.p0 precedent). Entries whose `not_before` is still in the future
	 * land here; `Job_Delay::sweep()` circulates them until due.
	 */
	public const DELAY_BASENAME = 'jobdelay';

	/**
	 * Dir template per log basename, relative to the logs dir — the one place
	 * Job_Intake's layout is written. `log_dir_templates()` serves both the writer
	 * and the GC registration, so the dirs written and the dirs declared cannot
	 * drift apart.
	 */
	private const DIR_TEMPLATES = [
		self::LOG_BASENAME   => self::LOG_BASENAME . '.p<partition>',
		self::FEED_BASENAME  => self::FEED_BASENAME . '.p<partition>',
		self::DELAY_BASENAME => self::DELAY_BASENAME . '.p0',
	];

	/** Batch counters outlive any sane batch runtime, then self-expire. */
	public const BATCH_TTL_S = 7 * 86400;

	/** Every option write_job() accepts; anything else throws (typos stay loud). */
	private const OPTION_KEYS = [ 'not_before', 'delay', 'retries', 'attempt', 'batch', 'unique', 'unique_ttl' ];

	/**
	 * Entry fields beyond the core `k`/`handler`/`parameters`/`ts`/`id` that
	 * Job_Worker dispatch reads back off jobs.log: `retries`/`attempt` gate
	 * `schedule_retry()`, `batch` gates `settle_batch()`, `key` re-hashes the
	 * partition on requeue. write_job() writes them; an application's
	 * Job_Router must CARRY them when it normalizes an entry onto jobs.log.
	 *
	 * The canonical list, because a normalizer that rebuilds a fixed record
	 * instead of overlaying silently drops whatever it has not heard of —
	 * which disabled retry and batch fan-in wherever such a router ran.
	 *
	 * @var list<string>
	 */
	public const DISPATCH_FIELDS = [ 'retries', 'attempt', 'batch', 'key' ];

	/**
	 * Maximum job size in bytes (32 MB). The canonical cap: Job_Worker_Node and
	 * an application's Job_Router derive their limit from this constant.
	 */
	public const MAX_JOB_SIZE = 32 * 1024 * 1024;

	/** Max chars for the optional per-job `id` (it rides in jobstats record KEYs). */
	public const MAX_JOB_ID_LEN = 128;

	/**
	 * Valid handler name pattern (must match JobRouter and JobWorker).
	 */
	private const HANDLER_NAME_PATTERN = '/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/';

	/**
	 * Round-robin counter for partition distribution.
	 *
	 * @var int
	 */
	private static int $round_robin = 0;

	/**
	 * Base directory for this intake's log + lock dirs.
	 *
	 * @var string
	 */
	private string $base_dir;

	/**
	 * Number of partitions.
	 *
	 * @var int
	 */
	private int $num_partitions;

	/**
	 * Partition instances keyed by "{basename}.p{index}".
	 *
	 * @var array<string,Partition_Node>
	 */
	private array $partitions = [];

	/**
	 * Pinned partition (null = round-robin).
	 *
	 * @var int|null
	 */
	private ?int $pinned_partition = null;

	/**
	 * Constructor.
	 *
	 * Both `$base_dir` and `$num_partitions` default to the substrate config
	 * (`Config::load_config()`) — callers don't need to thread them through
	 * unless they're targeting a non-default location (e.g. tests with a tmp
	 * dir). Pass strings/ints explicitly to override.
	 *
	 * @param string|null $base_dir       Base directory containing logs/ and locks/.
	 * @param int|null    $num_partitions Number of partitions.
	 */
	public function __construct( ?string $base_dir = null, ?int $num_partitions = null ) {
		if ( null === $base_dir || null === $num_partitions ) {
			$base_dir       = $base_dir ?? Config::get_base_directory();
			$num_partitions = $num_partitions ?? Bootstrap::global_num_partitions();
		}
		$this->base_dir = \rtrim( $base_dir, '/' );
		// Clamped to what a worker consumes; past it, the GC sweeps the dir.
		$this->num_partitions = \min(
			Spawn_Coordinator::MAX_PARTITIONS,
			\max( 1, $num_partitions )
		);
	}

	/**
	 * Write multiple jobs in a batch.
	 *
	 * An atomic counter in the selected cache backend tracks a `$batch`. It is
	 * seeded to the valid-job count BEFORE writing, and every entry is tagged.
	 * The Job_Worker decrements it per settled job; the decrement that reaches 0
	 * signals completion (`newspack_nodes/job_worker/batch_complete` + an
	 * alerts.p0 row). A write that fails after seeding leaves the batch open;
	 * compare the return value against your job count.
	 *
	 * @api Used by external plugins.
	 * @param array<int,array<string,mixed>> $jobs  Zero-indexed list of ['handler' => string, 'parameters' => array].
	 * @param string|null                      $key   Optional partition key for all jobs.
	 * @param string|null                      $batch Optional fan-in batch id (requires a selected
	 *                                                cache backend: Memcached or APCu).
	 * @return int Number of jobs successfully written.
	 * @throws \LogicException When $batch is given with no claim store (memcached or APCu).
	 * @throws \RuntimeException When the batch id is already active.
	 */
	public function queue_many( array $jobs, ?string $key = null, ?string $batch = null ): int {
		$options = [];
		$backend = null;
		if ( null !== $batch && '' !== $batch ) {
			$backend = Cache_Backend::shared_first();
			if ( null === $backend ) {
				throw new \LogicException( 'batch jobs require memcached or APCu' );
			}
			$valid = \count(
				\array_filter(
					$jobs,
					static fn ( $job ): bool => \is_string( $job['handler'] ?? null )
						&& \is_array( $job['parameters'] ?? [] )
						&& 1 === \preg_match( self::HANDLER_NAME_PATTERN, $job['handler'] )
				)
			);
			if ( ! $backend->add( self::batch_count_key( $batch ), $valid, self::BATCH_TTL_S ) ) {
				// phpcs:ignore WordPress.Security.EscapeOutput.ExceptionNotEscaped -- plain-text message for log/CLI consumers; escape at the view, not the runtime.
				throw new \RuntimeException( "batch id already active: {$batch}" );
			}
			$backend->add( self::batch_err_key( $batch ), 0, self::BATCH_TTL_S );
			$options['batch'] = $batch;
		}

		$written = 0;

		foreach ( $jobs as $job ) {
			$handler    = $job['handler'] ?? '';
			$parameters = $job['parameters'] ?? [];
			$id         = $job['id'] ?? null;

			if ( ! \is_string( $handler ) || ! \is_array( $parameters ) ) {
				continue;
			}

			/** @var array<string,mixed> $parameters */
			if ( $this->write_job( $handler, $parameters, $key, \is_string( $id ) ? $id : null, $options ) ) {
				++$written;
			}
		}

		return $written;
	}

	/**
	 * Write a job to the job intake.
	 *
	 * Partition selection:
	 * - If pinned via partition(), always uses that partition
	 * - If key provided, hashes to consistent partition
	 * - Otherwise, round-robin across partitions
	 *
	 * @param string      $handler    Handler name (alphanumeric, underscores, hyphens, max 64 chars).
	 * @param array<string,mixed>       $parameters Job parameters (can be large).
	 * @param string|null $key        Optional partition key for consistent routing.
	 * @param string|null $id         Optional per-job identity (top-level `id`) for durable
	 *                                jobstats keying ("handler:id"); omitted entirely when null/empty.
	 * @param array<string,mixed>       $options    Optional behaviors: `not_before` (unix ts) or `delay`
	 *                                (seconds) schedules the job via jobdelay.p0; `retries` (int)
	 *                                opts into Job_Worker backoff retries; `unique` + `unique_ttl`
	 *                                dedups the enqueue within the ttl window (requires a selected
	 *                                cache backend: Memcached or APCu);
	 *                                `attempt`/`batch` are internal passthrough fields.
	 * @return bool True on success, false on validation failure, lock unavailable,
	 *              write error, or a duplicate `unique` enqueue inside its window.
	 * @throws \InvalidArgumentException On an unknown option key, not_before+delay together, or `unique` without a positive `unique_ttl`.
	 * @throws \LogicException When `unique` is passed with no claim store (memcached or APCu).
	 * @throws \RuntimeException From the per-Partition write lock on a genuine concurrent writer.
	 */
	public function write_job( string $handler, array $parameters, ?string $key = null, ?string $id = null, array $options = [] ): bool {
		return $this->write_entry( $handler, $parameters, $key, $id, $options, self::LOG_BASENAME, true );
	}

	/** Error tally for a batch; see batch_count_key(). */
	public static function batch_err_key( string $batch ): string {
		return Cache_Backend::site_key( 'job-batch-err:' . $batch );
	}

	/**
	 * Memcache keys for the batch fan-in counters and the unique-enqueue gate.
	 * Site-scoped through Cache_Backend: one fleet spans many containers and
	 * must agree on them, but a co-tenant install on the same memcached must
	 * not join in. Builders, not prefixes — a scope the caller has to remember
	 * to apply is one a caller eventually forgets.
	 */
	public static function batch_count_key( string $batch ): string {
		return Cache_Backend::site_key( 'job-batch:' . $batch );
	}

	/**
	 * Queue a small job on the feed log, unlocked.
	 *
	 * The same envelope write_job() produces, on FEED_BASENAME. Taking no write
	 * lock means PIPE_BUF binds it, so an entry that only fits under the lifted
	 * cap is refused here — route that one through queue() instead of losing it.
	 *
	 * @param string               $handler    Handler name.
	 * @param array<string,mixed> $parameters Job parameters (must fit PIPE_BUF once packed).
	 * @param string|null          $key        Optional partition key for consistent routing.
	 * @param string|null          $id         Optional per-job identity for jobstats keying.
	 * @return bool False on validation failure or an entry over the atomic cap.
	 */
	public function write_feed( string $handler, array $parameters, ?string $key = null, ?string $id = null ): bool {
		return $this->write_entry( $handler, $parameters, $key, $id, [], self::FEED_BASENAME, false );
	}

	/**
	 * Shared write path for both ingress logs.
	 *
	 * @param string               $handler    Handler name.
	 * @param array<string,mixed> $parameters Job parameters.
	 * @param string|null          $key        Optional partition key.
	 * @param string|null          $id         Optional per-job identity.
	 * @param array<string,mixed> $options    write_job() options; empty for the feed path.
	 * @param string               $basename   Target log basename.
	 * @param bool                 $large      Lift the PIPE_BUF cap and take the write lock.
	 *                                         The delay branch below assumes it: jobdelay is written locked.
	 * @return bool True when the entry was handed to its Partition.
	 * @throws \InvalidArgumentException On an unknown option key or not_before+delay together.
	 */
	private function write_entry( string $handler, array $parameters, ?string $key, ?string $id, array $options, string $basename, bool $large ): bool {
		$unknown = \array_diff( \array_keys( $options ), self::OPTION_KEYS );
		if ( [] !== $unknown ) {
			// phpcs:ignore WordPress.Security.EscapeOutput.ExceptionNotEscaped -- plain-text message for log/CLI consumers; escape at the view, not the runtime.
			throw new \InvalidArgumentException( 'unknown job option(s): ' . \implode( ', ', $unknown ) );
		}

		// Validate handler name.
		if ( ! \preg_match( self::HANDLER_NAME_PATTERN, $handler ) ) {
			return false;
		}

		// The id rides in every jobstats KEY — bound it here.
		if ( null !== $id && \strlen( $id ) > self::MAX_JOB_ID_LEN ) {
			Core::stderr( '[Nodes] JobIntake: Job id exceeds ' . self::MAX_JOB_ID_LEN . ' chars for handler: ' . $handler );
			return false;
		}

		if ( isset( $options['not_before'] ) && isset( $options['delay'] ) ) {
			throw new \InvalidArgumentException( 'pass not_before OR delay, not both' );
		}
		$now        = Core::right_now(); // one request-scope read, threaded through this write_job
		$not_before = Core::num_float( $options['not_before'] ?? 0, 0.0 );
		if ( isset( $options['delay'] ) ) {
			$not_before = $now + Core::num_float( $options['delay'], 0.0 );
		}

		if ( isset( $options['unique'] ) && ! $this->claim_unique( $handler, $options ) ) {
			return false;
		}

		// Select partition.
		if ( null !== $this->pinned_partition ) {
			$partition = $this->pinned_partition;
		} elseif ( null !== $key && '' !== $key ) {
			$partition = Partition_Node::hash_to_partition( $key, $this->num_partitions );
		} else {
			$partition         = self::$round_robin % $this->num_partitions;
			self::$round_robin = ( self::$round_robin + 1 ) % \PHP_INT_MAX;
		}

		// Clamp partition to valid range.
		$partition = \max( 0, \min( $partition, $this->num_partitions - 1 ) );

		$job = [
			'k'          => 'job',
			'handler'    => $handler,
			'parameters' => $parameters,
			'ts'         => $now,
		];
		if ( null !== $id && '' !== $id ) {
			$job['id'] = $id;
		}
		foreach ( [ 'retries', 'attempt' ] as $field ) {
			$n = Core::as_int( $options[ $field ] ?? 0, 0 );
			if ( $n > 0 ) {
				$job[ $field ] = $n;
			}
		}
		$batch = Core::as_string( $options['batch'] ?? '', '' );
		if ( '' !== $batch ) {
			$job['batch'] = $batch;
		}
		if ( null !== $key && '' !== $key ) {
			// Keyed entries keep their key; retries + delivery re-hash it.
			$job['key'] = $key;
		}

		// Still-future job: park it in jobdelay.p0 instead of the live intake.
		if ( $not_before > $now ) {
			$job['not_before'] = $not_before;
			$basename          = self::DELAY_BASENAME;
			$partition         = 0;
		}

		$encoded = \wp_json_encode( $job );
		if ( false === $encoded || \strlen( $encoded ) > self::MAX_JOB_SIZE ) {
			Core::stderr( '[Nodes] JobIntake: Job exceeds size limit for handler: ' . $handler );
			return false;
		}

		// TM_STRUCT ($job is structured) so Partition::fill packs and appends.
		$message                       = Message::new_message();
		$message[ Message::TYPE ]      = Message::TM_STRUCT;
		$message[ Message::TIMESTAMP ] = Core::$now;
		$message[ Message::VALUE ]     = $job;
		// serialize_record appends a newline; unlocked writes clear that too.
		if ( ! $large && Message::packed_size( $message ) + 1 > Partition_Node::MAX_LINE_SIZE ) {
			Core::stderr( '[Nodes] JobIntake: job exceeds PIPE_BUF for handler: ' . $handler . ' (use queue())' );
			return false;
		}
		// Partition_Node marks the on-demand wake; it sees every producer.
		$this->partition_handle( $partition, $basename, $large )->fill( $message );
		return true;
	}

	/**
	 * Lazily materialize the Partition for a given index. The per-Partition
	 * `allow_large_writes()` call acquires the partition's write lock — blocks
	 * up to ~65s on a respawn race, throws on a genuine concurrent writer.
	 */
	private function partition_handle( int $partition, string $basename = self::LOG_BASENAME, bool $large = true ): Partition_Node {
		$slot = "{$basename}.p{$partition}";
		if ( isset( $this->partitions[ $slot ] ) ) {
			return $this->partitions[ $slot ];
		}
		$dir = Core::resolve_partition_template(
			self::log_dir_templates( $this->base_dir . '/logs' )[ $basename ],
			$partition
		);
		// pid+object-id token: 2nd JobIntake won't clash with stale Core regs.
		$instance_token = \getmypid() . '-' . \spl_object_id( $this );
		$p              = new Partition_Node();
		$p->name( "{$basename}.{$instance_token}.p{$partition}" );
		// Sibling plumbing: patron-link so dump_metadata hides from canvas.
		$p->patron( $p );
		// Rule 4: sink into the interpreter only when one is in scope.
		$ci = Core::node( Node_Names::COMMAND_INTERPRETER );
		if ( null === $p->sink() && null !== $ci ) {
			$p->sink( $ci );
		}
		$args = [ $dir ];
		if ( self::FEED_BASENAME === $basename ) {
			$args[] = (string) self::FEED_SEGMENT_SIZE;
		}
		$p->arguments( $args );
		if ( $large ) {
			$p->allow_large_writes( Partition_Node::DEFAULT_LOCK_WAIT_MS );
		}
		$this->partitions[ $slot ] = $p;
		return $p;
	}

	/**
	 * Dir templates for every log Job_Intake writes, keyed by basename. Bootstrap
	 * registers these with the log GC and `partition_handle()` writes through
	 * them, so declaration and writer are the same statement. The default root is
	 * the `<config:logs_dir>` token — registration must not touch the filesystem;
	 * a writer with its own base passes that base's `logs` dir.
	 *
	 * @return array<string,string> `basename => path template`.
	 */
	public static function log_dir_templates( string $logs_dir = '<config:logs_dir>' ): array {
		$prefix = \rtrim( $logs_dir, '/' ) . '/';
		return \array_map(
			static fn ( string $template ): string => $prefix . $template,
			self::DIR_TEMPLATES
		);
	}

	/**
	 * Atomically claim the unique-enqueue slot for this window. The selected cache
	 * backend's atomic `add()` is the same claim idiom the command nonce and SSE
	 * slot pool use. Exactly one successful add wins the ttl; false means either a
	 * duplicate claim or a backend failure, and the caller fails closed on either.
	 *
	 * LogicException family throughout: static queue() swallows RuntimeException
	 * (its lock-contention boolean contract) and misuse must stay loud through it.
	 * The claim store resolves shared-first: memcached scope when configured,
	 * APCu keeping a memcached-less host functional.
	 *
	 * @param string               $handler Handler name (namespaces the slot).
	 * @param array<string,mixed> $options The write_job options (unique + unique_ttl).
	 * @return bool True when this enqueue won the slot.
	 * @throws \InvalidArgumentException Without a positive unique_ttl.
	 * @throws \LogicException When no selected cache backend is available.
	 */
	private function claim_unique( string $handler, array $options ): bool {
		$ttl = Core::as_int( $options['unique_ttl'] ?? 0, 0 );
		if ( $ttl < 1 ) {
			throw new \InvalidArgumentException( 'unique jobs require a positive unique_ttl' );
		}
		$backend = Cache_Backend::shared_first();
		if ( null === $backend ) {
			throw new \LogicException( 'unique jobs require memcached or APCu' );
		}
		$slot = self::unique_key( $handler, Core::as_string( $options['unique'], '' ) );
		return $backend->add( $slot, 1, $ttl );
	}

	/** Unique-enqueue claim slot; see batch_count_key(). */
	public static function unique_key( string $handler, string $token ): string {
		return Cache_Backend::site_key( 'job-uniq:' . $handler . ':' . $token );
	}

	/**
	 * Destructor — release any per-Partition write locks still held.
	 */
	public function __destruct() {
		$this->close();
	}

	/**
	 * Close all open Partitions. `Partition::remove_node()` flushes the batch
	 * and releases the per-Partition write lock.
	 */
	public function close(): void {
		foreach ( $this->partitions as $partition ) {
			$partition->flush();
			// remove_node() owns the siblings (lock + heartbeat).
			$partition->remove_node();
		}
		$this->partitions = [];
	}

	/**
	 * Static helper to write a single job.
	 *
	 * If a key is provided, jobs with the same key always go to the same partition.
	 * If no key is provided, jobs are distributed via round-robin.
	 *
	 * Lock acquisition (per-Partition, not host-wide) happens inside
	 * `Partition::allow_large_writes()`, which blocks up to ~65s on a respawn
	 * race and throws on a genuine concurrent live writer. We catch the
	 * throw and return false so callers retain the boolean contract.
	 *
	 * `$base_dir` and `$num_partitions` default to the substrate config — callers
	 * should normally just pass `(handler, parameters[, key])`. The trailing
	 * overrides are for tests targeting an isolated tmp dir.
	 *
	 * @api Used by external plugins (pyrobase Log runtime large-write path).
	 * @param string              $handler        Handler name.
	 * @param array<string,mixed> $parameters     Job parameters.
	 * @param string|null         $key            Optional partition key (e.g., event ID).
	 * @param string|null         $id             Optional job ID for logging.
	 * @param string|null         $base_dir       Override base directory.
	 * @param int|null            $num_partitions Override partition count.
	 * @param array<string,mixed> $options        Optional behaviors — see write_job().
	 * @return bool True on success, false on validation failure or unrecoverable
	 *              lock contention (live concurrent writer on same partition).
	 */
	public static function queue(
		string $handler,
		array $parameters,
		?string $key = null,
		?string $id = null,
		?string $base_dir = null,
		?int $num_partitions = null,
		array $options = []
	): bool {
		if ( ! \preg_match( self::HANDLER_NAME_PATTERN, $handler ) ) {
			return false;
		}

		$intake = new self( $base_dir, $num_partitions );
		try {
			$result = $intake->write_job( $handler, $parameters, $key, $id, $options );
		} catch ( Worker_Should_Stop $e ) {
			throw $e; // ADR-14: a cooperative stop is not a write failure.
		} catch ( \RuntimeException $e ) {
			$result = false;
		} finally {
			$intake->close();
		}
		return $result;
	}

	/**
	 * Queue a small job on the feed log — the static counterpart to queue().
	 *
	 * @api Small-job ingress. Paired with a firehose `job` write by every producer.
	 * @param string              $handler        Handler name.
	 * @param array<string,mixed> $parameters     Job parameters (must fit PIPE_BUF once packed).
	 * @param string|null         $key            Optional partition key for consistent routing.
	 * @param string|null         $id             Optional per-job identity for jobstats keying.
	 * @param string|null         $base_dir       Override the configured base dir.
	 * @param int|null            $num_partitions Override the configured partition count.
	 * @return bool False on validation failure or an entry over the atomic cap.
	 * @throws Worker_Should_Stop When a cooperative stop lands mid-write.
	 */
	public static function feed(
		string $handler,
		array $parameters,
		?string $key = null,
		?string $id = null,
		?string $base_dir = null,
		?int $num_partitions = null
	): bool {
		if ( ! \preg_match( self::HANDLER_NAME_PATTERN, $handler ) ) {
			return false;
		}

		$intake = new self( $base_dir, $num_partitions );
		try {
			$result = $intake->write_feed( $handler, $parameters, $key, $id );
		} catch ( Worker_Should_Stop $e ) {
			throw $e; // ADR-14: a cooperative stop is not a write failure.
		} catch ( \RuntimeException $e ) {
			$result = false;
		} finally {
			$intake->close();
		}
		return $result;
	}

	/**
	 * Pin all writes to a specific partition.
	 *
	 * @api Used by tests.
	 * @param int $partition Partition index.
	 * @return self For chaining.
	 */
	public function partition( int $partition ): self {
		$this->pinned_partition = \max( 0, \min( $partition, $this->num_partitions - 1 ) );
		return $this;
	}
}
