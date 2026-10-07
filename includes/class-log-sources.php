<?php
/**
 * Log_Sources: the fixed name → log-source registry behind `list_logs`,
 * `dump_log`, `read_message` and a `sources/<name>` subscription on
 * `/messages/stream`.
 *
 * A caller always addresses a source by registry NAME — never a path, so
 * there is no traversal surface. Three families compose the registry, in
 * priority order (first name wins, then realpath-dedupe keeps the first):
 *
 *   1. Built-ins — php `error_log` and
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
 * Composes the registry and serves every read of a log by its stamp: the
 * picker `catalog()`, a log's `footprint()`, the single-step `read()`, and
 * the reader a subscription opens. Each branches on `Log_Discovery::split()`,
 * so a `sources/<name>` stamp resolves through the registry and any other
 * through `Log_Discovery::dir_of()` (ADR-29). Static throughout, because the
 * registry resolves per request out of the options table and the active
 * topologies — there is nothing to hold between calls.
 */
class Log_Sources {

	/**
	 * Built-in-source seam. Resolves the FIXED builtin name → absolute-path map
	 * (`php` | `debug`). Lazily-defaulted to the real resolver
	 * (`ini_get('error_log')` / `WP_CONTENT_DIR`); tests reassign it to point at
	 * temp fixtures without the container's ini/constants. A source whose backing
	 * location is unconfigured is omitted from the map. A php source is
	 * registered whenever `error_log` is an absolute path, before the file
	 * exists, so a stream or a Tail naming it opens and waits; `is_available()`
	 * reports whether it exists yet.
	 *
	 * @var (\Closure(): array<string,string>)|null
	 */
	public static ?\Closure $builtin_sources = null;

	/**
	 * Legal registry-name charset, gating the config and topology families
	 * through `is_valid_name()`. The first character excludes `.`, so `.` and
	 * `..` can never name a source.
	 */
	private const NAME_PATTERN = '/^[a-z0-9_-][a-z0-9_.-]*$/D';

	/**
	 * Every registry source as a picker row, keyed by the stamp it streams
	 * under: `sources/<name>`, its name as the label, and whether a Tail
	 * would find bytes there now. A source whose segments will not list
	 * takes an unavailable row carrying `error`, and an active topology that
	 * will not read takes one labelled for the topology and keyed by no
	 * stamp, because it names no log; one failure never blanks the picker.
	 * Every source is offered its listing, and a stop among the failures
	 * escapes carrying the rest, which is `Worker_Should_Stop`'s rule.
	 *
	 * @return list<array{key?:string,label:string,available:bool,error?:string}>
	 * @throws Worker_Should_Stop When a stop is among the failures, carrying the rest.
	 */
	public static function catalog(): array {
		[ $registry, $unreadable ] = self::readable_registry();
		$rows                      = \array_fill_keys( \array_keys( $registry ), null );
		$failed                    = Worker_Should_Stop::attempt_each(
			$registry,
			static function ( array $entry, string $name ) use ( &$rows ): void {
				$rows[ $name ] = [
					'key'       => self::stamp( $name ),
					'label'     => $name,
					'available' => self::is_available( $entry ),
				];
			}
		);
		$caught = Worker_Should_Stop::combine( [ ...\array_values( $failed ), ...\array_values( $unreadable ) ] );
		if ( $caught instanceof Worker_Should_Stop ) {
			throw $caught;
		}
		foreach ( $failed as $name => $e ) {
			$rows[ $name ] = self::error_row( $name, $e, self::stamp( $name ) );
		}
		$rows = \array_values( \array_filter( $rows ) );
		foreach ( $unreadable as $topology => $e ) {
			$rows[] = self::error_row( $topology, $e );
		}
		return $rows;
	}

	/**
	 * The unavailable picker row for what could not be read, keyed by the
	 * stamp it names, or by none when it names no log.
	 *
	 * @param string            $label Source, topology or dir name.
	 * @param \Throwable|string $error What reading it threw, or why it was refused.
	 * @param string|null       $key   The stamp the row names, or null.
	 * @return array{key?:string,label:string,available:bool,error:string}
	 */
	public static function error_row( string $label, \Throwable|string $error, ?string $key = null ): array {
		return ( null === $key ? [] : [ 'key' => $key ] ) + [
			'label'     => $label,
			'available' => false,
			'error'     => \is_string( $error ) ? $error : \html_entity_decode( $error->getMessage(), \ENT_QUOTES ),
		];
	}

	/**
	 * Whether a source currently has bytes a reader may take: whether its
	 * footprint lists a segment, which retention may have pruned to a later
	 * one, and which a file source lists only while it is readable.
	 *
	 * @param array{path: string, mode: string} $entry A registry() entry.
	 * @return bool True when a tail would find something to read.
	 * @throws \Throwable What listing the segments threw.
	 */
	public static function is_available( array $entry ): bool {
		return [] !== self::entry_footprint( $entry )['segments'];
	}

	/**
	 * The stamp a registry name streams under.
	 *
	 * @param string $name Registry name.
	 */
	private static function stamp( string $name ): string {
		return Log_Discovery::stamp_for( Log_Discovery::SOURCES_PREFIX, $name );
	}

	/**
	 * One log's segments and size, the rail a reader browses, by its stamp:
	 * its `{id, size}` list and their summed bytes. A dir and a segmented
	 * source are read from the writer of that layout. A file source is one
	 * segment, its inode at the file's size, which is the slot a Tail over
	 * the file stamps its breadcrumbs with; it lists none while the file is
	 * absent or unreadable.
	 *
	 * @param string $stamp A dir stamp or `sources/<name>`.
	 * @return array{segments:list<array{id:int,size:int}>,total_size:int}
	 * @throws \InvalidArgumentException On a stamp no dir or registry entry carries.
	 */
	public static function footprint( string $stamp ): array {
		[ $group, $name ] = Log_Discovery::split( $stamp );
		if ( Log_Discovery::SOURCES_PREFIX !== $group ) {
			return self::writer_footprint( new Partition_Node(), self::dir( $stamp ) );
		}
		return self::entry_footprint( self::entry( $name ) );
	}

	/**
	 * One registry entry's footprint, as `footprint()` describes it.
	 *
	 * @param array{path: string, mode: string} $entry A registry() entry.
	 * @return array{segments:list<array{id:int,size:int}>,total_size:int}
	 * @throws \Throwable What listing the segments threw.
	 */
	private static function entry_footprint( array $entry ): array {
		$path = $entry['path'];
		if ( Tail_Node::MODE_SEGMENTED === $entry['mode'] ) {
			return self::writer_footprint( new Log_Node(), $path );
		}
		\clearstatcache( true, $path );
		$stat = \is_file( $path ) && \is_readable( $path ) ? \stat( $path ) : false;
		if ( false === $stat ) {
			return [
				'segments'   => [],
				'total_size' => 0,
			];
		}
		return [
			'segments'   => [
				[
					'id'   => $stat['ino'],
					'size' => $stat['size'],
				],
			],
			'total_size' => $stat['size'],
		];
	}

	/**
	 * The footprint the WRITER of a layout reads off `$path`, so the segment
	 * naming rule is declared once, by the class that writes the files, and
	 * a companion `.idx` never reads as a data segment. The writer is
	 * ephemeral and removed on every exit. A dir `scandir()` cannot read
	 * lists as empty, as it does to the writer; a listing that throws
	 * propagates.
	 *
	 * @param Partition_Node $writer A fresh Partition for a dir, Log for a segmented source.
	 * @param string         $path   The dir, or the segmented source's base path.
	 * @return array{segments:list<array{id:int,size:int}>,total_size:int}
	 * @throws \Throwable What the listing threw.
	 */
	private static function writer_footprint( Partition_Node $writer, string $path ): array {
		try {
			$writer->arguments( [ $path ] );
			$footprint = $writer->footprint();
		} finally {
			$writer->remove_node();
		}
		return [
			'segments'   => \array_values( $footprint['segments'] ?? [] ),
			'total_size' => $footprint['bytes'] ?? 0,
		];
	}

	/**
	 * Single-step ONE log, by its stamp, to the record at `$position` — the
	 * read model behind every paused single-step debugger.
	 *
	 * The position is a word of `Log_Position::WORDS`, or what
	 * `Log_Position::parse()` reads: `<segment>:<offset>` with a trailing
	 * `:<length>` it ignores. A file
	 * source also takes `:<offset>`, the cursor a stream states while it has
	 * not seen the file's generation, and reads at that offset in whichever
	 * file the path holds; a segmented log refuses it, because segment 0 is a
	 * real segment and no other can stand in. A malformed position throws before any log is
	 * opened. The reader arrives armed, so every exit after it opens runs
	 * `remove_node()` in the `finally`: a reader left armed with no sink fires
	 * forever inside the worker's drain loop.
	 *
	 * The `cursor` returned is the POST-step position, exactly where the next
	 * step resumes. No record there is a result, not a refusal: `message` is
	 * null, and `at_eof` says whether the reader stopped at the end or only
	 * consumed a line that would not unpack, with the cursor past it. `Tail_Node extends Consumer_Node`, so a dir and
	 * both registry modes drive identically; segment rolls, torn records and
	 * length-blindness are subtle enough that a second copy drifts.
	 *
	 * @param string $log      A dir stamp or `sources/<name>`.
	 * @param string $position Magic token, or `[<segment>]:<offset>[:<length>]`.
	 * @return array{source:string,message:array<array-key,mixed>|null,cursor:array{segment:int,offset:int},at_eof:bool}
	 * @throws \InvalidArgumentException On a malformed position, a segment-less one on a
	 *                                   segmented log, or a stamp nothing carries.
	 */
	public static function read( string $log, string $position ): array {
		// A word rides through to next_offset(), which speaks it.
		$at      = isset( Log_Position::WORDS[ $position ] ) ? $position : Log_Position::parse( $position );
		$invalid = 'read_message: invalid position (want <segment>:<offset>[:<length>], :<offset> on a file source, start, recent or end)';
		if ( null === $at ) {
			throw new \InvalidArgumentException( $invalid );
		}
		$captured = null;
		$reader   = self::open_reader( $log );
		try {
			if ( \is_array( $at ) && ! isset( $at['segment'] ) && ! $reader instanceof File_Tail_Node ) {
				throw new \InvalidArgumentException( $invalid );
			}
			$reader->sink( new Callback_Node( static function ( array $message ) use ( &$captured ): void {
				$captured = $message;
			} ) );
			$reader->next_offset( $at );
			$cursor = $reader->step();
		} finally {
			$reader->remove_node();
		}
		return [
			'source'  => $log,
			'message' => $captured,
			'cursor'  => [
				'segment' => $cursor['segment'],
				'offset'  => $cursor['offset'],
			],
			'at_eof'  => $cursor['at_eof'],
		];
	}

	/**
	 * Open ONE named log as a durable reader stamped with that name: a
	 * `sources/<name>` stamp as its registry entry's Tail, any other as the
	 * cursorless `Consumer_Node::scan()` over the dir it names, the reader the
	 * stream opens, so a line that will not unpack is skipped and counted.
	 * The stream and the single-step read both resolve here, so a name means
	 * one log wherever it is read. No sidecar is built; the caller sets the
	 * cursor.
	 *
	 * @param string $log A dir stamp or `sources/<name>`.
	 * @return Consumer_Node The reader, stamped `$log`.
	 * @throws \InvalidArgumentException On a stamp no dir or registry entry carries.
	 */
	public static function open_reader( string $log ): Consumer_Node {
		[ $group, $name ] = Log_Discovery::split( $log );
		if ( Log_Discovery::SOURCES_PREFIX === $group ) {
			$reader = self::open_tail( self::entry( $name ) );
		} else {
			$reader = Consumer_Node::scan( self::dir( $log ) );
		}
		$reader->set_stamp_as( $log );
		return $reader;
	}

	/**
	 * The dir a dir stamp names under the runtime base, or the refusal that
	 * names the stamp.
	 *
	 * @param string $stamp A dir stamp.
	 * @return string The absolute dir.
	 * @throws \InvalidArgumentException On a stamp the guard refuses or no dir carries.
	 */
	private static function dir( string $stamp ): string {
		return Log_Discovery::dir_of( $stamp, Config::get_base_directory() )
			// phpcs:ignore WordPress.Security.EscapeOutput.ExceptionNotEscaped -- plain-text message for log/CLI consumers; escape at the view, not the runtime.
			?? throw new \InvalidArgumentException( "unknown log: \"{$stamp}\"" );
	}

	/**
	 * The registry entry a name keys, or the ONE teaching error for a name
	 * it lacks, naming every source there is — the REPL, the single-step
	 * read and the SSE stream all phrase it identically.
	 *
	 * @param string $name Registry name.
	 * @return array{path: string, mode: string}
	 * @throws \InvalidArgumentException On a name the registry lacks.
	 */
	public static function entry( string $name ): array {
		$registry = self::registry();
		if ( isset( $registry[ $name ] ) ) {
			return $registry[ $name ];
		}
		throw self::unknown_source( $name, \array_keys( $registry ) );
	}

	/**
	 * The merged registry: built-ins, then config, then topologies. First name
	 * wins and realpath dedupe keeps the first, so insertion order is priority.
	 * Strict: an active topology that cannot be read throws, after every other
	 * was read.
	 *
	 * @return array<string,array{path: string,mode: string}>
	 * @throws \Throwable What the unreadable topologies threw, combined.
	 */
	public static function registry(): array {
		[ $entries, $unreadable ] = self::readable_registry();
		Worker_Should_Stop::raise( $unreadable );
		return $entries;
	}

	/**
	 * The registry over every readable family, and what each active topology
	 * that could not be read threw instead, keyed by topology name.
	 *
	 * @return array{0: array<string,array{path: string,mode: string}>, 1: array<string,\Throwable>}
	 */
	private static function readable_registry(): array {
		[ $topology_entries, $unreadable ] = self::topology_entries();
		$entries                           = [];
		foreach ( self::file_entries() as $name => $path ) {
			$entries[ $name ] = [
				'path' => $path,
				'mode' => Tail_Node::MODE_FILE,
			];
		}
		foreach ( $topology_entries as $name => $entry ) {
			$entries[ $name ] ??= $entry;
		}
		return [ self::dedupe_by_realpath( $entries ), $unreadable ];
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
	 * but the basename isn't). Every readable topology is scanned whatever
	 * another threw, and every failure — `Bootstrap::active_topologies()`'s, and
	 * an unresolvable `<ns:key>` token — is returned beside the entries, keyed by
	 * the topology that threw it.
	 *
	 * @return array{0: array<string,array{path: string,mode: string}>, 1: array<string,\Throwable>}
	 */
	private static function topology_entries(): array {
		[ $readable, $unreadable ] = Bootstrap::active_topologies();
		$entries                   = [];
		$failed                    = Worker_Should_Stop::attempt_each(
			$readable,
			static function ( array $entry, string $type ) use ( &$entries ): void {
				$entries += self::entries_of( Bootstrap::partitions_of( $entry ), $type );
			}
		);
		return [ $entries, $unreadable + $failed ];
	}

	/**
	 * The segmented sources one topology's `Log` nodes declare.
	 *
	 * @param int    $partitions Its partition count.
	 * @param string $type       Topology name.
	 * @return array<string,array{path: string,mode: string}>
	 * @throws \RuntimeException When a path template carries an unresolvable token.
	 */
	private static function entries_of( int $partitions, string $type ): array {
		$entries = [];
		foreach ( Topology_Analyzer::graph_for( $type )['nodes'] as $node ) {
			if ( 'log' !== ( $node['kind'] ?? '' ) ) {
				continue;
			}
			$template = Core::as_string( $node['path'] ?? '' );
			$writes   = \strtolower( Core::as_string( $node['writes'] ?? '' ) );
			if ( '' === $template || '' === $writes ) {
				continue;
			}
			// Strict: an unresolvable <ns:key> throws.
			Core::resolve_config_tokens( $template, true );
			$per_partition = self::has_partition_token( $template );
			for ( $p = 0; $p < $partitions; $p++ ) {
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
		return $entries;
	}

	/** Whether $template carries a partition token in either spelling `resolve_partition_template` accepts. */
	private static function has_partition_token( string $template ): bool {
		return \str_contains( $template, '<partition>' ) || \str_contains( $template, '{partition}' );
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
	 * The file a `sources/<name>` path names, for a Tail a topology declares.
	 * Only the built-in and config families answer: the topology family is
	 * built by reading the active topologies, which a topology being loaded
	 * cannot depend on, and its entries are segmented Logs, not files.
	 *
	 * @param string $name The registry name, without the prefix.
	 * @return string The absolute file path.
	 * @throws \InvalidArgumentException When neither family carries the name.
	 */
	public static function file_source_path( string $name ): string {
		$files = self::file_entries();
		return $files[ $name ] ?? throw self::unknown_source( $name, \array_keys( $files ) );
	}

	/**
	 * The ONE teaching error for a name the registry lacks.
	 *
	 * @param string       $name  The name asked for.
	 * @param list<string> $names Every name the lookup knew.
	 */
	private static function unknown_source( string $name, array $names ): \InvalidArgumentException {
		$known = \implode( ', ', $names );
		// phpcs:ignore WordPress.Security.EscapeOutput.ExceptionNotEscaped -- plain-text message for log/CLI consumers; escape at the view, not the runtime.
		return new \InvalidArgumentException( "unknown log source: \"{$name}\" (known: " . ( '' === $known ? 'none' : $known ) . ')' );
	}

	/**
	 * The file families, built-ins first so a built-in name wins a config one.
	 *
	 * @return array<string,string> Name → absolute path.
	 */
	private static function file_entries(): array {
		return self::builtin_entries() + self::config_entries();
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
	 * Whether $name is a legal registry name: the NAME_PATTERN charset and no `..`.
	 *
	 * @param string $name Candidate registry name.
	 * @return bool True when the name is legal.
	 */
	public static function is_valid_name( string $name ): bool {
		if ( \str_contains( $name, '..' ) ) {
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
			// An absolute path is followed written yet or not; syslog is not.
			if ( \is_string( $php ) && \str_starts_with( $php, '/' ) ) {
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
