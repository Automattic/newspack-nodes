<?php
/**
 * Consumer: partition-aware reader with offsetlog checkpointing.
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes;

if ( ! \defined( 'ABSPATH' ) ) {
	exit;
}

class Consumer_Node extends Timer_Node {
	public const OFFSETLOG_SEGMENT_SIZE = 65536;
	public const OFFSETLOG_NUM_SEGMENTS = 2;
	public const MAX_LINE_BUFFER_SIZE = 20971520;
	public const MAX_POLL_BYTES = 10485760;

	/** Memcache key prefix Consumer_Node uses to publish its live cursor (read by Workers_CI + CLI). */
	public const POSITION_KEY_PREFIX = 'np:pos:';

	/** Canonical `np:pos:{host}:{source_base_dir}:p{N}` cursor cache key. */
	public static function position_key( string $host, string $source_base_dir, int $partition ): string {
		return self::POSITION_KEY_PREFIX . "{$host}:{$source_base_dir}:p{$partition}";
	}

	public const POLL_INTERVAL_EOF_MS = 100;

	/** 0 = next event-loop iteration. */
	public const POLL_INTERVAL_BUSY_MS = 0;

	public const CHECKPOINT_INTERVAL_S = 1;

	protected float $last_checkpoint = 0.0;

	/** Last (seg, off) committed; skip checkpoint if cursor hasn't advanced. */
	protected int $checkpoint_seg = -1;
	protected int $checkpoint_off = -1;

	protected string $source_base_dir = '';
	protected int $source_partition   = 0;
	/**
	 * Raw token written by the base schema walker — kept as documentation
	 * of the input shape. The override normalizes it (rtrim '/') into the
	 * derived $offsetlog_dir below.
	 */
	protected string $offsetlog_base_dir = '';
	protected string $offsetlog_dir      = '';
	protected ?Partition_Node $source    = null;
	/** Null when constructed with empty $offsetlog_base_dir (ephemeral readers skip durable cursors). */
	protected ?Partition_Node $offsetlog = null;

	/** FROM-stamp override; defaults to $this->name. The IPC input-Consumer stamps as `_repl`. */
	private string $stamp_override = '';

	/** Cursor segment. cursor_off + line_remainder length is the next read position. */
	protected int $cursor_seg = 0;

	/** Last offset committed for cursor_seg; always a line boundary. */
	protected int $cursor_off = 0;

	/** Partial line read past cursor_off but not yet emitted; prepended to the next poll's read. */
	protected string $line_remainder = '';

	protected bool $at_eof = true;

	/**
	 * Tachikoma-parity: no-arg ctor. Positional config arrives via `arguments()`,
	 * which the base setter parses against `node_schema()['arguments']`. The
	 * override below normalizes the assigned values and materializes the
	 * source / offsetlog Partitions + seeds the cursor from disk.
	 */
	public function __construct() {
		parent::__construct();
	}

	/**
	 * Setter chains through the base schema walker (which assigns
	 * source_base_dir / source_partition / offsetlog_base_dir from positional
	 * tokens or schema defaults), then normalizes the assigned values, derives
	 * the final offsetlog_dir, materializes the source / offsetlog Partitions
	 * and seeds the in-memory cursor from any existing offsetlog entries.
	 *
	 * @param string|null $args
	 * @return string
	 */
	public function arguments( ?string $args = null ): string {
		if ( null === $args ) {
			return parent::arguments();
		}
		$result = parent::arguments( $args );
		// Empty-string args mirrors the base setter's no-op (no schema walk).
		if ( '' === $args ) {
			return $result;
		}
		$this->source_base_dir = \rtrim( $this->source_base_dir, '/' );
		$this->offsetlog_dir   = \rtrim( $this->offsetlog_base_dir, '/' );

		$this->source = new Partition_Node();
		if ( '' !== $this->name ) {
			$this->source->name( "{$this->name}:source" );
		}
		$this->source->arguments( "{$this->source_base_dir} {$this->source_partition}" );
		$this->source->sink( $this->sink );
		$this->source->patron( $this );

		if ( '' !== $this->offsetlog_dir ) {
			$this->offsetlog = new Partition_Node();
			if ( '' !== $this->name ) {
				$this->offsetlog->name( "{$this->name}:offsetlog" );
			}
			$this->offsetlog->arguments( implode( ' ', [ "{$this->offsetlog_dir}", 0, self::OFFSETLOG_SEGMENT_SIZE, self::OFFSETLOG_NUM_SEGMENTS ] ) );
			$this->offsetlog->sink( $this->sink );
			$this->offsetlog->patron( $this );
			$this->load_offsetlog();
		} else {
			$this->offsetlog = null;
		}

		$this->set_timer( self::POLL_INTERVAL_EOF_MS, true );

		return $result;
	}

	/**
	 * Handle TM_REQUEST introspection verbs (reply TO=FROM); else defer to Timer.
	 */
	public function fill( array &$message ): void {
		$type_raw = $message[ Message::TYPE ];
		$type     = \is_numeric( $type_raw ) ? (int) $type_raw : 0;
		if ( $type & Message::TM_REQUEST ) {
			$this->handle_request( $message );
			return;
		}
		parent::fill( $message );
	}

	/** @param array<int, mixed> $message Incoming request Message. */
	private function handle_request( array $message ): void {
		if ( null === $this->sink ) {
			throw new \RuntimeException( 'Consumer::fill requires a wired sink' );
		}
		$value_raw = $message[ Message::VALUE ];
		$value     = \is_scalar( $value_raw ) ? (string) $value_raw : '';
		$verb      = \strtoupper( \explode( ' ', \trim( $value ), 2 )[0] );

		$payload = null;
		if ( 'GET_LAG' === $verb ) {
			$payload = $this->compute_lag();
		} elseif ( 'GET_OFFSET' === $verb ) {
			$payload = [
				'cursor_seg'         => $this->cursor_seg,
				'cursor_off'         => $this->cursor_off,
				'checkpoint_seg'     => $this->checkpoint_seg,
				'checkpoint_off'     => $this->checkpoint_off,
				'last_checkpoint_ts' => (int) $this->last_checkpoint,
			];
		} else {
			$payload = [ 'error' => "unknown request verb: {$verb}" ];
		}

		$reply                   = Message::new_message();
        $reply[ Message::TYPE ]  = Message::TM_STRUCT | Message::TM_RESPONSE;
		$reply[ Message::FROM ]  = '' !== $this->stamp_override ? $this->stamp_override : $this->name;
		$reply[ Message::TO ]    = $message[ Message::FROM ];
		$reply[ Message::ID ]    = $message[ Message::ID ];
		$reply[ Message::KEY ]   = $message[ Message::KEY ];
		$reply[ Message::VALUE ] = [ 'verb' => $verb, 'data' => $payload ];
		$this->sink->fill( $reply );
	}

	/**
	 * Read new bytes; emit a TM_BYTESTREAM per complete line; advance cursor at line boundaries.
	 *
	 * Trailing partial lines carry across polls via $line_remainder so a split line emits intact next poll.
	 */
	public function poll(): void {
		// Defeat the stat cache so size growth from another process's writer is visible.
		\clearstatcache( true, $this->source()->partition_dir() );
		$segments = $this->source()->get_segments( true );
		if ( empty( $segments ) ) {
			$this->at_eof = true;
			return;
		}

		// If the cursor segment was deleted by cleanup, recover.
		$ids = \array_column( $segments, 'id' );
		if ( ! \in_array( $this->cursor_seg, $ids, true ) ) {
			$this->cursor_seg     = $segments[0]['id'];
			$this->cursor_off     = 0;
			$this->line_remainder = '';
		}

		$newest_id   = \end( $segments )['id'];
		$newest_size = \end( $segments )['size'];

		foreach ( $segments as $s ) {
			if ( $s['id'] < $this->cursor_seg ) {
				continue;
			}

			// Crossing into a new segment: drop the prior segment's line_remainder and reset cursor.
			if ( $s['id'] !== $this->cursor_seg ) {
				$this->cursor_seg     = $s['id'];
				$this->cursor_off     = 0;
				$this->line_remainder = '';
				$this->set_state( 'SEGMENT', $this->cursor_seg );
			}

			$remainder_len = \strlen( $this->line_remainder );
			$read_start    = $this->cursor_off + $remainder_len;
			$len           = $s['size'] - $read_start;

			if ( $len > self::MAX_POLL_BYTES ) {
				$len = self::MAX_POLL_BYTES;
			}

			if ( $len <= 0 && 0 === $remainder_len ) {
				continue;
			}

			$bytes = ( $len > 0 ) ? $this->source()->read_at( $s['id'], $read_start, $len ) : '';
			// Consumers are the user-facing read nodes, so surface bytes_read here too.
			$this->bytes_read += \strlen( $bytes );

			// DoS guard: reject if buffer would exceed MAX_LINE_BUFFER_SIZE.
			if ( $remainder_len + \strlen( $bytes ) > self::MAX_LINE_BUFFER_SIZE ) {
				$this->print_less_often(
					\sprintf(
						'Consumer: line buffer exceeded %d bytes at seg %d off %d - discarding',
						self::MAX_LINE_BUFFER_SIZE,
						$s['id'],
						$read_start
					)
				);
				$this->set_state(
					'OVERFLOW',
					[ 'seg' => $s['id'], 'off' => $read_start, 'limit' => self::MAX_LINE_BUFFER_SIZE ]
				);
				// Discard remainder + sweep cursor past everything read so polls don't re-read it.
				$this->line_remainder = '';
				$this->cursor_seg     = $s['id'];
				$nl                   = \strpos( $bytes, "\n" );
				if ( false !== $nl ) {
					// Land after the newline; carry the tail as the new remainder.
					$this->cursor_off     = $read_start + $nl + 1;
					$tail                 = \substr( $bytes, $nl + 1 );
					$this->line_remainder = $tail;
				} else {
					$this->cursor_off = $read_start + \strlen( $bytes );
				}
				continue;
			}

			$buffer = $this->line_remainder . $bytes;
			$lines  = \explode( "\n", $buffer );
			// Trailing partial (empty if buffer ended with \n).
			$pending = \array_pop( $lines );

			$offset_in_buffer = 0;
			foreach ( $lines as $line ) {
				$abs_offset = $this->cursor_off + $offset_in_buffer;
				$line_size  = \strlen( $line ) + 1; // +1 for the consumed \n.
				$offset_in_buffer += $line_size;
				if ( $line_size > $this->largest_msg_sent ) {
					$this->largest_msg_sent = $line_size;
				}

				// Each line is a packed Message; unpack, stamp FROM, forward.
				try {
					$msg = Message::unpacked( $line );
				} catch ( \InvalidArgumentException $e ) {
					// Skip corrupt lines (cursor already advanced) and keep draining.
					$this->print_less_often( "Consumer: skipping unparseable line: {$e->getMessage()}" );
					continue;
				}
				$stamp = '' !== $this->stamp_override ? $this->stamp_override : $this->name;
				if ( '' !== $stamp && ! $this->stamp_message( $msg, $stamp ) ) {
					continue; // FROM exceeded MAX_FROM_SIZE; drop_message handled.
				}
				// Position breadcrumb goes in ID; KEY must stay the producer's routing key.
				$msg[ Message::ID ] = "{$s['id']}:{$abs_offset}";
				parent::fill( $msg );
			}

			// Commit past emitted lines; trailing partial survives in $line_remainder.
			$this->cursor_seg     = $s['id'];
			$this->cursor_off    += $offset_in_buffer;
			$this->line_remainder = $pending;
		}

		$tail_after_remainder = $this->cursor_off + \strlen( $this->line_remainder );
		$this->at_eof         = ( $this->cursor_seg >= $newest_id ) && ( $tail_after_remainder >= $newest_size );
	}

	/** Source Partition, materialized by arguments(). Throws if a read runs before configuration. */
	private function source(): Partition_Node {
		if ( null === $this->source ) {
			throw new \RuntimeException( 'Consumer source partition not initialized; call arguments() first' );
		}
		return $this->source;
	}

	/** Override the FROM-stamp used when emitting messages; '' falls back to $this->name. */
	public function set_stamp_as( string $stamp ): void {
		$this->stamp_override = $stamp;
	}

	/** Read the newest offsetlog entry to seed the cursor. No-op when offsetlog is disabled. */
	protected function load_offsetlog(): void {
		if ( null === $this->offsetlog ) {
			return;
		}
		$segments = $this->offsetlog->get_segments( true );
		if ( empty( $segments ) ) {
			return;
		}
		$newest = \end( $segments );
		$bytes  = $this->offsetlog->read_at( $newest['id'], 0, $newest['size'] );
		$lines  = \array_filter( \explode( "\n", $bytes ), static fn ( $l ) => '' !== $l );
		if ( empty( $lines ) ) {
			return;
		}
		try {
			$msg = Message::unpacked( \end( $lines ) );
		} catch ( \InvalidArgumentException $e ) {
			// Unparseable entry: start from the default cursor rather than failing construction.
			$this->print_less_often( "Consumer: ignoring unparseable offsetlog entry while seeding cursor: {$e->getMessage()}" );
			return;
		}
		$entry = $msg[ Message::VALUE ];
		if ( \is_array( $entry ) && isset( $entry['seg'], $entry['off'] ) ) {
			$seg                  = $entry['seg'];
			$off                  = $entry['off'];
			$this->cursor_seg     = \is_numeric( $seg ) ? (int) $seg : 0;
			$this->cursor_off     = \is_numeric( $off ) ? (int) $off : 0;
			$this->checkpoint_seg = $this->cursor_seg;
			$this->checkpoint_off = $this->cursor_off;
		}
	}

	/**
	 * Set next read position: 'start' | 'recent' | 'end' | array{seg,off}.
	 *
	 * @param string|array<array-key, mixed> $position Magic value or explicit position (reads 'seg'/'off').
	 */
	public function next_offset( $position ): void {
		$this->line_remainder = '';
		$this->at_eof         = false;

		if ( \is_array( $position ) ) {
			$seg              = $position['seg'] ?? 0;
			$off              = $position['off'] ?? 0;
			$this->cursor_seg = \is_numeric( $seg ) ? (int) $seg : 0;
			$this->cursor_off = \max( 0, \is_numeric( $off ) ? (int) $off : 0 );
			return;
		}

		$segments = $this->source()->get_segments( true );

		switch ( $position ) {
			case 'end':
				if ( ! empty( $segments ) ) {
					$newest           = \end( $segments );
					$this->cursor_seg = $newest['id'];
					$this->cursor_off = $newest['size'];
				}
				break;

			case 'recent':
				if ( ! empty( $segments ) ) {
					$count = \count( $segments );
					if ( $count >= 2 ) {
						$this->cursor_seg = $segments[ $count - 2 ]['id'];
					} else {
						$this->cursor_seg = $segments[0]['id'];
					}
					$this->cursor_off = 0;
				}
				break;

			case 'start':
			default:
				$this->cursor_seg = 0;
				$this->cursor_off = 0;
				break;
		}
	}

	/**
	 * Resolve the Consumer's immediate downstream processor(s) to `{name, class}` entries.
	 *
	 * A Tee target is expanded to its targets so the dashboard shows the real processors.
	 *
	 * @return array<int,array{name:string,class:string}>
	 */
	private function resolve_downstream_targets(): array {
		if ( ! \is_string( $this->target ) || '' === $this->target ) {
			return [];
		}
		$node = Core::node( $this->target );
		if ( null === $node ) {
			// Not yet registered or removed; surface the name without a class.
			return [ [ 'name' => $this->target, 'class' => '' ] ];
		}
		$class = Command_Interpreter_Node::shell_name_for( $node );
		if ( 'Tee' !== $class ) {
			return [ [ 'name' => $this->target, 'class' => $class ] ];
		}
		$tee_targets = $node->target;
		if ( ! \is_array( $tee_targets ) ) {
			return [ [ 'name' => $this->target, 'class' => 'Tee' ] ];
		}
		$out = [];
		foreach ( $tee_targets as $t ) {
			if ( '' === $t ) {
				continue;
			}
			$tn = Core::node( $t );
			$tc = null === $tn ? '' : Command_Interpreter_Node::shell_name_for( $tn );
			$out[] = [ 'name' => $t, 'class' => $tc ];
		}
		return $out;
	}

	public function checkpoint(): void {
		if ( null === $this->offsetlog ) {
			return;
		}
		// Always write the first checkpoint (even at 0:0) so an idle Consumer is still attributed.
		$first_checkpoint = -1 === $this->checkpoint_seg && -1 === $this->checkpoint_off;
		if (
			! $first_checkpoint
			&& $this->cursor_seg === $this->checkpoint_seg
			&& $this->cursor_off === $this->checkpoint_off
		) {
			return;
		}
		$msg                       = Message::new_message();
		$msg[ Message::TYPE ]      = Message::TM_STRUCT;
		$msg[ Message::TIMESTAMP ] = Core::$now;
		$msg[ Message::FROM ]      = $this->name;
		$msg[ Message::VALUE ]     = [
			'seg'         => $this->cursor_seg,
			'off'         => $this->cursor_off,
			'ts'          => Core::$now,
			'name'        => $this->name,
			'target'      => \is_string( $this->target ) ? $this->target : '',
			'targets'     => $this->resolve_downstream_targets(),
			'worker_type' => self::worker_type_env(),
		];
		$this->offsetlog->fill( $msg );
		// Persist synchronously — don't wait for the offsetlog Partition's PIPE_BUF threshold.
		$this->offsetlog->flush();
		$this->checkpoint_seg = $this->cursor_seg;
		$this->checkpoint_off = $this->cursor_off;

		$this->set_state( 'CHECKPOINT', [ 'seg' => $this->cursor_seg, 'off' => $this->cursor_off ] );
	}

	/**
	 * True if this Consumer resumed from a durable offsetlog checkpoint (seg/off
	 * default to -1; load_offsetlog seeds them ≥0). Lets a caller distinguish a
	 * respawn (resume from cursor) from a first spawn (seek 'end' to skip history).
	 */
	public function has_checkpoint(): bool {
		return -1 !== $this->checkpoint_seg || -1 !== $this->checkpoint_off;
	}

	/** Timer-driven: poll, publish position, periodically checkpoint, then re-arm (busy/EOF cadence). */
	protected function fire(): void {
		$this->poll();
		$this->publish_position();
		// poll() updates the in-memory cursor every read; checkpoint() makes it durable.
		if (
			null !== $this->offsetlog
			&& ( Core::$now - $this->last_checkpoint ) >= self::CHECKPOINT_INTERVAL_S
		) {
			$this->checkpoint();
			$this->last_checkpoint = Core::$now;
		}
		$next_ms = $this->at_eof ? self::POLL_INTERVAL_EOF_MS : self::POLL_INTERVAL_BUSY_MS;
		$this->set_timer( $next_ms, true ); // oneshot — fire() re-arms.
	}

	/**
	 * Publish the current cursor to memcache, keyed by hostname + source path, for live dashboards.
	 *
	 * No-op when Memcached is missing or unreachable; a failed connect is sticky for this worker.
	 */
	/** Worker-type env tag (set by SpawnController after HMAC auth); '' when unset. */
	private static function worker_type_env(): string {
		// phpcs:ignore WordPress.Security.ValidatedSanitizedInput.InputNotSanitized -- env var is set by SpawnController after HMAC auth.
		return self::as_string( $_SERVER['NEWSPACK_NODES_WORKER_TYPE'] ?? '' );
	}

	private function publish_position(): void {
		if ( ! \class_exists( '\\Memcached' ) ) {
			return;
		}
		/** @var \Memcached|false|null $memd */
		static $memd = null;
		if ( false === $memd ) {
			return;
		}
		if ( null === $memd ) {
			$config  = Config::load_config();
			$servers = $config['memcache_servers'] ?? [];
			if ( ! \is_array( $servers ) || empty( $servers ) ) {
				$memd = false;
				return;
			}
			$memd = new \Memcached();
			foreach ( $servers as $hp ) {
				$hp_str    = \is_scalar( $hp ) ? (string) $hp : '';
				[ $h, $p ] = \array_pad( \explode( ':', \trim( $hp_str ) ), 2, '11211' );
				$memd->addServer( $h, (int) $p );
			}
			if ( empty( $memd->getServerList() ) ) {
				$memd = false;
				return;
			}
		}
		$host = \gethostname() ?: 'unknown';
		$memd->set(
			self::position_key( $host, $this->source_base_dir, $this->source_partition ),
			[
				'seg'         => $this->cursor_seg,
				'off'         => $this->cursor_off,
				'ts'          => Core::$now,
				'name'        => $this->name,
				'target'      => \is_string( $this->target ) ? $this->target : '',
				'targets'     => $this->resolve_downstream_targets(),
				'worker_type' => self::worker_type_env(),
			],
			60
		);
	}

	/** @return array{bytes_behind: int, segments_behind: int, caught_up: bool} */
	private function compute_lag(): array {
		\clearstatcache( true, $this->source()->partition_dir() );
		$segments = $this->source()->get_segments( true );
		if ( empty( $segments ) ) {
			return [ 'bytes_behind' => 0, 'segments_behind' => 0, 'caught_up' => true ];
		}
		$bytes_behind     = 0;
		$segments_behind  = 0;
		foreach ( $segments as $s ) {
			$id   = $s['id'];
			$size = $s['size'];
			if ( $id < $this->cursor_seg ) {
				continue;
			}
			if ( $id === $this->cursor_seg ) {
				$bytes_behind += \max( 0, $size - $this->cursor_off );
			} else {
				$bytes_behind += $size;
				++$segments_behind;
			}
		}
		// Count line_remainder as already-read so lag reflects bytes-still-to-emit.
		$bytes_behind = \max( 0, $bytes_behind - \strlen( $this->line_remainder ) );
		return [
			'bytes_behind'    => $bytes_behind,
			'segments_behind' => $segments_behind,
			'caught_up'       => 0 === $bytes_behind,
		];
	}

	protected function check_name_availability( string $name ): void {
		parent::check_name_availability( $name );
		if ( null !== $this->source && null !== Core::node( "{$name}:source" ) ) {
			throw new \RuntimeException( \esc_html( "node name collision: {$name}:source already registered" ) );
		}
		if ( null !== $this->offsetlog && null !== Core::node( "{$name}:offsetlog" ) ) {
			throw new \RuntimeException( \esc_html( "node name collision: {$name}:offsetlog already registered" ) );
		}
	}

	protected function set_sibling_names( ?string $name = null ): void {
		$this->source?->name( "{$name}:source" );
		$this->offsetlog?->name( "{$name}:offsetlog" );
		parent::set_sibling_names( $name );
	}

	public function sink( ?Node $node = null ): ?Node {
		if ( \func_num_args() > 0 ) {
			if ( null !== $this->source ) {
				$this->source->sink( $node );
			}
			if ( null !== $this->offsetlog ) {
				$this->offsetlog->sink( $node );
			}
			return parent::sink( $node );
		}
		return parent::sink();
	}

	public function remove_node(): void {
		if ( null !== $this->source ) {
			$this->source->remove_node();
		}
		if ( null !== $this->offsetlog ) {
			$this->offsetlog->remove_node();
		}
		parent::remove_node();
	}

	public static function node_schema(): array {
		return \array_merge( parent::node_schema(), [
			'category'    => 'I/O',
			'description' => 'Tails a Partition; emits each appended message to its sink.',
			'arguments'        => [
				[ 'name' => 'source_base_dir',    'type' => 'string', 'required' => true ],
				[ 'name' => 'source_partition',   'type' => 'int',    'required' => true ],
				[ 'name' => 'offsetlog_base_dir', 'type' => 'string', 'default' => '' ],
			],
			'requests'    => [
				[
					'name'        => 'GET_LAG',
					'description' => 'Bytes/messages behind the source partition tail.',
					'reply_shape' => '{ bytes_behind, segments_behind, caught_up }',
				],
				[
					'name'        => 'GET_OFFSET',
					'description' => 'Current cursor + last checkpoint.',
					'reply_shape' => '{ cursor_seg, cursor_off, checkpoint_seg, checkpoint_off, last_checkpoint_ts }',
				],
			],
			'accepts_fill' => false,
		] );
	}
}
