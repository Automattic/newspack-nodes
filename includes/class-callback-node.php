<?php
/**
 * Callback: adapt a PHP closure into the node graph.
 *
 * Short-lived graphs need a terminal that runs arbitrary PHP once per message —
 * a test asserting on what reached the end of a chain, `Job_Delay` sorting due
 * entries from held ones, `Log_Sources::read_at()` capturing the one record a
 * Consumer stepped to. Callback is that terminal, so none of them has to declare
 * a Node subclass it would use once.
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes;

\defined( 'ABSPATH' ) || exit;

/**
 * Invokes a callable on every message and stops there.
 *
 * Callback needs no sink, forwards nothing and stamps no `target` into TO; a
 * closure that means to transform and pass on fills the next node itself. Its
 * constructor takes a required argument, which is why `make_node` cannot build
 * it — that sequence instantiates with `new $fqcn()` (ADR-11) — so callers
 * construct it directly in PHP and no topology line ever names it. Tachikoma's
 * `Callback.pm`, the model, guards the same ground by dying whenever
 * `arguments()` is handed anything.
 */
class Callback_Node extends Node {

	/**
	 * The callable every message is handed to.
	 *
	 * @var callable
	 */
	private $cb;

	/**
	 * Take the callable directly. A closure is not a scalar token, so it cannot
	 * ride the `arguments()` path every configurable node takes its setup from.
	 *
	 * @param callable $cb Invoked once per message as `function ( array $message ): void`.
	 */
	public function __construct( callable $cb ) {
		parent::__construct();
		$this->cb = $cb;
	}

	/**
	 * Count the message and hand it to the callable.
	 *
	 * The parameter is by value, so a callback declaring `array &$message`
	 * mutates this node's copy and nothing the caller can see. Transforming a
	 * message means forwarding the changed copy yourself. The JS mirror,
	 * `src/runtime/callback-node.js`, hands the array over by reference, so a
	 * closure that writes into the message edits the caller's copy there.
	 *
	 * @param array<int,mixed> $message The 7-field positional message array.
	 */
	public function fill( array $message ): void {
		++$this->counter;
		( $this->cb )( $message );
	}

	/**
	 * Console-palette manifest. Hidden: a closure has no TSL spelling and no form
	 * the GUI could render, so the class stays out of the palette.
	 *
	 * @return array<string,mixed>
	 */
	public static function node_schema(): array {
		return [
			'category'    => 'Hidden',
			'description' => 'Inline PHP closure as a node — invokes a callable on each message.',
			'arguments'   => [],
			'commands'    => [],
		];
	}
}
