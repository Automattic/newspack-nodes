<?php
/**
 * Value Timeout
 *
 * Coalesces repeated triggers carrying the same VALUE. The first arrival
 * forwards; a duplicate inside the `timeout` window is dropped but still
 * refreshes the arrival stamp; and the last trigger of a burst still produces
 * a send, because `fire()` re-emits once the send window ages out. Wire it
 * ahead of dispatch — a Consumer filling `make_node Value_Timeout warm-gate
 * 900 3300`, whose target is the job sink — and a run of identical triggers
 * costs one send per window plus one trailing send, not a dispatch apiece.
 *
 * Two windows carry that, both keyed by the trimmed VALUE: `recently_sent`
 * holds the suppression deadline, `recently_received` the last arrival.
 * `fire()` sweeps them on the `interval` cadence, so the trailing send lands
 * within one sweep of the window expiring.
 *
 * Divergences from Tachikoma's `PayloadTimeout.pm`, the standard budget: the
 * re-emit carries no TM_PERSIST (ADR-3), a suppressed or stale message is
 * dropped rather than `cancel()`ed, and the class and its internals say
 * `value` where the Perl says payload, matching the substrate's VALUE field.
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes;

\defined( 'ABSPATH' ) || exit;

/**
 * Value_Timeout node — `make_node Value_Timeout <name> [ <timeout> <expires> <interval> ]`.
 */
class Value_Timeout_Node extends Timer_Node {
	use Schema_Reflection;

	/** Seconds; Tachikoma's suppression window and the zero-token fallback. */
	public const DEFAULT_TIMEOUT = 900;

	/** Seconds; Tachikoma's staleness bound and the zero-token fallback. */
	public const DEFAULT_EXPIRES = 3300;

	/** Seconds a value stays suppressed, and the refresh window. Positional 0. */
	private int $timeout = self::DEFAULT_TIMEOUT;

	/** Seconds; an arrival stamped older than this drops. Positional 1. */
	private int $expires = self::DEFAULT_EXPIRES;

	/** Sweep cadence in seconds; 0 derives it from timeout. Positional 2. */
	private float $interval = 0.0;

	/** @var array<string,float> Value → refresh deadline (last arrival + timeout). */
	private array $recently_received = [];

	/** @var array<string,float> Value → suppression deadline (last send + timeout). */
	private array $recently_sent = [];

	/**
	 * Assign `timeout`, `expires` and `interval` from the positional tokens,
	 * then arm the sweep.
	 *
	 * A zero token takes the default rather than its literal reading, as the
	 * original's `||=` does: a zero timeout suppresses nothing and a zero
	 * expires drops every arrival, so neither reads as a request. Re-arguing a
	 * live node clears both windows, because the deadlines they hold were
	 * measured against the timeout being replaced. The derived cadence passes
	 * through `cadence_ms()`, whose one-second floor keeps a sub-second
	 * interval on the Router hitchhike instead of a free-spinning own slot.
	 *
	 * @param list<string>|null $args New argument tokens (null = pure getter).
	 * @return list<string> Last-set argument tokens.
	 * @throws \InvalidArgumentException When a token is not of its declared numeric type.
	 * @throws \RuntimeException When the sweep timer hitchhikes and finds no `_router`.
	 */
	public function arguments( ?array $args = null ): array {
		if ( null === $args ) {
			return parent::arguments();
		}
		$this->parse_schema_args( $args );
		$this->timeout           = $this->timeout > 0 ? $this->timeout : self::DEFAULT_TIMEOUT;
		$this->expires           = $this->expires > 0 ? $this->expires : self::DEFAULT_EXPIRES;
		$this->recently_received = [];
		$this->recently_sent     = [];
		$this->set_timer( $this->cadence_ms( $this->interval > 0.0 ? $this->interval : $this->timeout / 60 ) );
		return $this->arguments;
	}

	/**
	 * Forward the first arrival of a value, suppress the rest of its window.
	 *
	 * Three checks drop a message before dedup even looks at it: a type other
	 * than TM_BYTESTREAM, a missing or non-numeric TIMESTAMP, and an age past
	 * `expires`. A stale trigger describes work whose result nobody waits for
	 * any more, and dispatching it costs as much as fresh work.
	 *
	 * Every accepted arrival refreshes `recently_received`, the suppressed ones
	 * included — that stamp is the only evidence `fire()` has that a burst
	 * outlived its window and owes a trailing send. The trailing newline comes
	 * off the value so a line-oriented producer and a bare one key the same
	 * window; `fire()` puts it back on the re-emit.
	 *
	 * @param array<int,mixed> $message The 7-field positional message array.
	 */
	public function fill( array $message ): void {
		if ( ! ( Core::as_int( $message[ Message::TYPE ], 0 ) & Message::TM_BYTESTREAM ) ) {
			return;
		}
		$timestamp = Core::num_float( $message[ Message::TIMESTAMP ], 0.0 );
		if ( $timestamp <= 0.0 || Core::$now - $timestamp > $this->expires ) {
			return;
		}
		$value = \rtrim( Core::as_string( $message[ Message::VALUE ] ), "\n" );

		$this->recently_received[ $value ] = Core::$now + $this->timeout;
		if ( isset( $this->recently_sent[ $value ] ) ) {
			return;
		}
		$this->recently_sent[ $value ] = Core::$now + $this->timeout;
		parent::fill( $message );
	}

	/**
	 * Sweep the windows: re-emit values that kept arriving past their send
	 * window, forget the quiet ones, expire stale receive stamps.
	 *
	 * The node keeps values, not messages, so the trailing send is minted
	 * fresh: `stamp_message()` puts this node in FROM, the TIMESTAMP is the
	 * sweep's — what an age sieve downstream should judge — and `parent::fill()`
	 * stamps TO from `target`, so it routes exactly like a forwarded arrival.
	 * Re-arming `recently_sent` at the same moment is what caps a sustained
	 * stream at one send per window.
	 *
	 * Overriding `fire()` replaces Timer_Node's heartbeat outright: this node
	 * emits values, never a tick, and notifies no FIRE listener. Both loops
	 * mutate the array they walk, which is safe because PHP's by-value
	 * `foreach` iterates a copy.
	 */
	public function fire(): void {
		foreach ( $this->recently_sent as $value => $sent ) {
			if ( Core::$now <= $sent ) {
				continue;
			}
			$received = $this->recently_received[ $value ] ?? 0.0;
			if ( $received > $sent ) {
				$this->recently_sent[ $value ] = Core::$now + $this->timeout;
				$response                       = Message::new_message();
				$response[ Message::TYPE ]      = Message::TM_BYTESTREAM;
				$response[ Message::TIMESTAMP ] = Core::$now;
				$response[ Message::VALUE ]     = $value . "\n";
				$this->stamp_message( $response, $this->name );
				parent::fill( $response );
			} else {
				unset( $this->recently_sent[ $value ] );
			}
		}
		foreach ( $this->recently_received as $value => $deadline ) {
			if ( Core::$now > $deadline ) {
				unset( $this->recently_received[ $value ] );
			}
		}
	}

	/**
	 * Snapshot seam for a reader's `add_snapshot_node`: both window maps ride
	 * the offsetlog frame the reader co-commits with its cursor, so a worker
	 * that dies mid-window resumes owing the trailing re-emit. Lose the maps
	 * and two things go with them — that pending send, often the one that
	 * invalidates a cache, and every live suppression window, so the next
	 * duplicate of each value forwards as new.
	 *
	 * @return array<string,array<string,float>>
	 */
	public function save_state(): array {
		return [
			'recently_received' => $this->recently_received,
			'recently_sent'     => $this->recently_sent,
		];
	}

	/**
	 * Restore both window maps from a save_state() payload.
	 *
	 * Keys and deadlines are re-coerced because the payload comes back through
	 * the offsetlog's JSON round trip, which turns a value spelled `12345` into
	 * an int array key. A missing or malformed map restores empty, costing a
	 * duplicate forward rather than a fatal on resume.
	 *
	 * @param array<array-key,mixed> $state A save_state() payload.
	 */
	public function restore_state( array $state ): void {
		foreach ( [ 'recently_received', 'recently_sent' ] as $map ) {
			$restored = \is_array( $state[ $map ] ?? null ) ? $state[ $map ] : [];
			$clean    = [];
			foreach ( $restored as $value => $deadline ) {
				$clean[ (string) $value ] = Core::num_float( $deadline, 0.0 );
			}
			$this->{$map} = $clean;
		}
	}

	/** @api Introspection: the suppression window in seconds (Tachikoma accessor parity). */
	public function timeout(): int {
		return $this->timeout;
	}

	/** @api Introspection: the staleness bound in seconds (Tachikoma accessor parity). */
	public function expires(): int {
		return $this->expires;
	}

	/**
	 * Palette entry and argument form for the topology console.
	 *
	 * @return array<string,mixed>
	 */
	public static function node_schema(): array {
		return [
			'category'    => 'Filtering',
			'description' => 'Value-keyed dedup window with trailing re-emit (Tachikoma PayloadTimeout variant).',
			'arguments'   => [
				[ 'name' => 'timeout', 'type' => 'int', 'default' => self::DEFAULT_TIMEOUT, 'description' => 'Suppression window in seconds.' ],
				[ 'name' => 'expires', 'type' => 'int', 'default' => self::DEFAULT_EXPIRES, 'description' => 'Drop messages older than this many seconds.' ],
				[ 'name' => 'interval', 'type' => 'float', 'default' => 0.0, 'description' => 'Sweep interval in seconds (numeric; 0 or empty takes timeout/60, floored at 1).' ],
			],
			'commands'    => [],
			'requests'    => [],
			'has_target'  => true,
		];
	}
}
