<?php
declare(strict_types=1);

namespace Newspack_Nodes\Tests\Unit;

use PHPUnit\Framework\Attributes\DataProvider;
use PHPUnit\Framework\TestCase;
use Newspack_Nodes\Log_Discovery;

/**
 * The stamp a FROM trail opens with, read back by
 * `Log_Discovery::dir_from_stamp()`, held to `src/runtime/log-stamp.js` by one
 * case list: every stamp is one `/` segment, its parts joined by `:`.
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

	/** A one-segment stamp never reads as a prefix, so a log may take a group's name. */
	public function test_a_log_dir_named_like_the_sources_prefix_is_an_ordinary_log(): void {
		$this->assertSame( 'sources', Log_Discovery::stamp_for( 'logs', 'sources' ) );
		$this->assertTrue( Log_Discovery::is_stamp( 'sources' ) );
		$this->assertNull( Log_Discovery::source_name( 'sources' ) );
	}

	public function test_stamp_for_refuses_a_log_dir_holding_a_colon(): void {
		$this->expectException( \InvalidArgumentException::class );
		$this->expectExceptionMessage( 'log dir sources:php holds a colon, which a stamp reads as a separator; rename it' );

		Log_Discovery::stamp_for( 'logs', 'sources:php' );
	}

	/**
	 * The cases `tests/fixtures/source-names.json` holds, which the browser's
	 * `sourceName()` reads alike in `log-stamp.test.js`.
	 *
	 * @return array<string,array{string,?string}> Label => a string, then the source it names or null.
	 */
	public static function source_names(): array {
		$cases = \json_decode( (string) \file_get_contents( __DIR__ . '/../fixtures/source-names.json' ), true, 512, \JSON_THROW_ON_ERROR );
		$out   = [];
		foreach ( $cases as [ $label, $stamp, $name ] ) {
			$out[ $label ] = [ $stamp, $name ];
		}
		return $out;
	}

	/** A `sources:` stamp names its entry; anything a stream refuses names none, and nothing throws. */
	#[\PHPUnit\Framework\Attributes\DataProvider( 'source_names' )]
	public function test_source_name_reads_the_name_after_the_sources_prefix( string $stamp, ?string $name ): void {
		$this->assertSame( $name, Log_Discovery::source_name( $stamp ) );
	}

	/** The fixture's over-long case stays past the stamp bound. */
	public function test_the_fixtures_over_long_source_is_past_the_bound(): void {
		$this->assertGreaterThan( Log_Discovery::MAX_STAMP_BYTES, \strlen( self::source_names()['an over-long one'][0] ) );
	}
}
