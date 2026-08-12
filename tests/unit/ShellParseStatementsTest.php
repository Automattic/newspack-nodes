<?php
/**
 * Shell_Node::parse_statements — the one static TSL statement front-end.
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes\Tests\Unit;

use PHPUnit\Framework\Attributes\CoversClass;
use Newspack_Nodes\Shell_Node;
use Newspack_Nodes\Tests\TestCase;

#[CoversClass( Shell_Node::class )]
class ShellParseStatementsTest extends TestCase {

	/**
	 * @param list<array{verb:string,values:list<string>,spans:list<string>,raw:string,line:int}> $statements
	 * @return list<array{verb:string,values:list<string>,raw:string,line:int}>
	 */
	private function summarize( array $statements ): array {
		return \array_map(
			static fn ( array $s ): array => [
				'verb'   => $s['verb'],
				'values' => $s['values'],
				'raw'    => $s['raw'],
				'line'   => $s['line'],
			],
			$statements
		);
	}

	/** make/connect/disconnect/command/command_node resolve to their canonical verbs. */
	public function test_resolves_verb_aliases(): void {
		$verbs = \array_column(
			Shell_Node::parse_statements(
				"make Tee a\nconnect a b\ndisconnect a b\ncommand a v\ncommand_node c w"
			),
			'verb'
		);
		$this->assertSame(
			[ 'make_node', 'connect_node', 'disconnect_node', 'command_node', 'command_node' ],
			$verbs
		);
	}

	/** A bare make_node inside a cwd is a command to that node, like any verb. */
	public function test_make_node_inside_a_cwd_is_a_command_to_that_node(): void {
		$statements = Shell_Node::parse_statements( "cd deep\nmake_node Topic leaf" );

		$this->assertSame(
			[ 'command_node', 'deep', 'make_node', 'Topic', 'leaf' ],
			$statements[0]['values']
		);
	}

	/** var and include are shell BUILTINS: never routed, even after a cd. */
	public function test_builtins_var_and_include_are_never_cwd_routed(): void {
		$statements = Shell_Node::parse_statements( "cd deep\nvar x = 1\ninclude other" );

		$this->assertSame( [ 'var', 'x', '=', '1' ], $statements[0]['values'] );
		$this->assertSame( [ 'include', 'other' ], $statements[1]['values'] );
	}

	/** Every verb parse() short-circuits is a BUILTIN: shell state, never a message. */
	public function test_shell_state_builtins_are_never_cwd_routed(): void {
		$statements = Shell_Node::parse_statements(
			"cd deep\nprint hello\nclear\nstatus\nshow_parse\ndebug_level 2"
		);

		$this->assertSame(
			[
				[ 'print', 'hello' ],
				[ 'clear' ],
				[ 'status' ],
				[ 'show_parse' ],
				[ 'debug_level', '2' ],
			],
			\array_column( $statements, 'values' ),
			'a builtin acts on the shell wherever it appears; it never becomes command_node'
		);
	}

	/** A bare verb inside a cd'd path becomes `command_node <path> <verb> <args>`. */
	public function test_cwd_wraps_a_bare_verb_into_a_command_node(): void {
		$statements = $this->summarize(
			Shell_Node::parse_statements( "cd requests:partition\nvoid_warranty keep\ncd /\nset_multi_writer true" )
		);
		$this->assertSame(
			[
				[
					'verb'   => 'command_node',
					'values' => [ 'command_node', 'requests:partition', 'void_warranty', 'keep' ],
					'raw'    => 'command_node requests:partition void_warranty keep',
					'line'   => 2,
				],
				[
					'verb'   => 'set_multi_writer',
					'values' => [ 'set_multi_writer', 'true' ],
					'raw'    => 'set_multi_writer true',
					'line'   => 4,
				],
			],
			$statements
		);
	}

	/** The command family prefixes its path arg with the cwd; tail stays verbatim. */
	public function test_cmd_resolves_path_against_cwd(): void {
		$statements = $this->summarize(
			Shell_Node::parse_statements( "cd n1\ncmd n2 set_x true" )
		);
		$this->assertSame(
			[
				[
					'verb'   => 'command_node',
					'values' => [ 'command_node', 'n1/n2', 'set_x', 'true' ],
					'raw'    => 'command_node n1/n2 set_x true',
					'line'   => 2,
				],
			],
			$statements
		);
	}

	/** Two statements on one physical line split on the unquoted `;`. */
	public function test_splits_statements_on_unquoted_semicolon(): void {
		$statements = $this->summarize(
			Shell_Node::parse_statements( 'make_node Tee a; make_node Tee b' )
		);
		$this->assertSame(
			[
				[
					'verb'   => 'make_node',
					'values' => [ 'make_node', 'Tee', 'a' ],
					'raw'    => 'make_node Tee a',
					'line'   => 1,
				],
				[
					'verb'   => 'make_node',
					'values' => [ 'make_node', 'Tee', 'b' ],
					'raw'    => 'make_node Tee b',
					'line'   => 1,
				],
			],
			$statements
		);
	}

	/** A `;` inside a quoted span does not split the statement. */
	public function test_quoted_semicolon_stays_in_one_statement(): void {
		$statements = Shell_Node::parse_statements( 'cmd n do "a ; b"' );
		$this->assertCount( 1, $statements );
		$this->assertSame( [ 'command_node', 'n', 'do', 'a ; b' ], $statements[0]['values'] );
		$this->assertSame( [ 'command_node', 'n', 'do', '"a ; b"' ], $statements[0]['spans'] );
	}

	/** A trailing backslash folds the next physical line into one logical statement. */
	public function test_backslash_continuation_joins_lines(): void {
		$statements = $this->summarize(
			Shell_Node::parse_statements( "make_node Consumer c \\\n  <config:logs_dir>/f.p<partition>" )
		);
		$this->assertSame(
			[
				[
					'verb'   => 'make_node',
					'values' => [ 'make_node', 'Consumer', 'c', '<config:logs_dir>/f.p<partition>' ],
					'raw'    => 'make_node Consumer c <config:logs_dir>/f.p<partition>',
					'line'   => 1,
				],
			],
			$statements
		);
	}

	/** Comment and blank lines produce no statement, but still advance the line count. */
	public function test_comments_and_blanks_are_dropped(): void {
		$statements = $this->summarize(
			Shell_Node::parse_statements( "# header\n\nmake_node Tee t" )
		);
		$this->assertSame(
			[
				[
					'verb'   => 'make_node',
					'values' => [ 'make_node', 'Tee', 't' ],
					'raw'    => 'make_node Tee t',
					'line'   => 3,
				],
			],
			$statements
		);
	}

	/** An unterminated quote at end-of-input fails loud (topology load is fatal). */
	public function test_open_quote_at_eof_throws(): void {
		$this->expectException( \RuntimeException::class );
		$this->expectExceptionMessage( 'got EOF while waiting for tokens' );
		Shell_Node::parse_statements( 'make_node Tee "unterminated' );
	}

	/** A single-quoted `<partition>` survives byte-identical in spans; values strip the quotes. */
	public function test_single_quoted_partition_token_span_is_verbatim(): void {
		$statements = Shell_Node::parse_statements( "make_node Partition p '<partition>'" );
		$this->assertCount( 1, $statements );
		$this->assertSame(
			[ 'make_node', 'Partition', 'p', "'<partition>'" ],
			$statements[0]['spans']
		);
		$this->assertSame(
			[ 'make_node', 'Partition', 'p', '<partition>' ],
			$statements[0]['values']
		);
	}

	public function test_trailing_continuation_at_eof_fails_loud_like_the_runtime(): void {
		$this->expectException( \RuntimeException::class );
		$this->expectExceptionMessageMatches( '/EOF while waiting/' );
		Shell_Node::parse_statements( "make_node Tee dangling \\" );
	}

	public function test_var_values_are_quote_stripped_like_every_other_token(): void {
		// The legacy static regex captured quotes verbatim; the runtime never
		// did. One semantics now — enumerated as the FIX, not papered over.
		$statements = Shell_Node::parse_statements( "var greeting = \"hello and more\"\n" );
		$this->assertSame( 'var', $statements[0]['verb'] );
		$this->assertSame( [ 'var', 'greeting', '=', 'hello and more' ], $statements[0]['values'] );
		$this->assertSame( '"hello and more"', $statements[0]['spans'][3], 'the span keeps the quotes verbatim' );
	}
}
