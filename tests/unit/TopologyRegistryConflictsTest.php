<?php
declare(strict_types=1);

namespace Newspack_Nodes\Tests\Unit;

use PHPUnit\Framework\Attributes\CoversClass;
use Newspack_Nodes\Topology_Analyzer;
use Newspack_Nodes\Topology_Registry;
use Newspack_Nodes\Tests\TestCase;

/**
 * Topology conflict detection: two enabled topologies must not both WRITE the
 * same file (a data partition or a Consumer offsetlog). Two writers to one file
 * corrupt it — the hazard void_warranty() no longer catches with a lock, so it's
 * caught upfront at enable-time + supervisor-spawn-time instead.
 */
#[CoversClass( Topology_Registry::class )]
#[CoversClass( Topology_Analyzer::class )]
class TopologyRegistryConflictsTest extends TestCase {

	private string $tmp;

	protected function setUp(): void {
		parent::setUp();
		Topology_Registry::reset();
		$this->tmp = $this->make_temp_dir( 'topology-conflicts-' );
		Topology_Registry::register_stock_dir( $this->tmp );
	}

	protected function tearDown(): void {
		Topology_Registry::reset();
		$this->rmdir_recursive( $this->tmp );
		parent::tearDown();
	}

	private function write_tsl( string $name, string $contents ): void {
		\file_put_contents( "{$this->tmp}/{$name}.tsl", $contents );
	}

	public function test_no_conflict_when_write_sets_are_disjoint(): void {
		// The decomposed set: distinct data partitions AND distinct firehose
		// offsetlogs — safe to run together.
		$this->write_tsl( 'rb', "make_node Consumer firehose:consumer <config:logs_dir>/firehose.p<partition> <config:offsets_dir>/firehose.rb.p<partition>\nmake_node Partition requests:partition <config:logs_dir>/requests.p<partition> <config:segment_size> <config:min_segments> <config:max_segments> <config:min_lifetime> <config:max_lifetime>" );
		$this->write_tsl( 'jr', "make_node Consumer firehose:consumer <config:logs_dir>/firehose.p<partition> <config:offsets_dir>/firehose.jr.p<partition>\nmake_node Partition jobs:partition <config:logs_dir>/jobs.p<partition> <config:segment_size> <config:min_segments> <config:max_segments> <config:min_lifetime> <config:max_lifetime>" );

		$this->assertSame( [], Topology_Analyzer::find_conflicts( [ 'rb', 'jr' ] ) );
	}

	public function test_conflict_when_two_topologies_write_the_same_partition_with_different_geometry(): void {
		// Same path, DIFFERENT retention args: the two graphs would fight over
		// rotation/pruning — a real conflict, refused.
		$this->write_tsl( 'combined', "make_node Partition requests:partition <config:logs_dir>/requests.p<partition> <config:segment_size> <config:min_segments> <config:max_segments> <config:min_lifetime> <config:max_lifetime>\nmake_node Partition jobs:partition <config:logs_dir>/jobs.p<partition> <config:segment_size> <config:min_segments> <config:max_segments> <config:min_lifetime> <config:max_lifetime>" );
		$this->write_tsl( 'rb', "make_node Partition requests:partition <config:logs_dir>/requests.p<partition> 1048576 2 4 0 0" );

		$conflicts = Topology_Analyzer::find_conflicts( [ 'combined', 'rb' ] );
		$this->assertCount( 1, $conflicts );
		$this->assertSame( 'combined', $conflicts[0]['a'] );
		$this->assertSame( 'rb', $conflicts[0]['b'] );
		$this->assertContains( 'partition:<config:logs_dir>/requests.p<partition>', $conflicts[0]['shared'] );
	}

	public function test_identical_shared_partition_declaration_is_not_a_conflict(): void {
		// The topic-probe pattern: every topology pulls the SAME declaration
		// (typically via `include topic-probe`). Same path + byte-identical
		// args = one shared multi-writer log — atomic ≤PIPE_BUF appends and
		// the rotate lock make that safe, so it must not refuse the fleet.
		$probe = "make_node Partition  topicprobe:log <config:logs_dir>/topicprobe.p0 1048576 2 8 0 86400 86400";
		$this->write_tsl( 'workers-a', "{$probe}\nmake_node Partition a:partition <config:logs_dir>/a.p<partition> <config:segment_size> <config:min_segments> <config:max_segments> <config:min_lifetime> <config:max_lifetime>" );
		$this->write_tsl( 'workers-b', "{$probe}\nmake_node Partition b:partition <config:logs_dir>/b.p<partition> <config:segment_size> <config:min_segments> <config:max_segments> <config:min_lifetime> <config:max_lifetime>" );

		$this->assertSame( [], Topology_Analyzer::find_conflicts( [ 'workers-a', 'workers-b' ] ) );
	}

	public function test_identical_declaration_with_void_warranty_still_conflicts(): void {
		// Lifting the PIPE_BUF cap (void_warranty) means non-atomic writes —
		// safe only with a sole writer, so sharing is refused even when the
		// declarations match byte-for-byte.
		$line = "make_node Partition big:partition <config:logs_dir>/big.p<partition> <config:segment_size> <config:min_segments> <config:max_segments> <config:min_lifetime> <config:max_lifetime>";
		$this->write_tsl( 'writer-a', "{$line}\ncmd big:partition:config void_warranty" );
		$this->write_tsl( 'writer-b', $line );

		$conflicts = Topology_Analyzer::find_conflicts( [ 'writer-a', 'writer-b' ] );
		$this->assertCount( 1, $conflicts );
		$this->assertContains( 'partition:<config:logs_dir>/big.p<partition>', $conflicts[0]['shared'] );
	}

	public function test_identical_declaration_with_allow_large_writes_still_conflicts(): void {
		$line = "make_node Partition big:partition <config:logs_dir>/big.p<partition> <config:segment_size> <config:min_segments> <config:max_segments> <config:min_lifetime> <config:max_lifetime>";
		$this->write_tsl( 'writer-a', $line );
		$this->write_tsl( 'writer-b', "{$line}\ncmd big:partition:config allow_large_writes" );

		$conflicts = Topology_Analyzer::find_conflicts( [ 'writer-a', 'writer-b' ] );
		$this->assertCount( 1, $conflicts );
		$this->assertContains( 'partition:<config:logs_dir>/big.p<partition>', $conflicts[0]['shared'] );
	}

	public function test_conflict_when_two_consumers_share_an_offsetlog(): void {
		// Different data partitions, but two readers sharing one cursor file still
		// clobber each other — the firehose-offsetlog hazard.
		$this->write_tsl( 'reader-a', "make_node Consumer firehose:consumer <config:logs_dir>/firehose.p<partition> <config:offsets_dir>/firehose.p<partition>\nmake_node Partition a:partition <config:logs_dir>/a.p<partition> <config:segment_size> <config:min_segments> <config:max_segments> <config:min_lifetime> <config:max_lifetime>" );
		$this->write_tsl( 'reader-b', "make_node Consumer firehose:consumer <config:logs_dir>/firehose.p<partition> <config:offsets_dir>/firehose.p<partition>\nmake_node Partition b:partition <config:logs_dir>/b.p<partition> <config:segment_size> <config:min_segments> <config:max_segments> <config:min_lifetime> <config:max_lifetime>" );

		$conflicts = Topology_Analyzer::find_conflicts( [ 'reader-a', 'reader-b' ] );
		$this->assertCount( 1, $conflicts );
		$this->assertContains( 'offsetlog:<config:offsets_dir>/firehose.p<partition>', $conflicts[0]['shared'] );
	}

	public function test_conflict_when_two_consumers_share_a_deadletter_dir(): void {
		// The :deadletter sibling is void_warranty'd (unlocked, sole-writer assumed),
		// so two Consumers quarantining into the same dir corrupt the DLQ segments —
		// same hazard as a shared offsetlog. Distinct offsetlogs, shared deadletter.
		$this->write_tsl( 'reader-a', "make_node Consumer firehose:consumer <config:logs_dir>/firehose.p<partition> <config:offsets_dir>/firehose.a.p<partition> <config:deadletter_dir>/firehose.p<partition>" );
		$this->write_tsl( 'reader-b', "make_node Consumer firehose:consumer <config:logs_dir>/firehose.p<partition> <config:offsets_dir>/firehose.b.p<partition> <config:deadletter_dir>/firehose.p<partition>" );

		$conflicts = Topology_Analyzer::find_conflicts( [ 'reader-a', 'reader-b' ] );
		$this->assertCount( 1, $conflicts );
		$this->assertContains( 'deadletter:<config:deadletter_dir>/firehose.p<partition>', $conflicts[0]['shared'] );
	}

	public function test_topic_is_a_writer_in_the_write_set(): void {
		// A Topic appends to the partitions under its path exactly like Partition,
		// so it belongs in the write-set under the same `partition:` namespace —
		// otherwise a Topic-vs-Partition collision on the same log is invisible.
		$this->write_tsl( 'producer', "make_node Topic firehose:topic <config:logs_dir>/firehose.p{partition} <config:num_partitions> <config:segment_size> <config:min_segments> <config:max_segments> <config:min_lifetime> <config:max_lifetime>" );

		$this->assertContains(
			'partition:<config:logs_dir>/firehose.p{partition}',
			Topology_Analyzer::write_set( 'producer' )
		);
	}

	public function test_conflict_when_topic_and_partition_write_the_same_log(): void {
		$this->write_tsl( 'producer', "make_node Topic firehose:topic <config:logs_dir>/firehose.p{partition} <config:num_partitions> <config:segment_size> <config:min_segments> <config:max_segments> <config:min_lifetime> <config:max_lifetime>" );
		$this->write_tsl( 'writer', "make_node Partition firehose:partition <config:logs_dir>/firehose.p{partition} <config:segment_size> <config:min_segments> <config:max_segments> <config:min_lifetime> <config:max_lifetime>" );

		$conflicts = Topology_Analyzer::find_conflicts( [ 'producer', 'writer' ] );
		$this->assertCount( 1, $conflicts );
		$this->assertContains( 'partition:<config:logs_dir>/firehose.p{partition}', $conflicts[0]['shared'] );
	}

	public function test_write_set_is_memoized_until_cache_reset(): void {
		$this->write_tsl( 'w', "make_node Partition a:partition <config:logs_dir>/a.p<partition> <config:segment_size> <config:min_segments> <config:max_segments> <config:min_lifetime> <config:max_lifetime>" );
		$first = Topology_Analyzer::write_set( 'w' );
		$this->assertContains( 'partition:<config:logs_dir>/a.p<partition>', $first );

		// Rewrite the .tsl to a different path WITHOUT clearing the cache — the
		// memoized result persists (proves the disk read is cached, not redone).
		$this->write_tsl( 'w', "make_node Partition b:partition <config:logs_dir>/b.p<partition> <config:segment_size> <config:min_segments> <config:max_segments> <config:min_lifetime> <config:max_lifetime>" );
		$this->assertSame( $first, Topology_Analyzer::write_set( 'w' ), 'cached until the per-tick reset' );

		// reset_basename_cache() (Config::RESET_ACTION on each supervisor tick) picks up the edit.
		Topology_Registry::reset_basename_cache();
		$this->assertContains( 'partition:<config:logs_dir>/b.p<partition>', Topology_Analyzer::write_set( 'w' ) );
	}

	public function test_describe_conflicts_renders_pairs_with_shared_resource(): void {
		$desc = Topology_Analyzer::describe_conflicts( [
			[ 'a' => 'combined', 'b' => 'rb', 'shared' => [ 'partition:x/requests.log' ] ],
			[ 'a' => 'combined', 'b' => 'jr', 'shared' => [ 'offsetlog:y/firehose.p0' ] ],
		] );
		$this->assertStringContainsString( 'combined', $desc );
		$this->assertStringContainsString( 'rb', $desc );
		$this->assertStringContainsString( 'partition:x/requests.log', $desc );
		$this->assertStringContainsString( 'jr', $desc );
	}

	public function test_describe_conflicts_empty_is_empty_string(): void {
		$this->assertSame( '', Topology_Analyzer::describe_conflicts( [] ) );
	}

	/**
	 * write_set() is the conflict gate: it stops two fleets writing one log.
	 * It scanned the RAW file, so a topology that only `include`s others (ELN's
	 * combined.tsl is now exactly that) reported an EMPTY write set — and the
	 * gate silently passed anything.
	 */
	public function test_write_set_sees_through_includes(): void {
		$this->write_tsl(
			'zebra-base',
			"make_node Partition zebra:partition /var/log/zebra.log <partition> 1 2 0\n"
		);
		$this->write_tsl( 'zebra-top', "include zebra-base\n" );

		$this->assertSame(
			Topology_Analyzer::write_set( 'zebra-base' ),
			Topology_Analyzer::write_set( 'zebra-top' ),
			'an include-only topology must report what its includes write'
		);
		$this->assertNotEmpty( Topology_Analyzer::write_set( 'zebra-top' ) );
	}

	/**
	 * A safety gate must never DISARM itself. write_set() feeds find_conflicts()
	 * (two fleets on one log) and Log_Cleaner (delete what nothing declares), so
	 * an unresolvable include must THROW, not quietly report "this topology writes
	 * nothing" — which reads as "no conflict" and "all its logs are orphans".
	 */
	public function test_write_set_throws_on_an_unresolvable_include(): void {
		$this->write_tsl( 'zebra-top', "include no-such-base\n" );

		$this->expectException( \RuntimeException::class );
		$this->expectExceptionMessage( 'no-such-base' );

		Topology_Analyzer::write_set( 'zebra-top' );
	}

	/**
	 * The whole point of `<topology>`: two fleets tailing ONE log each get their
	 * own cursor, so they may co-run — while composing them still dedupes to one
	 * reader (the make_node lines are byte-identical). The LOG they write stays
	 * unscoped, so two fleets writing one log is still a conflict.
	 */
	public function test_topology_token_gives_each_fleet_its_own_offsetlog(): void {
		$consumer = "make_node Consumer shared:consumer <config:logs_dir>/firehose.p<partition> <config:offsets_dir>/firehose.<topology>.p<partition>\n";
		$this->write_tsl( 'alpha-fleet', $consumer );
		$this->write_tsl( 'beta-fleet', $consumer );

		$this->assertSame(
			[],
			Topology_Analyzer::find_conflicts( [ 'alpha-fleet', 'beta-fleet' ] ),
			'same log, different fleets — the cursors must not collide'
		);

		$alpha = Topology_Analyzer::write_set( 'alpha-fleet' );
		$this->assertContains( 'offsetlog:<config:offsets_dir>/firehose.alpha-fleet.p<partition>', $alpha );
	}

	/** Two fleets WRITING one log is still a conflict — only the cursor is fleet-scoped. */
	public function test_topology_token_does_not_excuse_a_disagreeing_partition(): void {
		// `<topology>` fleet-scopes CURSORS only. A partition path carries no
		// token, so two fleets declaring it with DIFFERENT geometry still
		// collide. (Byte-identical declarations are the sanctioned sharing
		// path — see the topic-probe tests above.)
		$this->write_tsl( 'alpha-fleet', "make_node Partition shared:partition <config:logs_dir>/requests.p<partition> 1 2 3 4 5\n" );
		$this->write_tsl( 'beta-fleet', "make_node Partition shared:partition <config:logs_dir>/requests.p<partition> 9 2 3 4 5\n" );

		$this->assertNotEmpty(
			Topology_Analyzer::find_conflicts( [ 'alpha-fleet', 'beta-fleet' ] ),
			'two fleets disagreeing over one log is a real collision'
		);
	}

	/**
	 * [147] Remote_Source's offsetlog is an ARGUMENT now, not a path write_set
	 * reconstructs from the old hardcoded convention. Reading the convention
	 * instead of the arg means the conflict gate and the GC both look at a cursor
	 * the node doesn't actually use — and a `<topology>`-scoped one is invisible.
	 */
	public function test_write_set_reads_remote_source_offsetlog_from_its_argument(): void {
		$this->write_tsl(
			'zebra-agg',
			"make_node Remote_Source spoke-a zebra-vault firehose.p0 <config:offsets_dir>/spoke-a.<topology>.p0 <config:deadletter_dir>/spoke-a.p0\n"
		);

		$set = Topology_Analyzer::write_set( 'zebra-agg' );

		$this->assertContains( 'offsetlog:<config:offsets_dir>/spoke-a.zebra-agg.p0', $set );
		$this->assertContains( 'deadletter:<config:deadletter_dir>/spoke-a.p0', $set );
		// NOT the reconstructed legacy path.
		$this->assertNotContains( 'offsetlog:<config:offsets_dir>/spoke-a.firehose.p0', $set );
	}

	/**
	 * The write set is a SAFETY gate: it feeds `find_conflicts` (two fleets
	 * writing one log) and `Log_Cleaner`'s declared-dir set (what the GC must
	 * not sweep). It identified writers by string-comparing the TSL token
	 * against 'Partition' / 'Topic' / 'Consumer' / 'Remote_Source', while the
	 * layout code in the same class resolves the token to an FQCN and asks the
	 * type system. So a plugin that SUBCLASSES Partition wrote a real log that
	 * no conflict check saw and that the GC did not know was declared.
	 */
	public function test_a_partition_subclass_is_a_writer_in_the_write_set(): void {
		require_once __DIR__ . '/../Helpers/fixtures/class-wombat-partition-node.php';
		\Newspack_Nodes\Command_Interpreter_Node::register_namespace(
			'Newspack_Nodes\\Tests\\Fixtures\\'
		);
		$this->write_tsl(
			'subclassed',
			'make_node Wombat_Partition zebra:partition <config:logs_dir>/zebra.p{partition} <config:segment_size> <config:min_segments> <config:max_segments> <config:min_lifetime> <config:max_lifetime>'
		);

		$this->assertContains(
			'partition:<config:logs_dir>/zebra.p{partition}',
			Topology_Analyzer::write_set( 'subclassed' ),
			'a Partition subclass writes the same log and must be gated the same'
		);
	}
}
