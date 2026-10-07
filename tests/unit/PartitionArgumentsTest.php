<?php
declare(strict_types=1);

namespace Newspack_Nodes\Tests\Unit;

use PHPUnit\Framework\Attributes\CoversClass;
use PHPUnit\Framework\Attributes\DataProvider;
use Newspack_Nodes\Consumer_Node;
use Newspack_Nodes\Core;
use Newspack_Nodes\Event_Framework;
use Newspack_Nodes\File_Tail_Node;
use Newspack_Nodes\Log_Node;
use Newspack_Nodes\Partition_Node;
use Newspack_Nodes\Remote_Consumer_Node;
use Newspack_Nodes\Remote_Link_Node;
use Newspack_Nodes\Remote_Source_Node;
use Newspack_Nodes\Schema_Reflection;
use Newspack_Nodes\Shell_Node;
use Newspack_Nodes\Table_Node;
use Newspack_Nodes\Tail_Node;
use Newspack_Nodes\Topic_Node;
use Newspack_Nodes\Tests\Capture_Sink_Node;
use Newspack_Nodes\Tests\TestCase;

/**
 * `{partition}` is resolved by the node, in the arguments its schema marks:
 * `bound` at the worker's partition, `each` left to the node itself.
 */
#[CoversClass( Schema_Reflection::class )]
class PartitionArgumentsTest extends TestCase {
	private string $tmp;

	protected function setUp(): void {
		parent::setUp();
		Event_Framework::reset();
		$this->tmp = $this->make_temp_dir();
	}

	protected function tearDown(): void {
		$this->rmdir_recursive( $this->tmp );
		parent::tearDown();
	}

	/**
	 * Every argument that names a log, a cursor or a quarantine carries a
	 * mark, so `{partition}` there resolves rather than naming a literal dir.
	 *
	 * @param class-string $class The node class.
	 * @param string       $arg   One of its positionals.
	 * @param string       $mark  The mark it carries.
	 */
	#[DataProvider( 'partitioned_arguments' )]
	public function test_a_partitioned_argument_carries_its_mark( string $class, string $arg, string $mark ): void {
		$specs = \array_column( $class::node_schema()['arguments'], null, 'name' );

		$this->assertSame( $mark, $specs[ $arg ]['partition'] ?? null );
	}

	/** @return array<string,array{class-string,string,string}> */
	public static function partitioned_arguments(): array {
		return [
			'Partition dir'          => [ Partition_Node::class, 'partition_dir', 'bound' ],
			'Log file'               => [ Log_Node::class, 'file', 'bound' ],
			'Consumer source'        => [ Consumer_Node::class, 'source_dir', 'bound' ],
			'Consumer offsetlog'     => [ Consumer_Node::class, 'offsetlog_dir', 'bound' ],
			'Consumer deadletter'    => [ Consumer_Node::class, 'deadletter_dir', 'bound' ],
			'Tail source'            => [ Tail_Node::class, 'source_file', 'bound' ],
			'File_Tail source'       => [ File_Tail_Node::class, 'source_file', 'bound' ],
			'File_Tail offsetlog'    => [ File_Tail_Node::class, 'offsetlog_dir', 'bound' ],
			'Remote reader cursor'   => [ Remote_Consumer_Node::class, 'offsetlog_dir', 'bound' ],
			'Remote reader dead'     => [ Remote_Consumer_Node::class, 'deadletter_dir', 'bound' ],
			'Broker cursor root'     => [ Remote_Source_Node::class, 'offsetlog_root', 'bound' ],
			'Broker deadletter root' => [ Remote_Source_Node::class, 'deadletter_root', 'bound' ],
			'Table namespace'        => [ Table_Node::class, 'namespace', 'bound' ],
			'Link subscription'      => [ Remote_Link_Node::class, 'remote_partition', 'bound' ],
			'Topic template'         => [ Topic_Node::class, 'dir_template', 'each' ],
		];
	}

	/** A dump taken on one worker rebuilds on another at that worker's partition. */
	public function test_a_consumer_dumped_on_partition_two_rebuilds_on_partition_three(): void {
		Core::$var['partition'] = '2';
		$written                = [ "{$this->tmp}/egret.p{partition}", "{$this->tmp}/egret-cursor.p{partition}", "{$this->tmp}/egret-dead.p{partition}" ];
		$first                  = new Consumer_Node();
		$first->arguments( $written );
		$line = \explode( "\n", $first->dump_config() )[0];

		Core::$var['partition'] = '3';
		$second                 = new Consumer_Node();
		$second->arguments( \array_slice( ( new Shell_Node() )->tokenize( $line ), 3 ) );

		$this->assertSame( "{$this->tmp}/egret.p2", $this->prop( $first, 'source_dir' ) );
		$this->assertSame( "{$this->tmp}/egret.p3", $this->prop( $second, 'source_dir' ) );
		$this->assertSame( "{$this->tmp}/egret-cursor.p3", $this->prop( $second, 'offsetlog_dir' ) );
		$this->assertSame( "{$this->tmp}/egret-dead.p3", $this->prop( $second, 'deadletter_dir' ) );
		$this->assertSame( $written, $second->arguments() );
	}

	/** A Table names its keys per worker partition. */
	public function test_a_table_namespace_resolves_at_the_bound_partition(): void {
		Core::$var['partition'] = '5';
		$this->use_base_dir( $this->tmp );
		$table = new Table_Node();
		$table->name( 'egret-stats' );
		$table->arguments( [ 'evlog:p{partition}', '60', 'sqlite' ] );

		$this->assertSame( 'evlog:p5', $this->prop( $table, 'namespace' ) );
	}

	/** A Topic's `{partition}` is each of its N partitions, not the worker's. */
	public function test_a_topic_builds_each_partition_from_its_template(): void {
		Core::$var['partition'] = '5';
		$topic                  = new Topic_Node();
		$topic->arguments( [ "{$this->tmp}/stork.p{partition}", '2' ] );

		$topic->name( 'stork-topic' );
		$topic->sink( new Capture_Sink_Node() );

		$this->assertSame( "{$this->tmp}/stork.p{partition}", $this->prop( $topic, 'dir_template' ) );
		$this->assertSame( "{$this->tmp}/stork.p1", Core::node( 'stork-topic:p1' )->partition_dir(), 'child 1, whatever the worker' );
	}

	/** A marked dir binds the fleet in `{topology}`, as the analyzer declares it. */
	public function test_a_bound_dir_resolves_the_fleet_beside_the_partition(): void {
		Core::$var['partition'] = '2';
		Core::$var['topology']  = 'heron-fleet';
		$consumer               = new Consumer_Node();
		$consumer->arguments( [ "{$this->tmp}/egret.p{partition}", "{$this->tmp}/{topology}.egret.p{partition}" ] );

		$this->assertSame( "{$this->tmp}/heron-fleet.egret.p2", $this->prop( $consumer, 'offsetlog_dir' ) );
	}

	/**
	 * A protected property of a node.
	 *
	 * @param object $node The node.
	 * @param string $name The property.
	 */
	private function prop( object $node, string $name ): mixed {
		return ( new \ReflectionProperty( $node, $name ) )->getValue( $node );
	}
}
