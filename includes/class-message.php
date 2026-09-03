<?php
/**
 * The one message shape: a 7-field positional array, its type bitmask, and the
 * JSON codec that puts it on the wire.
 *
 * Index through the constants here. `$message['type']` coerces to index 0 and
 * corrupts TYPE with no error, which is why there is no hash form and no object
 * form (ADR-2). Indexed access is what keeps the drain loop cheap, and one shape
 * in memory, in JS and on the wire is what spares every boundary a translation
 * layer: `packed()` and `unpacked()` are JSON of the array itself.
 *
 * The field NAMES are the budgeted divergence from Tachikoma — KEY rather than
 * STREAM, VALUE rather than PAYLOAD, TIMESTAMP at index 1 so WHAT and WHEN group
 * at the front. `src/runtime/message.js` mirrors every constant and both codecs;
 * the ports part company only on malformed input, where PHP throws and JS hands
 * back a fresh message.
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes;

\defined( 'ABSPATH' ) || exit;

/**
 * Message field indices, type flags, and the static helpers that read them.
 *
 * Never instantiated: a message IS the array, so `new_message()` hands one back
 * and every helper takes it as an argument.
 */
class Message {
	/**
	 * Bitmask of the TM_* flags below. Test it with `&` — a strict `===` misses
	 * every composite, and composites are routine (`TM_COMMAND | TM_RESPONSE`).
	 *
	 * @ordered
	 */
	public const TYPE      = 0;
	/** Float Unix timestamp, microsecond resolution, stamped at mint. */
	public const TIMESTAMP = 1;
	/** Slash-delimited path the message came from; a reply addresses TO=FROM. */
	public const FROM      = 2;
	/** Slash-delimited path it is bound for; Router peels one segment per hop. */
	public const TO        = 3;
	/** Producer-owned identifier — a reader's `{segment}:{offset}:{length}`. */
	public const ID        = 4;
	/** Partition and grouping key. A forwarder carries it, never overwrites it. */
	public const KEY       = 5;
	/** The payload: a string under TM_BYTESTREAM, an array under TM_STRUCT. */
	public const VALUE     = 6;

	/**
	 * Last canonical index. A copier slices `array_slice( $m, 0,
	 * LAST_VALUE_INDEX + 1 )` to drop whatever a caller appended past VALUE.
	 */
	public const LAST_VALUE_INDEX = self::VALUE;

	/**
	 * Provenance taint appended AFTER the canonical seven. A Shell sets it on a
	 * command it mints in-process, so its presence means "born here". `packed()`
	 * never emits it and `unpacked()` rejects an 8-field line, so it cannot cross
	 * a process boundary — an SSE or IPC message inherently lacks it, which is
	 * precisely what makes its presence worth trusting. The client-tier
	 * authorization default gates on `isset( $message[ LOCAL ] )` (ADR-15).
	 */
	public const LOCAL = 7;

	/**
	 * A string VALUE — one raw line or frame. Mutually exclusive with TM_STRUCT.
	 *
	 * @ordered
	 */
	public const TM_BYTESTREAM = 1;
	/** End of a stream. An interpreter bounces an unaddressed one TO=FROM. */
	public const TM_EOF        = 2;
	/** Round-trip probe carrying its send time; the receiver bounces it back. */
	public const TM_PING       = 4;
	/** Graph construction and administration, dispatched by an interpreter. */
	public const TM_COMMAND    = 8;
	/** An array VALUE. Array-VALUE consumers gate on this, not on `is_array`. */
	public const TM_STRUCT     = 16;
	/** A failure, addressed TO=FROM so it walks the breadcrumb trail back. */
	public const TM_ERROR      = 32;
	/** An unsolicited notice; its VALUE is a flat string, never an array. */
	public const TM_INFO       = 64;
	/** A live query, answered in the addressed node's own `fill()`. */
	public const TM_REQUEST    = 128;
	/** Marks an answer, so the interpreter it passes does not re-dispatch it. */
	public const TM_RESPONSE   = 256;
	/** Fire-and-forget command: the interpreter suppresses the routed reply. */
	public const TM_NOREPLY    = 512;

	/**
	 * The mint default: a message that exists but has not been typed yet. A free
	 * HIGH bit, so it matches NO type gate — an untyped message is inert rather
	 * than every type at once (which is what a -1 sentinel would be as a
	 * bitmask). Every minter assigns TYPE and overwrites it; one that reaches a
	 * sink still carrying it is a bug, and the drop audit names it. A naked array
	 * (no TYPE) stays TYPE_UNKNOWN — a different failure, worth telling apart.
	 */
	public const TM_UNTYPED = 1024;

	/**
	 * The ONE flags-to-names map, beside the constants it names. Renderers read
	 * it through type_labels() and supply their own separator and no-match
	 * label; a private copy is how a renderer ends up omitting a flag. The order
	 * is the order both ports render in, pinned to `src/runtime/message.js` —
	 * label order, not numeric order.
	 *
	 * @var array<int,string>
	 */
	private const TYPE_NAMES = [
		self::TM_BYTESTREAM => 'TM_BYTESTREAM',
		self::TM_EOF        => 'TM_EOF',
		self::TM_PING       => 'TM_PING',
		self::TM_COMMAND    => 'TM_COMMAND',
		self::TM_RESPONSE   => 'TM_RESPONSE',
		self::TM_ERROR      => 'TM_ERROR',
		self::TM_INFO       => 'TM_INFO',
		self::TM_STRUCT     => 'TM_STRUCT',
		self::TM_REQUEST    => 'TM_REQUEST',
		self::TM_NOREPLY    => 'TM_NOREPLY',
		self::TM_UNTYPED    => 'TM_UNTYPED',
	];

	/** Bytes of a raw frame an error may quote, so a huge payload can't flood the log. */
	private const EXCERPT_LENGTH = 200;

	/**
	 * Byte length of the packed message — what a PIPE_BUF or `MAX_LINE_SIZE`
	 * check measures. It counts the JSON alone, so a caller sizing a written
	 * record adds one for the newline Partition appends.
	 *
	 * @param array<int,mixed> $message The 7-field positional message array.
	 */
	public static function packed_size( array $message ): int {
		return \strlen( self::packed( $message ) );
	}

	/**
	 * Serialize the canonical seven fields as a JSON array — the wire form.
	 *
	 * Never returns an empty string. An empty frame decodes into a shape error
	 * three steps from its cause, so a message that will not encode comes back
	 * as a self-describing TM_ERROR frame and the reason goes to stderr. A bad
	 * UTF-8 byte is substituted rather than failing the whole encode, which is
	 * what keeps a latin1 column in a logged SQL string from voiding the record.
	 *
	 * @param array<int,mixed> $message The 7-field positional message array.
	 */
	public static function packed( array $message ): string {
		// The canonical seven; the slice is what keeps LOCAL in-process.
		$fields = \array_slice( $message, 0, self::LAST_VALUE_INDEX + 1 );
		// Substitute a bad byte rather than fail the whole encode.
		$flags = \JSON_UNESCAPED_SLASHES | \JSON_INVALID_UTF8_SUBSTITUTE;
		// phpcs:ignore WordPress.WP.AlternativeFunctions.json_encode_json_encode -- hot path; the wrapper is the ?: fallback.
		$json = \json_encode( $fields, $flags ) ?: \wp_json_encode( $fields, $flags );
		if ( false !== $json ) {
			return $json;
		}
		// Residual failure: log loudly, substitute a frame, never emit ''.
		$reason = \json_last_error_msg();
		Core::stderr( 'Message::packed(): encode failed: ' . $reason );
		$error_message                 = self::new_message();
		$error_message[ self::TYPE ]   = self::TM_ERROR;
		$error_message[ self::VALUE ]  = 'Message::packed(): ' . $reason;
		return (string) \wp_json_encode( $error_message, \JSON_UNESCAPED_SLASHES );
	}

	/**
	 * Mint a message: TM_UNTYPED, a timestamp, and empty strings everywhere
	 * else. The caller assigns TYPE.
	 *
	 * @return array<int,mixed> The 7-field positional message array.
	 */
	public static function new_message(): array {
		return [
			self::TYPE      => self::TM_UNTYPED,
			// Cached per-tick clock; a fresh read warms it outside the drain.
			self::TIMESTAMP => Core::$now ?: Core::right_now(),
			self::FROM      => '',
			self::TO        => '',
			self::ID        => '',
			self::KEY       => '',
			self::VALUE     => '',
		];
	}

	/**
	 * Decode a wire frame back into a message. Accepts ONLY a 7-element
	 * positional array, so a trailing field — a LOCAL taint that escaped, a
	 * producer's private bookkeeping — is refused rather than trusted. A decode
	 * failure and a shape failure throw distinct messages, each quoting a
	 * bounded excerpt, because the two want different fixes.
	 *
	 * Throwing is the deliberate divergence from the JS port, which returns a
	 * fresh message instead. Callers reading off disk catch it and quarantine
	 * the line to the `:deadletter` sibling rather than abandoning the read.
	 *
	 * @param string $data One packed frame, without its trailing newline.
	 * @throws \InvalidArgumentException When the frame is not a 7-element positional JSON array.
	 * @return array<int,mixed> The 7-field positional message array.
	 */
	public static function unpacked( string $data ): array {
		$decoded = \json_decode( $data, true );
		if ( null === $decoded && \JSON_ERROR_NONE !== \json_last_error() ) {
			$reason = 'Message::unpacked(): not valid JSON (' . \json_last_error_msg() . '): ' . self::excerpt( $data );
			// phpcs:ignore WordPress.Security.EscapeOutput.ExceptionNotEscaped -- plain-text message for log/CLI consumers; escape at the view, not the runtime.
			throw new \InvalidArgumentException( $reason );
		}
		if ( \is_array( $decoded ) && 7 === \count( $decoded ) && \array_is_list( $decoded ) ) {
			return $decoded;
		}
		$reason = 'Message::unpacked(): expected a 7-element positional array, got: ' . self::excerpt( $data );
		// phpcs:ignore WordPress.Security.EscapeOutput.ExceptionNotEscaped -- plain-text message for log/CLI consumers; escape at the view, not the runtime.
		throw new \InvalidArgumentException( $reason );
	}

	/**
	 * A bounded, ellipsis-marked excerpt of a raw frame for an exception
	 * message. A malformed megabyte belongs in neither the log nor the trace.
	 *
	 * @param string $data The raw frame that failed to decode.
	 */
	private static function excerpt( string $data ): string {
		return \strlen( $data ) > self::EXCERPT_LENGTH
			? \substr( $data, 0, self::EXCERPT_LENGTH ) . '…'
			: $data;
	}

	/**
	 * Names of every flag set in $type, in TYPE_NAMES order. Empty when no
	 * known flag matches — the caller names that case (the drop audit says
	 * TYPE_UNKNOWN, the Dumper prints `TM_UNKNOWN(0x…)`).
	 *
	 * @param int $type The TYPE bitmask.
	 * @return list<string>
	 */
	public static function type_labels( int $type ): array {
		$labels = [];
		foreach ( self::TYPE_NAMES as $flag => $name ) {
			if ( $type & $flag ) {
				$labels[] = $name;
			}
		}
		return $labels;
	}

	/**
	 * Split a slash-delimited path into `[ first_segment, remainder ]`. The
	 * remainder is `''` when there is no slash.
	 *
	 * This is the one place a leading path segment is taken — Router's dispatch
	 * peel, the fan-out liveness prune that tests a target's head node, and the
	 * HTTP_Filter pid gate all read it, so a second `explode()` beside them is a
	 * second definition of what a path is.
	 *
	 * @param string $path A slash-delimited node path, possibly a bare name.
	 * @return array{0:string,1:string}
	 */
	public static function split_first( string $path ): array {
		$parts = \explode( '/', $path, 2 );
		return [ $parts[0], $parts[1] ?? '' ];
	}
}
