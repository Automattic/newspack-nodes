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
	public const DEADLETTER_NUM_SEGMENTS = 16;

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
	 * Quarantine dir for poison messages (dead-letter [42]); '' = no DLQ (log + drop).
	 * The using node is the sole writer of its DLQ sibling, so it lifts the PIPE_BUF cap.
	 */
	protected string $deadletter_dir = '';

	/** Null when $deadletter_dir is empty — poison is logged and dropped instead of quarantined. */
	protected ?Partition_Node $deadletter = null;

	/**
	 * Build + register the `:deadletter` sibling Partition once (idempotent). Empty
	 * dir → null (log + drop). The using node asserts it's the sole writer, so the
	 * 4 KB PIPE_BUF cap is lifted (void_warranty) — a poison message can exceed it.
	 *
	 * @param string $dir  Quarantine segment directory. Empty → null.
	 * @param string $name Node name for the partition; '' leaves it unnamed (named later).
	 */
	protected function ensure_deadletter( string $dir, string $name ): ?Partition_Node {
		if ( null !== $this->deadletter ) {
			return $this->deadletter;
		}
		if ( '' === $dir ) {
			return null;
		}
		$deadletter = new Partition_Node();
		if ( '' !== $name ) {
			$deadletter->name( $name );
		}
		$deadletter->patron( $this );
		$deadletter->arguments( \implode( ' ', [ $dir, self::DEADLETTER_SEGMENT_SIZE, self::DEADLETTER_NUM_SEGMENTS ] ) );
		$deadletter->void_warranty();
		$this->deadletter = $deadletter;
		return $deadletter;
	}

	/**
	 * Build the Message to quarantine from a raw source line: the real unpacked
	 * message when it parses (so `wp nodes ingest` can replay it), else the raw bytes
	 * wrapped in a TM_BYTESTREAM for inspection. Stamps the source seg:off breadcrumb.
	 *
	 * @return array<int, mixed>
	 */
	protected function poison_from_line( string $line, int $seg, int $abs_offset ): array {
		try {
			$message = Message::unpacked( $line );
		} catch ( \InvalidArgumentException $e ) {
			$message                   = Message::new_message();
			$message[ Message::TYPE ]  = Message::TM_BYTESTREAM;
			$message[ Message::VALUE ] = $line;
		}
		$message[ Message::ID ] = "{$seg}:{$abs_offset}";
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
			try {
				$this->deadletter->fill( $message );
				$this->deadletter->flush();
				$outcome = 'quarantined';
			} catch ( Worker_Should_Stop $e ) {
				throw $e; // A stop during the DLQ write still escapes; poison re-quarantines on respawn.
			} catch ( \Throwable $e ) {
				// Quarantine itself failed (disk full / I/O). Drop the poison and let the
				// cursor advance — re-wedging here would loop the source forever.
				$outcome = 'DROP — deadletter write failed: ' . $e->getMessage();
			}
		}
		$this->print_less_often( "DEAD-LETTER [{$reason}] {$this->name} at {$where} — {$outcome}{$why}" );
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
		$prior_attempts = \is_numeric( $prior ) ? (int) $prior : 0;
		$reason         = Core::as_string( $entry['reason'] ?? '' );
		$this->attempts = $prior_attempts + 1;
		$entered_crawl  = false;
		if ( '' === $reason && $this->attempts >= self::CRASH_MAX_ATTEMPTS ) {
			$this->attempts      = self::CRASH_MAX_ATTEMPTS;
			$this->crawl         = true;
			$this->crawl_started = Core::$now;
			$entered_crawl       = true;
		}
		if ( $this->attempts > 1 ) {
			$prior_ts             = $entry['first_crash_ts'] ?? null;
			$this->first_crash_ts = \is_numeric( $prior_ts ) ? (float) $prior_ts : Core::$now;
		}
		return $entered_crawl;
	}

	/** True once a crawling node has run crash-free for one full checkpoint interval. */
	protected function crawl_interval_elapsed(): bool {
		return $this->crawl && ( Core::$now - $this->crawl_started ) >= self::CHECKPOINT_INTERVAL_S;
	}

	/** Leave crawl at the healthy baseline: the poison region is behind us. */
	protected function exit_crawl(): void {
		$this->crawl          = false;
		$this->crawl_started  = 0.0;
		$this->attempts       = 1;
		$this->first_crash_ts = null;
		$this->poison_reason  = '';
	}
}
