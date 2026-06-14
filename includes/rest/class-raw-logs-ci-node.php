<?php
/**
 * Raw_Logs_CI: command-dispatch for the Raw Logs dashboard.
 *
 * Verbs:
 *   list_logs  — args `{}`. Sorted catalog of subscribable log files,
 *                derived from `{base}/logs/*.log/` via `Log_Discovery::on_disk`.
 *   log_status — args `{log:string?}`. Per-partition segment metadata
 *                (size, count); unknown keys fall through to the
 *                preferred-when-present, else first-discovered log.
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
	/** Preferred log key when the operator's `log` arg is missing or unknown. */
	private const PREFERRED_LOG_KEY = 'firehose';

	/**
	 * Probe-wiring observation seam. Lazily-defaulted to null; the log_status
	 * handler invokes it (when set) with each per-partition inspection Partition
	 * right after naming + patron + sink, before it reads segments and is removed.
	 * Tests reassign it to capture that the sibling got the Rule-2 treatment
	 * without faking the rest of the handler.
	 *
	 * Signature: `function ( Partition_Node $probe ): void`.
	 *
	 * @var \Closure|null
	 */
	public static ?\Closure $on_probe = null;

	/**
	 * Map an inbound log argument to a known catalog key. Strips a `.log`
	 * suffix and falls through to `PREFERRED_LOG_KEY` when present, else the
	 * first-discovered log.
	 */
	private static function resolve_log_key( string $log ): string {
		$keys = Log_Discovery::on_disk();
		if ( empty( $keys ) ) {
			return self::PREFERRED_LOG_KEY;
		}
		$index   = \array_flip( $keys );
		$default = isset( $index[ self::PREFERRED_LOG_KEY ] ) ? self::PREFERRED_LOG_KEY : $keys[0];
		if ( '' === $log ) {
			return $default;
		}
		$key = \str_replace( '.log', '', $log );
		return isset( $index[ $key ] ) ? $key : $default;
	}

	public static function node_schema(): array {
		return [
			'category'    => 'Service',
			'description' => 'Log inspection: catalog on-disk logs and report a log\'s partition/segment status.',
			'arguments'        => [],
			'commands'       => [
				[
					'name'        => 'list_logs',
					'description' => 'List the on-disk log keys.',
					'args'        => [],
					'handler'     => static function ( Command_Interpreter_Node $self, string $args, array $envelope = [] ): array {
						self::require_manage_options();
						$result = [];
						foreach ( Log_Discovery::on_disk() as $key ) {
							$result[] = [
								'key'   => $key,
								'label' => "{$key}.log",
							];
						}
						return $result;
					},
				],
				[
					'name'        => 'log_status',
					'description' => 'Per-partition segment counts and sizes for a log (defaults to the preferred/first-discovered log).',
					'args'        => [ [ 'name' => 'log', 'type' => 'string', 'required' => false ] ],
					'handler'     => static function ( Command_Interpreter_Node $self, string $args ): array {
						self::require_manage_options();
						$log_key = self::resolve_log_key( \trim( $args ) );

						$config         = RuntimeConfig::load_config();
						$base_dir       = RuntimeConfig::get_base_directory();
						$cfg_np         = $config['num_partitions'] ?? 1;
						$num_partitions = (int) ( \is_scalar( $cfg_np ) ? $cfg_np : 1 );
						$log_file       = "{$log_key}.log";
						$log_base       = $base_dir . '/logs';

						$partitions     = [];
						$total_size     = 0;
						$total_segments = 0;
						$ci = Core::node( Node_Names::COMMAND_INTERPRETER );
						for ( $p = 0; $p < $num_partitions; $p++ ) {
							// Sibling plumbing: name + patron + sink the transient probe, read, then remove.
							$partition        = new Partition_Node();
							$partition->name( "{$self->name()}:status:p{$p}" );
							$partition->patron( $self );
							if ( null === $partition->sink() && null !== $ci ) {
								$partition->sink( $ci );
							}
							$partition->arguments( "{$log_base}/{$log_file}/p{$p}" );
							// finally so a throwing probe/read can't leave the named node registered (it would collide on the next call in a long-lived worker).
							try {
								if ( null !== self::$on_probe ) {
									( self::$on_probe )( $partition );
								}
								$segments         = $partition->get_segments( true );
								$size             = \array_sum( \array_column( $segments, 'size' ) );
								$partitions[ $p ] = [
									'segments'      => $segments,
									'segment_count' => \count( $segments ),
									'size'          => $size,
								];
								$total_size      += $size;
								$total_segments  += \count( $segments );
							} finally {
								$partition->remove_node();
							}
						}

						return [
							'log_id'         => $log_key,
							'log_file'       => $log_file,
							'num_partitions' => $num_partitions,
							'partitions'     => $partitions,
							'total_segments' => $total_segments,
							'total_size'     => $total_size,
						];
					},
				],
			],
		];
	}
}
