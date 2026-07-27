<?php
/**
 * Raw_Logs_CI: command-dispatch for the Raw Logs dashboard.
 *
 * Verbs:
 *   list_logs  — args `{}`. Sorted catalog of subscribable concrete partition
 *                dirs (flat layout, e.g. `firehose.p0`), via `Log_Discovery::on_disk`.
 *   log_status — args `{log:string?}`. Single concrete dir's segment metadata
 *                (size, count); unknown keys fall through to the
 *                firehose-ish-when-present, else first-discovered dir.
 *
 * Both read substrate state only; live SSE tailing happens via SSE_Out.
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes\Rest;

use Newspack_Nodes\Callback_Node;
use Newspack_Nodes\Command_Interpreter_Node;
use Newspack_Nodes\Consumer_Node;
use Newspack_Nodes\Config as RuntimeConfig;
use Newspack_Nodes\Core;
use Newspack_Nodes\Log_Discovery;
use Newspack_Nodes\Log_Sources;
use Newspack_Nodes\Message;
use Newspack_Nodes\Node_Names;
use Newspack_Nodes\Partition_Node;
use Newspack_Nodes\Service_CI_Node;

\defined( 'ABSPATH' ) || exit;

class Raw_Logs_CI_Node extends Service_CI_Node {

	/** Preferred log-key prefix when the operator's `log` arg is missing or unknown. */
	private const PREFERRED_LOG_PREFIX = 'firehose';


	/**
	 * Probe-wiring observation seam. Lazily-defaulted to null; the log_status
	 * handler invokes it (when set) with the single inspection Partition right
	 * after naming + patron + sink, before it reads segments and is removed.
	 * Tests reassign it to capture that the sibling got the Rule-2 treatment
	 * without faking the rest of the handler.
	 *
	 * Signature: `function ( Partition_Node $probe ): void`.
	 *
	 * @var \Closure|null
	 */
	public static ?\Closure $on_probe = null;

	/**
	 * `log_status` verb handler — segment counts and sizes for a single concrete
	 * partition dir. Accepts a bare logs key (`firehose.p0`) or a group-prefixed
	 * one (`offsets/…`, `deadletter/…`).
	 *
	 * @param Command_Interpreter_Node $self Verb argument.
	 * @param list<string> $args Verb argument.
	 *
	 * @return array<string,mixed>
	 */
	public static function cmd_log_status( Command_Interpreter_Node $self, array $args ): array {
		$log_key             = self::resolve_log_key( $args[0] ?? '' );
		$base_dir            = RuntimeConfig::get_base_directory();
		[ $group, $dir_key ] = self::split_group( $log_key );
		$log_base            = "{$base_dir}/{$group}";

		// Sibling plumbing: name + patron + sink the probe, read, remove.
		$ci        = Core::node( Node_Names::COMMAND_INTERPRETER );
		$partition = new Partition_Node();
		$partition->name( "{$self->name()}:status" );
		$partition->patron( $self );
		if ( null === $partition->sink() && null !== $ci ) {
			$partition->sink( $ci );
		}
		// Flat layout: the concrete dir IS one partition — stat it directly.
		$partition->arguments( [ "{$log_base}/{$dir_key}" ] );
		// finally: a throw can't leave the node registered (would collide).
		try {
			if ( null !== self::$on_probe ) {
				( self::$on_probe )( $partition );
			}
			$segments = $partition->get_segments( true );
			$size     = \array_sum( \array_column( $segments, 'size' ) );
		} finally {
			$partition->remove_node();
		}

		return [
			'log_id'        => $log_key,
			'segments'      => $segments,
			'segment_count' => \count( $segments ),
			'total_size'    => $size,
		];
	}

	/**
	 * `read_message` verb handler — the single record AT a position, decoded.
	 *
	 * Drives the REAL read model: an ephemeral Consumer (no offsetlog, no DLQ)
	 * seeked to `<segment>:<offset>` and single-stepped via the Durable_Reader
	 * debugger — so segment rolls, torn records, and oversized partials behave
	 * exactly as they do for every other reader, and the emitted record carries
	 * the stamped FROM + `seg:off:len` ID breadcrumb. Length-blind: a supplied
	 * `:<length>` token is tolerated and ignored. The reply's `cursor` is the
	 * post-step position — the exact next-record position for the paused
	 * single-step debugger.
	 *
	 * @param Command_Interpreter_Node $self Verb argument.
	 * @param list<string> $args `[<log key>, <segment>:<offset>[:<length>]]`.
	 *
	 * @return array<string,mixed>|string The record + cursor, or a teaching error.
	 */
	public static function cmd_read_message( Command_Interpreter_Node $self, array $args ): array|string {
		$log_key = self::resolve_log_key( $args[0] ?? '' );
		$position = Core::as_string( $args[1] ?? '' );
		// A magic token rides through to next_offset(), which speaks them.
		$magic   = \in_array( $position, Log_Sources::MAGIC_POSITIONS, true );
		$tokens  = \explode( ':', $position );
		if ( ! $magic
				&& ( \count( $tokens ) < 2 || \count( $tokens ) > 3
					|| ! \ctype_digit( $tokens[0] ) || ! \ctype_digit( $tokens[1] ) ) ) {
			return "read_message: invalid position (want <segment>:<offset>[:<length>], start, recent or end)\n";
		}
		$base_dir            = RuntimeConfig::get_base_directory();
		[ $group, $dir_key ] = self::split_group( $log_key );

		$captured = null;
		$capture  = new Callback_Node( static function ( array $message ) use ( &$captured ): void {
			$captured = $message;
		} );
		$consumer = new Consumer_Node();
		$consumer->sink( $capture );
		$consumer->arguments( [ "{$base_dir}/{$group}/{$dir_key}" ] );
		$consumer->set_stamp_as( $log_key );
		$consumer->next_offset(
			$magic ? $position : [ 'segment' => (int) $tokens[0], 'offset' => (int) $tokens[1] ]
		);
		try {
			$cursor = $consumer->step();
		} finally {
			$consumer->remove_node();
		}
		if ( null === $captured ) {
			return "read_message: no record at {$log_key} {$position}\n";
		}
		return [
			'log_id'  => $log_key,
			'message' => $captured,
			'cursor'  => [
				'segment' => $cursor['segment'],
				'offset'  => $cursor['offset'],
			],
			'at_eof'  => $cursor['at_eof'],
		];
	}

	/**
	 * Map an inbound log argument to a known concrete catalog key. Falls through
	 * to a firehose-ish concrete key when present (prefix preference), else the
	 * first-discovered concrete dir. Catalog keys are bare logs basenames plus
	 * `{group}/{basename}` for the offsets and deadletter roots.
	 */
	private static function resolve_log_key( string $log ): string {
		$keys = \array_column( self::catalog_keys(), 'key' );
		if ( empty( $keys ) ) {
			return self::PREFERRED_LOG_PREFIX;
		}
		$default = $keys[0];
		foreach ( $keys as $key ) {
			if ( \str_starts_with( $key, self::PREFERRED_LOG_PREFIX ) ) {
				$default = $key;
				break;
			}
		}
		if ( '' === $log ) {
			return $default;
		}
		return \in_array( $log, $keys, true ) ? $log : $default;
	}

	/**
	 * Split a catalog key into its root group + dir basename (bare = logs).
	 *
	 * @return array{0: string, 1: string}
	 */
	private static function split_group( string $key ): array {
		$slash = \strpos( $key, '/' );
		if ( false === $slash ) {
			return [ 'logs', $key ];
		}
		return [ \substr( $key, 0, $slash ), \substr( $key, $slash + 1 ) ];
	}

	/**
	 * `list_logs` verb handler — every on-disk partition dir as {key,label}:
	 * bare logs keys, then `offsets/…` and `deadletter/…`.
	 *
	 * @return array<int, mixed>
	 */
	public static function cmd_list_logs(): array {
		return self::catalog_keys();
	}

	/** @return list<array{key: string, label: string}> The full grouped catalog. */
	private static function catalog_keys(): array {
		$result = [];
		foreach ( Log_Discovery::groups() as $group => $names ) {
			foreach ( $names as $name ) {
				$key      = 'logs' === $group ? $name : "{$group}/{$name}";
				$result[] = [
					'key'   => $key,
					'label' => $key,
				];
			}
		}
		return $result;
	}

	public static function node_schema(): array {
		return \array_merge( parent::node_schema(), [
			'category'    => 'Service',
			'description' => 'Log inspection: catalog on-disk logs and report a log\'s partition/segment status.',
			'arguments'   => [],
			'commands'    => [
				[
					'name'        => 'list_logs',
					'description' => 'List the on-disk log keys.',
					'args'        => [],
					'handler'     => static fn ( Command_Interpreter_Node $self, array $args, array $envelope = [] ): array => self::cmd_list_logs(),
				],
				[
					'name'        => 'log_status',
					'description' => 'Segment counts and sizes for a single concrete partition dir (defaults to the firehose-ish/first-discovered dir).',
					'args'        => [ [ 'name' => 'log', 'type' => 'string', 'required' => false ] ],
					'handler'     => static fn ( Command_Interpreter_Node $self, array $args ): array => self::cmd_log_status( $self, self::arg_strings( $args ) ),
				],
				[
					'name'        => 'read_message',
					'description' => 'The single decoded record at <segment>:<offset> (a trailing :<length> is ignored); replies with the record + its consumed length.',
					'args'        => [
						[ 'name' => 'log', 'type' => 'string', 'required' => true ],
						[ 'name' => 'position', 'type' => 'string', 'required' => true ],
					],
					'handler'     => static fn ( Command_Interpreter_Node $self, array $args ): array|string => self::cmd_read_message( $self, self::arg_strings( $args ) ),
				],
			],
		] );
	}

}
