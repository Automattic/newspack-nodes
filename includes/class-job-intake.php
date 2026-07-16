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
	 * Maximum job size in bytes (32 MB). The canonical cap: Job_Worker_Node and
	 * an application's Job_Router derive their limit from this constant.
	 */
	public const MAX_JOB_SIZE = 32 * 1024 * 1024;

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
	 * Partition instances for each partition index.
	 *
	 * @var array<int, Partition_Node>
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
			$base_dir = $base_dir ?? Config::get_base_directory();
			/** @var int|float|string|bool|null $raw_num_partitions */
			$raw_num_partitions = Config::value( 'num_partitions' );
			$num_partitions     = $num_partitions ?? (int) $raw_num_partitions;
		}
		$this->base_dir       = \rtrim( $base_dir, '/' );
		$this->num_partitions = \max( 1, $num_partitions );
	}

	/**
	 * Write multiple jobs in a batch.
	 *
	 * @api Used by external plugins.
	 * @param array<int, array<string, mixed>> $jobs Zero-indexed list of ['handler' => string, 'parameters' => array].
	 * @param string|null                      $key  Optional partition key for all jobs.
	 * @return int Number of jobs successfully written.
	 */
	public function queue_many( array $jobs, ?string $key = null ): int {
		$written = 0;

		foreach ( $jobs as $job ) {
			$handler    = $job['handler'] ?? '';
			$parameters = $job['parameters'] ?? [];

			if ( ! \is_string( $handler ) || ! \is_array( $parameters ) ) {
				continue;
			}

			/** @var array<string, mixed> $parameters */
			if ( $this->write_job( $handler, $parameters, $key ) ) {
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
	 * @param array<string, mixed>       $parameters Job parameters (can be large).
	 * @param string|null $key        Optional partition key for consistent routing.
	 * @return bool True on success, false on validation failure, lock unavailable, or write error.
	 */
	public function write_job( string $handler, array $parameters, ?string $key = null ): bool {
		// Validate handler name.
		if ( ! \preg_match( self::HANDLER_NAME_PATTERN, $handler ) ) {
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
			'ts'         => \microtime( true ),
		];

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
		$this->partition_handle( $partition )->fill( $message );
		return true;
	}

	/**
	 * Lazily materialize the Partition for a given index. The per-Partition
	 * `allow_large_writes()` call acquires the partition's write lock — blocks
	 * up to ~65s on a respawn race, throws on a genuine concurrent writer.
	 */
	private function partition_handle( int $partition ): Partition_Node {
		if ( isset( $this->partitions[ $partition ] ) ) {
			return $this->partitions[ $partition ];
		}
		$log_base = $this->base_dir . '/logs/' . self::LOG_BASENAME;
		// pid+object-id token: 2nd JobIntake won't clash with stale Core regs.
		$instance_token = \getmypid() . '-' . \spl_object_id( $this );
		$p              = new Partition_Node();
		$p->name( self::LOG_BASENAME . ".{$instance_token}.p{$partition}" );
		// Sibling plumbing: patron-link so dump_metadata hides from canvas.
		$p->patron( $p );
		// Rule 4: sink into the interpreter only when one is in scope.
		$ci = Core::node( Node_Names::COMMAND_INTERPRETER );
		if ( null === $p->sink() && null !== $ci ) {
			$p->sink( $ci );
		}
		$p->arguments( [ "{$log_base}.p{$partition}" ] );
		$p->allow_large_writes();
		$this->partitions[ $partition ] = $p;
		return $p;
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
	 * @param string      $handler        Handler name.
	 * @param array<string, mixed>       $parameters     Job parameters.
	 * @param string|null $key            Optional partition key (e.g., event ID).
	 * @param string|null $base_dir       Override base directory.
	 * @param int|null    $num_partitions Override partition count.
	 * @return bool True on success, false on validation failure or unrecoverable
	 *              lock contention (live concurrent writer on same partition).
	 */
	public static function queue(
		string $handler,
		array $parameters,
		?string $key = null,
		?string $base_dir = null,
		?int $num_partitions = null
	): bool {
		if ( ! \preg_match( self::HANDLER_NAME_PATTERN, $handler ) ) {
			return false;
		}

		$intake = new self( $base_dir, $num_partitions );
		try {
			$result = $intake->write_job( $handler, $parameters, $key );
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
