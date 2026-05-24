<?php
/**
 * End-to-end: two independent sources fan into one summarizer, then a digest,
 * and a single flush produces one draft containing items from BOTH sources.
 * This is the composability claim made executable.
 *
 * @package Newspack_AI_Newsletter
 */

declare(strict_types=1);

require_once dirname( __DIR__ ) . '/includes/class-releases-source.php';
require_once dirname( __DIR__ ) . '/includes/class-community-source.php';
require_once dirname( __DIR__ ) . '/includes/class-summarizer.php';
require_once dirname( __DIR__ ) . '/includes/class-digest-builder.php';

use Newspack_AI_Newsletter\Releases_Source_Node;
use Newspack_AI_Newsletter\Community_Source_Node;
use Newspack_AI_Newsletter\Summarizer_Node;
use Newspack_AI_Newsletter\Digest_Builder_Node;
use Newspack_Nodes\Message;
use Newspack_Nodes\Tests\Capture_Sink_Node;
use Newspack_Nodes\Tests\TestCase;

final class PipelineTest extends TestCase {

	public function test_two_sources_flow_into_one_draft(): void {
		// Wire the graph by sink, the way connect_node does at runtime:
		// releases ─┐
		//           ├─> summarizer ─> digest ─> out
		// community ┘
		$out    = new Capture_Sink_Node();
		$digest = new Digest_Builder_Node();
		$digest->sink( $out );
		$summarizer = new Summarizer_Node();
		$summarizer->sink( $digest );
		$releases = new Releases_Source_Node();
		$releases->sink( $summarizer );
		$community = new Community_Source_Node();
		$community->sink( $summarizer );

		// Both sources emit; the digest assembles one draft. Adding the second
		// source above required exactly one extra sink wire and zero change to
		// the summarizer or the digest.
		$releases->cmd_tick();
		$community->cmd_tick();
		$digest->cmd_flush();

		$drafts = $out->captured;
		$this->assertCount( 1, $drafts, 'one draft emitted' );
		$draft = $drafts[0][ Message::VALUE ];
		$this->assertSame( Message::TM_BYTESTREAM, $drafts[0][ Message::TYPE ] & Message::TM_BYTESTREAM );

		// A release item and a community item both appear — proof the two
		// independent sources composed into one digest.
		$this->assertStringContainsString( 'Roundup Block ships', $draft );
		$this->assertStringContainsString( 'Reader forum hits 10k members', $draft );
	}
}
