<?php
/**
 * No-drift guard: PHP `Node_Names` consts and the canonical
 * `src/runtime/reserved-node-names.json` must stay byte-identical so the
 * reply pivot routes the same reserved names on both sides.
 *
 * @package Newspack_Nodes
 */

declare(strict_types=1);

namespace Newspack_Nodes\Tests\Unit;

use Newspack_Nodes\Node_Names;
use Newspack_Nodes\Tests\TestCase;
use PHPUnit\Framework\Attributes\CoversClass;

#[CoversClass( Node_Names::class )]
class NodeNamesTest extends TestCase {

	/** @return array<string,string> The canonical JSON map. */
	private function json_map(): array {
		$path = \dirname( __DIR__, 2 ) . '/src/runtime/reserved-node-names.json';
		$this->assertFileExists( $path, 'canonical reserved-node-names.json must exist' );
		$decoded = \json_decode( (string) \file_get_contents( $path ), true );
		$this->assertIsArray( $decoded, 'reserved-node-names.json must decode to an array' );
		return $decoded;
	}

	/**
	 * The Node_Names string node-name consts. Array-valued consts (e.g. the
	 * derived SESSION_SCAFFOLDING grouping) are not node names and are excluded
	 * from the JSON drift guard.
	 *
	 * @return array<string,string>
	 */
	private function const_map(): array {
		return \array_filter(
			( new \ReflectionClass( Node_Names::class ) )->getConstants(),
			static fn ( $value ): bool => \is_string( $value )
		);
	}

	public function test_every_json_key_maps_to_same_named_const_with_same_value(): void {
		$json   = $this->json_map();
		$consts = $this->const_map();
		foreach ( $json as $key => $value ) {
			$this->assertArrayHasKey( $key, $consts, "JSON key '{$key}' has no matching Node_Names const" );
			$this->assertSame( $value, $consts[ $key ], "Node_Names::{$key} must equal the JSON value" );
		}
	}

	public function test_every_const_appears_in_json_with_same_value(): void {
		$json   = $this->json_map();
		$consts = $this->const_map();
		foreach ( $consts as $name => $value ) {
			$this->assertArrayHasKey( $name, $json, "Node_Names::{$name} is missing from reserved-node-names.json" );
			$this->assertSame( $value, $json[ $name ], "reserved-node-names.json['{$name}'] must equal Node_Names::{$name}" );
		}
	}

	public function test_stdin_stdout_reserved_names(): void {
		$this->assertSame( '_stdin', \Newspack_Nodes\Node_Names::STDIN );
		$this->assertSame( '_stdout', \Newspack_Nodes\Node_Names::STDOUT );
	}
}
