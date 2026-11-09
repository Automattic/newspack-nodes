<?php
/**
 * ServiceCiCommandTableTest: every service interpreter the substrate mounts
 * builds its whole command table from its own `node_schema()`.
 *
 * Three contracts, held for each class in `Bootstrap::SUBSTRATE_CIS`:
 *
 *   1. Every node_schema command carries a callable `handler` — the schema is the
 *      single source of truth, so a command without one would be invisible to
 *      Service_CI_Node::commands_from_schema() and dispatch to nothing.
 *
 *   2. Constructing the interpreter emits NO "no callable handler" warning — proves
 *      every command has a handler (commands_from_schema warns + skips any named
 *      command that lacks a callable handler).
 *
 *   3. Every schema command installs as a dispatchable command.
 *
 * @package Newspack_Nodes
 */

declare(strict_types=1);

namespace Newspack_Nodes\Tests\Unit;

use PHPUnit\Framework\Attributes\CoversNothing;
use PHPUnit\Framework\Attributes\DataProvider;
use Newspack_Nodes\Bootstrap;
use Newspack_Nodes\Core;
use Newspack_Nodes\Service_CI_Node;
use Newspack_Nodes\Tests\Helpers\CommandHarness;
use Newspack_Nodes\Tests\TestCase;

#[CoversNothing]
class ServiceCiCommandTableTest extends TestCase {

	protected function tearDown(): void {
		CommandHarness::reset();
		parent::tearDown();
	}

	/**
	 * Mount name => the interpreter's class, as the substrate mounts it.
	 *
	 * @return array<string,array{0:class-string<Service_CI_Node>}>
	 */
	public static function interpreters(): array {
		return \array_map( static fn ( string $class ): array => [ $class ], Bootstrap::SUBSTRATE_CIS );
	}

	/** @param class-string<Service_CI_Node> $class */
	#[DataProvider( 'interpreters' )]
	public function test_schema_commands_all_carry_callable_handlers( string $class ): void {
		foreach ( $class::node_schema()['commands'] as $command ) {
			$this->assertTrue(
				isset( $command['handler'] ) && \is_callable( $command['handler'] ),
				"{$class} command '{$command['name']}' must carry a callable handler in node_schema()"
			);
		}
	}

	/** @param class-string<Service_CI_Node> $class */
	#[DataProvider( 'interpreters' )]
	public function test_construction_emits_no_handlerless_warning( string $class ): void {
		$buf = '';
		Core::set_stderr_handler( function ( $message ) use ( &$buf ) { $buf .= $message; } );

		new $class();

		$this->assertStringNotContainsString( 'no callable handler', $buf );
	}

	/** @param class-string<Service_CI_Node> $class */
	#[DataProvider( 'interpreters' )]
	public function test_every_schema_command_installs( string $class ): void {
		Core::set_stderr_handler( static function () { /* swallow */ } );

		$commands = ( new $class() )->commands();
		foreach ( $class::node_schema()['commands'] as $declared ) {
			$this->assertArrayHasKey(
				$declared['name'],
				$commands,
				"{$class}: schema command '{$declared['name']}' must install as a dispatchable command"
			);
		}
	}
}
