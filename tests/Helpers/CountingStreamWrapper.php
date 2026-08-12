<?php
namespace Newspack_Nodes\Tests;

/**
 * A read-only stream wrapper that counts how many of its handles are open at
 * once — the observable behind "does this command hold every file at the same
 * time?". Paths are `count://<real path>`; `url_stat` is implemented so
 * `is_file()` / `is_readable()` answer for the underlying file.
 */
class Counting_Stream_Wrapper {

	public const PROTOCOL = 'count';

	/** Handles currently open through this wrapper. */
	public static int $open = 0;

	/** High-water mark of $open since reset(). */
	public static int $max_open = 0;

	/** Stream context, assigned by PHP; unused. */
	public $context;

	/** @var resource|null */
	private $fh = null;

	/** Register the protocol and zero the counters. */
	public static function reset(): void {
		self::$open     = 0;
		self::$max_open = 0;
		if ( ! \in_array( self::PROTOCOL, \stream_get_wrappers(), true ) ) {
			\stream_wrapper_register( self::PROTOCOL, self::class );
		}
	}

	/** Unregister the protocol; safe to call when it was never registered. */
	public static function unregister(): void {
		if ( \in_array( self::PROTOCOL, \stream_get_wrappers(), true ) ) {
			\stream_wrapper_unregister( self::PROTOCOL );
		}
	}

	/** `count://<path>` -> `<path>`. */
	public static function wrap( string $path ): string {
		return self::PROTOCOL . '://' . $path;
	}

	private static function unwrap( string $path ): string {
		return \substr( $path, \strlen( self::PROTOCOL . '://' ) );
	}

	public function stream_open( string $path, string $mode, int $options, ?string &$opened_path ): bool {
		$fh = \fopen( self::unwrap( $path ), $mode );
		if ( false === $fh ) {
			return false;
		}
		$this->fh = $fh;
		++self::$open;
		self::$max_open = \max( self::$max_open, self::$open );
		return true;
	}

	public function stream_read( int $count ): string {
		return (string) \fread( $this->fh, $count );
	}

	public function stream_eof(): bool {
		return \feof( $this->fh );
	}

	public function stream_stat(): array {
		return \fstat( $this->fh );
	}

	public function stream_seek( int $offset, int $whence = \SEEK_SET ): bool {
		return 0 === \fseek( $this->fh, $offset, $whence );
	}

	public function stream_tell(): int {
		return (int) \ftell( $this->fh );
	}

	public function stream_close(): void {
		\fclose( $this->fh );
		--self::$open;
	}

	/** @return array<int|string,int>|false */
	public function url_stat( string $path, int $flags ) {
		return @\stat( self::unwrap( $path ) );
	}
}
