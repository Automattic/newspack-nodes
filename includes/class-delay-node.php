<?php
/**
 * Delay_Node: park a record until its `not_before`, then send it on.
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes;

\defined( 'ABSPATH' ) || exit;

/**
 * Delay node — `make_node Delay <name> <dir> <offsets_dir> <deadletter_dir> [interval_s] [max_age_s]`.
 *
 * A `TM_STRUCT` whose VALUE carries a numeric `not_before` (epoch seconds)
 * parks on the `{name}:queue` Partition the node owns, with its KEY, stamped
 * `parked_at` by the node's clock unless it already carries one. Anything
 * else is dropped with a rate-limited line.
 *
 * Every `interval_s` a recurring timer sweeps the queue once through
 * `circulate()`, with a `{name}:reader` Consumer built for the pass from the
 * committed cursor and removed after it, as `Job_Delay` reads; a line it
 * quarantines is reached as `Job_Delay`'s is, through the dead-letters alert
 * and `wp nodes ingest`. An entry parked longer than `max_age_s` is dropped with
 * a rate-limited line naming its KEY; a due one goes to target as a
 * `TM_STRUCT` FROM this node with its KEY, `not_before` removed and
 * `parked_at` kept, so a target that parks it again keeps its first park
 * time and `max_age_s` bounds the whole wait; the rest re-append before the
 * cursor commits. A delivery that throws is reported and its entry
 * re-appended, due again next sweep, so no delivery failure leaves
 * `fire()`. Delivery is at least once.
 *
 * The queue is sized for low volume: 1 MiB segments, at most eight kept, and
 * retention by age `max_age_s`, which prunes only as a segment rotates. The
 * hard cap prunes by segment count, so before every park, a fill's or a
 * sweep's, the node counts the segments from where the next read starts —
 * the pass reader's cursor during a sweep, the committed cursor otherwise —
 * to the queue's newest, and drops the entry with a rate-limited line naming
 * its KEY once one more could leave more unread segments than the cap keeps.
 *
 * All three dirs name `{partition}`: each worker parks on and sweeps a queue
 * of its own, which its queue's lifted write cap assumes.
 */
final class Delay_Node extends Timer_Node {
	use Schema_Reflection;

	use Sidecar;

	/** Seconds between two sweeps. */
	public const DEFAULT_INTERVAL_S = 60;

	/** Seconds an entry may stay parked, and the queue's lifetime: a day. */
	public const DEFAULT_MAX_AGE_S = 86400;

	/** The queue's segment size: low volume rotates, so age can prune. */
	private const QUEUE_SEGMENT_SIZE = 1048576;

	/** The queue's age-rule floor. */
	private const QUEUE_MIN_SEGMENTS = 2;

	/** The queue's count-rule target. */
	private const QUEUE_NUM_SEGMENTS = 4;

	/** The queue's hard cap: 0 derives twice the count target. */
	private const QUEUE_MAX_SEGMENTS = 0;

	/** Sibling kind of the Partition the entries park on. */
	private const QUEUE = 'queue';

	/** Name suffix of the Consumer each sweep builds over the queue. */
	private const READER = 'reader';

	/** Bytes of a KEY a drop line shows. */
	private const KEY_LABEL_BYTES = 64;

	/** The queue's segment directory, `{partition}` resolved. */
	protected string $dir = '';

	/** The sweep's offsetlog directory, `{partition}` resolved. */
	protected string $offsets_dir = '';

	/** The sweep's dead-letter directory, `{partition}` resolved. */
	protected string $deadletter_dir = '';

	/** Seconds between two sweeps. */
	protected int $interval_s = self::DEFAULT_INTERVAL_S;

	/** Seconds an entry may stay parked before a sweep drops it. */
	protected int $max_age_s = self::DEFAULT_MAX_AGE_S;

	/** The capability a raw read of the queue needs (ADR-39); '' for none. */
	protected string $read_capability = '';

	/** The `{name}:queue` sibling. */
	private ?Partition_Node $queue = null;

	/** The reader of the sweep in progress; null between sweeps. */
	private ?Consumer_Node $sweeping = null;

	/** Segment of the committed cursor, -1 for none; null until read. */
	private ?int $committed = null;

	/** Wire the `{name}:config` interpreter `set_read_capability` arrives on. */
	public function __construct() {
		parent::__construct();
		$this->auto_wire_interpreter();
	}

	/**
	 * `<dir> <offsets_dir> <deadletter_dir> [interval_s] [max_age_s]`: build
	 * the queue and arm the sweep. Every token is checked before anything
	 * moves; a replay rebuilds the queue.
	 *
	 * @param list<string>|null $args Positional tokens, or null to read the current ones.
	 * @return list<string>
	 * @throws \InvalidArgumentException When a dir names no `{partition}`, a token is
	 *                                   mistyped, or `max_age_s` is below 1.
	 * @throws \RuntimeException When the queue's name is refused.
	 */
	public function arguments( ?array $args = null ): array {
		if ( null === $args ) {
			return parent::arguments();
		}
		$values = $this->schema_values( $args );
		foreach ( [ 'dir', 'offsets_dir', 'deadletter_dir' ] as $arg ) {
			if ( ! Core::has_partition_token( self::written_in( $args, $arg ) ) ) {
				$this->refuse_argument( "{$arg} names no " . Core::PARTITION_TOKEN . '; each worker sweeps a queue of its own' );
			}
		}
		if ( Core::as_int( $values['max_age_s'] ) < 1 ) {
			$this->refuse_argument( 'max_age_s wants a whole number from 1 up, got \'' . Core::as_string( $values['max_age_s'] ) . "'" );
		}
		$this->assign_schema_args( $args, $values );
		$this->retract_sibling( self::QUEUE );
		$this->queue = null;
		$queue       = $this->make_sidecar(
			$this->dir,
			[
				self::QUEUE_SEGMENT_SIZE,
				self::QUEUE_MIN_SEGMENTS,
				self::QUEUE_NUM_SEGMENTS,
				self::QUEUE_MAX_SEGMENTS,
				$this->max_age_s,
				$this->max_age_s,
			]
		);
		$queue->void_warranty();
		$this->publish_sibling( self::QUEUE, $queue );
		$this->queue = $queue;
		$interval = $this->cadence_ms( $this->interval_s );
		if ( $interval !== $this->interval_ms ) {
			$this->set_timer( $interval );
		}
		return $args;
	}

	/**
	 * Park a struct carrying a numeric `not_before`; drop anything else.
	 *
	 * @param array<int,mixed> $message The 7-field positional message array.
	 * @throws \LogicException When no arguments have built the queue.
	 */
	public function fill( array $message ): void {
		$value = $message[ Message::VALUE ];
		if ( 0 === ( Core::num_int( $message[ Message::TYPE ] ) & Message::TM_STRUCT ) || ! \is_array( $value ) || ! \is_numeric( $value['not_before'] ?? null ) ) {
			$this->drop_message( $message, 'no numeric not_before to park by' );
			return;
		}
		if ( ! \is_numeric( $value['parked_at'] ?? null ) ) {
			$value['parked_at'] = Core::$now ?: Core::right_now();
		}
		++$this->counter;
		$this->park( $value, Core::as_string( $message[ Message::KEY ] ) );
	}

	/**
	 * One sweep: flush what this tick parked, then circulate the queue with
	 * a reader built for the pass from the dirs as written, so it resolves
	 * `{partition}` and judges ownership as a topology line would, and
	 * removed whatever the pass threw. A delivery failure is reported here
	 * and never leaves.
	 *
	 * @throws \Throwable A stop, or a re-append, checkpoint or teardown that failed.
	 */
	protected function fire(): void {
		$this->queue()->flush();
		if ( ! \is_dir( $this->dir ) ) {
			return;
		}
		$now    = Core::right_now();
		$reader = new Consumer_Node();
		$failed = [];
		try {
			Worker_Should_Stop::raise(
				Worker_Should_Stop::attempt(
					function () use ( $reader, $now, &$failed ): void {
						$reader->name( self::sibling_name_of( $this->name, self::READER ) );
						$reader->arguments( [ $this->written_argument( 'dir' ), $this->written_argument( 'offsets_dir' ), $this->written_argument( 'deadletter_dir' ) ] );
						$this->sweeping = $reader;
						$failed         = self::circulate( $reader, fn ( array $message ): bool => $this->route( $message, $now ), $this->requeue( ... ) );
					},
					$reader->remove_node( ... )
				)
			);
		} finally {
			$this->sweeping  = null;
			$this->committed = null;
		}
		foreach ( $failed as $e ) {
			$this->print_less_often( 'WARNING: delivery failed; its entry retries next sweep: ', $e->getMessage() );
		}
	}

	/**
	 * Drain a queue once with `$reader` and circulate what is not done with.
	 *
	 * The caller builds the reader for the pass, so it starts from the
	 * committed cursor, and removes it after. It reads to the end, handing each struct
	 * message to `$route`, which answers true when the entry is done with —
	 * delivered or dropped — and false to hold it. A `$route` throw holds its
	 * entry too, and the throws come back as the answer, so a failing
	 * delivery never fails the pass: one that failed every pass would climb
	 * the reader's attempt count into crawl (ADR-12). A `Worker_Should_Stop`
	 * raises at once, with them (ADR-14). The held messages reach `$requeue`,
	 * which must land them on disk, BEFORE the cursor commits, and answers how
	 * many of them, in order, it landed or dropped on purpose; the cursor
	 * commits just short of the first it could not, so nothing past it is
	 * lost and what was delivered after it delivers again. A pass that aborts
	 * anywhere duplicates and never drops. Every pass commits, so the boot
	 * frame of a reader built for it never climbs. A line that will not
	 * unpack is dead-lettered and passed (ADR-12); a torn line past a rewind
	 * is read again next pass and dead-lettered again, once a pass, for as
	 * long as the re-append stays blocked.
	 *
	 * @api Job_Delay::sweep() circulates jobdelay.p0 through it.
	 * @param Consumer_Node                                $reader  A reader built for this pass, its dirs set.
	 * @param \Closure(array<array-key,mixed>): bool       $route   True when an entry is done with.
	 * @param \Closure(list<array<array-key,mixed>>): int  $requeue Re-append the held messages durably;
	 *                                                            answers how many, in order, it settled.
	 * @return list<\Throwable> What `$route` threw; each one's entry was held.
	 * @throws \Throwable A stop, or what the drain, the re-append or the checkpoint
	 *                    threw, combined with what `$route` threw.
	 */
	public static function circulate( Consumer_Node $reader, \Closure $route, \Closure $requeue ): array {
		$held   = [];
		$failed = [];
		$reader->sink(
			new Callback_Node(
				static function ( array $message ) use ( &$held, &$failed, $route ): void {
					// drain()'s terminal TM_EOF carries no entry.
					if ( 0 === ( Core::num_int( $message[ Message::TYPE ] ) & Message::TM_STRUCT ) || ! \is_array( $message[ Message::VALUE ] ) ) {
						return;
					}
					try {
						if ( ! $route( $message ) ) {
							$held[] = $message;
						}
					} catch ( Worker_Should_Stop $e ) {
						Worker_Should_Stop::raise( [ ...$failed, $e ] );
					} catch ( \Throwable $e ) {
						$failed[] = $e;
						$held[]   = $message;
					}
				}
			)
		);
		try {
			$reader->drain();
			$settled = $requeue( $held );
			if ( $settled < \count( $held ) ) {
				$at = Log_Position::crumb( Core::as_string( $held[ $settled ][ Message::ID ] ) )
					?? throw new \LogicException( 'a held message carries no read position' );
				$reader->next_offset(
					[
						'segment' => $at['segment'],
						'offset'  => $at['offset'],
					]
				);
			}
			// Graceful: at EOF or a rewind, nothing mid-attempt.
			$reader->checkpoint( true );
		} catch ( \Throwable $e ) {
			Worker_Should_Stop::raise( [ ...$failed, $e ] );
		}
		return $failed;
	}

	/**
	 * Drop an entry parked past `max_age_s`, send a due one on, hold the rest.
	 *
	 * @param array<array-key,mixed> $message A parked message.
	 * @param float                  $now     The sweep's clock.
	 * @return bool True when the entry is done with.
	 */
	private function route( array $message, float $now ): bool {
		$entry = Core::arr( $message[ Message::VALUE ] );
		if ( $now - Core::num_float( $entry['parked_at'] ?? 0, 0.0 ) > $this->max_age_s ) {
			$this->print_less_often( "WARNING: dropped an entry parked past max_age {$this->max_age_s}s", ' keyed ' . self::key_label( Core::as_string( $message[ Message::KEY ] ) ) );
			return true;
		}
		if ( Core::num_float( $entry['not_before'] ?? 0, 0.0 ) > $now ) {
			return false;
		}
		unset( $entry['not_before'] );
		$out                   = Message::new_message();
		$out[ Message::TYPE ]  = Message::TM_STRUCT;
		$out[ Message::FROM ]  = $this->name;
		$out[ Message::KEY ]   = $message[ Message::KEY ];
		$out[ Message::VALUE ] = $entry;
		parent::fill( $out );
		return true;
	}

	/**
	 * Re-append the held messages, each as `park()` takes it, and land them
	 * on disk.
	 *
	 * @param list<array<array-key,mixed>> $held The messages a sweep held.
	 * @return int Every one of them, settled: parked or dropped loud.
	 */
	private function requeue( array $held ): int {
		foreach ( $held as $message ) {
			$this->park( Core::arr( $message[ Message::VALUE ] ), Core::as_string( $message[ Message::KEY ] ) );
		}
		$this->queue()->flush();
		return \count( $held );
	}

	/**
	 * Append one entry to the queue with its KEY, unless one more segment
	 * could leave the reader more unread segments than the hard cap keeps,
	 * when it drops loud instead.
	 *
	 * @param array<array-key,mixed> $entry The entry, `parked_at` stamped.
	 * @param string                 $key   The KEY it parks and delivers with.
	 */
	private function park( array $entry, string $key ): void {
		if ( ! $this->has_room() ) {
			$this->print_less_often( 'WARNING: queue full; dropped an entry', ' keyed ' . self::key_label( $key ) );
			return;
		}
		$message                   = Message::new_message();
		$message[ Message::TYPE ]  = Message::TM_STRUCT;
		$message[ Message::KEY ]   = $key;
		$message[ Message::VALUE ] = $entry;
		$this->queue()->fill( $message );
	}

	/**
	 * Whether the queue takes one more segment without the hard cap pruning
	 * one not yet read: the segments from where the next read starts, or
	 * from the oldest when that stands behind it, to the newest, plus one,
	 * stay below the cap. The queue's segment cache, which its lifted cap
	 * keeps warm, holds the newest.
	 */
	private function has_room(): bool {
		$segments = $this->queue()->get_segments();
		if ( [] === $segments ) {
			return true;
		}
		$from = \max( $this->read_from(), $segments[0]['id'] );
		$cap    = Partition_Node::derive_max_segments( self::QUEUE_NUM_SEGMENTS, self::QUEUE_MAX_SEGMENTS );
		return \end( $segments )['id'] - $from + 2 <= $cap - 1;
	}

	/**
	 * The segment the next read starts in: the pass reader's cursor during a
	 * sweep, otherwise the committed frame's, read from the offsetlog once a
	 * sweep and -1 when none was ever committed.
	 *
	 * @throws \InvalidArgumentException When the newest frame will not unpack.
	 */
	private function read_from(): int {
		if ( null !== $this->sweeping ) {
			return Log_Position::parse( $this->sweeping->cursor_position() )['segment'] ?? -1;
		}
		return $this->committed ??= Core::num_int( Partition_Node::read_latest_value_at( $this->offsets_dir )['segment'] ?? null, -1 );
	}

	/**
	 * A KEY as a drop line shows it: cut and made safe for a terminal.
	 *
	 * @param string $key The entry's KEY.
	 */
	private static function key_label( string $key ): string {
		return "'" . Core::terminal_safe( \mb_strcut( $key, 0, self::KEY_LABEL_BYTES, 'UTF-8' ) ) . "'";
	}

	/**
	 * The queue `arguments()` built.
	 *
	 * @throws \LogicException When no arguments have built it.
	 */
	private function queue(): Partition_Node {
		return $this->queue ?? throw new \LogicException( \esc_html( "Delay {$this->name} has no queue; arguments() builds it" ) );
	}

	/**
	 * Name the capability a raw read of the queue needs (ADR-39). The queue
	 * takes it at once and marks its dir, at once when the dir exists; the
	 * sweep's reader finds that marker and gates its cursor and dead letters
	 * by it.
	 *
	 * @param string $cap A WordPress capability name.
	 * @throws \InvalidArgumentException On an empty or malformed name.
	 */
	public function set_read_capability( string $cap ): void {
		$this->read_capability = Capabilities::read_capability( $cap );
		if ( null !== $this->queue ) {
			$this->gate_sidecar( $this->queue );
		}
	}

	/**
	 * The queue holds what this Delay parks, so it carries this Delay's gate.
	 *
	 * @return string|null The declared capability, or null for none.
	 */
	protected function sidecar_gate(): ?string {
		return '' === $this->read_capability ? null : $this->read_capability;
	}

	/**
	 * The `make_node` line, then the declared setters.
	 *
	 * @return string The `make_node` line, plus one config line per setter that holds a value.
	 */
	public function dump_config(): string {
		return parent::dump_config() . $this->dump_setters();
	}

	/** Let go of the queue the base cascade tears down. */
	public function remove_node(): void {
		parent::remove_node();
		$this->queue = null;
	}

	/**
	 * Topology console manifest.
	 *
	 * @return array<string,mixed>
	 */
	public static function node_schema(): array {
		return [
			'category'    => 'Control',
			'description' => 'Park each struct carrying a numeric not_before, and send it to target once that time has passed, not_before removed and parked_at kept; an entry parked longer than max_age_s is dropped.',
			'has_target'  => true,
			'owns'        => [ self::QUEUE => 'Partition' ],
			'arguments'   => [
				[ 'name' => 'dir', 'type' => 'string', 'required' => true, 'partition' => 'bound', 'description' => 'The queue Partition\'s directory; names {partition}.' ],
				[ 'name' => 'offsets_dir', 'type' => 'string', 'required' => true, 'partition' => 'bound', 'description' => 'The sweep\'s offsetlog directory; names {partition}.' ],
				[ 'name' => 'deadletter_dir', 'type' => 'string', 'required' => true, 'partition' => 'bound', 'description' => 'Where the sweep quarantines a line that will not unpack; names {partition}.' ],
				[ 'name' => 'interval_s', 'type' => 'int', 'default' => self::DEFAULT_INTERVAL_S, 'description' => 'Seconds between two sweeps, at least ' . self::MIN_INTERVAL_S . '.' ],
				[ 'name' => 'max_age_s', 'type' => 'int', 'default' => self::DEFAULT_MAX_AGE_S, 'description' => 'Seconds an entry may stay parked from its first park, and the queue\'s retention by age; at least 1.' ],
			],
			'commands'    => [
				[
					'name'        => 'set_read_capability',
					'description' => 'Name the WordPress capability a raw read of the queue needs. The queue writes it to a .read-capability marker at once when its dir exists, else before its first flush; the sweep\'s cursor and dead letters copy it, and a raw-logs verb, the catalog and the SSE stream refuse them to a caller without it (ADR-39).',
					'args'        => [
						[ 'name' => 'capability', 'type' => 'string', 'required' => true, 'description' => 'Lowercase letters, digits and underscores.' ],
					],
					'setter'      => 'read_capability',
				],
			],
		];
	}
}
