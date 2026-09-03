<?php
/**
 * Log_Sources: the fixed name → log-source registry the `taillog` verb and the
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

/**
 * Composes the registry and serves every bounded read over it: the `taillog`
 * listing, the `sources` struct, the single-step `read`, and the `Tail` a
 * `/log/stream` subscription opens. Static throughout, because the registry
 * resolves per request out of the options table and the active topologies —
 * there is nothing to hold between calls.
 */
class Log_Sources {

	/**
	 * Seek words the human-facing surfaces accept, aliasing
	 * `Consumer_Node::SEEK_*` (start 0, recent -2, end -1). The numbers are what
	 * travels on the wire; `next_offset()` resolves these words to them, so both
	 * spellings reach one behaviour.
	 */
	public const MAGIC_POSITIONS = [ 'start', 'recent', 'end' ];

	/**
	 * Built-in-source seam. Resolves the FIXED builtin name → absolute-path map
	 * (`php` | `debug`). Lazily-defaulted to the real resolver
	 * (`ini_get('error_log')` / `WP_CONTENT_DIR`); tests reassign it to point at
	 * temp fixtures without the container's ini/constants. A source whose backing
	 * location is unconfigured is omitted from the map.
	 *
	 * @var (\Closure(): array<string,string>)|null
	 */
	public static ?\Closure $builtin_sources = null;

	/**
	 * Legal registry-name charset, which an SSE subscription name shares. The
	 * first character excludes `.`, so `.` and `..` can never name a source.
	 */
	private const NAME_PATTERN = '/^[a-z0-9_-][a-z0-9_.-]*$/D';

	/** Tail window `taillog` reads when the caller names no size (KB). */
	private const TAILLOG_DEFAULT_KB = 16;

	/** Ceiling on the window a caller may ask for (KB); a larger ask clamps. */
	private const TAILLOG_MAX_KB = 64;

	/**
	 * `taillog [<source>] [max_kb]` builtin — the last `max_kb` KB (16 by
	 * default, 64 at most) of a durable aggregated log FILE, addressed by fixed
	 * registry NAME (built-ins + config `log_sources` + active-topology Log
	 * nodes). Three replies are reserved: no source lists the registry with
	 * per-source availability; the name `sources` returns the registry as a
	 * struct (array) a GUI reads; and `read <source> <segment>:<offset>` returns
	 * the single line at a position (the paused single-step debugger). An
	 * unknown name, or a file that is missing or unreadable, comes back as a
	 * teaching error naming the resolved path (errors-as-docs). The
	 * interpreter's `taillog` verb delegates here, so the file I/O sits beside
	 * the registry this class owns.
	 *
	 * @param list<string> $args `[ <source>, <max_kb> ]`, or a reserved form.
	 * @return string|array<array-key,mixed> Struct/read replies are arrays; tails and errors are strings.
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
			return self::unknown_source( $registry, $source );
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
	 * Read the last $max_bytes of $path, dropping the first line when the window
	 * opens past byte 0 — a window rarely starts on a line boundary, and a
	 * leading fragment reads as corruption. The offset argument seeks in the
	 * kernel, so a multi-gigabyte log never lands in memory.
	 *
	 * @param string       $path      Registry-resolved log path.
	 * @param positive-int $max_bytes Tail window (callers clamp to >= 1024).
	 * @return string The tail as plain text, or a teaching error when the read fails.
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
		// Drop the partial first line: the window started mid-line.
		if ( $start > 0 ) {
			$nl   = \strpos( $data, "\n" );
			$data = false === $nl ? '' : \substr( $data, $nl + 1 );
		}
		return $data;
	}

	/**
	 * The single FILE a bounded tail read opens for an entry: the path itself in
	 * file mode, the NEWEST `{path}.{seg}` segment (numeric order, not lexical)
	 * in segmented mode — null when no segment exists yet.
	 *
	 * @param array{path: string, mode: string} $entry A registry() entry.
	 * @return string|null The file to read, or null when a segmented source has no segment.
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
	 * Tabulate the registry: SOURCE, AVAILABLE (exists + readable), BYTES, PATH.
	 * Reuses the ONE Command_Interpreter_Node::tabulate renderer.
	 *
	 * @param array<string,array{path: string,mode: string}> $registry Name → entry.
	 * @return string The rendered table.
	 */
	private static function taillog_list( array $registry ): string {
		$rows = [];
		foreach ( $registry as $name => $entry ) {
			// One listing per row: AVAILABLE and BYTES are two reads of it.
			$segments = self::source_segments( $entry );
			$size     = self::tail_bytes( $entry, $segments );
			$rows[]   = [
				$name,
				self::is_available( $entry, $segments ) ? 'yes' : 'no',
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
	 * The reserved `taillog read <source> <segment>:<offset>[:<length>]` reply:
	 * the single LINE at a position, via the REAL read model — an ephemeral
	 * Tail (file or segmented mode) seeked there and single-stepped through the
	 * Durable_Reader debugger, so inode validation, segment rolls, and partial
	 * lines behave exactly as they do on the live stream, and the emitted
	 * record carries the stamped FROM + ID breadcrumb. File mode validates the
	 * segment slot as the file's inode (a breadcrumb round-trip); a mismatch
	 * re-seeks to 0 rather than reading a rotated-away generation. `read_at()`
	 * owns the position grammar and the cursor contract.
	 *
	 * @param array<string,array{path: string,mode: string}> $registry Name → entry.
	 * @param string $name     Registry source name.
	 * @param string $position `<segment>:<offset>[:<length>]`, or a MAGIC_POSITIONS word.
	 * @return array<string,mixed>|string The line + cursor, or a teaching error.
	 */
	private static function taillog_read( array $registry, string $name, string $position ): array|string {
		if ( ! isset( $registry[ $name ] ) ) {
			return self::unknown_source( $registry, $name );
		}
		return self::read_at( self::open_tail( $registry[ $name ] ), $name, $position, 'taillog read' );
	}

	/**
	 * Open a registry entry as a durable reader — the ONE place a `mode` token
	 * becomes a class. Handing the reader its path alone leaves the offsetlog
	 * and dead-letter dirs empty, so neither sidecar is built: these readers are
	 * ephemeral (the single-step debugger) or client-cursored (the SSE stream),
	 * and neither resumes from a durable cursor.
	 *
	 * @param array{path: string, mode: string} $entry A registry() entry.
	 * @return Tail_Node A File_Tail_Node in file mode, a plain Tail_Node in segmented mode.
	 */
	public static function open_tail( array $entry ): Tail_Node {
		$tail = Tail_Node::MODE_FILE === $entry['mode'] ? new File_Tail_Node() : new Tail_Node();
		$tail->arguments( [ $entry['path'] ] );
		return $tail;
	}

	/**
	 * Single-step ONE configured durable reader to the record at `$position` —
	 * the read model behind every paused single-step debugger.
	 *
	 * The reader arrives already ARMED — the caller's `arguments()` has run
	 * `set_timer()` and registered it with the Event_Framework — so every exit
	 * from here, a rejected position included, runs `remove_node()` in the
	 * `finally`. A reader left armed with no sink fires forever inside the
	 * worker's drain loop.
	 *
	 * Position grammar is the seek transport's — a `MAGIC_POSITIONS` token, or
	 * `<segment>:<offset>` with an optional trailing `:<length>` that is
	 * tolerated and IGNORED (the reader knows the record's real length). The
	 * `cursor` returned is the POST-step position, i.e. exactly where the next
	 * step resumes.
	 *
	 * `Tail_Node extends Consumer_Node`, so the segmented, file-follow and
	 * partition readers all drive identically; only construction and the verb
	 * name in the teaching errors differ. A copy per caller drifts: segment
	 * rolls, torn records, length-blindness and the post-step cursor are subtle
	 * enough that a fix reaches one copy and silently misses the other.
	 *
	 * @param Consumer_Node $reader   A configured, unsunk durable reader.
	 * @param string        $label    Source name; stamped as FROM and echoed back.
	 * @param string        $position Magic token, or `<segment>:<offset>[:<length>]`.
	 * @param string        $verb     Verb name for the teaching errors.
	 *
	 * @return array{source:string,message:array<array-key,mixed>,cursor:array{segment:int,offset:int},at_eof:bool}|string
	 */
	public static function read_at( Consumer_Node $reader, string $label, string $position, string $verb ): array|string {
		$captured = null;
		try {
			// A magic token rides through to next_offset(), which speaks it.
			$magic  = \in_array( $position, self::MAGIC_POSITIONS, true );
			$tokens = \explode( ':', $position );
			if ( ! $magic
					&& ( \count( $tokens ) < 2 || \count( $tokens ) > 3
						|| ! \ctype_digit( $tokens[0] ) || ! \ctype_digit( $tokens[1] ) ) ) {
				return "{$verb}: invalid position (want <segment>:<offset>[:<length>], start, recent or end)\n";
			}
			$reader->sink( new Callback_Node( static function ( array $message ) use ( &$captured ): void {
				$captured = $message;
			} ) );
			$reader->set_stamp_as( $label );
			$reader->next_offset(
				$magic ? $position : [ 'segment' => (int) $tokens[0], 'offset' => (int) $tokens[1] ]
			);
			$cursor = $reader->step();
		} finally {
			$reader->remove_node();
		}
		if ( null === $captured ) {
			return "{$verb}: no record at {$label} {$position}\n";
		}
		return [
			'source'  => $label,
			'message' => $captured,
			'cursor'  => [
				'segment' => $cursor['segment'],
				'offset'  => $cursor['offset'],
			],
			'at_eof'  => $cursor['at_eof'],
		];
	}

	/**
	 * The ONE teaching error for a name the registry does not carry — the REPL,
	 * the single-step read and the SSE stream all phrase it identically.
	 *
	 * @param array<string,array{path: string,mode: string}> $registry Name → entry.
	 * @param string $name The name that missed.
	 * @return string The error, newline-terminated, naming every source there is.
	 */
	public static function unknown_source( array $registry, string $name ): string {
		$known = \implode( ', ', \array_keys( $registry ) );
		return "unknown log source: \"$name\" (known: " . ( '' === $known ? 'none' : $known ) . ")\n";
	}

	/**
	 * The reserved `taillog sources` reply: one { name, path, mode, available, bytes,
	 * segments } row per (deduped) registry entry, as a plain array a GUI reads to
	 * build its source picker — mirrors the dump_metadata array-reply precedent.
	 * `bytes` is the byte size a tail would read (the Log Viewer's replay-catch-up
	 * boundary); null when the source has no readable file. `segments` is the
	 * `{id, size}` list a segment browser renders — [] in file mode.
	 *
	 * @param array<string,array{path: string,mode: string}> $registry Name → entry.
	 * @return list<array{name:string,path:string,mode:string,available:bool,bytes:?int,segments:list<array{id:int,size:int}>}>
	 */
	private static function taillog_sources_struct( array $registry ): array {
		$rows = [];
		foreach ( $registry as $name => $entry ) {
			$segments = self::source_segments( $entry );
			$rows[]   = [
				'name'      => $name,
				'path'      => $entry['path'],
				'mode'      => $entry['mode'],
				'available' => self::is_available( $entry, $segments ),
				'bytes'     => self::tail_bytes( $entry, $segments ),
				'segments'  => $segments,
			];
		}
		return $rows;
	}

	/**
	 * The byte size a tail would read from $entry — its NEWEST segment if segmented,
	 * else the file. Null when there is no readable file (missing, or a segmented
	 * source with no segment yet). Sizes what a Log Viewer replay must catch up to.
	 *
	 * @param array{path: string, mode: string}   $entry    A registry() entry.
	 * @param list<array{id: int,size: int}>|null $segments A source_segments() list to reuse, or null to list here.
	 * @return int|null Bytes, or null when there is nothing readable.
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
	 * Whether a source currently has bytes to offer: file mode checks the file
	 * itself; segmented mode checks for ANY `{path}.{seg}` segment (retention
	 * may have pruned the early ones).
	 *
	 * @param array{path: string, mode: string}   $entry    A registry() entry.
	 * @param list<array{id: int,size: int}>|null $segments A source_segments() list to reuse, or null to list here.
	 * @return bool True when a tail would find something to read.
	 */
	public static function is_available( array $entry, ?array $segments = null ): bool {
		if ( Tail_Node::MODE_SEGMENTED === $entry['mode'] ) {
			return [] !== ( $segments ?? self::source_segments( $entry ) );
		}
		return \is_file( $entry['path'] ) && \is_readable( $entry['path'] );
	}

	/**
	 * The on-disk `{path}.{seg}` segments of a segmented entry as a `{id, size}`
	 * list sorted by id — the shape the Log Viewer's segment browser renders,
	 * matching `log_status.segments`.
	 *
	 * Asked of the WRITER: an ephemeral `Log_Node` on the same path already
	 * exposes exactly this list through `Partition_Node::get_segments()`, using
	 * its own `segment_pattern()` seam — so the naming rule is declared once, by
	 * the class that writes the files, and a companion `.idx` can never read as
	 * a data segment. (The sibling `Raw_Logs_CI_Node::cmd_log_status` builds an
	 * ephemeral Partition for the same reason.) File mode has no segments: [].
	 *
	 * Every listing caller walks the WHOLE registry, so one entry that cannot be
	 * listed degrades to no segments rather than blanking the reply — a
	 * debugging surface has to survive the broken thing being debugged.
	 *
	 * @param array{path: string, mode: string} $entry A registry() entry.
	 * @return list<array{id: int,size: int}>
	 */
	private static function source_segments( array $entry ): array {
		if ( Tail_Node::MODE_SEGMENTED !== $entry['mode'] ) {
			return [];
		}
		$log = new Log_Node();
		try {
			$log->arguments( [ $entry['path'] ] );
			return \array_values( $log->get_segments( true ) );
		} catch ( Worker_Should_Stop $e ) {
			throw $e; // ADR-14: cooperative stop is never a skippable error.
		} catch ( \Throwable $e ) {
			Core::print_less_often( 'log_sources: cannot list segments of ', $entry['path'] . ': ' . $e->getMessage() );
			return [];
		} finally {
			$log->remove_node();
		}
	}

	/**
	 * The merged registry: built-ins → config → topologies, first name wins,
	 * realpath-deduped (insertion order is priority).
	 *
	 * @return array<string,array{path: string,mode: string}>
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

	/**
	 * Collapse registry entries that resolve to the SAME real file — where php
	 * `error_log` IS `wp-content/debug.log`, `php` and `debug` would otherwise
	 * tail identical content. Insertion order is priority: `php` precedes `debug`
	 * in the resolver, so the ini-configured aggregation point is the survivor. A
	 * path that doesn't yet exist (`realpath` false) can't be a duplicate and is
	 * kept.
	 *
	 * @param array<string,array{path: string,mode: string}> $registry Name → entry (insertion order = priority).
	 * @return array<string,array{path: string,mode: string}>
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
	 * Segmented sources inferred from every `Log` node in the active topologies,
	 * one per partition where the path template carries a partition token. Named
	 * by lowercased writes-basename (+ `.p{N}` when the template is per-partition
	 * but the basename isn't). The graph scan is display-grade: a broken topology
	 * degrades to skipping that topology, never a thrown stream.
	 *
	 * @return array<string,array{path: string,mode: string}>
	 */
	private static function topology_entries(): array {
		$partitions_by_type = [];
		foreach ( Bootstrap::expand_workers() as $worker ) {
			$partitions_by_type[ Core::as_string( $worker['type'] ) ][] = Core::num_int( $worker['partition'] );
		}
		$entries = [];
		foreach ( $partitions_by_type as $type => $partitions ) {
			try {
				$graph = Topology_Analyzer::graph_for( $type );
				foreach ( $graph['nodes'] as $node ) {
					if ( 'log' !== ( $node['kind'] ?? '' ) ) {
						continue;
					}
					$template = Core::as_string( $node['path'] ?? '' );
					$writes   = \strtolower( Core::as_string( $node['writes'] ?? '' ) );
					if ( '' === $template || '' === $writes ) {
						continue;
					}
					// An unresolvable <ns:key> throws, skipping the topology.
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

	/** Whether $template carries a partition token in either spelling `resolve_partition_template` accepts. */
	private static function has_partition_token( string $template ): bool {
		return \str_contains( $template, '<partition>' ) || \str_contains( $template, '{partition}' );
	}

	/**
	 * The config family: one `name=/absolute/path` per line of the `log_sources`
	 * setting. An invalid line is skipped rather than fatal, so one typo in the
	 * textarea cannot blank the whole registry; first name wins within the family.
	 *
	 * @return array<string,string> Config `log_sources` name → path (invalid lines skipped).
	 */
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
	 * Parse one config `log_sources` line (`name=/absolute/path`). The name must
	 * pass `is_valid_name()`; the path must be absolute and free of `..` and NUL,
	 * so an entry names exactly the file it spells. The Admin sanitizer and the
	 * registry share this ONE rule.
	 *
	 * @param string $line One raw textarea line.
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
	 * Whether $name is a legal registry name: the NAME_PATTERN charset, no `..`,
	 * and neither of the words `taillog` reserves for its sub-verbs, `sources`
	 * and `read` — a source wearing either would be unreachable behind it.
	 */
	public static function is_valid_name( string $name ): bool {
		if ( \in_array( $name, [ 'sources', 'read' ], true ) || \str_contains( $name, '..' ) ) {
			return false;
		}
		return 1 === \preg_match( self::NAME_PATTERN, $name );
	}

	/**
	 * The built-in family, resolved through the `$builtin_sources` seam so a
	 * test can supply fixtures in place of the host's ini and constants.
	 *
	 * @return array<string,string> Builtin name → absolute path.
	 */
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
}
