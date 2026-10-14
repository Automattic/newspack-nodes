<?php
/**
 * Remote_Consumer: the durable reader for one stream a broker carries.
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes;

\defined( 'ABSPATH' ) || exit;

/**
 * One stream a broker carries, read like a Consumer — the `Durable_Reader`
 * cursor, offsetlog, dead-letter queue and debugger — over the lines the
 * broker hands here by their FROM stamp, as Tachikoma's Consumer reads under
 * a ConsumerBroker. Under `Remote_Source` the broker owns the feed and asks
 * each reader where its stream stands; under `HTTP_Source` a live reader
 * fetches its own blocks of records over the broker's HTTP_Out. A paused
 * reader leaves the feed and steps over that HTTP_Out instead.
 *
 * Positions live in the SPOKE's byte space: each record's `segment:offset:length`
 * breadcrumb places it, never the local line's bytes. A file-mode source that
 * has not seen its generation yet states no segment, and this reader carries
 * that as `$generation_unknown` rather than as segment 0, which a File_Tail
 * reads as a foreign inode and replays from byte 0.
 */
class Remote_Consumer_Node extends Timer_Node implements Position_Reporter {
	use Schema_Reflection;
	use Durable_Reader {
		fire as reader_fire;
		step as reader_step;
		advance_consume_cursor as reader_advance;
	}

	/** The spoke service that answers a reader's step, fetch and discovery. */
	public const RAW_LOGS_SERVICE = 'raw-logs';

	/** The stamp this reader's lines carry: a partition dir or `sources:<name>`. */
	protected string $stamp = '';

	/** The broker routing this reader's lines; null until it adopts the reader. */
	private ?Remote_Broker_Node $broker = null;

	/**
	 * The SOURCE and READER this reader's probe record names, which its broker
	 * composes each time it names the reader; blank until then.
	 *
	 * @var array{0:string,1:string}
	 */
	private array $probe_names = [ '', '' ];

	/**
	 * One entry per buffered line, in order: its breadcrumb and the message the
	 * broker already decoded, so a line is decoded once. A null message is a
	 * line handed over undecoded.
	 *
	 * @var \SplQueue<array{crumb:array{segment:int,offset:int,length:int}|null,message:array<int,mixed>|null}>
	 */
	private \SplQueue $lines;

	/** Whether the cursor's segment is unknown: a file source's generation not yet seen. */
	private bool $generation_unknown = false;

	/** When a step's `read_message` went out unanswered; null while none is out. */
	private ?float $step_requested_at = null;

	/** `step` clicks still waiting on a reply, one record each. */
	private int $steps_owed = 0;

	/**
	 * The block fetch in flight: the arguments its reply echoes, and when it
	 * went out. Null while none is out.
	 *
	 * @var array{args:list<string>,at:float}|null
	 */
	private ?array $fetch_in_flight = null;

	/** When the latest block fetch went out; null before the first. */
	private ?float $fetch_sent_at = null;

	/**
	 * The latest answered fetch: when, and its round trip in seconds.
	 *
	 * @var array{at:float,rtt:float}|null
	 */
	private ?array $fetch_answered = null;

	/**
	 * When a wait at the end, or after a refusal, began; null while none
	 * stands. Only the broker's tick ends one, a retry interval on, so
	 * readers due together ask in one POST.
	 */
	private ?float $waiting_since = null;

	/** What the spoke said refusing the latest fetch; null once a block answers. */
	private ?string $fetch_refusal = null;

	/**
	 * The header of the block in flight, between it and its TM_BATCH: where
	 * the block begins, what the spoke's log holds from there, whether a
	 * deleted segment rewound it, and the position a fetch asked, null for a
	 * block the stream pushed. A file the spoke cannot find names no segment.
	 *
	 * @var array{segment:?int,offset:int,distance:int,reset:bool,asked:?string}|null
	 */
	private ?array $header = null;

	/**
	 * What the spoke's log held from a place, as the spoke last said, and
	 * when. The backlog is that distance less how far the cursor has drained
	 * past the place, so a record that arrives after it is never counted twice.
	 *
	 * @var array{segment:int,offset:int,distance:int,at:float}|null
	 */
	private ?array $distance = null;

	/**
	 * A line the last block cut short: where it begins and its bytes so far,
	 * joined to the block that continues it.
	 *
	 * @var array{segment:int,offset:int,bytes:string}|null
	 */
	private ?array $carry = null;

	/**
	 * The offsetlog restore_position() read its durable frame from and seeded the
	 * cursor with.
	 *
	 * This is what makes restore_position() idempotent: connect_position() calls it
	 * to state the cursor in the first request, and the Durable_Reader boot seam
	 * (init_position) calls it again on the first poll, where it returns the
	 * already-seeded cursor untouched. Latching the sidecar rather than a bare `true`
	 * is what stops the latch outliving the offsetlog it describes: a replayed
	 * `arguments()` naming a new offsetlog_dir builds a new Partition, and a bool
	 * would leave the cursor seeded from the dir those arguments superseded.
	 */
	private ?Partition_Node $position_restored_from = null;

	/**
	 * A seek the spoke resolves, sent instead of the cursor until the cursor
	 * stands somewhere: a handshake, a step reply or the first record answers
	 * it. A fresh reader asks for the end, and while one is pending the
	 * cursor's 0:0 names no place.
	 */
	private ?int $pending_seek = Consumer_Node::SEEK_END;

	/**
	 * How far what this reader holds reaches: where the last block's whole
	 * lines end, where an empty one stands, or past the last placed record a
	 * step received, until the cursor reaches it and stands there. Everything
	 * buffered lies before it.
	 *
	 * @var array{segment?:int, offset:int}|null
	 */
	private ?array $block_end = null;

	/**
	 * The entry crumb_for_line() last took for a line, or null when none was
	 * queued. Its crumb, null when the line carried none, is what drain_line()
	 * steers on — the distinction the placeholder crumb erases — and its
	 * message is what forward_line() relays.
	 *
	 * @var array{crumb:array{segment:int,offset:int,length:int}|null,message:array<int,mixed>|null}|null
	 */
	private ?array $head = null;

	/** Seconds a spoke's distance stands with no newer word before the backlog reads unknown. */
	public const DISTANCE_STALE_SECONDS = 60;

	/** Tachikoma-parity: no-arg ctor; the broker configures it through `arguments()`. */
	public function __construct() {
		parent::__construct();
		$this->lines = new \SplQueue();
		// The first probe window opens now, so its elapsed is time-since-birth.
		$this->probe_ts = Core::$now;
		$this->auto_wire_interpreter();
	}

	/**
	 * Parse `<stamp> <offsetlog_dir> <deadletter_dir>`, build the sidecars and
	 * arm the poll. A replay naming other dirs rebuilds them, and leaves a
	 * paused reader paused.
	 *
	 * @api Dynamic entrypoint.
	 * @param list<string>|null $args Positional tokens, or null to read them.
	 * @return list<string>
	 */
	public function arguments( ?array $args = null ): array {
		if ( null === $args ) {
			return parent::arguments();
		}
		$this->parse_schema_args( $args );
		if ( $this->idle_unless_owned( $this->stamp ) ) {
			return $args;
		}
		$this->ensure_offsetlog();
		$this->ensure_deadletter();
		$this->poll_cb = $this->poll_init( ... );
		if ( $this->is_live() ) {
			$this->set_timer( self::POLL_INTERVAL_EOF_MS );
			$this->set_state( 'POLLING', 'ACTIVE' );
		}
		return $args;
	}

	/**
	 * What reaches this reader: a raw block and its header, pushed by the
	 * stream or answering a fetch; the spoke's refusal of a block fetch,
	 * matched by the arguments it echoes; the answer to a step; and the
	 * Router's bounce of a line whose target names no node, which is no command
	 * and settles nothing. An answer echoing the arguments a step would send
	 * now settles the request; any other is stale, a seek having moved the
	 * position since, and leaves the step in flight, so its late arrival
	 * cannot free the next tick to ask again. `pause` and `play` move nothing
	 * but forgive what was owed, so an answer nothing awaits is stale too: the
	 * stream says where the reader is.
	 *
	 * A record goes through `receive()` and drains as a streamed line does,
	 * one poll per owed step; the reply's cursor is then where the reader
	 * stands, since it places even a record carrying no crumb. No record owes
	 * nothing more and still takes the cursor, which moves past a line the
	 * spoke could not unpack. A payload that is no struct is a refusal: it owes
	 * nothing and leaves the cursor where it is.
	 *
	 * @param array<int,mixed> $message The 7-field positional message array.
	 */
	public function fill( array $message ): void {
		$type = Core::int( $message[ Message::TYPE ] );
		if ( $type & Message::TM_BATCH ) {
			if ( $type & Message::TM_INFO ) {
				$this->take_header( Core::as_string( $message[ Message::VALUE ] ) );
			} else {
				$this->take_batch( Core::as_string( $message[ Message::ID ] ), Core::as_string( $message[ Message::VALUE ] ), 0 !== ( $type & Message::TM_BYTESTREAM ) );
			}
			return;
		}
		if ( ! ( $type & Message::TM_COMMAND ) || ! ( $type & ( Message::TM_RESPONSE | Message::TM_ERROR ) ) ) {
			return;
		}
		$value = Core::arr( $message[ Message::VALUE ] );
		if ( 'read_block' === ( $value['name'] ?? null ) ) {
			$asked = $this->fetch_in_flight;
			if ( null !== $asked && ( $value['arguments'] ?? null ) === $asked['args'] ) {
				$this->settle_refusal( $value );
			}
			return;
		}
		if ( 0 === $this->steps_owed || ( $value['arguments'] ?? null ) !== [ $this->stamp, $this->step_position() ] ) {
			return;
		}
		try {
			$this->settle_step( $value );
		} finally {
			// Settled only once consumed, so the drain cannot ask again.
			$this->step_requested_at = null;
		}
	}

	/**
	 * Live, the reader drains on the Durable_Reader cadence. Paused, a tick only
	 * retries the request an owed step could not send — no session yet — and
	 * stops once nothing is owed, so it never drains past what a step granted.
	 */
	protected function fire(): void {
		if ( $this->is_live() ) {
			$this->reader_fire();
			return;
		}
		if ( $this->steps_owed > 0 ) {
			$this->request_step();
			if ( self::POLL_INTERVAL_EOF_MS !== $this->interval_ms ) {
				$this->set_timer( self::POLL_INTERVAL_EOF_MS );
			}
			return;
		}
		$this->stop_timer();
	}

	/**
	 * Consume the answer to the step in flight, while its request still
	 * counts as in flight.
	 *
	 * @param array<array-key,mixed> $value The reply's VALUE.
	 */
	private function settle_step( array $value ): void {
		$payload = $value['payload'] ?? null;
		if ( ! \is_array( $payload ) ) {
			$this->steps_owed = 0;
			$this->print_less_often( 'step refused: ', \trim( Core::as_string( $payload ) ) );
			return;
		}
		$record = $payload['message'] ?? null;
		if ( \is_array( $record ) ) {
			/** @var array<int,mixed> $record */
			$this->receive( Message::packed( $record ), $record, Log_Position::crumb( Core::as_string( $record[ Message::ID ] ) ) );
			while ( $this->steps_owed > 0 && $this->buffer_has_line() ) {
				$this->steps_owed -= $this->poll();
			}
		} else {
			$this->steps_owed = 0;
		}
		$cursor = Core::arr( $payload['cursor'] ?? null );
		if ( \is_int( $cursor['segment'] ?? null ) && \is_int( $cursor['offset'] ?? null ) ) {
			$this->stand_at( [ 'segment' => $cursor['segment'], 'offset' => $cursor['offset'] ] );
		}
	}

	/**
	 * Where the request about to go out begins, and the effects that go with
	 * stating it. It restores the durable cursor first, so a connect ahead of
	 * this reader's first poll still asks from it. Then it answers: past
	 * everything already held, as `held_end()` reads it, else a pending seek,
	 * else the cursor. What is held is a real place, so it outranks a pending
	 * seek, which stands until the cursor reaches what is held. A cursor
	 * whose generation is unknown states its offset alone. `Remote_Source`
	 * calls it once per connect, from its `stream_request()`.
	 *
	 * @return array{segment?:int,offset:int}|int The position, or a seek sentinel.
	 */
	public function connect_position(): array|int {
		$this->restore_position();
		$held = $this->held_end();
		if ( null !== $held ) {
			return $held;
		}
		if ( null !== $this->pending_seek ) {
			return $this->pending_seek;
		}
		return $this->generation_unknown
			? [ 'offset' => $this->cursor_offset ]
			: [ 'segment' => $this->cursor_segment, 'offset' => $this->cursor_offset ];
	}

	/**
	 * Refill seam: nothing is read here. Stand at the last block's end once
	 * its records drained; live, hand the broker its refill, where
	 * `Remote_Source` re-arms the stream that pushes lines here and
	 * `HTTP_Source` has this reader fetch its next block; paused and dry, ask
	 * the spoke for the next record.
	 */
	protected function get_batch(): void {
		$this->pass_block_end();
		if ( $this->is_live() ) {
			$this->broker?->refill( $this );
		} elseif ( ! $this->buffer_has_line() ) {
			$this->request_step();
		}
		$this->at_eof = ! $this->buffer_has_line();
	}

	/**
	 * Ask for the record where the reader stands, once per request: a reply
	 * lost to a transport error or a refused POST never comes, so a request
	 * older than HTTP_Out's own timeout goes out again, through a fresh
	 * session check. A late reply to the first is a duplicate the echo check
	 * already discards.
	 */
	private function request_step(): void {
		if ( null === $this->broker
			|| ( null !== $this->step_requested_at && Core::$now - $this->step_requested_at < HTTP_Out_Node::REQUEST_TIMEOUT ) ) {
			return;
		}
		$this->step_requested_at = $this->broker->send_read( $this, 'read_message', [ $this->stamp, $this->step_position() ] ) ? Core::$now : null;
	}

	/**
	 * Stand at the last block's end once the records buffered ahead of it
	 * have drained, which places an empty block's position and a line whose
	 * FROM would not stamp, neither of which reaches the buffer.
	 */
	private function pass_block_end(): void {
		if ( null === $this->block_end || $this->buffer_has_line() ) {
			return;
		}
		$this->stand_at( $this->block_end );
		$this->block_end = null;
	}

	/**
	 * Boot seam: seed the durable read position on the first poll. Delegates to the idempotent
	 * restore_position(). connect_position() has usually already run it, in which case this
	 * second call leaves the cursor, the crawl lineage and the boot head-skip exactly as that
	 * one set them. Then make sure the deadletter sibling exists, so the trait's
	 * cooperative_stop() has somewhere to quarantine to.
	 */
	protected function init_position(): void {
		$this->restore_position();
		$this->ensure_deadletter();
	}

	/**
	 * Read the latest committed frame, seed the node cursor and the boot pin, resume the shared
	 * poison and crash accounting (attempts+1, and a hard-crash lineage enters crawl), then arm
	 * the boot head-skip. A seek a caller asked for through `next_offset()` before this first
	 * restore stands, and the cursor stays for the spoke to resolve it; the frame's head then
	 * names no record the spoke will send, so no head-skip arms. Otherwise the restored
	 * cursor answers the fresh reader's end seek. Idempotent: connect_position() calls it to
	 * state the cursor in the first request, and the Durable_Reader boot seam calls it again on
	 * the first poll. Returns empty on a fresh offsetlog.
	 *
	 * @return array{segment?:int,offset?:int}
	 */
	protected function restore_position(): array {
		$offsetlog = $this->ensure_offsetlog();
		if ( null === $offsetlog ) {
			return [];
		}
		if ( $offsetlog === $this->position_restored_from ) {
			return [ 'segment' => $this->cursor_segment, 'offset' => $this->cursor_offset ];
		}
		$this->position_restored_from = $offsetlog;
		$value                        = $this->read_last_offsetlog_frame();
		if ( null === $value ) {
			return [];
		}
		$segment = $value['segment'] ?? 0;
		$offset  = $value['offset'] ?? 0;
		$segment = Core::as_int( $segment );
		$offset  = Core::as_int( $offset );
		if ( $this->offset_set && null !== $this->pending_seek ) {
			$this->resume_attempts_from_frame( $value );
		} else {
			$this->arm_skip_head_from_frame( $value );
			$this->stand_at( [ 'segment' => $segment, 'offset' => $offset ] );
		}
		$this->boot_cursor_segment = $segment;
		$this->boot_cursor_offset  = $offset;
		return [
			'segment' => $segment,
			'offset'  => $offset,
		];
	}

	/**
	 * Drain seam override: dispatch ONE buffered line the push way. Pin the cursor to the
	 * record's own START, taken from its breadcrumb, which also names the generation; then, if
	 * the boot head-skip is armed, run the 3-way crumb-vs-boot-pin compare. A push stream can
	 * resume PAST a GC'd suspect, so an armed head is not unconditionally the first drained
	 * line — which is why the trait's unconditional sacrifice cannot serve here. Everything
	 * else forwards through forward_line().
	 */
	protected function drain_line( string $line, int $abs_offset ): void {
		$crumb = $this->head['crumb'] ?? null;
		if ( null !== $crumb ) {
			$this->stand_at( $crumb );
		}
		if ( $this->crawl_skip_head && null !== $crumb && $this->sacrifice_boot_head( $line, $crumb ) ) {
			return; // Sacrificed — not forwarded.
		}
		$this->forward_line( $line, $abs_offset );
	}

	/**
	 * Crawl-entry head sacrifice: the 3-way compare deciding the fate of the first relayed
	 * message while the boot head-skip is armed. An EXACT crumb-start match on the boot pin is
	 * the suspect that was in flight when the death struck — dead-lettered under reason
	 * 'crash', or dropped when no quarantine is configured, and the caller skips the forward.
	 * A start PAST the pin means the suspect was GC'd or the stream resumed beyond it, so
	 * disarm without sacrificing and forward normally. Anything earlier leaves the flag armed
	 * for the real suspect. One-shot either way, once resolved.
	 *
	 * @param string $line The raw line under judgment.
	 * @param array{segment:int, offset:int} $crumb The line's parsed breadcrumb (its start).
	 * @return bool True when the head is condemned, so the caller skips the forward.
	 */
	private function sacrifice_boot_head( string $line, array $crumb ): bool {
		// Lexicographic (segment,offset) vs boot pin: 0=suspect, >0=past it.
		$cmp = [ $crumb['segment'], $crumb['offset'] ] <=> [ $this->boot_cursor_segment, $this->boot_cursor_offset ];
		if ( 0 === $cmp ) {
			$this->crawl_skip_head = false;
			$this->dead_letter( $this->poison_from_line( $line, $crumb['segment'], $crumb['offset'] ), 'crash' );
			$this->disposed_record = true;
			return true;
		}
		if ( 0 < $cmp ) {
			$this->crawl_skip_head = false;
			$this->print_less_often( "{$this->name} crawl head-sacrifice: suspect at ", "{$this->boot_cursor_segment}:{$this->boot_cursor_offset}", ' is gone (stream resumed past it) — not sacrificing' );
		}
		return false;
	}

	/**
	 * Emit seam override: forward one raw line with the FROM trail and the ID crumb the spoke
	 * sent, byte for byte, because a relay is a forwarder and stamps nothing; the crumb is what
	 * the Aggregator reads a record's origin from. drain_line() has already pinned the cursor
	 * from that crumb.
	 *
	 * `admit()` routes the line by the pair's target: a firehose record carries no TO, so an
	 * addressed line is refused. A refused line was still READ, so the cursor advances past it
	 * as a forward does, and it is marked disposed, so the drain commits past it and ends any
	 * poison or crash lineage. One bad record wedges nothing.
	 *
	 * The message is the one decoded when the block was split, so a line is decoded once.
	 * Each forward, and each clean stop, counts, and the largest line is tracked, as the
	 * trait's own forward does.
	 *
	 * Five dispositions, that refusal the first. A null sink FAILS LOUD, because a relay
	 * with nowhere to relay is a topology error. A torn line, which came with no message, is
	 * quarantined at its place, where drain_line() stood the cursor, and the drain moves past
	 * it by its crumb's length. A downstream throw
	 * dead-letters the message ON SIGHT and marks the record disposed, so the drain loop
	 * advances past it with no head-block and no fair-shot climb; that climb is reserved for
	 * the hard-crash lineage and its crawl. A Worker_Should_Stop escapes as
	 * `fill_sink()` settles it. When that is clean the drain commits past the record
	 * by its crumb's length; a crumbless record has no position of its own, so that length is
	 * zero and the cursor stays where the spoke will resume.
	 *
	 * @param string $line       One complete line off the pump buffer.
	 * @param int    $abs_offset Local drain offset, carried for the trait's signature; a push
	 *                           source places records from the crumb instead.
	 */
	protected function forward_line( string $line, int $abs_offset ): void {
		if ( null === $this->sink ) {
			throw new \RuntimeException( 'Remote_Consumer relay requires a wired sink' );
		}
		$this->largest_msg_sent = \max( $this->largest_msg_sent, \strlen( $line ) + 1 );
		$message = $this->head['message'] ?? null;
		if ( null === $message ) {
			// Torn: drain_line() stood the cursor at its place.
			$this->dead_letter( $this->poison_from_line( $line, $this->cursor_segment, $this->cursor_offset ), 'torn' );
			$this->disposed_record = true;
			return;
		}
		if ( ! $this->admit( $message ) ) {
			$this->disposed_record = true;
			return;
		}
		if ( $this->crawl ) {
			// Pre-dispatch pin: commit start before fill (crash resumes here).
			$this->write_checkpoint_frame( false, true );
		}
		if ( ! $this->fill_sink( $message ) ) {
			$this->disposed_record = true;
			return;
		}
		// Clear streak on forward itself (cursor at boot); not in crawl.
		if ( ! $this->crawl && $this->attempts > 1 ) {
			$this->reset_poison_streak();
			$this->write_checkpoint_frame( true, true );
		}
	}

	/**
	 * Route one record by the pair's target, the reader's declaration of where
	 * its lines may go: a record the spoke ADDRESSED names a node in this graph
	 * and is refused, consumed like a forward; an unaddressed one takes the
	 * target.
	 *
	 * @param array<int,mixed> $message The record, TO rewritten in place.
	 * @return bool True when it may go on to the sink.
	 */
	private function admit( array &$message ): bool {
		if ( '' !== Core::as_string( $message[ Message::TO ] ) ) {
			// Constant: drop_message keys its throttle on the reason.
			$this->drop_message( $message, 'addressed while target is set' );
			return false;
		}
		$message[ Message::TO ] = Core::as_string( $this->target );
		return true;
	}

	/**
	 * A step taken live leaves the stream as `pause` does, so the broker
	 * reconnects without this reader rather than buffering for it.
	 *
	 * @api Consumed over the wire by the debugger UI (auth-gated `step` command).
	 * @return array{segment:int, offset:int, at_eof:bool} The resulting cursor + EOF flag.
	 */
	public function step(): array {
		$live = $this->is_live();
		if ( $live ) {
			// Before the step, which owes itself a record afterwards.
			$this->forgive_asks();
		}
		$cursor = $this->reader_step();
		if ( $live ) {
			$this->broker?->restream();
		}
		return $cursor;
	}

	/**
	 * Reposition. A live reader's stream restarts from the new place; a paused
	 * one only moves its cursor, since it is not in the stream. A bare seek is
	 * forwarded for the spoke to resolve, and the in-flight buffer goes either
	 * way, since it belongs to the position being left behind. A position naming
	 * no segment moves the offset alone and leaves the generation unknown.
	 *
	 * @param string|int|array<array-key,mixed> $position Explicit {segment?,offset}, or a seek sentinel / alias word.
	 */
	protected function seek_to( $position ): void {
		$this->forgive_asks();
		if ( \is_array( $position ) ) {
			$at = [ 'offset' => \is_numeric( $position['offset'] ?? null ) ? Core::as_int( $position['offset'] ) : 0 ];
			if ( \is_numeric( $position['segment'] ?? null ) ) {
				$at['segment'] = Core::as_int( $position['segment'] );
			}
			$this->stand_at( $at );
		} else {
			$this->pending_seek = Log_Position::sentinel( $position );
		}
		$this->offset_set = true;
		$this->buffer     = '';
		$this->lines      = new \SplQueue();
		$this->block_end = null;
		$this->carry      = null;
		$this->distance   = null;
		if ( $this->is_live() ) {
			$this->broker?->restream();
		}
	}

	/**
	 * Durable-commit seam: one frame at the cursor, unconditionally. A cursor
	 * whose generation is unknown is not written: segment 0 would name a
	 * foreign inode on restore, so the last known frame stands instead.
	 *
	 * @param array<array-key,mixed> $extra Per-call frame additions.
	 */
	protected function write_checkpoint_frame( bool $graceful, bool $with_state, array $extra = [] ): void {
		// The sidecar in place: a move commits through the one it supersedes.
		if ( $this->generation_unknown || null === ( $this->offsetlog ?? $this->ensure_offsetlog() ) ) {
			return;
		}
		$this->commit_checkpoint_frame( $this->cursor_segment, $this->cursor_offset, $graceful, $extra );
	}

	/**
	 * Resolve a pending seek to where the spoke's handshake says the stream
	 * begins. Without one the handshake only names the position the connect
	 * asked for, which ticks may since have drained past, so it is not adopted;
	 * nor while records are held, since the connect asked past them and the
	 * cursor reaches them first. A cursor naming no segment leaves the
	 * generation unknown rather than writing segment 0.
	 *
	 * @param array{segment?:int,offset:int} $cursor This stream's CURSORS entry.
	 */
	public function adopt_stream_start( array $cursor ): void {
		if ( null === $this->pending_seek || null !== $this->held_end() ) {
			return;
		}
		$this->stand_at( $cursor );
	}

	/**
	 * Stand the cursor at a place, the cursor's one deliberate writer: a real
	 * place answers any pending seek. A place naming no segment moves the
	 * offset alone and leaves the generation unknown, rather than writing
	 * segment 0, which a File_Tail reads as a foreign inode.
	 *
	 * @param array{segment?:int,offset:int} $at Where the reader now stands.
	 */
	private function stand_at( array $at ): void {
		$this->pending_seek       = null;
		$this->generation_unknown = ! isset( $at['segment'] );
		if ( isset( $at['segment'] ) ) {
			$this->cursor_segment = $at['segment'];
		}
		$this->cursor_offset = $at['offset'];
	}

	/** `pause` leaves the stream: the broker reconnects without this reader. */
	protected function time_travel_on_pause(): void {
		$this->forgive_asks();
		$this->broker?->restream();
	}

	/** `play` rejoins it from where the cursor stands. */
	protected function time_travel_resume(): void {
		$this->forgive_asks();
		$this->set_timer( self::POLL_INTERVAL_EOF_MS );
		$this->broker?->restream();
	}

	/** Owe no step, await no reply and wait out nothing: what was asked no longer stands. */
	private function forgive_asks(): void {
		$this->steps_owed    = 0;
		$this->waiting_since = null;
		$this->drop_requests();
	}

	/**
	 * The channel that carried this reader's step and fetch is gone: neither
	 * is in flight, so the next poll asks again. Steps still owed stay owed.
	 */
	public function drop_requests(): void {
		$this->step_requested_at = null;
		$this->fetch_in_flight   = null;
		$this->header            = null;
	}

	/**
	 * Take a block's header, as `Consumer_Node::block_messages()` builds it:
	 * `OFFSET` where the block begins, `DISTANCE` what the spoke's log holds
	 * from there, `RESET` a rewind past deleted segments. One echoing `ASKED`
	 * answers a fetch, and counts only when it echoes the fetch in flight; one
	 * without was pushed by the stream. Its TM_BATCH follows.
	 *
	 * @param string $value The header's flat pairs.
	 */
	private function take_header( string $value ): void {
		$info     = Message::info_pairs( $value ) ?? [];
		$at       = Log_Position::parse( $info['OFFSET'] ?? '' );
		$distance = Core::canonical_decimal( $info['DISTANCE'] ?? null );
		$asked    = $info['ASKED'] ?? null;
		if ( ( null !== $asked && $asked !== ( $this->fetch_in_flight['args'][1] ?? null ) ) || ! \is_array( $at ) || isset( $at['length'] ) || null === $distance ) {
			return;
		}
		$this->header = [ 'segment' => $at['segment'] ?? null, 'offset' => $at['offset'], 'distance' => $distance, 'reset' => '1' === ( $info['RESET'] ?? null ), 'asked' => $asked ];
	}

	/**
	 * Take the bytes a header announced: split them into records and take the
	 * header's distance as the backlog's anchor. A block answering a fetch
	 * settles it, and the reader asks again at once, or after a retry interval when
	 * the block was empty.
	 *
	 * @param string $id    Where the bytes begin, `segment:offset`.
	 * @param string $bytes The raw bytes.
	 * @param bool   $text  Whether its lines are text, each a TM_BYTESTREAM, rather than packed records.
	 */
	private function take_batch( string $id, string $bytes, bool $text ): void {
		$header       = $this->header;
		$this->header = null;
		if ( null === $header || Log_Position::format( $header['segment'], $header['offset'], null ) !== $id ) {
			return;
		}
		if ( $header['reset'] ) {
			$this->stderr( 'spoke served past deleted segments: ' . ( null === $header['asked'] ? 'pushed' : "asked {$header['asked']}" ) . ", served {$id}" );
		}
		$segment = $header['segment'];
		if ( null !== $segment ) {
			$this->take_block( $segment, $header['offset'], $bytes, $text );
			$this->distance = [ 'segment' => $segment, 'offset' => $header['offset'], 'distance' => $header['distance'], 'at' => Core::$now ];
		} elseif ( '' !== $bytes ) {
			if ( null === $header['asked'] ) {
				$this->print_less_often( 'a block with bytes names no segment: ', $id );
			} else {
				$this->settle_refusal( [ 'payload' => "a block with bytes names no segment: {$id}" ] );
			}
			return;
		} elseif ( null === $this->held_end() && ( null !== $this->pending_seek || $this->generation_unknown ) ) {
			// A file not there yet places a reader with no place of its own.
			$this->block_end = [ 'offset' => $header['offset'] ];
		}
		$asked          = $this->fetch_in_flight;
		if ( null === $header['asked'] || null === $asked ) {
			return;
		}
		$this->fetch_in_flight = null;
		$this->fetch_refusal   = null;
		$this->fetch_answered  = [ 'at' => Core::$now, 'rtt' => Core::$now - $asked['at'] ];
		$this->waiting_since   = '' === $bytes ? Core::$now : null;
		$this->fetch();
	}

	/**
	 * A refused fetch: said rate-limited, shown in the status until a block
	 * answers, and waited out as the end is.
	 *
	 * @param array<array-key,mixed> $value The reply's VALUE.
	 */
	private function settle_refusal( array $value ): void {
		$this->fetch_in_flight = null;
		$this->fetch_refusal   = Core::as_string( $value['payload'] ?? '' );
		$this->print_less_often( 'fetch refused: ', \trim( $this->fetch_refusal ) );
		$this->waiting_since   = Core::$now;
	}

	/**
	 * Split raw bytes into records, as the browser's `SseInNode` does, the
	 * two held to `tests/fixtures/raw-blocks.json`. A carried fragment the
	 * bytes continue is joined to them; one they do not was torn, and is
	 * dead-lettered at its place. Each whole line goes on at its own place,
	 * and what follows the last newline is carried to the next block, unless
	 * it already runs past `MAX_LINE_BUFFER_SIZE`, which skips it as a
	 * reader skips any overflowing line.
	 *
	 * @param int    $segment Where the bytes begin.
	 * @param int    $offset  Their offset in it.
	 * @param string $bytes   The raw bytes.
	 * @param bool   $text    Whether its lines are text rather than packed records.
	 */
	private function take_block( int $segment, int $offset, string $bytes, bool $text ): void {
		if ( '' === $bytes ) {
			// Nothing yet; the header still places a word the reader asked.
			if ( null === $this->held_end() ) {
				$this->block_end = [ 'segment' => $segment, 'offset' => $offset ];
			}
			return;
		}
		$carry = $this->carry;
		if ( null !== $carry ) {
			if ( [ 'segment' => $segment, 'offset' => $offset ] === $this->held_end() ) {
				$bytes  = $carry['bytes'] . $bytes;
				$offset = $carry['offset'];
			} else {
				$this->receive( $carry['bytes'], null, [ 'segment' => $carry['segment'], 'offset' => $carry['offset'], 'length' => \strlen( $carry['bytes'] ) ] );
			}
		}
		$pos = 0;
		while ( false !== ( $nl = \strpos( $bytes, "\n", $pos ) ) ) {
			$this->take_line( \substr( $bytes, $pos, $nl - $pos ), $segment, $offset + $pos, $text );
			$pos = $nl + 1;
		}
		$cut = \substr( $bytes, $pos );
		if ( \strlen( $cut ) > self::MAX_LINE_BUFFER_SIZE ) {
			$this->report_overflow( $segment, $offset + $pos );
			$pos += \strlen( $cut );
			$cut  = '';
		}
		$this->carry     = '' === $cut ? null : [ 'segment' => $segment, 'offset' => $offset + $pos, 'bytes' => $cut ];
		$this->block_end = [ 'segment' => $segment, 'offset' => $offset + $pos ];
	}

	/**
	 * One whole line from a block, as a record: stamped FROM with the log the
	 * spoke read, as a stream's reader stamps it, and ID'd with its place,
	 * `segment:offset:length`. A text line is a TM_BYTESTREAM carrying it,
	 * newline restored, as a Tail emits one; a line that will not unpack was
	 * torn, and goes on undecoded to be dead-lettered at its place.
	 *
	 * @param string $line    The line, without its newline.
	 * @param int    $segment Its segment.
	 * @param int    $offset  Where it begins.
	 * @param bool   $text    Whether it is text rather than a packed record.
	 */
	private function take_line( string $line, int $segment, int $offset, bool $text ): void {
		$crumb = [ 'segment' => $segment, 'offset' => $offset, 'length' => \strlen( $line ) + 1 ];
		try {
			$message = $text ? Tail_Node::text_record( $line ) : Message::unpacked( $line );
		} catch ( \InvalidArgumentException $e ) {
			$this->receive( $line, null, $crumb );
			return;
		}
		if ( ! $this->stamp_message( $message, $this->stamp ) ) {
			return;
		}
		$message[ Message::ID ] = Log_Position::format( $segment, $offset, $crumb['length'] );
		$this->receive( $line, $message, $crumb );
	}

	/**
	 * Buffer one line beside the message already decoded from it and its
	 * place in the spoke's log, and take the busy cadence: data arrives on
	 * the cURL drain, between fires. A torn line comes with no message and is
	 * dead-lettered when it drains; a step's record may come with no place.
	 * A split block and a step's reply share it, so no line is decoded twice
	 * (ADR-1's amendment).
	 *
	 * @param string                                          $raw     The line, without its newline.
	 * @param array<int,mixed>|null                           $message Its decoded message, or null when torn.
	 * @param array{segment:int,offset:int,length:int}|null $crumb   Its place, or null when it names none.
	 */
	private function receive( string $raw, ?array $message, ?array $crumb ): void {
		if ( null !== $crumb ) {
			$this->block_end = [ 'segment' => $crumb['segment'], 'offset' => $crumb['offset'] + $crumb['length'] ];
		}
		$this->buffer     .= $raw . "\n";
		$this->bytes_read += \strlen( $raw ) + 1;
		$this->lines->enqueue( [ 'crumb' => $crumb, 'message' => $message ] );
		$this->at_eof = false;
		if ( $this->is_live() && self::POLL_INTERVAL_BUSY_MS !== $this->interval_ms ) {
			$this->set_timer( self::POLL_INTERVAL_BUSY_MS );
		}
	}

	/**
	 * End a wait `$wait_s` old, and fetch: the broker's tick calls it with
	 * its retry interval.
	 *
	 * @param float $wait_s The broker's retry interval, in seconds.
	 */
	public function fetch_when_due( float $wait_s ): void {
		if ( null !== $this->waiting_since && Core::$now >= $this->waiting_since + $wait_s ) {
			$this->waiting_since = null;
			$this->fetch();
		}
	}

	/**
	 * Ask the spoke for the next block, when this reader is live, holds under
	 * one block, has none in flight and waits out no end or refusal, which
	 * only `fetch_when_due()` ends. A fetch lost to a transport error is asked
	 * again once HTTP_Out's own timeout has passed; a late reply to the first
	 * then echoes arguments no longer held.
	 */
	public function fetch(): void {
		if ( null === $this->broker
			|| ! $this->is_live()
			|| $this->holding_back()
			|| null !== $this->waiting_since
			|| Core::$now - ( $this->fetch_in_flight['at'] ?? -\INF ) < HTTP_Out_Node::REQUEST_TIMEOUT ) {
			return;
		}
		$args = [ $this->stamp, $this->fetch_position(), ...( $this->broker->multi_writer() ? [ '--multi_writer=true' ] : [] ) ];
		if ( $this->broker->send_read( $this, 'read_block', $args ) ) {
			$this->fetch_in_flight = [ 'args' => $args, 'at' => Core::$now ];
			$this->fetch_sent_at   = Core::$now;
		}
	}

	/** A paused reader is out of the stream; any other reads it live. */
	public function is_live(): bool {
		return 'PAUSED' !== $this->get_state( 'POLLING' );
	}

	/**
	 * Where the next block begins, in `read_block`'s grammar: past what is
	 * held, else a pending seek's word, else the cursor.
	 */
	private function fetch_position(): string {
		$held = $this->held_end();
		if ( null !== $held ) {
			return Log_Position::format( $held['segment'] ?? null, $held['offset'], null );
		}
		return $this->step_position();
	}

	/**
	 * Where a step reads, in `read_message`'s grammar: a pending seek's word,
	 * which the spoke resolves; else the cursor.
	 */
	private function step_position(): string {
		$word = null === $this->pending_seek ? null : Log_Position::word( $this->pending_seek );
		return $word ?? $this->cursor_position();
	}

	/**
	 * Where the cursor stands now, restoring and consuming nothing, as
	 * `Log_Position::format()` writes it: the offset alone, as `:{offset}`,
	 * while the generation is unknown, since segment 0 names a foreign inode.
	 *
	 * @return string `{segment}:{offset}` or `:{offset}`.
	 */
	public function cursor_position(): string {
		return Log_Position::format( $this->generation_unknown ? null : $this->cursor_segment, $this->cursor_offset, null );
	}

	/**
	 * How far the spoke's stream reaches past the cursor, as far as this reader
	 * knows: the end of a line a block cut short, whose bytes it holds; else
	 * `block_end`; null when it holds neither.
	 *
	 * @return array{segment?:int,offset:int}|null
	 */
	private function held_end(): ?array {
		if ( null !== $this->carry ) {
			return [ 'segment' => $this->carry['segment'], 'offset' => $this->carry['offset'] + \strlen( $this->carry['bytes'] ) ];
		}
		return $this->block_end;
	}

	/**
	 * Probe seam: this reader's Consumer record, through
	 * `Durable_Reader::probe_record()`, as `Consumer_Node::probe_stats()` sends
	 * its own. SOURCE names the spoke's log as this site does,
	 * `remote:<vault_id>:<stamp>`, never the spoke's bare stamp, which would name
	 * a log of this site's own; READER is the id the broker composes from its
	 * worker binding. Both come from the broker (`probe_names()`) as it names
	 * this reader, and both are blank without one.
	 *
	 * DISTANCE is the spoke's own count of the bytes its log holds past where
	 * it last answered from, plus the spoke-side length of every record this
	 * reader holds undrained, which lie before that place; null until a spoke
	 * reports one, as one older than the report does not. The spoke names no
	 * end position, so the END pair stays null. A segment this reader does not
	 * know — a file source's generation before the spoke names it — is null
	 * too, never 0, which names a real segment or a foreign inode. A reader
	 * whose seek is still pending stands nowhere yet, so it sends nothing.
	 *
	 * @return array<int,int|string|null>|null A `Probe_Record`-indexed positional array, or null.
	 */
	public function probe_stats(): ?array {
		if ( null !== $this->pending_seek ) {
			return null;
		}
		[ $source, $reader ] = $this->probe_names;
		return $this->probe_record( $source, $reader, [
			'cursor_segment' => $this->generation_unknown ? null : $this->cursor_segment,
			'cursor_offset'  => $this->cursor_offset,
			'end_segment'    => null,
			'end_size'       => null,
			'bytes_behind'   => $this->backlog(),
		] );
	}

	/**
	 * The spoke's last distance less how far the cursor has drained past the
	 * place it was measured from. A cursor on another segment, still draining
	 * what came before that place, adds what it holds there; segments are
	 * compared for sameness alone, because a file source's are inodes. Null
	 * before the spoke first says, or once `DISTANCE_STALE_SECONDS` pass with
	 * no word: a header, or the broker hearing that nothing more waits. A
	 * quiet the hub keeps, a full reader or a shut valve, is no silence.
	 */
	private function backlog(): ?int {
		$distance = $this->distance;
		$heard    = $this->holding_back() ? Core::$now : ( $this->broker?->heard_at() ?? -\INF );
		if ( null === $distance || $this->generation_unknown || Core::$now - \max( $distance['at'], $heard ) > self::DISTANCE_STALE_SECONDS ) {
			return null;
		}
		if ( $this->cursor_segment === $distance['segment'] ) {
			return \max( 0, $distance['distance'] - ( $this->cursor_offset - $distance['offset'] ) );
		}
		return $distance['distance'] + $this->held_before( $distance['segment'], $distance['offset'] );
	}

	/** A block's worth held undrained: the reader asks for no more until it drains. */
	private function holding_back(): bool {
		return $this->buffered_bytes() >= Log_Sources::BLOCK_BYTES;
	}

	/** Bytes buffered and not yet drained; the broker sums them for its valve. */
	public function buffered_bytes(): int {
		return \strlen( $this->buffer );
	}

	/**
	 * The spoke-side length of every record held undrained before a place,
	 * which the spoke's distance from there leaves out: each line's
	 * breadcrumb names it, and a line without one counts nothing.
	 *
	 * @param int $segment The place's segment.
	 * @param int $offset  Its offset.
	 */
	private function held_before( int $segment, int $offset ): int {
		$bytes = 0;
		foreach ( $this->lines as $entry ) {
			$crumb = $entry['crumb'];
			if ( null !== $crumb && ( $crumb['segment'] !== $segment || $crumb['offset'] < $offset ) ) {
				$bytes += $crumb['length'];
			}
		}
		return $bytes;
	}

	/**
	 * A broker builds this reader only for a pair its worker owns, having
	 * asked `Core::owns()` of the pair as written, so there is no source
	 * argument to judge and the reader never idles (ADR-31).
	 */
	protected static function source_argument(): ?string {
		return null;
	}

	/**
	 * Final cursor handoff of an operational stop, overriding `Durable_Reader`'s. A
	 * healthy reader commits gracefully (attempts=0), so progress survives the recycle; a
	 * hard-crash lineage still in flight keeps its climbing, pinned frame instead. The
	 * cooperative-stop fair-shot lives elsewhere, in Durable_Reader's cooperative_stop(),
	 * gated on buffer_head_line() and stopped_in_fill.
	 *
	 * @api Invoked by Durable_Reader::hand_off_cursor() on an operational stop.
	 */
	public function checkpoint_shutdown(): void {
		$this->commit_healthy_frame();
	}

	/**
	 * Crumb seam override: a pull source is addressed by the spoke that sent it, so the record's
	 * position and size are the breadcrumb it arrived with, read off the queue `receive()` fills,
	 * never the local line's bytes. A line carrying no crumb cannot be placed in the spoke's byte
	 * space at all — it keeps the cursor where it stands and moves it by nothing. It peeks: the
	 * entry leaves the queue only with its line, in `advance_consume_cursor()`, so a stop that
	 * keeps the line buffered keeps its entry too.
	 *
	 * @return array{segment:int, offset:int, length:int}
	 */
	protected function crumb_for_line( string $line ): array {
		$this->head = $this->lines->isEmpty() ? null : $this->lines->bottom();
		return $this->head['crumb'] ?? [ 'segment' => $this->cursor_segment, 'offset' => $this->cursor_offset, 'length' => 0 ];
	}

	/** Move past the record just drained, and drop its entry with it. */
	protected function advance_consume_cursor(): void {
		if ( ! $this->lines->isEmpty() ) {
			$this->lines->dequeue();
		}
		$this->reader_advance();
	}

	/** Owe a starved step one record, and tick so a request the broker could not send yet retries. */
	protected function after_step( int $consumed ): void {
		if ( 0 === $consumed ) {
			++$this->steps_owed;
		}
		$this->set_timer( self::POLL_INTERVAL_EOF_MS );
	}

	/**
	 * The reader's frame extra beyond the shared base: the commit wall-clock, carried on every
	 * frame so an idle-vs-fresh cursor is distinguishable in the durable record.
	 *
	 * @return array<array-key,mixed>
	 */
	protected function checkpoint_frame_extra(): array {
		return [ '_ts' => (int) Core::$now ];
	}

	/**
	 * Adopt the broker whose feed carries this stream and whose HTTP_Out
	 * steps it, and take the names this reader reports under. The broker calls
	 * it whenever it names the reader: on building it, on a rename and on a
	 * replay, which may move the vault, the topology or the partition.
	 *
	 * @param Remote_Broker_Node $broker The broker routing this stream's lines.
	 */
	public function broker( Remote_Broker_Node $broker ): void {
		$this->broker      = $broker;
		$this->probe_names = $broker->probe_names( $this->stamp );
	}

	/** The stamp this reader's lines carry. */
	public function stamp(): string {
		return $this->stamp;
	}

	/**
	 * What the broker's status reads off this reader's fetches.
	 * `waiting_since` names an end-of-log wait alone, which the broker's
	 * interval ends; a refusal's wait is a failure, which the status reads as
	 * `refused`, not as idle.
	 *
	 * @return array{sent_at:?float,answered_at:?float,rtt:?float,waiting_since:?float,refused:?string}
	 */
	public function fetch_stats(): array {
		return [
			'sent_at'       => $this->fetch_sent_at,
			'answered_at'   => $this->fetch_answered['at'] ?? null,
			'rtt'           => $this->fetch_answered['rtt'] ?? null,
			'waiting_since' => null === $this->fetch_refusal ? $this->waiting_since : null,
			'refused'       => $this->fetch_refusal,
		];
	}

	/**
	 * Drop the slots the base cascade just tore down, so a later `ensure_offsetlog()`, which
	 * `init_position()` reaches, rebuilds them instead of handing back a Partition whose name,
	 * sink and patron that cascade already cleared.
	 */
	public function remove_node(): void {
		parent::remove_node();
		$this->offsetlog  = null;
		$this->deadletter = null;
	}

	/**
	 * Fold the time-travel READ surface (frames + cursor) into the canvas-poll payload. The
	 * reported cursor is the node-owned after-forward cursor (the single source of truth).
	 *
	 * @api Dynamic entrypoint.
	 * @return array{frames: array<int,array{id:int,size:int}>, cursor: array{segment:int, offset:int}, polling: string, at_frame: int|null, on_frame: bool, deadletter_segments: int}
	 */
	public function dump_metadata(): array {
		return $this->time_travel_metadata() + $this->deadletter_metadata();
	}

	/** Round-trip the time-travel lines and toggles after the base `make_node` line. */
	public function dump_config(): string {
		return parent::dump_config() . $this->dump_time_travel_config() . $this->dump_toggles();
	}

	/**
	 * Off the palette, since a broker builds it, with the Consumer reader's
	 * verbs on its own `:config`; the console opens it from its broker.
	 *
	 * @api Dynamic entrypoint.
	 * @return array<string,mixed>
	 */
	public static function node_schema(): array {
		return [
			'category'     => 'Hidden',
			'description'  => 'Durable reader for one stream a broker carries (built by the broker).',
			'arguments'    => [
				[ 'name' => 'stamp', 'type' => 'string', 'required' => true, 'description' => 'The stamp this stream\'s lines carry: a spoke partition dir or sources:<name>.' ],
				[ 'name' => 'offsetlog_dir', 'type' => 'string', 'required' => true, 'partition' => 'bound', 'description' => 'Directory for the durable read-cursor offsetlog.' ],
				[ 'name' => 'deadletter_dir', 'type' => 'string', 'required' => true, 'partition' => 'bound', 'description' => 'Directory where poison records are quarantined.' ],
			],
			'commands'     => \array_merge( self::deadletter_verbs(), self::time_travel_verbs(), self::pump_verbs() ),
			'requests'     => [],
			'accepts_fill' => true,
		];
	}
}
