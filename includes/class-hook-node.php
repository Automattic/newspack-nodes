<?php
/**
 * Hook: WordPress action/filter as a node. Action mode forwards unchanged; filter mode forwards the apply_filters result.
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes;

\defined( 'ABSPATH' ) || exit;

class Hook_Node extends Node {
	use Schema_Reflection;

	protected string $hook_name = '';
	protected bool $filter      = false;

	/** Tachikoma-parity: no-arg ctor. Positional config arrives via arguments(). */
	public function __construct() {
		parent::__construct();
	}

	/** Assign hook_name / filter from positional tokens (no derived state). */
	public function arguments( ?string $args = null ): string {
		if ( null === $args ) {
			return parent::arguments();
		}
		$this->parse_schema_args( $args );
		return $args;
	}

	public function fill( array &$message ): void {
		if ( null === $this->sink ) {
			throw new \RuntimeException( 'fill requires a wired sink' );
		}
		if ( '' === $this->hook_name ) {
			throw new \RuntimeException( 'Hook::fill requires a hook_name' );
		}
		if ( $this->filter ) {
			$filtered = \apply_filters( $this->hook_name, $message[ Message::VALUE ] );
			if ( \is_array( $filtered ) && \array_is_list( $filtered ) ) {
				$message[ Message::TYPE ] = Message::TM_STRUCT;
			} else {
				$message[ Message::TYPE ] = Message::TM_BYTESTREAM;
			}
			$message[ Message::VALUE ] = $filtered;
		} else {
			\do_action( $this->hook_name, $message[ Message::VALUE ] );
		}
		parent::fill( $message );
	}

	public static function node_schema(): array {
		return [
			'category'    => 'Control',
			'description' => 'WordPress hook adapter — fires do_action/apply_filters on each message.',
			'arguments'   => [
				[ 'name' => 'hook_name', 'type' => 'string', 'required' => true ],
				[ 'name' => 'filter',    'type' => 'bool',   'default' => false ],
			],
			'commands'    => [],
		];
	}
}
