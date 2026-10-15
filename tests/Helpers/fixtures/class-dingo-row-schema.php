<?php
/**
 * A class named as a Row_Schema is that does not implement Row_Schema.
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes\Tests;

\defined( 'ABSPATH' ) || exit;

final class Dingo_Row_Schema {
	public static function version(): int {
		return 4;
	}
}
