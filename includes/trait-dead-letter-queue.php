<?php
/**
 * Dead_Letter_Queue: quarantine plus fair-shot attempt accounting (dead-letter [42]).
 *
 * This trait carries the reusable half of ADR-12: the `:deadletter` sibling Partition
 * and its triage index, the `dead_letter()` writer, the wrap that turns a raw source
 * line back into a replayable Message (`poison_from_line`), the attempt accounting a
 * respawn resumes (`resume_attempts_from_frame` and `record_poison_strike`), crawl
 * mode, and the `dl_*` triage verbs. What DECIDES when to call any of it — the buffer,
 * the cursor and its advance — belongs to `Durable_Reader`, so no reader can adopt the
 * quarantine and forget the accounting.
 *
 * Three classes use it, in two shapes. `Durable_Reader` mixes it into Consumer_Node
 * and Remote_Source_Node, which both carry a durable cursor and use every piece.
 * Partition_Node uses it for a case with no cursor at all: a short write or a
 * failed segment open quarantines the messages that never landed, so the attempt
 * fields stay at their baseline there and `requeue_deadletter()` is overridden into
 * a refusal.
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes;

\defined( 'ABSPATH' ) || exit;

/**
 * Dead-letter mixin: what a using class owes, and what it gets back.
 *
 * The class must be a `Node`, because the quarantine is a patron-owned sibling built
 * through `Sidecar`, reported through `print_less_often()` and redelivered to `sink`.
 * It supplies the directory, by assigning `$deadletter_dir` or by overriding
 * `deadletter_dir()`, and calls `ensure_deadletter()` before the first quarantine:
 * `dead_letter()` writes to the sibling that call built and never builds one, so a
 * class that skips it reports a configured quarantine as absent.
 *
 * In return it gets the quarantine and its triage index, the `dead_letter()` writer,
 * the attempt accounting a respawn resumes, and crawl mode. Two surfaces stay opt-in
 * because they belong to the using class's own schema: merge `deadletter_verbs()` into
 * `node_schema()['commands']` for the `dl_*` triage verbs, and `deadletter_metadata()`
 * into `dump_metadata()` for the badge count. `deadletter_sole_writer()` and
 * `requeue_deadletter()` are the seams a class with another writer, or another
 * downstream, overrides.
 */
trait Dead_Letter_Queue {
	use Sidecar;

	/**
	 * Hard-crash threshold: after this many respawns at one cursor with NO reason
	 * stamped (an uncatchable death — OOM/fatal/SIGKILL — not a caught throw), the
	 * worker enters crawl mode to isolate the poison one message at a time.
	 */
	public const CRASH_MAX_ATTEMPTS = 5;

	/**
	 * Cooperative-stop threshold: after this many fair-shot strikes (full worker
	 * lifetimes spent on the boot-cursor message under a timeout or memory stop), the
	 * message is dead-lettered and the cursor advances. Lower than the hard-crash
	 * budget because a cooperative stop names its reason, so fewer mulligans buy the
	 * same confidence.
	 */
	public const COOP_MAX_ATTEMPTS = 2;

	/**
	 * Crawl cadence: the forward-progress window a crawling node must survive
	 * crash-free before it leaves crawl and returns to coarse checkpointing. It is
	 * also the coarse cursor-checkpoint interval both readers throttle to, so the two
	 * crawl shapes — Consumer per-line, Remote_Source per-relayed-message — agree on
	 * the exit window.
	 */
	public const CHECKPOINT_INTERVAL_S = 30;

	/** Rotate a quarantine segment at 1 MiB, so one segment holds many poison records. */
	public const DEADLETTER_SEGMENT_SIZE = 1048576;

	/** Floor for Partition's age rule. Inert here, since the age rule is off. */
	public const DEADLETTER_MIN_SEGMENTS = 2;

	/** Count rule: prune the oldest segments back to sixteen. */
	public const DEADLETTER_NUM_SEGMENTS = 16;

	/** Floor for the count rule, in seconds. Zero protects no segment from it. */
	public const DEADLETTER_MIN_LIFETIME = 0;

	/**
	 * Age rule off: quarantine ages out by COUNT, never by clock. A record that sat
	 * all weekend is exactly the one an operator comes back for.
	 */
	public const DEADLETTER_LIFETIME     = 0;

	/** Hard cap, pruned unconditionally: the quarantine cannot grow past 32 segments. */
	public const DEADLETTER_MAX_SEGMENTS = 32;

	/** Newest-first page size for the `dl_list` triage verb when no limit is given. */
	public const DEADLETTER_LIST_DEFAULT_LIMIT = 50;

	/**
	 * Times the message at the boot cursor has been attempted without advancing past
	 * it. One is the healthy baseline (a running checkpoint); zero is a
	 * graceful-shutdown handoff at a genuinely un-attempted cursor. A respawn reads
	 * the frame's value and resumes at attempts+1, so only a stuck cursor climbs.
	 */
	protected int $attempts = 1;

	/**
	 * Why the prior process stopped at this cursor. Empty means nothing stamped it —
	 * an uncatchable death, the signature that drives crawl-mode isolation; anything
	 * else is a cooperative-stop reason (`timeout` or `memory`) stamped at shutdown.
	 * A respawn reads it to tell the two apart.
	 */
	protected string $poison_reason = '';

	/**
	 * Wall-clock of the first crash in the current stuck streak (null when healthy),
	 * carried forward across respawns.
	 */
	protected ?float $first_crash_ts = null;

	/**
	 * Hard-crash crawl mode: the node respawned into an uncatchable-death lineage and
	 * now checkpoints per message to pin the exact culprit on a re-crash. Surviving
	 * CHECKPOINT_INTERVAL_S of forward progress leaves it.
	 */
	protected bool $crawl = false;

	/** Wall-clock this process entered crawl; surviving CHECKPOINT_INTERVAL_S past it exits crawl. */
	protected float $crawl_started = 0.0;

	/**
	 * Quarantine directory for poison messages. Empty disables the DLQ, and poison is
	 * reported and dropped instead of stored.
	 */
	protected string $deadletter_dir = '';

	/**
	 * The quarantine Partition, or null — either because no directory is configured,
	 * in which case poison is reported and dropped, or because `ensure_deadletter()`
	 * has not run yet.
	 */
	protected ?Partition_Node $deadletter = null;

	/**
	 * Reason staged for the companion-index callback right before a `:deadletter` fill.
	 * `dead_letter()` sets it and clears it in the same `finally`. It is a property
	 * rather than a parameter because Partition hands its index formatter the message
	 * and the position only, and the callback is bound to `$this`.
	 */
	protected string $deadletter_reason = '';

	/**
	 * Where the quarantine lives; empty disables it. The trait never computes this: a
	 * reader takes it as a positional argument, Partition derives it from the directory
	 * whose write stalled, and an override can answer differently again.
	 */
	protected function deadletter_dir(): string {
		return $this->deadletter_dir;
	}

	/**
	 * Whether this node is the ONLY writer of its quarantine (readers are; a
	 * multi-writer Partition's shared write-quarantine is not). True lifts the
	 * sidecar's PIPE_BUF cap via void_warranty (lockless rotation) — safe only
	 * for a sole writer.
	 *
	 * @return bool True when nothing else writes this quarantine.
	 */
	protected function deadletter_sole_writer(): bool {
		return true;
	}

	/**
	 * Build the quarantine Partition for the CONFIGURED dir and publish it into the
	 * `deadletter` slot. Idempotent on the dir rather than on the property, for the
	 * reason `ensure_offsetlog()` is: `arguments()` is a replay setter, so an incumbent
	 * built for a directory the arguments have since superseded would go on
	 * quarantining where nobody triages.
	 *
	 * @return Partition_Node|null The sidecar, or null when no directory is configured.
	 */
	protected function ensure_deadletter(): ?Partition_Node {
		$dir = \rtrim( $this->deadletter_dir(), '/' );
		if ( null !== $this->deadletter && $dir === $this->deadletter->partition_dir() ) {
			return $this->deadletter;
		}
		$this->retract_sibling( 'deadletter' );
		$this->deadletter = null;
		if ( '' === $dir ) {
			return null;
		}
		// All five axes explicit; an omitted one inherits <config:*> forever.
		$deadletter = $this->make_sidecar( $dir, [
			self::DEADLETTER_SEGMENT_SIZE,
			self::DEADLETTER_MIN_SEGMENTS,
			self::DEADLETTER_NUM_SEGMENTS,
			self::DEADLETTER_MAX_SEGMENTS,
			self::DEADLETTER_MIN_LIFETIME,
			self::DEADLETTER_LIFETIME,
		] );
		// Sole writer: the cap lifts so poison over PIPE_BUF still quarantines.
		if ( $this->deadletter_sole_writer() ) {
			$deadletter->void_warranty();
		}
		// Triage metadata rides in .idx; ingest replays only .log (verbatim).
		$deadletter->with_index( $this->deadletter_index_row( ... ) );
		$this->publish_sibling( 'deadletter', $deadletter );
		$this->deadletter = $deadletter;
		return $deadletter;
	}

	/**
	 * Build the Message to quarantine from a raw source line: the real unpacked message
	 * when it parses, so `wp nodes ingest` can replay it, else the raw bytes wrapped in
	 * a TM_BYTESTREAM so an operator can still read what arrived. Either way ID carries
	 * the `segment:offset:length` breadcrumb of where the line came from, which the .idx
	 * row reports as `source`; the length counts the newline the reader consumed with it.
	 *
	 * @param string $line    The raw line, without its trailing newline.
	 * @param int    $segment Source segment the line was read from.
	 * @param int    $offset  Byte offset of the line within that segment.
	 * @return array<int,mixed> The Message to quarantine, positional.
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
	 * Quarantine a poison message: write the replayable original to the `:deadletter`
	 * sibling when one is configured, else report and drop. The give-up goes out
	 * through `print_less_often`, which reaches `error_log` via `Core::stderr` and
	 * collapses a burst to one line per reason per node. A `Worker_Should_Stop` escapes
	 * the write's broad catch (ADR-14) with nothing committed, so the respawn
	 * re-quarantines; any other write failure drops and says so, because a source that
	 * retries the quarantine forever is the wedge this exists to prevent. A reader
	 * advances its cursor past the message either way.
	 *
	 * Replay is `wp nodes ingest <topic> <deadletter-segment>`, which re-`fill()`s each
	 * stored message verbatim — so the entry is the original message, not a wrapper.
	 *
	 * @param array<int,mixed> $message The poison Message (positional).
	 * @param string           $reason  Why it is being quarantined; rides in the .idx row
	 *                                  and heads the reported line.
	 * @param \Throwable|null  $error   The throw that condemned it, when there was one.
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
	 * @param array<int,mixed>  $message  The quarantined Message.
	 * @param array<string,int> $position Its {segment,offset,length} in the sidecar.
	 * @return string One JSON object, the .idx line for this record.
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
	 * List quarantined records newest-first, capped at $limit. Each row is the .idx
	 * triage metadata (reason, attempts, first_crash_ts, quarantine ts, source
	 * breadcrumb, sidecar locator). `total` counts ALL indexed records — the badge
	 * number — not the returned page. `unindexed_segments` counts .log segments with no
	 * .idx companion, quarantined by a writer that wrote no index: they stay out of
	 * `rows`, remain replayable via `wp nodes ingest`, and rotate out within
	 * DEADLETTER_NUM_SEGMENTS. The queue is count-bounded, so the full .idx pass behind
	 * the totals stays cheap.
	 *
	 * @param int $limit Rows to return; the walk still visits every record for the totals.
	 * @return array{rows: array<int,mixed>, total: int, unindexed_segments: int}
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
	 * Redeliver the dead-letter record at $locator (the `locator` field from
	 * list_deadletter, its SIDECAR position) to this node's sink, byte-verbatim as
	 * quarantined. The DLQ copy is left in place, so a redelivery that dies mid-flight
	 * costs nothing — press the button again.
	 *
	 * It delivers rather than re-injecting into the source log because a reader is
	 * never that log's writer. Appending from here would put a SECOND writer on a
	 * partition whose real one may have asserted sole-writership (`void_warranty`)
	 * and skipped the write lock; once any writer exceeds PIPE_BUF the kernel may
	 * split its record, and a foreign append of ANY size can land inside the gap.
	 * Delivering also spares the log's other tailers a record only this node failed.
	 *
	 * @param string $locator `segment:offset:length` in the sidecar, from dl_list.
	 * @return string The `ok:` or `error:` line the verb replies.
	 */
	public function requeue_deadletter( string $locator ): string {
		$deadletter = $this->ensure_deadletter();
		if ( null === $deadletter ) {
			return "error: no dead-letter queue configured\n";
		}
		if ( null === $this->sink ) {
			return "error: requeue unavailable — this node has no sink to deliver into\n";
		}
		$loc = $this->parse_deadletter_locator( $locator );
		if ( null === $loc ) {
			return "error: malformed locator '{$locator}' — want segment:offset:length from dl_list\n";
		}
		[ $segment, $offset, $length ] = $loc;
		$message = $deadletter->read_message_at( $segment, $offset, $length );
		if ( null === $message ) {
			return "error: no dead-letter record at {$locator}\n";
		}
		// Address it as forward_line does; Router, not the sink, delivers.
		if ( \is_string( $this->target ) && '' !== $this->target ) {
			$message[ Message::TO ] = $this->target;
		}
		// Let a re-throw escape: only a raise stamps TM_ERROR for the UI.
		$size = Message::packed_size( $message );
		$this->sink->fill( $message );
		return "ok: redelivered {$locator} ({$size} bytes) to the sink\n";
	}

	/**
	 * Decode the dead-letter record at $locator into named envelope fields for the
	 * triage UI and the REPL — JSON `{ type, type_flags, timestamp, from, to, id, key,
	 * value, size }`. Read-only sibling of requeue_deadletter: same locator grammar,
	 * same sidecar read, no side effects.
	 *
	 * @param string $locator `segment:offset:length` in the sidecar, from dl_list.
	 * @return string The JSON object, or an `error:` line.
	 */
	public function show_deadletter( string $locator ): string {
		$deadletter = $this->ensure_deadletter();
		if ( null === $deadletter ) {
			return "error: no dead-letter queue configured\n";
		}
		$loc = $this->parse_deadletter_locator( $locator );
		if ( null === $loc ) {
			return "error: malformed locator '{$locator}' — want segment:offset:length from dl_list\n";
		}
		[ $segment, $offset, $length ] = $loc;
		$message = $deadletter->read_message_at( $segment, $offset, $length );
		if ( null === $message ) {
			return "error: no dead-letter record at {$locator}\n";
		}
		$type = Core::as_int( $message[ Message::TYPE ] ?? 0 );
		return (string) \wp_json_encode( [
			'type'       => $type,
			'type_flags' => Dumper_Node::format_type_flags( $type ),
			'timestamp'  => $message[ Message::TIMESTAMP ] ?? 0,
			'from'       => Core::as_string( $message[ Message::FROM ] ?? '' ),
			'to'         => Core::as_string( $message[ Message::TO ] ?? '' ),
			'id'         => Core::as_string( $message[ Message::ID ] ?? '' ),
			'key'        => Core::as_string( $message[ Message::KEY ] ?? '' ),
			'value'      => $message[ Message::VALUE ] ?? null,
			'size'       => Message::packed_size( $message ),
		] );
	}

	/**
	 * Delete every dead-letter segment and its .idx companion, then refresh the warm
	 * segment cache. Convenience only — the queue is count-rotated
	 * (DEADLETTER_NUM_SEGMENTS), so quarantine cannot grow unbounded and a purge is
	 * never required for correctness.
	 *
	 * @return string The `ok:` count line, or an `error:` line when no DLQ is configured.
	 */
	public function purge_deadletter(): string {
		$deadletter = $this->ensure_deadletter();
		if ( null === $deadletter ) {
			return "error: no dead-letter queue configured\n";
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
		return \sprintf( "ok: purged %d of %d dead-letter segment(s)\n", $removed, \count( $segments ) );
	}

	/**
	 * Parse a `segment:offset:length` sidecar locator into `[segment, offset, length]`,
	 * or null when it isn't three non-negative integers. It refuses rather than coerces
	 * because an operator pastes this token, and a coerced `abc` reads segment 0 — a
	 * different record, redelivered without complaint.
	 *
	 * @param string $locator The locator as typed or pasted.
	 * @return array{0:int,1:int,2:int}|null Null when the token is malformed.
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
	 * One cheap dump_metadata field so a UI can badge the DLQ: the sidecar's segment
	 * count. A sole-writer sidecar is void_warranty, so get_segments() serves the warm
	 * cache with no scandir, and an unbuilt DLQ short-circuits before any filesystem
	 * call at all. The using node merges this into its own dump_metadata().
	 *
	 * @return array{deadletter_segments:int}
	 */
	protected function deadletter_metadata(): array {
		return [ 'deadletter_segments' => null === $this->deadletter ? 0 : \count( $this->deadletter->get_segments() ) ];
	}

	/**
	 * Fair-shot accounting for a cooperative stop: stamp this strike's reason and the
	 * streak start (kept from the first crash, never reset), then report whether the
	 * cooperative-stop budget is spent. True means the caller quarantines the message
	 * and advances past it; false means the caller records the strike at the unchanged
	 * cursor, so the respawn boots on the same message and the count climbs.
	 *
	 * @param string $reason The stop that produced the strike: 'timeout' or 'memory'.
	 * @return bool True when the attempt count has reached COOP_MAX_ATTEMPTS.
	 */
	protected function record_poison_strike( string $reason ): bool {
		$this->poison_reason = $reason;
		if ( null === $this->first_crash_ts ) {
			$this->first_crash_ts = Core::$now;
		}
		return $this->attempts >= self::COOP_MAX_ATTEMPTS;
	}

	/**
	 * Apply a restored offsetlog frame's attempt accounting to this process: resume at
	 * attempts+1, so a graceful handoff stamped 0 resumes as a virgin 1 while a crash or
	 * a strike left at least 1 and climbs; carry first_crash_ts forward; and detect a
	 * hard-crash lineage — no reason stamped, meaning an uncatchable death rather than a
	 * caught throw, with the crash budget exhausted — by entering crawl with attempts
	 * pinned at the threshold.
	 *
	 * `Durable_Reader::arm_skip_head_from_frame()` is the only caller, reached when
	 * Consumer loads its offsetlog and when Remote_Source restores its position; it arms
	 * the boot-head sacrifice on the returned flag. poison_reason stays empty here —
	 * only the live strike path stamps one.
	 *
	 * @param array<array-key,mixed> $entry The restored frame VALUE.
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
		$this->crawl         = false;
		$this->crawl_started = 0.0;
		$this->reset_poison_streak();
	}

	/** Back to a virgin first attempt: forward progress cleared the streak. */
	protected function reset_poison_streak(): void {
		$this->attempts       = 1;
		$this->first_crash_ts = null;
		$this->poison_reason  = '';
	}

	/**
	 * The triage verb table, merged into a using node's `node_schema()['commands']` so
	 * Consumer and Remote_Source both expose dl_list, dl_show, dl_requeue and dl_purge
	 * on their `{name}:config` interpreter (auto-wired by Schema_Reflection — no CI
	 * edits). Every verb is hidden because the Inspector's Triage modal drives them:
	 * dl_show and dl_requeue need a sidecar locator only its listing supplies, so a
	 * generic verb button would offer an operator a field they cannot fill.
	 *
	 * The handlers RETURN their `error:` lines instead of throwing. A refusal throws
	 * everywhere else in the substrate; these are values the modal renders beside the
	 * row that produced them, not failed commands.
	 *
	 * @return array<int,array<string,mixed>>
	 */
	public static function deadletter_verbs(): array {
		return [
			[
				'name'        => 'dl_list',
				'description' => 'List quarantined dead-letter records newest-first (reason, attempts, first_crash_ts, quarantine ts, source breadcrumb, sidecar locator). Optional limit (default ' . self::DEADLETTER_LIST_DEFAULT_LIMIT . ').',
				'hidden'      => true,
				'args'        => [
					[ 'name' => 'limit', 'type' => 'int', 'required' => false ],
				],
				'handler'     => static fn ( Command_Interpreter_Node $interpreter, array $args ): string => self::cmd_dl_list( $interpreter, $args ),
			],
			[
				'name'        => 'dl_show',
				'description' => 'Decode the dead-letter record at <locator> (segment:offset:length from dl_list) — envelope fields + VALUE, read-only.',
				'hidden'      => true,
				'args'        => [
					[ 'name' => 'locator', 'type' => 'string', 'required' => true ],
				],
				'handler'     => static fn ( Command_Interpreter_Node $interpreter, array $args ): string => self::cmd_dl_show( $interpreter, $args ),
			],
			[
				'name'        => 'dl_requeue',
				'description' => 'Redeliver the dead-letter record at <locator> (segment:offset:length from dl_list) to this node\'s sink; the queued copy stays put.',
				'hidden'      => true,
				'args'        => [
					[ 'name' => 'locator', 'type' => 'string', 'required' => true ],
				],
				'handler'     => static fn ( Command_Interpreter_Node $interpreter, array $args ): string => self::cmd_dl_requeue( $interpreter, $args ),
			],
			[
				'name'        => 'dl_purge',
				'description' => 'Delete all dead-letter segments (.log + .idx). Convenience only — the queue is count-rotated, so this is not required for correctness.',
				'hidden'      => true,
				'args'        => [],
				'handler'     => static fn ( Command_Interpreter_Node $interpreter, array $args ): string => self::cmd_dl_purge( $interpreter ),
			],
		];
	}

	/**
	 * The node behind a `{name}:config` interpreter, when it is one using this trait.
	 * The verbs run on a node's own interpreter, so a foreign patron is a wiring bug;
	 * null lets each handler answer with an error line rather than fatal on a method
	 * the patron does not have.
	 *
	 * @param Command_Interpreter_Node $interpreter The interpreter dispatching the verb.
	 * @return self|null The using node, or null when the patron is something else.
	 */
	private static function deadletter_patron( Command_Interpreter_Node $interpreter ): ?self {
		$patron = $interpreter->patron();
		return $patron instanceof self ? $patron : null;
	}

	/**
	 * `dl_list` verb handler — reply the triage page as JSON.
	 *
	 * @param Command_Interpreter_Node $interpreter The `{name}:config` interpreter.
	 * @param array<array-key,mixed>   $args        Optional limit token; absent takes
	 *                                              DEADLETTER_LIST_DEFAULT_LIMIT and a
	 *                                              non-positive one clamps to 1.
	 * @return string The JSON page, or an `error:` line.
	 */
	public static function cmd_dl_list( Command_Interpreter_Node $interpreter, array $args ): string {
		$patron = self::deadletter_patron( $interpreter );
		if ( null === $patron ) {
			return "error: not a dead-letter node\n";
		}
		$raw   = Core::as_string( $args[0] ?? '' );
		$limit = '' === $raw ? self::DEADLETTER_LIST_DEFAULT_LIMIT : \max( 1, Core::as_int( $raw ) );
		return (string) \wp_json_encode( $patron->list_deadletter( $limit ) );
	}

	/**
	 * `dl_show` verb handler — decode one record; reply JSON or an error line.
	 *
	 * @param Command_Interpreter_Node $interpreter The `{name}:config` interpreter.
	 * @param array<array-key,mixed>   $args        The sidecar locator from dl_list.
	 * @return string The decoded record as JSON, or an `error:` line.
	 */
	public static function cmd_dl_show( Command_Interpreter_Node $interpreter, array $args ): string {
		$patron = self::deadletter_patron( $interpreter );
		if ( null === $patron ) {
			return "error: not a dead-letter node\n";
		}
		return $patron->show_deadletter( Core::as_string( $args[0] ?? '' ) );
	}

	/**
	 * `dl_requeue` verb handler — redeliver one record; reply the ok/error line.
	 *
	 * @param Command_Interpreter_Node $interpreter The `{name}:config` interpreter.
	 * @param array<array-key,mixed>   $args        The sidecar locator from dl_list.
	 * @return string The `ok:` or `error:` line.
	 */
	public static function cmd_dl_requeue( Command_Interpreter_Node $interpreter, array $args ): string {
		$patron = self::deadletter_patron( $interpreter );
		if ( null === $patron ) {
			return "error: not a dead-letter node\n";
		}
		return $patron->requeue_deadletter( Core::as_string( $args[0] ?? '' ) );
	}

	/**
	 * `dl_purge` verb handler — delete all dead-letter segments; reply the count.
	 *
	 * @param Command_Interpreter_Node $interpreter The `{name}:config` interpreter.
	 * @return string The `ok:` count line, or an `error:` line.
	 */
	public static function cmd_dl_purge( Command_Interpreter_Node $interpreter ): string {
		$patron = self::deadletter_patron( $interpreter );
		if ( null === $patron ) {
			return "error: not a dead-letter node\n";
		}
		return $patron->purge_deadletter();
	}
}
