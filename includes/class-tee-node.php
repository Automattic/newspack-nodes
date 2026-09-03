<?php
/**
 * Tee: the fan-out node. Every live target gets its own copy of each message,
 * addressed so Router carries that copy down whatever path remains.
 *
 * The target LIST, its prune-on-read and the shared failure contract live in
 * `Fanout_Targets`, which Tap and the command minters use as well. Tee adds the
 * dispatch loop alone: address each copy `<target>/<TO>` — bare `<target>`
 * when TO is empty — and forward it through the sink, `_router` in a stock
 * graph (ADR-7). Delivery follows CONNECT order, synchronously, and a consumer
 * may rely on an earlier target having been fully delivered before a later one
 * starts.
 *
 * Tee consumes nothing and forwards no original: every TYPE fans out,
 * TM_COMMAND and TM_REQUEST included, and a message with no live target stops
 * here. A graph that needs the original to continue past the fan-out uses
 * `Tap_Node`.
 *
 * Ported from Tachikoma's `Tee.pm` minus its TM_PERSIST ledger and the
 * `[ <timeout> ]` that expired it, both of which ADR-3 dropped.
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes;

\defined( 'ABSPATH' ) || exit;

/**
 * Tee node — `make_node Tee <name>`.
 */
class Tee_Node extends Node {
	use Fanout_Targets;

	/**
	 * Copy the message to every live target, then raise the deferred failure.
	 *
	 * The sink is required before the target list is read, so a Tee wired to
	 * nothing refuses loudly instead of reading as a fan-out that found no live
	 * targets. Reassigning TO inside the loop is safe because `fill()` takes
	 * the message by value (ADR-2): every target receives its own copy and one
	 * target's edits cannot reach the next. The counter records messages
	 * filled, not copies emitted, which is what `ls -c` and `dump_metadata`
	 * report.
	 *
	 * Every target is attempted even after one throws. A branch's failure says
	 * nothing about its siblings, and a skipped healthy target loses the
	 * message for good once the poison path dead-letters it and advances the
	 * cursor. Whichever throwable `outranks()` selects is raised after the
	 * loop, the fan-out carve-out ADR-14 grants.
	 *
	 * @param array<int,mixed> $message The 7-field positional message array.
	 * @throws \RuntimeException When no sink is wired.
	 * @throws \Throwable Whichever target failure `outranks()` kept, raised after the loop.
	 */
	public function fill( array $message ): void {
		$sink = $this->require_sink();
		++$this->counter;

		$to    = Core::as_string( $message[ Message::TO ] );
		$alive = $this->live_targets();

		// Attempt every target: a skip is lost when the cursor advances.
		$deferred = null;
		foreach ( $alive as $t ) {
			$message[ Message::TO ] = $this->target_path( $t, $to );
			try {
				$sink->fill( $message );
			} catch ( \Throwable $e ) {
				if ( $this->outranks( $e, $deferred ) ) {
					$deferred = $e;
				}
			}
		}
		if ( null !== $deferred ) {
			throw $deferred;
		}
	}

	/**
	 * Console-palette entry: a routing primitive with no positional arguments.
	 *
	 * Targets arrive through `connect_node`, so an operator types none of them,
	 * and Tee declares no verbs or requests — a message reaching it fans out
	 * whatever its TYPE.
	 *
	 * @return array<string,mixed>
	 */
	public static function node_schema(): array {
		return [
			'category'    => 'Routing',
			'description' => 'Fan-out: copies each message to multiple targets via Router.',
			'arguments'   => [],
			'commands'    => [],
			'requests'    => [],
		];
	}
}
