<?php
namespace Newspack_Nodes\Tests\Unit;

use Newspack_Nodes\Settings_Sync_Node;
use Newspack_Nodes\Tests\TestCase;
use Newspack_Nodes\Tests\Capture_Sink_Node;
use Newspack_Nodes\Tests\Helpers\InMemoryMemcached;
use PHPUnit\Framework\Attributes\CoversClass;
use Newspack_Nodes\Command_Auth;
use Newspack_Nodes\Core;
use Newspack_Nodes\HTTP_Out_Node;
use Newspack_Nodes\Message;
use Newspack_Nodes\Vault;

/**
 * Settings_Sync mints and signs one command per spoke. A signature under one
 * spoke's key verifies only there, so a fan-out that re-addresses AFTER the mint
 * is structurally impossible — which is why `spokes:tee` goes away and the
 * minter carries the target list itself.
 */
#[CoversClass( Settings_Sync_Node::class )]
class SettingsSyncFanoutTest extends TestCase {

	private ?\Memcached $prev_memd = null;

	protected function setUp(): void {
		parent::setUp();
		$this->prev_memd = Core::$memd;
		Core::$memd      = new InMemoryMemcached();
		\update_option(
			Vault::OPTION_KEY,
			[
				'tw0' => [ 'url' => 'https://tw0.example', 'auth_username' => 'u', 'auth_password' => 'p' ],
				'tw1' => [ 'url' => 'https://tw1.example', 'auth_username' => 'u', 'auth_password' => 'p' ],
			]
		);
		Vault::get_instance()->reset_cache();
	}

	protected function tearDown(): void {
		HTTP_Out_Node::$curl_dispatch = null;
		Command_Auth::forget_session( 'tw0' );
		Command_Auth::forget_session( 'tw1' );
		Vault::get_instance()->reset_cache();
		Core::$memd = $this->prev_memd;
		parent::tearDown();
	}

	/** An egress node named independently of its vault id — as the live hub graph is. */
	private function egress( string $node_name, string $vault_id ): HTTP_Out_Node {
		$node = new HTTP_Out_Node();
		$node->name( $node_name );
		$node->arguments( [ $vault_id ] );
		return $node;
	}

	private function minter( Capture_Sink_Node $sink ): Settings_Sync_Node {
		$sink->name( '_command_interpreter' );
		$node = new Settings_Sync_Node();
		$node->name( 'settings-sync' );
		$node->sink( $sink );
		return $node;
	}

	private function push( Settings_Sync_Node $node ): void {
		$msg                   = Message::new_message();
		$msg[ Message::TYPE ]  = Message::TM_STRUCT;
		$msg[ Message::VALUE ] = [ 'option' => 'newspack_nodes_max_segments' ];
		$node->fill( $msg );
	}

	public function test_one_signed_command_is_minted_per_connected_spoke(): void {
		\update_option( 'newspack_nodes_max_segments', 8 );
		$this->egress( 'settings:tw0', 'tw0' );
		$this->egress( 'settings:tw1', 'tw1' );
		$a = Command_Auth::mint_session();
		$b = Command_Auth::mint_session();
		Command_Auth::remember_session( 'tw0', $a['handle'], $a['key'] );
		Command_Auth::remember_session( 'tw1', $b['handle'], $b['key'] );

		$sink = new Capture_Sink_Node();
		$node = $this->minter( $sink );
		$node->add_setting( [ 'newspack_nodes_max_segments', 'settings', 'newspack_nodes_max_segments' ] );
		$node->connect_node( 'settings:tw0' );
		$node->connect_node( 'settings:tw1' );

		$this->push( $node );

		$this->assertCount( 2, $sink->captured, 'one command per spoke, not one to a Tee' );
		$this->assertSame( 'settings:tw0/settings', $sink->captured[0][ Message::TO ] );
		$this->assertSame( 'settings:tw1/settings', $sink->captured[1][ Message::TO ] );
		$this->assertSame( $a['handle'], $sink->captured[0][ Message::VALUE ]['auth']['handle'] );
		$this->assertSame( $b['handle'], $sink->captured[1][ Message::VALUE ]['auth']['handle'] );
	}

	/**
	 * A target may be a PATH (`spoke/settings`), which is alive as long as its head
	 * is. The deadlock-breaker has to resolve the head like `send_set` does — a
	 * full-path lookup returns null, the handshake never runs, and the deadlock the
	 * skip path exists to break survives silently.
	 */
	public function test_a_path_form_target_without_a_session_still_kicks_the_handshake(): void {
		\update_option( 'newspack_nodes_max_segments', 8 );
		$this->egress( 'settings:tw0', 'tw0' );
		$posts                        = 0;
		HTTP_Out_Node::$curl_dispatch = static function ( array $opts ) use ( &$posts ): \CurlHandle {
			++$posts;
			// phpcs:ignore WordPress.WP.AlternativeFunctions.curl_curl_init
			return \curl_init();
		};

		$sink = new Capture_Sink_Node();
		$node = $this->minter( $sink );
		$node->add_setting( [ 'newspack_nodes_max_segments', 'settings', 'newspack_nodes_max_segments' ] );
		$node->connect_node( 'settings:tw0/settings' );

		$this->push( $node );

		$this->assertSame( [], $sink->captured, 'no session: nothing may be minted' );
		$this->assertGreaterThan( 0, $posts, 'the skip path must ask for a handshake' );
	}

	/** No session, no signature, no command: a minter must not emit what will be refused. */
	public function test_a_spoke_without_a_session_is_skipped_and_the_others_still_ship(): void {
		\update_option( 'newspack_nodes_max_segments', 8 );
		$this->egress( 'settings:tw0', 'tw0' );
		$this->egress( 'settings:tw1', 'tw1' );
		$a = Command_Auth::mint_session();
		Command_Auth::remember_session( 'tw0', $a['handle'], $a['key'] );

		$sink = new Capture_Sink_Node();
		$node = $this->minter( $sink );
		$node->add_setting( [ 'newspack_nodes_max_segments', 'settings', 'newspack_nodes_max_segments' ] );
		$node->connect_node( 'settings:tw0' );
		$node->connect_node( 'settings:tw1' );

		$this->push( $node );

		$this->assertCount( 1, $sink->captured );
		$this->assertSame( 'settings:tw0/settings', $sink->captured[0][ Message::TO ] );
	}

	/** A removed spoke must not linger in the list and keep getting commands minted for it. */
	public function test_a_vanished_egress_node_is_pruned_from_the_fan_out(): void {
		\update_option( 'newspack_nodes_max_segments', 8 );
		$this->egress( 'settings:tw0', 'tw0' );
		$doomed = $this->egress( 'settings:tw1', 'tw1' );
		$a      = Command_Auth::mint_session();
		$b      = Command_Auth::mint_session();
		Command_Auth::remember_session( 'tw0', $a['handle'], $a['key'] );
		Command_Auth::remember_session( 'tw1', $b['handle'], $b['key'] );

		$sink = new Capture_Sink_Node();
		$node = $this->minter( $sink );
		$node->add_setting( [ 'newspack_nodes_max_segments', 'settings', 'newspack_nodes_max_segments' ] );
		$node->connect_node( 'settings:tw0' );
		$node->connect_node( 'settings:tw1' );

		$doomed->remove_node();
		$this->push( $node );

		$this->assertCount( 1, $sink->captured );
		$this->assertSame( 'settings:tw0/settings', $sink->captured[0][ Message::TO ] );
	}
}
