<?php
/**
 * Node_Schema_Help renders a node_schema() as the errors-as-docs help block —
 * extracted from Command_Interpreter_Node (presentation over a schema owned by
 * Schema_Reflection, not Tachikoma vocabulary). cmd_help's node-type branch
 * delegates here; test_help_renders_node_schema_for_a_node_type pins that path
 * end-to-end while this pins the renderer directly.
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes\Tests\Unit;

use Newspack_Nodes\Node_Schema_Help;
use Newspack_Nodes\Tests\TestCase;
use PHPUnit\Framework\Attributes\CoversClass;

#[CoversClass( Node_Schema_Help::class )]
class NodeSchemaHelpTest extends TestCase {

	/** @return array<string,mixed> A schema exercising every render section. */
	private function full_schema(): array {
		return [
			'category'     => 'Storage',
			'description'  => 'A widget node.',
			'accepts_fill' => true,
			'has_target'   => false,
			'arguments'    => [
				[ 'name' => 'path', 'type' => 'string', 'required' => true, 'description' => 'where to write' ],
				[ 'name' => 'limit', 'type' => 'int', 'default' => 42, 'description' => 'row cap' ],
			],
			'commands'     => [
				[ 'name' => 'flush', 'description' => 'flush now' ],
			],
			'requests'     => [
				[ 'name' => 'peek', 'description' => 'peek head' ],
			],
			'registrations' => [ 'FIRE', 'DONE' ],
		];
	}

	public function test_render_lays_out_every_schema_section(): void {
		$out = Node_Schema_Help::render( 'Widget', $this->full_schema() );

		$this->assertStringStartsWith( '### Widget — Storage ###', $out );
		$this->assertStringContainsString( 'A widget node.', $out );
		$this->assertStringContainsString( 'accepts_fill=true', $out );
		$this->assertStringContainsString( 'has_target=false', $out );

		$this->assertStringContainsString( 'ARGUMENTS', $out );
		$this->assertStringContainsString( 'path', $out );
		$this->assertStringContainsString( 'required', $out );
		$this->assertStringContainsString( 'where to write', $out );
		// A non-required arg renders its default as `=<value>`, not "required".
		$this->assertStringContainsString( '=42', $out );
		$this->assertStringContainsString( 'row cap', $out );

		$this->assertStringContainsString( "COMMANDS\nflush", $out );
		$this->assertStringContainsString( 'flush now', $out );
		$this->assertStringContainsString( "REQUESTS\npeek", $out );
		$this->assertStringContainsString( 'peek head', $out );
		$this->assertStringContainsString( 'REGISTRATIONS: FIRE, DONE', $out );
	}

	public function test_render_omits_absent_sections(): void {
		// A bare schema (no args/commands/requests/registrations) renders only
		// the header + description — no empty section labels.
		$out = Node_Schema_Help::render( 'Bare', [ 'description' => 'nothing else' ] );

		$this->assertSame( "### Bare ###\nnothing else", $out );
	}
}
