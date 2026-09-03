<?php
/**
 * Hook: the WordPress extensibility bridge into a running graph.
 *
 * A plugin that wants to watch or rewrite what flows through somebody else's
 * topology should not have to ship a Node subclass or edit that topology.
 * Splice a Hook into the chain and the ordinary `add_action` / `add_filter` API
 * reaches the stream: observers read each payload, filters replace it.
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes;

\defined( 'ABSPATH' ) || exit;

/**
 * Fires one WordPress hook per message, in one of two modes.
 *
 * Action mode, the default, fires `do_action( $hook_name, $value )` and forwards
 * the message untouched. Filter mode fires `apply_filters( $hook_name, $value )`
 * and adopts the return as the new VALUE.
 *
 * Either way the hook is handed the VALUE alone, never the envelope, so a
 * listener reads and rewrites the payload but cannot re-address the message.
 * Hook forwards rather than mints, so it leaves FROM alone as well: a message
 * crossing it still names the source that stamped it.
 */
class Hook_Node extends Node {
	use Schema_Reflection;

	/** Mode selector: `apply_filters` when true, `do_action` when false. */
	protected bool $filter = false;

	/** The WordPress hook fired once per message. */
	protected string $hook_name = '';

	/**
	 * Take no constructor arguments, which is what ADR-11's construction
	 * sequence requires: `new`, then `name()`, then `arguments()`.
	 */
	public function __construct() {
		parent::__construct();
	}

	/**
	 * Read the tokens in force, or assign `hook_name` and `filter` from new ones.
	 *
	 * `parse_schema_args()` writes both properties by their schema names and is
	 * the one place the `filter` default and the missing-token refusal live
	 * (ADR-11). Neither property feeds a derived one, so there is no second step
	 * to keep in sync: `fill()` reads them exactly as assigned.
	 *
	 * @param list<string>|null $args Positional tokens, or null to read.
	 * @return list<string> The tokens now in force.
	 */
	public function arguments( ?array $args = null ): array {
		if ( null === $args ) {
			return parent::arguments();
		}
		$this->parse_schema_args( $args );
		return $args;
	}

	/**
	 * Fire the hook for this message, then forward the message to the sink.
	 *
	 * The sink and the hook name are both checked before the hook fires, so a
	 * misconfigured node refuses without leaving a side effect behind a message
	 * that never reaches a sink. `hook_name` is a required argument, and the
	 * guard still earns its place: a node constructed in PHP that never calls
	 * `arguments()`, and a blank token on a `make_node` line, each satisfy the
	 * schema and would otherwise dispatch on the empty hook name, where no
	 * listener can be waiting.
	 *
	 * Filter mode restamps TYPE from the shape of the return — a list array is
	 * TM_STRUCT, and a scalar, an object or an associative array is
	 * TM_BYTESTREAM. TYPE is replaced rather than bit-swapped, so the forwarded
	 * message carries that one flag alone.
	 *
	 * @param array<int,mixed> $message The 7-field positional message array.
	 * @throws \RuntimeException When no sink is wired or no hook name is set.
	 */
	public function fill( array $message ): void {
		$this->require_sink();
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

	/**
	 * Console-palette entry, and the argument list `parse_schema_args()` walks:
	 * `<hook_name> [ <filter> ]`.
	 *
	 * @return array<string,mixed>
	 */
	public static function node_schema(): array {
		return [
			'category'    => 'Control',
			'description' => 'WordPress hook adapter — fires do_action/apply_filters on each message.',
			'arguments'   => [
				[ 'name' => 'hook_name', 'type' => 'string', 'required' => true, 'description' => 'WordPress hook name fired on each message (do_action, or apply_filters when filter is true).' ],
				[ 'name' => 'filter',    'type' => 'bool',   'default' => false, 'description' => 'When true, run apply_filters and forward its result as VALUE; when false (default) run do_action and pass VALUE through.' ],
			],
			'commands'    => [],
		];
	}
}
