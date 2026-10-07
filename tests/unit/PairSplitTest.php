<?php
declare(strict_types=1);

namespace Newspack_Nodes\Tests\Unit;

use PHPUnit\Framework\Attributes\DataProvider;
use PHPUnit\Framework\TestCase;
use Newspack_Nodes\Remote_Source_Node;

/**
 * A broker's `<source>:<target>` pair splits at its first colon outside
 * `<…>`, and the console's TSL reader splits it the same way, so both read
 * one case list.
 */
final class PairSplitTest extends TestCase {

	/** @return array<string,array{string,string,string}> Label => token, then its source and target. */
	public static function pairs(): array {
		$cases = \json_decode( (string) \file_get_contents( __DIR__ . '/../fixtures/pair-split.json' ), true, 512, \JSON_THROW_ON_ERROR );
		$out   = [];
		foreach ( $cases as [ $label, $token, $source, $target ] ) {
			$out[ $label ] = [ $token, $source, $target ];
		}
		return $out;
	}

	#[DataProvider( 'pairs' )]
	public function test_split_pair_reads_the_shared_case_list( string $token, string $source, string $target ): void {
		$this->assertSame( [ 'source' => $source, 'target' => $target ], Remote_Source_Node::split_pair( $token ) );
	}
}
