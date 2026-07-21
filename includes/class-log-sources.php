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

	/**
	 * Whether $name is a legal registry name: the SSE-subscription charset,
	 * no `..`, and not the `sources` word `taillog` reserves for its struct verb.
	 */
	public static function is_valid_name( string $name ): bool {
		if ( 'sources' === $name || \str_contains( $name, '..' ) ) {
			return false;
		}
		return 1 === \preg_match( self::NAME_PATTERN, $name );
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
		$newest = null;
		$top    = -1;
		foreach ( self::segment_files( $entry['path'] ) as $file ) {
			$dot = \strrpos( $file, '.' );
			if ( false === $dot ) {
				continue; // Glob guarantees a dot; typed guard for the narrower.
			}
			$seg = (int) \substr( $file, $dot + 1 );
			if ( $seg > $top ) {
				$top    = $seg;
				$newest = $file;
			}
		}
		return $newest;
	}

	/** @return array<int, string> The on-disk `{path}.{seg}` segment files. */
	private static function segment_files( string $path ): array {
		$segments = \glob( $path . '.[0-9]*' );
		return \is_array( $segments ) ? $segments : [];
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
}
