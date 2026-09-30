<?php
namespace Newspack_Nodes\Tests\Unit;

use PHPUnit\Framework\Attributes\CoversClass;
use Newspack_Nodes\Cache_Backend;
use Newspack_Nodes\Core;
use Newspack_Nodes\Message;
use Newspack_Nodes\Node;
use Newspack_Nodes\Sqlite_Arm;
use Newspack_Nodes\Table_Node;
use Newspack_Nodes\Table_Unavailable;
use Newspack_Nodes\Tests\Capture_Sink_Node;
use Newspack_Nodes\Tests\Helpers\InMemoryMemcached;
use Newspack_Nodes\Tests\TestCase;

/**
 * Table_Node: the keyed store (Tachikoma Table vocabulary) kept in the
 * Cache_Backend arm it names, so ANY process — dashboard, REST, CLI — reads
 * values without asking a live worker. fill() stores KEY→VALUE write-through
 * (the message passes on), Table_Node::lookup() is the cross-process read.
 */
#[CoversClass( Table_Node::class )]
class TableNodeTest extends TestCase {
	private ?\Memcached $prev_memd = null;
	private InMemoryMemcached $memd;

	/** Core::$now as this suite found it; Core::reset() does not clear it. */
	private float $saved_now = 0.0;

	/** @var list<string> Base directories a test opened, removed in tearDown. */
	private array $base_dirs = [];

	protected function setUp(): void {
		parent::setUp();
		$this->prev_memd = Core::$memd;
		$this->saved_now = Core::$now;
		$this->memd      = new InMemoryMemcached();
		Core::$memd      = $this->memd;
	}

	protected function tearDown(): void {
		Core::$memd = $this->prev_memd;
		Core::$now  = $this->saved_now;
		foreach ( $this->base_dirs as $dir ) {
			$this->rmdir_recursive( $dir );
		}
		parent::tearDown();
	}

	/** A fresh base directory for a sqlite Table, removed in tearDown. */
	private function base_dir( string $prefix ): string {
		$dir               = $this->make_temp_dir( $prefix );
		$this->base_dirs[] = $dir;
		$this->use_base_dir( $dir );
		return $dir;
	}

	private function table( string $ns = 'prices', string $ttl = '37', string ...$rest ): array {
		$sink  = new Capture_Sink_Node();
		$table = new Table_Node();
		$table->name( 'prices:table' );
		$table->sink( $sink );
		$table->arguments( [ $ns, $ttl, ...$rest ] );
		return [ $table, $sink ];
	}

	private function keyed( string $key, mixed $value ): array {
		$message                   = Message::new_message();
		$message[ Message::TYPE ]  = Message::TM_STRUCT;
		$message[ Message::KEY ]   = $key;
		$message[ Message::VALUE ] = $value;
		return $message;
	}

	private function request( string $value, string $from = 'asker' ): array {
		$message                   = Message::new_message();
		$message[ Message::TYPE ]  = Message::TM_REQUEST;
		$message[ Message::FROM ]  = $from;
		$message[ Message::VALUE ] = $value;
		return $message;
	}

	/**
	 * What an MGET of `$keys` answers, as key => value.
	 *
	 * @return array<string,mixed>
	 */
	private function mget( Table_Node $table, string ...$keys ): array {
		$sink = new Capture_Sink_Node();
		$table->sink( $sink );
		$table->fill( $this->request( 'MGET ' . \implode( ' ', $keys ) ) );
		$found = [];
		foreach ( $sink->captured as $reply ) {
			if ( 0 === ( $reply[ Message::TYPE ] & ( Message::TM_INFO | Message::TM_ERROR ) ) ) {
				$found[ $reply[ Message::KEY ] ] = $reply[ Message::VALUE ];
			}
		}
		return $found;
	}

	public function test_get_request_replies_bytestream_for_a_scalar_value(): void {
		[ $table, $sink ] = $this->table();
		$table->fill( $this->keyed( 'sku-9', "bar\n" ) );
		$sink->captured = [];

		$table->fill( $this->request( 'GET sku-9' ) );

		$this->assertCount( 2, $sink->captured );
		$reply = $sink->captured[0];
		$this->assertSame( Message::TM_BYTESTREAM, $reply[ Message::TYPE ] );
		$this->assertSame( 'prices:table', $reply[ Message::FROM ] );
		$this->assertSame( 'asker', $reply[ Message::TO ] );
		$this->assertSame( 'sku-9', $reply[ Message::KEY ] );
		$this->assertSame( "bar\n", $reply[ Message::VALUE ] );
		$this->assertSame( [ Message::TM_INFO, "GET 1\n" ], [ $sink->captured[1][ Message::TYPE ], $sink->captured[1][ Message::VALUE ] ] );
	}

	public function test_get_request_replies_struct_for_an_array_value(): void {
		[ $table, $sink ] = $this->table();
		$table->fill( $this->keyed( 'sku-9', [ 'usd' => 1250 ] ) );
		$sink->captured = [];

		$table->fill( $this->request( 'GET sku-9' ) );

		$this->assertCount( 2, $sink->captured );
		$reply = $sink->captured[0];
		$this->assertSame( Message::TM_STRUCT, $reply[ Message::TYPE ] );
		$this->assertSame( [ 'usd' => 1250 ], $reply[ Message::VALUE ] );
		$this->assertSame( [ Message::TM_INFO, "GET 1\n" ], [ $sink->captured[1][ Message::TYPE ], $sink->captured[1][ Message::VALUE ] ] );
	}

	public function test_a_request_is_neither_stored_nor_forwarded(): void {
		[ $table, $sink ] = $this->table();

		// A KEY-bearing request must not be mistaken for a write.
		$message                 = $this->request( 'GET sku-9' );
		$message[ Message::KEY ] = 'sku-9';
		$table->fill( $message );

		$this->assertFalse( $this->memd->get( Cache_Backend::entry_key( 'prices', 'sku-9' ) ) );
		$this->assertCount( 1, $sink->captured, 'only the count, not the request itself' );
		$this->assertSame( Message::TM_INFO, $sink->captured[0][ Message::TYPE ] );
	}

	public function test_an_empty_value_deletes_the_key(): void {
		[ $table ] = $this->table();
		$table->fill( $this->keyed( 'sku-9', [ 'usd' => 1250 ] ) );

		$table->fill( $this->keyed( 'sku-9', '' ) );

		$this->assertNull( $table->lookup( 'sku-9' ) );
	}

	public function test_a_bare_newline_deletes_too_since_send_node_always_appends_one(): void {
		[ $table ] = $this->table();
		$table->fill( $this->keyed( 'sku-9', [ 'usd' => 1250 ] ) );

		$table->fill( $this->keyed( 'sku-9', "\n" ) );

		$this->assertNull( $table->lookup( 'sku-9' ) );
	}

	public function test_a_value_that_is_only_terminated_still_stores(): void {
		[ $table ] = $this->table();

		$table->fill( $this->keyed( 'sku-9', "bar\n" ) );

		$this->assertSame( "bar\n", $table->lookup( 'sku-9' ) );
	}

	public function test_fill_stores_key_value_and_passes_the_message_through(): void {
		[ $table, $sink ] = $this->table();

		$table->fill( $this->keyed( 'sku-9', [ 'usd' => 1250 ] ) );

		$this->assertSame( [ 'usd' => 1250 ], $this->memd->get( Cache_Backend::entry_key( 'prices', 'sku-9' ) ) );
		$this->assertCount( 1, $sink->captured, 'write-through: the table composes mid-graph' );
	}

	public function test_lookup_reads_from_any_process(): void {
		[ $table ] = $this->table();
		$other     = Table_Node::table( 'other-ns', 37 );
		$table->fill( $this->keyed( 'sku-9', 'v2' ) );

		$this->assertSame( 'v2', $table->lookup( 'sku-9' ) );
		$this->assertNull( $table->lookup( 'absent' ) );
		$this->assertNull( $other->lookup( 'sku-9' ) );
	}

	public function test_a_keyless_struct_is_refused_not_forwarded(): void {
		[ $table, $sink ] = $this->table();

		$table->fill( $this->keyed( '', [ 'no' => 'key' ] ) );

		$this->assertSame( [], $this->memd->keys() );
		$this->assertSame( [], $sink->captured );
	}

	public function test_a_keyless_info_still_passes_through(): void {
		[ $table, $sink ] = $this->table();
		$info                   = Message::new_message();
		$info[ Message::TYPE ]  = Message::TM_INFO;
		$info[ Message::VALUE ] = "MGET 37\n";

		$table->fill( $info );

		$this->assertSame( [], $this->memd->keys() );
		$this->assertSame( [ $info ], $sink->captured );
	}

	public function test_an_auto_table_on_a_host_with_no_cache_backend_is_table_unavailable(): void {
		Core::$memd                 = null;
		Cache_Backend::$apcu_usable = static fn (): bool => false;
		try {
			$this->assert_unavailable( fn () => $this->table( 'kea:p3', '37' ), 'Table prices:table: auto backend finds neither memcached nor APCu' );
		} finally {
			Cache_Backend::$apcu_usable = null;
		}
	}

	public function test_a_stored_false_reads_back_as_false_not_missing(): void {
		[ $table ] = $this->table();
		$table->fill( $this->keyed( 'flag', false ) );

		$this->assertFalse( $table->lookup( 'flag' ), 'RES_NOTFOUND disambiguates a stored false from a miss' );
		$this->assertNull( $table->lookup( 'absent' ) );
	}

	public function test_a_backend_read_error_logs_memcached_result(): void {
		[ $table ]                  = $this->table();
		$this->memd->result_message = 'CONNECTION FAILURE 6620';
		$this->memd->fail_get( Cache_Backend::entry_key( 'prices', 'sku-6620' ), \Memcached::RES_CONNECTION_FAILURE );
		$captured = [];
		Core::set_stderr_handler(
			static function ( string $message ) use ( &$captured ): void {
				$captured[] = $message;
			}
		);

		$this->assertNull( $table->lookup( 'sku-6620' ) );

		$lines = \array_values( \array_filter( $captured, static fn ( string $l ): bool => \str_contains( $l, 'backend read error' ) ) );
		$this->assertCount( 1, $lines );
		$this->assertStringContainsString( 'prices:sku-6620', $lines[0] );
		$this->assertStringContainsString(
			'memcached result ' . \Memcached::RES_CONNECTION_FAILURE . ': CONNECTION FAILURE 6620',
			$lines[0]
		);
	}

	public function test_make_node_wires_the_config_sibling_that_serves_the_verbs(): void {
		// The hand-built interpreter above proves the handlers work; this proves
		// anything can REACH them. Without auto_wire_interpreter() the verbs are
		// declared in the schema and dispatchable from nowhere.
		$ci = new \Newspack_Nodes\Command_Interpreter_Node();
		$ci->name( '_command_interpreter' );
		$ci->sink( new Capture_Sink_Node() );

		$table = $ci->make_node( 'Table', 'ledger', 'invoices', '37' );
		$table->fill( $this->keyed( 'inv-42', [ 'eur' => 8800 ] ) );

		$config = Core::node( 'ledger:config' );
		$this->assertNotNull( $config, 'make_node Table must wire the :config sibling' );
		$this->assertSame( $table, $config->patron() );
		$this->assertSame( 1, $config->dispatch( 'stats' )['INSERT']['answered'], 'the sibling answers for the Table that stored inv-42' );
	}

	public function test_verbs_refuse_a_foreign_patron(): void {
		$ci = new \Newspack_Nodes\Command_Interpreter_Node();
		$ci->name( 'stray:config' );
		$verbs = array_column( \Newspack_Nodes\Table_Node::node_schema()['commands'], 'handler', 'name' );
		foreach ( [ 'stats', 'flush', 'vacuum' ] as $verb ) {
			$e = $this->caught(
				fn () => $verbs[ $verb ]( $ci, [] ),
				"{$verb} answered a foreign patron"
			);
			$this->assertSame( 'no table patron', $e->getMessage() );
		}
	}

	public function test_arguments_read_back(): void {
		[ $table ] = $this->table( 'prices', '300' );
		$this->assertSame( [ 'prices', '300' ], $table->arguments() );
	}

	public function test_store_reports_whether_the_write_landed(): void {
		// A caller that shadows its writes durably — Stats_Store's mirror seam —
		// must not record a set the backend refused, or a failed write is
		// resurrected on cold boot as though it had succeeded.
		$table = Table_Node::table( 'prices', 60 );

		$this->assertTrue( $table->store( 'sku-9', [ 'usd' => 1250 ] ), 'a landed write reports true' );
	}

	public function test_store_reports_false_when_the_backend_refuses(): void {
		$table = Table_Node::table( 'prices', 60 );
		$prev  = Core::$memd;
		// A handle whose set() always fails, as a full or unreachable server does.
		Core::$memd = new class() extends InMemoryMemcached {
			public function set( $key, $value, $expiration = 0 ): bool {
				return false;
			}
		};
		try {
			$this->assertFalse( $table->store( 'sku-9', [ 'usd' => 1250 ] ), 'a refused write reports false' );
		} finally {
			Core::$memd = $prev;
		}
	}

	public function test_ttl_comes_from_the_table_not_the_call(): void {
		[ $table ] = $this->table( 'prices', '300' );

		$table->store( 'sku-9', 'timed' );

		$this->assertEqualsWithDelta(
			\time() + 300,
			$this->memd->expiries()[ Cache_Backend::entry_key( 'prices', 'sku-9' ) ],
			2
		);
	}

	public function test_store_puts_an_entry_where_lookup_finds_it(): void {
		// A ruleset saved from wp-admin is not inside any graph, so there is no
		// node to fill(). Same table, same site scoping, no graph required.
		$table = Table_Node::table( 'prices', 300 );
		$table->store( 'sku-9', [ 'usd' => 1250 ] );

		$this->assertSame( [ 'usd' => 1250 ], $table->lookup( 'sku-9' ) );
		$this->assertSame(
			[ 'usd' => 1250 ],
			$this->memd->get( Cache_Backend::entry_key( 'prices', 'sku-9' ) ),
			'store() must land on the same key fill() writes'
		);
	}

	public function test_store_scopes_by_namespace_like_every_other_write(): void {
		Table_Node::table( 'prices', 37 )->store( 'sku-9', 'here' );
		$this->assertNull( Table_Node::table( 'ledger', 37 )->lookup( 'sku-9' ) );
	}

	public function test_forget_removes_an_entry(): void {
		$table = Table_Node::table( 'prices', 37 );
		$table->store( 'sku-9', 'gone-soon' );
		$table->forget( 'sku-9' );
		$this->assertNull( $table->lookup( 'sku-9' ) );
	}

	public function test_touch_moves_an_entry_s_expiry_to_the_call_s_ttl(): void {
		// A caller refreshing an entry dates it to its own window, so the
		// touch takes the call's lifetime where store() takes the table's.
		$table = Table_Node::table( 'prices', 300 );
		$table->store( 'sku-9', 'held' );
		$this->memd->get_calls = 0;

		$this->assertTrue( $table->touch( 'sku-9', 4471 ) );

		$this->assertEqualsWithDelta(
			\time() + 4471,
			$this->memd->expiries()[ Cache_Backend::entry_key( 'prices', 'sku-9' ) ],
			2
		);
		$this->assertSame( 'held', $table->lookup( 'sku-9' ), 'the value is left as it was' );
		$this->assertSame( 1, $this->memd->touches, 'one touch' );
		$this->assertSame( 1, $this->memd->get_calls, 'and the lookup its only read' );
	}

	public function test_touch_reports_an_absent_entry(): void {
		$table = Table_Node::table( 'prices', 300 );

		$this->assertFalse( $table->touch( 'sku-404', 4471 ) );
		$this->assertArrayNotHasKey( Cache_Backend::entry_key( 'prices', 'sku-404' ), $this->memd->expiries() );
	}

	public function test_touch_reports_a_backend_error_as_unknown_not_absent(): void {
		$table = Table_Node::table( 'prices', 300 );
		$table->store( 'sku-9', 'held' );
		$this->memd->fail_touch( Cache_Backend::entry_key( 'prices', 'sku-9' ), \Memcached::RES_CONNECTION_FAILURE );

		$this->assertNull( $table->touch( 'sku-9', 4471 ) );
	}

	public function test_touch_reports_unknown_with_no_backend(): void {
		$table      = Table_Node::table( 'prices', 300 );
		Core::$memd = null;

		$this->assertNull( $table->touch( 'sku-9', 4471 ) );
	}

	public function test_store_and_forget_survive_a_backend_that_went_away(): void {
		// Every other cache path here fails soft; a ruleset save must not fatal
		// because memcached died after the table was built. A table built with
		// NO backend at all is a configuration error and says so — see
		// test_arguments_without_memcached_throws.
		$table      = Table_Node::table( 'prices', 37 );
		Core::$memd = null;

		$table->store( 'sku-9', 'nowhere' );
		$table->forget( 'sku-9' );
		$this->assertNull( $table->lookup( 'sku-9' ) );
	}

	// --- backed_by: read-through to a durable system of record ------------

	public function test_a_miss_reads_through_to_the_backing_and_lands_in_the_table(): void {
		$table = Table_Node::table( 'prices', 60 );
		$asked = [];
		$table->backed_by(
			static function ( array $keys ) use ( &$asked ): array {
				$asked[] = $keys;
				return [ 'sku-9' => [ 'value' => [ 'usd' => 900 ] ] ];
			}
		);

		$this->assertSame( [ 'usd' => 900 ], $table->lookup( 'sku-9' ), 'the miss was filled from the backing' );
		$this->assertSame( [ [ 'sku-9' ] ], $asked );

		// Landed in the table, so the next read never asks again.
		$table->backed_by( static fn ( array $keys ): array => [] );
		$this->assertSame( [ 'usd' => 900 ], $table->lookup( 'sku-9' ) );
	}

	public function test_a_hit_never_reaches_the_backing(): void {
		$table = Table_Node::table( 'prices', 60 );
		$table->store( 'sku-1', [ 'usd' => 100 ] );
		$table->backed_by( static fn ( array $keys ): array => [ 'sku-1' => [ 'value' => [ 'usd' => 999 ] ] ] );

		$this->assertSame( [ 'usd' => 100 ], $table->lookup( 'sku-1' ), 'the stored value wins over the backing' );
	}

	public function test_store_multi_writes_every_entry_in_one_backend_call(): void {
		// ELN's stats flush issues one read-modify-write per key and two of
		// its loops are per URL, so the write path is where a full-window
		// replay decays. Seeds distinct from every default: three skus,
		// values 707/808/909.
		$table = Table_Node::table( 'prices', 60 );

		$this->assertTrue( $table->store_multi( [
			'sku-707' => [ 'usd' => 707 ],
			'sku-808' => [ 'usd' => 808 ],
			'sku-909' => [ 'usd' => 909 ],
		] ) );

		$this->assertSame(
			[ 'sku-707' => [ 'usd' => 707 ], 'sku-808' => [ 'usd' => 808 ], 'sku-909' => [ 'usd' => 909 ] ],
			$this->mget( $table, 'sku-707', 'sku-808', 'sku-909' ),
			'every entry must be readable back under the caller\'s own key'
		);
	}

	public function test_store_multi_survives_an_all_digit_key(): void {
		// PHP coerces an all-digit array key to int whatever the docblock says,
		// and entry_key() takes a string. A url_hash can be all digits.
		$table = Table_Node::table( 'prices', 60 );
		$this->assertTrue( $table->store_multi( [ '9777777777777' => [ 'usd' => 41 ] ] ) );
		$this->assertSame(
			[ '9777777777777' => [ 'usd' => 41 ] ],
			$this->mget( $table, '9777777777777' )
		);
	}

	public function test_store_multi_writes_nothing_for_an_empty_set(): void {
		$table = Table_Node::table( 'prices', 60 );
		$this->assertTrue( $table->store_multi( [] ), 'an empty batch is a no-op, not a failure' );
	}

	public function test_mget_asks_the_backing_once_for_every_miss(): void {
		$table = Table_Node::table( 'prices', 60 );
		$table->store( 'sku-1', [ 'usd' => 100 ] );
		$calls = 0;
		$table->backed_by(
			static function ( array $keys ) use ( &$calls ): array {
				++$calls;
				return [ 'sku-2' => [ 'value' => [ 'usd' => 200 ] ], 'sku-3' => [ 'value' => [ 'usd' => 300 ] ] ];
			}
		);

		$found = $this->mget( $table, 'sku-1', 'sku-2', 'sku-3' );

		$this->assertSame(
			[ 'sku-1' => [ 'usd' => 100 ], 'sku-2' => [ 'usd' => 200 ], 'sku-3' => [ 'usd' => 300 ] ],
			$found
		);
		$this->assertSame( 1, $calls, 'one backing call for every miss, not one per key' );
	}

	public function test_a_backing_entry_may_carry_its_own_remaining_lifetime(): void {
		// A restored entry resumes the life it had left, not a fresh table TTL.
		$table = Table_Node::table( 'prices', 600 );
		$table->backed_by( static fn ( array $keys ): array => [ 'sku-7' => [ 'value' => [ 'usd' => 700 ], 'ttl' => 5 ] ] );

		$this->assertSame( [ 'usd' => 700 ], $table->lookup( 'sku-7' ) );
		$expiry = $this->memd->expiries()[ Cache_Backend::entry_key( 'prices', 'sku-7' ) ] ?? 0;
		$this->assertEqualsWithDelta( \time() + 5, $expiry, 2, 'stored under the entry\'s own remaining life, not the table\'s 600' );
	}

	/**
	 * Every miss reaches the backing, on every read and through both readers,
	 * and a key the backing did not return leaves nothing in the cache.
	 */
	public function test_every_miss_reaches_the_backing_on_every_read(): void {
		$table = Table_Node::table( 'prices', 600 );
		$calls = [];
		$table->backed_by(
			static function ( array $keys ) use ( &$calls ): array {
				$calls[] = $keys;
				return [ 'sku-2' => [ 'value' => [ 'usd' => 200 ] ] ];
			}
		);

		$this->assertSame( [ 'sku-2' => [ 'usd' => 200 ] ], $this->mget( $table, 'sku-2', 'sku-5', 'sku-6' ) );
		$this->assertNull( $table->lookup( 'sku-5' ) );
		$this->assertSame( [ 'sku-2' => [ 'usd' => 200 ] ], $this->mget( $table, 'sku-2', 'sku-5', 'sku-6' ) );

		$this->assertSame( [ [ 'sku-2', 'sku-5', 'sku-6' ], [ 'sku-5' ], [ 'sku-5', 'sku-6' ] ], $calls );
		$this->assertSame(
			[ Cache_Backend::entry_key( 'prices', 'sku-2' ) ],
			\array_keys( $this->memd->expiries() ),
			'only the value the backing returned is warmed'
		);
	}

	/**
	 * A table reserves no value: whatever sits in an entry's slot is data,
	 * the string an older substrate used to mark an absence included.
	 */
	public function test_no_stored_value_is_reserved(): void {
		$table = Table_Node::table( 'prices', 600 );
		$asked = 0;
		$table->backed_by(
			static function ( array $keys ) use ( &$asked ): array {
				++$asked;
				return [];
			}
		);
		$this->memd->set( Cache_Backend::entry_key( 'prices', 'sku-4471' ), "\0table:absent", 600 );

		$this->assertSame( "\0table:absent", $table->lookup( 'sku-4471' ) );
		$this->assertSame( [ 'sku-4471' => "\0table:absent" ], $this->mget( $table, 'sku-4471' ) );
		$this->assertSame( 0, $asked, 'a hit never reaches the backing' );
	}

	/**
	 * A backing that could not look — out of budget, its record not yet
	 * there — answers null: the read is a miss, nothing is warmed, and the
	 * next read asks again.
	 */
	public function test_a_backing_that_could_not_look_reads_as_a_miss(): void {
		$table    = Table_Node::table( 'prices', 600 );
		$answered = false;
		$table->backed_by(
			static function ( array $keys ) use ( &$answered ): ?array {
				return $answered ? [ 'sku-3' => [ 'value' => [ 'usd' => 300 ] ] ] : null;
			}
		);

		$this->assertNull( $table->lookup( 'sku-3' ), 'unanswered reads as a miss' );
		$this->assertArrayNotHasKey( Cache_Backend::entry_key( 'prices', 'sku-3' ), $this->memd->expiries(), 'and nothing is written against the key' );
		$answered = true;
		$this->assertSame( [ 'usd' => 300 ], $table->lookup( 'sku-3' ), 'the next read asks again' );
	}

	public function test_the_record_is_still_served_when_the_backend_went_away(): void {
		// Warming the table is best-effort. A store that cannot land must not
		// turn a successful read of the system of record into a miss.
		$table = Table_Node::table( 'prices', 60 );
		$table->backed_by( static fn ( array $keys ): array => [ 'sku-4' => [ 'value' => [ 'usd' => 400 ] ] ] );
		Core::$memd = null;

		$this->assertSame( [ 'usd' => 400 ], $table->lookup( 'sku-4' ) );
	}

	/**
	 * A SPENT remaining life is served from the record, and not warmed.
	 *
	 * The backing is the system of record; the cache TTL it was written with is
	 * a FOOTPRINT bound on the cache, not a statement that the data expired.
	 * Refusing a spent entry made the durable tier useless for exactly the data
	 * whose cache lifetime is shortest — event-logger-nodes' fine URL buckets
	 * are kept two hours in memcache and mirrored for twice the stats window,
	 * and the refusal meant an evicted hourly key could never be rebuilt from
	 * them. A backing that wants an entry gone stops returning it; one that
	 * states a spent remainder is saying "serve this, but it is not worth a
	 * cache slot".
	 */
	public function test_an_entry_whose_remaining_life_is_spent_is_still_served(): void {
		$table = Table_Node::table( 'prices', 600 );
		$table->backed_by( static fn ( array $keys ): array => [ 'sku-8' => [ 'value' => [ 'usd' => 800 ], 'ttl' => 0 ] ] );

		$this->assertSame( [ 'usd' => 800 ], $table->lookup( 'sku-8' ), 'the record answers' );
		$this->assertArrayNotHasKey(
			Cache_Backend::entry_key( 'prices', 'sku-8' ),
			$this->memd->expiries(),
			'and takes no cache slot: a spent remainder is not worth warming'
		);
	}

	public function test_lookup_multi_returns_found_only_keyed_by_the_callers_key(): void {
		$table = Table_Node::table( 'prices', 60 );
		$table->store( 'sku-1', [ 'usd' => 100 ] );
		$table->store( 'sku-3', [ 'usd' => 300 ] );

		$this->assertSame(
			[ 'sku-1' => [ 'usd' => 100 ], 'sku-3' => [ 'usd' => 300 ] ],
			$table->lookup_multi( [ 'sku-1', 'sku-2', 'sku-3' ] ),
			'absent keys are omitted, present ones keyed as the caller asked'
		);
	}

	public function test_lookup_multi_reports_a_broken_batch_to_a_caller_that_asks(): void {
		$table = Table_Node::table( 'prices', 60 );
		$table->store( 'sku-6120', [ 'usd' => 6120 ] );
		Core::$memd = new class() extends InMemoryMemcached {
			public function getMulti( array $keys, int $get_flags = 0 ): array|false {
				return false;
			}
		};

		$failed = false;
		$this->assertSame( [], $table->lookup_multi( [ 'sku-6120' ], $failed ) );
		$this->assertTrue( $failed );
	}

	public function test_lookup_multi_reports_a_backing_rescue_as_a_failed_batch_still(): void {
		$table = Table_Node::table( 'prices', 60 );
		$table->backed_by( static fn ( array $keys ): array => [ 'sku-71' => [ 'value' => [ 'usd' => 71 ] ] ] );
		Core::$memd = new class() extends InMemoryMemcached {
			public function getMulti( array $keys, int $get_flags = 0 ): array|false {
				return false;
			}
		};

		$failed = false;
		$this->assertSame( [ 'sku-71' => [ 'usd' => 71 ] ], $table->lookup_multi( [ 'sku-71', 'sku-72' ], $failed ) );
		$this->assertTrue( $failed, 'no cache backend answered, whatever the backing returned' );
	}

	public function test_lookup_multi_reports_no_failure_for_a_read_that_answered(): void {
		$table = Table_Node::table( 'prices', 60 );
		$table->store( 'sku-5150', [ 'usd' => 5150 ] );

		$failed = true;
		$this->assertSame( [ 'sku-5150' => [ 'usd' => 5150 ] ], $table->lookup_multi( [ 'sku-5150', 'sku-absent' ], $failed ) );
		$this->assertFalse( $failed );
	}

	public function test_lookup_multi_reports_a_lost_backend_as_a_failed_read(): void {
		$table      = Table_Node::table( 'prices', 60 );
		$prev       = Core::$memd;
		Core::$memd = null;
		try {
			$failed = false;
			$this->assertSame( [], $table->lookup_multi( [ 'sku-1' ], $failed ) );
			$this->assertTrue( $failed, 'no backend answered, so nothing was read' );
		} finally {
			Core::$memd = $prev;
		}
	}

	public function test_a_request_naming_an_unknown_verb_is_refused_to_its_asker(): void {
		// A silent drop would read as an empty table; a refusal says why.
		[ $table, $sink ] = $this->table();
		$logged           = [];
		\add_action(
			'newspack_nodes/stderr',
			static function ( string $line ) use ( &$logged ): void {
				$logged[] = $line;
			}
		);

		$table->fill( $this->request( 'SET sku-9 12', 'asker-12' ) );

		$this->assertCount( 1, $sink->captured );
		$this->assertSame( [ Message::TM_ERROR, 'asker-12', "SET: unknown verb\n" ], [ $sink->captured[0][ Message::TYPE ], $sink->captured[0][ Message::TO ], $sink->captured[0][ Message::VALUE ] ] );
		$this->assertCount( 1, $logged );
		$this->assertStringContainsString( 'ERROR: bad request: SET: unknown verb - from: asker-12', $logged[0] );
		$this->assertNull( $table->lookup( 'sku-9' ) );
	}

	/** The eight verbs are catalogued for `help` and the Inspector, and answered by fill(). */
	public function test_the_verbs_are_declared_without_a_handler_and_help_lists_them(): void {
		$requests = Table_Node::node_schema()['requests'];

		$this->assertSame( [ 'GET', 'MGET', 'SMEMBERS', 'TOUCH', 'RM', 'MSET', 'ADD', 'SADD' ], \array_column( $requests, 'name' ) );
		foreach ( $requests as $request ) {
			$this->assertArrayNotHasKey( 'handler', $request );
			$this->assertNotSame( '', $request['reply_shape'] ?? '' );
		}
		$this->assertMatchesRegularExpression(
			'/^REQUESTS\n.*\bGET\b/m',
			\Newspack_Nodes\Node_Schema_Help::render( 'Table', Table_Node::node_schema() )
		);
	}

	public function test_the_config_verbs_are_the_ones_no_request_answers(): void {
		$this->assertSame( [ 'stats', 'reset_stats', 'flush', 'vacuum' ], \array_column( Table_Node::node_schema()['commands'], 'name' ), 'GET and RM are requests, never :config verbs' );
	}

	public function test_each_structured_request_declares_its_one_json_map(): void {
		$requests = \array_column( Table_Node::node_schema()['requests'], 'args', 'name' );
		$values   = \array_column( Table_Node::node_schema()['requests'], 'value', 'name' );
		$this->assertSame( [ 'MSET' => 'struct', 'ADD' => 'struct', 'SADD' => 'struct' ], $values, 'the three structured requests declare their VALUE, and no other request does' );
		foreach ( [ 'MSET', 'ADD', 'SADD' ] as $verb ) {
			$this->assertCount( 1, $requests[ $verb ], $verb );
			$this->assertSame( [ 'name' => 'map', 'type' => 'json', 'required' => true ], \array_diff_key( $requests[ $verb ][0], [ 'description' => true ] ), $verb );
			$this->assertStringContainsString( ' => [ ', $requests[ $verb ][0]['description'], "{$verb} describes its payload shape" );
		}
	}

	/** Verbs are case-sensitive, as Tachikoma's are: `get` is no verb, and is refused. */
	public function test_a_lowercase_get_is_refused(): void {
		[ $table, $sink ] = $this->table();
		$table->fill( $this->keyed( 'sku-7713', "kea\n" ) );
		$sink->captured = [];

		$table->fill( $this->request( 'get sku-7713' ) );

		$this->assertSame( [ [ Message::TM_ERROR, "get: unknown verb\n" ] ], \array_map( static fn ( array $r ): array => [ $r[ Message::TYPE ], $r[ Message::VALUE ] ], $sink->captured ) );
	}

	public function test_a_backend_read_error_is_said_out_loud(): void {
		// Null reads as "empty table" downstream, so a broken backend that stays
		// quiet is indistinguishable from a cold one.
		$table = new class() extends Table_Node {
			/** @var string[] */
			public array $warnings = [];
		};
		$table->arguments( [ 'prices', '37' ] );
		$prev = Core::$memd;
		// A handle whose get() fails with something other than NOTFOUND.
		Core::$memd = new class() extends InMemoryMemcached {
			public function get( $key, $cache_cb = null, $flags = 0 ): mixed {
				return false;
			}
			public function getResultCode(): int {
				return \Memcached::RES_SERVER_ERROR;
			}
		};
		try {
			$this->assertNull( $table->lookup( 'sku-9' ), 'a failed read is still a null' );
		} finally {
			Core::$memd = $prev;
		}
	}

	public function test_a_table_without_a_namespace_is_refused(): void {
		// The namespace is what scopes lookup(); an empty one would silently
		// share a keyspace with every other unnamed table.
		$this->expectException( \InvalidArgumentException::class );
		Table_Node::table( '', 37 );
	}

	public function test_accumulating_yields_nothing_without_an_accumulator(): void {
		$table = Table_Node::table( 'prices', 60 );

		$this->assertSame( [], \iterator_to_array( $table->accumulating() ) );
	}

	// ── Accumulator: an opt-in in-memory tier the caller drains ────────────

	private function accumulating_table(): Table_Node {
		return Table_Node::table( 'agg', 60 )->accumulator( 1000, 5 );
	}

	public function test_accumulate_holds_the_value_without_writing_it(): void {
		// The tier Flame_Builder needs: un-persisted state it folds into and
		// drains on its own cadence, NOT a write-through cache of storage.
		$table = $this->accumulating_table();

		$table->accumulate( 'h1', [ 'count' => 3 ] );

		$this->assertNull( $table->lookup( 'h1' ), 'accumulate() must not reach the backend' );
		$this->assertSame( [ 'count' => 3 ], $table->accumulated( 'h1' ) );
	}

	public function test_accumulated_falls_back_to_stored_when_nothing_is_held(): void {
		$table = $this->accumulating_table();
		$table->store( 'h2', [ 'count' => 9 ] );

		$this->assertSame( [ 'count' => 9 ], $table->accumulated( 'h2' ), 'a cold key reads through to storage' );
	}

	public function test_accumulating_walks_what_is_held_for_the_drain(): void {
		$table = $this->accumulating_table();
		$table->accumulate( 'h1', [ 'count' => 1 ] );
		$table->accumulate( 'h2', [ 'count' => 2 ] );

		$seen = [];
		foreach ( $table->accumulating() as $key => $value ) {
			$seen[ (string) $key ] = $value;
		}

		$this->assertSame( [ 'h1' => [ 'count' => 1 ], 'h2' => [ 'count' => 2 ] ], $seen );
	}

	public function test_a_drain_does_not_clear_what_is_held(): void {
		// set_url_stats() overwrites the whole aggregate, so draining twice is
		// idempotent; clearing here would lose the accumulation between flushes.
		$table = $this->accumulating_table();
		$table->accumulate( 'h1', [ 'count' => 1 ] );

		foreach ( $table->accumulating() as $key => $value ) {
			$table->store( (string) $key, $value );
		}

		$this->assertSame( [ 'count' => 1 ], $table->accumulated( 'h1' ), 'still held after the drain' );
	}

	public function test_reset_drops_what_is_held(): void {
		$table = $this->accumulating_table();
		$table->accumulate( 'h1', [ 'count' => 1 ] );

		$table->reset();

		$this->assertSame( [], \iterator_to_array( $table->accumulating() ) );
	}

	public function test_accumulating_without_opting_in_is_refused(): void {
		// Silently dropping the value would lose counts; say so instead.
		$table = Table_Node::table( 'agg', 60 );

		$this->expectException( \LogicException::class );
		$table->accumulate( 'h1', [ 'count' => 1 ] );
	}

	// ── Backends: a Table names where it keeps its entries ────────────────

	public function test_a_named_backend_is_kept_after_its_partition_unbinds_and_memcache_leaves(): void {
		$dir                    = $this->base_dir( 'table-kea-' );
		Core::$var['partition'] = '3';
		try {
			$table = new Table_Node();
			$table->name( 'lab-7:kea' );
			$table->arguments( [ 'kea:p3', '777', 'sqlite' ] );
		} finally {
			unset( Core::$var['partition'] );
		}
		$this->assertTrue( $table->store( 'sku-41', [ 'usd' => 1250 ] ) );
		$this->assertFileExists( "{$dir}/tables/lab-7:kea.p3.sqlite" );
		Core::$memd = null;
		$this->assertSame( [ 'usd' => 1250 ], $table->lookup( 'sku-41' ), 'memcache leaving does not move a named backend' );
	}

	public function test_mount_names_the_partition_and_opens_its_file(): void {
		$dir = $this->base_dir( 'table-mount-' );
		( new Sqlite_Arm( Table_Node::file( 'lab-7:kea', 3 ), 'kea:p3' ) )->set( 'kea:p3:sku-42', [ 'usd' => 4200 ], 0 );
		$sink  = new Capture_Sink_Node();
		$table = Table_Node::mount( 'lab-7:kea', 3, [ 'namespace' => 'kea:p3', 'ttl' => 777, 'backend' => 'sqlite' ], $sink );
		$this->assertSame( 'lab-7:kea.p3', $table->name() );
		$this->assertSame( "{$dir}/tables/lab-7:kea.p3.sqlite", Table_Node::file( 'lab-7:kea', 3 ) );
		$this->assertSame( [ 'kea:p3', '777', 'sqlite' ], $table->arguments() );
		$this->assertSame( $table, Core::node( 'lab-7:kea.p3' ) );
		$table->fill( $this->request( 'GET sku-42' ) );
		$this->assertSame( [ 'usd' => 4200 ], $sink->captured[0][ Message::VALUE ], 'a mounted Table replies through the sink it was given' );
	}

	public function test_a_mounted_table_dumps_no_replayable_make_node_line(): void {
		$this->base_dir( 'table-dump-' );
		new Sqlite_Arm( Table_Node::file( 'lab-7:kea', 3 ), 'kea:p3' );
		$interpreter = new \Newspack_Nodes\Command_Interpreter_Node();
		$interpreter->name( '_command_interpreter' );
		$table = Table_Node::mount( 'lab-7:kea', 3, [ 'namespace' => 'kea:p3', 'ttl' => 777, 'backend' => 'sqlite' ], $interpreter );

		$this->assertSame( '', $table->dump_config() );
		$this->assertStringNotContainsString( 'make_node Table', $interpreter->dispatch( 'dump_config' ) );
	}

	public function test_an_unmounted_make_node_table_round_trips_through_dump_config(): void {
		$this->base_dir( 'table-trip-' );
		$interpreter = new \Newspack_Nodes\Command_Interpreter_Node();
		$interpreter->name( '_command_interpreter' );
		Core::$var['partition'] = '3';
		try {
			$interpreter->make_node( 'Table', 'lab-7:kea', 'kea:p3', '777', 'sqlite' );
		} finally {
			unset( Core::$var['partition'] );
		}

		$this->assertSame( "make_node Table lab-7:kea kea:p3 777 sqlite\n", $interpreter->dispatch( 'dump_config', [ '^lab-7:kea$' ] ) );
	}

	public function test_a_mount_raises_a_failed_teardown_beside_the_failure_that_began_it(): void {
		$this->base_dir( 'table-teardown-' );
		new Sqlite_Arm( Table_Node::file( 'lab-7:kea', 3 ), 'kea:p3' );
		$refusal = new \LogicException( 'teardown refused-37' );
		// A sibling whose teardown refuses; the Table's own cascade reaches it.
		$sibling = new class( $refusal ) extends Node {
			public function __construct( private \Throwable $refusal ) {
				parent::__construct();
			}

			public function remove_node(): void {
				parent::remove_node();
				throw $this->refusal;
			}
		};
		// The open seam runs once the mount is named: publish, then refuse.
		Sqlite_Arm::$available = static function () use ( $sibling ): bool {
			$table = Core::node( 'lab-7:kea.p3' );
			\Closure::bind(
				function ( Node $stub ): void {
					$this->publish_sibling( 'kea', $stub );
				},
				$table,
				Node::class
			)( $sibling );
			return false;
		};
		$caught = null;
		try {
			Table_Node::mount( 'lab-7:kea', 3, [ 'namespace' => 'kea:p3', 'ttl' => 37, 'backend' => 'sqlite' ], new Capture_Sink_Node() );
		} catch ( \Throwable $e ) {
			$caught = $e;
		} finally {
			Sqlite_Arm::$available = null;
		}

		$this->assertInstanceOf( \Newspack_Nodes\Failures::class, $caught );
		$this->assertSame( 'Table lab-7:kea: sqlite backend needs the pdo_sqlite extension', $caught->all()[0]->getMessage() );
		$this->assertSame( $refusal, $caught->all()[1] );
		$this->assertNull( Core::node( 'lab-7:kea.p3' ), 'the Table is unregistered whatever its sibling threw' );
	}

	public function test_a_mount_escapes_a_refused_name_once(): void {
		try {
			Table_Node::mount( "lab'kea", 3, [ 'namespace' => 'kea:p3', 'ttl' => 37, 'backend' => 'sqlite' ], new Capture_Sink_Node() );
			$this->fail( 'a quoted name was mounted' );
		} catch ( \InvalidArgumentException $e ) {
			$this->assertSame( 'Table name lab&#039;kea cannot name a file', $e->getMessage() );
		}
	}

	public function test_a_wpdb_arm_refusal_reaches_the_table_escaped_once(): void {
		$db              = $this->use_wpdb();
		$db->base_prefix = 'kea7_';
		$namespace       = \str_repeat( 'k', 190 ) . '&p3';
		$e = $this->caught( fn () => $this->table( $namespace, '37', 'wpdb' ), 'a namespace wider than the column was held' );
		$this->assertSame( 'Table prices:table: wpdb backend cannot hold namespace ' . \str_repeat( 'k', 190 ) . '&amp;p3', $e->getMessage() );
	}

	public function test_a_sqlite_arm_refusal_reaches_the_table_escaped_once(): void {
		$dir = $this->base_dir( 'table-a&b-' );
		\mkdir( "{$dir}/tables/lab-7:kea.p3.sqlite", 0700, true );
		Core::$var['partition'] = '3';
		try {
			$table = new Table_Node();
			$table->name( 'lab-7:kea' );
			$e = $this->caught( static fn () => $table->arguments( [ 'kea:p3', '37', 'sqlite' ] ), 'a directory opened as a database' );
		} finally {
			unset( Core::$var['partition'] );
		}
		$this->assertStringStartsWith( 'Table lab-7:kea: sqlite backend could not open ' . \esc_html( $dir ) . '/tables/lab-7:kea.p3.sqlite: ', $e->getMessage() );
		$this->assertStringNotContainsString( '&amp;amp;', $e->getMessage() );
	}

	public function test_a_mount_whose_backend_cannot_open_leaves_nothing_registered(): void {
		Sqlite_Arm::$available = static fn (): bool => false;
		try {
			$this->caught(
				static fn () => Table_Node::mount( 'lab-7:kea', 3, [ 'namespace' => 'kea:p3', 'ttl' => 37, 'backend' => 'sqlite' ], new Capture_Sink_Node() ),
				'a mount whose backend cannot open was built'
			);
		} finally {
			Sqlite_Arm::$available = null;
		}
		$this->assertNull( Core::node( 'lab-7:kea.p3' ) );
		$this->assertNull( Core::node( 'lab-7:kea.p3:config' ) );
	}

	public function test_a_namespace_holding_whitespace_is_refused(): void {
		$this->expectException( \InvalidArgumentException::class );
		$this->expectExceptionMessage( 'Table requires a non-empty namespace holding no whitespace' );
		$this->table( "kea p3", '37' );
	}

	public function test_an_unknown_backend_is_refused(): void {
		$this->expectExceptionMessage( 'Table backend must be one of auto, memcache, apcu, sqlite, wpdb, not redis' );
		$this->table( 'prices', '37', 'redis' );
	}

	public function test_a_ttl_that_is_not_a_whole_number_is_refused(): void {
		$this->expectExceptionMessage( 'Table prices:table needs a TTL of at least 1 whole second, not soon' );
		$this->table( 'prices', 'soon' );
	}

	public function test_a_ttl_below_one_second_is_refused_naming_the_table(): void {
		[ $table ] = $this->table( 'prices', '37' );
		foreach ( [ '0', '-3' ] as $ttl ) {
			try {
				$table->arguments( [ 'prices', $ttl ] );
				$this->fail( "a TTL of {$ttl} was taken" );
			} catch ( \InvalidArgumentException $e ) {
				$this->assertSame( "Table prices:table needs a TTL of at least 1 whole second, not {$ttl}", $e->getMessage() );
			}
		}
		$this->assertSame( [ 'prices', '37' ], $table->arguments(), 'a refusal leaves the Table as it was' );
	}

	public function test_a_missing_ttl_is_refused_naming_the_table(): void {
		foreach ( [ 'kea-bare' => [ 'prices' ], 'kea-blank' => [ 'prices', '' ] ] as $name => $args ) {
			$table = new Table_Node();
			$table->name( $name );
			try {
				$table->arguments( $args );
				$this->fail( 'a Table took no TTL' );
			} catch ( \InvalidArgumentException $e ) {
				$this->assertSame( "Table {$name} needs a TTL", $e->getMessage() );
			}
		}
	}

	public function test_a_refused_ttl_is_escaped_once(): void {
		try {
			$this->table( 'prices', 'a&b' );
			$this->fail( 'a TTL of a&b was taken' );
		} catch ( \InvalidArgumentException $e ) {
			$this->assertSame( 'Table prices:table needs a TTL of at least 1 whole second, not a&amp;b', $e->getMessage() );
		}
	}

	public function test_table_refuses_a_ttl_below_one_second(): void {
		foreach ( [ 0, -3 ] as $ttl ) {
			try {
				Table_Node::table( 'prices', $ttl );
				$this->fail( "table() took a TTL of {$ttl}" );
			} catch ( \InvalidArgumentException $e ) {
				$this->assertSame( "Table prices needs a TTL of at least 1 whole second, not {$ttl}", $e->getMessage() );
			}
		}
	}

	public function test_touch_refuses_a_ttl_below_one_second(): void {
		$table = Table_Node::table( 'prices', 37 );
		$table->store( 'sku-9', 'timed' );
		foreach ( [ 0, -3 ] as $ttl ) {
			try {
				$table->touch( 'sku-9', $ttl );
				$this->fail( "touch() took a TTL of {$ttl}" );
			} catch ( \InvalidArgumentException $e ) {
				$this->assertSame( "Table prices needs a TTL of at least 1 whole second, not {$ttl}", $e->getMessage() );
			}
		}
		$this->assertEqualsWithDelta( \time() + 37, $this->memd->expiries()[ Cache_Backend::entry_key( 'prices', 'sku-9' ) ], 2, 'the refused touch left the expiry alone' );
	}

	public function test_the_ttl_positional_is_required_and_declares_no_default(): void {
		$ttl = \array_values( \array_filter( Table_Node::node_schema()['arguments'], static fn ( array $arg ): bool => 'ttl' === $arg['name'] ) )[0];
		$this->assertTrue( $ttl['required'] );
		$this->assertArrayNotHasKey( 'default', $ttl, 'the make_node line is the one place a Table\'s TTL lives' );
	}

	public function test_a_cooperative_stop_raised_while_opening_propagates_unwrapped(): void {
		$stop                   = new \Newspack_Nodes\Worker_Should_Stop( 'stop 37' );
		Sqlite_Arm::$available  = static fn (): bool => throw $stop;
		Core::$var['partition'] = '3';
		try {
			$this->assertSame( $stop, $this->caught( fn () => $this->table( 'kea:p3', '37', 'sqlite' ), 'the stop was swallowed' ) );
		} finally {
			Sqlite_Arm::$available = null;
			unset( Core::$var['partition'] );
		}
	}

	public function test_an_unmounted_sqlite_table_without_a_bound_partition_is_refused(): void {
		unset( Core::$var['partition'] );
		$e = $this->caught( fn () => $this->table( 'kea:p3', '37', 'sqlite' ), 'a sqlite Table opened with no partition' );
		$this->assertNotInstanceOf( Table_Unavailable::class, $e, 'a missing partition is the declaration\'s fault' );
		$this->assertSame( 'Table prices:table: a sqlite backend needs a bound partition', $e->getMessage() );
	}

	/**
	 * A backend that cannot open is Table_Unavailable, naming the Table and
	 * carrying the arm's own refusal, escaped once, as its previous.
	 *
	 * @param \Closure(): mixed $open    Builds the Table.
	 * @param string            $message The whole refusal, `Table <name>: <cause>`.
	 */
	private function assert_unavailable( \Closure $open, string $message ): void {
		$e = $this->caught( $open, 'a backend that cannot open was built' );
		$this->assertInstanceOf( Table_Unavailable::class, $e, \get_class( $e ) . ": {$e->getMessage()}" );
		$this->assertSame( $message, $e->getMessage() );
		$this->assertNotNull( $e->getPrevious() );
		$this->assertStringEndsWith( \esc_html( $e->getPrevious()->getMessage() ), $message );
	}

	public function test_a_missing_pdo_sqlite_is_table_unavailable(): void {
		Sqlite_Arm::$available  = static fn (): bool => false;
		Core::$var['partition'] = '3';
		try {
			$this->assert_unavailable( fn () => $this->table( 'kea:p3', '37', 'sqlite' ), 'Table prices:table: sqlite backend needs the pdo_sqlite extension' );
		} finally {
			Sqlite_Arm::$available = null;
			unset( Core::$var['partition'] );
		}
	}

	public function test_a_sqlite_file_that_cannot_open_is_table_unavailable(): void {
		$dir = $this->base_dir( 'table-unopenable-' );
		\mkdir( "{$dir}/tables/lab-7:kea.p3.sqlite", 0700, true );
		Core::$var['partition'] = '3';
		try {
			$table = new Table_Node();
			$table->name( 'lab-7:kea' );
			$this->assert_unavailable( static fn () => $table->arguments( [ 'kea:p3', '37', 'sqlite' ] ), "Table lab-7:kea: sqlite backend could not open {$dir}/tables/lab-7:kea.p3.sqlite: SQLSTATE[HY000] [14] unable to open database file" );
		} finally {
			unset( Core::$var['partition'] );
		}
	}

	public function test_a_sqlite_directory_that_cannot_be_written_is_table_unavailable(): void {
		$dir = $this->base_dir( 'table-unwritable-' );
		\mkdir( "{$dir}/tables", 0500 );
		try {
			$this->assert_unavailable( static fn () => Table_Node::table( 'kea:p3', 37, 'sqlite' ), "Table kea:p3: sqlite backend could not open {$dir}/tables/kea:p3.p0.sqlite: SQLSTATE[HY000] [14] unable to open database file" );
		} finally {
			\chmod( "{$dir}/tables", 0700 );
		}
	}

	public function test_a_wpdb_table_the_server_will_not_create_is_table_unavailable(): void {
		$db                       = $this->use_wpdb();
		$db->base_prefix          = 'kea9_';
		$db->deny['CREATE TABLE'] = 'CREATE command denied';
		$this->assert_unavailable( fn () => $this->table( 'kea:p3', '37', 'wpdb' ), 'Table prices:table: wpdb backend could not create kea9_newspack_nodes_table: CREATE command denied' );
	}

	public function test_a_wpdb_packet_limit_the_server_will_not_say_fails_the_first_write(): void {
		$db                               = $this->use_wpdb();
		$db->base_prefix                  = 'kea9_';
		$db->deny['@@max_allowed_packet'] = 'SELECT command denied 1131';
		[ $table ]                        = $this->table( 'kea:p3', '37', 'wpdb' );
		$this->assertFalse( $table->store( 'sku-1131', 1131 ) );
		$this->assertSame( 'wpdb kea9_newspack_nodes_table: could not read max_allowed_packet: SELECT command denied 1131', $table->last_failure() );
	}

	public function test_a_memcache_table_with_no_handle_is_table_unavailable(): void {
		Core::$memd = null;
		$this->assert_unavailable( fn () => $this->table( 'kea:p3', '37', 'memcache' ), 'Table prices:table: memcache backend has no memcached handle' );
	}

	public function test_an_apcu_table_where_apcu_is_unusable_is_table_unavailable(): void {
		Cache_Backend::$apcu_usable = static fn (): bool => false;
		try {
			$this->assert_unavailable( fn () => $this->table( 'kea:p3', '37', 'apcu' ), 'Table prices:table: apcu backend is not usable here' );
		} finally {
			Cache_Backend::$apcu_usable = null;
		}
	}

	/**
	 * A Table built fresh under `$name`, so one refusal cannot leave a
	 * registration that makes the next read as a name collision.
	 *
	 * @param list<string> $args The make_node arguments.
	 */
	private function named_table( string $name, array $args ): void {
		$table = new Table_Node();
		$table->name( $name );
		$table->arguments( $args );
	}

	public function test_a_declaration_the_table_refuses_is_not_table_unavailable(): void {
		$dir             = $this->base_dir( 'table-declared-' );
		$db              = $this->use_wpdb();
		$db->base_prefix = 'kea9_';
		$wide            = \str_repeat( 'k', 192 );
		$refusals        = [
			'Table kea-ttl needs a TTL of at least 1 whole second, not soon' => fn () => $this->named_table( 'kea-ttl', [ 'kea:p3', 'soon', 'sqlite' ] ),
			'Table backend must be one of auto, memcache, apcu, sqlite, wpdb, not redis' => fn () => $this->named_table( 'kea-redis', [ 'kea:p3', '37', 'redis' ] ),
			"Table kea-wide: wpdb backend cannot hold namespace {$wide}" => fn () => $this->named_table( 'kea-wide', [ $wide, '37', 'wpdb' ] ),
			'Table lab..kea: Table name lab..kea cannot name a file' => fn () => $this->named_table( 'lab..kea', [ 'kea:p3', '37', 'sqlite' ] ),
			'Table kea-base: base_directory not configured' => function () use ( $dir ): void {
				$this->use_base_dir( $dir, [ 'base_directory' => '' ] );
				$this->named_table( 'kea-base', [ 'kea:p3', '37', 'sqlite' ] );
			},
			"Table kea-link: Path {$dir}/tables resolves to " => function () use ( $dir ): void {
				$this->use_base_dir( $dir );
				\mkdir( "{$dir}/elsewhere", 0700 );
				\symlink( "{$dir}/elsewhere", "{$dir}/tables" );
				$this->named_table( 'kea-link', [ 'kea:p3', '37', 'sqlite' ] );
			},
		];
		Core::$var['partition'] = '3';
		try {
			foreach ( $refusals as $message => $open ) {
				$e = null;
				try {
					$open();
				} catch ( \RuntimeException | \LogicException $e ) {
					$this->assertNotInstanceOf( Table_Unavailable::class, $e, $message );
					$this->assertStringStartsWith( $message, $e->getMessage() );
				}
				$this->assertNotNull( $e, "{$message} was taken" );
			}
		} finally {
			unset( Core::$var['partition'] );
		}
	}

	public function test_a_named_memcache_backend_writes_through_memcached(): void {
		[ $table ] = $this->table( 'kea:p3', '37', 'memcache' );
		$this->assertTrue( $table->store( 'sku-41', 'kea' ) );
		$this->assertSame( 'kea', $this->memd->get( Cache_Backend::entry_key( 'kea:p3', 'sku-41' ) ) );
	}

	public function test_a_wpdb_table_keeps_its_rows_in_the_shared_table(): void {
		$db                    = $this->use_wpdb();
		$db->base_prefix       = 'kea7_';
		$table = Table_Node::table( 'kea:p3', 37, 'wpdb' );
		$this->assertTrue( $table->store_multi( [ 'sku-41' => [ 'usd' => 41 ], 'sku-43' => [ 'usd' => 43 ] ] ) );
		$this->assertSame(
			[ [ 'n' => 2 ] ],
			$db->get_results( "SELECT COUNT(*) AS n FROM kea7_newspack_nodes_table WHERE namespace = 'kea:p3'" ),
			'the rows are in the shared table, under the namespace'
		);
		$this->assertSame( [], $this->memd->keys(), 'and nowhere in memcached' );
		Core::$memd = null;
		$this->assertSame( [ 'sku-41' => [ 'usd' => 41 ], 'sku-43' => [ 'usd' => 43 ] ], $this->mget( $table, 'sku-41', 'sku-43', 'sku-44' ) );
		$this->assertTrue( $table->touch( 'sku-41', 777 ) );
		$table->forget( 'sku-43' );
		$this->assertNull( $table->lookup( 'sku-43' ) );
		$this->assertSame( [ 'kea:p3', '37', 'wpdb' ], $table->arguments() );
	}

	public function test_a_name_that_cannot_name_a_file_is_refused(): void {
		$this->expectExceptionMessage( 'Table name ../kea cannot name a file' );
		Table_Node::stem( '../kea', 3 );
	}

	public function test_no_path_separator_nul_or_parent_reaches_the_file_name(): void {
		foreach ( [ 'lab/kea', 'lab\\kea', "lab\0kea", 'lab..kea', '..', '' ] as $name ) {
			try {
				Table_Node::file( $name, 3 );
				$this->fail( "'{$name}' named a file" );
			} catch ( \InvalidArgumentException $e ) {
				$this->assertStringEndsWith( ' cannot name a file', $e->getMessage() );
			}
		}
		$this->assertSame( 'lab-7_kea.v2:x.p3', Table_Node::stem( 'lab-7_kea.v2:x', 3 ) );
	}

	public function test_a_sqlite_table_named_outside_its_directory_is_refused_naming_itself(): void {
		Core::$var['partition'] = '3';
		try {
			$table = new Table_Node();
			$table->name( 'lab..kea' );
			$this->expectExceptionMessage( 'Table lab..kea: Table name lab..kea cannot name a file' );
			$table->arguments( [ 'kea:p3', '37', 'sqlite' ] );
		} finally {
			unset( Core::$var['partition'] );
		}
	}

	public function test_a_refused_file_name_is_escaped_once(): void {
		Core::$var['partition'] = '3';
		try {
			$table = new Table_Node();
			$table->name( "lab'kea" );
			$e = $this->caught( static fn () => $table->arguments( [ 'kea:p3', '37', 'sqlite' ] ), 'a quoted name named a file' );
		} finally {
			unset( Core::$var['partition'] );
		}
		$this->assertSame( 'Table lab&#039;kea: Table name lab&#039;kea cannot name a file', $e->getMessage() );
	}

	public function test_every_write_refuses_a_key_holding_whitespace(): void {
		[ $table, $sink ] = $this->table();
		$this->assertFalse( $table->store( 'sku 41', 1 ) );
		$this->assertFalse( $table->store_multi( [ 'sku-43' => 1, "sku\n44" => 2 ] ) );
		$this->assertNull( $table->lookup( 'sku-43' ) );
		$table->fill( $this->keyed( "sku\t45", 'v' ) );
		$this->assertSame( [], $sink->captured, 'a refused INSERT is neither stored nor forwarded' );
		$this->assertNull( $table->lookup( "sku\t45" ) );
	}

	public function test_a_refused_insert_is_said_out_loud_once(): void {
		[ $table ] = $this->table();
		$lines     = [];
		\add_action(
			'newspack_nodes/stderr',
			static function ( string $line ) use ( &$lines ): void {
				$lines[] = $line;
			}
		);

		$table->fill( $this->keyed( 'sku 46', [ 'usd' => 46 ] ) );
		$table->fill( $this->keyed( "sku\t47", [ 'usd' => 47 ] ) );

		$refusals = \array_values( \array_filter( $lines, static fn ( string $l ): bool => \str_contains( $l, 'refused an INSERT' ) ) );
		$this->assertCount( 1, $refusals, 'rate-limited to one line' );
		$this->assertStringEndsWith( "prices:table: ERROR: refused an INSERT whose KEY is empty or holds whitespace\n", $refusals[0] );
	}

	public function test_the_schema_declares_the_backend_positional(): void {
		$args = \array_column( Table_Node::node_schema()['arguments'], null, 'name' );
		$this->assertSame( 'auto', $args['backend']['default'] );
	}

	// ── The purge on the Router tick, and the vacuum verb ─────────────────

	/** A sqlite Table of `$ttl` built as a worker's make_node builds one, and its file's row count. */
	private function durable( int $ttl ): array {
		Core::$var['partition'] = '3';
		try {
			$table = new Table_Node();
			$table->name( 'lab-7:kea' );
			$table->arguments( [ 'kea:p3', (string) $ttl, 'sqlite' ] );
		} finally {
			unset( Core::$var['partition'] );
		}
		$table->sink( new Capture_Sink_Node() );
		$file = Table_Node::file( 'lab-7:kea', 3 );
		$rows  = static fn (): int => (int) ( new \PDO( 'sqlite:' . $file ) )->query( 'SELECT COUNT(*) FROM kv' )->fetchColumn();
		return [ $table, $rows ];
	}

	/** A Router the tick fires through, as a worker mounts one. */
	private function router(): \Newspack_Nodes\Router_Node {
		$router = new \Newspack_Nodes\Router_Node();
		$router->name( \Newspack_Nodes\Node_Names::ROUTER );
		return $router;
	}

	public function test_the_router_tick_purges_a_durable_table_once_a_minute(): void {
		$this->base_dir( 'table-purge-' );
		$now              = 1790000000.0;
		Core::$clock      = static function () use ( &$now ): float {
			return $now;
		};
		Core::$now        = $now;
		$router           = $this->router();
		[ $table, $rows ] = $this->durable( 37 );
		$table->store_multi( [ 'sku-41' => 1, 'sku-42' => 2 ] );
		$now      += 37;
		Core::$now = $now;
		$router->fire_cb();
		$this->assertSame( 0, $rows() );
		$table->store( 'sku-43', 3 );
		$now      += 37;
		Core::$now = $now;
		$router->fire_cb();
		$this->assertSame( 1, $rows(), 'the next purge waits out its minute' );
		$now      += 60;
		Core::$now = $now;
		$router->fire_cb();
		$this->assertSame( 0, $rows() );
	}

	public function test_the_router_tick_purges_expired_members_beside_expired_rows(): void {
		$this->base_dir( 'table-purge-members-' );
		$now         = 1790000000.0;
		Core::$clock = static function () use ( &$now ): float {
			return $now;
		};
		Core::$now   = $now;
		$router      = $this->router();
		[ $table ]   = $this->durable( 37 );
		$request                   = Message::new_message();
		$request[ Message::TYPE ]  = Message::TM_REQUEST | Message::TM_STRUCT;
		$request[ Message::FROM ]  = 'asker-9';
		$request[ Message::VALUE ] = [ 'SADD' => [ 'word:kea' => [ [ 'u-41' => 1, 'u-43' => 3 ] ], 'word:owl' => [ [ 'u-47' => 7 ], 777 ] ] ];
		$table->fill( $request );
		$members = static fn (): int => (int) ( new \PDO( 'sqlite:' . Table_Node::file( 'lab-7:kea', 3 ) ) )->query( 'SELECT COUNT(*) FROM members' )->fetchColumn();
		$this->assertSame( 3, $members() );
		$now      += 37;
		Core::$now = $now;
		$router->fire_cb();
		$this->assertSame( 1, $members(), 'the expired set is reclaimed and the live one stays' );
	}

	public function test_a_purge_repeats_full_batches_until_its_budget_is_spent(): void {
		$this->base_dir( 'table-budget-' );
		Core::$clock      = static fn (): float => 1790000000.0;
		[ $table, $rows ] = $this->durable( 37 );
		$items            = [];
		for ( $i = 0; $i < 2 * Table_Node::PURGE_BATCH_ROWS + 1; ++$i ) {
			$items[ "sku-{$i}" ] = $i;
		}
		$this->assertTrue( $table->store_multi( $items ) );
		$reads       = 0;
		Core::$clock = static function () use ( &$reads ): float {
			return 1790000037.0 + 0.03 * $reads++;
		};
		Table_Node::purge_and_checkpoint( 1790000037 );
		$this->assertSame( 1, $rows(), 'two full batches fit the budget; the third waits' );
	}

	/** Store `$batches` full purge batches plus `$extra` rows, all expiring at 1790000037. */
	private function expiring( Table_Node $table, int $batches, int $extra, string $tag ): void {
		$items = [];
		for ( $i = 0; $i < $batches * Table_Node::PURGE_BATCH_ROWS + $extra; ++$i ) {
			$items[ "{$tag}-{$i}" ] = $i;
		}
		$this->assertTrue( $table->store_multi( $items ) );
	}

	public function test_a_table_left_behind_spends_the_backlog_budget_until_a_batch_comes_back_short(): void {
		$this->base_dir( 'table-backlog-' );
		Core::$clock      = static fn (): float => 1790000000.0;
		[ $table, $rows ] = $this->durable( 37 );
		$this->expiring( $table, 12, 3, 'sku' );
		$reads       = 0;
		Core::$clock = static function () use ( &$reads ): float {
			return 1790000037.0 + 0.03 * $reads++;
		};
		$logged = [];
		\add_action(
			'newspack_nodes/stderr',
			static function ( string $line ) use ( &$logged ): void {
				$logged[] = $line;
			}
		);
		$this->assertSame( 0.25, Table_Node::PURGE_BACKLOG_BUDGET_S );

		Table_Node::purge_and_checkpoint( 1790000037 );
		$this->assertSame( 10 * Table_Node::PURGE_BATCH_ROWS + 3, $rows(), 'a tick on time spends 50 ms: two batches' );
		$this->assertStringContainsString( 'lab-7:kea: WARNING: purge is behind: its last batch came back full after 2 batches, 10000 rows', \implode( "\n", $logged ) );

		Table_Node::purge_and_checkpoint( 1790000097 );
		$this->assertSame( Table_Node::PURGE_BATCH_ROWS + 3, $rows(), 'a tick behind spends the backlog budget: nine batches, and stops there' );

		Table_Node::purge_and_checkpoint( 1790000157 );
		$this->assertSame( 0, $rows(), 'a short batch ends the tick caught up' );

		$this->expiring( $table, 3, 0, 'emu' );
		Table_Node::purge_and_checkpoint( 1790000217 );
		$this->assertSame( Table_Node::PURGE_BATCH_ROWS, $rows(), 'caught up, the next tick spends 50 ms again' );
	}

	public function test_tables_behind_share_one_tick_deadline(): void {
		$this->base_dir( 'table-shared-deadline-' );
		Core::$clock      = static fn (): float => 1790000000.0;
		[ $kea, $kea_rows ] = $this->durable( 37 );
		$this->expiring( $kea, 12, 3, 'sku' );
		Core::$var['partition'] = '3';
		try {
			$owl = new Table_Node();
			$owl->name( 'lab-7:owl' );
			$owl->arguments( [ 'owl:p3', '37', 'sqlite' ] );
		} finally {
			unset( Core::$var['partition'] );
		}
		$owl->sink( new Capture_Sink_Node() );
		$this->expiring( $owl, 3, 5, 'emu' );
		$owl_file = Table_Node::file( 'lab-7:owl', 3 );
		$owl_rows = static fn (): int => (int) ( new \PDO( 'sqlite:' . $owl_file ) )->query( 'SELECT COUNT(*) FROM kv' )->fetchColumn();
		$reads       = 0;
		Core::$clock = static function () use ( &$reads ): float {
			return 1790000037.0 + 0.03 * $reads++;
		};
		$batch = Table_Node::PURGE_BATCH_ROWS;

		Table_Node::purge_and_checkpoint( 1790000037 );
		$this->assertSame( [ 10 * $batch + 3, 2 * $batch + 5 ], [ $kea_rows(), $owl_rows() ], 'the second Table gets its one batch after the first spent the tick' );

		Table_Node::purge_and_checkpoint( 1790000097 );
		$this->assertSame( [ $batch + 3, $batch + 5 ], [ $kea_rows(), $owl_rows() ], 'both behind: one 250 ms deadline for the tick, not one each' );
	}

	public function test_a_mounted_table_never_joins_the_purge(): void {
		$this->base_dir( 'table-mount-purge-' );
		Core::$clock      = static fn (): float => 1790000000.0;
		[ $table, $rows ] = $this->durable( 37 );
		$table->store( 'sku-41', 1 );
		$table->remove_node();
		Table_Node::mount( 'lab-7:kea', 3, [ 'namespace' => 'kea:p3', 'ttl' => 37, 'backend' => 'sqlite' ], new Capture_Sink_Node() );
		Table_Node::purge_and_checkpoint( 1790000037 );
		$this->assertSame( 1, $rows(), 'a request graph never becomes the file\'s second writer' );
	}

	public function test_a_mounted_tables_config_write_verbs_refuse(): void {
		$this->base_dir( 'table-mount-verbs-' );
		[ $table, $rows ] = $this->durable( 37 );
		$table->store( 'sku-41', 1 );
		$table->remove_node();
		// Close the writer now: its last close checkpoints the WAL into the file.
		unset( $table );
		\gc_collect_cycles();
		$file = Table_Node::file( 'lab-7:kea', 3 );
		\clearstatcache();
		$bytes = \filesize( $file );
		$mount = Table_Node::mount( 'lab-7:kea', 3, [ 'namespace' => 'kea:p3', 'ttl' => 37, 'backend' => 'sqlite' ], new Capture_Sink_Node() );
		$refusals = [];
		foreach ( [ [ 'flush', [] ], [ 'vacuum', [] ] ] as [ $verb, $args ] ) {
			try {
				$mount->interpreter()->dispatch( $verb, $args );
			} catch ( \PHPUnit\Exception $e ) {
				throw $e;
			} catch ( \RuntimeException $e ) {
				$refusals[] = $e->getMessage();
			}
		}
		$this->assertSame( 1, $rows(), 'the routed flush deleted nothing' );
		\clearstatcache();
		$this->assertSame( $bytes, \filesize( $file ), 'the routed vacuum rewrote nothing' );
		$this->assertSame(
			[ 'flush: lab-7:kea.p3 is a mounted Table, which serves reads only', 'vacuum: lab-7:kea.p3 is a mounted Table, which serves reads only' ],
			$refusals
		);
	}

	public function test_a_table_outside_the_graph_is_never_purged(): void {
		$this->base_dir( 'table-orphan-' );
		Core::$clock      = static fn (): float => 1790000000.0;
		[ $table, $rows ] = $this->durable( 37 );
		$table->store( 'sku-41', 1 );
		$table->remove_node();
		Table_Node::purge_and_checkpoint( 1790000037 );
		$this->assertSame( 1, $rows(), 'a removed Table is no longer its file\'s writer' );
	}

	public function test_vacuum_is_a_verb_a_durable_table_answers(): void {
		$this->base_dir( 'table-vacuum-' );
		[ $table ] = $this->durable( 37 );
		$this->assertSame( "ok\n", $table->interpreter()->dispatch( 'vacuum', [] ) );
		[ $auto ] = $this->table();
		$this->expectExceptionMessage( 'vacuum needs a durable backend; prices:table is auto' );
		$auto->vacuum();
	}

	public function test_a_refused_vacuum_names_its_table_escaped_once(): void {
		$dir       = $this->base_dir( "table-vac'" );
		[ $table ] = $this->durable( 37 );
		// A 1 ms busy_timeout, as SqliteArmTest opens one, so the refusal is prompt.
		( new \ReflectionProperty( Table_Node::class, 'arm' ) )->setValue( $table, new Sqlite_Arm( Table_Node::file( 'lab-7:kea', 3 ), 'kea:p3', 1 ) );
		$table->store( 'sku-41', 1 );
		$reader = new \PDO( 'sqlite:' . Table_Node::file( 'lab-7:kea', 3 ) );
		$reader->exec( 'BEGIN' );
		$reader->query( 'SELECT count(*) FROM kv' )->fetchAll();
		$table->store( 'sku-43', 3 );
		try {
			$e = $this->caught( static fn () => $table->vacuum(), 'a vacuum under a live reader reported success' );
		} finally {
			$reader->exec( 'ROLLBACK' );
		}
		$escaped = \str_replace( "'", '&#039;', $dir );
		$this->assertSame( "Table lab-7:kea: sqlite {$escaped}/tables/lab-7:kea.p3.sqlite: database is locked: a reader holds the WAL", $e->getMessage() );
	}

	public function test_a_named_volatile_table_refuses_vacuum_as_auto_does(): void {
		[ $table ] = $this->table( 'kea:p3', '37', 'memcache' );
		$this->expectException( \RuntimeException::class );
		$this->expectExceptionMessage( 'vacuum needs a durable backend; prices:table is memcache' );
		$table->vacuum();
	}

	public function test_a_refused_verb_is_shown_at_most_64_bytes(): void {
		[ $table, $sink ] = $this->table();
		$logged           = [];
		\add_action(
			'newspack_nodes/stderr',
			static function ( string $line ) use ( &$logged ): void {
				$logged[] = $line;
			}
		);
		$verb = \str_repeat( 'K', 64 );

		$table->fill( $this->request( "{$verb}A sku-9", 'asker-12' ) );
		$table->fill( $this->request( "{$verb}B sku-9", 'asker-12' ) );

		$this->assertCount( 1, $logged, 'two verbs sharing 64 bytes share one throttle key' );
		$this->assertStringContainsString( "ERROR: bad request: {$verb}: unknown verb - from: asker-12", $logged[0] );
		$this->assertSame( "{$verb}: unknown verb\n", \end( $sink->captured )[ Message::VALUE ] );
	}

	public function test_each_bad_verb_is_logged_once_and_an_empty_one_is_named(): void {
		[ $table, $sink ] = $this->table();
		$logged           = [];
		\add_action(
			'newspack_nodes/stderr',
			static function ( string $line ) use ( &$logged ): void {
				$logged[] = $line;
			}
		);

		$table->fill( $this->request( 'SET sku-9 12', 'asker-12' ) );
		$table->fill( $this->request( 'SET sku-9 13', 'asker-12' ) );
		$table->fill( $this->request( 'PUT sku-9 14', 'asker-12' ) );
		$table->fill( $this->request( '  ', 'asker-13' ) );

		$this->assertCount( 3, $logged, 'one line per verb in the window' );
		$this->assertStringContainsString( 'ERROR: bad request: PUT: unknown verb - from: asker-12', $logged[1] );
		$this->assertStringContainsString( 'ERROR: bad request: (empty): unknown verb - from: asker-13', $logged[2] );
		$this->assertSame( "(empty): unknown verb\n", \end( $sink->captured )[ Message::VALUE ] );
	}
}
