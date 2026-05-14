<?php
declare(strict_types=1);

namespace Newspack_Nodes\Tests\Unit;

use Newspack_Nodes\CommandInterpreter;
use Newspack_Nodes\Tests\TestCase;

class NodeSchemaCoverageTest extends TestCase {
	public function test_every_registered_class_returns_schema_with_category(): void {
		$missing = [];
		foreach ( CommandInterpreter::class_map() as $shell_name => $fqcn ) {
			if ( ! \method_exists( $fqcn, 'node_schema' ) ) {
				$missing[ $shell_name ] = 'no node_schema() method';
				continue;
			}
			$schema = $fqcn::node_schema();
			$cat    = $schema['category'] ?? '';
			if ( ! \is_array( $schema ) || '' === $cat ) {
				$missing[ $shell_name ] = 'schema missing non-empty category';
			}
		}
		$this->assertSame(
			[],
			$missing,
			"Classes without node_schema()/category: " . \print_r( $missing, true )
		);
	}
}
