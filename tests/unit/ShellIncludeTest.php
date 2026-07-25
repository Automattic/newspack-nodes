<?php
declare(strict_types=1);

namespace Newspack_Nodes\Tests\Unit;

use Newspack_Nodes\Message;
use Newspack_Nodes\Shell_Node;
use Newspack_Nodes\Tests\Capture_Sink_Node;
use Newspack_Nodes\Tests\TestCase;
use Newspack_Nodes\Topology_Registry;
use PHPUnit\Framework\Attributes\CoversClass;

#[CoversClass( Shell_Node::class )]
class ShellIncludeTest extends TestCase {

	private string $tmp;

	protected function setUp(): void {
		parent::setUp();
		Topology_Registry::reset();
		$this->tmp = $this->make_temp_dir( 'shell-include-' );
		Topology_Registry::register_stock_dir( $this->tmp );
	}

	protected function tearDown(): void {
		Topology_Registry::reset();
		$this->rmdir_recursive( $this->tmp );
		parent::tearDown();
	}

	private function write_tsl( string $name, string $contents ): void {
		\file_put_contents( "{$this->tmp}/{$name}.tsl", $contents );
	}

	/**
	 * Every command line the Shell dispatched, in order, reconstructed from the
	 * captured Message. `command`-shaped verbs (make_node, connect_node, ...) carry
	 * VALUE as ['name' => ..., 'arguments' => ...] (Shell::parse()'s default case);
	 * others (tell_node, ...) carry a plain string VALUE.
	 *
	 * @return list<string>
	 */
	private function captured_lines( Capture_Sink_Node $sink ): array {
		$lines = [];
		foreach ( $sink->captured as $message ) {
			$value = $message[ Message::VALUE ] ?? '';
			if ( \is_array( $value ) && isset( $value['name'] ) ) {
				$lines[] = \trim( $value['name'] . ' ' . \implode( ' ', $value['arguments'] ?? [] ) );
			} else {
				$lines[] = (string) $value;
			}
		}
		return $lines;
	}

	/**
	 * @return list<string>
	 */
	private function run_script( string $script, bool $fatal_errors = false ): array {
		$shell = new Shell_Node();
		$sink  = new Capture_Sink_Node();
		$shell->sink( $sink );
		$shell->want_reply( false );
		$shell->fatal_errors( $fatal_errors );
		$shell->eval_script( $script );
		return $this->captured_lines( $sink );
	}

	public function test_include_resolves_a_topology_name_through_the_registry(): void {
		// Distinct from every default: a class + name no other fixture uses.
		$this->write_tsl( 'wombat-base', "make_node Echo wombat-echo\n" );

		$lines = $this->run_script( "include wombat-base\nmake_node Echo caller-echo\n" );

		$this->assertContains( 'make_node Echo wombat-echo', $lines, 'the included topology\'s line never ran' );
		$this->assertContains( 'make_node Echo caller-echo', $lines );
	}

	public function test_include_still_accepts_a_literal_file_path(): void {
		$path = "{$this->tmp}/loose.tsl";
		\file_put_contents( $path, "make_node Echo loose-echo\n" );

		$lines = $this->run_script( "include {$path}\n" );

		$this->assertContains( 'make_node Echo loose-echo', $lines );
	}

	public function test_include_is_a_builtin_and_never_emits_an_include_message(): void {
		$this->write_tsl( 'solo', "make_node Echo solo-echo\n" );

		$lines = $this->run_script( "include solo\n" );

		$this->assertSame( [ 'make_node Echo solo-echo' ], $lines, 'only the included file\'s own lines dispatch' );
	}

	public function test_include_provides_cwd_context_as_though_piped_into_the_repl(): void {
		// A cd\'d include: the included file\'s bare verb routes to the cwd.
		$this->write_tsl( 'tuning', "set_x 41941\n" );
		$shell = new Shell_Node();
		$sink  = new Capture_Sink_Node();
		$shell->sink( $sink );
		$shell->want_reply( false );

		$shell->eval_script( "cd worker:sub\ninclude tuning\n" );

		$this->assertCount( 1, $sink->captured );
		$message = $sink->captured[0];
		$this->assertSame( 'worker:sub', $message[ Message::TO ] );
		$this->assertSame( 'set_x', $message[ Message::VALUE ]['name'] );
		$this->assertSame( [ '41941' ], $message[ Message::VALUE ]['arguments'] );
	}

	public function test_pragma_once_expands_a_diamond_base_exactly_once(): void {
		$this->write_tsl( 'diamond-base', "make_node Tee shared-tee\nconnect_node shared-tee wombat-sink\n" );
		$this->write_tsl( 'diamond-left', "include diamond-base\nmake_node Echo left-echo\n" );
		$this->write_tsl( 'diamond-right', "include diamond-base\nmake_node Echo right-echo\n" );

		$lines = $this->run_script( "include diamond-left\ninclude diamond-right\n" );

		$connects = \array_filter( $lines, fn ( $l ) => 'connect_node shared-tee wombat-sink' === $l );
		$this->assertCount( 1, $connects, 'the shared base expanded twice' );
		$this->assertContains( 'make_node Echo left-echo', $lines );
		$this->assertContains( 'make_node Echo right-echo', $lines );
	}

	public function test_include_cycle_throws_naming_the_chain_in_fatal_mode(): void {
		// Loader-shaped: Topology_Loader turns fatal_errors on so a cyclic
		// .tsl fails loud at worker boot instead of booting a half-built graph.
		$this->write_tsl( 'cycle-a', "include cycle-b\n" );
		$this->write_tsl( 'cycle-b', "include cycle-a\n" );

		$this->expectException( \RuntimeException::class );
		$this->expectExceptionMessage( 'topology include cycle' );

		$this->run_script( "include cycle-a\n", true );
	}

	public function test_include_cycle_logs_and_continues_by_default(): void {
		// REPL-shaped: fatal_errors defaults off, so an operator's `include`
		// typo logs and the session keeps running instead of dying.
		$this->write_tsl( 'cycle-a', "include cycle-b\nmake_node Echo after-cycle\n" );
		$this->write_tsl( 'cycle-b', "include cycle-a\n" );

		$lines = $this->run_script( "include cycle-a\n" );

		$this->assertContains( 'make_node Echo after-cycle', $lines, 'a cycle killed the REPL session instead of logging and continuing' );
	}

	public function test_include_of_unknown_topology_logs_and_continues(): void {
		$lines = $this->run_script( "include no-such-topology\nmake_node Echo after-missing\n" );

		$this->assertContains( 'make_node Echo after-missing', $lines, 'an unresolvable include must log and continue, not abort the script' );
	}

	public function test_include_of_unknown_topology_logs_and_continues_in_fatal_mode_too(): void {
		// fatal_errors only escalates a real parse/cycle detection; an unresolvable
		// name never reaches that branch, so fatal mode doesn't change this.
		$lines = $this->run_script( "include no-such-topology\nmake_node Echo after-missing\n", true );

		$this->assertContains( 'make_node Echo after-missing', $lines );
	}

	public function test_repl_reincludes_after_a_second_top_level_call(): void {
		// A long-lived REPL Shell (unlike Topology_Loader, which builds a
		// fresh Shell per load) must not silently ignore a re-`include` of
		// the same file across separate top-level fill() calls.
		$this->write_tsl( 'wombat-base', "make_node Echo wombat-echo\n" );

		$shell = new Shell_Node();
		$sink  = new Capture_Sink_Node();
		$shell->sink( $sink );
		$shell->want_reply( false );

		$shell->eval_script( "include wombat-base\n" );
		$shell->eval_script( "include wombat-base\n" );

		$lines   = $this->captured_lines( $sink );
		$matches = \array_filter( $lines, fn ( $l ) => 'make_node Echo wombat-echo' === $l );
		$this->assertCount( 2, $matches, 'the second top-level include was silently ignored' );
	}
}
