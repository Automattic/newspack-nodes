<?php
/**
 * The static TSL front-end must MEAN what the runtime means.
 *
 * `Shell_Node::parse()` is the authority: it mints the Message. `parse_statements()`
 * only re-renders the same line as a cwd-free canonical statement, so replaying
 * that statement at the root cwd has to mint the very same Message. Every verb
 * parse() dispatches — the minting family, `pwd`, the run_builtin() state verbs,
 * and the bare-verb default — is driven through both halves here.
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes\Tests\Unit;

use PHPUnit\Framework\Attributes\CoversClass;
use Newspack_Nodes\Message;
use Newspack_Nodes\Shell_Node;
use Newspack_Nodes\Tests\Capture_Sink_Node;
use Newspack_Nodes\Tests\TestCase;

#[CoversClass( Shell_Node::class )]
class StatementRuntimeParityTest extends TestCase {

	/**
	 * Every minting verb aimed at a node inside a cwd, plus the state verbs and
	 * a bare verb for contrast. Names are deliberately unlike every other
	 * fixture so a stale expectation cannot pass by coincidence.
	 */
	private const SCRIPT = <<<'TSL'
cd depot
tell_node beacon status ok
tell beacon short form
ping beacon
send_node beacon payload bytes
send beacon short bytes
send_struct_node beacon '{"depth":9}'
request_node beacon fetch 7
send_eof beacon
command_node beacon ping
cmd beacon set_retention --segments=41
pwd
rotate_now --after=13
print holding at depot
var depot_hint = 4271
cd ..
tell_node beacon top level
command_node beacon ping
ping beacon
pwd
rotate_now --after=13
TSL;

	/** Messages a live Shell mints for a script, reduced to their meaning. */
	private function runtime_messages( string $script ): array {
		$sink  = new Capture_Sink_Node();
		$shell = new Shell_Node();
		$shell->sink( $sink );
		$shell->eval_script( $script );
		return \array_map( [ $this, 'meaning' ], $sink->captured );
	}

	/**
	 * The same script read statically, then replayed statement by statement at
	 * the root cwd — the round trip the canonical form promises.
	 */
	private function static_messages( string $script ): array {
		$sink  = new Capture_Sink_Node();
		$shell = new Shell_Node();
		$shell->sink( $sink );
		foreach ( Shell_Node::parse_statements( $script ) as $statement ) {
			$shell->eval_script( $statement['raw'] );
		}
		return \array_map( [ $this, 'meaning' ], $sink->captured );
	}

	/**
	 * TYPE/TO/VALUE — what the message says. `ping` carries the mint clock as
	 * its VALUE, which no two runs share; normalize it to the type name.
	 *
	 * @param array<int,mixed> $message A minted Message.
	 */
	private function meaning( array $message ): array {
		$value = $message[ Message::VALUE ];
		if ( Message::TM_PING === ( $message[ Message::TYPE ] & Message::TM_PING ) ) {
			$value = '<mint-clock>';
		}
		// Command_Auth::sign() stamps a per-message nonce; drop it.
		if ( \is_array( $value ) ) {
			unset( $value['auth'] );
		}
		return [
			'type'  => $message[ Message::TYPE ],
			'to'    => $message[ Message::TO ],
			'value' => $value,
		];
	}

	public function test_static_statements_replay_to_the_runtime_messages(): void {
		$this->assertSame(
			$this->runtime_messages( self::SCRIPT ),
			$this->static_messages( self::SCRIPT )
		);
	}

	/**
	 * The one place the static reading deliberately differs: an INTERPRETER
	 * alias is canonicalized, because consumers match `'make_node' === verb`.
	 * parse() keeps the typed verb and lets the interpreter resolve it.
	 */
	public function test_interpreter_aliases_canonicalize_in_the_statement(): void {
		$statements = Shell_Node::parse_statements( "make Tee fanout\ncd depot\nconnect fanout beacon" );
		$this->assertSame( [ 'make_node', 'Tee', 'fanout' ], $statements[0]['values'] );
		$this->assertSame(
			[ 'command_node', 'depot', 'connect_node', 'fanout', 'beacon' ],
			$statements[1]['values']
		);
	}

	/**
	 * `raw` is the canonical single-line form, so it has to REPLAY. The cwd is
	 * spliced in as a resolved value, not a span — unquoted, a spaced cwd makes
	 * `raw` two tokens too long and addresses a node that doesn't exist.
	 */
	public function test_raw_requotes_a_spaced_cwd_spliced_into_the_spans(): void {
		$shell = new Shell_Node();
		$statements = Shell_Node::parse_statements(
			"cd 'depot floor'\nconnect fanout beacon\ntell beacon hello"
		);
		// `cd` mutates and emits nothing, so the two emitted lines are 0 and 1.
		$this->assertSame(
			"command_node 'depot floor' connect_node fanout beacon",
			$statements[0]['raw']
		);
		$this->assertSame( "tell 'depot floor/beacon' hello", $statements[1]['raw'] );
		$this->assertSame(
			[ 'command_node', 'depot floor', 'connect_node', 'fanout', 'beacon' ],
			$shell->tokenize( $statements[0]['raw'] )
		);
	}

	/**
	 * Builtin dispatch reads token[0] and nothing else: `ping foo` is the
	 * Shell's ping, while `command_node foo ping` names a REMOTE verb the Shell
	 * must pass through untouched.
	 */
	public function test_ping_as_a_command_name_is_not_the_ping_verb(): void {
		$statements = Shell_Node::parse_statements(
			"command_node _command_interpreter ping\ncd depot\ncommand_node beacon ping"
		);
		$this->assertSame(
			[ 'command_node', '_command_interpreter', 'ping' ],
			$statements[0]['values']
		);
		$this->assertSame( [ 'command_node', 'depot/beacon', 'ping' ], $statements[1]['values'] );

		$sink  = new Capture_Sink_Node();
		$shell = new Shell_Node();
		$shell->sink( $sink );
		$shell->eval_script( 'command_node _command_interpreter ping' );
		$this->assertSame( Message::TM_COMMAND, $sink->captured[0][ Message::TYPE ] );
		$this->assertSame( '_command_interpreter', $sink->captured[0][ Message::TO ] );
		$value = $sink->captured[0][ Message::VALUE ];
		$this->assertSame( 'ping', $value['name'] );
		$this->assertSame( [], $value['arguments'] );
	}
}
