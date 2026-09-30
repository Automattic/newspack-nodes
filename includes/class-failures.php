<?php
/**
 * Failures: several throwables escaping as one.
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes;

\defined( 'ABSPATH' ) || exit;

/**
 * What an attempt-all loop raises when more than one step failed and none of
 * them stopped (`Worker_Should_Stop::combine()`), and what a stop carries as
 * its previous when it has more than one failure to report. PHP chains one
 * previous per throwable, so a list is the only shape that loses none.
 *
 * Flat by construction: a `Failures` among the inputs contributes its members,
 * never itself, so `all()` is always the failures and nothing that wraps them.
 * The previous is the first, which keeps a reader walking `getPrevious()` on
 * the path it already knows. `getFile()` and `getLine()` report where that
 * first failure originated, so a reader attributing a fatal by its file names
 * the code that failed, not the aggregation site; `getTraceAsString()` still
 * shows where the failures were combined.
 *
 * `all()` keeps every member; the message is bounded. It names each member's
 * message in order, whole, until the next would pass MESSAGE_BUDGET, then
 * counts the rest as `… and K more`. A fan-out over a hundred thousand
 * failing feed events would otherwise join tens of megabytes into one string
 * that every log line, status row and TM_ERROR reply carries.
 */
final class Failures extends \RuntimeException {

	/**
	 * Most bytes the message spends. A single failure's message runs to a few
	 * KB at most — a SQL error carrying its query — so 64 KiB holds the largest
	 * one with a wide margin, and shows four hundred or more members of a
	 * typical fan-out before it counts the rest.
	 */
	public const MESSAGE_BUDGET = 65536;

	/** Bytes held back for the `… and K more` marker, twenty digits included. */
	private const MARKER_ROOM = 64;

	/**
	 * Every failure, in the order it was caught.
	 *
	 * @var list<\Throwable>
	 */
	private array $all;

	/**
	 * Hold every failure, flattening any `Failures` among them.
	 *
	 * @param array<array-key,\Throwable> $failures Two or more throwables, in order; keys are ignored.
	 * @throws \InvalidArgumentException When fewer than two remain after flattening.
	 */
	public function __construct( array $failures ) {
		$all = self::flatten( $failures );
		if ( \count( $all ) < 2 ) {
			throw new \InvalidArgumentException( 'Failures needs two or more throwables' );
		}
		$this->all = $all;
		parent::__construct( self::summarize( $all ), 0, $all[0] );
		$this->file = $all[0]->getFile();
		$this->line = $all[0]->getLine();
	}

	/**
	 * Every failure this one carries.
	 *
	 * @api Called from consumer plugins (cross-repo, invisible here).
	 *
	 * @return list<\Throwable>
	 */
	public function all(): array {
		return $this->all;
	}

	/**
	 * Expand every `Failures` in a list into its members, keeping order and
	 * each instance once.
	 *
	 * @param array<array-key,\Throwable> $throwables What a loop caught.
	 * @return list<\Throwable>
	 */
	private static function flatten( array $throwables ): array {
		$flat = [];
		foreach ( $throwables as $e ) {
			foreach ( $e instanceof self ? $e->all : [ $e ] as $member ) {
				$flat[ \spl_object_id( $member ) ] ??= $member;
			}
		}
		return \array_values( $flat );
	}

	/**
	 * `<n> failures: <m1> | <m2> …`, whole members only, within MESSAGE_BUDGET.
	 *
	 * @param non-empty-list<\Throwable> $all Every member.
	 */
	private static function summarize( array $all ): string {
		$total   = \count( $all );
		$message = "{$total} failures: ";
		$room    = self::MESSAGE_BUDGET - self::MARKER_ROOM;
		foreach ( $all as $shown => $e ) {
			$piece = ( 0 === $shown ? '' : ' | ' ) . $e->getMessage();
			if ( \strlen( $message ) + \strlen( $piece ) > $room ) {
				return $message . ' … and ' . ( $total - $shown ) . ' more';
			}
			$message .= $piece;
		}
		return $message;
	}
}
