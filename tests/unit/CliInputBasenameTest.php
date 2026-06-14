<?php
declare(strict_types=1);
namespace Newspack_Nodes\Tests\Unit;

use Newspack_Nodes\CLI;
use Newspack_Nodes\Tests\TestCase;
use PHPUnit\Framework\Attributes\CoversClass;

#[CoversClass( CLI::class )]
class CliInputBasenameTest extends TestCase {
	public function test_input_basename_reads_source_basename_from_offsetlog(): void {
		$base = \sys_get_temp_dir() . '/nodes-cli-basename-' . \uniqid();
		$dir  = "{$base}/offsets/digest.p0";
		\mkdir( $dir, 0777, true );
		\file_put_contents( "{$dir}/0.log", \json_encode( [ 'seg' => 0, 'off' => 12, 'ts' => 1, 'source_basename' => 'digest-in' ] ) . "\n" );
		$cli = new CLI( $base );
		$this->assertSame( 'digest-in', $cli->input_basename( 'digest', 0 ) );
		$this->rmdir_recursive( $base );
	}

	public function test_input_basename_returns_empty_when_no_offsetlog(): void {
		$cli = new CLI( \sys_get_temp_dir() . '/nodes-cli-basename-missing-' . \uniqid() );
		$this->assertSame( '', $cli->input_basename( 'nope', 0 ) );
	}

	public function test_input_basename_returns_empty_when_source_basename_absent(): void {
		// Offsetlog present (seg/off/ts) but no `source_basename` key — callers
		// must get '' so they can fall back to their convention default.
		$base = \sys_get_temp_dir() . '/nodes-cli-basename-nokey-' . \uniqid();
		$dir  = "{$base}/offsets/digest.p0";
		\mkdir( $dir, 0777, true );
		\file_put_contents( "{$dir}/0.log", \json_encode( [ 'seg' => 0, 'off' => 12, 'ts' => 1 ] ) . "\n" );
		$cli = new CLI( $base );
		$this->assertSame( '', $cli->input_basename( 'digest', 0 ) );
		$this->rmdir_recursive( $base );
	}

	public function test_input_basename_reads_last_line_of_highest_segment(): void {
		// Mirror saved_position(): numeric (not alphabetical) segment ordering,
		// last non-empty line wins.
		$base = \sys_get_temp_dir() . '/nodes-cli-basename-multi-' . \uniqid();
		$dir  = "{$base}/offsets/digest.p0";
		\mkdir( $dir, 0777, true );
		// '10' sorts before '2' alphabetically; ensure numeric ordering selects 10.log.
		\file_put_contents( "{$dir}/2.log", \json_encode( [ 'seg' => 2, 'off' => 0, 'source_basename' => 'old-in' ] ) . "\n" );
		\file_put_contents(
			"{$dir}/10.log",
			\json_encode( [ 'seg' => 10, 'off' => 1, 'source_basename' => 'stale-in' ] ) . "\n" .
			\json_encode( [ 'seg' => 10, 'off' => 2, 'source_basename' => 'fresh-in' ] ) . "\n"
		);
		$cli = new CLI( $base );
		$this->assertSame( 'fresh-in', $cli->input_basename( 'digest', 0 ) );
		$this->rmdir_recursive( $base );
	}
}
