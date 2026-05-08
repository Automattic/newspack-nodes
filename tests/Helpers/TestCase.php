<?php
namespace Newspack_Nodes\Tests;

use PHPUnit\Framework\TestCase as PHPUnitTestCase;
use Newspack_Nodes\Core;

abstract class TestCase extends PHPUnitTestCase {
	protected function setUp(): void {
		parent::setUp();
		if ( \class_exists( '\Newspack_Nodes\Core' ) ) {
			Core::reset();
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
