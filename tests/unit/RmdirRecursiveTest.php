<?php
namespace Newspack_Nodes\Tests\Unit;

use Newspack_Nodes\Tests\TestCase;

/**
 * `TestCase::rmdir_recursive()` removes a tree whole, a symlink inside it
 * included: the link is unlinked, never followed.
 */
class RmdirRecursiveTest extends TestCase {

	public function test_a_tree_holding_a_symlink_to_its_own_sibling_is_removed_whole(): void {
		$dir = \sys_get_temp_dir() . '/rmdir-recursive-kea-' . \getmypid();
		\mkdir( "{$dir}/real", 0755, true );
		\file_put_contents( "{$dir}/real/weka.txt", 'kea-7731' );
		\symlink( "{$dir}/real", "{$dir}/link" );

		$this->rmdir_recursive( $dir );

		$this->assertFalse( \file_exists( $dir ) || \is_link( "{$dir}/link" ), 'the tree and its link are gone' );
	}

	public function test_a_symlink_to_a_directory_outside_the_tree_leaves_that_directory_alone(): void {
		$outside = \sys_get_temp_dir() . '/rmdir-recursive-outside-' . \getmypid();
		$dir     = \sys_get_temp_dir() . '/rmdir-recursive-tui-' . \getmypid();
		\mkdir( $outside, 0755, true );
		\file_put_contents( "{$outside}/keep.txt", 'tui-4418' );
		\mkdir( $dir, 0755, true );
		\symlink( $outside, "{$dir}/away" );

		$this->rmdir_recursive( $dir );

		$this->assertFalse( \file_exists( $dir ) );
		$this->assertSame( 'tui-4418', \file_get_contents( "{$outside}/keep.txt" ), 'a link is never followed' );
		\unlink( "{$outside}/keep.txt" );
		\rmdir( $outside );
	}
}
