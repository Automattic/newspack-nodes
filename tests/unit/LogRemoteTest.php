<?php
declare(strict_types=1);

namespace Newspack_Nodes\Tests\Unit;

use PHPUnit\Framework\Attributes\CoversClass;
use PHPUnit\Framework\Attributes\DataProvider;
use PHPUnit\Framework\TestCase;
use Newspack_Nodes\Log_Discovery;
use Newspack_Nodes\Remote_Source_Node;

/**
 * A remote log's name: the hub's name for one spoke's log in its own probe
 * channel, `remote/<vault_id>:<kind>`. `remote_for()` writes it and
 * `remote_of()` reads it, and `src/runtime/log-stamp.js` reads the same case
 * list, so a spoke's `firehose.p0` never shares the hub's own stamp. The same
 * rows hold `Remote_Source_Node::reader_id()` to the browser's `brokerReaderId()`.
 */
#[CoversClass( Log_Discovery::class )]
final class LogRemoteTest extends TestCase {

	/** @return array<string,array{string,string,string,string}> Label => vault id, stamp, name, kind. */
	public static function remotes(): array {
		$cases = \json_decode( (string) \file_get_contents( __DIR__ . '/../fixtures/log-remotes.json' ), true, 512, \JSON_THROW_ON_ERROR );
		$out   = [];
		foreach ( $cases as [ $label, $vault_id, $stamp, $name, $kind ] ) {
			$out[ $label ] = [ $vault_id, $stamp, $name, $kind ];
		}
		return $out;
	}

	/** @return array<string,array{string,string,string,int,string}> Label => kind, topology, broker, partition, reader id. */
	public static function reader_ids(): array {
		$cases = \json_decode( (string) \file_get_contents( __DIR__ . '/../fixtures/log-remotes.json' ), true, 512, \JSON_THROW_ON_ERROR );
		$out   = [];
		foreach ( $cases as [ $label, , , , $kind, $topology, $broker, $partition, $reader_id ] ) {
			$out[ $label ] = [ $kind, $topology, $broker, $partition, $reader_id ];
		}
		return $out;
	}

	#[DataProvider( 'reader_ids' )]
	public function test_reader_id_names_a_brokers_reader( string $kind, string $topology, string $broker, int $partition, string $reader_id ): void {
		$this->assertSame( $reader_id, Remote_Source_Node::reader_id( $topology, $broker, $kind, $partition ) );
	}

	#[DataProvider( 'remotes' )]
	public function test_remote_for_names_a_spokes_log( string $vault_id, string $stamp, string $name ): void {
		$this->assertSame( $name, Log_Discovery::remote_for( $vault_id, $stamp ) );
	}

	#[DataProvider( 'remotes' )]
	public function test_remote_of_reads_the_spoke_and_the_kind( string $vault_id, string $stamp, string $name, string $kind ): void {
		$this->assertSame( [ 'vault_id' => $vault_id, 'kind' => $kind ], Log_Discovery::remote_of( $name ) );
	}

	/** @return array<string,array{string}> Label => a name no remote log carries. */
	public static function not_remote(): array {
		return [
			'a local partition dir'     => [ 'firehose.p0' ],
			'a local registry source'   => [ 'sources/php' ],
			'a bare prefix'             => [ 'remote' ],
			'a prefix naming nothing'   => [ 'remote/' ],
			'a spoke with no kind'      => [ 'remote/austin-9' ],
			'an empty spoke'            => [ 'remote/:firehose.p0' ],
			'an empty kind'             => [ 'remote/austin-9:' ],
			'a trail after the name'    => [ 'remote/austin-9:firehose.p0/hub.p2' ],
		];
	}

	#[DataProvider( 'not_remote' )]
	public function test_remote_of_refuses_a_name_no_remote_log_carries( string $name ): void {
		$this->assertNull( Log_Discovery::remote_of( $name ) );
	}

	public function test_remote_for_refuses_a_spoke_id_the_vault_refuses(): void {
		$this->expectException( \InvalidArgumentException::class );
		$this->expectExceptionMessage( 'aus:tin' );

		Log_Discovery::remote_for( 'aus:tin', 'firehose.p0' );
	}

	public function test_split_reads_a_remote_name_by_its_prefix(): void {
		$this->assertSame( [ 'remote', 'kea_41:sources:php' ], Log_Discovery::split( 'remote/kea_41:sources:php' ) );
	}

	public function test_no_local_log_dir_takes_the_remote_prefix(): void {
		$this->expectException( \InvalidArgumentException::class );
		$this->expectExceptionMessage( 'log dir remote is named like a group' );

		Log_Discovery::stamp_for( 'logs', 'remote' );
	}

	public function test_a_remote_name_is_no_stamp_or_subscription_the_wire_carries(): void {
		$this->assertFalse( Log_Discovery::is_stamp( 'remote/austin-9' ) );
		$this->assertFalse( Log_Discovery::is_subscription( 'remote/austin-9' ) );
		$this->assertFalse( Log_Discovery::is_stamp( 'remote/austin-9:firehose.p0' ) );
	}
}
