<?php
/**
 * Raw_Logs_CI: command-dispatch for the Raw Logs dashboard.
 *
 * Verbs:
 *   firehose_logs   — args `{}`. Sorted catalog of subscribable log files,
 *                     derived from `{base}/logs/*.log/` via `Log_Discovery::on_disk`.
 *   firehose_status — args `{log:string?}`. Per-partition segment metadata
 *                     (size, count); unknown keys fall through to `firehose.log`.
 *
 * Both read substrate state only; live SSE tailing happens via SSE_Out.
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes\Rest;

use Newspack_Nodes\Command_Interpreter_Node;
use Newspack_Nodes\Config as RuntimeConfig;
use Newspack_Nodes\Log_Discovery;
use Newspack_Nodes\Partition_Node;
use Newspack_Nodes\Service_CI_Node;

\defined( 'ABSPATH' ) || exit;

class Raw_Logs_CI_Node extends Service_CI_Node {

	/** Fallback log key when the operator's `log` arg is missing or unknown. */
	private const DEFAULT_LOG_KEY = 'firehose';

	public static function node_schema(): array {
		return [
			'category'    => 'Service',
			'description' => 'Firehose log inspection: catalog on-disk logs and report a log\'s partition/segment status.',
			'ctor'        => [],
			'verbs'       => [
				[ 'name' => 'firehose_logs', 'description' => 'List the on-disk firehose log keys.', 'args' => [] ],
				[
					'name'        => 'firehose_status',
					'description' => 'Per-partition segment counts and sizes for a log (defaults to firehose).',
					'args'        => [ [ 'name' => 'log', 'type' => 'string', 'required' => false ] ],
				],
			],
		];
	}

	public function __construct() {
		$this->commands(
			[
				'firehose_logs'   => static function ( Command_Interpreter_Node $self, string $args, array $envelope = [] ): array {
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
				'firehose_status' => static function ( Command_Interpreter_Node $self, string $args ): array {
					self::require_manage_options();
					$log_key = self::resolve_log_key( \trim( $args ) );

					$config         = RuntimeConfig::load_config();
					$base_dir       = (string) ( $config['base_directory'] ?? '/tmp/newspack-nodes' );
					$num_partitions = (int) ( $config['num_partitions'] ?? 1 );
					$log_file       = "{$log_key}.log";
					$log_base       = $base_dir . '/logs';

					$partitions     = [];
					$total_size     = 0;
					$total_segments = 0;
					for ( $p = 0; $p < $num_partitions; $p++ ) {
						$partition        = new Partition_Node( "{$log_base}/{$log_file}", $p );
						$segments         = $partition->get_segments( true );
						$size             = (int) \array_sum( \array_column( $segments, 'size' ) );
						$partitions[ $p ] = [
							'segments'      => $segments,
							'segment_count' => \count( $segments ),
							'size'          => $size,
						];
						$total_size      += $size;
						$total_segments  += \count( $segments );
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
			]
		);
	}

	/**
	 * Map an inbound log argument to a known catalog key. Strips a `.log`
	 * suffix and falls through to `DEFAULT_LOG_KEY` (or the first discovered
	 * log if `firehose.log` doesn't exist for any reason).
	 */
	private static function resolve_log_key( string $log ): string {
		$keys = Log_Discovery::on_disk();
		if ( empty( $keys ) ) {
			return self::DEFAULT_LOG_KEY;
		}
		$index   = \array_flip( $keys );
		$default = isset( $index[ self::DEFAULT_LOG_KEY ] ) ? self::DEFAULT_LOG_KEY : $keys[0];
		if ( '' === $log ) {
			return $default;
		}
		$key = \str_replace( '.log', '', $log );
		return isset( $index[ $key ] ) ? $key : $default;
	}
}
