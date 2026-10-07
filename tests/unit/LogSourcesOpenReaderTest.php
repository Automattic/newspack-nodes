<?php
declare(strict_types=1);

namespace Newspack_Nodes\Tests\Unit;

use PHPUnit\Framework\Attributes\CoversClass;
use Newspack_Nodes\Consumer_Node;
use Newspack_Nodes\File_Tail_Node;
use Newspack_Nodes\Log_Discovery;
use Newspack_Nodes\Log_Sources;
use Newspack_Nodes\Message;
use Newspack_Nodes\Tests\TestCase;

/**
 * One name, one log: `open_reader()`, `footprint()` and `read()` resolve the
 * stream's and the single-step read's names alike, and refuse any they
 * cannot place.
 */
#[CoversClass( Log_Sources::class )]
#[CoversClass( Log_Discovery::class )]
final class LogSourcesOpenReaderTest extends TestCase {

	private string $tmp;

	protected function setUp(): void {
		parent::setUp();
		$this->tmp = (string) \realpath( \sys_get_temp_dir() ) . '/open-reader-' . \uniqid();
		\mkdir( $this->tmp, 0755, true );
		$this->use_base_dir( $this->tmp, [ 'num_partitions' => 1 ] );
		Log_Discovery::reset();
	}

	protected function tearDown(): void {
		Log_Sources::$builtin_sources = null;
		Log_Discovery::reset();
		$this->rmdir_recursive( $this->tmp );
		parent::tearDown();
	}

	public function test_a_bare_stamp_opens_a_consumer_over_its_logs_dir(): void {
		\mkdir( "{$this->tmp}/logs/kea-7713.p3", 0755, true );

		$reader = Log_Sources::open_reader( 'kea-7713.p3' );

		$this->assertSame( Consumer_Node::class, $reader::class );
		$this->assertSame( "{$this->tmp}/logs/kea-7713.p3", $this->read_private( $reader, 'source_dir' ) );
		$this->assertSame( 'kea-7713.p3', $reader->stamped_as() );
		$reader->remove_node();
	}

	public function test_a_grouped_stamp_opens_its_own_root(): void {
		\mkdir( "{$this->tmp}/offsets/hub.kea-7713.p3", 0755, true );

		$reader = Log_Sources::open_reader( 'offsets/hub.kea-7713.p3' );

		$this->assertSame( "{$this->tmp}/offsets/hub.kea-7713.p3", $this->read_private( $reader, 'source_dir' ) );
		$reader->remove_node();
	}

	public function test_a_sources_stamp_opens_the_registry_entrys_tail(): void {
		$path = "{$this->tmp}/php-errors-4194.log";
		\file_put_contents( $path, "PHP Warning: 977\n" );
		Log_Sources::$builtin_sources = static fn (): array => [ 'php' => $path ];

		$reader = Log_Sources::open_reader( 'sources/php' );

		$this->assertInstanceOf( File_Tail_Node::class, $reader );
		$this->assertSame( $path, $this->read_private( $reader, 'source_file' ) );
		$this->assertSame( 'sources/php', $reader->stamped_as() );
		$reader->remove_node();
	}

	public function test_an_unknown_dir_stamp_is_refused_by_name(): void {
		\mkdir( "{$this->tmp}/logs/firehose.p0", 0755, true );

		$this->expectException( \InvalidArgumentException::class );
		$this->expectExceptionMessage( 'unknown log: "kea-7713.p9"' );

		Log_Sources::open_reader( 'kea-7713.p9' );
	}

	public function test_an_empty_name_is_refused_by_the_streams_guard(): void {
		\mkdir( "{$this->tmp}/logs/firehose.p0", 0755, true );

		$this->expectException( \InvalidArgumentException::class );
		$this->expectExceptionMessage( 'invalid subscription: ' );

		Log_Sources::open_reader( '' );
	}

	public function test_a_name_the_streams_guard_refuses_opens_nothing(): void {
		\mkdir( "{$this->tmp}/logs/Kea-7713.p3", 0755, true );

		$this->expectException( \InvalidArgumentException::class );
		$this->expectExceptionMessage( 'invalid subscription: Kea-7713.p3' );

		Log_Sources::open_reader( 'Kea-7713.p3' );
	}

	public function test_a_logs_dir_named_like_a_group_does_not_break_another_read(): void {
		\mkdir( "{$this->tmp}/logs/sources", 0755, true );
		\mkdir( "{$this->tmp}/logs/kea-7713.p3", 0755, true );

		$reader = Log_Sources::open_reader( 'kea-7713.p3' );

		$this->assertSame( "{$this->tmp}/logs/kea-7713.p3", $this->read_private( $reader, 'source_dir' ) );
		$reader->remove_node();
	}

	public function test_footprint_sizes_a_dir_through_its_partition(): void {
		$dir = "{$this->tmp}/deadletter/jobs-6143.p2";
		\mkdir( $dir, 0755, true );
		\file_put_contents( "{$dir}/4.log", \str_repeat( 'q', 613 ) );
		\file_put_contents( "{$dir}/9.log", \str_repeat( 'r', 71 ) );

		$this->assertSame(
			[
				'segments'   => [ [ 'id' => 4, 'size' => 613 ], [ 'id' => 9, 'size' => 71 ] ],
				'total_size' => 684,
			],
			Log_Sources::footprint( 'deadletter/jobs-6143.p2' )
		);
	}

	public function test_footprint_of_an_empty_dir_is_zero(): void {
		\mkdir( "{$this->tmp}/logs/kea-7713.p3", 0755, true );

		$this->assertSame( [ 'segments' => [], 'total_size' => 0 ], Log_Sources::footprint( 'kea-7713.p3' ) );
	}

	public function test_footprint_refuses_an_unknown_dir_by_name(): void {
		$this->expectException( \InvalidArgumentException::class );
		$this->expectExceptionMessage( 'unknown log: "kea-7713.p9"' );

		Log_Sources::footprint( 'kea-7713.p9' );
	}

	public function test_read_answers_the_record_at_a_dir_position(): void {
		$dir = "{$this->tmp}/logs/kea-7713.p3";
		\mkdir( $dir, 0755, true );
		$m                     = Message::new_message();
		$m[ Message::TYPE ]    = Message::TM_BYTESTREAM;
		$m[ Message::VALUE ]   = 'only record 5531';
		$line                  = Message::packed( $m ) . "\n";
		\file_put_contents( "{$dir}/6.log", $line );

		$result = Log_Sources::read( 'kea-7713.p3', '6:0' );

		$this->assertSame( 'kea-7713.p3', $result['source'] );
		$this->assertSame( 'only record 5531', $result['message'][ Message::VALUE ] );
		$this->assertSame( 'kea-7713.p3', $result['message'][ Message::FROM ] );
		$this->assertSame( [ 'segment' => 6, 'offset' => \strlen( $line ) ], $result['cursor'] );
	}

	/** A packed record line carrying $value. */
	private static function record( string $value ): string {
		$m                   = Message::new_message();
		$m[ Message::TYPE ]  = Message::TM_BYTESTREAM;
		$m[ Message::VALUE ] = $value;
		return Message::packed( $m ) . "\n";
	}

	public function test_no_record_past_the_last_is_a_result_at_eof(): void {
		$dir  = "{$this->tmp}/logs/kea-7713.p3";
		$line = self::record( 'the only record 6604' );
		\mkdir( $dir, 0755, true );
		\file_put_contents( "{$dir}/6.log", $line );

		$this->assertSame(
			[
				'source'  => 'kea-7713.p3',
				'message' => null,
				'cursor'  => [ 'segment' => 6, 'offset' => \strlen( $line ) ],
				'at_eof'  => true,
			],
			Log_Sources::read( 'kea-7713.p3', '6:' . \strlen( $line ) )
		);
	}

	public function test_an_unparseable_line_is_consumed_without_a_record_and_not_at_eof(): void {
		$dir   = "{$this->tmp}/logs/kea-7713.p3";
		$first = self::record( 'before 7781' );
		$bad   = "not a packed line 7781\n";
		\mkdir( $dir, 0755, true );
		\file_put_contents( "{$dir}/5.log", $first . $bad . self::record( 'after 7781' ) );

		$result = Log_Sources::read( 'kea-7713.p3', '5:' . \strlen( $first ) );

		$this->assertNull( $result['message'] );
		$this->assertFalse( $result['at_eof'], 'a good record still follows' );
		$this->assertSame( [ 'segment' => 5, 'offset' => \strlen( $first . $bad ) ], $result['cursor'] );
	}

	public function test_a_dir_refuses_a_segmentless_position(): void {
		$dir = "{$this->tmp}/logs/kea-7713.p3";
		\mkdir( $dir, 0755, true );
		\file_put_contents( "{$dir}/6.log", self::record( 'segmented record 2817' ) . self::record( 'second 2817' ) );

		$this->expectException( \InvalidArgumentException::class );
		$this->expectExceptionMessage( 'read_message: invalid position (want <segment>:<offset>[:<length>], :<offset> on a file source, start, recent or end)' );

		Log_Sources::read( 'kea-7713.p3', ':42' );
	}

	public function test_a_bad_position_throws_before_any_log_is_resolved(): void {
		Log_Sources::$builtin_sources = fn (): array => $this->fail( 'a bad position resolves no log' );

		$this->expectException( \InvalidArgumentException::class );
		$this->expectExceptionMessage( 'read_message: invalid position (want <segment>:<offset>[:<length>], :<offset> on a file source, start, recent or end)' );

		Log_Sources::read( 'sources/php', '7:x' );
	}

	public function test_an_unknown_source_teaches_the_known_names(): void {
		$log                          = "{$this->tmp}/gyro.log";
		Log_Sources::$builtin_sources = static fn (): array => [ 'gyro' => $log ];

		$this->expectException( \InvalidArgumentException::class );
		$this->expectExceptionMessage( 'unknown log source: "nope-1189" (known: gyro' );

		Log_Sources::open_reader( 'sources/nope-1189' );
	}
}
