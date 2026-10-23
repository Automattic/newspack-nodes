<?php
namespace Newspack_Nodes\Tests\Unit;

use PHPUnit\Framework\Attributes\CoversClass;
use Newspack_Nodes\Command_Auth;
use Newspack_Nodes\Oauth_Store;
use Newspack_Nodes\Session_Store_Unavailable;
use Newspack_Nodes\Tests\Helpers\OauthStoreContract;

/** Every `OauthStoreContract` case on the wpdb session store. */
#[CoversClass( Oauth_Store::class )]
final class OauthStoreTest extends OauthStoreContract {

	protected function use_backend(): void {
		$this->db = $this->use_wpdb_sessions();
	}

	/** Each row's value as the arm wrote it, out of the column's base64. */
	protected function rows(): array {
		return \array_map(
			static fn ( array $row ): array => [ 'value' => (string) \base64_decode( (string) $row['value'], true ) ] + $row,
			$this->db->get_results( "SELECT cache_key, `value`, expires FROM wp_newspack_nodes_table WHERE namespace = '" . Command_Auth::session_store() . "'" )
		);
	}

	protected function members(): array {
		return $this->db->get_results( "SELECT set_key, member, expires FROM wp_newspack_nodes_members WHERE namespace = '" . Command_Auth::session_store() . "'" );
	}

	/**
	 * A grace row the store refuses, with no other claim standing, is a
	 * store failure: the session the refresh minted is revoked, the token it
	 * issued dropped, and the refusal raised; the old token still works.
	 */
	public function test_a_claim_the_store_refuses_revokes_the_session_and_raises(): void {
		$first  = Oauth_Store::open_grant( self::approval() );
		$minted = $this->answer();
		$answer = function ( array $grant, string $grant_id, string $next ) use ( $minted ): array {
			$out                            = $minted( $grant, $grant_id, $next );
			$this->db->deny['INSERT IGNORE'] = 'Deadlock found 4410';
			return $out;
		};

		$thrown = $this->caught( static fn () => Oauth_Store::rotate( $first['refresh'], $answer ), 'expected a refused claim to raise' );
		$this->db->deny = [];

		$this->assertInstanceOf( Session_Store_Unavailable::class, $thrown );
		$this->assertStringStartsWith( 'could not store an OAuth row: ', $thrown->getMessage() );
		$this->assertStringContainsString( 'Deadlock found 4410', $thrown->getMessage() );
		$this->assertNull( Command_Auth::load_session_record( $this->answered[0]['handle'] ), 'the minted session is revoked' );
		$this->assertStringNotContainsString( \hash( 'sha256', $this->answered[0]['next'] ), (string) \wp_json_encode( $this->rows() ), 'the issued token is dropped' );
		$this->assertNotNull( Oauth_Store::rotate( $first['refresh'], $this->answer() ), 'the live token was never spent' );
	}
}
