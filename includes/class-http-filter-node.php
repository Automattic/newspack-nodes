<?php
/**
 * HTTP_Filter: the per-session gate on attached-worker replies.
 *
 * Every session attached to a worker — a browser tab's SSE stream or a cli
 * process — reads that worker's whole output Partition, so without a gate each
 * would receive every other session's command replies. A reply's address names
 * its session in one segment, `<realm>:<session>`: `_sse:<handle>` for a
 * browser, whose command session outlives any one connection, and `_cli:<pid>`
 * for a cli process, which never reconnects. Both sit behind the `_output`
 * boundary on the worker's output Partition, so each reader's gate sees the
 * other realm's replies and drops them.
 *
 * A browser mints a command stamped FROM `_sse:<handle>/<reply-node>`,
 * `HTTP_In` adds the `_output` boundary, and the worker's IPC-input Consumer
 * adds `_repl`. The worker's TO=FROM reply (ADR-7) is therefore addressed
 * `_repl/_output/_sse:<handle>/<reply-node>`, and the worker's Router peels
 * `_repl` on the way into the output Partition. A Consumer in the SSE process
 * reads that record and forwards it through the interpreter into `_router`,
 * which peels the leading `_output` and fills this Node — registered under
 * that name, sinking into the `SSE_Out` egress — with TO set to
 * `_sse:<handle>/<reply-node>`. A cli mints `_output/_cli:<pid>/<reply-node>`
 * itself, and `CLI::open_channel()` feeds its gate straight from the output
 * Consumer, so that gate matches the whole `_output/_cli:<pid>` prefix. Either
 * way the gate strips its head and forwards the reply node as the TO the
 * session's own router dispatches on.
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes;

\defined( 'ABSPATH' ) || exit;

/**
 * One session's gate on a worker's shared output. `SSE_Out_Node` builds one
 * per stream, patrons it and names it `_output`; `CLI::open_channel()` builds
 * one per channel and names it `<worker-id>:replies`. `make_node` cannot build
 * one, because the constructor requires the head it gates on.
 */
class HTTP_Filter_Node extends Node {

	/** The address prefix this session's replies carry; null passes none. */
	private ?string $own_head;

	/**
	 * Bind the gate to one session's reply address.
	 *
	 * @param string|null $head The prefix, whole path segments, this session's
	 *                          replies carry, from `head()`; null for a stream
	 *                          that presented no session, whose gate passes no
	 *                          reply.
	 */
	public function __construct( ?string $head ) {
		parent::__construct();
		$this->own_head = $head;
	}

	/**
	 * Forward a reply addressed to this session, stripped of its head, and an
	 * unaddressed message, a worker's broadcast, to the target when one is set;
	 * drop everything else.
	 *
	 * A passed message whose TO is left empty takes the target, as `Node::fill()`
	 * stamps it, so a gate with no target has no place for a broadcast. The
	 * counter counts every message, so `ls -c` reports what the gate saw rather
	 * than what it passed; a gate with no traffic and a gate dropping all of it
	 * would otherwise show the same row. The drop is silent
	 * by contract (ADR-13) — `fill()` returns nothing, so a producer cannot tell
	 * a gated reply from a delivered one.
	 *
	 * @param array<int,mixed> $message The 7-field positional message array.
	 * @throws \RuntimeException When no sink is wired.
	 */
	public function fill( array $message ): void {
		$sink = $this->require_sink();
		++$this->counter;
		$to     = Core::as_string( $message[ Message::TO ] );
		$target = \is_string( $this->target ) ? $this->target : '';
		if ( '' === $to ) {
			if ( '' === $target ) {
				return;
			}
		} else {
			$reply_node = $this->reply_node( $to );
			if ( null === $reply_node ) {
				return;
			}
			$message[ Message::TO ] = $reply_node;
		}
		if ( '' === $message[ Message::TO ] ) {
			$message[ Message::TO ] = $target;
		}
		$sink->fill( $message );
	}

	/**
	 * What follows this session's head in a reply address.
	 *
	 * @param string $to A non-empty TO.
	 * @return string|null The rest of the path, '' for the head alone, or null
	 *                     when TO does not open with the head as whole segments.
	 */
	private function reply_node( string $to ): ?string {
		if ( null === $this->own_head ) {
			return null;
		}
		if ( $to === $this->own_head ) {
			return '';
		}
		$prefix = $this->own_head . '/';
		return \str_starts_with( $to, $prefix ) ? \substr( $to, \strlen( $prefix ) ) : null;
	}

	/**
	 * The one segment naming a session in a reply address, `<realm>:<session>`.
	 *
	 * @param string $realm   `Node_Names::SSE` or `Node_Names::CLI`.
	 * @param string $session A browser's command-session handle or a cli pid.
	 * @return string The session head.
	 */
	public static function head( string $realm, string $session ): string {
		return "{$realm}:{$session}";
	}

	/**
	 * Topology console manifest: hidden, with no arguments and no verbs.
	 *
	 * `Hidden` is what keeps it out of the class palette. A TSL `make_node`
	 * line cannot build it either: `make_node` constructs with `new $fqcn()`,
	 * and this constructor requires a head.
	 *
	 * @return array<string,mixed>
	 */
	public static function node_schema(): array {
		return [
			'category'    => 'Hidden',
			'description' => 'Per-session gate on an attached worker\'s replies, for an SSE stream or a cli process.',
			'arguments'   => [],
			'commands'    => [],
		];
	}
}
