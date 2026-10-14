<?php
declare(strict_types=1);

namespace Newspack_Nodes\Tests\Unit;

use PHPUnit\Framework\Attributes\CoversClass;
use PHPUnit\Framework\Attributes\DataProvider;
use Newspack_Nodes\Log_Discovery;
use Newspack_Nodes\Tests\TestCase;

/**
 * A broker reader's dir stamps as one segment, `<group>:<root>:<kind>`, cut
 * at its first two colons by one parser. `tests/fixtures/reader-stamps.json`
 * holds that parser to `src/runtime/log-stamp.js`; every row naming parts is
 * a dir the catalog lists and every read path opens.
 */
#[CoversClass( Log_Discovery::class )]
final class LogReaderStampTest extends TestCase {

	private string $tmp;

	protected function setUp(): void {
		parent::setUp();
		$this->tmp = $this->make_temp_dir( 'log-reader-stamp-' );
	}

	protected function tearDown(): void {
		$this->rmdir_recursive( $this->tmp );
		parent::tearDown();
	}

	/** @return array<string,array{string,?list<string>}> Label => candidate, then its group, root and kind, or null. */
	public static function shapes(): array {
		$cases = \json_decode( (string) \file_get_contents( __DIR__ . '/../fixtures/reader-stamps.json' ), true, 512, \JSON_THROW_ON_ERROR );
		$out   = [];
		foreach ( $cases as [ $label, $candidate, $parts ] ) {
			$out[ $label ] = [ $candidate, $parts ];
		}
		return $out;
	}

	/** @return array<string,array{string,string,string}> Label => stamp, its group, and its dir under the group. */
	public static function readers(): array {
		$out = [];
		foreach ( self::shapes() as $label => [ $stamp, $parts ] ) {
			if ( null !== $parts ) {
				$out[ $label ] = [ $stamp, $parts[0], "{$parts[1]}/{$parts[2]}" ];
			}
		}
		return $out;
	}

	/**
	 * @param string            $candidate A string that may be a reader stamp.
	 * @param list<string>|null $parts     Its group, root and kind, or null.
	 */
	#[DataProvider( 'shapes' )]
	public function test_is_reader_stamp_reads_the_shape_the_fixture_names( string $candidate, ?array $parts ): void {
		$this->assertSame( null !== $parts, Log_Discovery::is_reader_stamp( $candidate ) );
	}

	#[DataProvider( 'readers' )]
	public function test_stamp_for_writes_the_stamp_and_split_reads_the_dir_back( string $stamp, string $group, string $dir ): void {
		$this->assertSame( $stamp, Log_Discovery::stamp_for( $group, $dir ) );
		$this->assertSame( [ $group, $dir ], Log_Discovery::split( $stamp ) );
		$this->assertTrue( Log_Discovery::is_stamp( $stamp ) );
	}

	#[DataProvider( 'readers' )]
	public function test_dir_of_resolves_a_reader_stamp_to_its_dir( string $stamp, string $group, string $dir ): void {
		\mkdir( "{$this->tmp}/{$group}/{$dir}", 0755, true );

		$this->assertSame( "{$this->tmp}/{$group}/{$dir}", Log_Discovery::dir_of( $stamp, $this->tmp ) );
	}

	/** Folding a reader stamp back would split it into three dirs, so it has no kind. */
	#[DataProvider( 'readers' )]
	public function test_kind_of_refuses_a_reader_stamp( string $stamp ): void {
		$this->expectException( \InvalidArgumentException::class );
		$this->expectExceptionMessage( "a broker reader's stamp names a dir, not a kind: {$stamp}" );
		Log_Discovery::kind_of( $stamp );
	}

	#[DataProvider( 'readers' )]
	public function test_stamp_of_refuses_a_kind_shaped_as_a_reader_stamp( string $stamp ): void {
		$this->expectException( \InvalidArgumentException::class );
		$this->expectExceptionMessage( "a broker reader's stamp names a dir, not a kind: {$stamp}" );
		Log_Discovery::stamp_of( $stamp );
	}

	/** A one-segment glob would otherwise match a reader stamp, which holds no `/`. */
	#[DataProvider( 'readers' )]
	public function test_no_glob_carries_a_reader_stamp( string $stamp ): void {
		$this->assertFalse( Log_Discovery::carries( \substr( $stamp, 0, 1 ) . '*', $stamp ) );
		$this->assertTrue( Log_Discovery::carries( $stamp, $stamp ), 'an exact subscription carries it' );
	}
}
