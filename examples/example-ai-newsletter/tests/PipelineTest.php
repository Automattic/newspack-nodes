<?php
/**
 * End-to-end: two sources fan into a summarizer, a scorer scores each item, and the
 * digest assembles one draft. Plus: the digest's accumulated state is durably co-committed
 * to the Consumer's offsetlog and read back exactly as the dashboard reads it.
 *
 * @package Example_AI_Newsletter
 */

declare(strict_types=1);

require_once dirname( __DIR__ ) . '/includes/class-releases-source.php';
require_once dirname( __DIR__ ) . '/includes/class-community-source.php';
require_once dirname( __DIR__ ) . '/includes/class-summarizer.php';
require_once dirname( __DIR__ ) . '/includes/class-scorer.php';
require_once dirname( __DIR__ ) . '/includes/class-digest-builder.php';
require_once dirname( __DIR__ ) . '/includes/class-insights-ci.php';

use Example_AI_Newsletter\Releases_Source_Node;
use Example_AI_Newsletter\Community_Source_Node;
use Example_AI_Newsletter\Summarizer_Node;
use Example_AI_Newsletter\Scorer_Node;
use Example_AI_Newsletter\Digest_Builder_Node;
use Example_AI_Newsletter\Insights_CI_Node;
use Newspack_Nodes\Consumer_Node;
use Newspack_Nodes\Message;
use Newspack_Nodes\Tests\Capture_Sink_Node;
use Newspack_Nodes\Tests\TestCase;

final class PipelineTest extends TestCase {

	/** @var string[] make_temp_dir() doesn't self-register for cleanup, so track + remove here. */
	private array $created = [];

	protected function tearDown(): void {
		foreach ( $this->created as $dir ) {
			$this->rmdir_recursive( $dir );
		}
		$this->created = [];
		parent::tearDown();
	}

	private function summary_struct( string $source, string $title, float $score ): array {
		$m                   = Message::new_message();
		$m[ Message::TYPE ]  = Message::TM_STRUCT;
		$m[ Message::VALUE ] = [ 'source' => $source, 'title' => $title, 'summary' => "sum:$title", 'score' => $score ];
		return $m;
	}

	/** A runtime trigger request (TICK/FLUSH), as the REPL's `request_node <node> <verb>` mints it. */
	private function request( string $verb ): array {
		$m                   = Message::new_message();
		$m[ Message::TYPE ]  = Message::TM_REQUEST;
		$m[ Message::FROM ]  = '_repl';
		$m[ Message::VALUE ] = $verb;
		return $m;
	}

	public function test_two_sources_flow_through_scorer_into_one_draft(): void {
		// Wire the graph by sink, the way connect_node does at runtime:
		// releases ─┐
		//           ├─> summarizer ─> scorer ─> digest ─> out
		// community ┘
		$out    = new Capture_Sink_Node();
		$digest = new Digest_Builder_Node();
		$digest->sink( $out );
		$scorer = new Scorer_Node();
		$scorer->sink( $digest );
		$summarizer = new Summarizer_Node();
		$summarizer->sink( $scorer );
		$releases = new Releases_Source_Node();
		$releases->sink( $summarizer );
		$community = new Community_Source_Node();
		$community->sink( $summarizer );

		$rel_req = $this->request( 'TICK' );
		$releases->fill( $rel_req );
		$com_req = $this->request( 'TICK' );
		$community->fill( $com_req );

		// Every item picked up a score from the scorer wired between summarizer and digest —
		// Ben's lesson again: a node + one wire, nothing else changed. (Guarded so an empty
		// digest is a failure, not a vacuous pass.)
		$items = $digest->save_state()['items'];
		$this->assertNotEmpty( $items );
		foreach ( $items as $item ) {
			$this->assertArrayHasKey( 'score', $item );
		}

		$flush_req = $this->request( 'FLUSH' );
		$digest->fill( $flush_req );

		$drafts = array_values( array_filter(
			$out->captured,
			static fn ( $m ) => 0 !== ( $m[ Message::TYPE ] & Message::TM_BYTESTREAM )
		) );
		$this->assertCount( 1, $drafts, 'one draft emitted' );
		$draft = $drafts[0][ Message::VALUE ];
		$this->assertSame( Message::TM_BYTESTREAM, $drafts[0][ Message::TYPE ] & Message::TM_BYTESTREAM );

		// A release item and a community item both appear — two independent sources, one digest.
		$this->assertStringContainsString( 'Roundup Block ships', $draft );
		$this->assertStringContainsString( 'Reader forum hits 10k members', $draft );
	}

	public function test_digest_snapshot_is_durably_cocommitted_and_dashboard_readable(): void {
		// Proves the dashboard's data path: a digest's accumulated state is co-committed into the
		// Consumer's offsetlog (set_snapshot_node) and read back by Insights_CI. The restore_state
		// side of a respawn is unit-covered in DigestBuilderTest; this pins the durable read.
		$offsets         = $this->make_temp_dir( 'pipeline-respawn-' );
		$this->created[] = $offsets;
		\mkdir( "$offsets/scored.p0", 0777, true );

		$digest = new Digest_Builder_Node();
		$digest->name( 'digest' );
		$item = $this->summary_struct( 'releases', 'Roundup Block ships', 7.0 );
		$digest->fill( $item );

		$consumer = new Consumer_Node();
		$consumer->name( 'scored:consumer' );
		$consumer->arguments( "$offsets/src.log $offsets/scored.p0" );
		$consumer->set_snapshot_node( 'digest' );
		$consumer->checkpoint();

		$model = Insights_CI_Node::read_insights_model( $offsets );
		$this->assertSame( 1, $model['accumulated'] );
		$this->assertSame( 'Roundup Block ships', $model['top'][0]['title'] );
	}
}
