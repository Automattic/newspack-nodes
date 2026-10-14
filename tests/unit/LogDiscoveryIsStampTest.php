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
		$max = Log_Discovery::MAX_STAMP_BYTES;
		return [
			'a partition dir'                    => [ 'firehose.p0', true ],
			'a registry source'                  => [ 'sources:php', true ],
			'a grouped dir'                      => [ 'offsets:kea-7713.p3', true ],
			'a dead-letter dir'                  => [ 'deadletter:aggregator.tw7', true ],
			'underscores, dashes and digits'     => [ '_q-4417.p9', true ],
			'a log named like a prefix'          => [ 'sources', true ],
			'a log named like a group'           => [ 'offsets', true ],
			'empty'                              => [ '', false ],
			'the parent dir'                     => [ '..', false ],
			'the current dir'                    => [ '.', false ],
			'a grouped parent dir'               => [ 'offsets:..', false ],
			'a dot-led name'                     => [ '.hidden-38', false ],
			'a doubled dot inside a name'        => [ 'kea..7713', false ],
			'a slash spelling'                   => [ 'sources/php', false ],
			'a nested source'                    => [ 'sources:php:x', false ],
			'a colon with no prefix'             => [ 'a:b', false ],
			'a prefix with no name'              => [ 'sources:', false ],
			'a leading slash'                    => [ '/firehose.p0', false ],
			'an upper-case letter'               => [ 'Firehose.p0', false ],
			'a space'                            => [ 'fire hose.p0', false ],
			'a NUL'                              => [ "fire\0hose.p0", false ],
			'a trailing newline'                 => [ "firehose.p0\n", false ],
			'a glob'                             => [ 'errors.*', false ],
			'an explicit logs prefix'            => [ 'logs:firehose.p0', false ],
			'a remote name'                      => [ 'remote:austin-9:firehose.p0', false ],
			'a name at the byte limit'           => [ \str_repeat( 'k', $max ), true ],
			'a name past the byte limit'         => [ \str_repeat( 'k', $max + 1 ), false ],
			'a grouped stamp at the byte limit'  => [ 'deadletter:' . \str_repeat( 'k', $max - 11 ), true ],
			'a grouped stamp past the limit'     => [ 'deadletter:' . \str_repeat( 'k', $max - 10 ), false ],
			'a broker reader\'s cursor'          => [ 'offsets:hub.tucson-41:firehose.p3', true ],
			'a broker reader\'s dead letters'    => [ 'deadletter:hub.tucson-41:firehose.p3', true ],
			'a reader of a registry source'      => [ 'offsets:hub.coast-73:sources:php', true ],
			'a reader of a grouped dir'          => [ 'deadletter:hub.coast-73:offsets:agg.firehose.p3', true ],
			'a reader of a spoke\'s reader'      => [ 'offsets:hub.kea-12:offsets:agg.tw7:firehose.p3', true ],
			'a reader under a mixed-case root'   => [ 'offsets:hub.TucsonWeekly:firehose.p3', true ],
			'a reader with an empty kind'        => [ 'offsets:hub.tucson-41:', false ],
			'a reader with an empty root'        => [ 'offsets::firehose.p3', false ],
			'a reader under the logs root'       => [ 'logs:hub.tucson-41:firehose.p3', false ],
			'a reader under the source registry' => [ 'sources:hub.tucson-41:firehose.p3', false ],
			'a reader under an unknown root'     => [ 'secrets:hub.tucson-41:firehose.p3', false ],
			'a reader whose root climbs'         => [ 'offsets:..:firehose.p3', false ],
			'a reader whose root is dot-led'     => [ 'offsets:.hub:firehose.p3', false ],
			'a reader whose kind climbs'         => [ 'offsets:hub.tucson-41:..', false ],
			'a reader whose kind is no stamp'    => [ 'offsets:hub.tucson-41:kea:okapi', false ],
			'a reader whose kind holds a slash'  => [ 'offsets:hub.tucson-41:sources/php', false ],
			'a reader with a space in its root'  => [ 'offsets:hub tw0:firehose.p3', false ],
			'a reader with a glob kind'          => [ 'offsets:hub.tucson-41:firehose.*', false ],
			'a slash spelling of a reader\'s dir' => [ 'offsets/hub.tucson-41/firehose.p3', false ],
			'a root at a directory name\'s limit' => [ 'offsets:' . \str_repeat( 'R', $max ) . ':firehose.p3', true ],
			'a root past it'                     => [ 'offsets:' . \str_repeat( 'R', $max + 1 ) . ':firehose.p3', false ],
			'a read stamp at the limit'          => [ 'offsets:hub:' . \str_repeat( 'k', $max ), true ],
			'a read stamp past it'               => [ 'offsets:hub:' . \str_repeat( 'k', $max + 1 ), false ],
			'both at the limit, the whole past it' => [ 'deadletter:' . \str_repeat( 'R', $max ) . ':' . \str_repeat( 'k', $max ), true ],
			'a read reader stamp past a dir name' => [ 'offsets:hub:offsets:' . \str_repeat( 'R', 200 ) . ':' . \str_repeat( 'k', 60 ), false ],
		];
	}

	/** @return array<string,array{string,bool}> Label => candidate subscription, expected. */
	public static function subscriptions(): array {
		return [
			'a partition dir'                    => [ 'firehose.p0', true ],
			'a partition glob'                   => [ 'firehose.*', true ],
			'a grouped glob'                     => [ 'offsets:kea-*', true ],
			'a registry source'                  => [ 'sources:php', true ],
			'a log named like a group'           => [ 'offsets', true ],
			'a group prefix naming nothing'      => [ 'offsets:', false ],
			'a dead-letter prefix naming nothing' => [ 'deadletter:', false ],
			'a glob opening the name'            => [ '*', false ],
			'a grouped glob opening the name'    => [ 'offsets:*', false ],
			'a glob over the source registry'    => [ 'sources:ph*', false ],
			'a slash spelling'                   => [ 'offsets/kea-*', false ],
			'an explicit logs prefix'            => [ 'logs:firehose.p0', false ],
			'an explicit logs glob'              => [ 'logs:kea*', false ],
			'a dot-led glob'                     => [ '.*', false ],
			'the parent dir'                     => [ '..', false ],
			'a traversal under a group'          => [ 'offsets:..:x', false ],
			'an upper-case letter'               => [ 'Firehose.p0', false ],
			'a colon with no prefix'             => [ 'a:b', false ],
			'past the byte limit'                => [ \str_repeat( 'k', Log_Discovery::MAX_STAMP_BYTES ) . '*', false ],
			'a broker reader\'s stamp'           => [ 'offsets:hub.tucson-41:sources:php', true ],
			'a glob over a broker\'s readers'    => [ 'offsets:hub.tucson-41:fire*', false ],
			'a glob over every root\'s readers'  => [ 'offsets:*:firehose.p3', false ],
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
