<?php
declare(strict_types=1);

namespace Newspack_Nodes\Tests\Unit;

use PHPUnit\Framework\Attributes\DataProvider;
use PHPUnit\Framework\TestCase;
use Newspack_Nodes\Consumer_Node;
use Newspack_Nodes\Log_Position;

/**
 * A read position has one writer and one reader (ADR-30), held to the
 * browser's `formatPosition()` and `parsePosition()` by one case list.
 */
final class LogPositionTest extends TestCase {

	/** @return array<string,mixed> The fixture, decoded. */
	private static function fixture(): array {
		return \json_decode( (string) \file_get_contents( __DIR__ . '/../fixtures/log-positions.json' ), true, 512, \JSON_THROW_ON_ERROR );
	}

	/** @return array<string,array{int|null,int,int|null,string}> Label => segment, offset, length, then the position. */
	public static function formats(): array {
		$out = [];
		foreach ( self::fixture()['format'] as [ $label, $segment, $offset, $length, $position ] ) {
			$out[ $label ] = [ $segment, $offset, $length, $position ];
		}
		return $out;
	}

	/** @return array<string,array{string,mixed}> Label => position, then what it reads as. */
	public static function parses(): array {
		$out = [];
		foreach ( self::fixture()['parse'] as [ $label, $position, $expected ] ) {
			$out[ $label ] = [ $position, $expected ];
		}
		return $out;
	}

	/** @return array<string,array{string,mixed}> Label => record ID, then the breadcrumb it reads as. */
	public static function crumbs(): array {
		$out = [];
		foreach ( self::fixture()['crumb'] as [ $label, $id, $expected ] ) {
			$out[ $label ] = [ $id, $expected ];
		}
		return $out;
	}

	#[DataProvider( 'formats' )]
	public function test_format_writes_the_position( ?int $segment, int $offset, ?int $length, string $position ): void {
		$this->assertSame( $position, Log_Position::format( $segment, $offset, $length ) );
	}

	#[DataProvider( 'parses' )]
	public function test_parse_reads_the_position( string $position, mixed $expected ): void {
		$this->assertSame( $expected, Log_Position::parse( $position ) );
	}

	#[DataProvider( 'crumbs' )]
	public function test_crumb_reads_a_records_breadcrumb( string $id, mixed $expected ): void {
		$this->assertSame( $expected, Log_Position::crumb( $id ) );
	}

	public function test_every_word_resolves_to_its_sentinel_and_back(): void {
		$this->assertSame( [ 'start' => Consumer_Node::SEEK_START, 'recent' => Consumer_Node::SEEK_RECENT, 'end' => Consumer_Node::SEEK_END ], Log_Position::WORDS, 'one table, word to sentinel' );
		foreach ( Log_Position::WORDS as $word => $sentinel ) {
			$this->assertSame( $sentinel, Log_Position::sentinel( $word ) );
			$this->assertSame( $word, Log_Position::word( $sentinel ) );
		}
	}

	public function test_a_sentinel_names_itself_and_an_unknown_word_starts(): void {
		$this->assertSame( 7713, Log_Position::sentinel( 7713 ) );
		$this->assertSame( 4410, Log_Position::sentinel( '4410' ) );
		$this->assertSame( Consumer_Node::SEEK_START, Log_Position::sentinel( 'middle' ) );
		$this->assertNull( Log_Position::word( 7713 ) );
	}
}
