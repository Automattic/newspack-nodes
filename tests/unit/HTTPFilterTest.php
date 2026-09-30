<?php
namespace Newspack_Nodes\Tests\Unit;

use PHPUnit\Framework\Attributes\CoversClass;
use Newspack_Nodes\HTTP_Filter_Node;
use Newspack_Nodes\Message;
use Newspack_Nodes\Node_Names;
use Newspack_Nodes\Tests\Capture_Sink_Node;
use Newspack_Nodes\Tests\TestCase;

#[CoversClass( HTTP_Filter_Node::class )]
class HTTPFilterTest extends TestCase {

	private const HANDLE = '5e55104cafe0f00d5e55104cafe0f00d';

	/**
	 * Fill a gate once per TO and answer the TO of each message it passed.
	 *
	 * @param HTTP_Filter_Node $gate The gate under test.
	 * @param list<string>     $tos  TO of each message filled.
	 * @return list<string>
	 */
	private function passed( HTTP_Filter_Node $gate, array $tos ): array {
		$gate->sink( $sink = new Capture_Sink_Node() );
		foreach ( $tos as $to ) {
			$message                = Message::new_message();
			$message[ Message::TO ] = $to;
			$gate->fill( $message );
		}
		return \array_map( static fn ( array $m ): string => $m[ Message::TO ], $sink->captured );
	}

	public function test_fill_strips_session_head_and_emits_remainder_as_to(): void {
		// Router peeled `_output`, leaving TO=`_sse:<handle>/<reply-node>`. The
		// filter matches the head against its session, strips it, and forwards
		// the remainder so the browser receives TO=`_output` (its Dumper).
		$f = new HTTP_Filter_Node( '_sse:' . self::HANDLE );
		$f->sink( $sink = new Capture_Sink_Node() );
		$message                   = Message::new_message();
		$message[ Message::TO ]    = '_sse:' . self::HANDLE . '/_output';
		$message[ Message::VALUE ] = 'reply';
		$f->fill( $message );
		$this->assertCount( 1, $sink->captured );
		$this->assertSame( '_output', $sink->captured[0][ Message::TO ] );
		$this->assertSame( 'reply', $sink->captured[0][ Message::VALUE ] );
	}

	public function test_fill_strips_to_empty_when_the_head_has_no_reply_node_suffix(): void {
		$this->assertSame( [ '' ], $this->passed( new HTTP_Filter_Node( '_sse:' . self::HANDLE ), [ '_sse:' . self::HANDLE ] ) );
	}

	public function test_fill_drops_a_reply_addressed_to_another_session(): void {
		$this->assertSame( [], $this->passed( new HTTP_Filter_Node( '_sse:' . self::HANDLE ), [ '_sse:0ther0ther0ther0ther0ther0the/_output' ] ) );
	}

	public function test_fill_drops_a_reply_addressed_to_a_process_pid(): void {
		$this->assertSame( [], $this->passed( new HTTP_Filter_Node( '_sse:' . self::HANDLE ), [ '_sse:' . \getmypid() . '/_output' ] ) );
	}

	public function test_a_stream_drops_a_cli_sessions_reply_its_router_peeled_to_the_session_head(): void {
		$this->assertSame( [], $this->passed( new HTTP_Filter_Node( '_sse:' . self::HANDLE ), [ '_cli:73519/_output', '_cli:' . self::HANDLE . '/_output' ] ) );
	}

	public function test_a_stream_with_no_session_passes_no_reply(): void {
		$f = new HTTP_Filter_Node( null );
		$this->assertSame( [], $this->passed( $f, [ '_sse:', '_sse:/_output', '_sse:' . self::HANDLE . '/_output' ] ) );
		$this->assertSame( 3, $f->counter() );
	}

	public function test_a_cli_gate_passes_its_own_head_and_no_other(): void {
		$tos = [ '_output/_cli:73519/_output', '_output/_cli:48211/_output', '_output/_sse:73519/_output', '_output/_cli:473519/_output', '_cli:73519/_output', '_output/_cli:73519x/_output' ];
		$this->assertSame( [ '_output' ], $this->passed( new HTTP_Filter_Node( '_output/_cli:73519' ), $tos ) );
	}

	public function test_a_reply_whose_tail_names_the_session_under_another_head_is_dropped(): void {
		$tos = [ '_output/_cli:48211/_output/73519', '_output/73519', 'recv/sku-9/73519', '73519', '_output' ];
		$this->assertSame( [], $this->passed( new HTTP_Filter_Node( '_output/_cli:73519' ), $tos ) );
	}

	public function test_a_gate_with_a_target_passes_an_unaddressed_message_to_it(): void {
		$gate = new HTTP_Filter_Node( '_output/_cli:73519' );
		$gate->target( 'dumper-8812' );
		$this->assertSame( [ 'dumper-8812', 'ember-4' ], $this->passed( $gate, [ '', '_output/_cli:73519/ember-4' ] ) );
	}

	public function test_a_gate_with_no_target_drops_an_unaddressed_message(): void {
		$gate = new HTTP_Filter_Node( '_output/_cli:73519' );
		$this->assertSame( [ 'ember-4' ], $this->passed( $gate, [ '', '_output/_cli:73519/ember-4' ] ) );
		$this->assertSame( 2, $gate->counter() );
	}

	public function test_counter_increments_even_when_message_is_dropped(): void {
		$f = new HTTP_Filter_Node( '_sse:' . self::HANDLE );
		$this->assertSame( [], $this->passed( $f, [ '_sse:0ther0ther0ther0ther0ther0the/_output' ] ) );
		$this->assertSame( 1, $f->counter() );
	}

	public function test_head_joins_the_realm_and_the_session(): void {
		$this->assertSame( '_cli:61403', HTTP_Filter_Node::head( Node_Names::CLI, '61403' ) );
		$this->assertSame( '_sse:' . self::HANDLE, HTTP_Filter_Node::head( Node_Names::SSE, self::HANDLE ) );
	}

	public function test_node_schema_is_hidden_with_empty_ctor_and_verbs(): void {
		// HTTP_Filter is built by its stream with the session handle; it
		// must never appear in the `make_node` factory's discoverable
		// category list or expose user-facing verbs.
		$schema = HTTP_Filter_Node::node_schema();
		$this->assertSame( 'Hidden', $schema['category'] );
		$this->assertSame( [], $schema['arguments'] );
		$this->assertSame( [], $schema['commands'] );
		$this->assertNotEmpty( $schema['description'] );
	}
}
