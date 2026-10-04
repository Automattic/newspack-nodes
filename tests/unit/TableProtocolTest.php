<?php
namespace Newspack_Nodes\Tests\Unit;

use Newspack_Nodes\Cache_Backend;
use Newspack_Nodes\Core;
use Newspack_Nodes\Message;
use Newspack_Nodes\Table_Node;
use Newspack_Nodes\Tests\Capture_Sink_Node;
use Newspack_Nodes\Tests\Helpers\InMemoryMemcached;
use Newspack_Nodes\Tests\TestCase;
use PHPUnit\Framework\Attributes\CoversClass;

/**
 * The Table protocol: string TM_REQUEST verbs (GET, MGET, SMEMBERS, TOUCH,
 * RM), the TM_REQUEST|TM_STRUCT carve-out for MSET, ADD and SADD, and plain
 * INSERT.
 * Every reply goes TO the request's FROM, FROM the Table, its ID echoed.
 */
#[CoversClass( Table_Node::class )]
final class TableProtocolTest extends TestCase {
	private string $dir = '';
	private Table_Node $table;
	private Capture_Sink_Node $sink;
	private ?\Memcached $prev_memd = null;

	protected function setUp(): void {
		parent::setUp();
		$this->prev_memd = Core::$memd;
		$this->dir       = $this->make_temp_dir( 'table-protocol-' );
		$this->use_base_dir( $this->dir );
		$this->sink  = new Capture_Sink_Node();
		$this->table = $this->worker_table( 'lab-7:kea', 'kea:p3', 'sqlite' );
	}

	/** A Table built as a worker's `make_node Table` builds one, partition 3 bound. */
	private function worker_table( string $name, string $namespace, string $backend ): Table_Node {
		Core::$var['partition'] = '3';
		try {
			$table = new Table_Node();
			$table->name( $name );
			$table->arguments( [ $namespace, '777', $backend ] );
		} finally {
			unset( Core::$var['partition'] );
		}
		$table->sink( $this->sink );
		return $table;
	}

	protected function tearDown(): void {
		Core::$clock = null;
		Core::$memd  = $this->prev_memd;
		$this->rmdir_recursive( $this->dir );
		parent::tearDown();
	}

	/** @return list<array<int,mixed>> */
	private function ask( string|array $value, int $type = Message::TM_REQUEST, ?Table_Node $to = null ): array {
		$this->sink->captured      = [];
		$message                   = Message::new_message();
		$message[ Message::TYPE ]  = $type;
		$message[ Message::FROM ]  = 'asker-9';
		$message[ Message::ID ]    = 'ask-17';
		$message[ Message::VALUE ] = $value;
		( $to ?? $this->table )->fill( $message );
		return $this->sink->captured;
	}

	/** @return list<array{0:mixed,1:mixed,2:mixed}> */
	private static function shape( array $replies ): array {
		return \array_map( static fn ( array $r ): array => [ $r[ Message::TYPE ], $r[ Message::KEY ], $r[ Message::VALUE ] ], $replies );
	}

	public function test_mget_sends_one_message_per_value_then_the_count(): void {
		$this->table->store( 'sku-41', [ 'usd' => 1250 ] );
		$this->table->store( 'sku-43', "bar\n" );
		$replies = $this->ask( "MGET sku-41 sku-42 sku-43\n" );
		$this->assertSame(
			[
				[ Message::TM_STRUCT, 'sku-41', [ 'usd' => 1250 ] ],
				[ Message::TM_BYTESTREAM, 'sku-43', "bar\n" ],
				[ Message::TM_INFO, '', "MGET 2\n" ],
			],
			self::shape( $replies )
		);
		foreach ( $replies as $reply ) {
			$this->assertSame( [ 'lab-7:kea', 'asker-9', 'ask-17' ], [ $reply[ Message::FROM ], $reply[ Message::TO ], $reply[ Message::ID ] ] );
		}
	}

	public function test_get_answers_one_value_then_the_count(): void {
		$this->table->store( 'sku-41', "bar\n" );
		$this->assertSame(
			[
				[ Message::TM_BYTESTREAM, 'sku-41', "bar\n" ],
				[ Message::TM_INFO, '', "GET 1\n" ],
			],
			self::shape( $this->ask( "GET sku-41 sku-43\n" ) )
		);
	}

	public function test_a_get_of_an_absent_key_sends_only_the_count(): void {
		$this->assertSame( [ [ Message::TM_INFO, '', "GET 0\n" ] ], self::shape( $this->ask( "GET sku-49\n" ) ) );
	}

	public function test_a_scalar_answers_as_a_string_bytestream(): void {
		$this->table->store( 'sku-46', 7731 );
		$this->assertSame(
			[
				[ Message::TM_BYTESTREAM, 'sku-46', '7731' ],
				[ Message::TM_INFO, '', "GET 1\n" ],
			],
			self::shape( $this->ask( "GET sku-46\n" ) )
		);
	}

	public function test_a_wide_mget_answers_every_key(): void {
		$items = [];
		for ( $i = 0; $i < 2345; ++$i ) {
			$items[ "sku-{$i}" ] = $i;
		}
		$this->table->store_multi( $items );
		$replies = $this->ask( 'MGET ' . \implode( ' ', \array_keys( $items ) ) . "\n" );
		$this->assertCount( 2346, $replies );
		$this->assertSame( [ Message::TM_INFO, '', "MGET 2345\n" ], self::shape( [ \end( $replies ) ] )[0] );
	}

	public function test_a_failed_read_answers_an_error_never_absence(): void {
		( new \PDO( 'sqlite:' . Table_Node::file( 'lab-7:kea', 3 ) ) )->exec( 'DROP TABLE kv' );
		$this->assertSame( [ [ Message::TM_ERROR, '', "MGET: backend read failed\n" ] ], self::shape( $this->ask( "MGET sku-41\n" ) ) );
	}

	public function test_a_scan_is_refused_as_an_unknown_verb(): void {
		$this->table->store( 'urltoken:ab:wolf:c1', 'c1' );
		$this->assertSame( [ [ Message::TM_ERROR, '', "SCAN: unknown verb\n" ] ], self::shape( $this->ask( "SCAN urltoken:ab:wo 5\n" ) ) );
	}

	public function test_mset_answers_the_keys_that_landed(): void {
		Core::$clock = static fn (): float => 1790000000.0;
		$replies     = $this->ask( [ 'MSET' => [ 'sku-41' => [ 'a' ], 'sku 42' => [ 'b' ], 'sku-43' => [ 'c', 37 ] ] ], Message::TM_REQUEST | Message::TM_STRUCT );
		$this->assertSame( [ [ Message::TM_RESPONSE, '', "MSET sku-41 sku-43\n" ] ], self::shape( $replies ) );
		$this->assertSame( [ 'lab-7:kea', 'asker-9', 'ask-17' ], [ $replies[0][ Message::FROM ], $replies[0][ Message::TO ], $replies[0][ Message::ID ] ] );
		Core::$clock = static fn (): float => 1790000037.0;
		$this->assertNull( $this->table->lookup( 'sku-43' ), 'an item TTL overrides the Table\'s' );
		$this->assertSame( 'a', $this->table->lookup( 'sku-41' ) );
	}

	public function test_mset_names_an_all_digit_key_as_it_was_sent(): void {
		$this->assertSame( [ [ Message::TM_RESPONSE, '', "MSET 4417\n" ] ], self::shape( $this->ask( [ 'MSET' => [ '4417' => [ 'kea' ] ] ], Message::TM_REQUEST | Message::TM_STRUCT ) ) );
		$this->assertSame( 'kea', $this->table->lookup( '4417' ) );
	}

	public function test_a_failed_atomic_batch_is_not_retried_key_by_key(): void {
		// A second row aborts the batch, while a lone set() still lands.
		( new \PDO( 'sqlite:' . Table_Node::file( 'lab-7:kea', 3 ) ) )->exec( 'CREATE TRIGGER one_row BEFORE INSERT ON kv WHEN ( SELECT COUNT(*) FROM kv ) >= 1 BEGIN SELECT RAISE( ABORT, \'one row\' ); END' );
		$this->assertSame( [ [ Message::TM_RESPONSE, '', "MSET\n" ] ], self::shape( $this->ask( [ 'MSET' => [ 'sku-41' => [ 'a' ], 'sku-43' => [ 'c' ] ] ], Message::TM_REQUEST | Message::TM_STRUCT ) ) );
		$this->assertNull( $this->table->lookup( 'sku-41' ), 'a retry would have landed the first key' );
	}

	public function test_a_failed_volatile_batch_is_retried_key_by_key(): void {
		$memd       = new InMemoryMemcached();
		Core::$memd = $memd;
		$owl        = $this->worker_table( 'lab-7:owl', 'owl:p3', 'memcache' );
		$memd->fail_set( Cache_Backend::entry_key( 'owl:p3', 'sku-42' ) );
		$request                   = Message::new_message();
		$request[ Message::TYPE ]  = Message::TM_REQUEST | Message::TM_STRUCT;
		$request[ Message::FROM ]  = 'asker-9';
		$request[ Message::VALUE ] = [ 'MSET' => [ 'sku-41' => [ 'a' ], 'sku-42' => [ 'b' ], 'sku-43' => [ 'c' ] ] ];
		$this->sink->captured      = [];
		$owl->fill( $request );
		$this->assertSame( [ [ Message::TM_RESPONSE, '', "MSET sku-41 sku-43\n" ] ], self::shape( $this->sink->captured ) );
		$this->assertSame( 'c', $owl->lookup( 'sku-43' ) );
	}

	public function test_a_write_with_no_backend_names_no_key(): void {
		Core::$memd                = new InMemoryMemcached();
		$auto                      = $this->worker_table( 'lab-7:emu', 'emu:p3', 'auto' );
		Core::$memd                = null;
		$request                   = Message::new_message();
		$request[ Message::TYPE ]  = Message::TM_REQUEST | Message::TM_STRUCT;
		$request[ Message::FROM ]  = 'asker-9';
		$request[ Message::VALUE ] = [ 'ADD' => [ 'sku-41' => [ 'a' ] ] ];
		$this->sink->captured      = [];
		$auto->fill( $request );
		$this->assertSame( [ [ Message::TM_RESPONSE, '', "ADD\n" ] ], self::shape( $this->sink->captured ) );
	}

	public function test_add_writes_only_where_absent(): void {
		$this->table->store( 'sku-41', 'kept' );
		$replies = $this->ask( [ 'ADD' => [ 'sku-41' => [ 'lost' ], 'sku-44' => [ 'new' ] ] ], Message::TM_REQUEST | Message::TM_STRUCT );
		$this->assertSame( [ [ Message::TM_RESPONSE, '', "ADD sku-44\n" ] ], self::shape( $replies ) );
		$this->assertSame( 'kept', $this->table->lookup( 'sku-41' ) );
		$this->assertSame( 'new', $this->table->lookup( 'sku-44' ) );
	}

	public function test_touch_and_rm_name_the_keys_they_took_effect_on(): void {
		$this->table->store( 'sku-41', 'v' );
		$this->assertSame( [ [ Message::TM_RESPONSE, '', "TOUCH sku-41\n" ] ], self::shape( $this->ask( "TOUCH 900 sku-41 sku-49\n" ) ) );
		$this->assertSame( [ [ Message::TM_RESPONSE, '', "RM sku-41\n" ] ], self::shape( $this->ask( "RM sku-41 sku-49\n" ) ) );
		$this->assertSame( [ [ Message::TM_RESPONSE, '', "RM\n" ] ], self::shape( $this->ask( "RM sku-41\n" ) ) );
	}

	public function test_touch_moves_the_expiry_to_its_own_ttl(): void {
		Core::$clock = static fn (): float => 1790000000.0;
		$this->table->store( 'sku-41', 'v' );
		$this->ask( "TOUCH 37 sku-41\n" );
		Core::$clock = static fn (): float => 1790000037.0;
		$this->assertNull( $this->table->lookup( 'sku-41' ) );
	}

	public function test_a_touch_whose_ttl_is_not_a_number_is_refused(): void {
		Core::$clock = static fn (): float => 1790000000.0;
		$this->table->store( 'sku-41', 'v' );
		$this->assertSame( [ [ Message::TM_ERROR, '', "TOUCH: usage: TOUCH <ttl> <key>…, ttl in whole seconds, at least 1\n" ] ], self::shape( $this->ask( "TOUCH soon sku-41\n" ) ) );
		Core::$clock = static fn (): float => 1790000776.0;
		$this->assertSame( 'v', $this->table->lookup( 'sku-41' ), 'the refused TOUCH moved no expiry' );
	}

	public function test_a_struct_request_other_than_one_mset_or_add_is_refused(): void {
		$struct = Message::TM_REQUEST | Message::TM_STRUCT;
		$this->assertSame( [ [ Message::TM_ERROR, '', "DEL: only MSET, ADD and SADD take a structure\n" ] ], self::shape( $this->ask( [ 'DEL' => [ 'sku-41' => [ 1 ] ] ], $struct ) ) );
		$this->assertSame( [ [ Message::TM_ERROR, '', "MSET: a structured request needs the TM_STRUCT bit\n" ] ], self::shape( $this->ask( [ 'MSET' => [ 'sku-41' => [ 1 ] ] ] ) ) );
		$this->assertSame( [ [ Message::TM_ERROR, '', "MSET: a structured request names one verb\n" ] ], self::shape( $this->ask( [ 'MSET' => [ 'sku-41' => [ 1 ] ], 'ADD' => [ 'sku-42' => [ 2 ] ] ], $struct ) ) );
		$this->assertSame( [ [ Message::TM_ERROR, '', "MSET: needs a map of key => [ value, ttl ]\n" ] ], self::shape( $this->ask( [ 'MSET' => 'sku-41' ], $struct ) ) );
		$this->assertNull( $this->table->lookup( 'sku-41' ) );
		$this->assertNull( $this->table->lookup( 'sku-42' ) );
	}

	public function test_a_string_mset_is_refused_toward_the_structured_form(): void {
		$this->assertSame( [ [ Message::TM_ERROR, '', "MSET: needs a map of key => [ value, ttl ]\n" ] ], self::shape( $this->ask( "MSET sku-41 a\n" ) ) );
	}

	public function test_an_unknown_verb_is_refused_to_the_asker_and_logged_with_its_origin(): void {
		$logged = [];
		\add_action(
			'newspack_nodes/stderr',
			static function ( string $line ) use ( &$logged ): void {
				$logged[] = $line;
			}
		);
		$replies = $this->ask( "FLY sku-41\n" );
		$this->assertSame( [ [ Message::TM_ERROR, '', "FLY: unknown verb\n" ] ], self::shape( $replies ) );
		$this->assertSame( [ 'lab-7:kea', 'asker-9', 'ask-17' ], [ $replies[0][ Message::FROM ], $replies[0][ Message::TO ], $replies[0][ Message::ID ] ] );
		$this->assertCount( 1, $logged );
		$this->assertStringContainsString( 'ERROR: bad request: FLY: unknown verb - from: asker-9', $logged[0] );
	}

	public function test_an_item_whose_ttl_is_not_whole_seconds_is_left_out(): void {
		$replies = $this->ask( [ 'MSET' => [ 'sku-41' => [ 'a', 'soon' ], 'sku-42' => [ 'b', -5 ], 'sku-43' => [ 'c', true ], 'sku-44' => [ 'd', 37 ] ] ], Message::TM_REQUEST | Message::TM_STRUCT );
		$this->assertSame( [ [ Message::TM_RESPONSE, '', "MSET sku-44\n" ] ], self::shape( $replies ) );
		$this->assertNull( $this->table->lookup( 'sku-41' ) );
		$this->assertNull( $this->table->lookup( 'sku-42' ) );
		$this->assertNull( $this->table->lookup( 'sku-43' ) );
	}

	public function test_an_item_ttl_below_one_second_is_left_out_and_an_absent_one_takes_the_declared(): void {
		Core::$clock = static fn (): float => 1790000000.0;
		$struct      = Message::TM_REQUEST | Message::TM_STRUCT;
		$replies     = $this->ask( [ 'MSET' => [ 'sku-41' => [ 'a', 0 ], 'sku-42' => [ 'b', '-3' ], 'sku-43' => [ 'c', 37 ], 'sku-44' => [ 'd' ] ] ], $struct );
		$this->assertSame( [ [ Message::TM_RESPONSE, '', "MSET sku-43 sku-44\n" ] ], self::shape( $replies ) );
		$this->assertSame( [ [ Message::TM_RESPONSE, '', "ADD\n" ] ], self::shape( $this->ask( [ 'ADD' => [ 'sku-45' => [ 'e', 0 ] ] ], $struct ) ) );
		$this->assertNull( $this->table->lookup( 'sku-41' ), 'a ttl of 0 stores nothing' );
		$this->assertNull( $this->table->lookup( 'sku-42' ) );
		$this->assertNull( $this->table->lookup( 'sku-45' ) );
		Core::$clock = static fn (): float => 1790000776.0;
		$this->assertSame( 'd', $this->table->lookup( 'sku-44' ), 'an untimed item lives the declared 777 seconds' );
		Core::$clock = static fn (): float => 1790000777.0;
		$this->assertNull( $this->table->lookup( 'sku-44' ) );
	}

	public function test_a_touch_below_one_second_is_refused(): void {
		Core::$clock = static fn (): float => 1790000000.0;
		$this->table->store( 'sku-41', 'v' );
		foreach ( [ '0', '-3' ] as $ttl ) {
			$this->assertSame( [ [ Message::TM_ERROR, '', "TOUCH: usage: TOUCH <ttl> <key>…, ttl in whole seconds, at least 1\n" ] ], self::shape( $this->ask( "TOUCH {$ttl} sku-41\n" ) ) );
		}
		Core::$clock = static fn (): float => 1790000777.0;
		$this->assertNull( $this->table->lookup( 'sku-41' ), 'the refused TOUCH left the declared expiry standing' );
	}

	public function test_a_backed_table_answers_what_its_backing_recovered_past_a_broken_cache(): void {
		Core::$memd = new class() extends InMemoryMemcached {
			public function getMulti( array $keys, int $get_flags = 0 ): array|false {
				return false;
			}
		};
		$emu = Table_Node::table( 'emu:p3', 777 )->backed_by( static fn ( array $keys ): array => [ 'sku-41' => [ 'value' => 'kea-41' ] ] );
		$emu->sink( $this->sink );
		$request                   = Message::new_message();
		$request[ Message::TYPE ]  = Message::TM_REQUEST;
		$request[ Message::FROM ]  = 'asker-9';
		$request[ Message::VALUE ] = "MGET sku-41 sku-42\n";
		$this->sink->captured      = [];
		$emu->fill( $request );
		$this->assertSame(
			[
				[ Message::TM_BYTESTREAM, 'sku-41', 'kea-41' ],
				[ Message::TM_INFO, '', "MGET 1\n" ],
			],
			self::shape( $this->sink->captured )
		);
	}

	public function test_a_backing_that_could_not_look_leaves_a_broken_cache_an_error(): void {
		Core::$memd = new class() extends InMemoryMemcached {
			public function getMulti( array $keys, int $get_flags = 0 ): array|false {
				return false;
			}
		};
		$emu = Table_Node::table( 'emu:p3', 777 )->backed_by( static fn ( array $keys ): ?array => null );
		$emu->sink( $this->sink );
		$request                   = Message::new_message();
		$request[ Message::TYPE ]  = Message::TM_REQUEST;
		$request[ Message::FROM ]  = 'asker-9';
		$request[ Message::VALUE ] = "MGET sku-41\n";
		$this->sink->captured      = [];
		$emu->fill( $request );
		$this->assertSame( [ [ Message::TM_ERROR, '', "MGET: backend read failed\n" ] ], self::shape( $this->sink->captured ) );
	}

	public function test_a_string_request_carrying_the_struct_bit_is_refused(): void {
		$this->table->store( 'sku-41', 'v' );
		$this->assertSame(
			[ [ Message::TM_ERROR, '', "GET: a string request carries no TM_STRUCT bit\n" ] ],
			self::shape( $this->ask( "GET sku-41\n", Message::TM_REQUEST | Message::TM_STRUCT ) )
		);
	}

	public function test_insert_stores_at_the_declared_ttl_and_forwards(): void {
		Core::$clock               = static fn (): float => 1790000000.0;
		$message                   = Message::new_message();
		$message[ Message::TYPE ]  = Message::TM_BYTESTREAM;
		$message[ Message::KEY ]   = 'sku-45';
		$message[ Message::VALUE ] = "7731\n";
		$this->sink->captured      = [];
		$this->table->fill( $message );
		$this->assertCount( 1, $this->sink->captured );
		$this->assertSame( "7731\n", $this->table->lookup( 'sku-45' ) );
		Core::$clock = static fn (): float => 1790000776.0;
		$this->assertSame( "7731\n", $this->table->lookup( 'sku-45' ), 'live one second before the declared TTL' );
		Core::$clock = static fn (): float => 1790000777.0;
		$this->assertNull( $this->table->lookup( 'sku-45' ) );
	}

	public function test_every_request_counts_toward_ls(): void {
		$before = $this->table->counter();
		$this->ask( "GET sku-41\n" );
		$this->ask( "MGET sku-41 sku-42\n" );
		$this->assertSame( $before + 2, $this->table->counter() );
	}

	// ── Set members: SADD and SMEMBERS on a durable Table ──

	private const STRUCT = Message::TM_REQUEST | Message::TM_STRUCT;

	public function test_sadd_answers_the_set_keys_that_landed_and_smembers_one_message_per_set(): void {
		$replies = $this->ask( [ 'SADD' => [ 'word:kea' => [ [ 'u-41' => [ 'hits' => 3 ], 'u-43' => 'weka' ] ], 'word:owl' => [ [ 'u-47' => 7 ], 37 ] ] ], self::STRUCT );
		$this->assertSame( [ [ Message::TM_RESPONSE, '', "SADD word:kea word:owl\n" ] ], self::shape( $replies ) );
		$this->assertSame( [ 'lab-7:kea', 'asker-9', 'ask-17' ], [ $replies[0][ Message::FROM ], $replies[0][ Message::TO ], $replies[0][ Message::ID ] ] );
		$replies = $this->ask( "SMEMBERS 9 word:owl word:emu word:kea\n" );
		$this->assertSame(
			[
				[ Message::TM_STRUCT, 'word:owl', [ [ 'u-47', 7 ] ] ],
				[ Message::TM_STRUCT, 'word:kea', [ [ 'u-41', [ 'hits' => 3 ] ], [ 'u-43', 'weka' ] ] ],
				[ Message::TM_INFO, '', "SMEMBERS 2\n" ],
			],
			self::shape( $replies )
		);
		foreach ( $replies as $reply ) {
			$this->assertSame( [ 'lab-7:kea', 'asker-9', 'ask-17' ], [ $reply[ Message::FROM ], $reply[ Message::TO ], $reply[ Message::ID ] ] );
		}
	}

	public function test_an_all_digit_member_answers_as_the_string_it_was_sent(): void {
		$this->ask( [ 'SADD' => [ '4417' => [ [ '0418' => 'kea', '4419' => 'owl' ] ] ] ], self::STRUCT );
		$this->assertSame(
			[
				[ Message::TM_STRUCT, '4417', [ [ '0418', 'kea' ], [ '4419', 'owl' ] ] ],
				[ Message::TM_INFO, '', "SMEMBERS 1\n" ],
			],
			self::shape( $this->ask( "SMEMBERS 9 4417\n" ) )
		);
	}

	public function test_a_set_past_its_limit_answers_the_over_marker_and_no_members(): void {
		$this->ask( [ 'SADD' => [ 'word:kea' => [ [ 'u-1' => 1, 'u-2' => 2, 'u-3' => 3, 'u-4' => 4, 'u-5' => 5 ] ], 'word:owl' => [ [ 'u-6' => 6, 'u-7' => 7, 'u-8' => 8 ] ] ] ], self::STRUCT );
		$this->assertSame(
			[
				[ Message::TM_BYTESTREAM, 'word:kea', "OVER 3\n" ],
				[ Message::TM_STRUCT, 'word:owl', [ [ 'u-6', 6 ], [ 'u-7', 7 ], [ 'u-8', 8 ] ] ],
				[ Message::TM_INFO, '', "SMEMBERS 2\n" ],
			],
			self::shape( $this->ask( "SMEMBERS 3 word:kea word:owl\n" ) ),
			'five members past a limit of 3 are over it; exactly three are not'
		);
	}

	public function test_a_set_lives_its_own_ttl_or_the_tables(): void {
		Core::$clock = static fn (): float => 1790000000.0;
		$this->ask( [ 'SADD' => [ 'word:kea' => [ [ 'u-41' => 1 ], 37 ], 'word:owl' => [ [ 'u-43' => 2 ] ] ] ], self::STRUCT );
		Core::$clock = static fn (): float => 1790000037.0;
		$this->assertSame( [ [ Message::TM_STRUCT, 'word:owl', [ [ 'u-43', 2 ] ] ], [ Message::TM_INFO, '', "SMEMBERS 1\n" ] ], self::shape( $this->ask( "SMEMBERS 9 word:kea word:owl\n" ) ) );
		Core::$clock = static fn (): float => 1790000777.0;
		$this->assertSame( [ [ Message::TM_INFO, '', "SMEMBERS 0\n" ] ], self::shape( $this->ask( "SMEMBERS 9 word:owl\n" ) ), 'an untimed set lives the declared 777 seconds' );
	}

	public function test_a_malformed_set_is_left_out_of_the_reply(): void {
		$replies = $this->ask( [ 'SADD' => [ 'word kea' => [ [ 'u-1' => 1 ] ], 'word:owl' => [ 'u-2' ], 'word:emu' => [ [ 'u-3' => 3 ], 0 ], 'word:tui' => [ [ 'u-4' => 4 ], 'soon' ], 'word:moa' => [ [ 'u-5' => 5 ], 37 ] ] ], self::STRUCT );
		$this->assertSame( [ [ Message::TM_RESPONSE, '', "SADD word:moa\n" ] ], self::shape( $replies ) );
		$this->assertSame( [ [ Message::TM_INFO, '', "SMEMBERS 0\n" ] ], self::shape( $this->ask( "SMEMBERS 9 word:owl word:emu word:tui\n" ) ) );
	}

	public function test_a_smembers_whose_limit_is_not_a_count_is_refused(): void {
		foreach ( [ '0', '-3', 'many', '' ] as $limit ) {
			$this->assertSame( [ [ Message::TM_ERROR, '', "SMEMBERS: usage: SMEMBERS <limit> <set_key>…, limit a whole number from 1 to 10000\n" ] ], self::shape( $this->ask( \rtrim( "SMEMBERS {$limit}" ) . " word:kea\n" ) ) );
		}
	}

	public function test_smembers_admits_a_limit_up_to_its_ceiling_and_refuses_one_above(): void {
		$this->assertSame( 10000, Table_Node::MAX_MEMBERS_LIMIT );
		$this->ask( [ 'SADD' => [ 'word:kea' => [ [ 'u-41' => 1 ] ] ] ], self::STRUCT );
		foreach ( [ '5001', '10000' ] as $limit ) {
			$this->assertSame( [ [ Message::TM_STRUCT, 'word:kea', [ [ 'u-41', 1 ] ] ], [ Message::TM_INFO, '', "SMEMBERS 1\n" ] ], self::shape( $this->ask( "SMEMBERS {$limit} word:kea\n" ) ) );
		}
		$this->assertSame( [ [ Message::TM_ERROR, '', "SMEMBERS: usage: SMEMBERS <limit> <set_key>…, limit a whole number from 1 to 10000\n" ] ], self::shape( $this->ask( "SMEMBERS 10001 word:kea\n" ) ) );
	}

	public function test_a_failed_member_read_answers_an_error_never_absence(): void {
		( new \PDO( 'sqlite:' . Table_Node::file( 'lab-7:kea', 3 ) ) )->exec( 'DROP TABLE members' );
		$this->assertSame( [ [ Message::TM_ERROR, '', "SMEMBERS: backend read failed\n" ] ], self::shape( $this->ask( "SMEMBERS 9 word:kea\n" ) ) );
	}

	public function test_a_corrupt_member_row_answers_a_failed_read(): void {
		$this->ask( [ 'SADD' => [ 'word:kea' => [ [ 'u-41' => 1 ] ] ] ], self::STRUCT );
		$db = new \PDO( 'sqlite:' . Table_Node::file( 'lab-7:kea', 3 ) );
		$db->exec( "UPDATE members SET \"value\" = 'zz-not-tagged'" );
		$this->assertSame( [ [ Message::TM_ERROR, '', "SMEMBERS: backend read failed\n" ] ], self::shape( $this->ask( "SMEMBERS 9 word:kea\n" ) ) );
	}

	public function test_a_salt_rotation_leaves_every_durable_row(): void {
		$this->table->store( 'sku-41', 'kea-4471' );
		$this->ask( [ 'SADD' => [ 'word:kea' => [ [ 'u-41' => 1 ] ] ] ], self::STRUCT );
		\Newspack_Nodes\Cache_Backend::rotate_salt();
		$this->assertSame( 'kea-4471', $this->table->lookup( 'sku-41' ), 'a keyed row outlives the rotation' );
		$this->assertSame( [ [ Message::TM_STRUCT, 'word:kea', [ [ 'u-41', 1 ] ] ], [ Message::TM_INFO, '', "SMEMBERS 1\n" ] ], self::shape( $this->ask( "SMEMBERS 9 word:kea\n" ) ), 'and so does a set' );
	}

	public function test_a_sqlite_table_keys_its_rows_by_namespace_and_key_alone(): void {
		$this->table->store( 'sku-41', 'kea-4471' );
		$this->ask( [ 'SADD' => [ 'word:kea' => [ [ 'u-41' => 1 ] ] ] ], self::STRUCT );
		$db = new \PDO( 'sqlite:' . Table_Node::file( 'lab-7:kea', 3 ) );
		$this->assertSame( [ 'kea:p3:sku-41' ], $db->query( 'SELECT "key" FROM kv' )->fetchAll( \PDO::FETCH_COLUMN ) );
		$this->assertSame( [ 'kea:p3:word:kea' ], $db->query( 'SELECT set_key FROM members' )->fetchAll( \PDO::FETCH_COLUMN ) );
	}

	public function test_a_wpdb_table_keys_its_rows_by_the_key_alone_under_its_namespace_column(): void {
		$this->use_wpdb();
		$owl = $this->worker_table( 'lab-7:owl', 'owl:p3', 'wpdb' );
		$owl->store( 'sku-43', 'owl-4473' );
		$this->ask( [ 'SADD' => [ 'word:owl' => [ [ 'u-43' => 3 ] ] ] ], self::STRUCT, $owl );
		$this->assertSame( [ [ 'namespace' => 'owl:p3', 'cache_key' => 'sku-43' ] ], $GLOBALS['wpdb']->get_results( 'SELECT namespace, cache_key FROM wp_newspack_nodes_table' ) );
		$this->assertSame( [ [ 'namespace' => 'owl:p3', 'set_key' => 'word:owl' ] ], $GLOBALS['wpdb']->get_results( 'SELECT namespace, set_key FROM wp_newspack_nodes_members' ) );
		$this->assertSame( 'owl-4473', $owl->lookup( 'sku-43' ) );
	}

	public function test_add_stores_under_its_own_ttl_only_where_absent(): void {
		Core::$clock = static fn (): float => 1790000000.0;
		$this->assertTrue( $this->table->add( 'sku-51', 'kea-51', 4242 ) );
		$this->assertFalse( $this->table->add( 'sku-51', 'lost-51', 5151 ), 'a live key is never displaced' );
		$this->assertSame( 'kea-51', $this->table->lookup( 'sku-51' ) );
		$db = new \PDO( 'sqlite:' . Table_Node::file( 'lab-7:kea', 3 ) );
		$this->assertSame( [ 1790004242 ], \array_map( 'intval', $db->query( "SELECT expires FROM kv WHERE \"key\" = 'kea:p3:sku-51'" )->fetchAll( \PDO::FETCH_COLUMN ) ), 'its own ttl, not the declared 777' );
	}

	public function test_add_refuses_a_ttl_below_one_second(): void {
		$this->expectException( \InvalidArgumentException::class );
		$this->expectExceptionMessage( 'Table lab-7:kea needs a TTL of at least 1 whole second, not 0' );
		$this->table->add( 'sku-52', 'kea-52', 0 );
	}

	public function test_lookup_entries_answers_each_live_entrys_remaining_life(): void {
		Core::$clock = static fn (): float => 1790000000.0;
		$this->table->add( 'sku-53', [ 'usd' => 53 ], 4242 );
		$this->table->store( 'sku-54', 'kea-54' );
		Core::$clock = static fn (): float => 1790000042.0;
		$this->assertSame(
			[
				'sku-53' => [ 'value' => [ 'usd' => 53 ], 'ttl' => 4200 ],
				'sku-54' => [ 'value' => 'kea-54', 'ttl' => 735 ],
			],
			$this->table->lookup_entries( [ 'sku-53', 'sku-54', 'sku-55' ] )
		);
	}

	public function test_lookup_entries_is_null_when_the_store_did_not_answer(): void {
		( new \PDO( 'sqlite:' . Table_Node::file( 'lab-7:kea', 3 ) ) )->exec( 'DROP TABLE kv' );
		$this->assertNull( $this->table->lookup_entries( [ 'sku-56' ] ) );
		$this->assertStringContainsString( 'no such table: kv', $this->table->last_failure() );
	}

	public function test_a_volatile_table_refuses_lookup_entries_and_purge(): void {
		Core::$memd = new InMemoryMemcached();
		$owl        = $this->worker_table( 'lab-7:owl-memcache', 'owl:p3', 'memcache' );
		foreach ( [ 'lookup_entries' => static fn () => $owl->lookup_entries( [ 'sku-57' ] ), 'purge' => static fn () => $owl->purge( 9 ), 'add_members' => static fn () => $owl->add_members( [ 'word:kea' => [ [ 'u-41' => 1 ] ] ] ), 'members_of' => static fn () => $owl->members_of( [ 'word:kea' ], 9 ) ] as $verb => $call ) {
			try {
				$call();
				$this->fail( "a volatile table answered {$verb}" );
			} catch ( \RuntimeException $e ) {
				$this->assertSame( "{$verb} needs a durable backend; lab-7:owl-memcache is memcache", $e->getMessage() );
			}
		}
	}

	public function test_purge_deletes_up_to_its_limit_of_expired_rows_counted_as_purge(): void {
		Core::$clock = static fn (): float => 1790000000.0;
		$this->table->add( 'sku-61', 'kea-61', 37 );
		$this->table->add( 'sku-62', 'kea-62', 37 );
		$this->table->add( 'sku-63', 'kea-63', 4242 );
		Core::$clock = static fn (): float => 1790000037.0;
		$this->assertSame( 1, $this->table->purge( 1 ) );
		$this->assertSame( 1, $this->table->purge( 9 ) );
		$this->assertSame( 0, $this->table->purge( 9 ) );
		$this->assertSame( [ 'calls' => 3, 'asked' => 19, 'answered' => 2 ], \array_intersect_key( $this->table->stats()['PURGE'], [ 'calls' => 0, 'asked' => 0, 'answered' => 0 ] ) );
		$this->assertSame( 'kea-63', $this->table->lookup( 'sku-63' ) );
	}

	/**
	 * `add_members()` and `members_of()` are SADD and SMEMBERS for a caller
	 * outside a graph, down the same path: the same set keys land, the same
	 * rows are counted, the same limit tells a full set from one over it.
	 */
	public function test_add_members_and_members_of_take_the_sadd_and_smembers_path(): void {
		Core::$clock = static fn (): float => 1790000000.0;
		$this->assertSame( [ 'word:kea', 'word:emu' ], $this->table->add_members( [ 'word:kea' => [ [ 'u-43' => 43, 'u-41' => [ 'n' => 41 ] ], 4242 ], 'word kea' => [ [ 'u-9' => 9 ] ], 'word:emu' => [ [ 'u-47' => 47 ] ] ] ) );
		$this->assertSame(
			[ 'word:kea' => [ 'u-41' => [ 'n' => 41 ], 'u-43' => 43 ], 'word:emu' => [ 'u-47' => 47 ] ],
			$this->table->members_of( [ 'word:kea', 'word:owl', 'word:emu' ], 2 )
		);
		$this->assertSame( [ 'word:kea' => null ], $this->table->members_of( [ 'word:kea' ], 1 ), 'a set past the limit answers null' );
		$this->assertSame( [ 'calls' => 0, 'asked' => 3, 'answered' => 3 ], \array_intersect_key( $this->table->stats()['SADD'], [ 'calls' => 0, 'asked' => 0, 'answered' => 0 ] ) );
		$this->assertSame( [ 'calls' => 0, 'asked' => 4, 'answered' => 3 ], \array_intersect_key( $this->table->stats()['SMEMBERS'], [ 'calls' => 0, 'asked' => 0, 'answered' => 0 ] ) );
		Core::$clock = static fn (): float => 1790000777.0;
		$this->assertSame( [ 'word:kea' => [ 'u-41' => [ 'n' => 41 ], 'u-43' => 43 ] ], $this->table->members_of( [ 'word:kea', 'word:emu' ], 9 ), 'each set under its own ttl, or the Table\'s' );
	}

	public function test_members_of_is_null_when_the_store_did_not_answer(): void {
		( new \PDO( 'sqlite:' . Table_Node::file( 'lab-7:kea', 3 ) ) )->exec( 'DROP TABLE members' );
		$this->assertNull( $this->table->members_of( [ 'word:kea' ], 9 ) );
		$this->assertStringContainsString( 'no such table: members', $this->table->last_failure() );
	}

	public function test_members_of_refuses_a_limit_smembers_refuses(): void {
		foreach ( [ 0, Table_Node::MAX_MEMBERS_LIMIT + 1 ] as $limit ) {
			try {
				$this->table->members_of( [ 'word:kea' ], $limit );
				$this->fail( "members_of() took limit {$limit}" );
			} catch ( \InvalidArgumentException $e ) {
				$this->assertSame( 'members_of: limit a whole number from 1 to 10000', $e->getMessage() );
			}
		}
	}

	public function test_a_string_sadd_is_refused_toward_the_structured_form(): void {
		$this->assertSame( [ [ Message::TM_ERROR, '', "SADD: needs a map of set key => [ [ member => value, … ], ttl ]\n" ] ], self::shape( $this->ask( "SADD word:kea u-41\n" ) ) );
		$this->assertSame( [ [ Message::TM_ERROR, '', "SADD: needs a map of set key => [ [ member => value, … ], ttl ]\n" ] ], self::shape( $this->ask( [ 'SADD' => 'word:kea' ], self::STRUCT ) ) );
	}

	public function test_a_volatile_table_refuses_both_member_verbs_naming_itself_and_its_backend(): void {
		Core::$memd = new InMemoryMemcached();
		$tables     = [ 'memcache' => $this->worker_table( 'lab-7:owl-memcache', 'owl:p3', 'memcache' ), 'auto' => $this->worker_table( 'lab-7:owl-auto', 'owl:p3', 'auto' ) ];
		Core::$memd = null;
		foreach ( $tables as $backend => $owl ) {
			foreach ( [ [ [ 'SADD' => [ 'word:kea' => [ [ 'u-41' => 1 ] ] ] ], self::STRUCT, 'SADD' ], [ [ 'SADD' => [ 'word kea' => [ [ 'u-41' => 1 ] ] ] ], self::STRUCT, 'SADD' ], [ "SMEMBERS 9 word:kea\n", Message::TM_REQUEST, 'SMEMBERS' ] ] as [ $value, $type, $verb ] ) {
				$this->assertSame( [ [ Message::TM_ERROR, '', "{$verb}: needs a durable backend; lab-7:owl-{$backend} is {$backend}\n" ] ], self::shape( $this->ask( $value, $type, $owl ) ) );
			}
		}
	}

	public function test_smove_answers_the_moved_members_as_one_set_then_srem_the_members_that_were_there(): void {
		$this->ask( [ 'SADD' => [ 'pend-3307' => [ [ 'x-2' => [ 'n' => 2 ], 'x-1' => 'one', 'x-3' => 3 ] ] ] ], self::STRUCT );
		$this->assertSame(
			[ [ Message::TM_STRUCT, 'pend-3307', [ [ 'x-1', 'one' ], [ 'x-2', [ 'n' => 2 ] ] ] ], [ Message::TM_INFO, '', "SMOVE 1\n" ] ],
			self::shape( $this->ask( "SMOVE 2 pend-3307 fly-3307\n" ) )
		);
		$this->assertSame( [ [ Message::TM_RESPONSE, '', "SREM x-1\n" ] ], self::shape( $this->ask( "SREM fly-3307 x-1 x-8 x-1\n" ) ), 'each member named once, and only those that were there' );
		$this->assertSame(
			[ [ Message::TM_STRUCT, 'pend-3307', [ [ 'x-3', 3 ] ] ], [ Message::TM_STRUCT, 'fly-3307', [ [ 'x-2', [ 'n' => 2 ] ] ] ], [ Message::TM_INFO, '', "SMEMBERS 2\n" ] ],
			self::shape( $this->ask( "SMEMBERS 9 pend-3307 fly-3307\n" ) )
		);
	}

	public function test_smove_and_srem_count_their_calls_and_keys(): void {
		$this->ask( [ 'SADD' => [ 'pend-3307' => [ [ 'x-1' => 1, 'x-2' => 2, 'x-3' => 3 ] ] ] ], self::STRUCT );
		$this->ask( "SMOVE 2 pend-3307 fly-3307\n" );
		$this->ask( "SREM fly-3307 x-1 x-8 x-1\n" );
		$keys = [ 'calls' => 0, 'asked' => 0, 'answered' => 0 ];
		$this->assertSame( [ 'calls' => 1, 'asked' => 2, 'answered' => 2 ], \array_intersect_key( $this->table->stats()['SMOVE'], $keys ) );
		$this->ask( "SMOVE 7 pend-3307 fly-3307\n" );
		$this->assertSame( [ 'calls' => 2, 'asked' => 9, 'answered' => 3 ], \array_intersect_key( $this->table->stats()['SMOVE'], $keys ), 'asked counts the members requested, as SREM counts those named' );
		$this->assertSame( [ 'calls' => 1, 'asked' => 2, 'answered' => 1 ], \array_intersect_key( $this->table->stats()['SREM'], $keys ) );
	}

	public function test_a_smove_from_an_empty_set_answers_an_empty_struct_and_a_count_of_one(): void {
		$this->assertSame( [ [ Message::TM_STRUCT, 'void-5521', [] ], [ Message::TM_INFO, '', "SMOVE 1\n" ] ], self::shape( $this->ask( "SMOVE 3 void-5521 fly-5521\n" ) ) );
	}

	public function test_a_smove_naming_one_set_twice_is_refused(): void {
		$this->ask( [ 'SADD' => [ 'pend-3307' => [ [ 'x-1' => 1 ] ] ] ], self::STRUCT );

		$this->assertSame( [ [ Message::TM_ERROR, '', "SMOVE: from_set and to_set must differ\n" ] ], self::shape( $this->ask( "SMOVE 2 pend-3307 pend-3307\n" ) ) );
		$this->assertSame( [ [ Message::TM_STRUCT, 'pend-3307', [ [ 'x-1', 1 ] ] ], [ Message::TM_INFO, '', "SMEMBERS 1\n" ] ], self::shape( $this->ask( "SMEMBERS 9 pend-3307\n" ) ), 'nothing moved' );
	}

	public function test_a_malformed_smove_or_srem_is_refused_with_its_usage(): void {
		$smove = 'SMOVE: usage: SMOVE <count> <from_set> <to_set>, count a whole number from 1 to 10000';
		foreach ( [ "SMOVE 0 a b\n", "SMOVE 10001 a b\n", "SMOVE 2 a\n", "SMOVE\n", "SMOVE two a b\n" ] as $request ) {
			$this->assertSame( [ [ Message::TM_ERROR, '', "{$smove}\n" ] ], self::shape( $this->ask( $request ) ), $request );
		}
		foreach ( [ "SREM\n", "SREM fly-3307\n" ] as $request ) {
			$this->assertSame( [ [ Message::TM_ERROR, '', "SREM: usage: SREM <set_key> <member>…\n" ] ], self::shape( $this->ask( $request ) ), $request );
		}
		$this->assertSame( 2, $this->table->stats()['SREM']['errors'] );
	}

	public function test_a_volatile_table_refuses_smove_and_srem_naming_itself_and_its_backend(): void {
		Core::$memd = new InMemoryMemcached();
		$owl        = $this->worker_table( 'lab-7:owl-memcache', 'owl:p3', 'memcache' );
		Core::$memd = null;
		foreach ( [ 'SMOVE' => "SMOVE 2 a b\n", 'SREM' => "SREM a x-1\n" ] as $verb => $request ) {
			$this->assertSame( [ [ Message::TM_ERROR, '', "{$verb}: needs a durable backend; lab-7:owl-memcache is memcache\n" ] ], self::shape( $this->ask( $request, Message::TM_REQUEST, $owl ) ) );
		}
	}

	public function test_a_failed_smove_or_srem_answers_an_error_and_counts_it(): void {
		$this->ask( [ 'SADD' => [ 'pend-3307' => [ [ 'x-1' => 1 ] ] ] ], self::STRUCT );
		( new \PDO( 'sqlite:' . Table_Node::file( 'lab-7:kea', 3 ) ) )->exec( 'DROP TABLE members' );
		$this->assertSame( [ [ Message::TM_ERROR, '', "SMOVE: backend write failed\n" ] ], self::shape( $this->ask( "SMOVE 2 pend-3307 fly-3307\n" ) ) );
		$this->assertSame( [ [ Message::TM_ERROR, '', "SREM: backend write failed\n" ] ], self::shape( $this->ask( "SREM pend-3307 x-1\n" ) ) );
		$this->assertSame( [ 1, 1 ], [ $this->table->stats()['SMOVE']['errors'], $this->table->stats()['SREM']['errors'] ] );
	}

	public function test_a_failed_wpdb_set_add_is_retried_set_by_set(): void {
		$this->use_wpdb();
		$owl     = $this->worker_table( 'lab-7:owl', 'owl:p3', 'wpdb' );
		$replies = $this->ask( [ 'SADD' => [ 'word:kea' => [ [ 'u-41' => 1 ] ], 'word:owl' => [ [ \str_repeat( 'u', 256 ) => 2 ] ], 'word:emu' => [ [ 'u-47' => 7 ] ] ] ], self::STRUCT, $owl );
		$this->assertSame( [ [ Message::TM_RESPONSE, '', "SADD word:kea word:emu\n" ] ], self::shape( $replies ), 'the set wider than its column is left out and the rest land' );
		$this->assertSame( [ [ Message::TM_STRUCT, 'word:emu', [ [ 'u-47', 7 ] ] ], [ Message::TM_INFO, '', "SMEMBERS 1\n" ] ], self::shape( $this->ask( "SMEMBERS 9 word:emu\n", Message::TM_REQUEST, $owl ) ) );
	}

	public function test_a_throw_inside_a_durable_arm_escapes_both_member_verbs(): void {
		$this->use_wpdb();
		$owl             = $this->worker_table( 'lab-7:owl', 'owl:p3', 'wpdb' );
		$GLOBALS['wpdb'] = null;
		foreach ( [ [ [ 'SADD' => [ 'word:kea' => [ [ 'u-41' => 1 ] ] ] ], self::STRUCT ], [ "SMEMBERS 9 word:kea\n", Message::TM_REQUEST ] ] as [ $value, $type ] ) {
			try {
				$this->ask( $value, $type, $owl );
				$this->fail( 'the arm\'s own throw was answered as a refusal' );
			} catch ( \LogicException $e ) {
				$this->assertSame( 'wpdb backend needs $wpdb', $e->getMessage() );
			}
			$this->assertSame( [], $this->sink->captured );
		}
	}

	// ── RM and TOUCH of many keys: one write scope for the request ──

	/** The keyed rows another connection reads in the Table's file. */
	private static function committed_keys(): array {
		return ( new \PDO( 'sqlite:' . Table_Node::file( 'lab-7:kea', 3 ) ) )->query( 'SELECT "key" FROM kv ORDER BY "key"' )->fetchAll( \PDO::FETCH_COLUMN );
	}

	public function test_rm_and_touch_of_many_keys_dirty_their_pages_once(): void {
		$this->table->store_multi( [ 'sku-41' => 'kea-41', 'sku-43' => 'kea-43', 'sku-47' => 'kea-47', 'sku-53' => 'kea-53', 'sku-59' => 'kea-59' ] );
		$db     = new \PDO( 'sqlite:' . Table_Node::file( 'lab-7:kea', 3 ) );
		$frames = function ( string $request ) use ( $db ): int {
			// A written-back WAL restarts under the request's own writes.
			$db->query( 'PRAGMA wal_checkpoint(PASSIVE)' )->fetchAll();
			$this->ask( $request );
			return Core::as_int( $db->query( 'PRAGMA wal_checkpoint(PASSIVE)' )->fetchAll( \PDO::FETCH_NUM )[0][1] );
		};
		$two = $frames( "TOUCH 4471 sku-41 sku-43\n" );
		$one = $frames( "TOUCH 4473 sku-47\n" );
		$this->assertGreaterThan( 0, $one );
		$this->assertSame( $one, $two, 'TOUCH ran one BEGIN IMMEDIATE for both keys' );
		$two = $frames( "RM sku-41 sku-43\n" );
		$one = $frames( "RM sku-47\n" );
		$this->assertGreaterThan( 0, $one );
		$this->assertSame( $one, $two, 'RM ran one BEGIN IMMEDIATE for both keys' );
		$this->assertSame( [ 'kea:p3:sku-53', 'kea:p3:sku-59' ], self::committed_keys() );
	}

	public function test_a_key_named_twice_is_answered_and_counted_once(): void {
		$this->table->store_multi( [ 'sku-41' => 'kea-41', 'sku-43' => 'kea-43' ] );
		$this->assertSame( [ [ Message::TM_RESPONSE, '', "TOUCH sku-41\n" ] ], self::shape( $this->ask( "TOUCH 4471 sku-41 sku-41\n" ) ) );
		$this->assertSame( [ [ Message::TM_RESPONSE, '', "RM sku-41\n" ] ], self::shape( $this->ask( "RM sku-41 sku-41\n" ) ) );
		$stats = $this->table->stats();
		$this->assertSame( [ 1, 1, 1, 1 ], [ $stats['TOUCH']['asked'], $stats['TOUCH']['answered'], $stats['RM']['asked'], $stats['RM']['answered'] ] );
	}

	public function test_rm_and_touch_of_many_keys_land_together_or_not_at_all(): void {
		$this->table->store_multi( [ 'sku-41' => 'kea-41', 'sku-43' => 'kea-43', 'sku-47' => 'kea-47' ] );
		$db = new \PDO( 'sqlite:' . Table_Node::file( 'lab-7:kea', 3 ) );
		$db->exec( "CREATE TRIGGER no_rm BEFORE DELETE ON kv WHEN OLD.\"key\" = 'kea:p3:sku-43' BEGIN SELECT RAISE( ROLLBACK, 'rm 4473' ); END" );
		$db->exec( "CREATE TRIGGER no_touch BEFORE UPDATE ON kv WHEN OLD.\"key\" = 'kea:p3:sku-47' BEGIN SELECT RAISE( ROLLBACK, 'touch 4477' ); END" );
		$this->assertSame( [ [ Message::TM_RESPONSE, '', "RM\n" ] ], self::shape( $this->ask( "RM sku-41 sku-43\n" ) ) );
		$this->assertSame( [ 'kea:p3:sku-41', 'kea:p3:sku-43', 'kea:p3:sku-47' ], self::committed_keys(), 'sku-41 stayed with sku-43' );
		$expires = static fn (): array => $db->query( 'SELECT expires FROM kv ORDER BY "key"' )->fetchAll( \PDO::FETCH_COLUMN );
		$before  = $expires();
		$this->assertSame( [ [ Message::TM_RESPONSE, '', "TOUCH\n" ] ], self::shape( $this->ask( "TOUCH 4471 sku-41 sku-47\n" ) ) );
		$this->assertSame( $before, $expires(), 'sku-41 kept its expiry with sku-47' );
		$this->assertSame( [ [ Message::TM_RESPONSE, '', "RM sku-41 sku-47\n" ] ], self::shape( $this->ask( "RM sku-41 sku-47\n" ) ) );
		$this->assertSame( [ 'kea:p3:sku-43' ], self::committed_keys() );
	}

	// ── flush: every row and member, MANAGE by declaring nothing, the writer's alone ──

	/** The `flush` verb as a worker's `:config` interpreter answers it. */
	private function flush_verb( string $table = 'lab-7:kea' ): mixed {
		return Core::node( "{$table}:config" )->dispatch( 'flush' );
	}

	public function test_the_flush_verb_recreates_a_sqlite_file_and_answers_the_bytes_released(): void {
		$this->table->store( 'sku-41', 'kea-41' );
		$this->table->store( 'sku-43', 'kea-43' );
		$this->ask( [ 'SADD' => [ 'word:kea' => [ [ 'u-41' => 1, 'u-43' => 3 ] ] ] ], self::STRUCT );
		$file = Table_Node::file( 'lab-7:kea', 3 );
		( new \PDO( 'sqlite:' . $file ) )->exec( 'PRAGMA user_version = 4471' );

		$reply = $this->flush_verb();

		$this->assertSame( [ 'bytes' ], \array_keys( $reply ) );
		$this->assertGreaterThan( 0, $reply['bytes'] );
		$this->assertSame( 0, (int) ( new \PDO( 'sqlite:' . $file ) )->query( 'PRAGMA user_version' )->fetchColumn(), 'the file was recreated' );
		$this->assertSame( [ [ Message::TM_INFO, '', "MGET 0\n" ] ], self::shape( $this->ask( "MGET sku-41 sku-43\n" ) ) );
		$this->assertSame( [ [ Message::TM_INFO, '', "SMEMBERS 0\n" ] ], self::shape( $this->ask( "SMEMBERS 9 word:kea\n" ) ) );
		$this->table->store( 'sku-4477', 'kea-4477' );
		$this->assertSame( 'kea-4477', $this->table->lookup( 'sku-4477' ), 'a write then a read works' );
	}

	public function test_a_flush_forgets_the_state_that_described_the_old_file(): void {
		$state = [ 'checkpoint_due' => 1, 'wal_stalled' => 3, 'wal_stall_frames' => 4471, 'purge_behind' => true ];
		foreach ( $state as $field => $value ) {
			( new \ReflectionProperty( Table_Node::class, $field ) )->setValue( $this->table, $value );
		}
		Core::$now = 1790004471.0;

		$this->flush_verb();

		$this->assertSame(
			[ 'checkpoint_due' => 1790004471 + Table_Node::CHECKPOINT_INTERVAL_S, 'wal_stalled' => 0, 'wal_stall_frames' => 0, 'purge_behind' => false ],
			\array_map( fn ( string $field ): mixed => ( new \ReflectionProperty( Table_Node::class, $field ) )->getValue( $this->table ), \array_combine( \array_keys( $state ), \array_keys( $state ) ) )
		);
	}

	public function test_a_wpdb_flush_answers_the_rows_it_deleted(): void {
		$this->use_wpdb();
		$owl = $this->worker_table( 'lab-7:owl', 'owl:p3', 'wpdb' );
		$owl->store( 'sku-41', 'owl-41' );
		$this->ask( [ 'SADD' => [ 'word:owl' => [ [ 'u-41' => 1, 'u-43' => 3 ] ] ] ], self::STRUCT, $owl );
		$this->assertSame( [ 'rows' => 3 ], $this->flush_verb( 'lab-7:owl' ) );
	}

	public function test_the_flush_verb_refuses_a_session_scope_below_manage(): void {
		$this->table->store( 'sku-47', 'kea-47' );
		foreach ( [ \Newspack_Nodes\Capabilities::READ, \Newspack_Nodes\Capabilities::TUNE ] as $scope ) {
			\Newspack_Nodes\Capabilities::$session_scope = $scope;
			try {
				$this->flush_verb();
				$this->fail( "a {$scope} session flushed" );
			} catch ( \RuntimeException $e ) {
				$this->assertSame( 'permission denied: manage capability required', $e->getMessage() );
			} finally {
				\Newspack_Nodes\Capabilities::$session_scope = null;
			}
		}
		$this->assertSame( 'kea-47', $this->table->lookup( 'sku-47' ) );
		\Newspack_Nodes\Capabilities::$session_scope = \Newspack_Nodes\Capabilities::MANAGE;
		try {
			$this->assertArrayHasKey( 'bytes', $this->flush_verb(), 'a manage session flushes' );
		} finally {
			\Newspack_Nodes\Capabilities::$session_scope = null;
		}
	}

	public function test_the_flush_verb_is_refused_on_a_mount_and_a_volatile_table(): void {
		$this->table->store( 'sku-49', 'kea-49' );
		$this->mounted_kea();
		Core::$memd = new InMemoryMemcached();
		$this->worker_table( 'lab-7:owl-memcache', 'owl:p3', 'memcache' );
		foreach ( [ 'lab-7:kea.p3' => 'flush: lab-7:kea.p3 is a mounted Table, which serves reads only', 'lab-7:owl-memcache' => 'flush needs a durable backend; lab-7:owl-memcache is memcache' ] as $table => $refusal ) {
			try {
				$this->flush_verb( $table );
				$this->fail( "{$table} flushed" );
			} catch ( \RuntimeException $e ) {
				$this->assertSame( $refusal, $e->getMessage() );
			}
		}
		$this->assertSame( 'kea-49', $this->table->lookup( 'sku-49' ) );
	}

	public function test_a_flush_the_store_refuses_throws_naming_the_table_and_the_failure(): void {
		$this->use_wpdb();
		$this->worker_table( 'lab-7:owl', 'owl:p3', 'wpdb' );
		$GLOBALS['wpdb']->deny['DELETE FROM `wp_newspack_nodes_members`'] = 'Lock wait timeout 4473';
		$this->expectExceptionMessage( 'Table lab-7:owl: flush failed: wpdb wp_newspack_nodes_table: Lock wait timeout 4473' );
		$this->flush_verb( 'lab-7:owl' );
	}

	// ── A mount serves reads only: the declaring worker is the file's one writer ──

	private function mounted_kea(): Table_Node {
		return Table_Node::mount( 'lab-7:kea', 3, [ 'namespace' => 'kea:p3', 'ttl' => 777, 'backend' => 'sqlite' ], $this->sink );
	}

	public function test_a_mount_refuses_every_write_verb(): void {
		$this->table->store( 'sku-41', 'kea-41' );
		$mount  = $this->mounted_kea();
		$struct = Message::TM_REQUEST | Message::TM_STRUCT;
		foreach ( [ 'RM' => [ "RM sku-41\n", Message::TM_REQUEST ], 'TOUCH' => [ "TOUCH 37 sku-41\n", Message::TM_REQUEST ], 'MSET' => [ [ 'MSET' => [ 'sku-41' => [ 'owl' ] ] ], $struct ], 'ADD' => [ [ 'ADD' => [ 'sku-44' => [ 'owl' ] ] ], $struct ], 'SADD' => [ [ 'SADD' => [ 'word:kea' => [ [ 'u-41' => 'owl' ] ] ] ], $struct ], 'SMOVE' => [ "SMOVE 2 word:kea word:owl\n", Message::TM_REQUEST ], 'SREM' => [ "SREM word:kea u-41\n", Message::TM_REQUEST ] ] as $verb => [ $value, $type ] ) {
			$replies = $this->ask( $value, $type, $mount );
			$this->assertSame( [ [ Message::TM_ERROR, '', "{$verb}: a mounted Table serves reads only\n" ] ], self::shape( $replies ) );
			$this->assertSame( [ 'lab-7:kea.p3', 'asker-9', 'ask-17' ], [ $replies[0][ Message::FROM ], $replies[0][ Message::TO ], $replies[0][ Message::ID ] ] );
		}
		$this->assertSame( 'kea-41', $this->table->lookup( 'sku-41' ) );
		$this->assertNull( $this->table->lookup( 'sku-44' ) );
		$this->assertSame( [ [ Message::TM_INFO, '', "SMEMBERS 0\n" ] ], self::shape( $this->ask( "SMEMBERS 9 word:kea\n" ) ), 'the refused SADD added no member' );
	}

	public function test_a_mount_answers_every_read_verb(): void {
		$this->table->store( 'sku-41', 'kea-41' );
		$mount = $this->mounted_kea();
		$value = [ Message::TM_BYTESTREAM, 'sku-41', 'kea-41' ];
		$this->assertSame( [ $value, [ Message::TM_INFO, '', "GET 1\n" ] ], self::shape( $this->ask( "GET sku-41\n", Message::TM_REQUEST, $mount ) ) );
		$this->assertSame( [ $value, [ Message::TM_INFO, '', "MGET 1\n" ] ], self::shape( $this->ask( "MGET sku-41 sku-42\n", Message::TM_REQUEST, $mount ) ) );
		$this->ask( [ 'SADD' => [ 'word:kea' => [ [ 'u-41' => 'kea-41' ] ] ] ], Message::TM_REQUEST | Message::TM_STRUCT );
		$this->assertSame( [ [ Message::TM_STRUCT, 'word:kea', [ [ 'u-41', 'kea-41' ] ] ], [ Message::TM_INFO, '', "SMEMBERS 1\n" ] ], self::shape( $this->ask( "SMEMBERS 9 word:kea\n", Message::TM_REQUEST, $mount ) ) );
	}

	public function test_a_mount_of_a_file_its_writer_declared_before_members_reads_no_members(): void {
		$file = Table_Node::file( 'lab-7:owl', 3 );
		$db   = new \PDO( 'sqlite:' . $file );
		$db->exec( 'PRAGMA journal_mode = WAL' );
		$db->exec( 'CREATE TABLE kv ( "key" TEXT PRIMARY KEY, "value" BLOB NOT NULL, expires INTEGER NOT NULL )' );
		$mount = Table_Node::mount( 'lab-7:owl', 3, [ 'namespace' => 'owl:p3', 'ttl' => 777, 'backend' => 'sqlite' ], $this->sink );
		$this->assertSame( [ [ Message::TM_INFO, '', "SMEMBERS 0\n" ] ], self::shape( $this->ask( "SMEMBERS 9 word:kea\n", Message::TM_REQUEST, $mount ) ) );
	}

	public function test_a_mount_drops_an_insert_out_loud(): void {
		$logged = [];
		\add_action(
			'newspack_nodes/stderr',
			static function ( string $line ) use ( &$logged ): void {
				$logged[] = $line;
			}
		);
		$mount                   = $this->mounted_kea();
		$insert                  = Message::new_message();
		$insert[ Message::TYPE ]  = Message::TM_BYTESTREAM;
		$insert[ Message::FROM ]  = 'asker-9';
		$insert[ Message::KEY ]   = 'sku-43';
		$insert[ Message::VALUE ] = 'owl-43';
		$this->sink->captured    = [];
		$mount->fill( $insert );
		$this->assertSame( [], $this->sink->captured, 'a dropped INSERT is neither answered nor forwarded' );
		$this->assertNull( $this->table->lookup( 'sku-43' ) );
		$this->assertCount( 1, $logged );
		$this->assertStringContainsString( 'ERROR: refused an INSERT through a mounted Table - from: asker-9', $logged[0] );
	}
}
