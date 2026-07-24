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
	 * uid-source seam shared by the root-refusing verbs (`cli`, `run`). Lazily-
	 * defaulted to the real `posix_getuid()` (-1 when the extension is absent);
	 * tests reassign to simulate root without the runner being root.
	 * Signature: `function (): int`.
	 *
	 * @var \Closure|null
	 */
	public static ?\Closure $uid_provider = null;

	private string $base_dir;

	public function __construct( string $base_dir ) {
		$this->base_dir = \rtrim( $base_dir, '/' );
	}

	/** WP_CLI::error (exits) as root — root-owned IPC/lock dirs lock out the web-user fleet. */
	public static function refuse_root( string $verb ): void {
		$uid = ( self::$uid_provider ?? static fn (): int => \function_exists( 'posix_getuid' ) ? \posix_getuid() : -1 )();
		if ( 0 === $uid ) {
			\WP_CLI::error( "wp nodes {$verb} must run as the same user as the workers, not root." );
		}
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
		if ( ! \is_dir( $lock_dir ) ) {
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
	 * One row per active Consumer — the lean per-reader STATE from the topicprobe
	 * snapshot (`read_probe_index()`). Topology attribution (which topology/targets
	 * a reader belongs to) is NOT here: the dashboard joins these rows onto the
	 * `.tsl` graph by `reader`/`source`; `wp nodes status` renders them directly,
	 * unattributed. Keyed in the array by insertion; `reader` is the id.
	 *
	 * @return array<int,array{reader:string,source:string,partition:int,cursor_segment:int,cursor_offset:int,end_segment:int,end_size:int,distance:int,msgs:int}>
	 */
	public function consumer_rows(): array {
		$rows = [];
		foreach ( $this->read_probe_index() as $reader => $record ) {
			// reader is `{source_basename}.p{N}`: partition lives in the name.
			if ( ! \preg_match( '/^(.+)\.p(\d+)$/', $reader, $m ) ) {
				continue;
			}
			$rows[] = [
				'reader'     => $reader,
				'source'     => Core::as_string( $record[ Probe_Record::SOURCE ] ?? '' ),
				'partition'  => (int) $m[2],
				'cursor_segment' => Core::as_int( $record[ Probe_Record::CURSOR_SEGMENT ] ?? 0 ),
				'cursor_offset' => Core::as_int( $record[ Probe_Record::CURSOR_OFF ] ?? 0 ),
				'end_segment'    => Core::as_int( $record[ Probe_Record::END_SEGMENT ] ?? 0 ),
				'end_size'   => Core::as_int( $record[ Probe_Record::END_SIZE ] ?? 0 ),
				'distance'   => Core::as_int( $record[ Probe_Record::DISTANCE ] ?? 0 ),
				'msgs'       => Core::as_int( $record[ Probe_Record::MSGS ] ?? 0 ),
			];
		}
		return $rows;
	}


	/**
	 * Index of every active Consumer's latest stats record from the shared
	 * topicprobe log, keyed by `offsetlog_dir` — the durable per-reader identity.
	 * This is the single live-position source the dashboard + `wp nodes status`
	 * read (it replaced memcache + the offsetlog fallback); TopicProbe appends one
	 * record per Consumer every ~15s.
	 *
	 * @return array<string,array<mixed>> offsetlog_dir → the latest probe record VALUE.
	 */
	public function read_probe_index(): array {
		return Partition_Node::read_tail_index_by(
			"{$this->base_dir}/logs/" . TopicProbe_Node::LOG_DIR,
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
			] + self::lock_liveness( "{$locks_dir}/{$entry}", $now );
		}
		\usort( $workers, fn ( $a, $b ) =>
			[ $a['type'], $a['partition'] ] <=> [ $b['type'], $b['partition'] ]
		);
		return $workers;
	}

	/**
	 * Liveness of the supervisor's own singleton lock, or null when it holds
	 * no lock dir. The `.p<N>` worker scan can never see supervisor.lock.d —
	 * without this the process the whole safety net rests on is invisible.
	 *
	 * @return array{heartbeat_at:int,started_at:int,stale:bool}|null
	 */
	public function supervisor_status(): ?array {
		$dir = "{$this->base_dir}/locks/supervisor.lock.d";
		if ( ! \is_dir( $dir ) ) {
			return null;
		}
		return self::lock_liveness( $dir, \time() );
	}

	/**
	 * Heartbeat/started/staleness triple for one lock dir (workers + supervisor).
	 *
	 * @return array{heartbeat_at:int,started_at:int,stale:bool}
	 */
	private static function lock_liveness( string $dir, int $now ): array {
		$mtime = @\filemtime( "{$dir}/heartbeat" );
		return [
			'heartbeat_at' => $mtime ?: 0,
			'started_at'   => Lock_Node::get_started_time( $dir ) ?? 0,
			'stale'        => ( false === $mtime || ( $now - $mtime ) > Lock_Node::STALE_TIMEOUT ),
		];
	}

	/**
	 * Request restart for one or more worker groups by dropping a `restart` flag.
	 *
	 * @param array<int, array<string, mixed>> $workers   List of `[type=>str, partition=>int]`.
	 * @param array<string, bool>              $filter    Optional `[type => bool]`; empty or 'all' = wildcard.
	 * @param int                              $partition Only this partition if >= 0; -1 = any.
	 * @return int Number of restart-flag files written.
	 */
	public function restart_workers( array $workers, array $filter = [], int $partition = -1 ): int {
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
	 * Drop a restart flag at the supervisor's singleton lock dir.
	 *
	 * @return bool True when the flag was written.
	 */
	public function restart_supervisor(): bool {
		return Lock_Node::request_restart_at( "{$this->base_dir}/locks/supervisor.lock.d" );
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
