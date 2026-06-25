<?php
declare(strict_types=1);

require_once dirname( __DIR__ ) . '/includes/class-insights-ci-demo-node.php';

use Example_AI_Newsletter\Insights_CI_Demo_Node;
use Newspack_Nodes\Config;
use Newspack_Nodes\Message;
use Newspack_Nodes\Partition_Node;
use Newspack_Nodes\Tests\TestCase;

final class InsightsCiTest extends TestCase {

	/** @var string[] make_temp_dir() doesn't self-register for cleanup, so track + remove here. */
	private array $created = [];

	protected function setUp(): void {
		parent::setUp();
		// Service_CI verbs are gated by default; these tests dispatch them, so grant the cap.
		$GLOBALS['_wp_test_current_user_can']['manage_options'] = true;
	}

	protected function tearDown(): void {
		Insights_CI_Demo_Node::$read_items = null;
		// Clear the cap so it doesn't leak into sibling CI test classes (the
		// substrate's RawLogsCITest / LayoutsCITest reset here for the same reason).
		$GLOBALS['_wp_test_current_user_can'] = [];
		foreach ( $this->created as $dir ) {
			$this->rmdir_recursive( $dir );
		}
		$this->created = [];
		parent::tearDown();
	}

	/** Write one offsetlog-shaped snapshot record (seg/off + cache) into $offsets/example-scored.p$n. */
	private function write_snapshot( string $offsets, int $partition, array $items ): void {
		$ol = new Partition_Node();
		$ol->name( "t:ol:$partition" );
		$ol->arguments( "$offsets/example-scored.p$partition" );
		$ol->void_warranty(); // The real Consumer offsetlog runs large-writes on (set_snapshot_node).
		$m                   = Message::new_message();
		$m[ Message::TYPE ]  = Message::TM_STRUCT;
		$m[ Message::VALUE ] = [ 'seg' => 0, 'off' => 0, 'cache' => [ 'items' => $items ] ];
		$ol->fill( $m );
		$ol->flush();
	}

	/** Point Config's offsets dir at a fresh temp base seeded with $items, and return the CI bound to it. */
	private function ci_with_snapshot( array $items ): Insights_CI_Demo_Node {
		$base            = $this->make_temp_dir( 'insights-ci-base-' );
		$this->created[] = $base;
		$this->use_base_dir( $base );
		$this->write_snapshot( Config::get_offsets_directory(), 0, $items );
		$ci = new Insights_CI_Demo_Node();
		$ci->name( 'insights-demo' );
		return $ci;
	}

	private const SEED = [
		[ 'source' => 'releases',  'title' => 'Roundup Block ships',  'summary' => 's1', 'score' => 6.0 ],
		[ 'source' => 'community', 'title' => 'Reader forum hits 10k', 'summary' => 's2', 'score' => 4.0 ],
		[ 'source' => 'releases',  'title' => 'Minor fix',             'summary' => 's3', 'score' => 5.0 ],
	];

	public function test_counts_verb_returns_sources_slice_only(): void {
		$ci      = $this->ci_with_snapshot( self::SEED );
		$decoded = \json_decode( (string) $ci->dispatch( 'counts' ), true );
		$this->assertSame( [ 'sources' => [ 'releases' => 2, 'community' => 1 ] ], $decoded );
	}

	public function test_top_verb_returns_top_slice_sorted_desc(): void {
		$ci      = $this->ci_with_snapshot( self::SEED );
		$decoded = \json_decode( (string) $ci->dispatch( 'top' ), true );
		$this->assertSame( [ 'top' ], \array_keys( $decoded ) );
		// JSON serializes 6.0 as `6`; compare the score numerically, not by PHP type.
		$this->assertEquals( 6.0, $decoded['top'][0]['score'] );
		$this->assertSame( 'Roundup Block ships', $decoded['top'][0]['title'] );
		$this->assertEquals( 5.0, $decoded['top'][1]['score'] );
		$this->assertEquals( 4.0, $decoded['top'][2]['score'] );
	}

	public function test_top_verb_caps_at_ten(): void {
		$items = [];
		for ( $i = 0; $i < 25; $i++ ) {
			$items[] = [ 'source' => 'releases', 'title' => "Item $i", 'summary' => 's', 'score' => (float) $i ];
		}
		$ci      = $this->ci_with_snapshot( $items );
		$decoded = \json_decode( (string) $ci->dispatch( 'top' ), true );
		$this->assertCount( 10, $decoded['top'] );
		$this->assertEquals( 24.0, $decoded['top'][0]['score'] ); // highest first
	}

	public function test_accumulated_verb_returns_count_slice_only(): void {
		$ci      = $this->ci_with_snapshot( self::SEED );
		$decoded = \json_decode( (string) $ci->dispatch( 'accumulated' ), true );
		$this->assertSame( [ 'accumulated' => 3 ], $decoded );
	}

	public function test_verbs_read_a_snapshot_over_pipe_buf(): void {
		// 60 padded items pack to well over PIPE_BUF (4096B) as one offsetlog line —
		// the realistic accumulating-digest case the small-record tests never reach.
		$items = [];
		for ( $i = 0; $i < 60; $i++ ) {
			$items[] = [ 'source' => 'releases', 'title' => "Item $i " . \str_repeat( 'x', 80 ), 'summary' => 's', 'score' => (float) $i ];
		}
		$ci = $this->ci_with_snapshot( $items );
		$this->assertSame( 60, \json_decode( (string) $ci->dispatch( 'accumulated' ), true )['accumulated'] );
		$this->assertEquals( 59.0, \json_decode( (string) $ci->dispatch( 'top' ), true )['top'][0]['score'] );
	}

	public function test_empty_snapshot_yields_empty_slices(): void {
		$ci = $this->ci_with_snapshot( [] );
		$this->assertSame( [ 'sources' => [] ], \json_decode( (string) $ci->dispatch( 'counts' ), true ) );
		$this->assertSame( [ 'top' => [] ], \json_decode( (string) $ci->dispatch( 'top' ), true ) );
		$this->assertSame( [ 'accumulated' => 0 ], \json_decode( (string) $ci->dispatch( 'accumulated' ), true ) );
	}

	public function test_three_verbs_share_one_memoized_read(): void {
		$ci    = $this->ci_with_snapshot( self::SEED );
		$reads = 0;
		// Spy seam: count the offsetlog snapshot read while still running the real
		// glob/merge path through the default closure.
		$default = Insights_CI_Demo_Node::$read_items
			?? static fn ( string $dir ): array => Insights_CI_Demo_Node::read_snapshot_items( $dir );
		Insights_CI_Demo_Node::$read_items = static function ( string $dir ) use ( &$reads, $default ): array {
			$reads++;
			return $default( $dir );
		};

		$ci->dispatch( 'counts' );
		$ci->dispatch( 'top' );
		$ci->dispatch( 'accumulated' );

		$this->assertSame( 1, $reads, 'the three batched verbs must read the offsetlog exactly once' );
	}

	public function test_slice_verbs_are_refused_without_manage_options(): void {
		$ci = $this->ci_with_snapshot( self::SEED );
		// Drop the cap: the Service_CI base wraps every verb with
		// require_manage_options(), so each slice dispatch must now throw.
		$GLOBALS['_wp_test_current_user_can'] = [];
		foreach ( [ 'counts', 'top', 'accumulated' ] as $verb ) {
			try {
				$ci->dispatch( $verb );
				$this->fail( "verb '$verb' should be refused without manage_options" );
			} catch ( \RuntimeException $e ) {
				$this->assertStringContainsString( 'permission denied', $e->getMessage() );
			}
		}
	}

	public function test_insights_god_verb_is_gone_and_slice_verbs_registered(): void {
		$ci = new Insights_CI_Demo_Node();
		$ci->name( 'insights-demo' );
		$commands = $ci->commands();
		$this->assertArrayNotHasKey( 'insights', $commands );
		$this->assertArrayHasKey( 'counts', $commands );
		$this->assertArrayHasKey( 'top', $commands );
		$this->assertArrayHasKey( 'accumulated', $commands );
	}
}
