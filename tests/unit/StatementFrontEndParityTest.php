<?php
/**
 * Cross-language golden pin for the TSL statement front-end. The committed
 * fixtures under tests/fixtures/statements/*.json are generated ONCE from PHP
 * Shell_Node::parse_statements(); this test asserts PHP still reproduces them,
 * and the jest suite (src/runtime/__tests__/parse-statements.fixture.test.js)
 * asserts JS parseStatements() reproduces the same JSON. A change to either
 * front-end or tokenizer that isn't mirrored fails one side's suite immediately
 * (the Probe_Record / probe-record.js parity precedent, one level up).
 *
 * Regenerate after an intentional grammar change:
 *   NEWSPACK_NODES_REGEN_STATEMENTS=1 phpunit --filter StatementFrontEndParity
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes\Tests\Unit;

use Newspack_Nodes\Shell_Node;
use Newspack_Nodes\Tests\TestCase;
use PHPUnit\Framework\Attributes\CoversClass;

#[CoversClass( Shell_Node::class )]
class StatementFrontEndParityTest extends TestCase {

	/** @return array<string,string> Fixture name → absolute .tsl path. */
	private function tsl_fixtures(): array {
		$plugin_dir = \dirname( __DIR__, 2 );
		$paths      = [
			...\glob( $plugin_dir . '/topologies/*.tsl' ) ?: [],
			...\glob( $plugin_dir . '/examples/example-ai-newsletter/topologies/*.tsl' ) ?: [],
			...\glob( \dirname( __DIR__ ) . '/fixtures/*.tsl' ) ?: [],
		];
		$fixtures = [];
		foreach ( $paths as $path ) {
			$fixtures[ \basename( $path, '.tsl' ) ] = $path;
		}
		\ksort( $fixtures );
		return $fixtures;
	}

	private function statements_dir(): string {
		return \dirname( __DIR__ ) . '/fixtures/statements';
	}

	/** PHP front-end reproduces the committed statement-list JSON for every fixture. */
	public function test_php_front_end_matches_committed_statement_fixtures(): void {
		$regen = (bool) \getenv( 'NEWSPACK_NODES_REGEN_STATEMENTS' );
		if ( $regen && ! \is_dir( $this->statements_dir() ) ) {
			\mkdir( $this->statements_dir(), 0755, true );
		}
		foreach ( $this->tsl_fixtures() as $name => $path ) {
			$statements = Shell_Node::parse_statements( (string) \file_get_contents( $path ) );
			$json_path  = $this->statements_dir() . "/{$name}.json";
			if ( $regen ) {
				\file_put_contents(
					$json_path,
					(string) \json_encode( $statements, \JSON_PRETTY_PRINT | \JSON_UNESCAPED_SLASHES ) . "\n"
				);
				continue;
			}
			$this->assertFileExists(
				$json_path,
				"missing statement fixture for {$name}; regenerate with NEWSPACK_NODES_REGEN_STATEMENTS=1"
			);
			$expected = \json_decode( (string) \file_get_contents( $json_path ), true );
			$this->assertSame( $expected, $statements, "PHP front-end drifted from committed fixture {$name}.json" );
		}
		if ( $regen ) {
			// A write-then-assert would pass against its own output — never
			// let a leaked env var turn the cross-language pin vacuous.
			$this->markTestIncomplete( 'statement fixtures regenerated; rerun WITHOUT the env var to pin them' );
		}
	}
}
