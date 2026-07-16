<?php
/**
 * Ingest_CLI_Command: `wp nodes ingest` — replay packed partition segment
 * records back through a Topic onto disk.
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes;

\defined( 'ABSPATH' ) || exit;

class Ingest_CLI_Command {

	/**
	 * STDIN-resource seam. Defaults to the real \STDIN; tests reassign to a
	 * php://memory stream of packed records to exercise the piped-ingest branch
	 * without a real pipe.
	 *
	 * @var (\Closure(): resource)|null
	 */
	public static ?\Closure $stdin_provider = null;

	/**
	 * Replay packed segment records back through a Topic onto disk.
	 *
	 * Reads each file line-by-line, unpacks every packed record, and runs it through
	 * Topic::fill() — re-partitioning by the record's KEY (records pinned via their
	 * original TO honor that pin) and appending to the destination segments.
	 *
	 * ## OPTIONS
	 *
	 * <topic>
	 * : Destination. Either a dir-template carrying a {partition}/<partition> token
	 *   (e.g. <config:logs_dir>/firehose.p<partition>), used verbatim; or a bare log
	 *   name (e.g. firehose), expanded to <config:logs_dir>/<name>.p<partition>.
	 *
	 * [<file>...]
	 * : One or more packed segment files to replay. Omit to read packed records from
	 *   stdin instead (e.g. piping a filtered `wp nodes reqgrep` or `zcat` output).
	 *
	 * [--num_partitions=<n>]
	 * : Destination partition count. Defaults to the global config num_partitions
	 *   (or 1 for an explicit dir-template).
	 *
	 * [--segment_size=<bytes>]
	 * : Destination segment size in bytes. Defaults to the Partition default.
	 *
	 * [--max_segments=<n>]
	 * : Destination segment-retention count (the COUNT rule). Defaults to the Partition default.
	 *
	 * [--allow_large_writes]
	 * : Lift the 4KB PIPE_BUF cap to 10MB via a held per-partition write lock.
	 *
	 * [--void_warranty]
	 * : Lift the 4KB cap to 10MB with NO lock (caller asserts single-writer).
	 *
	 * [--dry-run]
	 * : Sample record sizes and report whether a large-write flag is needed; write nothing.
	 *
	 * ## EXAMPLES
	 *
	 *     # Re-segment topicprobe.p0 down to 1 MiB segments
	 *     wp nodes ingest '<config:logs_dir>/topicprobe.p<partition>' topicprobe.p0.old/*.log --num_partitions=1 --segment_size=1048576 --max_segments=2
	 *
	 *     # Dry-run a firehose replay to check for oversize records
	 *     wp nodes ingest firehose firehose.p0.old/*.log --dry-run
	 *
	 * @when after_wp_load
	 *
	 * @param array<int, string>   $args       Positional: <topic> then one or more files.
	 * @param array<string, mixed> $assoc_args --num_partitions / --segment_size / --max_segments / --allow_large_writes / --void_warranty / --dry-run.
	 */
	public function ingest( array $args, array $assoc_args ): void {
		Bootstrap::ensure_runtime_wired();

		$topic_arg = $args[0] ?? '';
		$files     = \array_slice( $args, 1 );
		$dry_run   = isset( $assoc_args['dry-run'] );
		$lock      = isset( $assoc_args['allow_large_writes'] );
		$void      = isset( $assoc_args['void_warranty'] );

		if ( $lock && $void ) {
			\WP_CLI::error( 'Pass at most one of --allow_large_writes or --void_warranty.' );
		}
		if ( '' === $topic_arg ) {
			\WP_CLI::error( 'Usage: wp nodes ingest <topic> [<file>...]' );
		}

		$stdin_mode = empty( $files );
		$stdin      = ( self::$stdin_provider ?? static fn () => \STDIN )();
		if ( $stdin_mode && \function_exists( 'posix_isatty' ) && @\posix_isatty( $stdin ) ) {
			\WP_CLI::error( 'Provide <file>... or pipe packed records on stdin.' );
		}
		if ( ! $stdin_mode ) {
			foreach ( $files as $file ) {
				// is_file rejects a DIR passed as a file (fopen reads nothing).
				if ( ! \is_file( $file ) || ! \is_readable( $file ) ) {
					\WP_CLI::error( "Cannot read file: {$file}" );
				}
			}
		}

		$np_raw = $assoc_args['num_partitions'] ?? null;
		if ( null !== $np_raw && ! \is_numeric( $np_raw ) ) {
			\WP_CLI::error( '--num_partitions must be an integer.' );
		}
		$requested = \is_numeric( $np_raw ) ? (int) $np_raw : null;
		[ $tpl, $num_partitions ] = $this->resolve_destination( $topic_arg, $requested );

		// Geometry defaults to Partition's; retention is by COUNT alone.
		$segment_size = $this->int_flag( $assoc_args, 'segment_size', Partition_Node::DEFAULT_SEGMENT_SIZE );
		$max_segments = $this->int_flag( $assoc_args, 'max_segments', Partition_Node::DEFAULT_MAX_SEGMENTS );

		\WP_CLI::log( "Destination: {$tpl} ({$num_partitions} partition(s), {$segment_size}-byte segments)" );

		// >4KB records hit PIPE_BUF; the cap rises to 10MB only on opt-in.
		$cap = ( $lock || $void ) ? Partition_Node::MAX_LARGE_LINE_SIZE : Partition_Node::MAX_LINE_SIZE;

		$topic = null;
		if ( ! $dry_run ) {
			$topic = new Topic_Node();
			// Lifetimes 0: an inherited floor makes --max_segments a no-op.
			$topic->arguments( \array_map( '\strval', [
				$tpl,
				$num_partitions,
				$segment_size,
				Partition_Node::DEFAULT_MIN_SEGMENTS,
				$max_segments,
				0,
				0,
			] ) );
			if ( $lock ) {
				$topic->allow_large_writes();
			} elseif ( $void ) {
				$topic->void_warranty();
			}
		}

		$stats = [
			'ingested'    => 0,
			'unparseable' => 0,
			'oversize'    => 0,
			'max_size'    => 0,
		];
		if ( $stdin_mode ) {
			// Batch replay: eof_deadline 0 → self-exits when stdin closes.
			$src = new Stdin_Node( $stdin, 0.0 );
			$src->sink( new Callback_Node(
				function ( array $message ) use ( $topic, $cap, &$stats ): void {
					$this->ingest_record( Core::as_string( $message[ Message::VALUE ] ), $topic, $cap, $stats );
				}
			) );
			while ( ! $src->exit ) {
				$src->fire();
			}
		} else {
			foreach ( $files as $file ) {
				// phpcs:ignore WordPress.WP.AlternativeFunctions.file_system_operations_fopen, WordPressVIPMinimum.Functions.RestrictedFunctions.file_ops_fopen
				$fh = \fopen( $file, 'r' );
				if ( false === $fh ) {
					\WP_CLI::error( "Cannot open file: {$file}" );
					continue; // WP_CLI::error exits; narrows $fh below.
				}
				while ( false !== ( $line = \fgets( $fh ) ) ) {
					$this->ingest_record( $line, $topic, $cap, $stats );
				}
				// phpcs:ignore WordPress.WP.AlternativeFunctions.file_system_operations_fclose
				\fclose( $fh );
			}
		}
		if ( null !== $topic ) {
			// Flush, then remove_node() to close handles + free the write lock.
			$topic->flush();
			$topic->remove_node();
		}

		$this->report( $dry_run, $stats, $lock || $void );
	}

	/**
	 * Resolve the <topic> argument to [dir_template, num_partitions].
	 *
	 * Explicit form (carries a {partition}/<partition> token): trust the operator —
	 * resolve config tokens, default count to 1. Shortname form: expand to
	 * <config:logs_dir>/<name>.p{partition} with the count from --num_partitions, or
	 * the global config num_partitions when not given.
	 *
	 * @return array{0:string,1:int}
	 */
	private function resolve_destination( string $topic_arg, ?int $requested ): array {
		$has_token = \str_contains( $topic_arg, '{partition}' ) || \str_contains( $topic_arg, '<partition>' );

		if ( $has_token ) {
			$tpl = \str_replace( '<partition>', '{partition}', Core::resolve_config_tokens( $topic_arg ) );
			return [ $tpl, \max( 1, $requested ?? 1 ) ];
		}

		$count = \max( 1, $requested ?? self::config_num_partitions() );
		$logs  = Core::resolve_config_tokens( '<config:logs_dir>' );
		return [ "{$logs}/{$topic_arg}.p{partition}", $count ];
	}

	/** Global config num_partitions (the operator default), clamped to >= 1. */
	private static function config_num_partitions(): int {
		$raw = Config::value( 'num_partitions' );
		return \max( 1, Core::as_int( $raw, 1 ) );
	}

	/**
	 * Parse an optional integer flag, defaulting when absent and erroring on a non-numeric value.
	 *
	 * @param array<string, mixed> $assoc_args
	 */
	private function int_flag( array $assoc_args, string $key, int $default ): int {
		$raw = $assoc_args[ $key ] ?? null;
		if ( null === $raw ) {
			return $default;
		}
		if ( ! \is_numeric( $raw ) ) {
			\WP_CLI::error( "--{$key} must be an integer." );
		}
		// is_scalar narrows the cast; is_numeric already rejected non-nums.
		return Core::as_int( $raw );
	}

	/**
	 * Unpack, size-check, and (unless dry-run) fill one packed line into the destination topic.
	 *
	 * @param array{ingested:int,unparseable:int,oversize:int,max_size:int} $stats Accumulated per-record counts, updated in place.
	 */
	private function ingest_record( string $line, ?Topic_Node $topic, int $cap, array &$stats ): void {
		$line = \rtrim( $line, "\n" );
		if ( '' === $line ) {
			return;
		}
		try {
			$message = Message::unpacked( $line );
		} catch ( \InvalidArgumentException $e ) {
			++$stats['unparseable'];
			return;
		}
		$size              = \strlen( Message::packed( $message ) ) + 1;
		$stats['max_size'] = \max( $stats['max_size'], $size );
		if ( $size > $cap ) {
			++$stats['oversize'];
			return;
		}
		if ( null !== $topic ) {
			$topic->fill( $message );
		}
		++$stats['ingested'];
	}

	/**
	 * Emit the run summary: dry-run advises on large-write flags; a real run reports what landed and what was skipped.
	 *
	 * @param array{ingested:int,unparseable:int,oversize:int,max_size:int} $stats Accumulated per-record counts.
	 */
	private function report( bool $dry_run, array $stats, bool $large_enabled ): void {
		$cap = Partition_Node::MAX_LINE_SIZE;
		if ( $stats['unparseable'] > 0 ) {
			\WP_CLI::warning( "Skipped {$stats['unparseable']} unparseable line(s)." );
		}

		if ( $dry_run ) {
			\WP_CLI::log( "Dry run: {$stats['ingested']} record(s) would be ingested; largest record {$stats['max_size']} bytes." );
			if ( $stats['oversize'] > 0 ) {
				\WP_CLI::warning(
					"{$stats['oversize']} record(s) exceed {$cap} bytes — re-run with "
					. '--allow_large_writes (locked) or --void_warranty (no lock) to include them.'
				);
			} else {
				\WP_CLI::log( "All records within the {$cap}-byte PIPE_BUF cap; no large-write flag needed." );
			}
			return;
		}

		if ( $stats['oversize'] > 0 && ! $large_enabled ) {
			\WP_CLI::warning(
				"Skipped {$stats['oversize']} oversize record(s) (> {$cap} bytes); "
				. 're-run with --allow_large_writes or --void_warranty to include them.'
			);
		}
		\WP_CLI::success( "Ingested {$stats['ingested']} record(s)." );
	}
}
