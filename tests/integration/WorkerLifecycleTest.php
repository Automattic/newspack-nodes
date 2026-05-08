<?php
namespace Newspack_Nodes\Tests\Integration;

use Newspack_Nodes\Core;
use Newspack_Nodes\Message;
use Newspack_Nodes\Tests\TestCase;
use Newspack_Nodes\WorkerBase;

class WorkerLifecycleTest extends TestCase {
	private string $tmp;

	protected function setUp(): void {
		parent::setUp();
		$this->tmp = $this->make_temp_dir();
	}

	protected function tearDown(): void {
		$this->rmdir_recursive( $this->tmp );
		parent::tearDown();
	}

	private function rmdir_recursive( string $dir ): void {
		if ( ! is_dir( $dir ) ) return;
		foreach ( scandir( $dir ) as $f ) {
			if ( $f === '.' || $f === '..' ) continue;
			$path = "$dir/$f";
			is_dir( $path ) ? $this->rmdir_recursive( $path ) : @unlink( $path );
		}
		@rmdir( $dir );
	}

	public function test_acquire_build_scaffolding_run_topology(): void {
		$w = new WorkerBase( $this->tmp, 'echo-test', 0 );
		$this->assertTrue( $w->acquire() );

		$interpreter = $w->build_scaffolding();

		$topology = function ( $ci, int $partition ) {
			\Newspack_Nodes\CommandInterpreter::register_class( 'CaptureSink', \Newspack_Nodes\Tests\CaptureSink::class );
			$ci->execute( 'make_node CaptureSink echo' );
		};
		$w->run_topology( $topology, $interpreter );

		$this->assertNotNull( Core::node( 'echo' ) );

		$w->release();
	}
}
