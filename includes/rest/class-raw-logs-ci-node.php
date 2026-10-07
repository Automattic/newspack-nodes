<?php
/**
 * Raw_Logs_CI: the read-only inspection surface behind the Raw Logs dashboard.
 *
 * The dashboard asks three questions and gets one verb each: which partition
 * directories exist on disk (`list_logs`), how much one of them holds
 * (`dump_log`), and what the record at a given position decodes to
 * (`read_message`). Every verb reads substrate state; none writes. Live
 * tailing belongs to `SSE_Out_Node`, not to this interpreter.
 *
 * `read_message` drives `Log_Sources::read_at()`, the same single-step read the
 * `taillog read` REPL verb drives, so the dashboard and the REPL share one
 * position grammar and one reply shape instead of drifting apart.
 *
 * A `log` the catalog does not name is refused, never defaulted: a paused
 * step handed another log's record would read the wrong stream.
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes\Rest;

use Newspack_Nodes\Capabilities;
use Newspack_Nodes\Command_Interpreter_Node;
use Newspack_Nodes\Core;
use Newspack_Nodes\Log_Discovery;
use Newspack_Nodes\Log_Sources;
use Newspack_Nodes\Node_Names;
use Newspack_Nodes\Partition_Node;
use Newspack_Nodes\Service_CI_Node;

\defined( 'ABSPATH' ) || exit;

/**
 * The `raw-logs` service interpreter: three READ verbs over on-disk partitions.
 *
 * Each verb declares `Capabilities::READ` in `node_schema()`, and
 * `dispatch()` refuses a caller below it (ADR-26). Nothing here writes, so
 * nothing here asks for a heavier role.
 */
class Raw_Logs_CI_Node extends Service_CI_Node {

	/**
	 * Observation seam over the `dump_log` probe wiring. Production leaves it
	 * null and nothing runs; a test assigns a closure, which `cmd_dump_log`
	 * invokes with the inspection Partition after patron, name and sink are set
	 * and before it reads segments or removes the node.
	 *
	 * A test therefore asserts that the probe is hidden from the canvas (patron),
	 * addressable (name) and sunk into `_command_interpreter`, while the rest of
	 * the handler — the segment read, the sum, the teardown — runs as real code.
	 *
	 * Signature: `function ( Partition_Node $probe ): void`.
	 *
	 * @var \Closure|null
	 */
	public static ?\Closure $on_probe = null;

	/**
	 * `list_logs` verb handler — the catalog the dashboard's log picker mounts.
	 *
	 * @return list<array{key:string,label:string}>
	 */
	public static function cmd_list_logs(): array {
		return self::catalog_keys();
	}

	/**
	 * Every on-disk partition directory as a `{key,label}` pair, `logs` first,
	 * then `offsets` and `deadletter`.
	 *
	 * A bare basename keys the `logs` root and `{group}/{basename}` keys the
	 * other two, which is the shape `Log_Discovery::dir_of()` resolves back to a path.
	 * `label` repeats `key`: the directory name is the identifier, so the picker has
	 * nothing else to render.
	 *
	 * @return list<array{key:string,label:string}>
	 */
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

	/**
	 * `dump_log` verb handler — segment count and total size for one concrete
	 * partition directory. Accepts a bare logs key (`firehose.p0`) or a
	 * group-prefixed one (`offsets/…`, `deadletter/…`).
	 *
	 * The probe Partition is plumbing, and the order it is wired in matters.
	 * `patron()` runs first because it refuses after `name()`: a named node has
	 * already registered its `{name}:config` interpreter, which taking a patron
	 * would tear straight back down. The name follows, then a sink into
	 * `_command_interpreter` so anything the probe emits has a destination. The
	 * `finally` removes the node, because a throw that left the name registered
	 * would collide with the next `dump_log` call in the same process.
	 *
	 * @param Command_Interpreter_Node $self The dispatching interpreter; names and patrons the probe.
	 * @param array<array-key,mixed>   $args Bound verb arguments: the log key, which must name a catalog dir; an unknown one throws.
	 *
	 * @return array<string,mixed> The key inspected, its `{id,size}` segment list, the segment count and the total size.
	 */
	public static function cmd_dump_log( Command_Interpreter_Node $self, array $args ): array {
		$log_key = Core::as_string( $args['log'] );
		$dir     = Log_Discovery::dir_of( $log_key );

		$ci        = Core::node( Node_Names::COMMAND_INTERPRETER );
		$partition = new Partition_Node();
		$partition->patron( $self );
		$partition->name( "{$self->name()}:status" );
		if ( null === $partition->sink() && null !== $ci ) {
			$partition->sink( $ci );
		}
		// Flat layout: the concrete dir IS one partition — stat it directly.
		$partition->arguments( [ $dir ] );
		try {
			if ( null !== self::$on_probe ) {
				( self::$on_probe )( $partition );
			}
			$footprint = $partition->footprint();
		} finally {
			$partition->remove_node();
		}

		$segments = null === $footprint ? [] : $footprint['segments'];

		return [
			'log_id'        => $log_key,
			'segments'      => $segments,
			'segment_count' => \count( $segments ),
			'total_size'    => null === $footprint ? 0 : $footprint['bytes'],
		];
	}

	/**
	 * `read_message` verb handler — the single record AT a position, decoded.
	 *
	 * Drives the REAL read model: an ephemeral Consumer (one argument, so
	 * neither the offsetlog nor the dead-letter sidecar is built) seeked to
	 * `<segment>:<offset>` and single-stepped through the Durable_Reader
	 * debugger. Segment rolls, torn records and oversized partials therefore
	 * behave exactly as they do for every other reader, and the emitted record
	 * carries the stamped FROM and the `seg:offset:length` ID breadcrumb.
	 * Length-blind: a supplied `:<length>` token is tolerated and ignored.
	 *
	 * `Log_Sources::read_at()` removes the Consumer on every exit, a rejected
	 * position included — `arguments()` armed its timer, and a reader left armed
	 * with no sink fires forever inside the worker's drain loop. The reply's
	 * `cursor` is the post-step position, exactly where the next step resumes.
	 *
	 * @param Command_Interpreter_Node $self The dispatching interpreter; unused, the handler signature is uniform.
	 * @param array<array-key,mixed>   $args Bound verb arguments: log, and the `<segment>:<offset>[:<length>]` position.
	 *
	 * @return array<string,mixed>|string The record + cursor, or a position teaching error; an unknown log throws.
	 */
	public static function cmd_read_message( Command_Interpreter_Node $self, array $args ): array|string {
		$log = Core::as_string( $args['log'] );
		$reader = Log_Sources::open_reader( $log );
		return Log_Sources::read_at( $reader, $log, Core::as_string( $args['position'] ), 'read_message' );
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
			'description' => 'Log inspection: catalog the on-disk partition dirs, report one dir\'s segment status, and decode a single record.',
			'arguments'   => [],
			'commands'    => [
				[
					'name'        => 'list_logs',
					'capability'  => Capabilities::READ,
					'description' => 'List the on-disk log keys.',
					'args'        => [],
					'handler'     => static fn ( Command_Interpreter_Node $self, array $args, array $envelope = [] ): array => self::cmd_list_logs(),
				],
				[
					'name'        => 'dump_log',
					'capability'  => Capabilities::READ,
					'description' => 'Segment counts and sizes for one concrete partition dir.',
					'args'        => [ [ 'name' => 'log', 'type' => 'string', 'required' => true ] ],
					'handler'     => static fn ( Command_Interpreter_Node $self, array $args ): array => self::cmd_dump_log( $self, $args ),
				],
				[
					'name'        => 'read_message',
					'capability'  => Capabilities::READ,
					'description' => 'The record at a position in a partition dir or a sources/<name> registry source.',
					'args'        => [
						[ 'name' => 'log', 'type' => 'string', 'required' => true ],
						[ 'name' => 'position', 'type' => 'string', 'required' => true ],
					],
					'handler'     => static fn ( Command_Interpreter_Node $self, array $args ): array|string => self::cmd_read_message( $self, $args ),
				],
			],
		] );
	}

}
