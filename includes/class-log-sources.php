<?php
/**
 * Log_Sources: the fixed name → log-source registry `cmd_taillog` and the
 * `/log/stream` SSE controller both consume.
 *
 * A caller always addresses a source by registry NAME — never a path, so
 * there is no traversal surface. Three families compose the registry, in
 * priority order (first name wins, then realpath-dedupe keeps the first):
 *
 *   1. Built-ins — php `error_log` (only when it's a real file) and
 *      `WP_CONTENT_DIR/debug.log`, both Tail file mode.
 *   2. Config — `log_sources` entries (`name=/absolute/path`, one per line
 *      in the Admin UI), Tail file mode.
 *   3. Active topologies — every `Log` node in an active topology's graph,
 *      its path template resolved per partition, Tail segmented mode.
 *
 * Each entry is `{ path, mode }` where mode is a `Tail_Node::MODE_*` token.
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes;

\defined( 'ABSPATH' ) || exit;

class Log_Sources {

	/** Position tokens next_offset() resolves; the seek transport's vocabulary. */
	public const MAGIC_POSITIONS = [ 'start', 'recent', 'end' ];

	/**
	 * Built-in-source seam. Resolves the FIXED builtin name → absolute-path map
	 * (`php` | `debug`). Lazily-defaulted to the real resolver
	 * (`ini_get('error_log')` / `WP_CONTENT_DIR`); tests reassign it to point at
	 * temp fixtures without the container's ini/constants. A source whose backing
	 * location is unconfigured is omitted from the map.
	 *
	 * @var (\Closure(): array<string, string>)|null
	 */
	public static ?\Closure $builtin_sources = null;

	/** SSE-subscription name charset (leading name char blocks `.`/`..`). */
	private const NAME_PATTERN = '/^[a-z0-9_-][a-z0-9_.-]*$/D';

	/** `taillog` default / hard-cap tail window (KB). */
	private const TAILLOG_DEFAULT_KB = 16;
	private const TAILLOG_MAX_KB     = 64;


	/**
	 * `taillog [<source>] [max_kb]` builtin — tail a durable aggregated log FILE by
	 * fixed registry NAME (the shared registry: built-ins + config `log_sources` +
	 * active-topology Log nodes). No source lists the registry with per-source
	 * availability; the reserved name `sources` returns the registry as a struct
	 * (array) a GUI reads; the reserved `read <source> <segment>:<offset>`
	 * returns the single line at a position (the paused single-step debugger);
	 * an unknown name or a missing/unreadable file returns a
	 * teaching error naming the resolved path (errors-as-docs). The interpreter's
	 * `taillog` verb delegates here — file I/O over a registry Log_Sources owns.
	 *
	 * @param list<string> $args
	 * @return string|array<array-key, mixed> Struct/read replies are arrays; tails and errors are strings.
	 */
	public static function taillog( array $args ): string|array {
		[ $source, $max_kb ] = \array_pad( $args, 2, '' );
		$registry            = self::registry();

		if ( 'sources' === $source ) {
			return self::taillog_sources_struct( $registry );
		}
		if ( 'read' === $source ) {
			return self::taillog_read( $registry, $args[1] ?? '', $args[2] ?? '' );
		}
		if ( '' === $source ) {
			return self::taillog_list( $registry );
		}
		if ( ! isset( $registry[ $source ] ) ) {
			$known = \implode( ', ', \array_keys( $registry ) );
			return "unknown log source: \"$source\" (known: " . ( '' === $known ? 'none' : $known ) . ')';
		}
		// Segmented sources tail their NEWEST {path}.{seg}; file mode the path.
		$path = self::tail_path( $registry[ $source ] );
		if ( null === $path || ! \is_file( $path ) || ! \is_readable( $path ) ) {
			return 'log unavailable: ' . ( $path ?? $registry[ $source ]['path'] ) . ' (missing or unreadable)';
		}
		$window = \max( 1, \min( \ctype_digit( $max_kb ) ? (int) $max_kb : self::TAILLOG_DEFAULT_KB, self::TAILLOG_MAX_KB ) );
		return self::tail_file( $path, $window * 1024 );
	}

	/**
	 * The merged registry: built-ins → config → topologies, first name wins,
	 * realpath-deduped (insertion order is priority).
	 *
	 * @return array<string, array{path: string, mode: string}>
	 */
	public static function registry(): array {
		$entries = [];
		foreach ( self::builtin_entries() as $name => $path ) {
			$entries[ $name ] = [
				'path' => $path,
				'mode' => Tail_Node::MODE_FILE,
			];
		}
		foreach ( self::config_entries() as $name => $path ) {
			$entries[ $name ] ??= [
				'path' => $path,
				'mode' => Tail_Node::MODE_FILE,
			];
		}
		foreach ( self::topology_entries() as $name => $entry ) {
			$entries[ $name ] ??= $entry;
		}
		return self::dedupe_by_realpath( $entries );
	}

	/** @return array<string, string> Builtin name → absolute path, via the seam. */
	private static function builtin_entries(): array {
		$resolve = self::$builtin_sources ?? static function (): array {
			$sources = [];
			$php     = \ini_get( 'error_log' );
			// Only a real file — 'syslog' / relative / '' aren't tailable.
			if ( \is_string( $php ) && '' !== $php && \is_file( $php ) ) {
				$sources['php'] = $php;
			}
			// Constant may be undefined in tests — then debug is unavailable.
			if ( \defined( 'WP_CONTENT_DIR' ) ) {
				$sources['debug'] = \WP_CONTENT_DIR . '/debug.log';
			}
			return $sources;
		};
		return $resolve();
	}

	/** @return array<string, string> Config `log_sources` name → path (invalid lines skipped). */
	private static function config_entries(): array {
		$entries = [];
		foreach ( Core::arr( Config::value( 'log_sources' ) ) as $line ) {
			$parsed = self::parse_entry( Core::as_string( $line ) );
			if ( null !== $parsed ) {
				$entries[ $parsed['name'] ] ??= $parsed['path'];
			}
		}
		return $entries;
	}

	/**
	 * Parse one config `log_sources` line (`name=/absolute/path`). The Admin
	 * sanitizer and the registry share this ONE rule.
	 *
	 * @return array{name: string, path: string}|null Null when the line is invalid.
	 */
	public static function parse_entry( string $line ): ?array {
		$eq = \strpos( $line, '=' );
		if ( false === $eq ) {
			return null;
		}
		$name = \substr( $line, 0, $eq );
		$path = \substr( $line, $eq + 1 );
		if ( ! self::is_valid_name( $name ) ) {
			return null;
		}
		if ( '' === $path || '/' !== $path[0] || \str_contains( $path, '..' ) || \str_contains( $path, "\0" ) ) {
			return null;
		}
		return [
			'name' => $name,
			'path' => \rtrim( $path, '/' ),
		];
	}

	/**
	 * Whether $name is a legal registry name: the SSE-subscription charset,
	 * no `..`, and not the `sources` word `taillog` reserves for its struct verb.
	 */
	public static function is_valid_name( string $name ): bool {
		if ( \in_array( $name, [ 'sources', 'read' ], true ) || \str_contains( $name, '..' ) ) {
			return false;
		}
		return 1 === \preg_match( self::NAME_PATTERN, $name );
	}

	/**
	 * Segmented sources inferred from every `Log` node in the active topologies,
	 * one per partition where the path template carries a partition token. Named
	 * by lowercased writes-basename (+ `.p{N}` when the template is per-partition
	 * but the basename isn't). The graph scan is display-grade: a broken topology
	 * degrades to skipping that topology, never a thrown stream.
	 *
	 * @return array<string, array{path: string, mode: string}>
	 */
	private static function topology_entries(): array {
		$partitions_by_type = [];
		foreach ( Bootstrap::expand_workers() as $worker ) {
			$partitions_by_type[ Core::as_string( $worker['type'] ) ][] = Core::num_int( $worker['partition'] );
		}
		$entries = [];
		foreach ( $partitions_by_type as $type => $partitions ) {
			try {
				$graph = Topology_Registry::graph_for( $type );
				foreach ( $graph['nodes'] as $node ) {
					if ( 'log' !== ( $node['kind'] ?? '' ) ) {
						continue;
					}
					$template = Core::as_string( $node['path'] ?? '' );
					$writes   = \strtolower( Core::as_string( $node['writes'] ?? '' ) );
					if ( '' === $template || '' === $writes ) {
						continue;
					}
					// An unresolvable <ns:key> throws → topology skipped.
					Core::resolve_config_tokens( $template, true );
					$per_partition = self::has_partition_token( $template );
					foreach ( $partitions as $p ) {
						$name = Core::resolve_partition_template( $writes, $p, $type );
						if ( $per_partition && ! self::has_partition_token( $writes ) ) {
							$name .= ".p{$p}";
						}
						if ( ! self::is_valid_name( $name ) ) {
							continue;
						}
						$path = Core::resolve_partition_template( $template, $p, $type );
						if ( '' === $path || '/' !== $path[0] ) {
							continue;
						}
						$entries[ $name ] ??= [
							'path' => $path,
							'mode' => Tail_Node::MODE_SEGMENTED,
						];
					}
				}
			} catch ( Worker_Should_Stop $e ) {
				throw $e; // ADR-14: cooperative stop is never a skippable error.
			} catch ( \Throwable $e ) {
				Core::print_less_often( 'log_sources: skipping topology ', $type . ': ' . $e->getMessage() );
			}
		}
		return $entries;
	}

	/** Both the `<partition>` and `{partition}` spellings `resolve_partition_template` accepts. */
	private static function has_partition_token( string $template ): bool {
		return \str_contains( $template, '<partition>' ) || \str_contains( $template, '{partition}' );
	}

	/**
	 * Collapse registry entries that resolve to the SAME real file — on this host
	 * php `error_log` IS `wp-content/debug.log`, so `php` and `debug` would tail
	 * identical content. Insertion order is priority: `php` precedes `debug` in the
	 * resolver, so the ini-configured aggregation point is the survivor. A path that
	 * doesn't yet exist (`realpath` false) can't be a duplicate and is kept.
	 *
	 * @param array<string, array{path: string, mode: string}> $registry Name → entry (insertion order = priority).
	 * @return array<string, array{path: string, mode: string}>
	 */
	private static function dedupe_by_realpath( array $registry ): array {
		$deduped = [];
		$seen    = [];
		foreach ( $registry as $name => $entry ) {
			$real = \realpath( $entry['path'] );
			if ( false !== $real && isset( $seen[ $real ] ) ) {
				continue;
			}
			if ( false !== $real ) {
				$seen[ $real ] = true;
			}
			$deduped[ $name ] = $entry;
		}
		return $deduped;
	}

	/**
	 * The reserved `taillog sources` reply: one { name, path, mode, available, bytes,
	 * segments } row per (deduped) registry entry, as a plain array a GUI reads to
	 * build its source picker — mirrors the dump_metadata array-reply precedent.
	 * `bytes` is the byte size a tail would read (the Log Viewer's replay-catch-up
	 * boundary); null when the source has no readable file. `segments` is the
	 * `{id, size}` list a segment browser renders — [] in file mode.
	 *
	 * @param array<string, array{path: string, mode: string}> $registry Name → entry.
	 * @return list<array{name:string, path:string, mode:string, available:bool, bytes:?int, segments:list<array{id:int, size:int}>}>
	 */
	private static function taillog_sources_struct( array $registry ): array {
		$rows = [];
		foreach ( $registry as $name => $entry ) {
			$segments = self::source_segments( $entry );
			$rows[]   = [
				'name'      => $name,
				'path'      => $entry['path'],
				'mode'      => $entry['mode'],
				'available' => self::is_available( $entry['path'], $entry['mode'] ),
				'bytes'     => self::tail_bytes( $entry, $segments ),
				'segments'  => $segments,
			];
		}
		return $rows;
	}

	/**
	 * The on-disk `{path}.{seg}` segments of a segmented entry as a `{id, size}`
	 * list sorted by id — the shape the Log Viewer's segment browser renders,
	 * matching `log_status.segments`. Companion files (`.idx`) whose suffix is
	 * not purely numeric are excluded — the same rule as
	 * `Workers_CI_Node::build_log_sink_entry()` (which also stats mtime, hence
	 * its own loop); keep the two in step. File mode has no segments: [].
	 *
	 * @param array{path: string, mode: string} $entry A registry() entry.
	 * @return list<array{id: int, size: int}>
	 */
	private static function source_segments( array $entry ): array {
		if ( Tail_Node::MODE_SEGMENTED !== $entry['mode'] ) {
			return [];
		}
		$segments = [];
		foreach ( self::segment_files( $entry['path'] ) as $file ) {
			$suffix = \substr( $file, \strlen( $entry['path'] ) + 1 );
			if ( ! \ctype_digit( $suffix ) ) {
				continue;
			}
			$size       = \filesize( $file );
			$segments[] = [
				'id'   => (int) $suffix,
				'size' => false === $size ? 0 : $size,
			];
		}
		\usort( $segments, static fn ( array $a, array $b ): int => $a['id'] <=> $b['id'] );
		return $segments;
	}

	/** @return array<int, string> The on-disk `{path}.{seg}` segment files. */
	private static function segment_files( string $path ): array {
		$segments = \glob( $path . '.[0-9]*' );
		return \is_array( $segments ) ? $segments : [];
	}

	/**
	 * Whether a source currently has bytes to offer: file mode checks the file
	 * itself; segmented mode checks for ANY `{path}.{seg}` segment (retention
	 * may have pruned the early ones).
	 */
	public static function is_available( string $path, string $mode ): bool {
		if ( Tail_Node::MODE_SEGMENTED === $mode ) {
			return [] !== self::segment_files( $path );
		}
		return \is_file( $path ) && \is_readable( $path );
	}

	/**
	 * The byte size a tail would read from $entry — its NEWEST segment if segmented,
	 * else the file. Null when there is no readable file (missing, or a segmented
	 * source with no segment yet). Sizes what a Log Viewer replay must catch up to.
	 * Pass a pre-listed $segments to skip re-globbing (the struct builder has one).
	 *
	 * @param array{path: string, mode: string} $entry
	 * @param list<array{id: int, size: int}>|null $segments A source_segments() list, or null to list here.
	 */
	private static function tail_bytes( array $entry, ?array $segments = null ): ?int {
		if ( Tail_Node::MODE_SEGMENTED === $entry['mode'] ) {
			$segments ??= self::source_segments( $entry );
			if ( [] === $segments ) {
				return null;
			}
			$newest = \end( $segments );
			return $newest['size'];
		}
		if ( ! \is_file( $entry['path'] ) ) {
			return null;
		}
		$size = \filesize( $entry['path'] );
		return false === $size ? null : $size;
	}

	/**
	 * The reserved `taillog read <source> <segment>:<offset>[:<length>]` reply:
	 * the single LINE at a position, via the REAL read model — an ephemeral
	 * Tail (file or segmented mode) seeked there and single-stepped through the
	 * Durable_Reader debugger, so inode validation, segment rolls, and partial
	 * lines behave exactly as they do on the live stream, and the emitted
	 * record carries the stamped FROM + ID breadcrumb. Length-blind: a supplied
	 * `:<length>` token is ignored. The reply's `cursor` is the post-step
	 * position — the Log Viewer's paused single-step advance. File mode
	 * validates the segment slot as the file's inode (a breadcrumb round-trip);
	 * a mismatch re-seeks to 0 rather than reading a rotated-away generation.
	 *
	 * @param array<string, array{path: string, mode: string}> $registry Name → entry.
	 * @param string $name     Registry source name.
	 * @param string $position `<segment>:<offset>[:<length>]`.
	 * @return array<string,mixed>|string The line + cursor, or a teaching error.
	 */
	private static function taillog_read( array $registry, string $name, string $position ): array|string {
		// A magic token rides through to next_offset(), which speaks them.
		$magic  = \in_array( $position, self::MAGIC_POSITIONS, true );
		$tokens = \explode( ':', $position );
		if ( ! $magic
				&& ( \count( $tokens ) < 2 || \count( $tokens ) > 3
					|| ! \ctype_digit( $tokens[0] ) || ! \ctype_digit( $tokens[1] ) ) ) {
			return 'taillog read: invalid position (want <segment>:<offset>[:<length>], start, recent or end)';
		}
		if ( ! isset( $registry[ $name ] ) ) {
			$known = \implode( ', ', \array_keys( $registry ) );
			return "unknown log source: \"$name\" (known: " . ( '' === $known ? 'none' : $known ) . ')';
		}
		$entry    = $registry[ $name ];
		$captured = null;
		$capture  = new Callback_Node( static function ( array $message ) use ( &$captured ): void {
			$captured = $message;
		} );
		$tail = new Tail_Node();
		$tail->sink( $capture );
		$tail->arguments( [ $entry['path'], '', '', $entry['mode'] ] );
		$tail->set_stamp_as( $name );
		$tail->next_offset(
			$magic ? $position : [ 'segment' => (int) $tokens[0], 'offset' => (int) $tokens[1] ]
		);
		try {
			$cursor = $tail->step();
		} finally {
			$tail->remove_node();
		}
		if ( null === $captured ) {
			return "taillog read: no line at {$name} {$position}";
		}
		return [
			'source'  => $name,
			'message' => $captured,
			'cursor'  => [
				'segment' => $cursor['segment'],
				'offset'  => $cursor['offset'],
			],
			'at_eof'  => $cursor['at_eof'],
		];
	}

	/**
	 * Tabulate the registry: SOURCE, AVAILABLE (exists + readable), BYTES, PATH.
	 * Reuses the ONE Command_Interpreter_Node::tabulate renderer.
	 *
	 * @param array<string, array{path: string, mode: string}> $registry Name → entry.
	 */
	private static function taillog_list( array $registry ): string {
		$rows = [];
		foreach ( $registry as $name => $entry ) {
			// BYTES sizes what a tail reads: newest segment if segmented.
			$size   = self::tail_bytes( $entry );
			$rows[] = [
				$name,
				self::is_available( $entry['path'], $entry['mode'] ) ? 'yes' : 'no',
				null === $size ? '-' : (string) $size,
				$entry['path'],
			];
		}
		return Command_Interpreter_Node::tabulate(
			[ 'left', 'left', 'right', 'left' ],
			[ 'SOURCE', 'AVAILABLE', 'BYTES', 'PATH' ],
			$rows
		);
	}

	/**
	 * The single FILE a bounded tail read (`cmd_taillog`) opens for an entry:
	 * the path itself in file mode, the NEWEST `{path}.{seg}` segment (numeric
	 * order, not lexical) in segmented mode — null when no segment exists yet.
	 *
	 * @param array{path: string, mode: string} $entry A registry() entry.
	 */
	public static function tail_path( array $entry ): ?string {
		if ( Tail_Node::MODE_SEGMENTED !== $entry['mode'] ) {
			return $entry['path'];
		}
		$segments = self::source_segments( $entry );
		if ( [] === $segments ) {
			return null;
		}
		$newest = \end( $segments );
		return "{$entry['path']}.{$newest['id']}";
	}

	/**
	 * Read the last $max_bytes of $path from the end via a kernel-seek offset read,
	 * dropping the (likely partial) first line when the window starts past byte 0.
	 * Plain text out.
	 *
	 * @param string       $path      Registry-resolved log path.
	 * @param positive-int $max_bytes Tail window (callers clamp to >= 1024).
	 */
	private static function tail_file( string $path, int $max_bytes ): string {
		$size = \filesize( $path );
		if ( false === $size ) {
			return "log unavailable: $path (cannot read)";
		}
		// Read only the last window via the built-in's offset (kernel seek).
		$start = $size > $max_bytes ? $size - $max_bytes : 0;
		// phpcs:ignore WordPress.WP.AlternativeFunctions.file_system_operations_file_get_contents, WordPressVIPMinimum.Performance.FetchingRemoteData.FileGetContentsUnknown -- Bounded diagnostic read of a fixed-registry log path, never a URL.
		$data = \file_get_contents( $path, false, null, $start, $max_bytes );
		if ( false === $data ) {
			return "log unavailable: $path (cannot read)";
		}
		// Dropped the partial first line (the window started mid-line).
		if ( $start > 0 ) {
			$nl   = \strpos( $data, "\n" );
			$data = false === $nl ? '' : \substr( $data, $nl + 1 );
		}
		return $data;
	}
}
