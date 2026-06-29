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
}
