<?php
/**
 * Ingest_CLI_Command: `wp nodes ingest` — replay packed partition-segment
 * records back through a Topic onto disk.
 *
 * This is the read side of everything a Partition set aside: the `:deadletter`
 * quarantine a poison handler filled, the messages a write stall could not
 * land, a segment directory moved out of the way. Records go back in through
 * `Topic_Node::fill()` rather than as appended bytes, so each one re-partitions
 * against the destination's geometry and that geometry's rotation and
 * retention rules apply. Re-segmenting a log whose `segment_size` or partition
 * count changed is the same operation.
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes;

\defined( 'ABSPATH' ) || exit;

class Ingest_CLI_Command {

	/**
	 * Stdin-handle seam, standing in for the `\STDIN` constant. Lazily
	 * defaulted at the call site; tests reassign it to a `php://memory` stream
	 * of packed records, which exercises the piped-ingest branch without a real
	 * pipe and without a TTY the interactive guard would refuse.
	 *
	 * @var (\Closure(): resource)|null
	 */
	public static ?\Closure $stdin_provider = null;

	/**
	 * Replay packed segment records back through a Topic onto disk.
	 *
	 * Reads each source line by line — the named files, or stdin when none are
	 * named — unpacks every record and runs it through `Topic_Node::fill()`,
	 * which picks the destination partition three ways: a record whose TO pins
	 * a `p<N>` keeps that pin, one carrying a KEY hashes by KEY, and one with
	 * neither lands round-robin. A line that will not unpack is counted and
	 * skipped, so a torn record at a segment's tail cannot abandon the replay.
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
	 * : Destination segment size in bytes. Defaults to the global config segment_size.
	 *
	 * [--num_segments=<n>]
	 * : Destination segment-retention count target (the COUNT rule). Defaults to the global config num_segments.
	 *
	 * [--allow_large_writes]
	 * : Lift the 4KB PIPE_BUF cap to 32 MiB via a held per-partition write lock.
	 *
	 * [--void_warranty]
	 * : Lift the 4KB cap to 32 MiB with NO lock (caller asserts single-writer).
	 *
	 * [--dry-run]
	 * : Sample record sizes and report whether a large-write flag is needed; write nothing.
	 *
	 * ## EXAMPLES
	 *
	 *     # Re-segment topicprobe.p0 down to 1 MiB segments
	 *     wp nodes ingest '<config:logs_dir>/topicprobe.p<partition>' topicprobe.p0.old/*.log --num_partitions=1 --segment_size=1048576 --num_segments=2
	 *
	 *     # Dry-run a firehose replay to check for oversize records
	 *     wp nodes ingest firehose firehose.p0.old/*.log --dry-run
	 *
	 *     # Replay a filtered slice piped from another tool
	 *     zcat firehose.p0.old/3.log.gz | wp nodes ingest firehose
	 *
	 * @when after_wp_load
	 *
	 * @param array<int,string>   $args       Positional: <topic>, then zero or more files; none means stdin.
	 * @param array<string,mixed> $assoc_args --num_partitions / --segment_size / --num_segments / --allow_large_writes / --void_warranty / --dry-run.
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

		// A geometry of zero is a topic that stores nothing; refuse it too.
		$requested                = CLI::require_flag_int( $assoc_args, 'num_partitions', null, false );
		[ $tpl, $num_partitions ] = $this->resolve_destination( $topic_arg, $requested );

		// Every geometry default is the config key the Topic schema names.
		$segment_size = CLI::require_flag_int( $assoc_args, 'segment_size', self::config_int( 'segment_size', Partition_Node::DEFAULT_SEGMENT_SIZE ), false );
		$num_segments = CLI::require_flag_int( $assoc_args, 'num_segments', self::config_int( 'num_segments', Partition_Node::DEFAULT_NUM_SEGMENTS ), false );

		\WP_CLI::log( "Destination: {$tpl} ({$num_partitions} partition(s), {$segment_size}-byte segments)" );

		// >4KB records hit PIPE_BUF; the cap rises to 32 MiB only on opt-in.
		$cap = ( $lock || $void ) ? Partition_Node::MAX_LARGE_LINE_SIZE : Partition_Node::MAX_LINE_SIZE;

		$topic = null;
		if ( ! $dry_run ) {
			$topic = new Topic_Node();
			// min_lifetime 0 makes the count rule prune to num_segments.
			$topic->arguments( \array_map( '\strval', [
				$tpl,
				$num_partitions,
				$segment_size,
				Partition_Node::DEFAULT_MIN_SEGMENTS,
				$num_segments,
				Partition_Node::DEFAULT_MAX_SEGMENTS,
				Partition_Node::DEFAULT_MIN_LIFETIME,
				Partition_Node::DEFAULT_LIFETIME,
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
		foreach ( $this->open_sources( $stdin_mode, $stdin, $files ) as [ $fh, $owned ] ) {
			while ( false !== ( $line = \fgets( $fh ) ) ) {
				$this->ingest_record( $line, $topic, $cap, $stats );
			}
			if ( $owned ) {
				// phpcs:ignore WordPress.WP.AlternativeFunctions.file_system_operations_fclose
				\fclose( $fh );
			}
		}
		if ( null !== $topic ) {
			// Flush, then remove_node() to close handles + free the write lock.
			$topic->flush();
			$topic->remove_node();
		}

		$this->report( $dry_run, $stats, $cap );
	}

	/**
	 * Emit the run summary: a dry run advises on large-write flags; a real run
	 * reports what landed and what was skipped.
	 *
	 * The dry run always judges against the PIPE_BUF cap, whatever cap was in
	 * EFFECT, because the question it exists to answer is "do I need the flag?"
	 * — and a run made WITH the flag measures oversize against 32 MiB, so it
	 * cannot answer that from `$stats['oversize']`. It reads `max_size`, which
	 * is cap-independent.
	 *
	 * @param bool                                                          $dry_run Report only.
	 * @param array{ingested:int,unparseable:int,oversize:int,max_size:int} $stats   Accumulated per-record counts.
	 * @param int                                                           $cap     The cap records were measured against.
	 */
	private function report( bool $dry_run, array $stats, int $cap ): void {
		if ( $stats['unparseable'] > 0 ) {
			\WP_CLI::warning( "Skipped {$stats['unparseable']} unparseable line(s)." );
		}

		if ( $dry_run ) {
			$pipe_buf = Partition_Node::MAX_LINE_SIZE;
			\WP_CLI::log( "Dry run: {$stats['ingested']} record(s) would be ingested; largest record {$stats['max_size']} bytes." );
			if ( $stats['max_size'] > $pipe_buf ) {
				\WP_CLI::warning(
					"Record(s) exceed {$pipe_buf} bytes — ingest needs "
					. '--allow_large_writes (locked) or --void_warranty (no lock) to include them.'
				);
			} else {
				\WP_CLI::log( "All records within the {$pipe_buf}-byte PIPE_BUF cap; no large-write flag needed." );
			}
			if ( $stats['oversize'] > 0 ) {
				\WP_CLI::warning( "{$stats['oversize']} record(s) exceed even the {$cap}-byte cap and cannot be ingested." );
			}
			return;
		}

		if ( $stats['oversize'] > 0 ) {
			// At the large cap the flags are already on.
			$advice = Partition_Node::MAX_LARGE_LINE_SIZE === $cap
				? 'they exceed the largest record a partition can store.'
				: 're-run with --allow_large_writes or --void_warranty to include them.';
			\WP_CLI::warning( "Skipped {$stats['oversize']} oversize record(s) (> {$cap} bytes); {$advice}" );
		}
		\WP_CLI::success( "Ingested {$stats['ingested']} record(s)." );
	}

	/**
	 * Unpack, size-check, and — outside a dry run — fill one packed line into
	 * the destination topic.
	 *
	 * The size checked is what THIS process would write, `Message::packed()`
	 * plus the newline Partition appends, rather than `strlen( $line )`. The
	 * destination re-packs the message, so the source line's own byte count is
	 * the wrong number to hold against the cap.
	 *
	 * `max_size` is recorded before the cap check, which is what lets a dry run
	 * report a record it would have skipped.
	 *
	 * @param string                                                        $line  One packed frame, with or without its trailing newline.
	 * @param Topic_Node|null                                               $topic Destination, null on a dry run.
	 * @param int                                                           $cap   Largest record the destination accepts, in bytes.
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
	 * The handles to replay, each paired with whether this command owns it,
	 * yielded one at a time so a file opens only as the previous one closes —
	 * a whole-log replay (`wp nodes ingest firehose logs/firehose.p0/*.log`) is
	 * a few hundred segments, and opening them all up front exhausts `ulimit -n`
	 * and dies as a "Cannot open file" that reads like a permissions problem.
	 *
	 * Stdin is the single-element case of the file list, read the same blocking
	 * way. That matters: a pipe (`zcat big.gz | wp nodes ingest …`) hands out
	 * whatever bytes are buffered, so a non-blocking `fgets` returns a record
	 * straddling the boundary as two fragments — both unparseable, both dropped.
	 * Blocking, `fgets` waits for the newline. Stdin belongs to the caller, so
	 * it is never closed here.
	 *
	 * @param bool         $stdin_mode Read stdin instead of a file list.
	 * @param resource     $stdin      The stdin stream.
	 * @param list<string> $files      Packed segment files, empty in stdin mode.
	 *
	 * @return \Generator<int,array{0:resource,1:bool}> Handle + whether to fclose it.
	 */
	private function open_sources( bool $stdin_mode, $stdin, array $files ): \Generator {
		if ( $stdin_mode ) {
			\stream_set_blocking( $stdin, true );
			yield [ $stdin, false ];
			return;
		}
		foreach ( $files as $file ) {
			// phpcs:ignore WordPress.WP.AlternativeFunctions.file_system_operations_fopen, WordPressVIPMinimum.Functions.RestrictedFunctions.file_ops_fopen
			$fh = \fopen( $file, 'r' );
			if ( false === $fh ) {
				\WP_CLI::error( "Cannot open file: {$file}" );
				continue; // WP_CLI::error exits; narrows $fh below.
			}
			yield [ $fh, true ];
		}
	}

	/**
	 * Resolve the <topic> argument to [dir_template, num_partitions].
	 *
	 * Explicit form (carries a {partition}/<partition> token): resolve the
	 * config tokens and default the count to 1. There is no declared-set lookup
	 * and no mismatch check, because the template names a layout the operator
	 * already has on disk. Shortname form: expand to
	 * <config:logs_dir>/<name>.p{partition} with the count from
	 * --num_partitions, or the global config num_partitions when not given.
	 *
	 * @param string   $topic_arg The <topic> positional, in either form.
	 * @param int|null $requested --num_partitions, or null when the flag is absent.
	 * @return array{0:string,1:int} The dir template and the partition count.
	 */
	private function resolve_destination( string $topic_arg, ?int $requested ): array {
		$has_token = \str_contains( $topic_arg, '{partition}' ) || \str_contains( $topic_arg, '<partition>' );

		if ( $has_token ) {
			$tpl = \str_replace( '<partition>', '{partition}', Core::resolve_config_tokens( $topic_arg ) );
			return [ $tpl, \max( 1, $requested ?? 1 ) ];
		}

		$count = \max( 1, $requested ?? self::config_int( 'num_partitions', 1 ) );
		$logs  = Core::resolve_config_tokens( '<config:logs_dir>' );
		return [ "{$logs}/{$topic_arg}.p{partition}", $count ];
	}

	/**
	 * One operator default per geometry key — the same key `Topic_Node`'s
	 * schema names — falling back to $default when the stored value is not a
	 * number.
	 *
	 * The VALIDATED `num_int` read is what makes that fallback reachable. A
	 * cleared admin field stores '', which `Options_Overlay` treats as PRESENT
	 * and therefore overriding, and a lenient cast turns it into a 0.
	 * `Partition_Node::arguments()` refuses a `segment_size` of 0 outright, so
	 * the lenient read would abort the whole replay on a blank field instead of
	 * falling back to the shipped default.
	 *
	 * @param string $key     Geometry config key: num_partitions, segment_size or num_segments.
	 * @param int    $default Value to use when the stored one is not numeric.
	 * @return int The configured geometry value.
	 */
	private static function config_int( string $key, int $default ): int {
		return Core::num_int( Config::value( $key ), $default );
	}

}
