<?php
/**
 * Settings_Event_Writer — the producer end of the settings-sync node graph.
 *
 * On a watched WP-option change (admin request), appends an option-NAME-only
 * event to `settings.p0`. A worker Consumer tails it; Settings_Sync_Node looks
 * the option up and pushes its CURRENT value at consume time. Because the event
 * carries only the name it is always <= PIPE_BUF -> an atomic lockless append
 * (firehose discipline), so no allow_large_writes() is needed.
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes;

/**
 * Appends option-name-only events to settings.p0 on watched option changes.
 */
class Settings_Event_Writer {

	public const SETTINGS_LOG_DIR      = 'settings.p0';
	public const SETTINGS_SEGMENT_SIZE = 5242880;
	public const SETTINGS_NUM_SEGMENTS = 2;
	public const SETTINGS_MAX_LIFESPAN = 86400;

	/** Only options whose name starts with this prefix are watched. */
	private const WATCH_PREFIX = 'newspack_';

	/**
	 * Atomic-append seam. Lazily-defaulted to a closure that constructs a
	 * transient `settings:writer` Partition, appends, flushes, and tears it down.
	 * Tests reassign in setUp to capture the Message without touching the
	 * filesystem; leaving it null exercises the real append path.
	 *
	 * Signature: `function ( array $m ): void`.
	 *
	 * @var \Closure|null
	 */
	public static ?\Closure $append_seam = null;

	/** Idempotency guard for init(). */
	private static bool $initialized = false;

	/**
	 * `update_option` hook callback.
	 *
	 * @api Registered dynamically via add_action by init().
	 * @param string $option Option name.
	 * @param mixed  $old    Old value (unused; the event is name-only).
	 * @param mixed  $new    New value (unused; the event is name-only).
	 */
	public static function on_update( string $option, $old, $new ): void {
		self::maybe_emit( $option );
	}

	/**
	 * Emit a name-only TM_STRUCT event for a watched option.
	 *
	 * @param string $option Option name.
	 */
	private static function maybe_emit( string $option ): void {
		if ( 0 !== \strpos( $option, self::WATCH_PREFIX ) ) {
			return;
		}

		$message                   = Message::new_message();
		$message[ Message::TYPE ]  = Message::TM_STRUCT;
		$message[ Message::VALUE ] = [ 'option' => $option ];

		$seam = self::$append_seam;
		if ( null !== $seam ) {
			$seam( $message );
			return;
		}
		self::default_append( $message );
	}

	/**
	 * Default atomic append: a transient `settings:writer` Partition fills + flushes
	 * + tears down. A named node registers in Core, so without teardown a 2nd option
	 * update in the same request would collide + leak; flush() forces the batched
	 * bytes to disk while the handle is open; remove_node() deregisters (try/finally
	 * guarantees teardown even if fill/flush throws).
	 *
	 * @param array<int, mixed> $message The 7-field positional message array.
	 */
	private static function default_append( array $message ): void {
		$writer = new Partition_Node();
		$writer->name( 'settings:writer' );
		$writer->arguments( Config::get_logs_directory()
			. '/' . self::SETTINGS_LOG_DIR
			. ' ' . self::SETTINGS_SEGMENT_SIZE
			. ' ' . self::SETTINGS_NUM_SEGMENTS
			. ' ' . self::SETTINGS_MAX_LIFESPAN );
		try {
			$writer->fill( $message );
			$writer->flush();
		} finally {
			$writer->remove_node();
		}
	}

	/**
	 * `add_option` hook callback.
	 *
	 * @api Registered dynamically via add_action by init().
	 * @param string $option Option name.
	 * @param mixed  $value  Value (unused; the event is name-only).
	 */
	public static function on_add( string $option, $value ): void {
		self::maybe_emit( $option );
	}

	/**
	 * `delete_option` hook callback. Resetting a setting to its default deletes
	 * the option row (Reset_Gate short-circuits update_option), so without this
	 * the reset-to-default never propagates to spokes — the downstream push then
	 * reads the now-absent option and the value-resolver ships the file default.
	 *
	 * @api Registered dynamically via add_action by init().
	 * @param string $option Option name.
	 */
	public static function on_delete( string $option ): void {
		self::maybe_emit( $option );
	}

	/**
	 * Register the option hooks once.
	 *
	 * @api Bootstrap entrypoint — called from the substrate wiring block.
	 */
	public static function init(): void {
		if ( self::$initialized ) {
			return;
		}
		self::$initialized = true;
		\add_action( 'update_option', [ self::class, 'on_update' ], 10, 3 );
		\add_action( 'add_option', [ self::class, 'on_add' ], 10, 2 );
		\add_action( 'delete_option', [ self::class, 'on_delete' ], 10, 1 );
	}
}
