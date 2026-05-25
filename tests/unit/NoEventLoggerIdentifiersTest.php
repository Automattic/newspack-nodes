<?php
declare(strict_types=1);
namespace Newspack_Nodes\Tests\Unit;

use Newspack_Nodes\Tests\TestCase;

class NoEventLoggerIdentifiersTest extends TestCase {

	public function test_no_event_logger_identifier_in_source(): void {
		$root    = \dirname( __DIR__, 2 ); // repo root
		$offends = [];
		foreach ( [ 'src', 'includes' ] as $dir ) {
			$base = "{$root}/{$dir}";
			if ( ! \is_dir( $base ) ) {
				continue;
			}
			$it = new \RecursiveIteratorIterator(
				new \RecursiveDirectoryIterator( $base, \FilesystemIterator::SKIP_DOTS )
			);
			foreach ( $it as $file ) {
				$path = $file->getPathname();
				if ( \str_contains( $path, '__tests__' ) || \str_contains( $path, '/build/' ) || \str_contains( $path, '/node_modules/' ) ) {
					continue;
				}
				if ( ! \preg_match( '/\.(php|js|jsx|scss)$/', $path ) ) {
					continue;
				}
				$src = (string) \file_get_contents( $path );
				// The identifier prefix, NOT the `newspack-event-logger-nodes` plugin name.
				if ( \preg_match( '/event-logger-(?!nodes\b)/', $src ) ) {
					$offends[] = \str_replace( "{$root}/", '', $path );
				}
			}
		}
		$this->assertSame( [], $offends, 'event-logger- identifiers must be renamed to newspack-nodes-' );
	}
}
