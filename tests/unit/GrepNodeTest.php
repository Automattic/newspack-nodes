<?php
namespace Newspack_Nodes\Tests\Unit;

use PHPUnit\Framework\Attributes\CoversClass;
use Newspack_Nodes\Grep_Node;
use Newspack_Nodes\Message;
use Newspack_Nodes\Tests\Capture_Sink_Node;
use Newspack_Nodes\Tests\TestCase;

#[CoversClass( Grep_Node::class )]
class GrepNodeTest extends TestCase {

	public function test_forwards_matching_value_and_drops_non_matching(): void {
		// Ported from Tachikoma's Grep.pm: fill() forwards a message whose VALUE
		// matches the regex to the sink; a miss is dropped (not forwarded).
		$g = new Grep_Node();
		$g->arguments( [ 'ERROR' ] );
		$capture = new Capture_Sink_Node();
		$g->sink( $capture );

		$hit = $this->bytestream( 'db ERROR: timeout' );
		$g->fill( $hit );
		$miss = $this->bytestream( 'all good here' );
		$g->fill( $miss );

		$this->assertCount( 1, $capture->captured, 'only the matching message is forwarded' );
		$this->assertSame( 'db ERROR: timeout', $capture->captured[0][ Message::VALUE ] );
	}

	/**
	 * An unparseable regex was accepted at config time and only failed at USE
	 * time — `preg_match` then emitted a warning and returned false for every
	 * message, so a typo'd `make_node Grep g '[unclosed'` silently dropped the
	 * whole stream behind a warning storm. The operator typed it on one line;
	 * the refusal belongs on that line.
	 */
	public function test_arguments_refuses_an_unparseable_pattern(): void {
		$g = new Grep_Node();
		$g->name( 'grep-probe' );

		$this->expectException( \InvalidArgumentException::class );
		$this->expectExceptionMessage( 'grep-probe' );

		$g->arguments( [ '[unclosed' ] );
	}

	public function test_arguments_keeps_a_valid_pattern_with_regex_metacharacters(): void {
		// The refusal must not reject legitimate PCRE — this one is valid.
		$g = new Grep_Node();
		$g->arguments( [ '^(alpha|beta)\d{2,4}$' ] );
		$capture = new Capture_Sink_Node();
		$g->sink( $capture );

		$g->fill( $this->bytestream( 'beta4173' ) );
		$g->fill( $this->bytestream( 'gamma4173' ) );

		$this->assertCount( 1, $capture->captured );
		$this->assertSame( 'beta4173', $capture->captured[0][ Message::VALUE ] );
	}

	/**
	 * A struct VALUE with a nested non-UTF-8 string (e.g. a job `parameters`
	 * field carrying raw latin1 SQL text) makes the stringify fallback's
	 * wp_json_encode() fail. Before this fix, the failure silently coerced to
	 * '' via a bare (string) cast — an empty subject fails the default `.`
	 * pattern (any single character), so the message is dropped with no
	 * diagnostic and no relation to the actual byte-encoding cause.
	 */
	public function test_forwards_struct_value_with_invalid_utf8_instead_of_silently_dropping(): void {
		$g = new Grep_Node();
		$capture = new Capture_Sink_Node();
		$g->sink( $capture );

		$m                   = Message::new_message();
		$m[ Message::TYPE ]  = Message::TM_STRUCT;
		$m[ Message::VALUE ] = [ 'handler' => 'job', 'parameters' => "WHERE name = 'Caf\xE9'" ];
		$g->fill( $m );

		$this->assertCount( 1, $capture->captured, 'a struct VALUE must not vanish on an encode failure' );
	}

	/** @return array<int, mixed> */
	private function bytestream( string $value ): array {
		$m                     = Message::new_message();
		$m[ Message::TYPE ]    = Message::TM_BYTESTREAM;
		$m[ Message::VALUE ]   = $value;
		return $m;
	}
}
