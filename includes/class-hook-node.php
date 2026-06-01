<?php
/**
 * Hook: WordPress action/filter as a node. Action mode forwards unchanged; filter mode forwards the apply_filters result.
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes;

\defined( 'ABSPATH' ) || exit;

class Hook_Node extends Node {
	protected string $hook_name = '';
	protected bool $filter      = false;

	/**
	 * Tachikoma-parity: no-arg ctor. Positional config arrives via `arguments()`,
	 * which the base setter parses against `node_schema()['arguments']`.
	 */
	public function __construct() {
		parent::__construct();
	}

	public function fill( array &$message ): void {
		++$this->counter;
		// An empty hook_name (unconfigured) is a no-op in WP — apply_filters('')
		// returns the value unchanged and do_action('') fires nothing — so skip
		// the dispatch and just forward unchanged.
		if ( '' !== $this->hook_name ) {
			if ( $this->filter ) {
				$message = \apply_filters( $this->hook_name, $message );
			} else {
				\do_action( $this->hook_name, $message );
			}
		}
		$this->sink?->fill( $message );
	}

	public static function node_schema(): array {
		return [
			'category'    => 'Control',
			'description' => 'WordPress hook adapter — fires do_action/apply_filters on each message.',
			'arguments'        => [
				[ 'name' => 'hook_name', 'type' => 'string', 'required' => true ],
				[ 'name' => 'filter',    'type' => 'bool',   'default' => false ],
			],
			'commands'       => [],
		];
	}
}
