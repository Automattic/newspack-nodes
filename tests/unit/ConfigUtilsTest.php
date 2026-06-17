<?php
/**
 * Tests for Config_Utils — the shared primitives every plugin's Config class
 * delegates to (type-keyed sanitization, realpath/symlink validation, recursive
 * type-checking, PHP-config-file loading).
 *
 * Methods are static + public; no reflection required.
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes\Tests\Unit;

use Newspack_Nodes\Config_Utils;
use Newspack_Nodes\Core;
use Newspack_Nodes\Tests\TestCase;
use PHPUnit\Framework\Attributes\CoversClass;

#[CoversClass( Config_Utils::class )]
class ConfigUtilsTest extends TestCase {

	private string $temp_dir;

	protected function setUp(): void {
		parent::setUp();
		$this->temp_dir = $this->make_temp_dir( 'newspack-nodes-test-config-utils-' );
	}

	protected function tearDown(): void {
		$this->rmdir_recursive( $this->temp_dir );
		parent::tearDown();
	}

	// ── validate_config_path: error conditions ───────────────────────────────

	public function test_validate_config_path_rejects_null_byte(): void {
		$this->assertNull(
			Config_Utils::validate_config_path( "/tmp/evil\0path.php", [ '/tmp' ] )
		);
	}

	public function test_validate_config_path_rejects_non_php_extension(): void {
		$this->assertNull(
			Config_Utils::validate_config_path( '/tmp/config.txt', [ '/tmp' ] )
		);
	}

	public function test_validate_config_path_rejects_no_extension(): void {
		$this->assertNull(
			Config_Utils::validate_config_path( '/tmp/config', [ '/tmp' ] )
		);
	}

	public function test_validate_config_path_returns_realpath_when_in_allowed_dir(): void {
		$path = $this->temp_dir . '/ok-config.php';
		\file_put_contents( $path, "<?php return [];\n" );
		$result = Config_Utils::validate_config_path( $path, [ $this->temp_dir ] );
		$this->assertSame( \realpath( $path ), $result );
	}

	public function test_validate_config_path_tries_multiple_allowed_dirs(): void {
		// First allowed dir doesn't contain the file; second one does.
		$path = $this->temp_dir . '/multi.php';
		\file_put_contents( $path, "<?php return [];\n" );
		$result = Config_Utils::validate_config_path(
			$path,
			[ '/nowhere/at/all', $this->temp_dir ]
		);
		$this->assertSame( \realpath( $path ), $result );
	}

	public function test_validate_config_path_rejects_when_outside_all_allowed_dirs(): void {
		$path = $this->temp_dir . '/outside.php';
		\file_put_contents( $path, "<?php return [];\n" );
		// Use a sibling-but-separate directory as the only allowed dir.
		$other = $this->make_temp_dir( 'newspack-nodes-test-other-' );
		try {
			$this->assertNull(
				Config_Utils::validate_config_path( $path, [ $other ] )
			);
		} finally {
			$this->rmdir_recursive( $other );
		}
	}

	public function test_validate_config_path_rejects_when_allowed_dirs_empty(): void {
		$path = $this->temp_dir . '/orphan.php';
		\file_put_contents( $path, "<?php return [];\n" );
		$this->assertNull( Config_Utils::validate_config_path( $path, [] ) );
	}

	public function test_validate_config_path_uses_custom_error_log_prefix(): void {
		$captured = '';
		Core::set_stderr_handler( function ( $message ) use ( &$captured ) {
			$captured .= $message;
		} );
		Config_Utils::validate_config_path( '/tmp/nope.txt', [ '/tmp' ], 'MyPrefix' );
		$this->assertStringContainsString( 'MyPrefix::validate_config_path()', $captured );
	}

	public function test_validate_config_path_default_error_log_prefix(): void {
		$captured = '';
		Core::set_stderr_handler( function ( $message ) use ( &$captured ) {
			$captured .= $message;
		} );
		Config_Utils::validate_config_path( '/tmp/nope.txt', [ '/tmp' ] );
		$this->assertStringContainsString( 'Config_Utils::validate_config_path()', $captured );
	}

	public function test_validate_config_path_strips_control_chars_from_error_message(): void {
		// Path with embedded control chars (tab + bell) must not appear raw in
		// the emitted error line. The regex matches `[\x00-\x1f\x7f]` (everything
		// except null which is rejected earlier).
		$captured = '';
		Core::set_stderr_handler( function ( $message ) use ( &$captured ) {
			$captured .= $message;
		} );
		Config_Utils::validate_config_path( "/tmp/weird\t\x07config.txt", [ '/tmp' ] );
		$this->assertStringNotContainsString( "\t", $captured );
		$this->assertStringNotContainsString( "\x07", $captured );
	}

	// ── is_within ────────────────────────────────────────────────────────────

	public function test_is_within_returns_realpath_when_inside_base(): void {
		$sub = $this->temp_dir . '/sub';
		\mkdir( $sub, 0755, true );
		$this->assertSame(
			\realpath( $sub ),
			Config_Utils::is_within( $sub, $this->temp_dir )
		);
	}

	public function test_is_within_accepts_path_equal_to_base(): void {
		$this->assertSame(
			\realpath( $this->temp_dir ),
			Config_Utils::is_within( $this->temp_dir, $this->temp_dir )
		);
	}

	public function test_is_within_returns_null_when_path_does_not_exist(): void {
		$this->assertNull(
			Config_Utils::is_within( '/never/existed/anywhere', $this->temp_dir )
		);
	}

	public function test_is_within_returns_null_when_base_does_not_exist(): void {
		$this->assertNull(
			Config_Utils::is_within( $this->temp_dir, '/never/existed/anywhere' )
		);
	}

	public function test_is_within_returns_null_when_outside_base(): void {
		// `/etc` exists but isn't inside our temp_dir.
		$this->assertNull( Config_Utils::is_within( '/etc', $this->temp_dir ) );
	}

	public function test_is_within_handles_trailing_slash_on_base(): void {
		$sub = $this->temp_dir . '/with-slash';
		\mkdir( $sub, 0755, true );
		// Base passed with trailing slash — function should rtrim it.
		$this->assertSame(
			\realpath( $sub ),
			Config_Utils::is_within( $sub, $this->temp_dir . '/' )
		);
	}

	public function test_is_within_does_not_treat_sibling_as_within(): void {
		// Make a sibling temp dir whose absolute path *starts with* the same
		// prefix as $this->temp_dir; without rtrim('/').'/' on the base, a
		// substr_compare would falsely accept it. Construct a sibling whose
		// directory name begins with the leaf component of $this->temp_dir.
		$leaf       = \basename( $this->temp_dir );
		$sibling    = \dirname( $this->temp_dir ) . '/' . $leaf . '-evil-sibling';
		\mkdir( $sibling, 0755, true );
		try {
			$this->assertNull( Config_Utils::is_within( $sibling, $this->temp_dir ) );
		} finally {
			$this->rmdir_recursive( $sibling );
		}
	}

	// ── validate_config_values ───────────────────────────────────────────────

	public function test_validate_config_values_allows_string(): void {
		$this->assertTrue( Config_Utils::validate_config_values( 'hello' ) );
	}

	public function test_validate_config_values_allows_int(): void {
		$this->assertTrue( Config_Utils::validate_config_values( 42 ) );
	}

	public function test_validate_config_values_allows_float(): void {
		$this->assertTrue( Config_Utils::validate_config_values( 3.14 ) );
	}

	public function test_validate_config_values_allows_bool(): void {
		$this->assertTrue( Config_Utils::validate_config_values( true ) );
		$this->assertTrue( Config_Utils::validate_config_values( false ) );
	}

	public function test_validate_config_values_allows_null(): void {
		$this->assertTrue( Config_Utils::validate_config_values( null ) );
	}

	public function test_validate_config_values_allows_empty_array(): void {
		$this->assertTrue( Config_Utils::validate_config_values( [] ) );
	}

	public function test_validate_config_values_allows_flat_array_of_scalars(): void {
		$this->assertTrue( Config_Utils::validate_config_values( [ 'a', 1, 3.14, true, null ] ) );
	}

	public function test_validate_config_values_allows_nested_array(): void {
		$this->assertTrue(
			Config_Utils::validate_config_values(
				[
					'level1' => [
						'level2' => [
							'level3' => 'deep value',
						],
					],
				]
			)
		);
	}

	public function test_validate_config_values_rejects_object(): void {
		$this->assertFalse( Config_Utils::validate_config_values( new \stdClass() ) );
	}

	public function test_validate_config_values_rejects_closure(): void {
		$this->assertFalse( Config_Utils::validate_config_values( static fn() => 'evil' ) );
	}

	public function test_validate_config_values_rejects_resource(): void {
		$resource = \fopen( 'php://memory', 'r' );
		try {
			$this->assertFalse( Config_Utils::validate_config_values( $resource ) );
		} finally {
			\fclose( $resource );
		}
	}

	public function test_validate_config_values_rejects_array_containing_object(): void {
		$this->assertFalse(
			Config_Utils::validate_config_values( [ 'k' => new \stdClass() ] )
		);
	}

	public function test_validate_config_values_rejects_nested_array_with_object(): void {
		$this->assertFalse(
			Config_Utils::validate_config_values(
				[ 'a' => [ 'b' => [ 'c' => new \stdClass() ] ] ]
			)
		);
	}

	public function test_validate_config_values_rejects_when_depth_exceeds_10(): void {
		// Wrap 'leaf' in 12 layers of array; the recursion limit is 10.
		$value = 'leaf';
		for ( $i = 0; $i < 12; $i++ ) {
			$value = [ $value ];
		}
		$this->assertFalse( Config_Utils::validate_config_values( $value ) );
	}

	public function test_validate_config_values_allows_max_depth_10(): void {
		// Depth 0 (top) through 10 = 11 calls; the guard rejects only when
		// `$depth > 10`. A 10-deep nest must pass.
		$value = 'leaf';
		for ( $i = 0; $i < 10; $i++ ) {
			$value = [ $value ];
		}
		$this->assertTrue( Config_Utils::validate_config_values( $value ) );
	}

	public function test_validate_config_values_rejects_when_starting_depth_exceeds_limit(): void {
		// Caller can pass an explicit starting depth; if it's already > 10 the
		// function must reject without inspecting the value.
		$this->assertFalse( Config_Utils::validate_config_values( 'scalar', 11 ) );
	}

	// ── load_config_file ─────────────────────────────────────────────────────

	public function test_load_config_file_returns_original_when_file_missing(): void {
		$config = [ 'existing' => 'value' ];
		$result = Config_Utils::load_config_file( $config, '/nonexistent/file.php' );
		$this->assertSame( $config, $result );
	}

	public function test_load_config_file_merges_array_return(): void {
		$conf = $this->temp_dir . '/good-config.php';
		\file_put_contents(
			$conf,
			"<?php return [ 'new_key' => 'new_value', 'other' => 42 ];\n"
		);
		$config = [ 'existing' => 'value' ];
		$result = Config_Utils::load_config_file( $config, $conf );
		$this->assertSame( 'value', $result['existing'] );
		$this->assertSame( 'new_value', $result['new_key'] );
		$this->assertSame( 42, $result['other'] );
	}

	public function test_load_config_file_overlay_overrides_existing_keys(): void {
		// Spread-merge semantics: later keys win over earlier ones.
		$conf = $this->temp_dir . '/override.php';
		\file_put_contents( $conf, "<?php return [ 'shared' => 'from_file' ];\n" );
		$result = Config_Utils::load_config_file( [ 'shared' => 'original' ], $conf );
		$this->assertSame( 'from_file', $result['shared'] );
	}

	public function test_load_config_file_rejects_non_array_return(): void {
		$conf = $this->temp_dir . '/string-return.php';
		\file_put_contents( $conf, "<?php return 'not-an-array';\n" );
		$config = [ 'existing' => 'value' ];
		$result = Config_Utils::load_config_file( $config, $conf );
		$this->assertSame( $config, $result );
	}

	public function test_load_config_file_rejects_array_with_object_value(): void {
		$conf = $this->temp_dir . '/object-config.php';
		\file_put_contents(
			$conf,
			"<?php return [ 'bad' => new \\stdClass() ];\n"
		);
		$config = [ 'existing' => 'value' ];
		$result = Config_Utils::load_config_file( $config, $conf );
		$this->assertSame( $config, $result );
		$this->assertArrayNotHasKey( 'bad', $result );
	}

	public function test_load_config_file_rejects_when_returns_null(): void {
		$conf = $this->temp_dir . '/null-return.php';
		\file_put_contents( $conf, "<?php return null;\n" );
		$config = [ 'existing' => 'value' ];
		$result = Config_Utils::load_config_file( $config, $conf );
		$this->assertSame( $config, $result );
	}

	public function test_load_config_file_uses_custom_error_log_prefix(): void {
		$conf = $this->temp_dir . '/bad-prefix-test.php';
		\file_put_contents( $conf, "<?php return 'malicious_string';\n" );
		$captured = '';
		Core::set_stderr_handler( function ( $message ) use ( &$captured ) {
			$captured .= $message;
		} );
		Config_Utils::load_config_file( [], $conf, 'CustomPrefix' );
		$this->assertStringContainsString( 'CustomPrefix::load_config_file()', $captured );
	}

	public function test_load_config_file_default_error_log_prefix(): void {
		$conf = $this->temp_dir . '/bad-default-prefix.php';
		\file_put_contents( $conf, "<?php return 'malicious_string';\n" );
		$captured = '';
		Core::set_stderr_handler( function ( $message ) use ( &$captured ) {
			$captured .= $message;
		} );
		Config_Utils::load_config_file( [], $conf );
		$this->assertStringContainsString( 'Config_Utils::load_config_file()', $captured );
	}

	public function test_load_config_file_empty_array_merge(): void {
		$conf = $this->temp_dir . '/empty-array.php';
		\file_put_contents( $conf, "<?php return [];\n" );
		$result = Config_Utils::load_config_file( [ 'keep' => 'me' ], $conf );
		$this->assertSame( [ 'keep' => 'me' ], $result );
	}
}
