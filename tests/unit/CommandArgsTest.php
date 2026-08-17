<?php
namespace Newspack_Nodes\Tests\Unit;

use PHPUnit\Framework\Attributes\CoversClass;
use Newspack_Nodes\Command_Args;
use Newspack_Nodes\Tests\TestCase;

/**
 * Command_Args over token arrays: parse() classifies a pre-split list<string>
 * and format() emits one. Token boundaries are native to the array, so a value
 * with spaces needs no quoting — the escaping the string form required is gone.
 */
#[CoversClass( Command_Args::class )]
class CommandArgsTest extends TestCase {

	public function test_parse_empty_list_yields_no_positionals_and_no_options(): void {
		$this->assertSame( [ 'positional' => [], 'options' => [] ], Command_Args::parse( [] ) );
	}

	public function test_parse_collects_positionals_in_order(): void {
		$this->assertSame(
			[ 'positional' => [ 'spoke1', 'web1' ], 'options' => [] ],
			Command_Args::parse( [ 'spoke1', 'web1' ] )
		);
	}

	public function test_parse_reads_key_value_options(): void {
		$out = Command_Args::parse( [ '--url=https://x', '--limit=50' ] );
		$this->assertSame( [], $out['positional'] );
		$this->assertSame( 'https://x', $out['options']['url'] );
		$this->assertSame( '50', $out['options']['limit'] );
	}

	public function test_parse_treats_bare_dashdash_key_as_boolean_true(): void {
		$out = Command_Args::parse( [ '--categories' ] );
		$this->assertTrue( $out['options']['categories'] );
	}

	public function test_parse_keeps_explicit_false_as_string(): void {
		$out = Command_Args::parse( [ '--enabled=false' ] );
		$this->assertSame( 'false', $out['options']['enabled'] );
	}

	public function test_parse_mixes_positionals_and_options_preserving_positional_order(): void {
		$out = Command_Args::parse( [ 'add', 'spoke1', '--url=https://x', '--enabled=false' ] );
		$this->assertSame( [ 'add', 'spoke1' ], $out['positional'] );
		$this->assertSame( 'https://x', $out['options']['url'] );
		$this->assertSame( 'false', $out['options']['enabled'] );
	}

	public function test_parse_keeps_comma_list_value_intact(): void {
		$out = Command_Args::parse( [ '--breakdown=server,status' ] );
		$this->assertSame( 'server,status', $out['options']['breakdown'] );
	}

	public function test_parse_keeps_a_spaced_value_token_verbatim(): void {
		// The token IS the boundary — no quoting, no escaping to undo.
		$out = Command_Args::parse( [ '--search=foo bar baz' ] );
		$this->assertSame( 'foo bar baz', $out['options']['search'] );
	}

	public function test_parse_keeps_an_equals_in_the_value(): void {
		$out = Command_Args::parse( [ '--expr=a=b' ] );
		$this->assertSame( 'a=b', $out['options']['expr'] );
	}

	public function test_format_returns_positionals_as_tokens(): void {
		$this->assertSame( [ 'spoke1', 'web1' ], Command_Args::format( [ 'spoke1', 'web1' ] ) );
	}

	public function test_format_renders_key_value_options(): void {
		$this->assertSame(
			[ 'add', 'spoke1', '--url=https://x' ],
			Command_Args::format( [ 'add', 'spoke1' ], [ 'url' => 'https://x' ] )
		);
	}

	public function test_format_renders_boolean_true_as_bare_flag(): void {
		$this->assertSame( [ 'overview', '--categories' ], Command_Args::format( [ 'overview' ], [ 'categories' => true ] ) );
	}

	public function test_format_renders_boolean_false_as_explicit_value(): void {
		$this->assertSame( [ '--enabled=false' ], Command_Args::format( [], [ 'enabled' => false ] ) );
	}

	public function test_format_joins_array_value_with_commas(): void {
		$this->assertSame(
			[ '--logs=firehose.p0,jobs.log' ],
			Command_Args::format( [], [ 'logs' => [ 'firehose.p0', 'jobs.log' ] ] )
		);
	}

	public function test_format_keeps_a_spaced_value_in_one_token(): void {
		// No quotes: the space lives inside a single array element.
		$this->assertSame( [ '--search=foo bar' ], Command_Args::format( [], [ 'search' => 'foo bar' ] ) );
	}

	public function test_format_then_parse_round_trips_a_spaced_value(): void {
		$positional = [ 'add', 'spoke one' ];
		$options    = [ 'url' => 'https://x', 'enabled' => false, 'logs' => 'a.log,b.log', 'search' => 'foo bar' ];
		$formatted  = Command_Args::format( $positional, $options );
		$parsed     = Command_Args::parse( $formatted );
		$this->assertSame( $positional, $parsed['positional'] );
		$this->assertSame( 'https://x', $parsed['options']['url'] );
		$this->assertSame( 'false', $parsed['options']['enabled'] );
		$this->assertSame( 'a.log,b.log', $parsed['options']['logs'] );
		$this->assertSame( 'foo bar', $parsed['options']['search'] );
	}

	// ── option_int: the one typed read of an operator-supplied option ──────

	public function test_option_int_takes_the_fallback_only_when_the_option_is_absent(): void {
		$this->assertSame( -1, Command_Args::option_int( [], 'partition', -1 ) );
		$this->assertNull( Command_Args::option_int( [], 'num_partitions', null ) );
	}

	public function test_option_int_reads_a_canonical_value(): void {
		$this->assertSame( 3, Command_Args::option_int( [ 'partition' => '3' ], 'partition', -1 ) );
		$this->assertSame( 0, Command_Args::option_int( [ 'partition' => '0' ], 'partition', -1 ) );
		$this->assertSame( 12, Command_Args::option_int( [ 'limit' => 12 ], 'limit', 20 ), 'an int needs no parsing' );
	}

	/** Every cast answers a NUMBER here, so the typo picks a real target. */
	public function test_option_int_refuses_a_malformed_value_instead_of_casting(): void {
		$this->assertNull( Command_Args::option_int( [ 'partition' => 'abc' ], 'partition', -1 ) );
		$this->assertNull( Command_Args::option_int( [ 'timeout' => '2m' ], 'timeout', 30 ) );
		$this->assertNull( Command_Args::option_int( [ 'segment_size' => '2.9' ], 'segment_size', 4096 ) );
		$this->assertNull( Command_Args::option_int( [ 'num_partitions' => '-1' ], 'num_partitions', null ) );
	}

	public function test_option_int_refuses_a_bare_flag(): void {
		// parse() renders `--partition` as true; casting it selects p1.
		$this->assertNull( Command_Args::option_int( [ 'partition' => true ], 'partition', -1 ) );
	}

	public function test_option_int_refuses_zero_when_the_caller_forbids_it(): void {
		$this->assertNull( Command_Args::option_int( [ 'num_partitions' => '0' ], 'num_partitions', null, false ) );
	}
}
