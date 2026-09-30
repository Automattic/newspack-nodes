<?php
namespace Newspack_Nodes\Tests\Unit;

use PHPUnit\Framework\Attributes\CoversClass;
use Newspack_Nodes\Command_Args;
use Newspack_Nodes\Core;
use Newspack_Nodes\Tests\TestCase;

/**
 * Command_Args over token arrays: bind() reads a verb's tokens against its
 * declared args, and format() emits tokens. Token boundaries are native to the
 * array, so a value with spaces needs no quoting.
 */
#[CoversClass( Command_Args::class )]
class CommandArgsTest extends TestCase {

	/** A verb's declared args, in the shape node_schema()['commands'][]['args'] carries. */
	private const CREATE = [
		[ 'name' => 'label', 'type' => 'string' ],
		[ 'name' => 'scope', 'type' => 'string', 'default' => 'manage' ],
		[ 'name' => 'ttl', 'type' => 'int', 'default' => 3600 ],
	];

	private function refusal( array $specs, array $tokens ): string {
		try {
			Command_Args::bind( $specs, $tokens );
		} catch ( \InvalidArgumentException $e ) {
			return \html_entity_decode( $e->getMessage(), \ENT_QUOTES );
		}
		$this->fail( 'bind() accepted ' . \implode( ' ', $tokens ) );
	}

	public function test_bind_takes_each_arg_by_position_in_declared_order(): void {
		$this->assertSame(
			[ 'label' => 'chris-claude', 'scope' => 'tune', 'ttl' => 86400 ],
			Command_Args::bind( self::CREATE, [ 'chris-claude', 'tune', '86400' ] )
		);
	}

	public function test_bind_takes_each_arg_by_name(): void {
		$this->assertSame(
			[ 'label' => 'chris-claude', 'scope' => 'tune', 'ttl' => 86400 ],
			Command_Args::bind( self::CREATE, [ '--ttl=86400', '--label=chris-claude', '--scope=tune' ] )
		);
	}

	public function test_bind_mixes_positions_and_names(): void {
		$this->assertSame(
			[ 'label' => 'chris-claude', 'scope' => 'tune', 'ttl' => 86400 ],
			Command_Args::bind( self::CREATE, [ 'chris-claude', '--ttl=86400', 'tune' ] )
		);
	}

	public function test_bind_applies_declared_defaults_and_null_for_an_undefaulted_optional(): void {
		$this->assertSame(
			[ 'label' => null, 'scope' => 'manage', 'ttl' => 3600 ],
			Command_Args::bind( self::CREATE, [] )
		);
	}

	public function test_bind_keeps_an_equals_and_spaces_inside_a_named_value(): void {
		$bound = Command_Args::bind( self::CREATE, [ '--label=a=b c' ] );
		$this->assertSame( 'a=b c', $bound['label'] );
	}

	public function test_bind_refuses_a_missing_required_arg(): void {
		$this->assertSame(
			'missing required argument: handle',
			$this->refusal( [ [ 'name' => 'handle', 'type' => 'string', 'required' => true ] ], [] )
		);
	}

	public function test_bind_refuses_an_unknown_option_naming_the_ones_it_takes(): void {
		$this->assertSame(
			'unknown option --scopes; this verb takes --label, --scope, --ttl',
			$this->refusal( self::CREATE, [ 'x', '--scopes=tune' ] )
		);
	}

	/** A surplus token may be a mis-slotted secret, so the refusal counts, never echoes. */
	public function test_bind_refuses_a_surplus_positional_by_count_alone(): void {
		$refusal = $this->refusal( self::CREATE, [ 'x', 'tune', '60', 'hunter2-4419' ] );

		$this->assertSame( 'too many arguments: 4 given, 3 accepted', $refusal );
		$this->assertStringNotContainsString( 'hunter2', $refusal );
	}

	public function test_bind_masks_a_secret_in_a_type_refusal(): void {
		$specs   = [ [ 'name' => 'pin', 'type' => 'int', 'secret' => true ] ];
		$refusal = $this->refusal( $specs, [ '--pin=hunter2-4419' ] );

		$this->assertSame( "pin wants a whole number, got '<redacted>'", $refusal );
		$this->assertSame( "limit wants a whole number, got 'kea-4419'", $this->refusal( [ [ 'name' => 'limit', 'type' => 'int' ] ], [ '--limit=kea-4419' ] ) );
	}

	/** A resolver answering a PHP bool — `<eln:is_hub>` — binds that bool, false included. */
	public function test_bind_types_a_token_default_whose_resolver_answers_a_bool(): void {
		$saved = Core::$config_resolvers;
		Core::register_config_namespace( 'kakapo', static fn ( string $key ): ?bool => [ 'off' => false, 'on' => true ][ $key ] ?? null );
		try {
			$specs = [
				[ 'name' => 'spoke', 'type' => 'bool', 'required' => true, 'default' => '<kakapo:off>' ],
				[ 'name' => 'hub', 'type' => 'bool', 'required' => true, 'default' => '<kakapo:on>' ],
			];
			$this->assertSame( [ 'spoke' => false, 'hub' => true ], Command_Args::bind( $specs, [] ) );
			$this->assertSame(
				[ 'spoke' => false, 'hub' => true ],
				Command_Args::bind( $specs, [ Core::resolve_config_tokens( '<kakapo:off>' ), Core::resolve_config_tokens( '<kakapo:on>' ) ] ),
				'a TSL line interpolating the token binds the same values'
			);
		} finally {
			Core::$config_resolvers = $saved;
		}
	}

	public function test_bind_refuses_a_name_given_twice(): void {
		$this->assertSame(
			'--scope given twice',
			$this->refusal( self::CREATE, [ '--scope=tune', '--scope=read' ] )
		);
	}

	public function test_bind_refuses_an_arg_given_by_position_and_by_name(): void {
		$this->assertSame(
			'scope given both by position and as --scope',
			$this->refusal( self::CREATE, [ 'x', 'tune', '--scope=read' ] )
		);
	}

	public function test_bind_refuses_a_token_that_is_not_its_declared_int(): void {
		$this->assertSame(
			"ttl wants a whole number, got '1h'",
			$this->refusal( self::CREATE, [ 'x', '--ttl=1h' ] )
		);
	}

	/** The placeholder rule `make_node` positionals follow: blank numeric is unsupplied. */
	public function test_bind_reads_a_blank_numeric_token_as_not_supplied(): void {
		$this->assertSame(
			[ 'label' => '', 'scope' => 'tune', 'ttl' => 3600 ],
			Command_Args::bind( self::CREATE, [ '', 'tune', '' ] )
		);
		$this->assertSame(
			'missing required argument: slot',
			$this->refusal( [ [ 'name' => 'slot', 'type' => 'int', 'required' => true ] ], [ '--slot=' ] )
		);
	}

	public function test_bind_reads_a_bare_flag_as_true_for_a_bool_and_a_word_for_either_value(): void {
		$specs = [ [ 'name' => 'enabled', 'type' => 'bool' ] ];
		$this->assertTrue( Command_Args::bind( $specs, [ '--enabled' ] )['enabled'] );
		$this->assertTrue( Command_Args::bind( $specs, [ 'yes' ] )['enabled'] );
		$this->assertFalse( Command_Args::bind( $specs, [ '--enabled=false' ] )['enabled'] );
		$this->assertNull( Command_Args::bind( $specs, [] )['enabled'] );
	}

	public function test_bind_refuses_a_bare_flag_for_an_arg_that_takes_a_value(): void {
		$this->assertSame(
			'--label needs a value: write --label=<value>',
			$this->refusal( self::CREATE, [ '--label' ] )
		);
	}

	public function test_bind_collects_the_positional_tail_into_a_variadic_arg(): void {
		$specs = [
			[ 'name' => 'types', 'type' => 'string', 'variadic' => true ],
			[ 'name' => 'partition', 'type' => 'int', 'default' => -1 ],
		];
		$this->assertSame(
			[ 'types' => [ 'job-worker', 'aggregator' ], 'partition' => 7 ],
			Command_Args::bind( $specs, [ 'job-worker', '--partition=7', 'aggregator' ] )
		);
		$this->assertSame( [ 'types' => [], 'partition' => -1 ], Command_Args::bind( $specs, [] ) );
	}

	public function test_bind_refuses_a_missing_required_variadic(): void {
		$this->assertSame(
			'missing required argument: names',
			$this->refusal( [ [ 'name' => 'names', 'type' => 'string', 'required' => true, 'variadic' => true ] ], [] )
		);
	}

	public function test_bind_takes_a_named_variadic_as_one_member(): void {
		$specs = [ [ 'name' => 'names', 'type' => 'string', 'variadic' => true ] ];
		$this->assertSame( [ 'names' => [ 'hub' ] ], Command_Args::bind( $specs, [ '--names=hub' ] ) );
	}

	/** A positional secret lands in shell history and transcripts unmasked. */
	public function test_bind_refuses_a_secret_given_by_position_without_echoing_it(): void {
		$specs = [
			[ 'name' => 'id', 'type' => 'string', 'required' => true ],
			[ 'name' => 'password', 'type' => 'string', 'secret' => true ],
		];
		$refusal = $this->refusal( $specs, [ 'spoke-9', 'hunter2-3391' ] );

		$this->assertSame( 'password must be named: write --password=<value>', $refusal );
		$this->assertSame( [ 'id' => 'spoke-9', 'password' => 'hunter2-3391' ], Command_Args::bind( $specs, [ 'spoke-9', '--password=hunter2-3391' ] ) );
	}

	/** A dialog cannot put a list in one token, so a variadic repeats by name. */
	public function test_bind_collects_a_variadic_repeated_by_name(): void {
		$specs = [
			[ 'name' => 'types', 'type' => 'string', 'variadic' => true ],
			[ 'name' => 'partition', 'type' => 'int' ],
		];
		$this->assertSame(
			[ 'types' => [ 'job-worker', 'aggregator' ], 'partition' => null ],
			Command_Args::bind( $specs, [ '--types=job-worker', '--types=aggregator' ] )
		);
		$this->assertSame(
			'types given both by position and as --types',
			$this->refusal( $specs, [ 'job-worker', '--types=aggregator' ] )
		);
	}

	/** One default rule: a `<ns:key>` default resolves and types, as make_node's does. */
	public function test_bind_resolves_and_types_a_token_default(): void {
		$saved = Core::$config_resolvers;
		Core::register_config_namespace( 'kakariki', static fn ( string $key ): ?string => [ 'depth' => '7741', 'hub' => 'yes' ][ $key ] ?? null );
		try {
			$this->assertSame(
				[ 'depth' => 7741, 'hub' => true ],
				Command_Args::bind(
					[
						[ 'name' => 'depth', 'type' => 'int', 'default' => '<kakariki:depth>' ],
						[ 'name' => 'hub', 'type' => 'bool', 'default' => '<kakariki:hub>' ],
					],
					[]
				)
			);
			try {
				Command_Args::bind( [ [ 'name' => 'depth', 'type' => 'int', 'default' => '<kakariki:nope>' ] ], [] );
				$this->fail( 'an unowned token default must not bind' );
			} catch ( \RuntimeException $e ) {
				$this->assertStringContainsString( 'unresolvable config token <kakariki:nope>', \html_entity_decode( $e->getMessage() ) );
			}
		} finally {
			Core::$config_resolvers = $saved;
		}
	}

	public function test_bind_refuses_a_bool_token_outside_its_words(): void {
		$specs = [ [ 'name' => 'enabled', 'type' => 'bool' ] ];
		$this->assertSame(
			"enabled wants a bool: 1, true, yes, on, 0, false, no or off, got 'ture'",
			$this->refusal( $specs, [ 'ture' ] )
		);
		$this->assertFalse( Command_Args::bind( $specs, [ 'OFF' ] )['enabled'] );
	}

	public function test_bind_reads_a_blank_required_token_as_missing(): void {
		$specs = [ [ 'name' => 'handle', 'type' => 'string', 'required' => true ] ];
		$this->assertSame( 'missing required argument: handle', $this->refusal( $specs, [ '' ] ) );
		$this->assertSame( 'missing required argument: handle', $this->refusal( $specs, [ '--handle=' ] ) );
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
		// A bare `--partition` is true; casting it selects p1.
		$this->assertNull( Command_Args::option_int( [ 'partition' => true ], 'partition', -1 ) );
	}

	public function test_option_int_refuses_zero_when_the_caller_forbids_it(): void {
		$this->assertNull( Command_Args::option_int( [ 'num_partitions' => '0' ], 'num_partitions', null, false ) );
	}
}
