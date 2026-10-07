<?php
declare(strict_types=1);

namespace Newspack_Nodes\Tests\Unit;

use PHPUnit\Framework\Attributes\CoversClass;
use PHPUnit\Framework\Attributes\DataProvider;
use PHPUnit\Framework\TestCase;
use Newspack_Nodes\Log_Discovery;

/**
 * Which strings are stamps a record may carry. A stamp names directories on
 * the hub that reads it, so one arriving from a spoke is held to this grammar
 * before it names any.
 */
#[CoversClass( Log_Discovery::class )]
final class LogDiscoveryIsStampTest extends TestCase {

	/** @return array<string,array{string,bool}> Label => candidate, expected. */
	public static function rows(): array {
		return [
			'a partition dir'                    => [ 'firehose.p0', true ],
			'a registry source'                  => [ 'sources/php', true ],
			'a grouped dir'                      => [ 'offsets/kea-7713.p3', true ],
			'a dead-letter dir'                  => [ 'deadletter/aggregator.tw7', true ],
			'underscores, dashes and digits'     => [ '_q-4417.p9', true ],
			'empty'                              => [ '', false ],
			'the parent dir'                     => [ '..', false ],
			'the current dir'                    => [ '.', false ],
			'a grouped parent dir'               => [ 'offsets/..', false ],
			'a dot-led name'                     => [ '.hidden-38', false ],
			'a doubled dot inside a name'        => [ 'kea..7713', false ],
			'three segments'                     => [ 'sources/php/x', false ],
			'two segments with no prefix'        => [ 'a/b', false ],
			'a bare prefix'                      => [ 'sources', false ],
			'a bare group'                       => [ 'offsets', false ],
			'a prefix with no name'              => [ 'sources/', false ],
			'a leading slash'                    => [ '/firehose.p0', false ],
			'an upper-case letter'               => [ 'Firehose.p0', false ],
			'a space'                            => [ 'fire hose.p0', false ],
			'a NUL'                              => [ "fire\0hose.p0", false ],
			'a trailing newline'                 => [ "firehose.p0\n", false ],
			'a glob'                             => [ 'errors.*', false ],
			'an explicit logs prefix'            => [ 'logs/firehose.p0', false ],
			'a name at the byte limit'           => [ \str_repeat( 'k', Log_Discovery::MAX_STAMP_BYTES ), true ],
			'a name past the byte limit'         => [ \str_repeat( 'k', Log_Discovery::MAX_STAMP_BYTES + 1 ), false ],
			'a grouped stamp at the byte limit'  => [ 'deadletter/' . \str_repeat( 'k', Log_Discovery::MAX_STAMP_BYTES - 11 ), true ],
			'a grouped stamp past the limit'     => [ 'deadletter/' . \str_repeat( 'k', Log_Discovery::MAX_STAMP_BYTES - 10 ), false ],
		];
	}

	/** @return array<string,array{string,bool}> Label => candidate subscription, expected. */
	public static function subscriptions(): array {
		return [
			'a partition dir'                    => [ 'firehose.p0', true ],
			'a partition glob'                   => [ 'firehose.*', true ],
			'a grouped glob'                     => [ 'offsets/kea-*', true ],
			'a registry source'                  => [ 'sources/php', true ],
			'a bare group, left to stamp_for()'  => [ 'offsets', true ],
			'a group prefix naming nothing'      => [ 'offsets/', false ],
			'a dead-letter prefix naming nothing' => [ 'deadletter/', false ],
			'a glob opening the name'            => [ '*', false ],
			'a grouped glob opening the name'    => [ 'offsets/*', false ],
			'a glob over the source registry'    => [ 'sources/ph*', false ],
			'an explicit logs prefix'            => [ 'logs/firehose.p0', false ],
			'an explicit logs glob'              => [ 'logs/kea*', false ],
			'a dot-led glob'                     => [ '.*', false ],
			'the parent dir'                     => [ '..', false ],
			'a traversal under a group'          => [ 'offsets/../x', false ],
			'an upper-case letter'               => [ 'Firehose.p0', false ],
			'two segments with no group'         => [ 'a/b', false ],
			'past the byte limit'                => [ \str_repeat( 'k', Log_Discovery::MAX_STAMP_BYTES ) . '*', false ],
		];
	}

	#[DataProvider( 'subscriptions' )]
	public function test_is_subscription( string $candidate, bool $expected ): void {
		$this->assertSame( $expected, Log_Discovery::is_subscription( $candidate ) );
	}

	#[DataProvider( 'rows' )]
	public function test_is_stamp( string $candidate, bool $expected ): void {
		$this->assertSame( $expected, Log_Discovery::is_stamp( $candidate ) );
	}
}
