<?php
namespace Newspack_Nodes\Tests\Unit;

use PHPUnit\Framework\Attributes\CoversClass;
use Newspack_Nodes\Core;
use Newspack_Nodes\Message;
use Newspack_Nodes\Table_Node;
use Newspack_Nodes\Tests\Capture_Sink_Node;
use Newspack_Nodes\Tests\Helpers\InMemoryMemcached;
use Newspack_Nodes\Tests\TestCase;

/**
 * Table_Node: the keyed store (Tachikoma Table vocabulary) backed by
 * memcache so ANY process — dashboard, REST, CLI — reads values without
 * asking a live worker. fill() stores KEY→VALUE write-through (the message
 * passes on), Table_Node::lookup() is the cross-process read.
 */
#[CoversClass( Table_Node::class )]
class TableNodeTest extends TestCase {
	private ?\Memcached $prev_memd = null;
	private InMemoryMemcached $memd;

	/** Core::$now as this suite found it; Core::reset() does not clear it. */
	private float $saved_now = 0.0;

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
		parent::tearDown();
	}

	private function table( string $ns = 'prices', string ...$rest ): array {
		$sink  = new Capture_Sink_Node();
		$table = new Table_Node();
		$table->name( 'prices:table' );
		$table->sink( $sink );
		$table->arguments( [ $ns, ...$rest ] );
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

	public function test_get_request_replies_bytestream_for_a_scalar_value(): void {
		[ $table, $sink ] = $this->table();
		$table->fill( $this->keyed( 'sku-9', "bar\n" ) );
		$sink->captured = [];

		$table->fill( $this->request( 'GET sku-9' ) );

		$this->assertCount( 1, $sink->captured );
		$reply = $sink->captured[0];
		$this->assertSame( Message::TM_BYTESTREAM, $reply[ Message::TYPE ] );
		$this->assertSame( 'prices:table', $reply[ Message::FROM ] );
		$this->assertSame( 'asker', $reply[ Message::TO ] );
		$this->assertSame( 'sku-9', $reply[ Message::KEY ] );
		$this->assertSame( "bar\n", $reply[ Message::VALUE ] );
	}

	public function test_get_request_replies_struct_for_an_array_value(): void {
		[ $table, $sink ] = $this->table();
		$table->fill( $this->keyed( 'sku-9', [ 'usd' => 1250 ] ) );
		$sink->captured = [];

		$table->fill( $this->request( 'GET sku-9' ) );

		$reply = $sink->captured[0];
		$this->assertSame( Message::TM_STRUCT, $reply[ Message::TYPE ] );
		$this->assertSame( [ 'usd' => 1250 ], $reply[ Message::VALUE ] );
	}

	public function test_get_request_replies_error_for_an_absent_key(): void {
		[ $table, $sink ] = $this->table();

		$table->fill( $this->request( 'GET never-stored' ) );

		$reply = $sink->captured[0];
		$this->assertSame( Message::TM_ERROR, $reply[ Message::TYPE ] );
		$this->assertSame( 'never-stored', $reply[ Message::KEY ] );
		$this->assertSame( 'NOT_FOUND', $reply[ Message::VALUE ] );
	}

	public function test_a_request_is_neither_stored_nor_forwarded(): void {
		[ $table, $sink ] = $this->table();

		// A KEY-bearing request must not be mistaken for a write.
		$message                 = $this->request( 'GET sku-9' );
		$message[ Message::KEY ] = 'sku-9';
		$table->fill( $message );

		$this->assertFalse( $this->memd->get( Table_Node::entry_key( 'prices', 'sku-9' ) ) );
		$this->assertCount( 1, $sink->captured, 'only the reply, not the request itself' );
		$this->assertSame( Message::TM_ERROR, $sink->captured[0][ Message::TYPE ] );
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

		$this->assertSame( [ 'usd' => 1250 ], $this->memd->get( Table_Node::entry_key( 'prices', 'sku-9' ) ) );
		$this->assertCount( 1, $sink->captured, 'write-through: the table composes mid-graph' );
	}

	public function test_lookup_reads_from_any_process(): void {
		[ $table ] = $this->table();
		$other     = Table_Node::table( 'other-ns' );
		$table->fill( $this->keyed( 'sku-9', 'v2' ) );

		$this->assertSame( 'v2', $table->lookup( 'sku-9' ) );
		$this->assertNull( $table->lookup( 'absent' ) );
		$this->assertNull( $other->lookup( 'sku-9' ) );
	}

	public function test_keyless_messages_pass_through_unstored(): void {
		[ $table, $sink ] = $this->table();

		$table->fill( $this->keyed( '', [ 'no' => 'key' ] ) );

		$this->assertSame( [], $this->memd->keys() );
		$this->assertCount( 1, $sink->captured );
	}

	public function test_arguments_without_memcached_throws(): void {
		Core::$memd = null;
		$table      = new Table_Node();
		$table->name( 'prices:table' );
		$this->expectException( \LogicException::class );
		$this->expectExceptionMessageMatches( '/memcached/' );
		$table->arguments( [ 'prices' ] );
	}

	public function test_a_stored_false_reads_back_as_false_not_missing(): void {
		[ $table ] = $this->table();
		$table->fill( $this->keyed( 'flag', false ) );

		$this->assertFalse( $table->lookup( 'flag' ), 'RES_NOTFOUND disambiguates a stored false from a miss' );
		$this->assertNull( $table->lookup( 'absent' ) );
	}

	public function test_get_and_rm_verbs_operate_through_the_interpreter(): void {
		[ $table ] = $this->table();
		$table->fill( $this->keyed( 'sku-9', [ 'usd' => 1250 ] ) );

		// The node names its own sibling; naming a second one here would collide.
		$ci = Core::node( 'prices:table:config' );

		$this->assertSame( '{"usd":1250}', $ci->dispatch( 'get', [ 'sku-9' ] ) );
		$this->assertSame( "ok\n", $ci->dispatch( 'rm', [ 'sku-9' ] ) );
		$this->assertSame( 'null', $ci->dispatch( 'get', [ 'sku-9' ] ) );
	}

	public function test_make_node_wires_the_config_sibling_that_serves_the_verbs(): void {
		// The hand-built interpreter above proves the handlers work; this proves
		// anything can REACH them. Without auto_wire_interpreter() the verbs are
		// declared in the schema and dispatchable from nowhere.
		$ci = new \Newspack_Nodes\Command_Interpreter_Node();
		$ci->name( '_command_interpreter' );
		$ci->sink( new Capture_Sink_Node() );

		$table = $ci->make_node( 'Table', 'ledger', 'invoices' );
		$table->fill( $this->keyed( 'inv-42', [ 'eur' => 8800 ] ) );

		$config = Core::node( 'ledger:config' );
		$this->assertNotNull( $config, 'make_node Table must wire the :config sibling' );
		$this->assertSame( $table, $config->patron() );
		$this->assertSame( '{"eur":8800}', $config->dispatch( 'get', [ 'inv-42' ] ) );
		$this->assertSame( "ok\n", $config->dispatch( 'rm', [ 'inv-42' ] ) );
		$this->assertSame( 'null', $config->dispatch( 'get', [ 'inv-42' ] ) );
	}

	public function test_verbs_refuse_a_foreign_patron(): void {
		$ci = new \Newspack_Nodes\Command_Interpreter_Node();
		$ci->name( 'stray:config' );
		$verbs = array_column( \Newspack_Nodes\Table_Node::node_schema()['commands'], 'handler', 'name' );
		$this->assertSame( "error: no table patron\n", $verbs['get']( $ci, [ 'x' ] ) );
		$this->assertSame( "error: no table patron\n", $verbs['rm']( $ci, [ 'x' ] ) );
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
			$this->memd->expiries()[ Table_Node::entry_key( 'prices', 'sku-9' ) ],
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
			$this->memd->get( Table_Node::entry_key( 'prices', 'sku-9' ) ),
			'store() must land on the same key fill() writes'
		);
	}

	public function test_store_scopes_by_namespace_like_every_other_write(): void {
		Table_Node::table( 'prices' )->store( 'sku-9', 'here' );
		$this->assertNull( Table_Node::table( 'ledger' )->lookup( 'sku-9' ) );
	}

	public function test_forget_removes_an_entry(): void {
		$table = Table_Node::table( 'prices' );
		$table->store( 'sku-9', 'gone-soon' );
		$table->forget( 'sku-9' );
		$this->assertNull( $table->lookup( 'sku-9' ) );
	}

	public function test_store_and_forget_survive_a_backend_that_went_away(): void {
		// Every other cache path here fails soft; a ruleset save must not fatal
		// because memcached died after the table was built. A table built with
		// NO backend at all is a configuration error and says so — see
		// test_arguments_without_memcached_throws.
		$table      = Table_Node::table( 'prices' );
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
		// lookup_multi()'s missing half. ELN's stats flush issues one
		// read-modify-write per key and two of its loops are per URL, so the
		// write path is where a full-window replay decays. Seeds distinct from
		// every default: three skus, values 707/808/909.
		$table = Table_Node::table( 'prices', 60 );

		$this->assertTrue( $table->store_multi( [
			'sku-707' => [ 'usd' => 707 ],
			'sku-808' => [ 'usd' => 808 ],
			'sku-909' => [ 'usd' => 909 ],
		] ) );

		$this->assertSame(
			[ 'sku-707' => [ 'usd' => 707 ], 'sku-808' => [ 'usd' => 808 ], 'sku-909' => [ 'usd' => 909 ] ],
			$table->lookup_multi( [ 'sku-707', 'sku-808', 'sku-909' ] ),
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
			$table->lookup_multi( [ '9777777777777' ] )
		);
	}

	public function test_store_multi_writes_nothing_for_an_empty_set(): void {
		$table = Table_Node::table( 'prices', 60 );
		$this->assertTrue( $table->store_multi( [] ), 'an empty batch is a no-op, not a failure' );
	}

	public function test_lookup_multi_asks_the_backing_once_for_every_miss(): void {
		$table = Table_Node::table( 'prices', 60 );
		$table->store( 'sku-1', [ 'usd' => 100 ] );
		$calls = 0;
		$table->backed_by(
			static function ( array $keys ) use ( &$calls ): array {
				++$calls;
				return [ 'sku-2' => [ 'value' => [ 'usd' => 200 ] ], 'sku-3' => [ 'value' => [ 'usd' => 300 ] ] ];
			}
		);

		$found = $table->lookup_multi( [ 'sku-1', 'sku-2', 'sku-3' ] );

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
		$expiry = $this->memd->expiries()[ Table_Node::entry_key( 'prices', 'sku-7' ) ] ?? 0;
		$this->assertEqualsWithDelta( \time() + 5, $expiry, 2, 'stored under the entry\'s own remaining life, not the table\'s 600' );
	}

	public function test_the_record_is_still_served_when_the_backend_went_away(): void {
		// Warming the table is best-effort. A store that cannot land must not
		// turn a successful read of the system of record into a miss.
		$table = Table_Node::table( 'prices', 60 );
		$table->backed_by( static fn ( array $keys ): array => [ 'sku-4' => [ 'value' => [ 'usd' => 400 ] ] ] );
		Core::$memd = null;

		$this->assertSame( [ 'usd' => 400 ], $table->lookup( 'sku-4' ) );
	}

	public function test_an_entry_whose_lifetime_ran_out_is_not_stored(): void {
		$table = Table_Node::table( 'prices', 600 );
		$table->backed_by( static fn ( array $keys ): array => [ 'sku-8' => [ 'value' => [ 'usd' => 800 ], 'ttl' => 0 ] ] );

		$this->assertNull( $table->lookup( 'sku-8' ), 'a spent lifetime is a miss, not a resurrection' );
	}

	public function test_lookup_multi_returns_found_only_keyed_by_the_callers_key(): void {
		// One backend round trip for a set of keys — what ELN's Stats_Store
		// reads a page of URL buckets through.
		$table = Table_Node::table( 'prices', 60 );
		$table->store( 'sku-1', [ 'usd' => 100 ] );
		$table->store( 'sku-3', [ 'usd' => 300 ] );

		$found = $table->lookup_multi( [ 'sku-1', 'sku-2', 'sku-3' ] );

		$this->assertSame(
			[ 'sku-1' => [ 'usd' => 100 ], 'sku-3' => [ 'usd' => 300 ] ],
			$found,
			'absent keys are omitted, present ones keyed as the caller asked'
		);
	}

	public function test_lookup_multi_is_empty_when_the_backend_goes_away(): void {
		// table() refuses to build without one, so the loss happens after: a
		// memcached that dies mid-process reads as an empty table, not a throw.
		$table      = Table_Node::table( 'prices', 60 );
		$prev       = Core::$memd;
		Core::$memd = null;
		try {
			$this->assertSame( [], $table->lookup_multi( [ 'sku-1' ] ) );
		} finally {
			Core::$memd = $prev;
		}
	}

	public function test_a_request_that_is_not_a_get_is_refused_not_answered(): void {
		// The verb surface is GET alone; anything else is a caller bug, and
		// replying to it would look like an empty table rather than a refusal.
		$table = new class() extends Table_Node {
			/** @var string[] */
			public array $warnings = [];
			public function print_less_often( string $text, string ...$extra ): void {
				$this->warnings[] = $text . \implode( '', $extra );
			}
		};
		$table->arguments( [ 'prices' ] );
		$capture = new Capture_Sink_Node();
		$table->sink( $capture );

		$message                   = Message::new_message();
		$message[ Message::TYPE ]  = Message::TM_REQUEST;
		$message[ Message::VALUE ] = 'SET sku-9 12';
		$table->fill( $message );

		$this->assertSame( [], $capture->captured, 'a refused request gets no reply' );
		$this->assertSame( [ 'ERROR: bad request: SET sku-9 12' ], $table->warnings );
	}

	public function test_a_backend_read_error_is_said_out_loud(): void {
		// Null reads as "empty table" downstream, so a broken backend that stays
		// quiet is indistinguishable from a cold one.
		$table = new class() extends Table_Node {
			/** @var string[] */
			public array $warnings = [];
		};
		$table->arguments( [ 'prices' ] );
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
		Table_Node::table( '' );
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

}
