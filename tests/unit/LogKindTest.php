<?php
declare(strict_types=1);

namespace Newspack_Nodes\Tests\Unit;

use PHPUnit\Framework\Attributes\DataProvider;
use PHPUnit\Framework\TestCase;
use Newspack_Nodes\Log_Discovery;

/**
 * The stamp ↔ kind codec: a kind is the sibling slot a broker publishes a
 * stamp's reader under, and the dir that reader's cursor sits in, so both
 * directions read one case list.
 */
final class LogKindTest extends TestCase {

	/** @return array<string,array{string,string}> Label => stamp, then its kind. */
	public static function kinds(): array {
		$cases = \json_decode( (string) \file_get_contents( __DIR__ . '/../fixtures/log-kinds.json' ), true, 512, \JSON_THROW_ON_ERROR );
		$out   = [];
		foreach ( $cases as [ $label, $stamp, $kind ] ) {
			$out[ $label ] = [ $stamp, $kind ];
		}
		return $out;
	}

	#[DataProvider( 'kinds' )]
	public function test_kind_of_writes_the_slot_a_stamp_takes( string $stamp, string $kind ): void {
		$this->assertSame( $kind, Log_Discovery::kind_of( $stamp ) );
	}

	#[DataProvider( 'kinds' )]
	public function test_stamp_of_reads_the_stamp_a_kind_names( string $stamp, string $kind ): void {
		$this->assertSame( $stamp, Log_Discovery::stamp_of( $kind ) );
	}
}
