<?php
/**
 * Tap: Tee with hard targets and passthrough.
 *
 * Each target receives a copy addressed straight at it — the target path alone,
 * with none of the incoming TO appended. That is what "hard" means, and it is
 * the whole difference from Tee, which prepends the remainder so Router keeps
 * routing past the hop; a tap is the end of its own branch. The original then
 * continues down `sink` addressed as it arrived, so a Tap splices into a live
 * pipeline without diverting it. `_shell` in the REPL graph is one: every
 * command the anonymous Shell sends walks through it, so a session can watch
 * its own traffic.
 *
 * Failure handling is Tee's: it attempts every target, then the passthrough,
 * and raises everything they threw, combined by `Worker_Should_Stop::raise()`.
 * Completing the fan-out is what keeps at-least-once: a target skipped by an
 * early throw never receives the message once the poison path dead-letters it
 * and advances the cursor. Duplicates on replay are the accepted cost of that,
 * and they arise with any fan-out. The passthrough runs before the raise because
 * it IS the pipeline — a `Worker_Should_Stop_Clean` commits PAST the message, so
 * throwing first would drop it from the main path entirely — and its own failure
 * joins the targets', so a clean tap stop beside a failed pipeline write is a
 * plain stop and the message replays (ADR-14).
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes;

\defined( 'ABSPATH' ) || exit;

/**
 * Tap node — `make_node Tap <name>`. Targets accumulate through
 * `connect_node()`; the passthrough goes to `sink`.
 */
class Tap_Node extends Tee_Node {

	/**
	 * Copy the message to every live target, then pass the original downstream.
	 *
	 * TO is saved before the loop and restored after it. The per-target rewrites
	 * mutate a local value, and the passthrough has to carry the address the
	 * message arrived with, or a Tap spliced mid-pipeline would re-route it.
	 *
	 * @param array<int,mixed> $message The 7-field positional message array.
	 * @throws \RuntimeException When no sink is wired.
	 * @throws \Throwable Every target and passthrough failure, combined, raised after the passthrough.
	 */
	public function fill( array $message ): void {
		$sink = $this->require_sink();
		++$this->counter;

		$alive = $this->live_targets();
		$to    = Core::as_string( $message[ Message::TO ] );

		// Defer: the passthrough below IS the pipeline, and Clean commits past.
		$caught = Worker_Should_Stop::attempt_each(
			$alive,
			static function ( string $t ) use ( $sink, $message ): void {
				$message[ Message::TO ] = $t; // hard target: no remainder to route on
				$sink->fill( $message );
			}
		);
		$message[ Message::TO ] = $to;
		Worker_Should_Stop::raise( [ ...$caught, ...Worker_Should_Stop::attempt( static fn () => $sink->fill( $message ) ) ] );
	}
}
