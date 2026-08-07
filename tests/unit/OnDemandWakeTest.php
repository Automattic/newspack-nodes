<?php
/**
 * OnDemandWakeTest: enqueue implies spawn.
 *
 * Once `worker_needs_spawn()` stops resurrecting an absent on-demand worker,
 * something else has to bring it back, and cron at minute cadence is the
 * fallback tier rather than the mechanism — a job that waits up to 60s for a
 * tick is worse than the resident worker it replaced. The producer already
 * reaches `Spawn_Coordinator` for the throttle, so it wakes the fleet itself.
 *
 * Fire-and-forget throughout: the blocking enqueue form can wait on a partition
 * lock for longer than `stale_timeout` and get the caller's own lock stolen.
 *
 * @package Newspack_Nodes
 */

declare(strict_types=1);

namespace Newspack_Nodes\Tests\Unit;

use PHPUnit\Framework\Attributes\CoversClass;
use Newspack_Nodes\Bootstrap;
use Newspack_Nodes\Core;
use Newspack_Nodes\Job_Intake;
use Newspack_Nodes\Partition_Node;
use Newspack_Nodes\Spawn_Coordinator;
use Newspack_Nodes\Topology_Registry;
use Newspack_Nodes\Tests\TestCase;

#[CoversClass( Bootstrap::class )]
#[CoversClass( Partition_Node::class )]
#[CoversClass( Spawn_Coordinator::class )]
#[CoversClass( Job_Intake::class )]
class OnDemandWakeTest extends TestCase {

	private string $tmp;

	private string $stock;

	/** @var array<int,array{url:string,body:array<string,mixed>}> */
	private array $posts = [];

	/** @var \Closure|null */
	private $saved_curl_exec;

	/** @var \Memcached|null */
	private $saved_memd;

	protected function setUp(): void {
		parent::setUp();
		$this->tmp             = $this->make_temp_dir( 'on-demand-wake-' );
		$this->saved_curl_exec = Core::$curl_exec;
		$this->saved_memd      = Core::$memd;
		$this->posts           = [];
		\mkdir( "{$this->tmp}/locks", 0755, true );
		\mkdir( "{$this->tmp}/logs", 0755, true );
		$this->use_base_dir( $this->tmp );
		Topology_Registry::reset();
		// An earlier file's empty map memo would otherwise leak into this one.
		Bootstrap::forget_on_demand_readers();
		Partition_Node::forget_pending_wakes();
		$this->stock = $this->make_temp_dir( 'on-demand-wake-tsl-' );
		Topology_Registry::register_stock_dir( $this->stock );
		$posts           = &$this->posts;
		Core::$curl_exec = static function ( \CurlHandle $ch, array $body ) use ( &$posts ) {
			$posts[] = [ 'url' => \curl_getinfo( $ch, \CURLINFO_EFFECTIVE_URL ) ?: '', 'body' => $body ];
			return '';
		};
	}

	protected function tearDown(): void {
		Core::$curl_exec                            = $this->saved_curl_exec;
		Core::$memd                                 = $this->saved_memd;
		\Newspack_Nodes\Cache_Backend::$apcu_usable = null;
		Topology_Registry::reset();
		Partition_Node::forget_pending_wakes();
		Bootstrap::forget_on_demand_readers();
		unset( $GLOBALS['_wp_options']['newspack_nodes_topologies'] );
		$this->rmdir_recursive( $this->stock );
		$this->rmdir_recursive( $this->tmp );
		parent::tearDown();
	}

	/**
	 * Activate a two-partition topology whose Consumer tails $reads, on-demand
	 * or not. A real `.tsl`, because the wake resolves readers from the graph.
	 */
	private function activate( string $name, int $on_demand_idle = 23, string $reads = 'jobintake' ): void {
		\file_put_contents(
			"{$this->stock}/{$name}.tsl",
			"var num_partitions = 2\n"
			. ( $on_demand_idle > 0 ? "var on_demand_idle = {$on_demand_idle}\n" : '' )
			. "make_node Consumer {$name}:in <config:logs_dir>/{$reads}.p<partition> "
			. "<config:offsets_dir>/{$reads}.p<partition>\n"
			. "make_node Echo {$name}:sink\n"
			. "connect_node {$name}:in {$name}:sink\n"
		);
		$entry = [
			'topology'       => $name,
			'num_partitions' => 2,
			'stale_timeout'  => 47,
			'on_demand_idle' => $on_demand_idle,
		];
		\add_filter(
			'newspack_nodes/topologies',
			static fn ( array $t ): array => $t + [ $name => $entry ]
		);
		$active                                              = $GLOBALS['_wp_options']['newspack_nodes_topologies'] ?? [];
		$active[]                                            = $name;
		$GLOBALS['_wp_options']['newspack_nodes_topologies'] = \array_values( \array_unique( $active ) );
		// What Topology_Registry::activate() does; the reader key reads through it.
		Topology_Registry::invalidate_config_cache();
	}

	/** @return list<string> `{type}.p{n}` of every spawn posted. */
	private function woken(): array {
		return \array_map(
			static fn ( array $p ): string => $p['body']['type'] . '.p' . $p['body']['partition'],
			$this->posts
		);
	}

	private function coordinator(): Spawn_Coordinator {
		return new Spawn_Coordinator( $this->tmp );
	}

	public function test_it_wakes_an_absent_on_demand_worker_on_that_partition(): void {
		$this->activate( 'marmot-ondemand', 23 );

		$this->coordinator()->wake_on_demand( "{$this->tmp}/logs/jobintake.p1", (float) \time() );

		$this->assertSame( [ 'marmot-ondemand.p1' ], $this->woken() );
	}

	public function test_it_leaves_a_resident_topology_to_the_ordinary_spawn_scan(): void {
		$this->activate( 'marmot-resident', 0 );

		$this->coordinator()->wake_on_demand( "{$this->tmp}/logs/jobintake.p1", (float) \time() );

		$this->assertSame( [], $this->woken() );
	}

	public function test_it_does_not_wake_a_worker_that_is_already_running(): void {
		$this->activate( 'marmot-ondemand', 23 );
		\mkdir( "{$this->tmp}/locks/marmot-ondemand.p1.lock.d", 0755, true );
		\touch( "{$this->tmp}/locks/marmot-ondemand.p1.lock.d/heartbeat" );

		$this->coordinator()->wake_on_demand( "{$this->tmp}/logs/jobintake.p1", (float) \time() );

		$this->assertSame( [], $this->woken() );
	}

	/** N producers in a burst, one spawn: the 15s throttle is the dedupe. */
	public function test_a_burst_of_enqueues_wakes_the_worker_once(): void {
		$this->activate( 'marmot-ondemand', 23 );
		$coordinator = $this->coordinator();
		$now         = (float) \time();

		$coordinator->wake_on_demand( "{$this->tmp}/logs/jobintake.p0", $now );
		$coordinator->wake_on_demand( "{$this->tmp}/logs/jobintake.p0", $now + 1.0 );
		$coordinator->wake_on_demand( "{$this->tmp}/logs/jobintake.p0", $now + 2.0 );

		$this->assertSame( [ 'marmot-ondemand.p0' ], $this->woken() );
	}

	/** Job_Intake writes through a Partition, so it needs no wake call of its own. */
	public function test_writing_a_job_wakes_the_partition_it_landed_on(): void {
		$this->activate( 'marmot-ondemand', 23 );

		( new Job_Intake( $this->tmp, 2 ) )->partition( 1 )->write_job( 'marmot_handler', [] );
		Partition_Node::flush_pending_wakes();

		$this->assertSame( [ 'marmot-ondemand.p1' ], $this->woken() );
	}

	/**
	 * The reader lookup walks the topology catalog, which globs both topology
	 * dirs and parses every `.tsl`. A batch coalesces to ONE wake per partition
	 * before any of that runs, so the walk cannot happen per job.
	 */
	public function test_a_batch_resolves_the_fleet_once_not_once_per_job(): void {
		$this->activate( 'marmot-ondemand', 23 );
		$scans = 0;
		\add_filter(
			'newspack_nodes/topologies',
			static function ( array $t ) use ( &$scans ): array {
				++$scans;
				return $t;
			}
		);

		( new Job_Intake( $this->tmp, 2 ) )->partition( 1 )->queue_many( [
			[ 'handler' => 'marmot_handler', 'parameters' => [] ],
			[ 'handler' => 'marmot_handler', 'parameters' => [] ],
			[ 'handler' => 'marmot_handler', 'parameters' => [] ],
		] );
		Partition_Node::flush_pending_wakes();

		$this->assertSame( 1, $scans, 'one catalog walk for the whole batch' );
		$this->assertSame( [ 'marmot-ondemand.p1' ], $this->woken() );
	}

	/**
	 * A parked job is not due, and no special case says so: nothing CONSUMES
	 * jobdelay — Job_Delay circulates it on the cron pass — so the reads map
	 * answers it. "Is it due" collapses into "does anything read that log".
	 */
	public function test_a_delayed_job_wakes_nothing_yet(): void {
		$this->activate( 'marmot-ondemand', 23 );

		( new Job_Intake( $this->tmp, 2 ) )
			->partition( 0 )
			->write_job( 'marmot_handler', [], null, null, [ 'delay' => 3600 ] );
		Partition_Node::flush_pending_wakes();

		$this->assertSame( [], $this->woken() );
	}

	public function test_writing_a_job_wakes_nothing_when_no_topology_is_on_demand(): void {
		$this->activate( 'marmot-resident', 0 );

		( new Job_Intake( $this->tmp, 2 ) )->partition( 1 )->write_job( 'marmot_handler', [] );
		Partition_Node::flush_pending_wakes();

		$this->assertSame( [], $this->woken() );
	}

	// ── the write boundary ──────────────────────────────────────────────────

	/**
	 * Every producer reaches disk through a Partition — `Job_Intake` writes one,
	 * a Topic fans into them, a Log extends one — so that is where a wake
	 * belongs. Hanging it off the producer helpers covered only the FIRST hop:
	 * a job routed firehose → jobs, or drained jobintake → jobs, landed in a log
	 * whose reader nothing woke.
	 */
	public function test_a_partition_write_wakes_the_topology_that_reads_that_log(): void {
		$this->activate( 'marmot-ondemand', 23, 'quokka' );

		$this->write_partition( 'quokka.p1' );
		Partition_Node::flush_pending_wakes();

		$this->assertSame( [ 'marmot-ondemand.p1' ], $this->woken() );
	}

	/** Deferred by design: a web request must not pay the wake on its way out. */
	public function test_the_write_itself_posts_nothing(): void {
		$this->activate( 'marmot-ondemand', 23, 'quokka' );

		$this->write_partition( 'quokka.p1' );

		$this->assertSame( [], $this->woken(), 'the wake waits for the flush' );
	}

	public function test_a_burst_of_writes_flushes_as_one_wake(): void {
		$this->activate( 'marmot-ondemand', 23, 'quokka' );

		$this->write_partition( 'quokka.p1' );
		$this->write_partition( 'quokka.p1' );
		$this->write_partition( 'quokka.p1' );
		Partition_Node::flush_pending_wakes();

		$this->assertSame( [ 'marmot-ondemand.p1' ], $this->woken() );
	}

	/**
	 * IPC is not a special case — it IS a Partition with a Consumer tailing it,
	 * declared in `Worker_Base::build_scaffolding()` rather than in TSL. So a
	 * command written to a sleeping on-demand worker's input wakes it, for the
	 * same reason and by the same path as a job written to its jobs log.
	 */
	public function test_an_ipc_write_wakes_the_worker_it_is_addressed_to(): void {
		$this->activate( 'marmot-ondemand', 23 );

		\mkdir( "{$this->tmp}/ipc/marmot-ondemand.p1", 0755, true );
		$this->write_partition_at( "{$this->tmp}/ipc/marmot-ondemand.p1/input" );
		Partition_Node::flush_pending_wakes();

		$this->assertSame( [ 'marmot-ondemand.p1' ], $this->woken() );
	}

	/**
	 * Offsetlogs, deadletter dirs and scratch are Partitions nothing tails, so
	 * they fall out of the map on their own — no exclusion rule, no path shapes.
	 */
	public function test_a_log_nothing_on_demand_reads_flushes_nothing(): void {
		$this->activate( 'marmot-ondemand', 23, 'quokka' );

		$this->write_partition( 'giraffe-scratch.p1' );
		Partition_Node::flush_pending_wakes();

		$this->assertSame( [], $this->woken() );
	}

	/** Append one record through a real Partition at logs/{dir}. */
	private function write_partition( string $dir ): void {
		$this->write_partition_at( "{$this->tmp}/logs/{$dir}" );
	}

	/** Append one record through a real Partition at an absolute dir. */
	private function write_partition_at( string $dir ): void {
		$partition = new Partition_Node();
		$partition->arguments( [ $dir ] );
		$message                       = \Newspack_Nodes\Message::new_message();
		$message[ \Newspack_Nodes\Message::TYPE ]  = \Newspack_Nodes\Message::TM_BYTESTREAM;
		$message[ \Newspack_Nodes\Message::VALUE ] = 'quokka';
		$partition->fill( $message );
		$partition->flush();
	}

	// ── who reads what ──────────────────────────────────────────────────────

	/**
	 * The graph says which topology tails which log, so the wake goes to the
	 * one that can actually act on the write. Waking every on-demand topology
	 * on the partition would boot a firehose reader because a job was queued.
	 */
	public function test_it_wakes_only_the_topology_that_reads_that_log(): void {
		$this->activate( 'marmot-jobs', 23, 'jobintake' );
		$this->activate( 'marmot-firehose', 23, 'firehose' );

		$this->coordinator()->wake_on_demand( "{$this->tmp}/logs/jobintake.p1", (float) \time() );

		$this->assertSame( [ 'marmot-jobs.p1' ], $this->woken() );
	}

	public function test_a_log_no_on_demand_topology_reads_wakes_nothing(): void {
		$this->activate( 'marmot-firehose', 23, 'firehose' );

		$this->coordinator()->wake_on_demand( "{$this->tmp}/logs/jobintake.p1", (float) \time() );

		$this->assertSame( [], $this->woken() );
	}

	/** A resident topology never enters the map, so it can never be woken. */
	public function test_a_resident_topology_is_absent_from_the_wake_map(): void {
		$this->activate( 'marmot-resident', 0 );

		$this->assertSame( [], Bootstrap::on_demand_wake_map() );
	}

	// ── the gate ────────────────────────────────────────────────────────────

	/**
	 * "Is there an active on-demand consumer of <log>?" is derived from the TSL
	 * files on disk, so it is host-local and cacheable — and the producer asking
	 * it sits on a request path. Without the cache every asker re-globs both
	 * topology dirs and re-parses every `.tsl`.
	 */
	public function test_the_reader_lookup_is_cached_across_coordinators(): void {
		$this->with_apcu();
		$this->activate( 'marmot-ondemand', 23 );
		Bootstrap::on_demand_wake_map();

		$scans = 0;
		\add_filter(
			'newspack_nodes/topologies',
			static function ( array $t ) use ( &$scans ): array {
				++$scans;
				return $t;
			}
		);
		Bootstrap::forget_on_demand_readers();

		$map = Bootstrap::on_demand_wake_map();

		$this->assertSame( 0, $scans, 'a warm cache walks no catalog' );
		$this->assertSame(
			[ 'marmot-ondemand' ],
			\array_column( $map[ "{$this->tmp}/logs/jobintake.p1" ] ?? [], 'type' )
		);
	}

	/** Activating a topology changes the key, so the answer cannot go stale. */
	public function test_activating_a_topology_does_not_serve_the_old_answer(): void {
		$this->with_apcu();
		$this->activate( 'marmot-firehose', 23, 'firehose' );
		$this->assertArrayNotHasKey( "{$this->tmp}/logs/jobintake.p1", Bootstrap::on_demand_wake_map() );

		$this->activate( 'marmot-jobs', 23, 'jobintake' );
		Bootstrap::forget_on_demand_readers();

		$this->assertSame(
			[ 'marmot-jobs' ],
			\array_column( Bootstrap::on_demand_wake_map()[ "{$this->tmp}/logs/jobintake.p1" ] ?? [], 'type' )
		);
	}

	/**
	 * A cache entry is data someone else wrote: a foreign or corrupted value
	 * must not put non-descriptor rows on the spawn path.
	 */
	public function test_a_poisoned_cache_entry_is_filtered_to_descriptor_rows(): void {
		$this->with_apcu();
		$this->activate( 'marmot-ondemand', 23 );
		$key = 'newspack_nodes:on_demand_wake:' . \md5(
			(string) \wp_json_encode( \Newspack_Nodes\Config::value( 'topologies' ) )
		);
		\Newspack_Nodes\Cache_Backend::local_first()->set(
			$key,
			[
				"{$this->tmp}/logs/jobintake.p1" => [ [ 'type' => 'marmot-ondemand', 'partition' => 1 ], 'junk' ],
				7                                => [ [ 'type' => 'numeric-key' ] ],
				"{$this->tmp}/logs/other.p0"     => 'not-a-list',
			],
			60
		);
		Bootstrap::forget_on_demand_readers();

		$map = Bootstrap::on_demand_wake_map();

		$this->assertSame( [ "{$this->tmp}/logs/jobintake.p1" ], \array_keys( $map ) );
		$this->assertSame( [ 'marmot-ondemand' ], \array_column( $map[ "{$this->tmp}/logs/jobintake.p1" ], 'type' ) );
	}

	/** No cache tier at all still answers, just without the shortcut. */
	public function test_it_answers_with_no_cache_backend_available(): void {
		\Newspack_Nodes\Cache_Backend::$apcu_usable = static fn (): bool => false;
		Core::$memd                                 = null;
		$this->activate( 'marmot-ondemand', 23 );

		$this->assertSame(
			[ 'marmot-ondemand' ],
			\array_column( Bootstrap::on_demand_wake_map()[ "{$this->tmp}/logs/jobintake.p1" ] ?? [], 'type' )
		);
	}

	/** Route Cache_Backend at the in-memory memcached double. */
	private function with_apcu(): void {
		\Newspack_Nodes\Cache_Backend::$apcu_usable = static fn (): bool => false;
		Core::$memd = new \Newspack_Nodes\Tests\Helpers\InMemoryMemcached();
	}
}
