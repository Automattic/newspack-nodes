<?php
declare(strict_types=1);

require_once dirname( __DIR__ ) . '/includes/class-insights-ci-demo-node.php';

use Example_AI_Newsletter\Insights_CI_Demo_Node;
use Newspack_Nodes\Message;
use Newspack_Nodes\Partition_Node;
use Newspack_Nodes\Tests\TestCase;

final class InsightsCiTest extends TestCase {

	/** @var string[] make_temp_dir() doesn't self-register for cleanup, so track + remove here. */
	private array $created = [];

	protected function tearDown(): void {
		foreach ( $this->created as $dir ) {
			$this->rmdir_recursive( $dir );
		}
		$this->created = [];
		parent::tearDown();
	}

	/** Write one offsetlog-shaped snapshot record (seg/off + cache) into $offsets/scored.p$n. */
	private function write_snapshot( string $offsets, int $partition, array $items ): void {
		$ol = new Partition_Node();
		$ol->name( "t:ol:$partition" );
		$ol->arguments( "$offsets/scored.p$partition" );
		$ol->void_warranty(); // The real Consumer offsetlog runs large-writes on (set_snapshot_node).
		$m                   = Message::new_message();
		$m[ Message::TYPE ]  = Message::TM_STRUCT;
		$m[ Message::VALUE ] = [ 'seg' => 0, 'off' => 0, 'cache' => [ 'items' => $items ] ];
		$ol->fill( $m );
		$ol->flush();
	}

	public function test_reads_snapshot_and_shapes_model(): void {
		$offsets         = $this->make_temp_dir( 'insights-ci-test-' );
		$this->created[] = $offsets;
		$this->write_snapshot( $offsets, 0, [
			[ 'source' => 'releases',  'title' => 'Roundup Block ships',  'summary' => 's1', 'score' => 6.0 ],
			[ 'source' => 'community', 'title' => 'Reader forum hits 10k', 'summary' => 's2', 'score' => 4.0 ],
			[ 'source' => 'releases',  'title' => 'Minor fix',             'summary' => 's3', 'score' => 5.0 ],
		] );

		$model = Insights_CI_Demo_Node::read_insights_model( $offsets );

		$this->assertSame( 3, $model['accumulated'] );
		$this->assertSame( [ 'releases' => 2, 'community' => 1 ], $model['sources'] );
		// top sorted by score desc.
		$this->assertSame( 6.0, $model['top'][0]['score'] );
		$this->assertSame( 'Roundup Block ships', $model['top'][0]['title'] );
		$this->assertSame( 5.0, $model['top'][1]['score'] );
	}

	public function test_reads_large_snapshot_over_pipe_buf(): void {
		$offsets         = $this->make_temp_dir( 'insights-ci-large-' );
		$this->created[] = $offsets;
		// 60 padded items pack to well over PIPE_BUF (4096B) as one offsetlog line —
		// the realistic accumulating-digest case the small-record tests never reach.
		$items = [];
		for ( $i = 0; $i < 60; $i++ ) {
			$items[] = [ 'source' => 'releases', 'title' => "Item $i " . \str_repeat( 'x', 80 ), 'summary' => 's', 'score' => (float) $i ];
		}
		$this->write_snapshot( $offsets, 0, $items );

		$model = Insights_CI_Demo_Node::read_insights_model( $offsets );
		$this->assertSame( 60, $model['accumulated'] );
		$this->assertSame( 59.0, $model['top'][0]['score'] ); // highest score first
	}

	public function test_missing_offsets_dir_yields_empty_model(): void {
		$model = Insights_CI_Demo_Node::read_insights_model( '/nonexistent/' . \uniqid() );
		$this->assertSame( [ 'sources' => [], 'top' => [], 'accumulated' => 0 ], $model );
	}

	public function test_insights_verb_is_registered_and_returns_json(): void {
		$ci = new Insights_CI_Demo_Node();
		$ci->name( 'insights' );
		$this->assertArrayHasKey( 'insights', $ci->commands() );
		$json = $ci->build_insights_json();
		$this->assertJson( $json );
		$decoded = \json_decode( $json, true );
		$this->assertIsArray( $decoded );
		$this->assertArrayHasKey( 'sources', $decoded );
		$this->assertArrayHasKey( 'top', $decoded );
		$this->assertArrayHasKey( 'accumulated', $decoded );
	}
}
