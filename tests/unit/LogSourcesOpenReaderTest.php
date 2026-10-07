<?php
declare(strict_types=1);

namespace Newspack_Nodes\Tests\Unit;

use PHPUnit\Framework\Attributes\CoversClass;
use Newspack_Nodes\Consumer_Node;
use Newspack_Nodes\File_Tail_Node;
use Newspack_Nodes\Log_Discovery;
use Newspack_Nodes\Log_Sources;
use Newspack_Nodes\Tests\TestCase;

/**
 * One name, one log: `open_reader()` resolves the stream's and the
 * single-step read's names alike, and refuses any it cannot place.
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

	public function test_an_empty_name_is_refused(): void {
		\mkdir( "{$this->tmp}/logs/firehose.p0", 0755, true );

		$this->expectException( \InvalidArgumentException::class );
		$this->expectExceptionMessage( 'unknown log: ""' );

		Log_Sources::open_reader( '' );
	}

	public function test_an_unknown_source_teaches_the_known_names(): void {
		$log                          = "{$this->tmp}/gyro.log";
		Log_Sources::$builtin_sources = static fn (): array => [ 'gyro' => $log ];

		$this->expectException( \InvalidArgumentException::class );
		$this->expectExceptionMessage( 'unknown log source: "nope-1189" (known: gyro' );

		Log_Sources::open_reader( 'sources/nope-1189' );
	}
}
