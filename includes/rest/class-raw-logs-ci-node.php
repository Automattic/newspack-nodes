<?php
/**
 * Raw_Logs_CI: the read-only inspection surface behind the Raw Logs dashboard.
 *
 * The dashboard asks three questions and gets one verb each: which partition
 * directories and registry sources exist (`list_logs`), how much one of them
 * holds (`dump_log`), and what the record at a given position decodes to
 * (`read_message`). A fourth, `read_block`, returns the records from a
 * position up to one block. Every verb reads substrate state; none writes.
 * Live tailing belongs to `SSE_Out_Node`, not to this interpreter.
 *
 * A `log` no dir or registry entry carries is refused, never defaulted: a
 * paused step handed another log's record would read the wrong stream.
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes\Rest;

use Newspack_Nodes\Capabilities;
use Newspack_Nodes\Command_Interpreter_Node;
use Newspack_Nodes\Core;
use Newspack_Nodes\Log_Discovery;
use Newspack_Nodes\Log_Sources;
use Newspack_Nodes\Service_CI_Node;

\defined( 'ABSPATH' ) || exit;

/**
 * The `raw-logs` service interpreter: four READ verbs over on-disk partitions.
 *
 * Each verb declares `Capabilities::READ` in `node_schema()`, and
 * `dispatch()` refuses a caller below it (ADR-26). Nothing here writes, so
 * nothing here asks for a heavier role.
 */
class Raw_Logs_CI_Node extends Service_CI_Node {

	/**
	 * `list_logs` verb handler — the catalog the dashboard's log picker mounts.
	 * A row that names no log carries no `key`.
	 *
	 * @return list<array{key?:string,label:string,available:bool,error?:string}>
	 */
	public static function cmd_list_logs(): array {
		return [ ...self::catalog_keys(), ...Log_Sources::catalog() ];
	}

	/**
	 * Every on-disk partition directory as a `{key,label,available}` row, `logs`
	 * first, then `offsets` and `deadletter`, keyed by the stamp
	 * `Log_Discovery::stamp_for()` writes. `label` repeats `key`: the stamp is
	 * the identifier, so the picker has nothing else to render. A dir named
	 * like a group, or named outside the stamp grammar `is_stamp()` reads,
	 * has no stamp a stream could open, so it takes an unavailable row
	 * carrying the refusal and no key.
	 *
	 * @return list<array{key?:string,label:string,available:bool,error?:string}>
	 */
	private static function catalog_keys(): array {
		$result = [];
		foreach ( Log_Discovery::groups() as $group => $names ) {
			foreach ( $names as $name ) {
				try {
					$key = Log_Discovery::stamp_for( $group, $name );
				} catch ( \InvalidArgumentException $e ) {
					$result[] = Log_Sources::error_row( $name, $e );
					continue;
				}
				$result[] = Log_Discovery::is_stamp( $key )
					? [
						'key'       => $key,
						'label'     => $key,
						'available' => true,
					]
					: Log_Sources::error_row( $name, "log dir {$name} is no stamp a stream can name; rename it" );
			}
		}
		return $result;
	}

	/**
	 * `dump_log` verb handler — segment count and total size of one log, a
	 * partition dir or a `sources/<name>` registry source, by its stamp.
	 *
	 * @param array<array-key,mixed> $args Bound verb arguments: the log stamp; one nothing carries throws.
	 * @return array{log_id:string,segments:list<array{id:int,size:int}>,segment_count:int,total_size:int}
	 */
	public static function cmd_dump_log( array $args ): array {
		$log       = Core::as_string( $args['log'] );
		$footprint = Log_Sources::footprint( $log );
		return [
			'log_id'        => $log,
			'segments'      => $footprint['segments'],
			'segment_count' => \count( $footprint['segments'] ),
			'total_size'    => $footprint['total_size'],
		];
	}

	/**
	 * `read_message` verb handler — the single record AT a position, decoded,
	 * through `Log_Sources::read()`, so a dir and a registry source step
	 * through one read model and the record carries the stamped FROM and the
	 * `seg:offset:length` ID breadcrumb a streamed row does. A malformed
	 * position and an unknown log throw; no record there is a result.
	 *
	 * @param array<array-key,mixed> $args Bound verb arguments: log, and the `<segment>:<offset>[:<length>]` position.
	 * @return array<string,mixed> The record, or null, and the post-step cursor.
	 */
	public static function cmd_read_message( array $args ): array {
		return Log_Sources::read( Core::as_string( $args['log'] ), Core::as_string( $args['position'] ) );
	}

	/**
	 * `read_block` verb handler — the records from a position up to one
	 * block, through `Log_Sources::read_block()`. A malformed position and an
	 * unknown log throw.
	 *
	 * @param array<array-key,mixed> $args Bound verb arguments: log, position and multi_writer.
	 * @return array<string,mixed> The block, its cursor and its skips.
	 */
	public static function cmd_read_block( array $args ): array {
		return Log_Sources::read_block( Core::as_string( $args['log'] ), Core::as_string( $args['position'] ), true === $args['multi_writer'] );
	}

	/**
	 * Palette entry, verb table and capabilities for the topology console.
	 *
	 * Declaring a verb here is its whole registration: `Service_CI_Node` derives
	 * the dispatch table from the `handler` entries, and `dispatch()` refuses a
	 * caller below the `capability` beside each (ADR-26).
	 *
	 * @return array<string,mixed>
	 */
	public static function node_schema(): array {
		return \array_merge( parent::node_schema(), [
			'category'    => 'Service',
			'description' => 'Log inspection: catalog the on-disk partition dirs and registry sources, report one log\'s segments, and decode a single record.',
			'arguments'   => [],
			'commands'    => [
				[
					'name'        => 'list_logs',
					'capability'  => Capabilities::READ,
					'description' => 'List the on-disk partition dirs and the registry sources.',
					'args'        => [],
					'handler'     => static fn ( Command_Interpreter_Node $self, array $args, array $envelope = [] ): array => self::cmd_list_logs(),
				],
				[
					'name'        => 'dump_log',
					'capability'  => Capabilities::READ,
					'description' => 'Segments and size of one partition dir or sources/<name> registry source.',
					'args'        => [ [ 'name' => 'log', 'type' => 'string', 'required' => true ] ],
					'handler'     => static fn ( Command_Interpreter_Node $self, array $args ): array => self::cmd_dump_log( $args ),
				],
				[
					'name'        => 'read_message',
					'capability'  => Capabilities::READ,
					'description' => 'The record at a position in a partition dir or a sources/<name> registry source.',
					'args'        => [
						[ 'name' => 'log', 'type' => 'string', 'required' => true ],
						[ 'name' => 'position', 'type' => 'string', 'required' => true ],
					],
					'handler'     => static fn ( Command_Interpreter_Node $self, array $args ): array => self::cmd_read_message( $args ),
				],
				[
					'name'        => 'read_block',
					'capability'  => Capabilities::READ,
					'description' => 'The records from a position in a partition dir or a sources/<name> registry source, up to a 1 MiB block; the first goes whole.',
					'args'        => [
						[ 'name' => 'log', 'type' => 'string', 'required' => true ],
						[ 'name' => 'position', 'type' => 'string', 'required' => true ],
						[ 'name' => 'multi_writer', 'type' => 'bool', 'default' => false ],
					],
					'handler'     => static fn ( Command_Interpreter_Node $self, array $args ): array => self::cmd_read_block( $args ),
				],
			],
		] );
	}

}
