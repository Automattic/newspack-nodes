<?php
/**
 * A Row_Schema whose tables a test sets, for pinning what a Row_Table
 * refuses in a schema before its file opens.
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes\Tests;

\defined( 'ABSPATH' ) || exit;

final class Lab_Row_Schema implements \Newspack_Nodes\Row_Schema {
	/** @var array<string,mixed> The tables tables() answers. */
	public static array $tables = [];

	public static function version(): int {
		return 9;
	}

	public static function tables(): array {
		return self::$tables;
	}
}
