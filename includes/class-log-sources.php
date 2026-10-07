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
 * Composes the registry and serves every read over it: the picker `catalog()`,
 * a source's `footprint()`, the single-step `read_at()`, and the reader a
 * `sources/<name>` subscription opens. Static throughout, because the registry
 * resolves per request out of the options table and the active topologies —
 * there is nothing to hold between calls.
 *
 * `read_at()` is the one member that takes no registry entry: it single-steps
 * whatever durable reader it is handed, which is how `Raw_Logs_CI_Node`'s
 * `read_message` verb reads a partition through this same model.
 */
class Log_Sources {

	/**
	 * Seek words the human-facing surfaces accept, aliasing
	 * `Consumer_Node::SEEK_*` (start 0, recent -2, end -1). The numbers are what
	 * travels on the wire; `Consumer_Node::seek_sentinel()` resolves the words to
	 * them, so both spellings reach one behaviour.
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
	 * Legal registry-name charset, gating the config and topology families
	 * through `is_valid_name()`. The first character excludes `.`, so `.` and
	 * `..` can never name a source.
	 */
	private const NAME_PATTERN = '/^[a-z0-9_-][a-z0-9_.-]*$/D';

	/**
	 * Every registry source as a picker row, keyed by the stamp it streams
	 * under: `sources/<name>`, its name as the label, and whether a Tail
	 * would find bytes there now. A source whose segments will not list,
	 * and an active topology that will not read, each take an unavailable
	 * row carrying `error`, so one failure never blanks the picker; a
	 * topology's row is named for the topology. Every source is offered
	 * its listing, and a stop among the failures escapes carrying the
	 * rest, which is `Worker_Should_Stop`'s rule.
	 *
	 * @return list<array{key:string,label:string,available:bool,error?:string}>
	 * @throws Worker_Should_Stop When a stop is among the failures, carrying the rest.
	 */
	public static function catalog(): array {
		[ $registry, $unreadable ] = self::readable_registry();
		$rows                      = \array_fill_keys( \array_keys( $registry ), null );
		$failed                    = Worker_Should_Stop::attempt_each(
			$registry,
			static function ( array $entry, string $name ) use ( &$rows ): void {
				$rows[ $name ] = self::catalog_row( $name, self::is_available( $entry ) );
			}
		);
		$caught = Worker_Should_Stop::combine( [ ...\array_values( $failed ), ...\array_values( $unreadable ) ] );
		if ( $caught instanceof Worker_Should_Stop ) {
			throw $caught;
		}
		foreach ( $failed as $name => $e ) {
			$rows[ $name ] = self::catalog_error_row( $name, $e );
		}
		$rows = \array_values( \array_filter( $rows ) );
		foreach ( $unreadable as $topology => $e ) {
			$rows[] = self::catalog_error_row( $topology, $e );
		}
		return $rows;
	}

	/**
	 * The unavailable picker row for a source or topology it could not read.
	 *
	 * @param string     $name Source or topology name.
	 * @param \Throwable $e    What reading it threw.
	 * @return array{key:string,label:string,available:bool,error:string}
	 */
	private static function catalog_error_row( string $name, \Throwable $e ): array {
		return self::catalog_row( $name, false ) + [
			'error' => \html_entity_decode( $e->getMessage(), \ENT_QUOTES ),
		];
	}

	/**
	 * One picker row for a registry name.
	 *
	 * @param string $name      Source or topology name.
	 * @param bool   $available Whether a Tail would find bytes there now.
	 * @return array{key:string,label:string,available:bool}
	 */
	private static function catalog_row( string $name, bool $available ): array {
		return [
			'key'       => Log_Discovery::SOURCES_PREFIX . "/{$name}",
			'label'     => $name,
			'available' => $available,
		];
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
	 * One source's segments and size, the rail a reader browses: a
	 * segmented source's `{id, size}` list and their summed bytes, a file
	 * source's empty list and its file size, 0 while the file is absent.
	 * A file's size is a replay's catch-up boundary, since it has no
	 * segment to order by.
	 *
	 * @param string $name Registry name.
	 * @return array{segments:list<array{id:int,size:int}>,bytes:int}
	 * @throws \InvalidArgumentException On a name the registry lacks.
	 */
	public static function footprint( string $name ): array {
		$registry = self::registry();
		if ( ! isset( $registry[ $name ] ) ) {
			// phpcs:ignore WordPress.Security.EscapeOutput.ExceptionNotEscaped -- plain-text message for log/CLI consumers; escape at the view, not the runtime.
			throw new \InvalidArgumentException( \rtrim( self::unknown_source( $registry, $name ), "\n" ) );
		}
		$entry    = $registry[ $name ];
		$segments = self::source_segments( $entry );
		if ( Tail_Node::MODE_SEGMENTED === $entry['mode'] ) {
			return [
				'segments' => $segments,
				'bytes'    => \array_sum( \array_column( $segments, 'size' ) ),
			];
		}
		$size = \is_file( $entry['path'] ) ? \filesize( $entry['path'] ) : false;
		return [
			'segments' => [],
			'bytes'    => false === $size ? 0 : $size,
		];
	}

	/**
	 * The on-disk `{path}.{seg}` segments of a segmented entry as a `{id, size}`
	 * list sorted by id — the shape a segment browser renders,
	 * matching `dump_log.segments`.
	 *
	 * Asked of the WRITER: an ephemeral `Log_Node` on the same path already
	 * exposes exactly this list through `Partition_Node::get_segments()`, using
	 * its own `segment_pattern()` seam — so the naming rule is declared once, by
	 * the class that writes the files, and a companion `.idx` can never read as
	 * a data segment. (The sibling `Raw_Logs_CI_Node::cmd_dump_log` builds an
	 * ephemeral Partition for the same reason.) File mode has no segments: [].
	 *
	 * An entry that cannot be listed fails the listing that asked, because an
	 * empty segment list would report a broken source as an empty one.
	 *
	 * @param array{path: string, mode: string} $entry A registry() entry.
	 * @return list<array{id: int,size: int}>
	 * @throws \Throwable What listing the segments threw.
	 */
	private static function source_segments( array $entry ): array {
		if ( Tail_Node::MODE_SEGMENTED !== $entry['mode'] ) {
			return [];
		}
		$log = new Log_Node();
		try {
			$log->arguments( [ $entry['path'] ] );
			return \array_values( $log->get_segments( true ) );
		} finally {
			$log->remove_node();
		}
	}

	/**
	 * Open ONE named log as a durable reader stamped with that name: a
	 * `sources/<name>` stamp as its registry entry's Tail, any other as a
	 * Consumer over the catalog dir it names. The stream and the single-step
	 * read both resolve here, so a name means one log wherever it is read.
	 * The reader carries its path alone, so no sidecar is built; the caller
	 * sets the cursor.
	 *
	 * @param string $log A `sources/<name>` stamp or a catalog stamp.
	 * @return Consumer_Node The reader, stamped `$log`.
	 * @throws \InvalidArgumentException On a name the registry or the catalog does not carry.
	 */
	public static function open_reader( string $log ): Consumer_Node {
		$prefix = Log_Discovery::SOURCES_PREFIX . '/';
		if ( \str_starts_with( $log, $prefix ) ) {
			$name     = \substr( $log, \strlen( $prefix ) );
			$registry = self::registry();
			if ( ! isset( $registry[ $name ] ) ) {
				// phpcs:ignore WordPress.Security.EscapeOutput.ExceptionNotEscaped -- plain-text message for log/CLI consumers; escape at the view, not the runtime.
				throw new \InvalidArgumentException( \rtrim( self::unknown_source( $registry, $name ), "\n" ) );
			}
			$reader = self::open_tail( $registry[ $name ] );
		} else {
			$reader = new Consumer_Node();
			$reader->arguments( [ Log_Discovery::dir_of( $log ) ] );
		}
		$reader->set_stamp_as( $log );
		return $reader;
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
	 * The teaching error for the first `sources/<name>` subscription the
	 * registry lacks, or null when every one resolves. A stream checks this
	 * before it opens, so a spoke without the source refuses the whole
	 * request with a reason the hub can show, rather than failing mid-stream.
	 *
	 * @param list<string> $subs Subscription names.
	 * @return string|null The error, or null.
	 */
	public static function unknown_in( array $subs ): ?string {
		$prefix   = Log_Discovery::SOURCES_PREFIX . '/';
		$registry = null;
		foreach ( $subs as $sub ) {
			if ( \str_starts_with( $sub, $prefix ) ) {
				$registry ??= self::registry();
				$name       = \substr( $sub, \strlen( $prefix ) );
				if ( ! isset( $registry[ $name ] ) ) {
					return \rtrim( self::unknown_source( $registry, $name ), "\n" );
				}
			}
		}
		return null;
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
	 * The built-in family, resolved through the `$builtin_sources` seam so a
	 * test can supply fixtures in place of the host's ini and constants.
	 *
	 * @return array<string,string> Builtin name → absolute path.
	 */
	private static function builtin_entries(): array {
		$resolve = self::$builtin_sources ?? static function (): array {
			$sources = [];
			$php     = \ini_get( 'error_log' );
			// Only a real file: 'syslog' and an empty setting aren't tailable.
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

	/** Whether $template carries a partition token in either spelling `resolve_partition_template` accepts. */
	private static function has_partition_token( string $template ): bool {
		return \str_contains( $template, '<partition>' ) || \str_contains( $template, '{partition}' );
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
	 * The position is a `MAGIC_POSITIONS` word, or `<segment>:<offset>` with an
	 * optional trailing `:<length>` that is tolerated and IGNORED, because the
	 * reader knows the record's real length. The `cursor` returned is the
	 * POST-step position, exactly where the next step resumes.
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
	 * @return array{source:string,message:array<array-key,mixed>,cursor:array{segment:int,offset:int},at_eof:bool}|string The record and its cursor, or a teaching error.
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
}
