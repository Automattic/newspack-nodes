<?php
namespace Newspack_Nodes\Tests;

/**
 * A write-only stream wrapper that behaves like a non-blocking pty. Each
 * `stream_write()` accepts at most `$accept` bytes and returns the short
 * count; the pty buffer is then full, and every write is refused with 0 until
 * the writer waits on `stream_select()`, whose `stream_cast()` call is where
 * the reader is modelled draining the buffer. PHP's own `fwrite` loops over
 * `stream_write()` for a short count, so the first refusal is absorbed there
 * and `fwrite` returns the partial; the refusal has to outlive that call for
 * the writer's next `fwrite` to see a 0.
 *
 * `$fail_after_refusal` breaks the stream at the first refusal: that call and
 * every call after it return false, which is how a test proves the writer
 * gives up on an error rather than spinning.
 *
 * Accepted bytes land in a real temp file, which `stream_cast()` hands to
 * `stream_select()` so the writer's writability wait runs for real. Open a
 * handle through `open()` and read what landed back through `written()`.
 */
class Pty_Stream_Wrapper {

	public const PROTOCOL = 'pty';

	/** Bytes one `stream_write()` accepts before reporting a short count. */
	public static int $accept = 0;

	/** Number of writes refused with a zero count since reset(). */
	public static int $refusals = 0;

	/** Number of `stream_select()` waits, counted at `stream_cast()`. */
	public static int $selects = 0;

	/** Whether the first refusal breaks the stream for good. */
	public static bool $fail_after_refusal = false;

	/** Whether the stream has broken; every write from here on returns false. */
	private static bool $broken = false;

	/** @var resource|null The temp file every accepted byte lands in. */
	private static $landed = null;

	/** Whether the buffer is full, set by a short write and cleared by a select. */
	private static bool $full = false;

	/** Stream context, assigned by PHP; unused. */
	public $context;

	/** Register the protocol, open a fresh landing file and zero the counters. */
	public static function reset( int $accept ): void {
		self::$accept             = $accept;
		self::$refusals           = 0;
		self::$selects            = 0;
		self::$fail_after_refusal = false;
		self::$broken             = false;
		self::$full               = false;
		self::$landed             = \tmpfile();
		if ( ! \in_array( self::PROTOCOL, \stream_get_wrappers(), true ) ) {
			\stream_wrapper_register( self::PROTOCOL, self::class );
		}
	}

	/** Unregister the protocol and drop the landing file. */
	public static function unregister(): void {
		if ( \in_array( self::PROTOCOL, \stream_get_wrappers(), true ) ) {
			\stream_wrapper_unregister( self::PROTOCOL );
		}
		if ( \is_resource( self::$landed ) ) {
			\fclose( self::$landed );
		}
		self::$landed = null;
	}

	/**
	 * Open a handle on the pty. PHP hands a userspace wrapper its writes in
	 * 8192-byte chunks by default, which would never overfill a pty-sized
	 * buffer; the chunk size is raised so one `fwrite` offers the whole
	 * string, as the plain wrapper does on a real terminal.
	 *
	 * @return resource
	 */
	public static function open( int $chunk_size ) {
		$fh = \fopen( self::PROTOCOL . '://out', 'w' );
		if ( false === $fh ) {
			throw new \RuntimeException( 'pty wrapper failed to open' );
		}
		\stream_set_chunk_size( $fh, $chunk_size );
		return $fh;
	}

	/** Every byte accepted since reset(), in order. */
	public static function written(): string {
		\rewind( self::$landed );
		return (string) \stream_get_contents( self::$landed );
	}

	public function stream_open( string $path, string $mode, int $options, ?string &$opened_path ): bool {
		return \is_resource( self::$landed );
	}

	/** @return int|false */
	public function stream_write( string $data ) {
		if ( self::$broken ) {
			return false;
		}
		if ( self::$full ) {
			++self::$refusals;
			self::$broken = self::$fail_after_refusal;
			return self::$broken ? false : 0;
		}
		$chunk = \substr( $data, 0, self::$accept );
		\fwrite( self::$landed, $chunk );
		self::$full = \strlen( $chunk ) < \strlen( $data );
		return \strlen( $chunk );
	}

	/**
	 * The select wait: the reader drains the buffer here.
	 *
	 * @return resource
	 */
	public function stream_cast( int $cast_as ) {
		++self::$selects;
		self::$full = false;
		return self::$landed;
	}

	public function stream_close(): void {
	}
}
