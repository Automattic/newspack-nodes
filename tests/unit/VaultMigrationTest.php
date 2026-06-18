<?php
namespace Newspack_Nodes\Tests\Unit;

use Newspack_Nodes\Vault;
use Newspack_Nodes\Vault_Migration;
use Newspack_Nodes\Tests\TestCase;

final class VaultMigrationTest extends TestCase {

	private const SOURCE = 'newspack_event_logger_nodes_aggregator_servers';
	private const MARKER = 'newspack_nodes_vault_migrated';

	protected function setUp(): void {
		parent::setUp();
		\delete_option( self::SOURCE );
		\delete_option( Vault::OPTION_KEY );
		\delete_option( self::MARKER );
	}

	public function test_copies_legacy_option_when_target_absent(): void {
		$legacy = [ 'spoke1' => [ 'url' => 'https://e.com', 'auth_password' => '$enc$abc', 'enabled' => true ] ];
		\update_option( self::SOURCE, $legacy );
		Vault_Migration::maybe_migrate();
		$this->assertSame( $legacy, \get_option( Vault::OPTION_KEY ) );
		$this->assertSame( $legacy, \get_option( self::SOURCE ), 'source left intact' );
	}

	public function test_is_idempotent_and_does_not_clobber_existing_target(): void {
		\update_option( self::SOURCE, [ 'old' => [ 'url' => 'https://a.com' ] ] );
		\update_option( Vault::OPTION_KEY, [ 'new' => [ 'url' => 'https://b.com' ] ] );
		Vault_Migration::maybe_migrate();
		$this->assertArrayHasKey( 'new', \get_option( Vault::OPTION_KEY ) );
		$this->assertArrayNotHasKey( 'old', \get_option( Vault::OPTION_KEY ) );
	}

	public function test_noop_when_no_legacy_option(): void {
		Vault_Migration::maybe_migrate();
		$this->assertFalse( \get_option( Vault::OPTION_KEY ) );
	}
}
