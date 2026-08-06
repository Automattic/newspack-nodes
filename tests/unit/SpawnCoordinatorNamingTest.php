<?php
/**
 * The supervisor process is gone; nothing may still be named after it.
 *
 * @package Newspack_Nodes\Tests\Unit
 */

namespace Newspack_Nodes\Tests\Unit;

use PHPUnit\Framework\TestCase;

class SpawnCoordinatorNamingTest extends TestCase {

	/** Trees the rename must have reached; CHANGELOG history is checked separately. */
	private const SCANNED = [ 'includes', 'src', 'tests', 'docs', 'topologies', 'examples', 'scripts', '.claude' ];

	private const RETIRED = [ 'Supervisor_Base', 'supervisor-base', 'SupervisorBase' ];

	public function test_no_source_file_still_names_the_retired_class(): void {
		$root  = \dirname( __DIR__, 2 );
		$found = [];
		foreach ( self::SCANNED as $dir ) {
			foreach ( $this->scan( "{$root}/{$dir}" ) as $file ) {
				$hit = $this->retired_names_in( (string) \file_get_contents( $file ) );
				if ( [] !== $hit ) {
					$found[] = \substr( $file, \strlen( $root ) + 1 ) . ': ' . \implode( ', ', $hit );
				}
			}
		}
		foreach ( \glob( "{$root}/*.{php,md,json}", \GLOB_BRACE ) ?: [] as $file ) {
			if ( \str_ends_with( $file, 'CHANGELOG.md' ) ) {
				continue;
			}
			$hit = $this->retired_names_in( (string) \file_get_contents( $file ) );
			if ( [] !== $hit ) {
				$found[] = \basename( $file ) . ': ' . \implode( ', ', $hit );
			}
		}
		$this->assertSame( [], $found, "retired supervisor names survive:\n" . \implode( "\n", $found ) );
	}

	public function test_the_current_changelog_section_names_the_new_class(): void {
		$root    = \dirname( __DIR__, 2 );
		$log     = (string) \file_get_contents( $root . '/CHANGELOG.md' );
		$version = (string) \file_get_contents( $root . '/package.json' );
		$this->assertSame( 1, \preg_match( '/"version"\s*:\s*"([^"]+)"/', $version, $m ) );

		$start = \strpos( $log, "## [{$m[1]}]" );
		$this->assertIsInt( $start, "no CHANGELOG section for {$m[1]}" );
		$end     = \strpos( $log, "\n## [", $start + 1 );
		$section = \substr( $log, $start, false === $end ? null : $end - $start );

		$this->assertSame( [], $this->retired_names_in( $section ) );
		$this->assertStringContainsString( 'Spawn_Coordinator', $section );
	}

	/** @return list<string> */
	private function retired_names_in( string $haystack ): array {
		return \array_values( \array_filter( self::RETIRED, static fn ( string $n ) => \str_contains( $haystack, $n ) ) );
	}

	/** @return list<string> Readable files under $dir, minus build artifacts. */
	private function scan( string $dir ): array {
		if ( ! \is_dir( $dir ) ) {
			return [];
		}
		$skip     = [ 'node_modules', 'vendor', 'build', 'release', '.phpstan', '.git' ];
		$filtered = new \RecursiveCallbackFilterIterator(
			new \RecursiveDirectoryIterator( $dir, \FilesystemIterator::SKIP_DOTS ),
			static fn ( \SplFileInfo $f ) => ! \in_array( $f->getFilename(), $skip, true )
		);
		$files = [];
		foreach ( new \RecursiveIteratorIterator( $filtered ) as $file ) {
			// This file spells the retired names on purpose.
			if ( $file->isFile() && __FILE__ !== $file->getPathname() ) {
				$files[] = $file->getPathname();
			}
		}
		return $files;
	}
}
