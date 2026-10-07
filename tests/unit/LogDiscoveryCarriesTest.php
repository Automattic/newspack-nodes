<?php
declare(strict_types=1);

namespace Newspack_Nodes\Tests\Unit;

use PHPUnit\Framework\Attributes\CoversClass;
use PHPUnit\Framework\Attributes\DataProvider;
use PHPUnit\Framework\TestCase;
use Newspack_Nodes\Log_Discovery;

/**
 * Which stamps a subscription carries, held to the browser's `carries()` in
 * `src/runtime/log-stamp.js` by one case list, so the hub's broker and a
 * dashboard route a record to the same reader.
 */
#[CoversClass( Log_Discovery::class )]
final class LogDiscoveryCarriesTest extends TestCase {

	/** @return array<string,array{string,string,bool}> Label => sub, stamp, expected. */
	public static function rows(): array {
		$cases = \json_decode( (string) \file_get_contents( __DIR__ . '/../fixtures/subscription-carries.json' ), true, 512, \JSON_THROW_ON_ERROR );
		$out   = [];
		foreach ( $cases as [ $label, $sub, $stamp, $expected ] ) {
			$out[ $label ] = [ $sub, $stamp, $expected ];
		}
		return $out;
	}

	#[DataProvider( 'rows' )]
	public function test_carries_matches_the_browser( string $sub, string $stamp, bool $expected ): void {
		$this->assertSame( $expected, Log_Discovery::carries( $sub, $stamp ) );
	}
}
