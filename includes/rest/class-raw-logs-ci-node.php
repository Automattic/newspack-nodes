<?php
/**
 * Raw_Logs_CI: the read-only inspection surface behind the Raw Logs dashboard.
 *
 * The dashboard asks three questions and gets one verb each: which partition
 * directories exist on disk (`list_logs`), how much one of them holds
 * (`log_status`), and what the record at a given position decodes to
 * (`read_message`). Every verb reads substrate state; none writes. Live
 * tailing belongs to `SSE_Out_Node`, not to this interpreter.
 *
 * `read_message` drives `Log_Sources::read_at()`, the same single-step read the
 * `taillog read` REPL verb drives, so the dashboard and the REPL share one
 * position grammar and one reply shape instead of drifting apart.
 *
 * A `log` argument the catalog does not carry resolves to a default rather than
 * refusing, so a picker holding a key whose directory has been pruned still
 * renders a log.
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes\Rest;

use Newspack_Nodes\Capabilities;
use Newspack_Nodes\Command_Interpreter_Node;
use Newspack_Nodes\Consumer_Node;
use Newspack_Nodes\Config as RuntimeConfig;
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
 * Each verb declares `Capabilities::READ` in `node_schema()`, and that is what
 * `Service_CI_Node` gates its handler with. Nothing here writes, so nothing
 * here asks for a heavier role.
 */
class Raw_Logs_CI_Node extends Service_CI_Node {

	/**
	 * Log-key prefix preferred when the `log` argument is missing or unknown.
	 *
	 * Matched with `str_starts_with` rather than compared whole, because the
	 * flat layout carries the partition in the directory name: the key on disk
	 * is `firehose.p0`, never a bare `firehose`.
	 */
	private const PREFERRED_LOG_PREFIX = 'firehose';

	/**
	 * Observation seam over the `log_status` probe wiring. Production leaves it
	 * null and nothing runs; a test assigns a closure, which `cmd_log_status`
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
	 * `log_status` verb handler — segment count and total size for one concrete
	 * partition directory. Accepts a bare logs key (`firehose.p0`) or a
	 * group-prefixed one (`offsets/…`, `deadletter/…`).
	 *
	 * The probe Partition is plumbing, and the order it is wired in matters.
	 * `patron()` runs first because it refuses after `name()`: a named node has
	 * already registered its `{name}:config` interpreter, which taking a patron
	 * would tear straight back down. The name follows, then a sink into
	 * `_command_interpreter` so anything the probe emits has a destination. The
	 * `finally` removes the node, because a throw that left the name registered
	 * would collide with the next `log_status` call in the same process.
	 *
	 * @param Command_Interpreter_Node $self The dispatching interpreter; names and patrons the probe.
	 * @param list<string>             $args `[<log key>]`; absent or unknown resolves to the catalog default.
	 *
	 * @return array<string,mixed> The key inspected, its `{id,size}` segment list, the segment count and the total size.
	 */
	public static function cmd_log_status( Command_Interpreter_Node $self, array $args ): array {
		$log_key = self::resolve_log_key( $args[0] ?? '' );

		$ci        = Core::node( Node_Names::COMMAND_INTERPRETER );
		$partition = new Partition_Node();
		$partition->patron( $self );
		$partition->name( "{$self->name()}:status" );
		if ( null === $partition->sink() && null !== $ci ) {
			$partition->sink( $ci );
		}
		// Flat layout: the concrete dir IS one partition — stat it directly.
		$partition->arguments( [ self::dir_for( $log_key ) ] );
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
	 * @param list<string>             $args `[<log key>, <segment>:<offset>[:<length>]]`.
	 *
	 * @return array<string,mixed>|string The record + cursor, or a teaching error.
	 */
	public static function cmd_read_message( Command_Interpreter_Node $self, array $args ): array|string {
		$log_key  = self::resolve_log_key( $args[0] ?? '' );
		$consumer = new Consumer_Node();
		$consumer->arguments( [ self::dir_for( $log_key ) ] );

		return Log_Sources::read_at( $consumer, $log_key, Core::as_string( $args[1] ?? '' ), 'read_message' );
	}

	/**
	 * Map an inbound `log` argument to a key the catalog carries.
	 *
	 * An empty or unrecognized argument resolves to the first key starting with
	 * `PREFERRED_LOG_PREFIX`, or to the first key discovered when no firehose
	 * directory exists — never to a refusal, so a picker holding a pruned key
	 * still renders a log. An empty catalog yields the bare prefix: there is no
	 * key to return, and the directory it names reports no segments rather than
	 * failing.
	 *
	 * @param string $log The verb's `log` argument, possibly empty.
	 * @return string A catalog key, or the bare prefix when nothing is on disk.
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
	 * The absolute directory a catalog key names.
	 *
	 * A bare key is a basename under `{base}/logs`; a `{group}/{name}` key
	 * already carries its own root (`offsets`, `deadletter`) and hangs off
	 * `{base}` whole. Both handlers resolve the path here rather than each
	 * splitting the key and re-joining it, which is what keeps the two roots
	 * from diverging.
	 *
	 * @param string $key A catalog key from `catalog_keys()`.
	 * @return string The absolute partition directory.
	 */
	private static function dir_for( string $key ): string {
		$base  = RuntimeConfig::get_base_directory();
		$slash = \strpos( $key, '/' );
		return false === $slash ? "{$base}/logs/{$key}" : "{$base}/{$key}";
	}

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
	 * other two, which is the shape `dir_for()` resolves back to a path. `label`
	 * repeats `key`: the directory name is the identifier, so the picker has
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
	 * Palette entry, verb table and capabilities for the topology console.
	 *
	 * Declaring a verb here is its whole registration: `Service_CI_Node` derives
	 * the dispatch table from the `handler` entries and gates each one on the
	 * `capability` beside it.
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
					'name'        => 'log_status',
					'capability'  => Capabilities::READ,
					'description' => 'Segment counts and sizes for a single concrete partition dir (an absent or unknown log defaults to the first firehose key, else the first key discovered).',
					'args'        => [ [ 'name' => 'log', 'type' => 'string', 'required' => false ] ],
					'handler'     => static fn ( Command_Interpreter_Node $self, array $args ): array => self::cmd_log_status( $self, self::arg_strings( $args ) ),
				],
				[
					'name'        => 'read_message',
					'capability'  => Capabilities::READ,
					'description' => 'The single decoded record at <segment>:<offset> (a trailing :<length> is ignored); replies with the record, the post-step cursor and at_eof.',
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
