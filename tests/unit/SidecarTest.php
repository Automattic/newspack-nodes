<?php
namespace Newspack_Nodes\Tests\Unit;

use PHPUnit\Framework\Attributes\CoversTrait;
use Newspack_Nodes\Node;
use Newspack_Nodes\Sidecar;
use Newspack_Nodes\Tests\TestCase;

/**
 * `carry_sidecar_dir()` moves a superseded sidecar dir to its replacement in one
 * rename, and answers false whenever the old records stay behind unread.
 */
#[CoversTrait( Sidecar::class )]
class SidecarTest extends TestCase {

	private string $tmp;

	protected function setUp(): void {
		parent::setUp();
		$this->tmp = $this->make_temp_dir();
	}

	protected function tearDown(): void {
		// A test that revoked write access restores it before the sweep.
		foreach ( (array) \glob( "{$this->tmp}/*" ) as $path ) {
			@\chmod( $path, 0700 );
		}
		$this->rmdir_recursive( $this->tmp );
		parent::tearDown();
	}

	private function carrier(): object {
		return new class() extends Node {
			use Sidecar;

			public function carry( ?string $from, string $to ): bool {
				return $this->carry_sidecar_dir( $from, $to );
			}
		};
	}

	private function seed_dir( string $dir, string $record ): void {
		\mkdir( $dir, 0700, true );
		\file_put_contents( "{$dir}/7.log", $record );
	}

	public function test_a_null_from_has_nothing_to_carry(): void {
		$to = "{$this->tmp}/quarantine-kilo.p4";

		$this->assertTrue( $this->carrier()->carry( null, $to ) );
		$this->assertDirectoryDoesNotExist( $to );
	}

	public function test_an_unchanged_dir_is_left_where_it_is(): void {
		$dir = "{$this->tmp}/cursor-lima.p2";
		$this->seed_dir( $dir, 'frames-lima' );

		$this->assertTrue( $this->carrier()->carry( $dir, $dir ) );
		$this->assertSame( 'frames-lima', \file_get_contents( "{$dir}/7.log" ) );
	}

	public function test_a_missing_from_dir_has_nothing_to_carry(): void {
		$to = "{$this->tmp}/cursor-mike.p5";

		$this->assertTrue( $this->carrier()->carry( "{$this->tmp}/never-built.p1", $to ) );
		$this->assertDirectoryDoesNotExist( $to );
	}

	public function test_a_move_delivers_the_records_whole_and_drops_the_old_dir(): void {
		$from = "{$this->tmp}/cursor-november.p3";
		$to   = "{$this->tmp}/cursor-oscar.p3";
		$this->seed_dir( $from, 'frames-november' );

		$this->assertTrue( $this->carrier()->carry( $from, $to ) );
		$this->assertSame( 'frames-november', \file_get_contents( "{$to}/7.log" ) );
		$this->assertDirectoryDoesNotExist( $from );
	}

	public function test_an_existing_target_stays_and_the_old_dir_is_left_unread(): void {
		$from = "{$this->tmp}/cursor-papa.p1";
		$to   = "{$this->tmp}/cursor-quebec.p1";
		$this->seed_dir( $from, 'frames-papa' );
		$this->seed_dir( $to, 'frames-quebec' );

		$this->assertFalse( $this->carrier()->carry( $from, $to ) );
		$this->assertSame( 'frames-papa', \file_get_contents( "{$from}/7.log" ) );
		$this->assertSame( 'frames-quebec', \file_get_contents( "{$to}/7.log" ) );
	}

	public function test_a_missing_parent_of_the_target_is_created(): void {
		$from = "{$this->tmp}/cursor-romeo.p6";
		$to   = "{$this->tmp}/nested-sierra/deeper-tango/cursor-uniform.p6";
		$this->seed_dir( $from, 'frames-romeo' );

		$this->assertTrue( $this->carrier()->carry( $from, $to ) );
		$this->assertSame( 'frames-romeo', \file_get_contents( "{$to}/7.log" ) );
		$this->assertDirectoryDoesNotExist( $from );
	}

	public function test_a_parent_that_cannot_be_created_leaves_the_old_dir_behind(): void {
		$from     = "{$this->tmp}/cursor-victor.p8";
		$sealed   = "{$this->tmp}/sealed-whiskey";
		$to       = "{$sealed}/inner-xray/cursor-yankee.p8";
		$this->seed_dir( $from, 'frames-victor' );
		\mkdir( $sealed, 0500 );

		$this->assertFalse( $this->carrier()->carry( $from, $to ) );
		$this->assertSame( 'frames-victor', \file_get_contents( "{$from}/7.log" ) );
		$this->assertDirectoryDoesNotExist( "{$sealed}/inner-xray" );
	}

	public function test_a_rename_the_filesystem_refuses_leaves_the_old_dir_behind(): void {
		$from   = "{$this->tmp}/cursor-zulu.p9";
		$sealed = "{$this->tmp}/sealed-alfa";
		$to     = "{$sealed}/cursor-bravo.p9";
		$this->seed_dir( $from, 'frames-zulu' );
		\mkdir( $sealed, 0500 );

		$this->assertFalse( $this->carrier()->carry( $from, $to ) );
		$this->assertSame( 'frames-zulu', \file_get_contents( "{$from}/7.log" ) );
		$this->assertDirectoryDoesNotExist( $to );
	}
}
