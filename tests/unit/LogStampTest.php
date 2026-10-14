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

	public function test_source_name_reads_the_name_after_the_sources_prefix(): void {
		$this->assertSame( 'php-9137', Log_Discovery::source_name( 'sources:php-9137' ) );
		$this->assertNull( Log_Discovery::source_name( '/var/log/sources:php' ) );
		$this->assertNull( Log_Discovery::source_name( 'logs:app-5531.log' ) );
		$this->assertNull( Log_Discovery::source_name( 'sourcesphp' ) );
	}

	/** @return array<string,array{string}> Label => a `sources:` string naming no one source. */
	public static function no_source_names(): array {
		return [
			'the bare prefix'  => [ 'sources:' ],
			'a nested name'    => [ 'sources:php-9138:x' ],
			'a slash spelling' => [ 'sources/php-9138' ],
			'an over-long one' => [ 'sources:' . \str_repeat( 'p', Log_Discovery::MAX_STAMP_BYTES ) ],
			'a dotted name'    => [ 'sources:..' ],
			'a dir stamp'      => [ 'offsets:php-9138' ],
		];
	}

	/** What a stream refuses names no source here either, and nothing throws. */
	#[\PHPUnit\Framework\Attributes\DataProvider( 'no_source_names' )]
	public function test_source_name_answers_null_for_what_no_stamp_names( string $stamp ): void {
		$this->assertNull( Log_Discovery::source_name( $stamp ) );
	}
}
