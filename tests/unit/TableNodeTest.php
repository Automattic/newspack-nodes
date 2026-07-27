<?php
namespace Newspack_Nodes\Tests\Unit;

use Newspack_Nodes\Core;
use Newspack_Nodes\Message;
use Newspack_Nodes\Table_Node;
use Newspack_Nodes\Tests\Capture_Sink_Node;
use Newspack_Nodes\Tests\Helpers\InMemoryMemcached;
use Newspack_Nodes\Tests\TestCase;
use PHPUnit\Framework\Attributes\CoversClass;

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

	protected function setUp(): void {
		parent::setUp();
		$this->prev_memd = Core::$memd;
		$this->memd      = new InMemoryMemcached();
		Core::$memd      = $this->memd;
	}

	protected function tearDown(): void {
		Core::$memd = $this->prev_memd;
		parent::tearDown();
	}

	private function table( string $ns = 'prices', string $ttl = '' ): array {
		$sink  = new Capture_Sink_Node();
		$table = new Table_Node();
		$table->name( 'prices:table' );
		$table->sink( $sink );
		$table->arguments( '' !== $ttl ? [ $ns, $ttl ] : [ $ns ] );
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

		$this->assertFalse( $this->memd->get( 'nodes-table:prices:sku-9' ) );
		$this->assertCount( 1, $sink->captured, 'only the reply, not the request itself' );
		$this->assertSame( Message::TM_ERROR, $sink->captured[0][ Message::TYPE ] );
	}

	public function test_an_empty_value_deletes_the_key(): void {
		[ $table ] = $this->table();
		$table->fill( $this->keyed( 'sku-9', [ 'usd' => 1250 ] ) );

		$table->fill( $this->keyed( 'sku-9', '' ) );

		$this->assertNull( Table_Node::lookup( 'prices', 'sku-9' ) );
	}

	public function test_a_bare_newline_deletes_too_since_send_node_always_appends_one(): void {
		[ $table ] = $this->table();
		$table->fill( $this->keyed( 'sku-9', [ 'usd' => 1250 ] ) );

		$table->fill( $this->keyed( 'sku-9', "\n" ) );

		$this->assertNull( Table_Node::lookup( 'prices', 'sku-9' ) );
	}

	public function test_a_value_that_is_only_terminated_still_stores(): void {
		[ $table ] = $this->table();

		$table->fill( $this->keyed( 'sku-9', "bar\n" ) );

		$this->assertSame( "bar\n", Table_Node::lookup( 'prices', 'sku-9' ) );
	}

	public function test_fill_stores_key_value_and_passes_the_message_through(): void {
		[ $table, $sink ] = $this->table();

		$table->fill( $this->keyed( 'sku-9', [ 'usd' => 1250 ] ) );

		$this->assertSame( [ 'usd' => 1250 ], $this->memd->get( 'nodes-table:prices:sku-9' ) );
		$this->assertCount( 1, $sink->captured, 'write-through: the table composes mid-graph' );
	}

	public function test_lookup_reads_from_any_process(): void {
		[ $table ] = $this->table();
		$table->fill( $this->keyed( 'sku-9', 'v2' ) );

		$this->assertSame( 'v2', Table_Node::lookup( 'prices', 'sku-9' ) );
		$this->assertNull( Table_Node::lookup( 'prices', 'absent' ) );
		$this->assertNull( Table_Node::lookup( 'other-ns', 'sku-9' ) );
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

		$this->assertFalse( Table_Node::lookup( 'prices', 'flag' ), 'RES_NOTFOUND disambiguates a stored false from a miss' );
		$this->assertNull( Table_Node::lookup( 'prices', 'absent' ) );
	}

	public function test_get_and_rm_verbs_operate_through_the_interpreter(): void {
		[ $table ] = $this->table();
		$table->fill( $this->keyed( 'sku-9', [ 'usd' => 1250 ] ) );

		// The node names its own sibling; naming a second one here would collide.
		$ci = Core::node( 'prices:table:config' );

		$this->assertSame( '{"usd":1250}', $ci->dispatch( 'get', [ 'sku-9' ] ) );
		$this->assertSame( 'ok', $ci->dispatch( 'rm', [ 'sku-9' ] ) );
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
		$this->assertSame( 'ok', $config->dispatch( 'rm', [ 'inv-42' ] ) );
		$this->assertSame( 'null', $config->dispatch( 'get', [ 'inv-42' ] ) );
	}

	public function test_verbs_refuse_a_foreign_patron(): void {
		$ci = new \Newspack_Nodes\Command_Interpreter_Node();
		$ci->name( 'stray:config' );
		$verbs = array_column( \Newspack_Nodes\Table_Node::node_schema()['commands'], 'handler', 'name' );
		$this->assertSame( 'error: no table patron', $verbs['get']( $ci, [ 'x' ] ) );
		$this->assertSame( 'error: no table patron', $verbs['rm']( $ci, [ 'x' ] ) );
	}

	public function test_arguments_read_back(): void {
		[ $table ] = $this->table( 'prices', '300' );
		$this->assertSame( [ 'prices', '300' ], $table->arguments() );
	}

	public function test_rm_deletes_a_key(): void {
		[ $table ] = $this->table();
		$table->fill( $this->keyed( 'sku-9', 'gone-soon' ) );

		$this->assertSame( 'ok', $table->rm( 'sku-9' ) );
		$this->assertNull( Table_Node::lookup( 'prices', 'sku-9' ) );
	}
}
