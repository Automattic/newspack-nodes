<?php
declare(strict_types=1);

namespace Newspack_Nodes\Tests\Unit;

use PHPUnit\Framework\Attributes\DataProvider;
use PHPUnit\Framework\TestCase;
use Newspack_Nodes\Log_Discovery;

/**
 * The reader stamp a FROM trail opens with, read back by
 * `Log_Discovery::dir_from_stamp()`, held to `src/runtime/log-stamp.js` by one
 * case list: a stamp opening with a group name takes a second segment,
 * because `stamp_for()` refuses a log dir named like a group.
 */
final class LogStampTest extends TestCase {

	/** @return array<string,array{string,string}> FROM => the dir it names. */
	public static function stamps(): array {
		$cases = \json_decode( (string) \file_get_contents( __DIR__ . '/../fixtures/log-stamps.json' ), true, 512, \JSON_THROW_ON_ERROR );
		$out   = [];
		foreach ( $cases as [ $label, $from, $dir ] ) {
			$out[ $label ] = [ $from, $dir ];
		}
		return $out;
	}

	#[DataProvider( 'stamps' )]
	public function test_dir_from_stamp_reads_the_dir_stamp_for_wrote( string $from, string $dir ): void {
		$this->assertSame( $dir, Log_Discovery::dir_from_stamp( $from ) );
	}

	public function test_stamp_for_refuses_a_log_dir_named_like_the_sources_prefix(): void {
		$this->expectException( \InvalidArgumentException::class );
		$this->expectExceptionMessage( 'log dir sources is named like a group' );

		Log_Discovery::stamp_for( 'logs', 'sources' );
	}
}
