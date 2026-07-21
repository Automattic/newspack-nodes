<?php
/**
 * Dead_Letter_Queue: quarantine + fair-shot attempt accounting (dead-letter [42]).
 *
 * Owns the reusable poison-handling core: the `:deadletter` sibling Partition, the
 * fail-loud `dead_letter()` writer, the raw-line → replayable-Message wrap
 * (`poison_from_line`), and the cooperative-stop strike accounting
 * (`record_poison_strike`). The buffer/cursor specifics that DECIDE when to call
 * these stay in the using class (Consumer's `cooperative_stop` / `drain_buffer`).
 *
 * Shared by Consumer_Node (raw-line reader, full fair-shot machinery) and
 * Remote_Source_Node (relays whole Messages; uses just the quarantine writer so a
 * poison stream message can't wedge the worker).
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes;

\defined( 'ABSPATH' ) || exit;

trait Dead_Letter_Queue {
	use Sidecar;

	/**
	 * Hard-crash threshold: after this many respawns at one cursor with NO reason
	 * stamped (an uncatchable death — OOM/fatal/SIGKILL — not a caught throw), the
	 * worker enters crawl mode to isolate the poison one message at a time.
	 */
	public const CRASH_MAX_ATTEMPTS = 5;

	/**
	 * Cooperative-stop threshold ([42]): after this many fair-shot strikes (full
	 * worker lifetimes spent on the boot-cursor message under a timeout/memory stop),
	 * the message is dead-lettered and the cursor advances. Lower than the hard-crash
	 * budget — a cooperative stop is a clean signal, so fewer mulligans are needed.
	 */
	public const COOP_MAX_ATTEMPTS = 2;

	/**
	 * Crawl cadence ([42]): the forward-progress window a crawling node must survive
	 * crash-free before it leaves crawl and returns to coarse checkpointing. Also the
	 * Consumer's coarse cursor-checkpoint interval. Shared so both crawl shapes
	 * (Consumer per-line, Remote_Source per-relayed-message) agree on the exit window.
	 */
	public const CHECKPOINT_INTERVAL_S = 30;

	/** DLQ sibling retention: 1 MiB segments × 16, rotate by count (no time-based aging). */
	public const DEADLETTER_SEGMENT_SIZE = 1048576;
	public const DEADLETTER_MIN_SEGMENTS = 2;
	public const DEADLETTER_MAX_SEGMENTS = 16;
	public const DEADLETTER_MIN_LIFETIME = 0;
	public const DEADLETTER_MAX_LIFETIME = 0;

	/** Newest-first page size for the `dl_list` triage verb when no limit is given. */
	public const DEADLETTER_LIST_DEFAULT_LIMIT = 50;

	/**
	 * Times the message at the boot cursor has been attempted without advancing past
	 * it (dead-letter [42]). 1 = healthy baseline (a running checkpoint); 0 = a
	 * graceful-shutdown handoff at a genuinely un-attempted cursor. A respawn reads
	 * the frame's value and resumes at attempts+1, so a stuck/poison cursor climbs.
	 */
	protected int $attempts = 1;

	/**
	 * Why the prior process stopped at this cursor — '' = none / hard crash (the
	 * signature that drives crawl-mode isolation), else a cooperative-stop reason
	 * (`timeout`/`memory`, stamped at shutdown). A respawn reads it to classify.
	 */
	protected string $poison_reason = '';

	/**
	 * Wall-clock of the first crash in the current stuck streak (null when healthy),
	 * carried forward across respawns.
	 */
	protected ?float $first_crash_ts = null;

	/**
	 * Hard-crash crawl mode ([42]): the node respawned into an uncatchable-death
	 * lineage and now checkpoints per message to pin the exact culprit on a re-crash.
	 * Surviving CHECKPOINT_INTERVAL_S of forward progress leaves it.
	 */
	protected bool $crawl = false;

	/** Wall-clock this process entered crawl; surviving CHECKPOINT_INTERVAL_S past it exits crawl. */
	protected float $crawl_started = 0.0;

	/**
	 * One-shot crawl-entry flag: on the first crawled drain, dead-letter the boot-cursor head —
	 * the message the reader was on when the uncatchable death struck (the crash suspect) — with
	 * reason 'crash' and advance past it. Lineage accounting, not read-loop machinery, so it lives
	 * here and both readers arm it on crawl entry: Consumer sacrifices its buffered head line
	 * (per-line drain), Remote_Source the relayed message whose crumb START matches the boot pin.
	 */
	protected bool $crawl_skip_head = false;

	/**
	 * Disposition of an armed boot head-skip (see $crawl_skip_head): 'crash' → the head was
	 * never captured, DLQ it with reason 'crash' (the crash-lineage sacrifice); 'drop' → a
	 * quarantine marker (`quarantined => true` on the resumed frame) says the head is ALREADY in
	 * the DLQ, so drop it silently (no second entry). Only meaningful while $crawl_skip_head is true.
	 */
	protected string $skip_head_disposition = 'crash';

	/**
	 * Source `{segment,offset}` of a message already in the `:deadletter` sibling that the cursor
	 * still sits on (an advance-on-next reader lingers there until the next arrival; a boot 'drop'
	 * life sits on the marker's position). Every frame committed AT this position keeps `quarantined`
	 * set so no plain boot/persist/shutdown frame clobbers the marker and re-forwards an
	 * already-quarantined message; a frame committed strictly PAST it releases the seal. null = none.
	 *
	 * @var array{segment:int,offset:int}|null
	 */
	protected ?array $sealed_quarantine = null;

	/**
	 * Quarantine dir for poison messages (dead-letter [42]); '' = no DLQ (log + drop).
	 * The using node is the sole writer of its DLQ sibling, so it lifts the PIPE_BUF cap.
	 */
	protected string $deadletter_dir = '';

	/** Null when $deadletter_dir is empty — poison is logged and dropped instead of quarantined. */
	protected ?Partition_Node $deadletter = null;

	/**
	 * Reason staged for the companion-index callback right before a :deadletter fill.
	 * dead_letter() sets it synchronously; the index closure closes over $this to read it.
	 */
	protected string $deadletter_reason = '';

	/**
	 * Build + register the `:deadletter` sibling Partition once (idempotent). Empty
	 * dir → null (log + drop). The using node asserts it's the sole writer, so the
	 * 4 KB PIPE_BUF cap is lifted (void_warranty) — a poison message can exceed it.
	 *
	 * @param string $dir  Quarantine segment directory. Empty → null.
	 * @param string $name Node name for the partition; '' leaves it unnamed (named later).
	 */
	/** Where the quarantine lives. Empty disables the DLQ; it is an ARGUMENT, not derived. */
	protected function deadletter_dir(): string {
		return $this->deadletter_dir;
	}

	/** What it answers to. Override to qualify the name (e.g. by remote partition). */
	protected function deadletter_name(): string {
		return '' !== $this->name ? "{$this->name}:deadletter" : '';
	}

	protected function ensure_deadletter(): ?Partition_Node {
		if ( null !== $this->deadletter ) {
			return $this->deadletter;
		}
		$dir = $this->deadletter_dir();
		if ( '' === $dir ) {
			return null;
		}
		// All four axes: an omitted one inherits <config:*> and never prunes.
		$deadletter = $this->make_sidecar( $dir, $this->deadletter_name(), [
			self::DEADLETTER_SEGMENT_SIZE,
			self::DEADLETTER_MIN_SEGMENTS,
			self::DEADLETTER_MAX_SEGMENTS,
			self::DEADLETTER_MIN_LIFETIME,
			self::DEADLETTER_MAX_LIFETIME,
		] );
		// Sole writer: the cap lifts so poison over PIPE_BUF still quarantines.
		$deadletter->void_warranty();
		// Triage metadata rides in .idx; ingest replays only .log (verbatim).
		$deadletter->with_index( $this->deadletter_index_row( ... ) );
		$this->deadletter = $deadletter;
		return $deadletter;
	}

	/**
	 * Build the Message to quarantine from a raw source line: the real unpacked
	 * message when it parses (so `wp nodes ingest` can replay it), else the raw bytes
	 * wrapped in a TM_BYTESTREAM for inspection. Stamps the source segment:offset:length breadcrumb.
	 *
	 * @return array<int, mixed>
	 */
	protected function poison_from_line( string $line, int $segment, int $offset ): array {
		try {
			$message = Message::unpacked( $line );
		} catch ( \InvalidArgumentException $e ) {
			$message                   = Message::new_message();
			$message[ Message::TYPE ]  = Message::TM_BYTESTREAM;
			$message[ Message::VALUE ] = $line;
		}
		$length                 = \strlen( $line ) + 1;
		$message[ Message::ID ] = "{$segment}:{$offset}:{$length}";
		return $message;
	}

	/**
	 * Quarantine a poison message: write the (replayable) original to the :deadletter
	 * sibling when one is configured, else log + drop. Always emits a rate-limited
	 * alert carrying the why (reason, source breadcrumb, error) — durable via
	 * Core::stderr's error_log, so the give-up is never silent. The caller advances
	 * the cursor past the message regardless, so poison can't wedge the source.
	 *
	 * Replay is `wp nodes ingest <topic> <deadletter-segment>`, which re-`fill()`s each
	 * stored message verbatim — so the entry is the original message, not a wrapper.
	 *
	 * @param array<int, mixed> $message The poison Message (positional).
	 */
	protected function dead_letter( array $message, string $reason, ?\Throwable $error = null ): void {
		$where   = Core::as_string( $message[ Message::ID ] ?? '' );
		$why     = null === $error ? '' : ': ' . $error->getMessage();
		$outcome = 'dropped (no deadletter_dir)';
		if ( null !== $this->deadletter ) {
			// Staged for the .idx callback; cleared in the finally.
			$this->deadletter_reason = $reason;
			try {
				$this->deadletter->fill( $message );
				$this->deadletter->flush();
				$outcome = 'quarantined';
			} catch ( Worker_Should_Stop $e ) {
				throw $e; // Stop escapes; poison re-quarantines on respawn.
			} catch ( \Throwable $e ) {
				// Quarantine failed: drop + advance, else the source loops.
				$outcome = 'DROP — deadletter write failed: ' . $e->getMessage();
			} finally {
				$this->deadletter_reason = '';
			}
		}
		$this->print_less_often( "DEAD-LETTER [{$reason}] {$this->name} at ", $where, ' — ', $outcome, $why );
	}

	/**
	 * Companion-index row for one quarantined record — the triage metadata written
	 * BESIDE the byte-verbatim :deadletter record in the sibling .idx. `reason` is
	 * staged by dead_letter() right before the fill; `attempts`/`first_crash_ts` are
	 * the live fair-shot accounting; `locator` is the record's `segment:offset:length`
	 * IN THE SIDECAR (paste it into dl_requeue); `source` is its origin breadcrumb
	 * (Message::ID) — same shape, different log, hence the distinct labels.
	 *
	 * @param array<int, mixed>  $message  The quarantined Message.
	 * @param array<string, int> $position Its {segment,offset,length} in the sidecar.
	 */
	private function deadletter_index_row( array $message, array $position ): string {
		return (string) \wp_json_encode( [
			'reason'         => $this->deadletter_reason,
			'attempts'       => $this->attempts,
			'first_crash_ts' => $this->first_crash_ts,
			'ts'             => (int) Core::$now,
			'source'         => Core::as_string( $message[ Message::ID ] ?? '' ),
			'locator'        => "{$position['segment']}:{$position['offset']}:{$position['length']}",
		] );
	}

	/**
	 * The log a requeued dead-letter record is re-injected into — the source this node
	 * tails. Null (the default) means no local source: a remote SSE pull cannot requeue.
	 * Consumer overrides to return its source Partition.
	 */
	protected function deadletter_requeue_target(): ?Partition_Node {
		return null;
	}

	/**
	 * List quarantined records newest-first, capped at $limit. Each row is the .idx
	 * triage metadata (reason, attempts, first_crash_ts, quarantine ts, source
	 * breadcrumb, sidecar locator). `total` counts ALL indexed records (the badge
	 * number), not the returned page. `unindexed_segments` counts .log segments with
	 * no .idx companion — records dead-lettered BEFORE this feature; they don't
	 * appear in `rows` but remain replayable via `wp nodes ingest` and rotate out
	 * within DEADLETTER_MAX_SEGMENTS. The DLQ is count-bounded, so the full .idx
	 * pass behind the totals stays cheap.
	 *
	 * @return array{rows: array<int, mixed>, total: int, unindexed_segments: int}
	 */
	public function list_deadletter( int $limit ): array {
		$deadletter = $this->ensure_deadletter();
		if ( null === $deadletter ) {
			return [ 'rows' => [], 'total' => 0, 'unindexed_segments' => 0 ];
		}
		$rows         = [];
		$total        = 0;
		$indexed_segs = [];
		$deadletter->scan_index(
			static function ( string $line, int $segment ) use ( &$rows, &$total, &$indexed_segs, $limit ): bool {
				$indexed_segs[ $segment ] = true;
				++$total;
				if ( \count( $rows ) < $limit ) {
					$row = \json_decode( $line, true );
					if ( \is_array( $row ) ) {
						$rows[] = $row;
					}
				}
				return true; // Full pass: total + unindexed count need every segment.
			},
			true
		);
		$unindexed = 0;
		foreach ( $deadletter->get_segments() as $s ) {
			if ( ! isset( $indexed_segs[ $s['id'] ] ) ) {
				++$unindexed;
			}
		}
		return [ 'rows' => $rows, 'total' => $total, 'unindexed_segments' => $unindexed ];
	}

	/**
	 * Re-inject the dead-letter record at $locator (the `locator` field from
	 * list_deadletter, its SIDECAR position) back into the source this node tails.
	 * Reads the byte-verbatim record via read_message_at, applies the same PIPE_BUF
	 * size guard `wp nodes ingest` uses, then appends it to the source's tail so the
	 * reader reaches it again. On a SHARED source log every tailer re-receives the
	 * record — including consumers that already processed it. Returns an ok/error
	 * line for the verb reply.
	 */
	public function requeue_deadletter( string $locator ): string {
		$deadletter = $this->ensure_deadletter();
		if ( null === $deadletter ) {
			return 'error: no dead-letter queue configured';
		}
		$target = $this->deadletter_requeue_target();
		if ( null === $target ) {
			return 'error: requeue unavailable — this node has no local source log to re-inject into';
		}
		$loc = $this->parse_deadletter_locator( $locator );
		if ( null === $loc ) {
			return "error: malformed locator '{$locator}' — want segment:offset:length from dl_list";
		}
		[ $segment, $offset, $length ] = $loc;
		$message = $deadletter->read_message_at( $segment, $offset, $length );
		if ( null === $message ) {
			return "error: no dead-letter record at {$locator}";
		}
		$size = Message::packed_size( $message ) + 1;
		if ( $size > Partition_Node::MAX_LINE_SIZE ) {
			return "error: record is {$size} bytes (over the " . Partition_Node::MAX_LINE_SIZE
				. "-byte PIPE_BUF cap); replay it via 'wp nodes ingest --void_warranty' instead";
		}
		$target->fill( $message );
		$target->flush();
		return "ok: requeued {$locator} ({$size} bytes) into the source";
	}

	/**
	 * Delete every dead-letter segment (.log + its .idx), then refresh the warm segment
	 * cache. Convenience only — the DLQ is count-rotated (DEADLETTER_MAX_SEGMENTS), so
	 * quarantine can never grow unbounded and purge is never required for correctness.
	 */
	public function purge_deadletter(): string {
		$deadletter = $this->ensure_deadletter();
		if ( null === $deadletter ) {
			return 'error: no dead-letter queue configured';
		}
		$removed  = 0;
		$segments = $deadletter->get_segments( true );
		foreach ( $segments as $s ) {
			$log = $deadletter->get_segment_path( $s['id'] );
			$idx = \substr( $log, 0, -4 ) . '.idx'; // {seg}.log → {seg}.idx.
			// DLQ segment dir is base_dir-relative — not WP-managed.
			// phpcs:disable WordPressVIPMinimum.Functions.RestrictedFunctions.file_ops_unlink
			if ( @\unlink( $log ) ) {
				++$removed;
			}
			@\unlink( $idx );
			// phpcs:enable
		}
		$deadletter->get_segments( true ); // Re-scan so the warm cache reflects the purge.
		// "X of Y" surfaces a failed unlink instead of hiding it.
		return \sprintf( 'ok: purged %d of %d dead-letter segment(s)', $removed, \count( $segments ) );
	}

	/**
	 * Parse a `segment:offset:length` sidecar locator into `[segment, offset, length]`,
	 * or null when it isn't three non-negative integers.
	 *
	 * @return array{0:int,1:int,2:int}|null
	 */
	private function parse_deadletter_locator( string $locator ): ?array {
		$parts = \explode( ':', $locator );
		if ( 3 !== \count( $parts ) ) {
			return null;
		}
		foreach ( $parts as $part ) {
			if ( '' === $part || ! \ctype_digit( $part ) ) {
				return null;
			}
		}
		return [ (int) $parts[0], (int) $parts[1], (int) $parts[2] ];
	}

	/**
	 * One cheap dump_metadata field so a UI can badge the DLQ: the sidecar segment count
	 * from the warm cache. The DLQ is void_warranty (single-writer), so get_segments
	 * serves the cache with no scandir once warm; an empty/absent dir short-circuits
	 * before any scan. The using node merges this into dump_metadata().
	 *
	 * @return array{deadletter_segments:int}
	 */
	protected function deadletter_metadata(): array {
		return [ 'deadletter_segments' => null === $this->deadletter ? 0 : \count( $this->deadletter->get_segments() ) ];
	}

	/**
	 * Fair-shot accounting for a cooperative stop ([42]): stamp this strike's reason
	 * and the streak start (kept from the first crash, not reset), then report whether
	 * the cooperative-stop budget is spent. True → the caller quarantines + advances;
	 * false → the caller records the strike at the unchanged cursor so the respawn
	 * boots on it again and climbs.
	 */
	protected function record_poison_strike( string $reason ): bool {
		$this->poison_reason = $reason;
		if ( null === $this->first_crash_ts ) {
			$this->first_crash_ts = Core::$now;
		}
		return $this->attempts >= self::COOP_MAX_ATTEMPTS;
	}

	/**
	 * Apply a restored offsetlog frame's attempt accounting to this process ([42]):
	 * resume at attempts+1 (a graceful handoff stamped 0 → virgin 1; a crash/strike
	 * left ≥1 → climbs), carry first_crash_ts forward, and detect a hard-crash lineage
	 * — NO reason stamped (an uncatchable death, not a caught throw) that has exhausted
	 * the crash budget — by entering crawl with attempts pinned at the threshold.
	 *
	 * Shared by Consumer (load_offsetlog) and Remote_Source (restore_position). The
	 * using class layers its own crawl-entry side effects on the returned flag (Consumer
	 * arms its boot-head sacrifice); poison_reason is left to the live strike path.
	 *
	 * @param array<array-key, mixed> $entry The restored frame VALUE.
	 * @return bool True when this restore entered crawl (a hard-crash lineage).
	 */
	protected function resume_attempts_from_frame( array $entry ): bool {
		$prior          = $entry['attempts'] ?? 0;
		$prior_attempts = Core::num_int( $prior );
		$reason         = Core::as_string( $entry['reason'] ?? '' );
		$this->attempts = $prior_attempts + 1;
		$entered_crawl  = false;
		if ( '' === $reason && $this->attempts >= self::CRASH_MAX_ATTEMPTS ) {
			$this->attempts = self::CRASH_MAX_ATTEMPTS;
			$this->enter_crawl();
			$entered_crawl  = true;
		}
		if ( $this->attempts > 1 ) {
			$prior_ts             = $entry['first_crash_ts'] ?? null;
			$this->first_crash_ts = Core::num_float( $prior_ts, Core::$now );
		}
		return $entered_crawl;
	}

	/**
	 * Arm the boot-time head skip from a restored frame, choosing its disposition. A quarantine
	 * marker (`quarantined => true`) arms a silent DROP — the head is already in the DLQ. Otherwise
	 * a hard-crash lineage (via resume_attempts_from_frame) arms the DLQ 'crash' sacrifice. A frame
	 * can be both (a post-crash-sacrifice marker keeps the crawl lineage AND carries the marker);
	 * the marker's DROP wins so the already-quarantined head isn't re-dead-lettered, while crawl
	 * still continues. resume_attempts_from_frame is ALWAYS called (it seeds attempts/first_crash_ts
	 * even off the crawl path). Shared by Consumer (load_offsetlog) and Remote_Source (restore_position).
	 *
	 * @param array<array-key, mixed> $entry The restored frame VALUE.
	 * @return bool True when the head skip is armed.
	 */
	protected function arm_skip_head_from_frame( array $entry ): bool {
		if ( $this->resume_attempts_from_frame( $entry ) ) {
			$this->crawl_skip_head = true; // Keep default: DLQ sacrifice.
		}
		if ( true === ( $entry['quarantined'] ?? false ) ) {
			$this->crawl_skip_head       = true;
			$this->skip_head_disposition = 'drop';
		}
		return $this->crawl_skip_head;
	}

	/** True once a crawling node has run crash-free for one full checkpoint interval. */
	protected function crawl_interval_elapsed(): bool {
		return $this->crawl && ( Core::$now - $this->crawl_started ) >= self::CHECKPOINT_INTERVAL_S;
	}

	/** Enter crawl: one line per tick with a per-message checkpoint (hard-crash lineage). */
	protected function enter_crawl(): void {
		$this->crawl         = true;
		$this->crawl_started = Core::$now;
	}

	/** Leave crawl at the healthy baseline: the poison region is behind us. */
	protected function exit_crawl(): void {
		$this->crawl          = false;
		$this->crawl_started  = 0.0;
		$this->attempts       = 1;
		$this->first_crash_ts = null;
		$this->poison_reason  = '';
	}

	// --- Triage verbs: dl_list / dl_requeue / dl_purge on {name}:config ---

	/**
	 * The triage verb table, merged into a using node's node_schema()['commands'] so
	 * Consumer and Remote_Source both expose dl_list / dl_requeue / dl_purge on their
	 * {name}:config interpreter (auto-wired by Schema_Reflection — no CI edits).
	 *
	 * @return array<int, array<string, mixed>>
	 */
	public static function deadletter_verbs(): array {
		return [
			[
				'name'        => 'dl_list',
				'description' => 'List quarantined dead-letter records newest-first (reason, attempts, first_crash_ts, quarantine ts, source breadcrumb, sidecar locator). Optional limit (default ' . self::DEADLETTER_LIST_DEFAULT_LIMIT . ').',
				'args'        => [
					[ 'name' => 'limit', 'type' => 'int', 'required' => false ],
				],
				'handler'     => static fn ( Command_Interpreter_Node $interpreter, array $args ): string => self::cmd_dl_list( $interpreter, $args ),
			],
			[
				'name'        => 'dl_requeue',
				'description' => 'Re-inject the dead-letter record at <locator> (segment:offset:length from dl_list) back into the source log this node tails.',
				'args'        => [
					[ 'name' => 'locator', 'type' => 'string', 'required' => true ],
				],
				'handler'     => static fn ( Command_Interpreter_Node $interpreter, array $args ): string => self::cmd_dl_requeue( $interpreter, $args ),
			],
			[
				'name'        => 'dl_purge',
				'description' => 'Delete all dead-letter segments (.log + .idx). Convenience only — the queue is count-rotated, so this is not required for correctness.',
				'args'        => [],
				'handler'     => static fn ( Command_Interpreter_Node $interpreter, array $args ): string => self::cmd_dl_purge( $interpreter ),
			],
		];
	}

	/** The verbs run on a node's own {name}:config; a foreign patron is a wiring bug. */
	private static function deadletter_patron( Command_Interpreter_Node $interpreter ): ?self {
		$patron = $interpreter->patron();
		return $patron instanceof self ? $patron : null;
	}

	/**
	 * `dl_list` verb handler — reply the triage page as JSON.
	 *
	 * @param array<array-key, mixed> $args Optional limit token (default DEADLETTER_LIST_DEFAULT_LIMIT).
	 */
	public static function cmd_dl_list( Command_Interpreter_Node $interpreter, array $args ): string {
		$patron = self::deadletter_patron( $interpreter );
		if ( null === $patron ) {
			return 'error: not a dead-letter node';
		}
		$raw   = Core::as_string( $args[0] ?? '' );
		$limit = '' === $raw ? self::DEADLETTER_LIST_DEFAULT_LIMIT : \max( 1, Core::as_int( $raw ) );
		return (string) \wp_json_encode( $patron->list_deadletter( $limit ) );
	}

	/**
	 * `dl_requeue` verb handler — re-inject one record; reply the ok/error line.
	 *
	 * @param array<array-key, mixed> $args The sidecar locator from dl_list.
	 */
	public static function cmd_dl_requeue( Command_Interpreter_Node $interpreter, array $args ): string {
		$patron = self::deadletter_patron( $interpreter );
		if ( null === $patron ) {
			return 'error: not a dead-letter node';
		}
		return $patron->requeue_deadletter( Core::as_string( $args[0] ?? '' ) );
	}

	/** `dl_purge` verb handler — delete all dead-letter segments; reply the count. */
	public static function cmd_dl_purge( Command_Interpreter_Node $interpreter ): string {
		$patron = self::deadletter_patron( $interpreter );
		if ( null === $patron ) {
			return 'error: not a dead-letter node';
		}
		return $patron->purge_deadletter();
	}
}
