<?php
namespace Newspack_Nodes\Tests\Unit;

use Newspack_Nodes\Vault;
use Newspack_Nodes\Tests\TestCase;

final class VaultTest extends TestCase {

	protected function setUp(): void {
		parent::setUp();
		\delete_option( Vault::OPTION_KEY );
		\Newspack_Nodes\Config::reset();
		Vault::get_instance()->reset_cache();
	}

	protected function tearDown(): void {
		\Newspack_Nodes\Config::reset();
		parent::tearDown();
	}

	public function test_option_key_is_substrate_namespaced(): void {
		$this->assertSame( 'newspack_nodes_vault', Vault::OPTION_KEY );
	}

	public function test_add_then_get_roundtrips_without_logs(): void {
		$vault = Vault::get_instance();
		$this->assertTrue( $vault->add( 'spoke1', [
			'url'           => 'https://example.com',
			'auth_username' => 'u',
			'auth_password' => 'secret-pw',
		] ) );
		$vault->reset_cache();
		$rec = $vault->get( 'spoke1' );
		$this->assertNotNull( $rec );
		$this->assertSame( 'https://example.com', $rec['url'] );
		$this->assertSame( 'secret-pw', $rec['auth_password'] ); // decrypted on read
		$this->assertArrayNotHasKey( 'logs', $rec );
		$this->assertArrayNotHasKey( 'enabled', $rec ); // enabled flag removed; presence = enabled.
	}

	public function test_password_is_encrypted_at_rest(): void {
		$vault = Vault::get_instance();
		$vault->add( 'spoke2', [ 'url' => 'https://e.com', 'auth_password' => 'pw' ] );
		$raw = \get_option( Vault::OPTION_KEY );
		$this->assertStringStartsWith( '$enc$', $raw['spoke2']['auth_password'] );
	}

	public function test_get_enabled_returns_all_present_servers(): void {
		$vault = Vault::get_instance();
		$vault->add( 'a', [ 'url' => 'https://a.com' ] );
		$vault->add( 'b', [ 'url' => 'https://b.com' ] );
		$vault->reset_cache();
		// Presence in the vault = enabled; get_enabled() is now an alias for get_all().
		$this->assertArrayHasKey( 'a', $vault->get_enabled() );
		$this->assertArrayHasKey( 'b', $vault->get_enabled() );
	}

	/**
	 * Stub Config's file-only defaults so a server reads as a config-file server.
	 *
	 * @param array<string, array<string, mixed>> $servers Vault server map.
	 */
	private function seed_config_servers( array $servers ): void {
		$ref = new \ReflectionProperty( \Newspack_Nodes\Config::class, 'config_defaults' );
		$ref->setValue( null, [ 'vault' => $servers ] );
		Vault::get_instance()->reset_cache();
	}

	public function test_config_file_server_update_is_a_noop(): void {
		$this->seed_config_servers( [ 'cfg' => [ 'url' => 'https://pinned.example' ] ] );
		$vault = Vault::get_instance();
		$this->assertTrue( $vault->is_config_server( 'cfg' ) );
		// Config-file servers are fully immutable — update() can change nothing.
		$this->assertFalse( $vault->update( 'cfg', [ 'url' => 'https://changed.example' ] ) );
		$vault->reset_cache();
		$this->assertSame( 'https://pinned.example', $vault->get( 'cfg' )['url'] );
	}

	public function test_fresh_returns_singleton_with_cache_dropped(): void {
		$vault = Vault::get_instance();
		$this->assertTrue( $vault->add( 'spoke1', [ 'url' => 'https://a.example' ] ) );
		$this->assertNotNull( $vault->get( 'spoke1' ) );
		\delete_option( Vault::OPTION_KEY );
		$fresh = Vault::fresh();
		$this->assertSame( $vault, $fresh );
		$this->assertNull( $fresh->get( 'spoke1' ) );
	}

	// ---------------------------------------------------------------------
	// get_all — defensive normalization of malformed config / option data.
	// ---------------------------------------------------------------------

	public function test_get_all_coerces_non_array_config_vault_to_empty(): void {
		$ref = new \ReflectionProperty( \Newspack_Nodes\Config::class, 'config_defaults' );
		$ref->setValue( null, [ 'vault' => 'not-an-array' ] );
		Vault::get_instance()->reset_cache();

		// The coercion guard turns a non-array config `vault` into [] BEFORE the
		// normalize foreach. Without it, foreach over the string still yields [] but
		// emits a PHP warning — so the empty result alone can't catch a regression.
		// Capture warnings and assert none fired.
		$warnings = [];
		\set_error_handler(
			static function ( int $errno, string $message ) use ( &$warnings ): bool {
				$warnings[] = $message;
				return true;
			},
			\E_WARNING
		);
		try {
			$result = Vault::get_instance()->get_all();
		} finally {
			\restore_error_handler();
		}

		$this->assertSame( [], $result );
		$this->assertSame( [], $warnings, 'get_all() must coerce a non-array config vault without emitting a PHP warning' );
	}

	public function test_get_all_skips_non_array_server_entries(): void {
		\update_option( Vault::OPTION_KEY, [
			'good' => [ 'url' => 'https://good.example' ],
			'bad'  => 'not-an-array',
		] );
		$vault = Vault::get_instance();
		$vault->reset_cache();
		$all = $vault->get_all();
		$this->assertArrayHasKey( 'good', $all );
		$this->assertArrayNotHasKey( 'bad', $all );
	}

	// ---------------------------------------------------------------------
	// decrypt — plaintext passthrough + failure on malformed ciphertext.
	// ---------------------------------------------------------------------

	public function test_plaintext_config_password_passes_through_decrypt(): void {
		// Config-file servers bypass validate_config, so their passwords are
		// stored verbatim; decrypt() must return a non-encrypted value unchanged.
		$this->seed_config_servers( [ 'cfg' => [ 'url' => 'https://e.com', 'auth_password' => 'plain text pw' ] ] );
		$rec = Vault::get_instance()->get( 'cfg' );
		$this->assertSame( 'plain text pw', $rec['auth_password'] );
	}

	public function test_malformed_encrypted_password_decrypts_to_empty(): void {
		\update_option( Vault::OPTION_KEY, [
			'x' => [ 'url' => 'https://e.com', 'auth_password' => Vault::ENCRYPTED_PREFIX . '@@@not-base64' ],
		] );
		$vault = Vault::get_instance();
		$vault->reset_cache();
		$this->assertSame( '', $vault->get( 'x' )['auth_password'] );
	}

	// ---------------------------------------------------------------------
	// add — rejection paths.
	// ---------------------------------------------------------------------

	public function test_add_rejects_invalid_id(): void {
		$this->assertFalse( Vault::get_instance()->add( 'bad id!', [ 'url' => 'https://e.com' ] ) );
	}

	public function test_add_rejects_duplicate_id(): void {
		$vault = Vault::get_instance();
		$this->assertTrue( $vault->add( 'dup', [ 'url' => 'https://e.com' ] ) );
		$vault->reset_cache();
		$this->assertFalse( $vault->add( 'dup', [ 'url' => 'https://other.example' ] ) );
	}

	public function test_add_rejects_when_at_capacity(): void {
		$servers = [];
		for ( $i = 0; $i < Vault::MAX_SERVERS; $i++ ) {
			$servers[ "s{$i}" ] = [ 'url' => 'https://e.com' ];
		}
		\update_option( Vault::OPTION_KEY, $servers );
		$vault = Vault::get_instance();
		$vault->reset_cache();
		$this->assertFalse( $vault->add( 'one-too-many', [ 'url' => 'https://e.com' ] ) );
	}

	// ---------------------------------------------------------------------
	// validate_config — URL + credential rules.
	// ---------------------------------------------------------------------

	public function test_add_rejects_missing_url(): void {
		$this->assertFalse( Vault::get_instance()->add( 'nourl', [ 'auth_username' => 'u' ] ) );
	}

	public function test_add_rejects_url_that_sanitizes_to_empty(): void {
		// esc_url_raw strips the whitespace-only URL to ''.
		$this->assertFalse( Vault::get_instance()->add( 'blank', [ 'url' => '   ' ] ) );
	}

	public function test_add_rejects_non_https_url(): void {
		$this->assertFalse( Vault::get_instance()->add( 'insecure', [ 'url' => 'http://insecure.example' ] ) );
	}

	public function test_add_truncates_overlong_username_and_password(): void {
		$vault = Vault::get_instance();
		$long  = \str_repeat( 'a', 300 );
		$this->assertTrue( $vault->add( 'caps', [
			'url'           => 'https://e.com',
			'auth_username' => $long,
			'auth_password' => $long,
		] ) );
		$vault->reset_cache();
		$rec = $vault->get( 'caps' );
		$this->assertSame( 256, \strlen( $rec['auth_username'] ) );
		// Password is decrypted on read; the stored plaintext was capped at 256.
		$this->assertSame( 256, \strlen( $rec['auth_password'] ) );
	}

	public function test_add_blanks_an_already_encrypted_password_that_will_not_decrypt(): void {
		// A pre-encrypted password handed to add() is verified, not re-encrypted;
		// one that fails to decrypt is blanked rather than stored as junk.
		$vault = Vault::get_instance();
		$this->assertTrue( $vault->add( 'enc', [
			'url'           => 'https://e.com',
			'auth_password' => Vault::ENCRYPTED_PREFIX . '@@@not-base64',
		] ) );
		$vault->reset_cache();
		$this->assertSame( '', $vault->get( 'enc' )['auth_password'] );
	}

	// ---------------------------------------------------------------------
	// encrypt — empty plaintext shortcut (private; exercised via reflection).
	// ---------------------------------------------------------------------

	public function test_encrypt_returns_empty_for_empty_plaintext(): void {
		$method = new \ReflectionMethod( Vault::class, 'encrypt' );
		$this->assertSame( '', $method->invoke( null, '' ) );
	}

	// ---------------------------------------------------------------------
	// update — happy path + rejection paths (non-config server).
	// ---------------------------------------------------------------------

	public function test_update_merges_partial_into_existing_server(): void {
		$vault = Vault::get_instance();
		$vault->add( 'up', [ 'url' => 'https://old.example', 'auth_username' => 'keepme' ] );
		$vault->reset_cache();
		$this->assertTrue( $vault->update( 'up', [ 'url' => 'https://new.example' ] ) );
		$vault->reset_cache();
		$rec = $vault->get( 'up' );
		$this->assertSame( 'https://new.example', $rec['url'] );
		$this->assertSame( 'keepme', $rec['auth_username'] ); // untouched key survives the merge.
	}

	public function test_update_rejects_invalid_id(): void {
		$this->assertFalse( Vault::get_instance()->update( 'bad id!', [ 'url' => 'https://e.com' ] ) );
	}

	public function test_update_rejects_unknown_id(): void {
		$this->assertFalse( Vault::get_instance()->update( 'ghost', [ 'url' => 'https://e.com' ] ) );
	}

	public function test_update_rejects_when_merge_fails_validation(): void {
		$vault = Vault::get_instance();
		$vault->add( 'valid', [ 'url' => 'https://e.com' ] );
		$vault->reset_cache();
		$this->assertFalse( $vault->update( 'valid', [ 'url' => 'http://downgrade.example' ] ) );
	}

	// ---------------------------------------------------------------------
	// remove — happy path + rejection paths.
	// ---------------------------------------------------------------------

	public function test_remove_deletes_a_wp_option_server(): void {
		$vault = Vault::get_instance();
		$vault->add( 'gone', [ 'url' => 'https://e.com' ] );
		$vault->reset_cache();
		$this->assertTrue( $vault->remove( 'gone' ) );
		$vault->reset_cache();
		$this->assertNull( $vault->get( 'gone' ) );
	}

	public function test_remove_rejects_invalid_id(): void {
		$this->assertFalse( Vault::get_instance()->remove( 'bad id!' ) );
	}

	public function test_remove_rejects_unknown_id(): void {
		$this->assertFalse( Vault::get_instance()->remove( 'ghost' ) );
	}

	public function test_remove_rejects_config_file_server(): void {
		$this->seed_config_servers( [ 'cfg' => [ 'url' => 'https://pinned.example' ] ] );
		$this->assertFalse( Vault::get_instance()->remove( 'cfg' ) );
	}
}
