<?php
/**
 * Value Timeout
 *
 * Port of Tachikoma's `PayloadTimeout.pm` (v2.0.905): value-keyed dedup
 * with a timeout window and a trailing re-emit. The first arrival of a
 * value forwards; duplicates inside the window are suppressed but refresh
 * `recently_received`; each fire() re-emits a value whose window aged out
 * while arrivals kept coming (so a burst always gets one final send after
 * the last trigger, once per window) and forgets one that went quiet.
 * Messages older than `expires` drop on arrival.
 *
 * Wire ahead of dispatch to coalesce repeated triggers:
 *   Consumer → Value_Timeout → Job_Intake-style sink
 *
 * Divergences from the Perl original (the standard budget): no TM_PERSIST on
 * the re-emit (ADR-3 removed persist acks), suppressed/stale messages are
 * dropped rather than cancel()ed, and the class and internals say 'value'
 * for the substrate's PAYLOAD→VALUE field rename.
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes;

\defined( 'ABSPATH' ) || exit;

/**
 * ValueTimeout node.
 */
class Value_Timeout_Node extends Timer_Node {
	use Schema_Reflection;

	public const DEFAULT_TIMEOUT = 900;
	public const DEFAULT_EXPIRES = 3300;

	private int $timeout = self::DEFAULT_TIMEOUT;
	private int $expires = self::DEFAULT_EXPIRES;

	/** @var array<string, float> Value → refresh deadline (last arrival + timeout). */
	private array $recently_received = [];

	/** @var array<string, float> Value → suppression deadline (last send + timeout). */
	private array $recently_sent = [];

	/**
	 * `[ <timeout> <expires> <interval> ]` — seconds, Tachikoma defaults
	 * (900 / 3300 / timeout÷60). Falsy tokens take the default, as the
	 * original's `||=` did.
	 *
	 * @param list<string>|null $args
	 * @return list<string>
	 */
	public function arguments( ?array $args = null ): array {
		if ( null === $args ) {
			return parent::arguments();
		}
		$this->arguments         = $args;
		$timeout                 = Core::num_int( $args[0] ?? 0, 0 );
		$expires                 = Core::num_int( $args[1] ?? 0, 0 );
		$interval                = Core::num_float( $args[2] ?? 0, 0.0 );
		$this->timeout           = $timeout > 0 ? $timeout : self::DEFAULT_TIMEOUT;
		$this->expires           = $expires > 0 ? $expires : self::DEFAULT_EXPIRES;
		$interval                = $interval > 0 ? $interval : $this->timeout / 60;
		$this->recently_received = [];
		$this->recently_sent     = [];
		$this->set_timer( (int) ( $interval * 1000 ) );
		return $args;
	}

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
	 * Snapshot seam for `add_snapshot_node`: the two window maps ride the
	 * Consumer's offsetlog frame, so a respawn restores mid-window state and
	 * the trailing re-emit (often the thing that invalidates a cache) still
	 * fires instead of being lost with the process.
	 *
	 * @return array<string, array<string, float>>
	 */
	public function save_state(): array {
		return [
			'recently_received' => $this->recently_received,
			'recently_sent'     => $this->recently_sent,
		];
	}

	/**
	 * Restore the co-committed window maps (see save_state()).
	 *
	 * @param array<array-key, mixed> $state A save_state() payload.
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

	/** @api Introspection (Tachikoma accessor parity). */
	public function timeout(): int {
		return $this->timeout;
	}

	/** @api Introspection (Tachikoma accessor parity). */
	public function expires(): int {
		return $this->expires;
	}

	public static function node_schema(): array {
		return [
			'category'    => 'Filtering',
			'description' => 'Value-keyed dedup window with trailing re-emit (Tachikoma PayloadTimeout port).',
			'arguments'   => [
				[ 'name' => 'timeout', 'type' => 'int', 'default' => self::DEFAULT_TIMEOUT, 'description' => 'Suppression window in seconds.' ],
				[ 'name' => 'expires', 'type' => 'int', 'default' => self::DEFAULT_EXPIRES, 'description' => 'Drop messages older than this many seconds.' ],
				[ 'name' => 'interval', 'type' => 'float', 'default' => 0, 'description' => 'Sweep interval in seconds (default timeout/60).' ],
			],
			'commands'    => [],
			'requests'    => [],
			'has_target'  => true,
		];
	}
}
