<?php
namespace Newspack_Nodes\Tests\Unit;

use PHPUnit\Framework\Attributes\CoversClass;
use Newspack_Nodes\Command_Auth;
use Newspack_Nodes\Oauth_Store;
use Newspack_Nodes\Table_Node;
use Newspack_Nodes\Tests\Helpers\OauthStoreContract;

/**
 * Every `OauthStoreContract` case on the session store's default backend, a
 * SQLite file, which a web process opens as a writer beside a READER.
 */
#[CoversClass( Oauth_Store::class )]
final class OauthStoreSqliteTest extends OauthStoreContract {

	protected function use_backend(): void {
		$this->db = $this->use_wpdb();
		$this->use_base_dir( $this->make_temp_dir( 'oauth-sqlite-' ) );
	}

	protected function rows(): array {
		return \array_map(
			fn ( array $row ): array => [
				'cache_key' => $this->unscoped( $row['cache_key'] ),
				'value'     => (string) $row['value'],
				'expires'   => (int) $row['expires'],
			],
			$this->file()->query( 'SELECT "key" AS cache_key, "value", expires FROM kv' )->fetchAll( \PDO::FETCH_ASSOC )
		);
	}

	protected function members(): array {
		return \array_map(
			fn ( array $row ): array => [
				'set_key' => $this->unscoped( $row['set_key'] ),
				'member'  => (string) $row['member'],
				'expires' => (int) $row['expires'],
			],
			$this->file()->query( 'SELECT set_key, member, expires FROM members' )->fetchAll( \PDO::FETCH_ASSOC )
		);
	}

	/** The store's file, opened as another process would. */
	private function file(): \PDO {
		$this->assertSame( 'sqlite', Command_Auth::sessions_backend() );
		return new \PDO( 'sqlite:' . Table_Node::file( Command_Auth::session_store(), 0 ) );
	}

	/** A stored key without the store's own `{namespace}:` scope. */
	private function unscoped( string $key ): string {
		$scope = Command_Auth::session_store() . ':';
		return \str_starts_with( $key, $scope ) ? \substr( $key, \strlen( $scope ) ) : $key;
	}
}
