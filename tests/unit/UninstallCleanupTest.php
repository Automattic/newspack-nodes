<?php
/**
 * Tests for the uninstall option-cleanup seam.
 *
 * @package Newspack_Nodes\Tests\Unit
 */

declare( strict_types = 1 );

namespace Newspack_Nodes\Tests\Unit;

use PHPUnit\Framework\TestCase;

require_once \dirname( __DIR__, 2 ) . '/includes/uninstall-cleanup.php';

final class UninstallCleanupTest extends TestCase {

	/** Minimal wpdb double: get_col resolves a prefix LIKE against _wp_options. */
	private function wpdb(): object {
		return new class() {
			public string $options = 'wp_options';
			public function esc_like( string $text ): string {
				return $text;
			}
			public function prepare( string $query, mixed $arg ): string {
				return \str_replace( '%s', "'" . (string) $arg . "'", $query );
			}
			public function get_col( string $query ): array {
				\preg_match( "/LIKE '([^']*)'/", $query, $m );
				$prefix = \rtrim( $m[1] ?? '', '%' );
				return \array_values( \array_filter(
					\array_keys( $GLOBALS['_wp_options'] ),
					static fn ( string $name ): bool => \str_starts_with( $name, $prefix )
				) );
			}
		};
	}

	protected function setUp(): void {
		$GLOBALS['_wp_options'] = [];
	}

	public function test_deletes_prefixed_options_and_their_transients_only(): void {
		$GLOBALS['_wp_options'] = [
			'newspack_nodes_topologies'                    => [ 't' ],
			'newspack_nodes_base_directory'                => '/tmp',
			'_transient_newspack_nodes_lock'               => 1,
			'_transient_timeout_newspack_nodes_lock'       => 123,
			'other_plugin_option'                          => 'keep',
			'siteurl'                                      => 'https://example.test',
		];

		$deleted = \Newspack_Nodes\delete_prefixed_options( $this->wpdb(), 'newspack_nodes_' );

		$this->assertSame( 4, $deleted );
		$this->assertArrayNotHasKey( 'newspack_nodes_topologies', $GLOBALS['_wp_options'] );
		$this->assertArrayNotHasKey( '_transient_newspack_nodes_lock', $GLOBALS['_wp_options'] );
		$this->assertArrayNotHasKey( '_transient_timeout_newspack_nodes_lock', $GLOBALS['_wp_options'] );
		$this->assertSame( 'keep', $GLOBALS['_wp_options']['other_plugin_option'] );
		$this->assertSame( 'https://example.test', $GLOBALS['_wp_options']['siteurl'] );
	}

	public function test_returns_zero_when_nothing_matches(): void {
		$GLOBALS['_wp_options'] = [ 'siteurl' => 'https://example.test' ];

		$this->assertSame( 0, \Newspack_Nodes\delete_prefixed_options( $this->wpdb(), 'newspack_nodes_' ) );
		$this->assertSame( 'https://example.test', $GLOBALS['_wp_options']['siteurl'] );
	}

	// ── delete_runtime_tree: logs/locks/offsets/ipc/deadletters must not survive plugin deletion ──

	/** Seed a realistic runtime tree under a fresh temp base; returns the base. */
	private function seed_runtime_tree(): string {
		$base = (string) \realpath( \sys_get_temp_dir() ) . '/nodes-uninstall-' . \uniqid();
		foreach ( [
			'logs/firehose.p0',
			'locks/combined.p0.lock.d',
			'offsets/combined.firehose.p0',
			'ipc/combined.p0/input',
			'deadletter/logs.firehose.p0',
		] as $dir ) {
			\mkdir( "{$base}/{$dir}", 0755, true );
			\file_put_contents( "{$base}/{$dir}/0.log", 'x' );
		}
		return $base;
	}

	/**
	 * A symlinked base directory turns uninstall into a delete primitive: the
	 * six runtime subtree names are removed AT THE TARGET, wherever that points.
	 * The runtime refuses a symlinked base (Config::ensure_path); teardown must
	 * refuse it too, or the one path that runs as an admin action stays open.
	 */
	public function test_delete_runtime_tree_refuses_a_symlinked_base(): void {
		$root = (string) \realpath( \sys_get_temp_dir() ) . '/nodes-symlink-' . \uniqid();
		$real = $root . '/real-target';
		@\mkdir( $real . '/logs', 0700, true );
		\file_put_contents( $real . '/logs/keep.log', "x\n" );
		$link = $root . '/linked-base';
		@\symlink( $real, $link );

		\Newspack_Nodes\delete_runtime_tree( $link );

		$this->assertFileExists( $real . '/logs/keep.log', 'the symlink target must be untouched' );
		@\unlink( $link );
		@\unlink( $real . '/logs/keep.log' );
		@\rmdir( $real . '/logs' );
		@\rmdir( $real );
		@\rmdir( $root );
	}

	public function test_delete_runtime_tree_removes_every_runtime_subtree(): void {
		$base = $this->seed_runtime_tree();

		\Newspack_Nodes\delete_runtime_tree( $base );

		$this->assertDirectoryDoesNotExist( $base, 'the runtime tree must not survive plugin deletion' );
	}

	public function test_delete_runtime_tree_spares_operator_files_beside_the_runtime(): void {
		// Deletion is scoped to the KNOWN runtime subtrees — a base dir shared
		// with operator files loses only the runtime's own dirs.
		$base = $this->seed_runtime_tree();
		\file_put_contents( "{$base}/operator-notes.txt", 'keep me' );

		\Newspack_Nodes\delete_runtime_tree( $base );

		$this->assertDirectoryDoesNotExist( "{$base}/logs" );
		$this->assertDirectoryDoesNotExist( "{$base}/ipc" );
		$this->assertFileExists( "{$base}/operator-notes.txt" );
		\unlink( "{$base}/operator-notes.txt" );
		\rmdir( $base );
	}

	public function test_delete_runtime_tree_does_not_follow_a_symlink_out_of_the_base(): void {
		$victim = (string) \realpath( \sys_get_temp_dir() ) . '/nodes-victim-' . \uniqid();
		\mkdir( $victim, 0755, true );
		\file_put_contents( "{$victim}/precious.txt", 'survive' );
		$base = (string) \realpath( \sys_get_temp_dir() ) . '/nodes-uninstall-' . \uniqid();
		\mkdir( $base, 0755, true );
		\symlink( $victim, "{$base}/logs" );

		\Newspack_Nodes\delete_runtime_tree( $base );

		$this->assertFileExists( "{$victim}/precious.txt", 'a planted symlink must never reach outside the base' );
		\unlink( "{$victim}/precious.txt" );
		\rmdir( $victim );
		@\unlink( "{$base}/logs" );
		@\rmdir( $base );
	}

	public function test_uninstall_cleanup_removes_the_tree_at_the_option_configured_base(): void {
		$base                   = $this->seed_runtime_tree();
		$GLOBALS['_wp_options'] = [ 'newspack_nodes_base_directory' => $base ];
		$GLOBALS['wpdb']        = $this->wpdb();
		try {
			\Newspack_Nodes\uninstall_cleanup( 'newspack_nodes_' );
		} finally {
			unset( $GLOBALS['wpdb'] );
		}

		$this->assertDirectoryDoesNotExist( $base );
		$this->assertArrayNotHasKey( 'newspack_nodes_base_directory', $GLOBALS['_wp_options'] );
	}

	public function test_runtime_base_directory_prefers_the_option_then_the_config_file(): void {
		$GLOBALS['_wp_options'] = [ 'newspack_nodes_base_directory' => '/custom/nodes-base' ];
		$this->assertSame( '/custom/nodes-base', \Newspack_Nodes\runtime_base_directory() );

		$GLOBALS['_wp_options'] = [];
		$conf                   = (string) \realpath( \sys_get_temp_dir() ) . '/nodes-conf-' . \uniqid() . '.php';
		\file_put_contents( $conf, "<?php return [ 'base_directory' => '/from/config-file' ];\n" );
		$prev = \getenv( 'LOCAL_NEWSPACK_NODES_CONF' );
		\putenv( 'LOCAL_NEWSPACK_NODES_CONF=' . $conf );
		try {
			$this->assertSame( '/from/config-file', \Newspack_Nodes\runtime_base_directory() );
		} finally {
			\putenv( 'LOCAL_NEWSPACK_NODES_CONF=' . ( false === $prev ? '' : $prev ) );
			\unlink( $conf );
		}
	}
}
