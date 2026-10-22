<?php
namespace Newspack_Nodes\Tests\Unit;

use PHPUnit\Framework\Attributes\CoversClass;
use Newspack_Nodes\Cache_Backend;
use Newspack_Nodes\Capabilities;
use Newspack_Nodes\CLI;
use Newspack_Nodes\Command_Auth;
use Newspack_Nodes\Config;
use Newspack_Nodes\Core;
use Newspack_Nodes\Session_Store_Unavailable;
use Newspack_Nodes\Sessions;
use Newspack_Nodes\Table_Node;
use Newspack_Nodes\Tests\Helpers\Sqlite_Wpdb;
use Newspack_Nodes\Tests\TestCase;

/**
 * The session store on its default backend, a SQLite file every web process
 * opens as its writer, and the `sessions_backend` key that names it.
 */
#[CoversClass( Command_Auth::class )]
#[CoversClass( Sessions::class )]
final class CommandAuthSqliteSessionTest extends TestCase {

	/** Distinct from SESSION_TTL_S and every bound. */
	private const TTL = 5173;

	private string $dir;

	private Sqlite_Wpdb $db;

	protected function setUp(): void {
		parent::setUp();
		$this->db  = $this->use_wpdb();
		$this->dir = $this->make_temp_dir( 'sessions-sqlite-' );
		$this->use_base_dir( $this->dir );
	}

	/** The store's file for the install `$GLOBALS['wpdb']` names. */
	private static function file(): string {
		return Table_Node::file( Command_Auth::session_store(), 0 );
	}

	/** The store as another process opens it: its own connection to the file. */
	private function other_process(): Table_Node {
		return Table_Node::table( Command_Auth::session_store(), Command_Auth::SESSION_TTL_S, 'sqlite', Table_Node::MANY_WRITERS );
	}

	/** A fresh process: nothing memoized from the last. */
	private static function next_process(): void {
		foreach ( [ 'table', 'reader' ] as $memo ) {
			( new \ReflectionProperty( Command_Auth::class, $memo ) )->setValue( null, null );
		}
		Config::reset();
	}

	/** Commit frames in the store's WAL, each one write transaction. */
	private static function commits(): int {
		$wal = (string) @\file_get_contents( self::file() . '-wal' );
		if ( \strlen( $wal ) < 32 ) {
			return 0;
		}
		$page    = \unpack( 'N', \substr( $wal, 8, 4 ) )[1];
		$commits = 0;
		for ( $at = 32; $at + 24 <= \strlen( $wal ); $at += 24 + $page ) {
			$commits += 0 === \unpack( 'N', \substr( $wal, $at + 4, 4 ) )[1] ? 0 : 1;
		}
		return $commits;
	}

	public function test_a_session_lives_in_the_installs_sqlite_file_by_default(): void {
		$session = Command_Auth::mint_session( Capabilities::TUNE, self::TTL );

		$this->assertSame( 'sqlite', Command_Auth::sessions_backend() );
		$this->assertSame( Command_Auth::SESSIONS_TABLE . '-' . Cache_Backend::install_id(), Command_Auth::session_store() );
		$this->assertFileExists( self::file() );
		$this->assertSame( $session['secret'], Core::arr( $this->other_process()->lookup( $session['handle'] ) )['k'] ?? null );
		$this->assertSame( [], $this->db->sent, 'no statement reaches wpdb' );
	}

	/** Two unconfigured installs share `/tmp/newspack-nodes`; neither reads the other's keys. */
	public function test_two_installs_on_one_base_dir_do_not_see_each_others_sessions(): void {
		$this->db->base_prefix = 'kea1_';
		$first                 = Command_Auth::mint_session( Capabilities::MANAGE, self::TTL );
		$first_file            = self::file();

		self::next_process();
		$this->db->base_prefix = 'kea2_';

		$this->assertNotSame( $first_file, self::file() );
		$this->assertNull( Command_Auth::load_session_record( $first['handle'] ) );
		$second = Command_Auth::mint_session( Capabilities::READ, self::TTL );
		$this->assertSame( $second['secret'], Command_Auth::load_session_record( $second['handle'] )['key'] ?? null );
	}

	public function test_a_salt_rotation_leaves_the_store_where_it_is(): void {
		$before  = Command_Auth::session_store();
		$session = Command_Auth::mint_session( Capabilities::TUNE, self::TTL );

		Cache_Backend::move_salt();
		self::next_process();

		$this->assertSame( $before, Command_Auth::session_store() );
		$this->assertSame( $session['secret'], Command_Auth::load_session_record( $session['handle'] )['key'] ?? null );
	}

	public function test_the_wpdb_backend_stays_an_option(): void {
		$this->use_base_dir( $this->dir, [ 'sessions_backend' => 'wpdb' ] );

		$session = Command_Auth::mint_session( Capabilities::TUNE, self::TTL );

		$this->assertSame( 'wpdb', Command_Auth::sessions_backend() );
		$this->assertFileDoesNotExist( self::file() );
		$this->assertSame( $session['secret'], Command_Auth::load_session_record( $session['handle'] )['key'] ?? null );
		$this->assertNotSame( [], $this->db->sent );
	}

	public function test_a_backend_outside_the_two_fails_the_mint_naming_it(): void {
		$this->use_base_dir( $this->dir, [ 'sessions_backend' => 'memcache' ] );

		try {
			Command_Auth::mint_session( Capabilities::TUNE, self::TTL );
			$this->fail( 'a mint must refuse a backend it cannot keep sessions in' );
		} catch ( Session_Store_Unavailable $e ) {
			$this->assertSame( 'the session store is unavailable: sessions_backend must be one of sqlite, wpdb, not memcache', $e->getMessage() );
		}
		$this->assertNull( Command_Auth::load_session_record( 'a1b2c3d4e5f60718293a4b5c6d7e8f90' ) );
	}

	/** A session minted before a switch away and back does not verify after. */
	public function test_switching_backends_and_back_revives_no_session(): void {
		$first = Command_Auth::mint_session( Capabilities::TUNE, self::TTL );

		$GLOBALS['_wp_options']['newspack_nodes_sessions_backend'] = 'wpdb';
		self::next_process();
		$parked = Command_Auth::mint_session( Capabilities::READ, self::TTL );

		unset( $GLOBALS['_wp_options']['newspack_nodes_sessions_backend'] );
		self::next_process();

		$this->assertSame( 'sqlite', Command_Auth::sessions_backend() );
		$this->assertNull( Command_Auth::load_session_record( $first['handle'] ), 'the sqlite store was flushed when left' );
		$GLOBALS['_wp_options']['newspack_nodes_sessions_backend'] = 'wpdb';
		self::next_process();
		$this->assertNull( Command_Auth::load_session_record( $parked['handle'] ), 'the wpdb store was flushed when left' );
	}

	/** Expired rows and members go in the mint's own write: one lock a mint. */
	public function test_a_mint_purges_expired_sessions_in_its_one_write(): void {
		Core::$clock = static fn (): float => 1790000000.0;
		$stale       = Sessions::issue( 'kea-5177', Capabilities::READ, 61 )['handle'];
		Core::$clock = static fn (): float => 1790000061.0;
		$before      = self::commits();

		$live = Command_Auth::mint_session( Capabilities::READ, self::TTL )['handle'];

		$this->assertSame( 1, self::commits() - $before, 'one write transaction' );
		$db = new \PDO( 'sqlite:' . self::file() );
		$this->assertSame( [ Command_Auth::session_store() . ":{$live}" ], $db->query( 'SELECT "key" FROM kv' )->fetchAll( \PDO::FETCH_COLUMN ), "{$stale} went with the mint" );
		$this->assertSame( 0, (int) $db->query( 'SELECT COUNT(*) FROM members' )->fetchColumn(), 'its index member too' );
	}

	/** A verify reads; it opens no writer, so it runs no DDL on the store. */
	public function test_a_verify_runs_no_ddl_against_the_store(): void {
		$session = Command_Auth::mint_session( Capabilities::TUNE, self::TTL );
		$raw     = new \PDO( 'sqlite:' . self::file() );
		$raw->exec( 'DROP TABLE members' );
		$schema = (int) $raw->query( 'PRAGMA schema_version' )->fetchColumn();
		self::next_process();

		$this->assertSame( $session['secret'], Command_Auth::load_session_record( $session['handle'] )['key'] ?? null );

		$this->assertSame( $schema, (int) $raw->query( 'PRAGMA schema_version' )->fetchColumn() );
		$this->assertSame( [ 'kv' ], $raw->query( "SELECT name FROM sqlite_master WHERE type = 'table'" )->fetchAll( \PDO::FETCH_COLUMN ) );
	}

	public function test_root_never_opens_the_store(): void {
		CLI::$uid_provider = static fn (): int => 0;

		try {
			Command_Auth::mint_session( Capabilities::TUNE, self::TTL );
			$this->fail( 'root must not open the session store' );
		} catch ( Session_Store_Unavailable $e ) {
			$this->assertStringContainsString( 'sqlite refuses to run as root', $e->getMessage() );
		}
		$this->assertNull( Command_Auth::load_session_record( 'a1b2c3d4e5f60718293a4b5c6d7e8f90' ) );
		$this->assertFileDoesNotExist( self::file() );
	}

	/**
	 * Web processes mint and verify at once: a verify reads past another
	 * process's open write, and a mint lands once that write lets go.
	 */
	public function test_a_verify_reads_past_another_processs_write_and_a_mint_follows_it(): void {
		$first = Command_Auth::mint_session( Capabilities::TUNE, self::TTL );
		$other = new \PDO( 'sqlite:' . self::file() );
		$other->exec( 'BEGIN IMMEDIATE' );
		$other->exec( "INSERT INTO kv ( \"key\", \"value\", expires ) VALUES ( 'pending-5179', x'00', 0 )" );

		$this->assertSame( $first['secret'], Command_Auth::load_session_record( $first['handle'] )['key'] ?? null );

		$other->exec( 'COMMIT' );
		$second = Command_Auth::mint_session( Capabilities::READ, self::TTL );
		$this->assertSame( $second['secret'], Core::arr( $this->other_process()->lookup( $second['handle'] ) )['k'] ?? null );
	}

	/** A revoke-all in one process reaches every process that opened the store before it. */
	public function test_revoke_all_elsewhere_revokes_here(): void {
		$session = Sessions::issue( 'kea-5171', Capabilities::TUNE, self::TTL );
		$this->assertCount( 1, Sessions::listing() );

		$this->other_process()->flush();

		$this->assertNull( Command_Auth::load_session_record( $session['handle'] ) );
		$this->assertSame( [], Sessions::listing() );
	}

	public function test_the_config_layer_names_the_backend(): void {
		$GLOBALS['_wp_options']['newspack_nodes_sessions_backend'] = 'wpdb';
		Config::reset();

		$this->assertSame( 'wpdb', Command_Auth::sessions_backend() );
	}
}
