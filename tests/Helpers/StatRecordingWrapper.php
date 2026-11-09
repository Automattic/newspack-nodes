<?php
namespace Newspack_Nodes\Tests;

/**
 * A stream wrapper over real paths, `stat://<real path>`, that counts every
 * stat by path, records each stat of a path that does not exist, and counts
 * every dir it lists.
 */
final class Stat_Recording_Wrapper {

	public const PROTOCOL = 'stat';

	/** @var list<string> Each stat of a missing path, in order. */
	public static array $misses = [];

	/** Dirs read since reset(). */
	public static int $listings = 0;

	/** @var array<string,int> Stats answered since reset(), by path. */
	public static array $stats = [];

	/** Stream context, assigned by PHP; unused. */
	public $context;

	/** @var list<string> */
	private array $entries = [];

	public static function reset(): void {
		self::$misses   = [];
		self::$listings = 0;
		self::$stats    = [];
		if ( ! \in_array( self::PROTOCOL, \stream_get_wrappers(), true ) ) {
			\stream_wrapper_register( self::PROTOCOL, self::class );
		}
	}

	public static function unregister(): void {
		if ( \in_array( self::PROTOCOL, \stream_get_wrappers(), true ) ) {
			\stream_wrapper_unregister( self::PROTOCOL );
		}
	}

	public static function wrap( string $path ): string {
		return self::PROTOCOL . '://' . $path;
	}

	private static function unwrap( string $path ): string {
		return \substr( $path, \strlen( self::PROTOCOL . '://' ) );
	}

	public function url_stat( string $path, int $flags ): array|false {
		$real                 = self::unwrap( $path );
		self::$stats[ $path ] = ( self::$stats[ $path ] ?? 0 ) + 1;
		if ( ! \file_exists( $real ) ) {
			self::$misses[] = $path;
			return false;
		}
		return \stat( $real );
	}

	public function dir_opendir( string $path, int $options ): bool {
		$entries = \scandir( self::unwrap( $path ) );
		if ( false === $entries ) {
			return false;
		}
		++self::$listings;
		$this->entries = $entries;
		return true;
	}

	public function dir_readdir(): string|false {
		$entry = \current( $this->entries );
		\next( $this->entries );
		return $entry;
	}

	public function dir_rewinddir(): bool {
		\reset( $this->entries );
		return true;
	}

	public function dir_closedir(): bool {
		return true;
	}
}
