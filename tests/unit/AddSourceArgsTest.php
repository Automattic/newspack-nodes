<?php
declare(strict_types=1);

namespace Newspack_Nodes\Tests\Unit;

use PHPUnit\Framework\Attributes\CoversClass;
use PHPUnit\Framework\Attributes\DataProvider;
use Newspack_Nodes\Command_Args;
use Newspack_Nodes\Command_Interpreter_Node;
use Newspack_Nodes\Remote_Source_Node;
use Newspack_Nodes\Tests\TestCase;

/**
 * A broker's `add_source` binds its two arguments through `Command_Args::bind()`,
 * and the browser's `bindCommandArgs()` binds them the same way, so both read
 * one case list.
 */
#[CoversClass( Command_Args::class )]
final class AddSourceArgsTest extends TestCase {

	/** @return array<string,array{list<string>,array<string,string>}> Label => tokens, then the binding or the refusal. */
	public static function cases(): array {
		$cases = \json_decode( (string) \file_get_contents( __DIR__ . '/../fixtures/add-source-args.json' ), true, 512, \JSON_THROW_ON_ERROR );
		$out   = [];
		foreach ( $cases as [ $label, $tokens, $expected ] ) {
			$out[ $label ] = [ $tokens, $expected ];
		}
		return $out;
	}

	/**
	 * @param list<string>          $tokens   The verb's tokens.
	 * @param array<string,string> $expected The bound args, or `refused` and its words.
	 */
	#[DataProvider( 'cases' )]
	public function test_bind_reads_the_shared_case_list( array $tokens, array $expected ): void {
		$specs = Command_Interpreter_Node::declared_verbs( Remote_Source_Node::class )['add_source']['args'];
		try {
			$bound = Command_Args::bind( $specs, $tokens );
		} catch ( \InvalidArgumentException $e ) {
			$this->assertSame( $expected, [ 'refused' => \html_entity_decode( $e->getMessage(), \ENT_QUOTES ) ] );
			return;
		}
		$this->assertSame( $expected, $bound );
	}
}
