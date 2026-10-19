<?php
/**
 * Dead_Letter_Queue: quarantine plus fair-shot attempt accounting.
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
 * and Remote_Consumer_Node, which both carry a durable cursor and use every piece.
 * Partition_Node uses it for a case with no cursor at all: a failed segment open
 * quarantines the messages that never landed before the flush raises, so the attempt
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
 * through `Sidecar`, reported through `stderr()` and redelivered to `sink`.
 * It supplies the directory by assigning `$deadletter_dir`, and calls
 * `ensure_deadletter()` before the first quarantine: `dead_letter()` writes to the
 * sibling that call built and never builds one, so a class that skips it reports a
 * configured quarantine as absent.
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
	 * crawl shapes — Consumer per-line, Remote_Consumer per-relayed-message — agree on
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

	/** Status of a record no tombstone names: what `dl_list`'s total counts. */
	public const DEADLETTER_QUARANTINED = 'quarantined';

	/** Tombstone status: a requeue delivered the record and its sink returned. */
	public const DEADLETTER_REQUEUED = 'requeued';

	/** Tombstone status: an operator removed the record, so `dl_list` omits it. */
	public const DEADLETTER_REMOVED = 'removed';

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
	 * reported and dropped instead of stored. The trait never computes it: a reader
	 * takes it as a positional argument, and Partition derives it from the directory
	 * whose segment would not open.
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
		$dir = \rtrim( $this->deadletter_dir, '/' );
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
		// @longform Sole writer: the cap lifts so poison over PIPE_BUF still
		// quarantines, and only then is an index sound — an .idx row records
		// the offset a record landed at, which on a quarantine peers share is
		// this writer's guess. A shared one loses TRIAGE metadata and nothing
		// else: `wp nodes ingest` replays the .log verbatim either way.
		if ( $this->deadletter_sole_writer() ) {
			$deadletter->void_warranty();
			$deadletter->with_index( $this->deadletter_index_row( ... ) );
		}
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
		$message[ Message::ID ] = Log_Position::format( $segment, $offset, $length );
		return $message;
	}

	/**
	 * Quarantine a poison message: write the replayable original to the `:deadletter`
	 * sibling when one is configured and report it. The report goes out through
	 * `stderr()`, one line per message, so the log names every record to requeue.
	 *
	 * With no quarantine configured, `$error` is the only record of the message, so
	 * it raises: a reader's cursor stays put and the successor replays the message,
	 * wedging loudly on poison until an operator configures a quarantine. A message
	 * condemned with no error — a crash suspect, a fair-shot strike — has nothing to
	 * raise, so it is reported and dropped.
	 *
	 * A message the quarantine would refuse as oversize is reported dropped:
	 * `fill()` returns nothing, so it is asked first, else a refused record
	 * would be reported quarantined.
	 *
	 * A write that fails is not a quarantine, so nothing is reported and the failure
	 * raises through `Worker_Should_Stop::raise()`, combined with `$error`: the error
	 * the quarantine would have recorded escapes beside the one that stopped it. A
	 * reader's cursor stays put, and the successor replays the message; a stop during
	 * the write is a plain stop carrying `$error`, and the replay re-quarantines.
	 *
	 * Replay is `wp nodes ingest <topic> <deadletter-segment>`, which re-`fill()`s each
	 * stored message verbatim — so the entry is the original message, not a wrapper.
	 *
	 * @param array<int,mixed> $message The poison Message (positional).
	 * @param string           $reason  Why it is being quarantined; rides in the .idx row
	 *                                  and heads the reported line.
	 * @param \Throwable|null  $error   The throw that condemned it, when there was one.
	 * @throws \Throwable `$error` when no quarantine is configured; else the failed write, combined with `$error`.
	 */
	protected function dead_letter( array $message, string $reason, ?\Throwable $error = null ): void {
		$where   = Core::as_string( $message[ Message::ID ] ?? '' );
		$why     = null === $error ? '' : ': ' . $error->getMessage();
		$outcome = 'dropped (no deadletter_dir)';
		$quarantine = $this->deadletter;
		if ( null === $quarantine && null !== $error ) {
			throw $error;
		}
		if ( null !== $quarantine && ! $quarantine->takes( $message ) ) {
			$outcome = 'dropped (larger than a record)';
		} elseif ( null !== $quarantine ) {
			// Staged for the .idx callback; cleared in the finally.
			$this->deadletter_reason = $reason;
			try {
				$quarantine->fill( $message );
				$quarantine->flush();
			} catch ( \Throwable $e ) {
				Worker_Should_Stop::raise( null === $error ? [ $e ] : [ $error, $e ] );
			} finally {
				$this->deadletter_reason = '';
			}
			$outcome = 'quarantined';
		}
		$this->stderr( "DEAD-LETTER [{$reason}] {$this->name} at {$where} — {$outcome}{$why}" );
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
			'locator'        => Log_Position::format( $position['segment'], $position['offset'], $position['length'] ),
		] );
	}

	/**
	 * List dead-letter records newest-first, capped at $limit. Each row is the .idx
	 * triage metadata (reason, attempts, first_crash_ts, quarantine ts, source
	 * breadcrumb, sidecar locator) plus its `status`: `quarantined`, or `requeued`
	 * once a requeue's sink returned. A removed record is omitted, and a tombstone
	 * is never a row of its own. `total` counts the indexed records still
	 * quarantined — the badge number — not the returned page. `unindexed_segments`
	 * counts .log segments with no .idx companion, or an empty one, quarantined by a
	 * writer that wrote no index: they stay out of `rows`, remain replayable via
	 * `wp nodes ingest`, and rotate out within DEADLETTER_NUM_SEGMENTS.
	 *
	 * @param int $limit Rows to return; the walk still visits every record for the total.
	 * @return array{rows: array<int,mixed>, total: int, unindexed_segments: int}
	 */
	public function list_deadletter( int $limit ): array {
		$deadletter = $this->ensure_deadletter();
		if ( null === $deadletter ) {
			return [ 'rows' => [], 'total' => 0, 'unindexed_segments' => 0 ];
		}
		return [
			...self::census( $deadletter, $limit ),
			'unindexed_segments' => \count( self::unindexed_segments( $deadletter ) ),
		];
	}

	/**
	 * Records in $deadletter still quarantined: the count `wp nodes doctor` and
	 * Site Health report. An indexed record counts until a requeue or removal
	 * tombstone settles it, as `dl_list`'s `total` counts, and every line of an
	 * unindexed segment counts, since nothing addresses those records to settle
	 * them. It reads every .idx row and every unindexed segment, so the cost is
	 * the queue's size, which DEADLETTER_MAX_SEGMENTS bounds.
	 *
	 * @param Partition_Node $deadletter The quarantine.
	 * @return int Records no tombstone settled.
	 */
	public static function quarantined_records( Partition_Node $deadletter ): int {
		$records = self::census( $deadletter, 0 )['total'];
		foreach ( self::unindexed_segments( $deadletter ) as $segment ) {
			$path = $deadletter->get_segment_path( $segment );
			// phpcs:ignore WordPressVIPMinimum.Performance.FetchingRemoteData.FileGetContentsUnknown -- A local quarantine segment, rotated at DEADLETTER_SEGMENT_SIZE.
			$records += \substr_count( (string) @\file_get_contents( $path ), "\n" );
		}
		return $records;
	}

	/**
	 * One walk of the index: the first $limit records a removal left, each with
	 * its status, and how many indexed records no tombstone settled.
	 *
	 * @param Partition_Node $deadletter The quarantine.
	 * @param int            $limit      Rows to return; 0 counts alone.
	 * @return array{rows: array<int,mixed>, total: int}
	 */
	private static function census( Partition_Node $deadletter, int $limit ): array {
		$rows  = [];
		$total = 0;
		self::walk_deadletter(
			$deadletter,
			static function ( array $row, string $status ) use ( &$rows, &$total, $limit ): bool {
				if ( self::DEADLETTER_REMOVED === $status ) {
					return true;
				}
				if ( self::DEADLETTER_QUARANTINED === $status ) {
					++$total;
				}
				if ( \count( $rows ) < $limit ) {
					$rows[] = [ ...$row, 'status' => $status ];
				}
				return true;
			}
		);
		return [ 'rows' => $rows, 'total' => $total ];
	}

	/**
	 * Segments no index describes: no .idx companion, or an empty one.
	 *
	 * @param Partition_Node $deadletter The quarantine.
	 * @return list<int> Their ids.
	 */
	private static function unindexed_segments( Partition_Node $deadletter ): array {
		$ids = [];
		foreach ( $deadletter->get_segments() as $s ) {
			// get_handle() creates an .idx before its first line lands.
			$idx = self::deadletter_index_path( $deadletter, $s['id'] );
			\clearstatcache( true, $idx );
			if ( 0 === (int) @\filesize( $idx ) ) {
				$ids[] = $s['id'];
			}
		}
		return $ids;
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
	 * A delivery whose sink returned appends a `requeued` tombstone, so the row
	 * lists as requeued; one that throws appends nothing and the row stays as it
	 * was. A removed record is refused rather than delivered, and so is an
	 * unaddressed one or one whose first hop names no mounted node, which the
	 * Router would drop without a throw. A record dropped deeper in its path
	 * still reads requeued, as does a job no handler is registered for. A
	 * tombstone that cannot be written after the sink took the record leaves the
	 * ok line standing with a warning beside it, because an error would invite a
	 * second delivery.
	 *
	 * @param string $locator `segment:offset:length` in the sidecar, from dl_list.
	 * @return string The `ok:` line the verb replies, with any warning after it.
	 * @throws \RuntimeException When there is no queue, no sink, no such record, no route, or it was removed.
	 */
	public function requeue_deadletter( string $locator ): string {
		$deadletter = $this->require_deadletter();
		if ( null === $this->sink ) {
			throw new \RuntimeException( 'requeue unavailable — this node has no sink to deliver into' );
		}
		$crumb   = self::require_listed( $deadletter, $locator );
		$message = self::deadletter_record( $deadletter, $crumb, $locator );
		// Address it as forward_line does; Router, not the sink, delivers.
		if ( \is_string( $this->target ) && '' !== $this->target ) {
			$message[ Message::TO ] = $this->target;
		}
		$to = Core::as_string( $message[ Message::TO ] );
		if ( '' === $to ) {
			throw new \RuntimeException( \esc_html( "requeue refused — the record at {$locator} has no destination: its TO is empty and this node has no target" ) );
		}
		// The table Router_Node::fill() indexes by the head of TO.
		if ( null === Core::node( \explode( '/', $to, 2 )[0] ) ) {
			throw new \RuntimeException( \esc_html( "requeue refused — no node is mounted to route {$to}" ) );
		}
		// Let a re-throw escape: only a raise stamps TM_ERROR for the UI.
		$size = Message::packed_size( $message );
		$this->sink->fill( $message );
		$ok = "ok: redelivered {$locator} ({$size} bytes) to the sink\n";
		try {
			self::tombstone_deadletter( $deadletter, $locator, self::DEADLETTER_REQUEUED );
		} catch ( Worker_Should_Stop $e ) {
			throw $e;
		} catch ( \Throwable $e ) {
			$this->stderr( "DEAD-LETTER {$this->name} requeued status not recorded at {$locator} — {$e->getMessage()}" );
			return $ok . "warning: requeued status not recorded — {$e->getMessage()}\n";
		}
		return $ok;
	}

	/**
	 * Remove the listed record at $locator, quarantined or requeued, from the
	 * triage list by appending a `removed` tombstone. The record itself stays in
	 * the sidecar until its segment rotates out, so `wp nodes ingest` still
	 * replays it.
	 *
	 * @param string $locator `segment:offset:length` in the sidecar, from dl_list.
	 * @return string The `ok:` line the verb replies.
	 * @throws \RuntimeException When there is no queue, no listed record there, or it was removed.
	 */
	public function remove_deadletter( string $locator ): string {
		$deadletter = $this->require_deadletter();
		self::require_listed( $deadletter, $locator );
		self::tombstone_deadletter( $deadletter, $locator, self::DEADLETTER_REMOVED );
		return "ok: removed {$locator}\n";
	}

	/**
	 * The breadcrumb of the listed record at $locator, refused when it is not
	 * listed: no .idx row names it, or a tombstone removed it. A line that does
	 * not contain the locator is skipped undecoded; the exact compare decides.
	 *
	 * @param Partition_Node $deadletter The sidecar.
	 * @param string         $locator    `segment:offset:length` in the sidecar, from dl_list.
	 * @return array{segment: int, offset: int, length: int} The record's position.
	 * @throws \RuntimeException When the locator is malformed, or names no listed record.
	 */
	private static function require_listed( Partition_Node $deadletter, string $locator ): array {
		$crumb  = self::deadletter_crumb( $locator );
		$status = null;
		self::walk_deadletter(
			$deadletter,
			static function ( array $row, string $found ) use ( $locator, &$status ): bool {
				if ( ( $row['locator'] ?? null ) !== $locator ) {
					return true;
				}
				$status = $found;
				return false;
			},
			$locator
		);
		if ( null === $status ) {
			throw new \RuntimeException( \esc_html( "no dead-letter record at {$locator}" ) );
		}
		if ( self::DEADLETTER_REMOVED === $status ) {
			throw new \RuntimeException( \esc_html( "dead-letter record at {$locator} is already removed" ) );
		}
		return $crumb;
	}

	/**
	 * Walk the sidecar's .idx newest-first, handing $visit each record row with
	 * its status: the one its latest tombstone set — the first met, walking
	 * backwards — or `quarantined` when none did. A tombstone is folded, never
	 * visited, and one whose record rotated out is folded and never read.
	 *
	 * @param Partition_Node                                $deadletter The sidecar.
	 * @param \Closure(array<array-key,mixed>, string): bool $visit      Row and status; false stops the walk.
	 * @param string                                        $needle     Skip, undecoded, a line not containing it.
	 */
	private static function walk_deadletter( Partition_Node $deadletter, \Closure $visit, string $needle = '' ): void {
		$tombstones = [];
		$deadletter->scan_index(
			static function ( string $line ) use ( $visit, $needle, &$tombstones ): bool {
				if ( ! \str_contains( $line, $needle ) ) {
					return true;
				}
				$row = \json_decode( $line, true );
				if ( ! \is_array( $row ) ) {
					return true;
				}
				$locator = Core::as_string( $row['locator'] ?? '' );
				if ( isset( $row['status'] ) ) {
					$tombstones[ $locator ] ??= Core::as_string( $row['status'] );
					return true;
				}
				return $visit( $row, $tombstones[ $locator ] ?? self::DEADLETTER_QUARANTINED );
			},
			true
		);
	}

	/**
	 * Append a tombstone setting the status of the record at $locator. It is an
	 * .idx line with no record behind it, so `wp nodes ingest` never replays it.
	 *
	 * @param Partition_Node $deadletter The sidecar.
	 * @param string         $locator    `segment:offset:length` of the record it names.
	 * @param string         $status     DEADLETTER_REQUEUED or DEADLETTER_REMOVED.
	 */
	private static function tombstone_deadletter( Partition_Node $deadletter, string $locator, string $status ): void {
		$deadletter->append_index(
			(string) \wp_json_encode( [ 'locator' => $locator, 'status' => $status, 'ts' => (int) Core::$now ] )
		);
	}

	/**
	 * Decode the dead-letter record at $locator into named envelope fields for the
	 * triage UI and the REPL — `{ type, type_flags, timestamp, from, to, id, key,
	 * value, size }`. Read-only sibling of requeue_deadletter: same locator grammar,
	 * same sidecar read, no side effects.
	 *
	 * @param string $locator `segment:offset:length` in the sidecar, from dl_list.
	 * @return array{type: int, type_flags: string, timestamp: mixed, from: string, to: string, id: string, key: string, value: mixed, size: int} The record.
	 * @throws \RuntimeException When there is no queue or no such record.
	 */
	public function show_deadletter( string $locator ): array {
		$deadletter = $this->require_deadletter();
		$message    = self::deadletter_record( $deadletter, self::deadletter_crumb( $locator ), $locator );
		$type = Core::as_int( $message[ Message::TYPE ] ?? 0 );
		return [
			'type'       => $type,
			'type_flags' => Dumper_Node::format_type_flags( $type ),
			'timestamp'  => $message[ Message::TIMESTAMP ] ?? 0,
			'from'       => Core::as_string( $message[ Message::FROM ] ?? '' ),
			'to'         => Core::as_string( $message[ Message::TO ] ?? '' ),
			'id'         => Core::as_string( $message[ Message::ID ] ?? '' ),
			'key'        => Core::as_string( $message[ Message::KEY ] ?? '' ),
			'value'      => $message[ Message::VALUE ] ?? null,
			'size'       => Message::packed_size( $message ),
		];
	}

	/**
	 * Delete every dead-letter segment and its .idx companion, then refresh the warm
	 * segment cache. Convenience only — the queue is count-rotated
	 * (DEADLETTER_NUM_SEGMENTS), so quarantine cannot grow unbounded and a purge is
	 * never required for correctness.
	 *
	 * @return string The `ok:` count line.
	 * @throws \RuntimeException When no dead-letter queue is configured.
	 */
	public function purge_deadletter(): string {
		$deadletter = $this->require_deadletter();
		$removed  = 0;
		$segments = $deadletter->get_segments( true );
		foreach ( $segments as $s ) {
			$log = $deadletter->get_segment_path( $s['id'] );
			$idx = self::deadletter_index_path( $deadletter, $s['id'] );
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
	 * The companion index of one dead-letter segment: `{seg}.log` → `{seg}.idx`.
	 *
	 * @param Partition_Node $deadletter The sidecar.
	 * @param int            $segment    Segment id.
	 * @return string The `.idx` path.
	 */
	private static function deadletter_index_path( Partition_Node $deadletter, int $segment ): string {
		return \substr( $deadletter->get_segment_path( $segment ), 0, -4 ) . '.idx';
	}

	/**
	 * The dead-letter sidecar, for a verb that cannot answer without one.
	 *
	 * @return Partition_Node The sidecar.
	 * @throws \RuntimeException When no dead-letter directory is configured.
	 */
	private function require_deadletter(): Partition_Node {
		return $this->ensure_deadletter() ?? throw new \RuntimeException( 'no dead-letter queue configured' );
	}

	/**
	 * Read the quarantined message at a parsed `dl_list` locator.
	 *
	 * @param Partition_Node                                $deadletter The sidecar.
	 * @param array{segment: int, offset: int, length: int} $crumb      The locator, parsed.
	 * @param string                                        $locator    The locator as given, for the refusal.
	 * @return array<int,mixed> The message, positional.
	 * @throws \RuntimeException When no record sits there.
	 */
	private static function deadletter_record( Partition_Node $deadletter, array $crumb, string $locator ): array {
		return $deadletter->read_message_at( $crumb['segment'], $crumb['offset'], $crumb['length'] )
			?? throw new \RuntimeException( \esc_html( "no dead-letter record at {$locator}" ) );
	}

	/**
	 * A `dl_list` locator read as a breadcrumb through `Log_Position::crumb()`.
	 * A malformed locator is refused, never coerced: an operator pastes it, and
	 * a coerced `abc` would act on another record without complaint.
	 *
	 * @param string $locator `segment:offset:length` in the sidecar.
	 * @return array{segment: int, offset: int, length: int} The position.
	 * @throws \RuntimeException When the locator is malformed.
	 */
	private static function deadletter_crumb( string $locator ): array {
		return Log_Position::crumb( $locator )
			?? throw new \RuntimeException( \esc_html( "malformed locator '{$locator}' — want segment:offset:length from dl_list" ) );
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
	 * Consumer loads its offsetlog and when Remote_Consumer restores its position; it arms
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
	 * Consumer and Remote_Consumer both expose dl_list, dl_show, dl_requeue, dl_remove
	 * and dl_purge on their `{name}:config` interpreter (auto-wired by Schema_Reflection — no CI
	 * edits). Every verb is hidden because the Inspector's Triage modal drives them:
	 * dl_show, dl_requeue and dl_remove need a sidecar locator only its listing supplies, so a
	 * generic verb button would offer an operator a field they cannot fill.
	 *
	 * A handler refuses by throwing, like every verb, so the reply is a TM_ERROR the
	 * modal shows in its status line.
	 *
	 * @return array<int,array<string,mixed>>
	 */
	public static function deadletter_verbs(): array {
		return [
			[
				'name'        => 'dl_list',
				'capability'  => Capabilities::READ,
				'description' => 'List dead-letter records newest-first (reason, attempts, first_crash_ts, quarantine ts, source breadcrumb, sidecar locator), each with a status (quarantined or requeued); removed records are omitted, and total counts only records still quarantined. Optional limit (default ' . self::DEADLETTER_LIST_DEFAULT_LIMIT . ').',
				'hidden'      => true,
				'args'        => [
					[ 'name' => 'limit', 'type' => 'int', 'required' => false ],
				],
				'handler'     => static fn ( Command_Interpreter_Node $interpreter, array $args ): array => self::cmd_dl_list( $interpreter, $args ),
			],
			[
				'name'        => 'dl_show',
				'capability'  => Capabilities::READ,
				'description' => 'Decode the dead-letter record at <locator> (segment:offset:length from dl_list) — envelope fields + VALUE, read-only.',
				'hidden'      => true,
				'args'        => [
					[ 'name' => 'locator', 'type' => 'string', 'required' => true ],
				],
				'handler'     => static fn ( Command_Interpreter_Node $interpreter, array $args ): array => self::cmd_dl_show( $interpreter, $args ),
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
				'name'        => 'dl_remove',
				'description' => 'Remove the dead-letter record at <locator> (segment:offset:length from dl_list), quarantined or requeued, from the triage list; the queued copy stays replayable until it rotates out.',
				'hidden'      => true,
				'args'        => [
					[ 'name' => 'locator', 'type' => 'string', 'required' => true ],
				],
				'handler'     => static fn ( Command_Interpreter_Node $interpreter, array $args ): string => self::cmd_dl_remove( $interpreter, $args ),
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
	 * The node behind a `{name}:config` interpreter, which must be one using this
	 * trait. The verbs run on a node's own interpreter, so a foreign patron is a
	 * wiring bug, refused rather than fatal on a method the patron lacks.
	 *
	 * @param Command_Interpreter_Node $interpreter The interpreter dispatching the verb.
	 * @return self The using node.
	 * @throws \RuntimeException When the patron is something else.
	 */
	private static function deadletter_patron( Command_Interpreter_Node $interpreter ): self {
		$patron = $interpreter->patron();
		return $patron instanceof self ? $patron : throw new \RuntimeException( 'not a dead-letter node' );
	}

	/**
	 * `dl_list` verb handler — reply the triage page.
	 *
	 * @param Command_Interpreter_Node $interpreter The `{name}:config` interpreter.
	 * @param array<array-key,mixed>   $args        Bound verb arguments: the optional
	 *                                              limit; absent takes
	 *                                              DEADLETTER_LIST_DEFAULT_LIMIT and 0
	 *                                              clamps to 1.
	 * @return array{rows: array<int,mixed>, total: int, unindexed_segments: int} The page.
	 */
	public static function cmd_dl_list( Command_Interpreter_Node $interpreter, array $args ): array {
		$patron = self::deadletter_patron( $interpreter );
		$limit  = null === $args['limit'] ? self::DEADLETTER_LIST_DEFAULT_LIMIT : \max( 1, Core::as_int( $args['limit'] ) );
		return $patron->list_deadletter( $limit );
	}

	/**
	 * `dl_show` verb handler — decode one record and reply with it.
	 *
	 * @param Command_Interpreter_Node $interpreter The `{name}:config` interpreter.
	 * @param array<array-key,mixed>   $args        Bound verb arguments: locator, from dl_list.
	 * @return array{type: int, type_flags: string, timestamp: mixed, from: string, to: string, id: string, key: string, value: mixed, size: int} The record.
	 */
	public static function cmd_dl_show( Command_Interpreter_Node $interpreter, array $args ): array {
		$patron = self::deadletter_patron( $interpreter );
		return $patron->show_deadletter( Core::as_string( $args['locator'] ) );
	}

	/**
	 * `dl_requeue` verb handler — redeliver one record; reply the `ok:` line.
	 *
	 * @param Command_Interpreter_Node $interpreter The `{name}:config` interpreter.
	 * @param array<array-key,mixed>   $args        Bound verb arguments: locator, from dl_list.
	 * @return string The `ok:` line.
	 */
	public static function cmd_dl_requeue( Command_Interpreter_Node $interpreter, array $args ): string {
		$patron = self::deadletter_patron( $interpreter );
		return $patron->requeue_deadletter( Core::as_string( $args['locator'] ) );
	}

	/**
	 * `dl_remove` verb handler — tombstone one record; reply the `ok:` line.
	 *
	 * @param Command_Interpreter_Node $interpreter The `{name}:config` interpreter.
	 * @param array<array-key,mixed>   $args        Bound verb arguments: locator, from dl_list.
	 * @return string The `ok:` line.
	 */
	public static function cmd_dl_remove( Command_Interpreter_Node $interpreter, array $args ): string {
		$patron = self::deadletter_patron( $interpreter );
		return $patron->remove_deadletter( Core::as_string( $args['locator'] ) );
	}

	/**
	 * `dl_purge` verb handler — delete all dead-letter segments; reply the count.
	 *
	 * @param Command_Interpreter_Node $interpreter The `{name}:config` interpreter.
	 * @return string The `ok:` count line.
	 */
	public static function cmd_dl_purge( Command_Interpreter_Node $interpreter ): string {
		$patron = self::deadletter_patron( $interpreter );
		return $patron->purge_deadletter();
	}
}
