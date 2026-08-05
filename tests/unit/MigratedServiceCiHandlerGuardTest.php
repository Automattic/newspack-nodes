<?php
/**
 * MigratedServiceCiHandlerGuardTest: cross-interpreter guards for the three substrate
 * service interpreters migrated off bespoke `__construct`/`verb_table` command setup
 * onto the schema-driven mechanism (handlers live in node_schema()['commands'][]).
 *
 * Two contracts, asserted for Raw_Logs_CI, Layouts_CI, and Workers_CI:
 *
 *   1. Every node_schema verb carries a callable `handler` — the schema is the
 *      single source of truth, so a verb without one would be invisible to
 *      Service_CI_Node::commands_from_schema() and dispatch to nothing.
 *
 *   2. Constructing the interpreter emits NO "no callable handler" warning — proves the
 *      migration didn't drop a handler in the move (commands_from_schema warns +
 *      skips any named verb that lacks a callable handler).
 *
 * @package Newspack_Nodes
 */

declare(strict_types=1);

namespace Newspack_Nodes\Tests\Unit;

use PHPUnit\Framework\Attributes\CoversNothing;
use Newspack_Nodes\Core;
use Newspack_Nodes\Rest\Layouts_CI_Node;
use Newspack_Nodes\Rest\Raw_Logs_CI_Node;
use Newspack_Nodes\Rest\Workers_CI_Node;
use Newspack_Nodes\Tests\Helpers\VerbHarness;
use Newspack_Nodes\Tests\TestCase;

#[CoversNothing]
class MigratedServiceCiHandlerGuardTest extends TestCase {

	protected function tearDown(): void {
		VerbHarness::reset();
		parent::tearDown();
	}

	/**
	 * Build a fresh Workers_CI with a duck-typed Cli stub. (Raw_Logs_CI and
	 * Layouts_CI take no ctor args; Workers_CI is the one stateful interpreter.)
	 */
	private function workers_ci(): Workers_CI_Node {
		$cli = new class {
			public function ls_workers(): array { return []; }
			public function live_position( $cache, string $type, int $partition ): ?array { return null; }
			public function restart_workers( array $workers, array $filter = [], int $partition = -1 ): int { return 0; }
		};
		$interpreter      = new Workers_CI_Node();
		$interpreter->cli = $cli;
		return $interpreter;
	}

	public function test_raw_logs_schema_verbs_all_carry_callable_handlers(): void {
		foreach ( Raw_Logs_CI_Node::node_schema()['commands'] as $verb ) {
			$this->assertTrue(
				isset( $verb['handler'] ) && \is_callable( $verb['handler'] ),
				"Raw_Logs verb '{$verb['name']}' must carry a callable handler in node_schema()"
			);
		}
	}

	public function test_layouts_schema_verbs_all_carry_callable_handlers(): void {
		foreach ( Layouts_CI_Node::node_schema()['commands'] as $verb ) {
			$this->assertTrue(
				isset( $verb['handler'] ) && \is_callable( $verb['handler'] ),
				"Layouts verb '{$verb['name']}' must carry a callable handler in node_schema()"
			);
		}
	}

	public function test_workers_schema_verbs_all_carry_callable_handlers(): void {
		foreach ( Workers_CI_Node::node_schema()['commands'] as $verb ) {
			$this->assertTrue(
				isset( $verb['handler'] ) && \is_callable( $verb['handler'] ),
				"Workers verb '{$verb['name']}' must carry a callable handler in node_schema()"
			);
		}
	}

	public function test_raw_logs_construction_emits_no_handlerless_warning(): void {
		$buf = '';
		Core::set_stderr_handler( function ( $message ) use ( &$buf ) { $buf .= $message; } );

		new Raw_Logs_CI_Node();

		$this->assertStringNotContainsString( 'no callable handler', $buf );
	}

	public function test_layouts_construction_emits_no_handlerless_warning(): void {
		$buf = '';
		Core::set_stderr_handler( function ( $message ) use ( &$buf ) { $buf .= $message; } );

		new Layouts_CI_Node();

		$this->assertStringNotContainsString( 'no callable handler', $buf );
	}

	public function test_workers_construction_emits_no_handlerless_warning(): void {
		$buf = '';
		Core::set_stderr_handler( function ( $message ) use ( &$buf ) { $buf .= $message; } );

		$this->workers_ci();

		$this->assertStringNotContainsString( 'no callable handler', $buf );
	}

	public function test_all_three_cis_install_every_schema_verb_as_a_command(): void {
		Core::set_stderr_handler( static function () { /* swallow */ } );

		$cases = [
			'raw-logs' => [ new Raw_Logs_CI_Node(), Raw_Logs_CI_Node::node_schema() ],
			'layouts'  => [ new Layouts_CI_Node(), Layouts_CI_Node::node_schema() ],
			'workers'  => [ $this->workers_ci(), Workers_CI_Node::node_schema() ],
		];

		foreach ( $cases as $label => [ $interpreter, $schema ] ) {
			$commands = $interpreter->commands();
			foreach ( $schema['commands'] as $verb ) {
				$this->assertArrayHasKey(
					$verb['name'],
					$commands,
					"{$label}: schema verb '{$verb['name']}' must install as a dispatchable command"
				);
			}
		}
	}
}
