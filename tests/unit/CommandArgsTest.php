<?php
namespace Newspack_Nodes\Tests\Unit;

use Newspack_Nodes\Command_Args;
use Newspack_Nodes\Tests\TestCase;
use PHPUnit\Framework\Attributes\CoversClass;

#[CoversClass( Command_Args::class )]
class CommandArgsTest extends TestCase {

	public function test_parse_empty_string_yields_no_positionals_and_no_options(): void {
		$this->assertSame( [ 'positional' => [], 'options' => [] ], Command_Args::parse( '' ) );
		$this->assertSame( [ 'positional' => [], 'options' => [] ], Command_Args::parse( '   ' ) );
	}

	public function test_parse_collects_positionals_in_order(): void {
		$this->assertSame(
			[ 'positional' => [ 'spoke1', 'web1' ], 'options' => [] ],
			Command_Args::parse( 'spoke1 web1' )
		);
	}

	public function test_parse_reads_key_value_options(): void {
		$out = Command_Args::parse( '--url=https://x --limit=50' );
		$this->assertSame( [], $out['positional'] );
		$this->assertSame( 'https://x', $out['options']['url'] );
		$this->assertSame( '50', $out['options']['limit'] );
	}

	public function test_parse_treats_bare_dashdash_key_as_boolean_true(): void {
		$out = Command_Args::parse( '--categories' );
		$this->assertTrue( $out['options']['categories'] );
	}

	public function test_parse_keeps_explicit_false_as_string(): void {
		$out = Command_Args::parse( '--enabled=false' );
		$this->assertSame( 'false', $out['options']['enabled'] );
	}

	public function test_parse_mixes_positionals_and_options_preserving_positional_order(): void {
		$out = Command_Args::parse( 'add spoke1 --url=https://x --enabled=false' );
		$this->assertSame( [ 'add', 'spoke1' ], $out['positional'] );
		$this->assertSame( 'https://x', $out['options']['url'] );
		$this->assertSame( 'false', $out['options']['enabled'] );
	}

	public function test_parse_keeps_comma_list_value_intact(): void {
		$out = Command_Args::parse( '--breakdown=server,status' );
		$this->assertSame( 'server,status', $out['options']['breakdown'] );
	}

	public function test_parse_honors_double_quoted_value_with_spaces(): void {
		$out = Command_Args::parse( '--search="foo bar baz"' );
		$this->assertSame( 'foo bar baz', $out['options']['search'] );
	}

	public function test_parse_unescapes_quote_and_backslash_inside_quotes(): void {
		$out = Command_Args::parse( '--value="a \"b\" \\\\ c"' );
		$this->assertSame( 'a "b" \\ c', $out['options']['value'] );
	}

	public function test_format_joins_positionals(): void {
		$this->assertSame( 'spoke1 web1', Command_Args::format( [ 'spoke1', 'web1' ] ) );
	}

	public function test_format_renders_key_value_options(): void {
		$this->assertSame(
			'add spoke1 --url=https://x',
			Command_Args::format( [ 'add', 'spoke1' ], [ 'url' => 'https://x' ] )
		);
	}

	public function test_format_renders_boolean_true_as_bare_flag(): void {
		$this->assertSame( 'overview --categories', Command_Args::format( [ 'overview' ], [ 'categories' => true ] ) );
	}

	public function test_format_renders_boolean_false_as_explicit_value(): void {
		$this->assertSame( '--enabled=false', Command_Args::format( [], [ 'enabled' => false ] ) );
	}

	public function test_format_joins_array_value_with_commas(): void {
		$this->assertSame(
			'--logs=firehose.log,jobs.log',
			Command_Args::format( [], [ 'logs' => [ 'firehose.log', 'jobs.log' ] ] )
		);
	}

	public function test_format_quotes_value_containing_whitespace(): void {
		$this->assertSame( '--search="foo bar"', Command_Args::format( [], [ 'search' => 'foo bar' ] ) );
	}

	public function test_format_quotes_and_escapes_embedded_quote(): void {
		$this->assertSame( '--value="a \"b\""', Command_Args::format( [], [ 'value' => 'a "b"' ] ) );
	}

	public function test_format_then_parse_round_trips(): void {
		$positional = [ 'add', 'spoke1' ];
		$options    = [ 'url' => 'https://x', 'enabled' => false, 'logs' => 'a.log,b.log', 'search' => 'foo bar' ];
		$formatted  = Command_Args::format( $positional, $options );
		$parsed     = Command_Args::parse( $formatted );
		$this->assertSame( $positional, $parsed['positional'] );
		$this->assertSame( 'https://x', $parsed['options']['url'] );
		$this->assertSame( 'false', $parsed['options']['enabled'] );
		$this->assertSame( 'a.log,b.log', $parsed['options']['logs'] );
		$this->assertSame( 'foo bar', $parsed['options']['search'] );
	}
}
