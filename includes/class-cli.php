<?php
/**
 * CLI: worker discovery, consumer position, restart flags and attached-cli IPC
 * paths for the `wp nodes` verbs and the dashboard that mirrors them.
 *
 * Every instance method works one runtime tree on disk — lock dirs for worker
 * liveness, the topicprobe log for consumer position, offsetlogs and segment
 * sizes when that log has gone stale. The measurements live here rather than in
 * the command classes so `Workers_CI` serves the dashboard the same rows
 * `wp nodes status` prints, because two independent readers of one tree drift
 * apart.
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes;

\defined( 'ABSPATH' ) || exit;

/**
 * An instance is scoped to ONE base directory, and every path it builds hangs
 * off that. The public statics — the uid seam, the root refusal, worker-id
 * spelling and parsing, flag parsing, byte and duration formatting — need no
 * tree and are callable from request scope.
 */
class CLI {

	/**
	 * uid-source seam replacing the one `posix_geteuid()` call. Every uid
	 * question in the substrate resolves through `uid()`: the root refusal on
	 * `wp nodes cli` and `run`, `Config`'s base-directory ownership assertion
	 * and root-write denial, and the ownership check behind `wp nodes doctor`
	 * and Site Health. Lazily defaulted to the real call — EFFECTIVE, for the
	 * reason `uid()` states — answering -1 when the extension is absent; tests
	 * reassign it to simulate a uid the runner does not hold.
	 * Signature: `function (): int`.
	 *
	 * @var \Closure|null
	 */
	public static ?\Closure $uid_provider = null;

	/** Runtime tree every path this instance builds hangs off, without its trailing slash. */
	private string $base_dir;

	/**
	 * Bind the instance to one runtime tree.
	 *
	 * @param string $base_dir Base directory; the trailing slash comes off so every path below concatenates cleanly.
	 */
	public function __construct( string $base_dir ) {
		$this->base_dir = \rtrim( $base_dir, '/' );
	}

	/**
	 * Resolve the IPC channel of a `{type}.p{N}` reader id, spawning an
	 * on-demand worker that is asleep, through
	 * `Spawn_Coordinator::worker_channel()`.
	 *
	 * @param string $worker_id Worker id in `{type}.p{N}` form.
	 * @return array{id:string,type:string,partition:int,input:string,output:string,sleeping:bool}
	 * @throws \InvalidArgumentException When the id will not parse, or names no worker that is running or wakeable.
	 */
	public function attach_to_worker( string $worker_id ): array {
		$channel = Spawn_Coordinator::worker_channel( $this->base_dir, $worker_id, Core::right_now() );
		if ( null !== $channel ) {
			return $channel;
		}
		// phpcs:ignore WordPress.Security.EscapeOutput.ExceptionNotEscaped -- terminal message, not HTML; terminal_safe() renders control chars, and esc_html() would mangle the text.
		throw new \InvalidArgumentException(
			null === self::parse_worker_id( $worker_id )
				? 'invalid reader id: ' . Core::terminal_safe( $worker_id ) . ' (expected {type}.p{N})'
				: "no worker '" . Core::terminal_safe( $worker_id ) . "' (run `wp nodes status` to list active workers)"
		);
	}

	/**
	 * One row per reader in the topicprobe tail — the lean per-reader position
	 * and rate that `wp nodes status` and the Workers dashboard both render.
	 *
	 * A row whose snapshot has aged past `Topic_Probe_Node::stale_after_s()` is
	 * re-measured off disk by `relag_from_disk()`, because the reader that wrote
	 * it may be gone and its last record keeps reporting whatever was true when
	 * it left. A reader whose id carries no `.p{N}` partition is skipped.
	 *
	 * Topology attribution — which topology or targets a reader belongs to — is
	 * NOT here: the dashboard joins these rows onto the `.tsl` graph by
	 * `reader`/`source`, and `wp nodes status` renders them unattributed.
	 *
	 * `msgs` is the newest record's per-probe-interval count, not a cumulative.
	 *
	 * The rows come out in the order the tail window first names each reader, so
	 * a caller rendering a table sorts them. `unparseable_lines` is how many
	 * tail lines `read_probe_frames()` skipped, which every renderer shows.
	 *
	 * @return array{rows: list<array{reader:string,source:string,partition:int,cursor_segment:int,cursor_offset:int,end_segment:int,end_size:int,distance:int,msgs:int}>, unparseable_lines: int} The rows, `reader` the id, and the skipped-line count.
	 */
	public function consumer_rows(): array {
		$rows = [];
		$now  = (int) Core::right_now();
		$tail = $this->read_probe_frames();
		foreach ( $tail['records'] as $reader => $frame ) {
			// An offsetlog basename, spelled as a worker id is.
			$parsed = self::parse_worker_id( $reader );
			if ( null === $parsed ) {
				continue;
			}
			$record = $frame['value'];
			$row    = [
				'reader'         => $reader,
				'source'         => Core::as_string( $record[ Probe_Record::SOURCE ] ?? '' ),
				'partition'      => $parsed[1],
				'cursor_segment' => Core::as_int( $record[ Probe_Record::CURSOR_SEGMENT ] ?? 0 ),
				'cursor_offset'  => Core::as_int( $record[ Probe_Record::CURSOR_OFF ] ?? 0 ),
				'end_segment'    => Core::as_int( $record[ Probe_Record::END_SEGMENT ] ?? 0 ),
				'end_size'       => Core::as_int( $record[ Probe_Record::END_SIZE ] ?? 0 ),
				'distance'       => Core::as_int( $record[ Probe_Record::DISTANCE ] ?? 0 ),
				'msgs'           => Core::as_int( $record[ Probe_Record::MSGS_DELTA ] ?? 0 ),
			];
			if ( $now - $frame['timestamp'] > Topic_Probe_Node::stale_after_s() ) {
				$row = $this->relag_from_disk( $row );
			}
			$rows[] = $row;
		}
		return [ 'rows' => $rows, 'unparseable_lines' => $tail['unparseable_lines'] ];
	}

	/**
	 * Replace a stale row's position with one measured off disk.
	 *
	 * A probe record is only ever as fresh as the worker that wrote it, so a
	 * departed reader's last snapshot says whatever was true when it left —
	 * usually `caught up`, which is how an externally-fed partition reports 0B
	 * while its backlog grows. Cursor and end are BOTH re-read, never mixed with
	 * the record's: pairing a stale cursor against a fresh stat would overstate
	 * every live reader by an interval of throughput, which is why the live path
	 * measures them together.
	 *
	 * Rebuilding a dir from the record's basename assumes the flat layout the
	 * probe's own SOURCE/READER basenames already assume. Every step must
	 * resolve — a SOURCE to rebuild from, both dirs on disk, a committed cursor —
	 * or the row is left alone, and a partition that will not read fails the
	 * table rather than reporting a guess: this row exists
	 * because a reader reported it, so that reader HAS a cursor, and an
	 * offsetlog we cannot find means the basename did not rebuild the path, not
	 * that there is no cursor. Reading it as absent would call the whole
	 * partition backlog, a worse lie than the stale record it replaces.
	 *
	 * Paths come off `$this->base_dir`, as `read_probe_frames()`'s do, NOT the
	 * `<config:logs_dir>` token: that resolves against the global base, and this
	 * class is instance-scoped, so the two disagree for any CLI built on another
	 * tree — recomputing one base's rows against another's partitions.
	 *
	 * @param array{reader:string,source:string,partition:int,cursor_segment:int,cursor_offset:int,end_segment:int,end_size:int,distance:int,msgs:int} $row Stale row.
	 * @return array{reader:string,source:string,partition:int,cursor_segment:int,cursor_offset:int,end_segment:int,end_size:int,distance:int,msgs:int}
	 * @throws \Throwable What reading the partition or its cursor off disk threw.
	 */
	private function relag_from_disk( array $row ): array {
		if ( '' === $row['source'] ) {
			return $row;
		}
		$source_dir    = "{$this->base_dir}/logs/{$row['source']}";
		$offsetlog_dir = "{$this->base_dir}/offsets/{$row['reader']}";
		// Both, or neither: a missing offsetlog means the path didn't rebuild.
		if ( ! \is_dir( $source_dir ) || ! \is_dir( $offsetlog_dir ) ) {
			return $row;
		}
		$lag = Consumer_Node::lag_from_disk( $source_dir, $offsetlog_dir );
		if ( ! $lag['cursor_known'] ) {
			return $row;
		}

		$row['cursor_segment'] = $lag['cursor_segment'];
		$row['cursor_offset']  = $lag['cursor_offset'];
		$row['end_segment']    = $lag['end_segment'];
		$row['end_size']       = $lag['end_size'];
		$row['distance']       = $lag['bytes_behind'];
		// Nobody is reading: the rate is 0, not the last one seen.
		$row['msgs'] = 0;
		return $row;
	}

	/**
	 * Parse `{type}.p{N}` into [type, partition], the inverse of `worker_id()`.
	 *
	 * The type match is greedy, so a dotted topology name keeps its dots and
	 * only the FINAL `.p{N}` reads as the partition: `foo.bar.p3` is partition 3
	 * of `foo.bar`, never partition 3 of `foo` inside something called `bar`.
	 *
	 * Only a spelling `worker_id()` can write parses. The type carries no `/`
	 * and no NUL, because the id is one path segment of the lock and IPC trees
	 * and one segment of a node path; the partition carries no leading zero,
	 * because `x.p03` would resolve to the lock `x.p3` holds while naming an
	 * IPC tree nothing reads.
	 *
	 * @param string $worker_id Worker id.
	 * @return array{0:string,1:int}|null Type and partition; null when the id
	 *                                    is no worker's spelling.
	 */
	public static function parse_worker_id( string $worker_id ): ?array {
		if ( ! \preg_match( '/^([^\/\x00]+)\.p(0|[1-9][0-9]*)$/D', $worker_id, $m ) ) {
			return null;
		}
		return [ $m[1], (int) $m[2] ];
	}

	/**
	 * The latest stats record in the shared topicprobe log for each reader in
	 * its tail, keyed by reader id — the basename of that consumer's offsetlog
	 * dir, which is what tells two readers of one partition apart — each with
	 * the snapshot time it was written at.
	 *
	 * The sole live-position source behind the dashboard and `wp nodes status`.
	 * `Topic_Probe` appends one record per READY Consumer every
	 * `Topic_Probe_Node::declared_interval_s()` seconds, 15 by default, and a
	 * record exists only while a worker is running to write one. The timestamp
	 * is therefore the only thing separating a reporting reader from a departed
	 * one, and departed is what `consumer_rows()` falls back on.
	 *
	 * `Partition_Node::read_tail_frames_by()` scans the newest segment's last
	 * 128 KiB, so a reader with no record inside that window is absent from the
	 * map rather than stale: it drops out of the status table instead of being
	 * re-measured off disk. Every Topic_Probe in the fleet appends to that one
	 * log, so a line a short write tore is expected; it is skipped and counted.
	 *
	 * @return array{records: array<string,array{value:array<mixed>,timestamp:int}>, unparseable_lines: int} Reader id → its latest record and that record's snapshot time, and the skipped-line count.
	 */
	public function read_probe_frames(): array {
		return Partition_Node::read_tail_frames_by(
			"{$this->base_dir}/logs/" . Topic_Probe_Node::LOG_DIR,
			Probe_Record::READER
		);
	}

	/**
	 * Every worker lock dir under this tree, sorted by type then partition, each
	 * with its heartbeat time, start time and staleness. The dirs are the ones
	 * `Spawn_Coordinator::worker_lock_dirs()` reads, so status lists exactly the
	 * set the fleet reconciles.
	 *
	 * Staleness is judged against the threshold the worker's OWN topology
	 * declares (`Bootstrap::stale_timeout_for()`), never a flat one: a topology
	 * that lifts its threshold because its work is legitimately slow would
	 * otherwise read as down here while the peer scan correctly leaves it up.
	 * One `time()` serves the whole scan, so every worker is judged against the
	 * same clock.
	 *
	 * @return array<int,array{id:string,type:string,partition:int,heartbeat_at:int,started_at:int,stale:bool}>
	 */
	public function ls_workers(): array {
		$now     = \time();
		$workers = [];
		foreach ( Spawn_Coordinator::worker_lock_dirs( $this->base_dir ) as $dir => $lock ) {
			$workers[] = $lock + self::lock_liveness(
				$dir,
				$now,
				Bootstrap::stale_timeout_for( $lock['type'] )
			);
		}
		\usort( $workers, fn ( $a, $b ) =>
			[ $a['type'], $a['partition'] ] <=> [ $b['type'], $b['partition'] ]
		);
		return $workers;
	}

	/**
	 * Heartbeat/started/staleness triple for one worker lock dir.
	 *
	 * A lock dir carrying neither file reports 0 for both times rather than
	 * null, so the status table selects its dash off a plain `> 0`. The
	 * staleness verdict is `Lock_Node`'s, which reads a missing heartbeat as
	 * stale.
	 *
	 * @param string $dir           The `.lock.d` directory.
	 * @param int    $now           Clock, so one scan judges every worker alike.
	 * @param int    $stale_timeout Seconds without a heartbeat before stale.
	 * @return array{heartbeat_at:int,started_at:int,stale:bool}
	 */
	private static function lock_liveness( string $dir, int $now, int $stale_timeout = Lock_Node::STALE_TIMEOUT ): array {
		$mtime = @\filemtime( "{$dir}/heartbeat" );
		return [
			'heartbeat_at' => $mtime ?: 0,
			'started_at'   => Lock_Node::get_started_time( $dir ) ?? 0,
			'stale'        => Lock_Node::heartbeat_is_stale( $dir, $now, $stale_timeout ),
		];
	}

	/**
	 * `WP_CLI::error` (exits) when this process is root.
	 *
	 * A root-run verb seeds `ipc/` and `locks/` root-owned, and the workers run
	 * as the web user, so they are the ones left unable to append to their own
	 * IPC directories.
	 *
	 * @param string $verb Subcommand name, for the message.
	 */
	public static function refuse_root( string $verb ): void {
		$uid = self::uid();
		if ( 0 === $uid ) {
			\WP_CLI::error( "wp nodes {$verb} must run as the same user as the workers, not root." );
		}
	}

	/**
	 * The EFFECTIVE uid through the seam; -1 when posix is absent.
	 *
	 * Effective, not real: every caller asks "who will own the files I create
	 * here", and that follows the effective uid (Linux fsuid, which tracks it).
	 * The two differ under a setuid wrapper, or a process that dropped only its
	 * effective uid — where the real uid would answer the wrong question.
	 */
	public static function uid(): int {
		$provider = self::$uid_provider
			?? static fn (): int => \function_exists( 'posix_geteuid' ) ? \posix_geteuid() : -1;
		return Core::as_int( $provider(), -1 );
	}

	/**
	 * Spell the worker id `{type}.p{N}`, the inverse of `parse_worker_id()`.
	 *
	 * The id names a worker everywhere it is addressed: its lock dir, its IPC
	 * tree, its REPL partition, its stop label and the fleet's liveness keys.
	 *
	 * @param string $type      Worker type, a topology name.
	 * @param int    $partition Partition index.
	 * @return string The worker id.
	 */
	public static function worker_id( string $type, int $partition ): string {
		return "{$type}.p{$partition}";
	}

	/**
	 * Read an operator-supplied `--flag=<n>`: absent takes the fallback, a
	 * malformed one is a WP_CLI::error (which exits non-zero).
	 *
	 * A cast would answer 0 for `--partition=abc` and 2 for `--timeout=2m`, so
	 * the typo selects a different fleet — or a different deadline — and the
	 * command reports success on it.
	 *
	 * @param array<string,mixed> $assoc_args WP-CLI associative args.
	 * @param string              $key        Flag name.
	 * @param int|null            $fallback   Value when the flag is absent.
	 * @param bool                $allow_zero Whether 0 is acceptable.
	 * @return ($fallback is null ? int|null : int)
	 * @throws \RuntimeException When a stubbed WP_CLI::error returns instead of exiting.
	 */
	public static function require_flag_int( array $assoc_args, string $key, ?int $fallback = null, bool $allow_zero = true ): ?int {
		if ( ! isset( $assoc_args[ $key ] ) ) {
			return $fallback;
		}
		$value = Command_Args::option_int( $assoc_args, $key, $fallback, $allow_zero );
		if ( null === $value ) {
			$bound = $allow_zero ? 'non-negative' : 'positive';
			\WP_CLI::error( "--{$key} must be a {$bound} integer; got: " . Core::terminal_safe( Core::as_string( $assoc_args[ $key ] ) ) );
			// The real error() exits; a stub returning must not fall through.
			throw new \RuntimeException( \esc_html( "invalid --{$key}" ) );
		}
		return $value;
	}

	/**
	 * Request restart for one or more worker groups by dropping a `restart` flag
	 * in each matching lock dir; the worker notices on its next continue check.
	 *
	 * Returns 0 without touching anything on a multisite subsite. The fleet is
	 * network-global — locks, IPC and logs carry no blog namespace — so it runs
	 * on the main site only, and a subsite flagging those dirs would restart
	 * another site's workers.
	 *
	 * @param array<int,array<string,mixed>> $workers   List of `[type=>str, partition=>int]`.
	 * @param array<string,bool>             $filter    Optional `[type => bool]`; empty or an `all` key = wildcard.
	 * @param int                            $partition Only this partition if >= 0; -1 = any.
	 * @return int Number of restart-flag files written.
	 * @throws \Throwable Every flag write refused or failed, raised after each worker was offered its flag.
	 */
	public function restart_workers( array $workers, array $filter = [], int $partition = -1 ): int {
		if ( ! Bootstrap::fleet_site() ) {
			return 0;
		}
		$wildcard = empty( $filter ) || isset( $filter['all'] );
		$targets  = [];
		foreach ( $workers as $w ) {
			$type = Core::as_string( $w['type'] ?? '' );
			$p    = Core::num_int( $w['partition'] ?? 0 );
			if ( '' === $type ) {
				continue;
			}
			if ( ! $wildcard && empty( $filter[ $type ] ) ) {
				continue;
			}
			if ( $partition >= 0 && $p !== $partition ) {
				continue;
			}
			$targets[] = [ $type, $p ];
		}
		return Spawn_Coordinator::signal_workers( $this->base_dir, $targets, Lock_Node::request_restart_at( ... ) );
	}

	/**
	 * Format byte counts compactly for the Behind column of `wp nodes status`.
	 *
	 * GB is the top of the ladder, so a terabyte reads `1024GB`.
	 *
	 * @param int $bytes Byte count.
	 * @return string A single unit, e.g. `938B`, `1.4KB`, `2.1MB`.
	 */
	public static function format_bytes( int $bytes ): string {
		if ( $bytes < 1024 ) {
			return $bytes . 'B';
		}
		if ( $bytes < 1024 * 1024 ) {
			return \round( $bytes / 1024, 1 ) . 'KB';
		}
		if ( $bytes < 1024 * 1024 * 1024 ) {
			return \round( $bytes / ( 1024 * 1024 ), 1 ) . 'MB';
		}
		return \round( $bytes / ( 1024 * 1024 * 1024 ), 1 ) . 'GB';
	}

	/**
	 * Compact elapsed-time rendering: the two largest NON-ZERO units, so an hour
	 * and a second reads `1h 1s` rather than spending half the width on `0m`.
	 *
	 * @param int $seconds Elapsed seconds.
	 * @return string E.g. `3h 12m`, `45s`; `0s` for zero and for anything below it.
	 */
	public static function format_duration( int $seconds ): string {
		$seconds = \max( 0, $seconds ); // clock skew must not render '-3s'
		$units   = [ 'd' => 86400, 'h' => 3600, 'm' => 60, 's' => 1 ];
		$parts = [];
		foreach ( $units as $suffix => $size ) {
			if ( $seconds >= $size || ( 's' === $suffix && empty( $parts ) ) ) {
				$parts[]  = \intdiv( $seconds, $size ) . $suffix;
				$seconds %= $size;
				if ( 2 === \count( $parts ) ) {
					break;
				}
			}
		}
		return \implode( ' ', $parts );
	}

}
