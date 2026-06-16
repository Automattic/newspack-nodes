<?php
/**
 * Topic: multi-partition wrapper. Hashes KEY to partition via Partition::hash_to_partition.
 *
 * Class-API contract: constructor must be safe in request scope (no event-loop deps).
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes;

\defined( 'ABSPATH' ) || exit;

class Topic_Node extends Node {
	use Schema_Reflection;

	protected string $dir_template  = '';
	protected int $num_partitions   = 1;
	protected int $segment_size     = Partition_Node::DEFAULT_SEGMENT_SIZE;
	protected int $num_segments     = Partition_Node::DEFAULT_NUM_SEGMENTS;
	protected int $max_lifespan     = Partition_Node::DEFAULT_MAX_LIFESPAN;

	/** @var array<int,Partition_Node> Lazy. */
	protected array $partitions = [];

	protected static int $rr_counter = 0;

	/** Tachikoma-parity: no-arg ctor. Positional config arrives via arguments(). */
	public function __construct() {
		$this->registrations = [ 'READY' => [] ];
		parent::__construct();
	}

	/**
	 * Store the raw string, parse positional tokens via parse_schema_args(), then
	 * normalize (rtrim dir_template, clamp num_partitions to ≥1).
	 *
	 * @param string|null $args
	 * @return string
	 */
	public function arguments( ?string $args = null ): string {
		if ( null === $args ) {
			return parent::arguments();
		}
		$this->parse_schema_args( $args );
		$this->dir_template   = \rtrim( $this->dir_template, '/' );
		$this->num_partitions = \max( 1, $this->num_partitions );
		return $args;
	}

	/**
	 * Node entry point. Pick a partition (pre-pinned TO, KEY hash, or round-robin) and delegate.
	 *
	 * @param array<int, mixed> $message Reference; not mutated.
	 */
	public function fill( array &$message ): void {
		++$this->counter;

		// Surface bytes-through + largest message on the Topic itself for dump_metadata.
		$packed_size = Message::packed_size( $message );
		$this->bytes_written += $packed_size;
		if ( $packed_size > $this->largest_msg_sent ) {
			$this->largest_msg_sent = $packed_size;
		}

		// Pre-pinned via TO: parse partition index out of TO's leading segment.
		$to = Core::as_string( $message[ Message::TO ] );
		if ( '' !== $to && \preg_match( '/^p(\d+)/', $to, $m ) ) {
			$idx = (int) $m[1];
			if ( $idx >= 0 && $idx < $this->num_partitions ) {
				$this->partition( $idx )->fill( $message );
				return;
			}
		}
		// KEY-routed (or round-robin if KEY empty).
		$key = Core::as_string( $message[ Message::KEY ] );
		if ( '' !== $key ) {
			$idx = Partition_Node::hash_to_partition( $key, $this->num_partitions );
		} else {
			$idx = ( self::$rr_counter++ ) % $this->num_partitions;
		}
		$this->partition( $idx )->fill( $message );
	}

	protected function partition( int $i ): Partition_Node {
		$first = empty( $this->partitions );
		if ( ! isset( $this->partitions[ $i ] ) ) {
			$p = new Partition_Node();
			// Name the sibling `{topic}:p{i}` (mirrors Consumer's `{name}:source`) when the Topic is named.
			if ( '' !== $this->name ) {
				$p->name( "{$this->name}:p{$i}" );
			}
			$child_dir = \str_replace( '{partition}', (string) $i, $this->dir_template );
			$p->arguments( "{$child_dir} {$this->segment_size} {$this->num_segments} {$this->max_lifespan}" );
			// Keep Topic's own sink (specific) and patron-link so dump_metadata hides it from the canvas.
			$p->sink( $this->sink );
			$p->patron( $this );
			$this->partitions[ $i ] = $p;
		}
		if ( $first ) {
			// set_state caches READY so late registrants get immediate replay.
			$this->set_state( 'READY', $this->name );
		}
		return $this->partitions[ $i ];
	}

	/** Override Node::sink() so child Partitions inherit the new sink. */
	public function sink( ?Node $node = null ): ?Node {
		$result = \func_num_args() > 0 ? parent::sink( $node ) : parent::sink();
		if ( \func_num_args() > 0 ) {
			foreach ( $this->partitions as $p ) {
				$p->sink( $node );
			}
		}
		return $result;
	}

	public function num_partitions(): int {
		return $this->num_partitions;
	}

	/** Flush every materialized partition's batch (request-scope callers land pending writes). */
	public function flush(): void {
		foreach ( $this->partitions as $p ) {
			$p->flush();
		}
	}

	/** Tear down owned Partitions before normal Node teardown so file handles close deterministically. */
	public function remove_node(): void {
		foreach ( $this->partitions as $p ) {
			$p->remove_node();
		}
		$this->partitions = [];
		parent::remove_node();
	}

	public static function node_schema(): array {
		return [
			'category'    => 'I/O',
			'description' => 'Multi-partition log abstraction; routes by hash to one of N Partitions.',
			'arguments'        => [
				[ 'name' => 'dir_template',   'type' => 'string', 'required' => true ],
				[ 'name' => 'num_partitions', 'type' => 'int',    'default'  => 1 ],
				[ 'name' => 'segment_size',   'type' => 'int',    'default' => Partition_Node::DEFAULT_SEGMENT_SIZE ],
				[ 'name' => 'num_segments',   'type' => 'int',    'default' => Partition_Node::DEFAULT_NUM_SEGMENTS ],
				[ 'name' => 'max_lifespan',   'type' => 'int',    'default' => Partition_Node::DEFAULT_MAX_LIFESPAN ],
			],
			'commands'       => [],
			'has_target'  => false,
		];
	}
}
