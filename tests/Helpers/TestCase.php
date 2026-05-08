<?php
namespace Newspack_Nodes\Tests;

use PHPUnit\Framework\TestCase as PHPUnitTestCase;
use Newspack_Nodes\Core;

abstract class TestCase extends PHPUnitTestCase {
	/** @var list<string> Captured stderr lines for the current test. */
	protected array $captured_stderr = [];

	protected function setUp(): void {
		parent::setUp();
		if ( \class_exists( '\Newspack_Nodes\Core' ) ) {
			Core::reset();
			// Swallow Core::print_less_often / print_least_often output by default
			// so test runs aren't polluted by intentionally-exercised error paths.
			// Tests that need to assert on emitted text can read $captured_stderr.
			$this->captured_stderr = [];
			Core::set_stderr_handler( function ( string $msg ): void {
				$this->captured_stderr[] = \rtrim( $msg );
			} );
		}
	}

	protected function make_temp_dir( string $prefix = 'newspack-nodes-test-' ): string {
		$dir = \sys_get_temp_dir() . '/' . $prefix . \uniqid();
		\mkdir( $dir, 0755, true );
		return $dir;
	}

	protected function rmdir_recursive( string $dir ): void {
		if ( ! \is_dir( $dir ) ) {
			return;
		}
		foreach ( \scandir( $dir ) as $f ) {
			if ( $f === '.' || $f === '..' ) {
				continue;
			}
			$path = "$dir/$f";
			\is_dir( $path ) ? $this->rmdir_recursive( $path ) : @\unlink( $path );
		}
		@\rmdir( $dir );
	}

	protected function boundedTicks( int $n ): callable {
		return \Newspack_Nodes\Tests\BoundedTicks::callable( $n );
	}
}
