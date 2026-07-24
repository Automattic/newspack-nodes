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

	public function test_rm_deletes_a_key(): void {
		[ $table ] = $this->table();
		$table->fill( $this->keyed( 'sku-9', 'gone-soon' ) );

		$this->assertSame( 'ok', $table->rm( 'sku-9' ) );
		$this->assertNull( Table_Node::lookup( 'prices', 'sku-9' ) );
	}
}
