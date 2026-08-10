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

	// ── L1: an opt-in in-memory tier in front of memcache ──────────────────

	/** Reads served straight from the backend, so a miss here means the L1 answered. */
	private function backend_reads(): int {
		return $this->memd->get_calls;
	}

	public function test_no_l1_by_default_so_every_read_reaches_the_backend(): void {
		[ $table ] = $this->table( 'prices' );
		$table->store( 'sku-9', 'v2' );

		$before = $this->backend_reads();
		$table->lookup( 'sku-9' );
		$table->lookup( 'sku-9' );

		$this->assertSame( 2, $this->backend_reads() - $before, 'a table that opted out is read-through' );
	}

	public function test_l1_answers_a_repeat_read_without_the_backend(): void {
		[ $table ] = $this->table( 'prices', '0', '5' );
		$table->store( 'sku-9', 'v2' );

		$table->lookup( 'sku-9' );
		$before = $this->backend_reads();

		$this->assertSame( 'v2', $table->lookup( 'sku-9' ) );
		$this->assertSame( 0, $this->backend_reads() - $before );
	}

	public function test_l1_is_keyed_by_the_derived_key_so_moving_the_namespace_orphans_it(): void {
		// The generation idiom: pyrobase names its table `pyrobase:g47` and a
		// schema bump renames it. Keyed by the bare key, the L1 would survive
		// that rename and keep serving the previous generation's value.
		[ $table ] = $this->table( 'pyrobase:g47', '0', '5' );
		$table->store( 'obj:88', 'gen-47-value' );
		$this->assertSame( 'gen-47-value', $table->lookup( 'obj:88' ) );

		$table->arguments( [ 'pyrobase:g48', '0', '5' ] );

		$this->assertNull( $table->lookup( 'obj:88' ) );
	}

	public function test_l1_entries_age_out_however_often_they_are_read(): void {
		// Promotion is what a working set wants and a read-through tier must
		// not have: re-reading the hottest key would pin the staleset forever.
		Core::$now = 1_770_000_000.0;
		[ $table ] = $this->table( 'prices', '0', '4' );
		$table->store( 'sku-9', 'v2' );
		$this->assertSame( 'v2', $table->lookup( 'sku-9' ) );

		// Another process writes; this table's L1 still holds the old value.
		$this->memd->set( Table_Node::entry_key( 'prices', 'sku-9' ), 'v3', 0 );
		$this->assertSame( 'v2', $table->lookup( 'sku-9' ), 'bounded staleness is what l1_ttl buys' );

		Core::$now = 1_770_000_009.0;
		$this->assertSame( 'v3', $table->lookup( 'sku-9' ), 'and the window closes on wall-clock time' );
	}

	public function test_a_write_through_this_table_updates_its_own_l1(): void {
		[ $table ] = $this->table( 'prices', '0', '5' );
		$table->store( 'sku-9', 'v2' );
		$table->lookup( 'sku-9' );

		$table->fill( $this->keyed( 'sku-9', 'v3' ) );

		$this->assertSame( 'v3', $table->lookup( 'sku-9' ) );
	}

	public function test_forget_drops_the_l1_copy_too(): void {
		[ $table ] = $this->table( 'prices', '0', '5' );
		$table->store( 'sku-9', 'v2' );
		$table->lookup( 'sku-9' );

		$table->forget( 'sku-9' );

		$this->assertNull( $table->lookup( 'sku-9' ) );
	}

	public function test_a_write_the_backend_refused_is_not_cached(): void {
		// A read-through tier may only hold what the store confirmed. Cached
		// anyway, this process reads its own failed write as fact for a whole
		// window while every other process correctly sees the old value.
		[ $table ] = $this->table( 'prices', '0', '5' );
		$table->store( 'sku-9', 'v2' );
		$this->memd->fail_set( Table_Node::entry_key( 'prices', 'sku-9' ) );

		$table->store( 'sku-9', 'refused' );

		$this->assertSame( 'v2', $table->lookup( 'sku-9' ), 'the backend still holds v2, so the table must say v2' );
	}

	public function test_lookup_multi_batches_the_backend_remainder(): void {
		[ $table ] = $this->table( 'prices', '0', '5' );
		$table->store( 'sku-9', 'nine' );
		$table->store( 'sku-7', 'seven' );
		$table->lookup( 'sku-9' );

		$found = $table->lookup_multi( [ 'sku-9', 'sku-7', 'never-stored' ] );

		$this->assertSame( [ 'sku-9' => 'nine', 'sku-7' => 'seven' ], $found );
		$this->assertSame( 1, $this->memd->multi_calls, 'one round trip for everything the L1 missed' );
	}

	public function test_lookup_multi_populates_the_l1_from_what_it_fetched(): void {
		[ $table ] = $this->table( 'prices', '0', '5' );
		$table->store( 'sku-7', 'seven' );

		$table->lookup_multi( [ 'sku-7' ] );
		$before = $this->backend_reads();

		$this->assertSame( 'seven', $table->lookup( 'sku-7' ) );
		$this->assertSame( 0, $this->backend_reads() - $before );
	}

	public function test_lookup_multi_keeps_a_stored_false(): void {
		// The single-key path distinguishes a stored false from a miss; the
		// batch path answers for the same table and must not disagree.
		[ $table ] = $this->table( 'prices' );
		$table->store( 'flag', false );

		$this->assertSame( [ 'flag' => false ], $table->lookup_multi( [ 'flag', 'absent' ] ) );
	}

	public function test_lookup_multi_without_an_l1_still_batches(): void {
		[ $table ] = $this->table( 'prices' );
		$table->store( 'sku-9', 'nine' );

		$this->assertSame( [ 'sku-9' => 'nine' ], $table->lookup_multi( [ 'sku-9', 'absent' ] ) );
		$this->assertSame( 1, $this->memd->multi_calls );
	}

	public function test_the_factory_builds_the_same_table_arguments_does(): void {
		$table = Table_Node::table( 'prices', 300, 5.0 );

		$this->assertSame( [ 'prices', '300', '5' ], $table->arguments() );
	}

	public function test_two_factory_calls_are_two_tables(): void {
		// Deliberately NOT memoized: a memoizing factory is the global registry
		// wearing a constructor's clothes, and the L1's lifetime belongs to
		// whoever holds the table.
		$this->assertNotSame( Table_Node::table( 'prices' ), Table_Node::table( 'prices' ) );
	}

	public function test_rm_deletes_a_key(): void {
		[ $table ] = $this->table();
		$table->fill( $this->keyed( 'sku-9', 'gone-soon' ) );

		$this->assertSame( "ok\n", $table->rm( 'sku-9' ) );
		$this->assertNull( $table->lookup( 'sku-9' ) );
	}
}
