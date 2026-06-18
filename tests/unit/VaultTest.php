<?php
namespace Newspack_Nodes\Tests\Unit;

use Newspack_Nodes\Vault;
use Newspack_Nodes\Tests\TestCase;

final class VaultTest extends TestCase {

	protected function setUp(): void {
		parent::setUp();
		\delete_option( Vault::OPTION_KEY );
		Vault::get_instance()->reset_cache();
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
			'enabled'       => true,
		] ) );
		$vault->reset_cache();
		$rec = $vault->get( 'spoke1' );
		$this->assertNotNull( $rec );
		$this->assertSame( 'https://example.com', $rec['url'] );
		$this->assertSame( 'secret-pw', $rec['auth_password'] ); // decrypted on read
		$this->assertArrayNotHasKey( 'logs', $rec );
	}

	public function test_password_is_encrypted_at_rest(): void {
		$vault = Vault::get_instance();
		$vault->add( 'spoke2', [ 'url' => 'https://e.com', 'auth_password' => 'pw' ] );
		$raw = \get_option( Vault::OPTION_KEY );
		$this->assertStringStartsWith( '$enc$', $raw['spoke2']['auth_password'] );
	}

	public function test_get_enabled_filters_disabled(): void {
		$vault = Vault::get_instance();
		$vault->add( 'on',  [ 'url' => 'https://a.com', 'enabled' => true ] );
		$vault->add( 'off', [ 'url' => 'https://b.com', 'enabled' => false ] );
		$vault->reset_cache();
		$this->assertArrayHasKey( 'on', $vault->get_enabled() );
		$this->assertArrayNotHasKey( 'off', $vault->get_enabled() );
	}
}
