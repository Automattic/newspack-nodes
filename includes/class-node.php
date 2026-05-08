<?php
/**
 * Node: base class for the substrate.
 *
 * Every component that participates in the node-graph runtime extends Node.
 * Subclasses override fill() with their actual behavior; the base class
 * provides forwarding-to-sink as the default.
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes;

\defined( 'ABSPATH' ) || exit;

class Node {
	protected string $name = '';
	protected ?Node  $sink = null;
	/** @var string|array<string> */
	protected $target = '';
	protected ?Node  $edge = null;

	protected int $counter = 0;

	/**
	 * @var array<string,array<string,callable|string>> Pre-declared events keyed by event name.
	 */
	protected array $registrations = [];

	/**
	 * Default: forward the message to the sink, incrementing counter first
	 * (so the message is counted even if the sink throws).
	 *
	 * @param array $message Reference; subclasses may mutate before forwarding.
	 */
	public function fill( array &$message ): void {
		++$this->counter;
		$this->sink?->fill( $message );
	}

	public function name( ?string $name = null ): string {
		if ( $name !== null ) {
			if ( $this->name !== '' ) {
				Core::unregister_node( $this->name );
			}
			if ( Core::node( $name ) !== null ) {
				throw new \RuntimeException( "node name collision: $name already registered" );
			}
			$this->name = $name;
			Core::register_node( $name, $this );
		}
		return $this->name;
	}

	public function sink( ?Node $node = null ): ?Node {
		if ( \func_num_args() > 0 ) {
			$this->sink = $node;
		}
		return $this->sink;
	}

	/**
	 * Get/set target. String or array (Tee uses array form for fan-out).
	 */
	public function target( $value = null ) {
		if ( $value !== null ) {
			$this->target = $value;
		}
		return $this->target;
	}

	public function edge( ?Node $node = null ): ?Node {
		if ( \func_num_args() > 0 ) {
			$this->edge = $node;
		}
		return $this->edge;
	}

	public function counter(): int {
		return $this->counter;
	}
}
