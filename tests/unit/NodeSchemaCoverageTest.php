<?php
declare(strict_types=1);

namespace Newspack_Nodes\Tests\Unit;

use Composer\Autoload\ClassLoader;
use Newspack_Nodes\Node;
use Newspack_Nodes\Tests\TestCase;

class NodeSchemaCoverageTest extends TestCase {
	public function test_every_substrate_node_class_returns_schema_with_category(): void {
		$missing = [];
		$checked = 0;
		foreach ( ClassLoader::getRegisteredLoaders() as $loader ) {
			foreach ( \array_keys( $loader->getClassMap() ) as $fqcn ) {
				// Substrate `*_Node` classes only — not the `Tests\` doubles.
				if ( ! \str_starts_with( $fqcn, 'Newspack_Nodes\\' ) ) {
					continue;
				}
				if ( \str_starts_with( $fqcn, 'Newspack_Nodes\\Tests\\' ) ) {
					continue;
				}
				$short = \substr( (string) \strrchr( '\\' . $fqcn, '\\' ), 1 );
				if ( ! \str_ends_with( $short, '_Node' ) || ! \is_subclass_of( $fqcn, Node::class ) ) {
					continue;
				}
				// Only classes that DECLARE their own node_schema() opt into the
				// catalog; ones inheriting Node's empty-category default (e.g.
				// SSE_Out_Node, a pure HTTP response writer) aren't cataloged.
				$method = new \ReflectionMethod( $fqcn, 'node_schema' );
				if ( Node::class === $method->getDeclaringClass()->getName() ) {
					continue;
				}
				++$checked;
				$shell  = \substr( $short, 0, -\strlen( '_Node' ) );
				$schema = $fqcn::node_schema();
				$cat    = $schema['category'] ?? '';
				if ( ! \is_array( $schema ) || '' === $cat ) {
					$missing[ $shell ] = 'schema missing non-empty category';
				}
			}
		}
		$this->assertGreaterThan( 0, $checked, 'expected to scan at least one substrate Node class' );
		$this->assertSame(
			[],
			$missing,
			'Classes without node_schema()/category: ' . \print_r( $missing, true )
		);
	}

	public function test_every_node_schema_argument_has_a_description(): void {
		// Every constructor argument surfaces in the topology console (CtorField);
		// a missing description is a blank tooltip. This gate keeps new args honest.
		$missing   = [];
		$seen_args = 0;
		foreach ( ClassLoader::getRegisteredLoaders() as $loader ) {
			foreach ( \array_keys( $loader->getClassMap() ) as $fqcn ) {
				if ( ! \str_starts_with( $fqcn, 'Newspack_Nodes\\' ) ) {
					continue;
				}
				if ( \str_starts_with( $fqcn, 'Newspack_Nodes\\Tests\\' ) ) {
					continue;
				}
				$short = \substr( (string) \strrchr( '\\' . $fqcn, '\\' ), 1 );
				if ( ! \str_ends_with( $short, '_Node' ) || ! \is_subclass_of( $fqcn, Node::class ) ) {
					continue;
				}
				$method = new \ReflectionMethod( $fqcn, 'node_schema' );
				if ( Node::class === $method->getDeclaringClass()->getName() ) {
					continue;
				}
				$args = $fqcn::node_schema()['arguments'] ?? [];
				if ( ! \is_array( $args ) ) {
					continue;
				}
				$shell = \substr( $short, 0, -\strlen( '_Node' ) );
				foreach ( $args as $arg ) {
					++$seen_args;
					$name = \is_array( $arg ) ? (string) ( $arg['name'] ?? '?' ) : '?';
					$desc = \is_array( $arg ) ? ( $arg['description'] ?? '' ) : '';
					if ( ! \is_string( $desc ) || '' === \trim( $desc ) ) {
						$missing[] = "{$shell}.{$name}";
					}
				}
			}
		}
		$this->assertGreaterThan( 0, $seen_args, 'expected to scan at least one node_schema argument' );
		$this->assertSame(
			[],
			$missing,
			'node_schema arguments missing a description: ' . \print_r( $missing, true )
		);
	}

	public function test_default_node_schema_advertises_both_ports(): void {
		// Plain Node has both fill() and target() — defaults must be true so
		// the schematic renderer keeps drawing IN/OUT ports for every class
		// that hasn't explicitly opted out.
		$schema = \Newspack_Nodes\Node::node_schema();
		$this->assertArrayHasKey( 'accepts_fill', $schema );
		$this->assertArrayHasKey( 'has_target', $schema );
		$this->assertTrue( $schema['accepts_fill'] );
		$this->assertTrue( $schema['has_target'] );
	}

	public function test_tail_does_not_accept_fill(): void {
		// Tail is a pure producer — it polls a file and emits messages.
		// fill() is unused, so the IN port should not render.
		$schema = \Newspack_Nodes\Tail_Node::node_schema();
		$this->assertFalse( $schema['accepts_fill'] ?? true );
		$this->assertTrue( $schema['has_target'] ?? false );
	}

	public function test_consumer_does_not_accept_fill(): void {
		// Consumer tails a Partition — also a pure producer.
		$schema = \Newspack_Nodes\Consumer_Node::node_schema();
		$this->assertFalse( $schema['accepts_fill'] ?? true );
		$this->assertTrue( $schema['has_target'] ?? false );
	}

	public function test_partition_has_no_target(): void {
		// Partition is terminal storage — accepts fill() but doesn't forward.
		$schema = \Newspack_Nodes\Partition_Node::node_schema();
		$this->assertTrue( $schema['accepts_fill'] ?? false );
		$this->assertFalse( $schema['has_target'] ?? true );
	}

	public function test_log_has_no_target(): void {
		// Log is terminal storage — accepts fill() but doesn't forward.
		$schema = \Newspack_Nodes\Log_Node::node_schema();
		$this->assertTrue( $schema['accepts_fill'] ?? false );
		$this->assertFalse( $schema['has_target'] ?? true );
	}

	public function test_dumper_forwards_via_target(): void {
		// Post-peel the Dumper renders and FORWARDS the rendered line to its target
		// (_stdout in the REPL, a Log/terminal when placed) — so has_target=true.
		$schema = \Newspack_Nodes\Dumper_Node::node_schema();
		$this->assertTrue( $schema['has_target'] );
	}

	public function test_http_in_has_no_target(): void {
		// HTTP_In is the `_http` egress terminal — writes the response, never forwards.
		$schema = \Newspack_Nodes\Rest\HTTP_In_Node::node_schema();
		$this->assertFalse( $schema['has_target'] );
	}
}
