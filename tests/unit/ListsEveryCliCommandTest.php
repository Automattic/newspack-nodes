<?php
/**
 * The usage-overview rule, against registrations WP-CLI handles each way.
 *
 * @package Newspack_Nodes\Tests
 */

namespace Newspack_Nodes\Tests;

use PHPUnit\Framework\AssertionFailedError;

require_once \dirname( __DIR__ ) . '/Helpers/ListsEveryCliCommand.php';

final class ListsEveryCliCommandTest extends TestCase {
	use ListsEveryCliCommand;

	public function test_an_unregistered_level_under_a_registered_root_is_missing_from_the_root(): void {
		$reported = $this->reported( [ 'grove' => self::group(), 'grove lantern wick' => [ self::group(), 'wick' ] ] );

		$this->assertStringContainsString( '`wp grove lantern` is missing from `wp grove`', $reported );
	}

	public function test_a_child_registered_before_its_group_is_missing_from_the_group(): void {
		$reported = $this->reported(
			[
				'grove'              => self::group(),
				'grove lantern wick' => [ self::group(), 'wick' ],
				'grove lantern'      => self::group(),
			]
		);

		$this->assertStringContainsString( '`wp grove lantern wick` is missing from `wp grove lantern`', $reported );
	}

	public function test_a_group_registered_before_its_child_lists_it(): void {
		$this->assert_every_cli_command_listed(
			[
				'grove'              => self::group(),
				'grove lantern'      => self::group(),
				'grove lantern wick' => [ self::group(), 'wick' ],
			]
		);
	}

	public function test_every_depth_under_an_unregistered_root_lists(): void {
		$this->assert_every_cli_command_listed(
			[
				'heath knoll cairn' => [ self::group(), 'cairn' ],
				'heath tor'         => [ self::group(), 'tor' ],
			]
		);
	}

	public function test_a_command_under_a_bound_method_is_refused_even_under_an_unregistered_root(): void {
		$reported = $this->reported( [ 'moor fen' => [ self::group(), 'fen' ], 'moor fen bog' => [ self::group(), 'bog' ] ] );

		$this->assertStringContainsString( '`wp moor fen bog`: `wp moor fen` is a single command', $reported );
	}

	public function test_a_command_under_an_invoke_class_is_refused(): void {
		$invokable = new class() {
			public function __invoke( array $args, array $assoc_args ): void {}
		};

		$reported = $this->reported(
			[
				'dune'             => self::group(),
				'dune crest'       => $invokable,
				'dune crest ridge' => [ self::group(), 'ridge' ],
			]
		);

		$this->assertStringContainsString( '`wp dune crest ridge`: `wp dune crest` is a single command', $reported );
	}

	public function test_a_bound_method_replacing_a_flushed_group_is_refused(): void {
		$reported = $this->reported( [ 'marsh reed pool' => [ self::group(), 'pool' ], 'marsh reed' => [ self::group(), 'reed' ] ] );

		$this->assertStringContainsString( '`wp marsh reed pool`: `wp marsh reed` is a single command', $reported );
	}

	public function test_a_command_two_levels_under_a_single_command_is_unreachable(): void {
		$reported = $this->reported(
			[
				'cliff'           => self::group(),
				'cliff ledge'     => [ self::group(), 'ledge' ],
				'cliff ledge nest egg' => [ self::group(), 'egg' ],
			]
		);

		$this->assertStringContainsString( '`wp cliff ledge nest` is unreachable: `wp cliff ledge` is a single command', $reported );
		$this->assertStringNotContainsString( "can't have subcommands", $reported, 'WP-CLI throws only under an immediate parent' );
	}

	public function test_a_later_command_named_for_the_deferred_path_attaches_it_at_load(): void {
		$this->assert_every_cli_command_listed(
			[
				'bay'              => self::group(),
				'bay harbour pier' => [ self::group(), 'pier' ],
				'harbour'          => self::group(),
			]
		);
	}

	public function test_a_refused_command_is_reported_once(): void {
		$reported = $this->reported( [ 'moor fen' => [ self::group(), 'fen' ], 'moor fen bog' => [ self::group(), 'bog' ] ] );

		$this->assertSame( 1, \substr_count( $reported, '`wp moor fen bog`' ) );
	}

	/**
	 * What the rule reports for $commands, or '' when it passes them.
	 *
	 * @param array<string,mixed> $commands Name => callable, in registration order.
	 */
	private function reported( array $commands ): string {
		try {
			$this->assert_every_cli_command_listed( $commands );
		} catch ( AssertionFailedError $e ) {
			return $e->getMessage();
		}
		return '';
	}

	/**
	 * A command class WP-CLI builds as a group.
	 */
	private static function group(): object {
		return new class() {
			public function wick(): void {}
		};
	}
}
