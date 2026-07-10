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

use Newspack_Nodes\Command_Interpreter_Node;
use Newspack_Nodes\Config as RuntimeConfig;
use Newspack_Nodes\Core;
use Newspack_Nodes\Log_Discovery;
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
	 * `log_status` verb handler — segment counts and sizes for a single concrete partition dir.
	 *
	 * @param Command_Interpreter_Node $self Verb argument.
	 * @param string $args Verb argument.
	 *
	 * @return array<string,mixed>
	 */
	public static function cmd_log_status( Command_Interpreter_Node $self, string $args ): array {
		$log_key  = self::resolve_log_key( \trim( $args ) );
		$base_dir = RuntimeConfig::get_base_directory();
		$log_base = $base_dir . '/logs';

		// Sibling plumbing: name + patron + sink the probe, read, remove.
		$ci        = Core::node( Node_Names::COMMAND_INTERPRETER );
		$partition = new Partition_Node();
		$partition->name( "{$self->name()}:status" );
		$partition->patron( $self );
		if ( null === $partition->sink() && null !== $ci ) {
			$partition->sink( $ci );
		}
		// Flat layout: the concrete dir IS one partition — stat it directly.
		$partition->arguments( "{$log_base}/{$log_key}" );
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
	 * Map an inbound log argument to a known concrete catalog key. Falls through
	 * to a firehose-ish concrete key when present (prefix preference), else the
	 * first-discovered concrete dir.
	 */
	private static function resolve_log_key( string $log ): string {
		$keys = Log_Discovery::on_disk();
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
	 * `list_logs` verb handler — every on-disk log directory as {key,label}.
	 *
	 * @return array<int, mixed>
	 */
	public static function cmd_list_logs(): array {
		$result = [];
		foreach ( Log_Discovery::on_disk() as $key ) {
			$result[] = [
				'key'   => $key,
				'label' => $key,
			];
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
					'handler'     => static fn ( Command_Interpreter_Node $self, string $args, array $envelope = [] ): array => self::cmd_list_logs(),
				],
				[
					'name'        => 'log_status',
					'description' => 'Segment counts and sizes for a single concrete partition dir (defaults to the firehose-ish/first-discovered dir).',
					'args'        => [ [ 'name' => 'log', 'type' => 'string', 'required' => false ] ],
					'handler'     => static fn ( Command_Interpreter_Node $self, string $args ): array => self::cmd_log_status( $self, $args ),
				],
			],
		] );
	}

}
