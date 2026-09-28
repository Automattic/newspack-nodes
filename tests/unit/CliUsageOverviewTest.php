<?php
/**
 * Every `wp nodes` command lists in the usage overview of its namespace.
 *
 * @package Newspack_Nodes\Tests
 */

namespace Newspack_Nodes\Tests;

require_once \dirname( __DIR__ ) . '/Helpers/WPCLIStub.php';
require_once \dirname( __DIR__ ) . '/Helpers/ListsEveryCliCommand.php';

final class CliUsageOverviewTest extends TestCase {
	use ListsEveryCliCommand;

	public function test_every_nodes_command_lists_in_its_usage_overview(): void {
		$GLOBALS['_test_wp_cli_commands'] = [];

		\newspack_nodes_register_cli_commands();

		$this->assert_every_cli_command_listed( $GLOBALS['_test_wp_cli_commands'] );
	}
}
