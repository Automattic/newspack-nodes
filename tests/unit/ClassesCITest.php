<?php
/**
 * ClassesCITest: unit tests for Classes_CI, the M3 service-CI that
 * replaces the legacy ClassesController. Sets the substrate pattern
 * every other M3 CI test (Layouts_CI, Topologies_CI) will follow:
 * instantiate the CI (no ctor args — substrate state is global),
 * fire a verb through VerbHarness, assert on the decoded payload.
 *
 * @package Newspack_Nodes
 */

declare(strict_types=1);

namespace Newspack_Nodes\Tests\Unit;

use Newspack_Nodes\Rest\Classes_CI_Node;
use Newspack_Nodes\Tests\Helpers\VerbHarness;
use Newspack_Nodes\Tests\TestCase;
use PHPUnit\Framework\Attributes\CoversClass;

#[CoversClass( Classes_CI_Node::class )]
class ClassesCITest extends TestCase {

	protected function tearDown(): void {
		VerbHarness::reset();
		parent::tearDown();
	}

	public function test_node_schema_declares_its_verbs(): void {
		$schema = Classes_CI_Node::node_schema();
		$names  = \array_map( static fn ( array $v ): string => $v['name'], $schema['verbs'] );
		\sort( $names );
		$this->assertSame( [ 'list' ], $names );
		$this->assertNotEmpty( $schema['description'] );
	}

	public function test_list_verb_returns_classes_and_formatters(): void {
		$result = VerbHarness::fire( new Classes_CI_Node(), 'classes', 'list' );

		$this->assertIsArray( $result );
		$this->assertArrayHasKey( 'classes', $result );
		$this->assertArrayHasKey( 'formatters', $result );
		$this->assertNotEmpty( $result['classes'] );
	}

	public function test_list_filters_hidden_category(): void {
		$result = VerbHarness::fire( new Classes_CI_Node(), 'classes', 'list' );

		foreach ( $result['classes'] as $entry ) {
			$this->assertNotSame(
				'Hidden',
				$entry['category'],
				"Class '{$entry['shell_name']}' has Hidden category — should be filtered out"
			);
		}
	}

	public function test_list_returns_sorted_by_category_then_name(): void {
		$result = VerbHarness::fire( new Classes_CI_Node(), 'classes', 'list' );

		$pairs = \array_map(
			static fn ( $c ) => [ $c['category'], $c['shell_name'] ],
			$result['classes']
		);
		$sorted = $pairs;
		\usort( $sorted, static fn ( $a, $b ) => $a <=> $b );
		$this->assertSame( $sorted, $pairs );
	}
}
