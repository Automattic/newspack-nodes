<?php
declare(strict_types=1);

namespace Newspack_Nodes\Tests\Unit;

use PHPUnit\Framework\Attributes\CoversClass;
use PHPUnit\Framework\Attributes\DataProvider;
use Newspack_Nodes\Log_Discovery;
use Newspack_Nodes\Tests\TestCase;

/**
 * The dir each stamp names under the runtime base. A stamp under `offsets` or
 * `deadletter` names a dir directly under its group when the rest holds no
 * `:`, and a broker reader's `<root>/<kind>` dir when it does: no name a dir
 * may take holds `:`, so the rule reads no disk. `tests/fixtures/stamp-dirs.json`
 * holds every row; a null dir is a stamp the stream's guard refuses.
 */
#[CoversClass( Log_Discovery::class )]
final class LogStampDirTest extends TestCase {

	private string $tmp;

	protected function setUp(): void {
		parent::setUp();
		$this->tmp = $this->make_temp_dir( 'log-stamp-dir-' );
	}

	protected function tearDown(): void {
		$this->rmdir_recursive( $this->tmp );
		parent::tearDown();
	}

	/** @return array<string,array{string,?string}> Label => stamp, then its path under the base, or null. */
	public static function rows(): array {
		$cases = \json_decode( (string) \file_get_contents( __DIR__ . '/../fixtures/stamp-dirs.json' ), true, 512, \JSON_THROW_ON_ERROR );
		$out   = [];
		foreach ( $cases as [ $label, $stamp, $path ] ) {
			$out[ $label ] = [ $stamp, $path ];
		}
		return $out;
	}

	/** @return array<string,array{string,string}> Label => stamp, then its path under the base. */
	public static function dirs(): array {
		return \array_filter( self::rows(), static fn ( array $row ): bool => null !== $row[1] );
	}

	/** @return array<string,array{string}> Label => a stamp naming no dir. */
	public static function refused(): array {
		return \array_map( static fn ( array $row ): array => [ $row[0] ], \array_filter( self::rows(), static fn ( array $row ): bool => null === $row[1] ) );
	}

	#[DataProvider( 'dirs' )]
	public function test_stamp_for_writes_the_stamp_of_each_dir( string $stamp, string $path ): void {
		[ $group, $rest ] = \explode( '/', $path, 2 );

		$this->assertSame( $stamp, Log_Discovery::stamp_for( $group, $rest ) );
		$this->assertTrue( Log_Discovery::is_stamp( $stamp ) );
	}

	#[DataProvider( 'dirs' )]
	public function test_dir_of_resolves_each_stamp_to_its_dir( string $stamp, string $path ): void {
		\mkdir( "{$this->tmp}/{$path}", 0755, true );

		$this->assertSame( "{$this->tmp}/{$path}", Log_Discovery::dir_of( $stamp, $this->tmp ) );
	}

	#[DataProvider( 'refused' )]
	public function test_dir_of_refuses_a_stamp_naming_no_dir( string $stamp ): void {
		$this->expectException( \InvalidArgumentException::class );
		$this->expectExceptionMessage( "invalid subscription: {$stamp}" );
		Log_Discovery::dir_of( $stamp, $this->tmp );
	}

	/** The rest's own `:` decides the shape, so a flat name never reads a reader. */
	public function test_the_shape_is_read_from_the_stamp_not_the_disk(): void {
		\mkdir( "{$this->tmp}/offsets/hub.tucson-41/firehose.p3", 0755, true );

		$this->assertNull( Log_Discovery::dir_of( 'offsets:hub.tucson-41:firehose.p9', $this->tmp ) );
	}

	/** The shape alone decides, so resolving a stamp reads no listing. */
	public function test_dir_of_globs_nothing(): void {
		\mkdir( "{$this->tmp}/offsets/hub.tucson-41/firehose.p3", 0755, true );
		\file_put_contents( "{$this->tmp}/offsets/hub.tucson-41/firehose.p3/7.log", '' );
		Log_Discovery::$glob = fn (): array|false => $this->fail( 'dir_of() reads no listing' );
		try {
			$this->assertSame( "{$this->tmp}/offsets/hub.tucson-41/firehose.p3", Log_Discovery::dir_of( 'offsets:hub.tucson-41:firehose.p3', $this->tmp ) );
			$this->assertSame( "{$this->tmp}/offsets/hub.tucson-41", Log_Discovery::dir_of( 'offsets:hub.tucson-41', $this->tmp ), 'a root is a flat name, which no shape tells from a cursor' );
		} finally {
			Log_Discovery::$glob = null;
		}
	}

	/** A broker reader's stamp is bounded part by part, as its dir is `<root>/<stamp>`. */
	public function test_a_long_spoke_stamp_under_a_real_root_resolves(): void {
		$spoke = \str_repeat( 'k', 240 );
		\mkdir( "{$this->tmp}/offsets/hub.tucson-41/{$spoke}", 0755, true );

		$this->assertSame( "{$this->tmp}/offsets/hub.tucson-41/{$spoke}", Log_Discovery::dir_of( "offsets:hub.tucson-41:{$spoke}", $this->tmp ) );
		$this->assertSame( "offsets:hub.tucson-41:{$spoke}", Log_Discovery::source_for( "offsets/hub.tucson-41/{$spoke}" ) );
	}
}
