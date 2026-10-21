<?php
/**
 * Driver_Error: a database driver's message as it may leave the site.
 *
 * A driver echoes the values a statement failed on. MySQL quotes a duplicate
 * key whole, and quotes up to 80 characters of the fragment a syntax error
 * stopped at, a fragment that pairs its quotes wrongly when it opens at a
 * literal, so no parse of the quotes can be trusted to find the values. The
 * one safe rule is the cut: `[<code>] ` and the message up to its first quote
 * (`'`, `"` or a backtick), at most `MAX_BYTES`. A SIGNAL (errno 1644, the
 * SQLSTATE 45000 a PDO reports it under) keeps its code alone, because its
 * text is the author's own MESSAGE_TEXT, values and no quotes at all.
 *
 * SQLite takes the same rule and needs nothing of its own. It quotes tokens,
 * not values: `near "x": syntax error` quotes the token the parser stopped
 * at, and the cut keeps `near`; a constraint names its columns unquoted
 * (`UNIQUE constraint failed: t.c`) and passes whole. A token can still be a
 * literal the statement embedded, which the cut removes with the rest. Its
 * one unquoted value is a trigger's `RAISE()` text, which reports as an
 * ordinary constraint (code 23000, errno 19) and so cannot be told apart; no
 * schema the substrate declares raises one.
 *
 * Every substrate path that carries driver text toward stderr, a log, a
 * command reply or a thrown message shapes it here, because ELN replicates
 * each stderr line into the hub-bound request record.
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes;

\defined( 'ABSPATH' ) || exit;

/**
 * The cut every driver message takes before it leaves a store.
 */
final class Driver_Error {

	/** Bytes a shaped message keeps, its code included, cut on a character. */
	public const MAX_BYTES = 256;

	/**
	 * The codes a SIGNAL raises, keyed for lookup: MySQL's
	 * `ER_SIGNAL_EXCEPTION` and the SQLSTATE a PDO reports it under.
	 *
	 * @var array<int,true>
	 */
	private const SIGNALS = [
		1644  => true,
		45000 => true,
	];

	/**
	 * Driver-errno seam. Replaces `mysqli_errno()` on a `$wpdb`'s connection,
	 * which core exposes only through its `__get()`, read after a statement
	 * fails. Tests reassign it to report a code a stand-in `$wpdb` cannot.
	 * Signature: `function ( object $wpdb ): int`
	 *
	 * @var (\Closure(object): int)|null
	 */
	public static ?\Closure $errno = null;

	/**
	 * A throwable's message, shaped when a driver threw it: a `PDOException`
	 * or a `mysqli_sql_exception`, subclasses included, by its code. Any
	 * other throwable's message passes as written.
	 *
	 * @api Consumed by sibling plugins: event-logger-nodes (`Log_Manager::thrown()`,
	 *      `Url_Snapshot`, `Performance_CI_Node`) and the cron managers of
	 *      pyrobase and nuclear-gyrobase.
	 * @param \Throwable $e What was thrown.
	 * @return string The message.
	 */
	public static function of( \Throwable $e ): string {
		return $e instanceof \PDOException || $e instanceof \mysqli_sql_exception
			? self::shape( $e->getCode(), $e->getMessage() )
			: $e->getMessage();
	}

	/**
	 * A PHP fatal's message as it may leave the site, classified by its head
	 * alone (`Uncaught <Class>: `), because a value can spell any tail PHP
	 * prints, `\nStack trace:` included. An uncaught `mysqli_sql_exception`
	 * keeps its class alone: its text carries no code, so a SIGNAL's
	 * MESSAGE_TEXT, which holds values and no quotes, cannot be told from any
	 * other message. An uncaught `PDOException` keeps its class and its
	 * SQLSTATE alone for a SIGNAL, else what follows the head cut at its
	 * first quote and then at the stack trace, within `MAX_BYTES`. Any other
	 * fatal drops its stack trace, whose frames print the arguments a
	 * statement ran with; every branch returns less than it was given.
	 *
	 * @api Consumed by sibling plugins: event-logger-nodes
	 *      (`Log_Manager`'s terminal `fatal_error`).
	 * @param string $message `error_get_last()`'s message.
	 * @return string The message.
	 */
	public static function fatal( string $message ): string {
		$head = 1 === \preg_match( '/\AUncaught ([\w\\\\]+): /', $message, $uncaught ) ? $uncaught[1] : '';
		if ( '' !== $head && \is_a( $head, 'mysqli_sql_exception', true ) ) {
			return self::capped( "Uncaught {$head}" );
		}
		if ( '' === $head || ! \is_a( $head, \PDOException::class, true ) ) {
			return \explode( "\nStack trace:", $message, 2 )[0];
		}
		$rest  = \substr( $message, \strlen( $uncaught[0] ) );
		$state = 1 === \preg_match( '/SQLSTATE\[(\w+)\]/', $rest, $code ) ? $code[1] : '';
		$said  = isset( self::SIGNALS[ $state ] )
			? "SQLSTATE[{$state}]"
			: \explode( "\nStack trace:", self::before_quote( $rest ), 2 )[0];
		return self::capped( "Uncaught {$head}: {$said}" );
	}

	/**
	 * The statement a `$wpdb` just refused, shaped by its own errno: the
	 * twin of gyrobase's `driver_text`. Empty when it reports no error, so
	 * each caller keeps the sentinel its own reports need.
	 *
	 * @api Consumed by sibling plugins: pyrobase (`Database`, `Customquery`,
	 *      `SchemaInstaller`) and nuclear-gyrobase (`RepeatingTimeMaintenance`).
	 * @param object $wpdb The `wpdb`, or a stand-in for one.
	 * @return string The shaped refusal, or ''.
	 */
	public static function of_wpdb( object $wpdb ): string {
		// wpdb declares last_error public; a stand-in may not carry it.
		$said = $wpdb->last_error ?? '';
		return \is_string( $said ) && '' !== $said ? self::shape( self::errno( $wpdb ), $said ) : '';
	}

	/**
	 * The driver's errno for the statement a `$wpdb` just ran, the code its
	 * `last_error` is shaped by; 0 where its connection is not mysqli's.
	 * `of_wpdb()` and `Wpdb_Arm`'s missing-table heal read it.
	 *
	 * @param object $wpdb The `wpdb`, or a stand-in for one.
	 * @return int The errno.
	 */
	public static function errno( object $wpdb ): int {
		$errno = self::$errno ?? static function ( object $wpdb ): int {
			// wpdb's __isset and __get reach its protected connection.
			$dbh = $wpdb->dbh ?? null;
			return $dbh instanceof \mysqli ? \mysqli_errno( $dbh ) : 0;
		};
		return $errno( $wpdb );
	}

	/**
	 * A driver's message as it may leave the site: `[<code>] ` and the
	 * message cut at its first quote, within `MAX_BYTES`; `[<code>]` alone
	 * for a SIGNAL. A code that is not a bare word — none, an empty one, one
	 * carrying punctuation — reads `?`.
	 *
	 * @api Consumed by sibling plugins: event-logger-nodes (`App\Core`'s
	 *      query outcome).
	 * @param int|string|null $code    The driver's errno or SQLSTATE.
	 * @param string          $message The driver's message.
	 * @return string The shaped message.
	 */
	public static function shape( int|string|null $code, string $message ): string {
		$code = 1 === \preg_match( '/\A\w{1,16}\z/', (string) $code ) ? (string) $code : '?';
		if ( isset( self::SIGNALS[ $code ] ) ) {
			return "[{$code}]";
		}
		return self::capped( "[{$code}] " . self::before_quote( $message ) );
	}

	/**
	 * A driver's message up to its first quote, where its values begin.
	 *
	 * @param string $message The driver's message.
	 */
	private static function before_quote( string $message ): string {
		return \rtrim( (string) \preg_replace( '/[\'"`].*/s', '', $message ) );
	}

	/**
	 * `$text` within `MAX_BYTES` of UTF-8, cut back to a character, then
	 * clear of a lead byte the cut left without its continuation bytes, so
	 * even malformed text ends on a whole character. Gyrobase's
	 * `driver_error` walks the same bytes the same way.
	 *
	 * @param string $text The shaped text.
	 */
	private static function capped( string $text ): string {
		$end = \strlen( $text );
		if ( $end > self::MAX_BYTES ) {
			$end = self::MAX_BYTES;
			while ( $end > 0 && 0x80 === ( \ord( $text[ $end ] ) & 0xC0 ) ) {
				--$end;
			}
			$lead = $end - 1;
			while ( $lead > $end - 4 && $lead > 0 && 0x80 === ( \ord( $text[ $lead ] ) & 0xC0 ) ) {
				--$lead;
			}
			$byte = $lead >= 0 ? \ord( $text[ $lead ] ) : 0;
			$size = $byte >= 0xF0 ? 4 : ( $byte >= 0xE0 ? 3 : ( $byte >= 0xC0 ? 2 : 1 ) );
			if ( $lead + $size > $end ) {
				$end = $lead;
			}
		}
		return \rtrim( \substr( $text, 0, $end ) );
	}
}
