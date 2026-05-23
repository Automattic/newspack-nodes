<?php
declare(strict_types=1);

namespace Newspack_Nodes\Tests\Unit;

use Newspack_Nodes\Command_Interpreter_Node;
use Newspack_Nodes\Echo_Node;
use Newspack_Nodes\Tests\TestCase;

class CommandInterpreterClassMapTest extends TestCase {
	public function test_class_map_reports_registered_shell_names(): void {
		Command_Interpreter_Node::register_class( 'Echo', Echo_Node::class );
		$map = Command_Interpreter_Node::class_map();
		$this->assertArrayHasKey( 'Echo', $map );
		$this->assertSame( Echo_Node::class, $map['Echo'] );
	}
}
