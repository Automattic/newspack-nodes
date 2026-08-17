<?php
/**
 * Cli: helper methods backing the WP-CLI commands (pure I/O against on-disk + memcache state).
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes;

\defined( 'ABSPATH' ) || exit;

class CLI {

	/**
	 * uid-source seam shared by the root-refusing verbs (`cli`, `run`) and
	 * `doctor`'s ownership check (uid vs base-dir owner). Lazily-defaulted to
	 * the real `posix_geteuid()` — EFFECTIVE, for the reason uid() states —
	 * (-1 when the extension is absent); tests reassign to simulate any uid
	 * without the runner holding it.
	 * Signature: `function (): int`.
	 *
	 * @var \Closure|null
	 */
	public static ?\Closure $uid_provider = null;

	private string $base_dir;

	public function __construct( string $base_dir ) {
		$this->base_dir = \rtrim( $base_dir, '/' );
	}

	/**
	 * Resolve IPC paths for a `{type}.p{N}` reader id; verifies the worker's lock dir exists.
	 *
	 * @param string $worker_id Worker id in `{type}.p{N}` form.
	 * @return array{input:string,output:string,type:string,partition:int}
	 * @throws \InvalidArgumentException If worker_id can't be parsed or no matching lock dir exists.
	 */
	public function attach_to_worker( string $worker_id ): array {
		[ $type, $partition ] = self::parse_worker_id( $worker_id );
		$lock_dir             = "{$this->base_dir}/locks/{$worker_id}.lock.d";
		// This class is base-dir scoped; the shared coordinator may not be.
		if ( ! \is_dir( $lock_dir )
			&& ! ( new Spawn_Coordinator( $this->base_dir ) )->wake_sleeping_worker( $worker_id, Core::right_now() ) ) {
			throw new \InvalidArgumentException(
				// phpcs:ignore WordPress.Security.EscapeOutput.ExceptionNotEscaped -- terminal message, not HTML; cli_safe() strips control chars, and esc_html() would render the quotes as &#039;.
				"no worker '" . self::cli_safe( $worker_id ) . "' (run `wp nodes status` to list active workers)"
			);
		}
		return [
			'input'     => "{$this->base_dir}/ipc/{$worker_id}/input",
			'output'    => "{$this->base_dir}/ipc/{$worker_id}/output",
			'type'      => $type,
			'partition' => $partition,
		];
	}

	/**
	 * Parse `{type}.p{N}` into [type, partition].
	 *
	 * @param string $worker_id Worker id.
	 * @return array{0:string,1:int}
	 * @throws \InvalidArgumentException If worker_id can't be parsed.
	 */
	public static function parse_worker_id( string $worker_id ): array {
		if ( ! \preg_match( '/^(.+)\.p(\d+)$/', $worker_id, $m ) ) {
			// phpcs:ignore WordPress.Security.EscapeOutput.ExceptionNotEscaped -- terminal message, not HTML; cli_safe() strips control chars, and esc_html() would mangle the text.
			throw new \InvalidArgumentException( 'invalid reader id: ' . self::cli_safe( $worker_id ) . ' (expected {type}.p{N})' );
		}
		return [ $m[1], (int) $m[2] ];
	}

	/**
	 * One row per active Consumer — the lean per-reader STATE from the topicprobe
	 * snapshot (`read_probe_index()`). Topology attribution (which topology/targets
	 * a reader belongs to) is NOT here: the dashboard joins these rows onto the
	 * `.tsl` graph by `reader`/`source`; `wp nodes status` renders them directly,
	 * unattributed. Keyed in the array by insertion; `reader` is the id.
	 *
	 * `msgs` is the newest record's per-probe-interval count, not a cumulative.
	 *
	 * @return array<int,array{reader:string,source:string,partition:int,cursor_segment:int,cursor_offset:int,end_segment:int,end_size:int,distance:int,msgs:int}>
	 */
	public function consumer_rows(): array {
		$rows = [];
		$now  = (int) Core::right_now();
		foreach ( $this->read_probe_frames() as $reader => $frame ) {
			// reader is `{source_basename}.p{N}`: partition lives in the name.
			if ( ! \preg_match( '/^(.+)\.p(\d+)$/', $reader, $m ) ) {
				continue;
			}
			$record = $frame['value'];
			$row    = [
				'reader'         => $reader,
				'source'         => Core::as_string( $record[ Probe_Record::SOURCE ] ?? '' ),
				'partition'      => (int) $m[2],
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
		return $rows;
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
	 * probe's own SOURCE/READER basenames already assume. BOTH dirs must resolve
	 * or the row is left alone: this row exists because a reader reported it, so
	 * that reader HAS a cursor, and an offsetlog we cannot find means the
	 * basename did not rebuild the path — not that there is no cursor. Reading
	 * it as absent would call the whole partition backlog, a worse lie than the
	 * stale record it replaces.
	 *
	 * Paths come off `$this->base_dir`, as `read_probe_index()`'s do, NOT the
	 * `<config:logs_dir>` token: that resolves against the global base, and this
	 * class is instance-scoped, so the two disagree for any CLI built on another
	 * tree — recomputing one base's rows against another's partitions.
	 *
	 * @param array{reader:string,source:string,partition:int,cursor_segment:int,cursor_offset:int,end_segment:int,end_size:int,distance:int,msgs:int} $row Stale row.
	 * @return array{reader:string,source:string,partition:int,cursor_segment:int,cursor_offset:int,end_segment:int,end_size:int,distance:int,msgs:int}
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
		try {
			$lag = Consumer_Node::lag_from_disk( $source_dir, $offsetlog_dir );
		} catch ( \Throwable $e ) {
			// A status table must not fatal over one unreadable reader.
			return $row;
		}
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
	 * Every active Consumer's latest stats record from the shared topicprobe log,
	 * keyed by `offsetlog_dir` — the durable per-reader identity — each with the
	 * snapshot time it was written at.
	 *
	 * The primary live-position source the dashboard + `wp nodes status` read (it
	 * replaced memcache + the offsetlog fallback); Topic_Probe appends one record
	 * per Consumer every ~15s. A record only exists while a worker is running to
	 * write one, so the timestamp is the only thing separating a reporting reader
	 * from a departed one — and departed is what `consumer_rows()` falls back on.
	 *
	 * @return array<string,array{value: array<mixed>, timestamp: int}> offsetlog_dir → record + snapshot time.
	 */
	public function read_probe_frames(): array {
		return Partition_Node::read_tail_frames_by(
			"{$this->base_dir}/logs/" . Topic_Probe_Node::LOG_DIR,
			Probe_Record::READER
		);
	}

	/**
	 * Enumerate worker lock dirs and report each one's staleness.
	 *
	 * @return array<int,array{type:string,partition:int,heartbeat_at:int,started_at:int,stale:bool}>
	 */
	public function ls_workers(): array {
		$locks_dir = "{$this->base_dir}/locks";
		if ( ! \is_dir( $locks_dir ) ) {
			return [];
		}
		$now     = \time();
		$workers = [];
		foreach ( \scandir( $locks_dir ) ?: [] as $entry ) {
			if ( ! \preg_match( '/^(.+)\.p(\d+)\.lock\.d$/', $entry, $m ) ) {
				continue;
			}
			$workers[] = [
				'type'      => $m[1],
				'partition' => (int) $m[2],
			] + self::lock_liveness(
				"{$locks_dir}/{$entry}",
				$now,
				Bootstrap::stale_timeout_for( $m[1] )
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

	/** WP_CLI::error (exits) as root — root-owned IPC/lock dirs lock out the web-user fleet. */
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
			\WP_CLI::error( "--{$key} must be a {$bound} integer; got: " . self::cli_safe( Core::as_string( $assoc_args[ $key ] ) ) );
			// The real error() exits; a stub returning must not fall through.
			throw new \RuntimeException( \esc_html( "invalid --{$key}" ) );
		}
		return $value;
	}

	/**
	 * Make an untrusted worker id safe to echo in a TERMINAL error message:
	 * strip C0 control characters + DEL so a crafted id can't inject an ANSI /
	 * escape sequence, while keeping the printable text and the message's literal
	 * quotes. This is terminal sanitization, not HTML output — esc_html() is the
	 * wrong tool here (it renders `'` as `&#039;` in the shell).
	 */
	private static function cli_safe( string $worker_id ): string {
		return (string) \preg_replace( '/[\x00-\x1F\x7F]/', '', $worker_id );
	}

	/**
	 * Request restart for one or more worker groups by dropping a `restart` flag.
	 *
	 * @param array<int,array<string,mixed>> $workers   List of `[type=>str, partition=>int]`.
	 * @param array<string,bool>              $filter    Optional `[type => bool]`; empty or 'all' = wildcard.
	 * @param int                              $partition Only this partition if >= 0; -1 = any.
	 * @return int Number of restart-flag files written.
	 */
	public function restart_workers( array $workers, array $filter = [], int $partition = -1 ): int {
		if ( ! Bootstrap::fleet_site() ) {
			return 0;
		}
		$restarted = 0;
		$wildcard  = empty( $filter ) || isset( $filter['all'] );

		foreach ( $workers as $w ) {
			$type_raw = $w['type'] ?? '';
			$type     = Core::as_string( $type_raw );
			$p_raw    = $w['partition'] ?? 0;
			$p        = Core::num_int( $p_raw );
			if ( '' === $type ) {
				continue;
			}
			if ( ! $wildcard && empty( $filter[ $type ] ) ) {
				continue;
			}
			if ( $partition >= 0 && $p !== $partition ) {
				continue;
			}
			if ( Lock_Node::request_restart_at( "{$this->base_dir}/locks/{$type}.p{$p}.lock.d" ) ) {
				++$restarted;
			}
		}
		return $restarted;
	}

	/**
	 * Format byte counts compactly for the Behind column of `wp nodes status`.
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

	/** Compact elapsed-time rendering: the two largest units, e.g. '3h 12m'. */
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
