<?php
/**
 * The `wp nodes` command root and the `wp nodes cli` REPL.
 *
 * WP-CLI registers this class as the whole `nodes` group, so the class docblock
 * below is the group's help text; every other subcommand is registered from its
 * own class. The one command implemented here is `cli`, which assembles a node
 * graph and hands it to `Event_Framework`. The REPL is therefore built out of
 * the same substrate a worker runs, not a read-eval-print loop of its own.
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes;

\defined( 'ABSPATH' ) || exit;

/**
 * Manage the Newspack Nodes runtime: workers, the node-graph REPL, and logs.
 *
 * `wp nodes` groups every runtime subcommand. The substrate (newspack-nodes)
 * provides worker lifecycle and graph inspection; the event-logger application
 * (newspack-event-logger-nodes) adds the `reqgrep` firehose tool. Run any
 * subcommand with `--help` for its own options.
 *
 * ## EXAMPLES
 *
 *     # List active workers and their heartbeats
 *     wp nodes status
 *
 *     # Attach a REPL to a live worker
 *     wp nodes cli firehose-workers-and-jobs.p0
 *
 *     # Restart every worker type
 *     wp nodes restart all
 *
 *     # Live-tail the request firehose
 *     wp nodes reqgrep --follow
 */
class CLI_Command {

	/**
	 * stdin seam. Lazily-defaulted to the real STDIN at the call sites. Tests
	 * reassign to a fixture stream (e.g. an empty `php://memory`) so the
	 * bare-REPL drain sees non-TTY EOF even when the phpunit runner's own
	 * STDIN is an interactive terminal (which would park the reader at a
	 * readline prompt forever).
	 *
	 * Signature: `function (): resource`.
	 *
	 * @var (\Closure(): resource)|null
	 */
	public static ?\Closure $stdin = null;

	/**
	 * Resolved terminal policy: `[ stdin stream, is_tty, has_readline ]`. Null
	 * until `terminal()` derives it, which it does exactly once.
	 *
	 * @var array{0:resource,1:bool,2:bool}|null
	 */
	private ?array $terminal = null;

	/**
	 * Open an interactive REPL — bare mode (local graph) or attached mode (IPC to a worker).
	 *
	 * ## OPTIONS
	 *
	 * [<worker>]
	 * : Worker id in the form {type}.p{N}, e.g. firehose-workers.p0.
	 *
	 * ## EXAMPLES
	 *
	 *     wp nodes cli
	 *     wp nodes cli firehose-workers.p0
	 *
	 * @api WP-CLI subcommand `wp nodes cli` — invoked by WP-CLI via reflection, not called in PHP.
	 * @param array<int,string>   $args       Positionals. Empty opens bare mode; `$args[0]` is the worker id otherwise.
	 * @param array<string,mixed> $assoc_args Flags. Unused — `cli` declares none, and WP-CLI passes the map regardless.
	 */
	public function cli( array $args, array $assoc_args ): void {
		Bootstrap::ensure_runtime_wired();
		[ $shell, $dumper, $stdout ] = $this->prepare_repl( $args );
		$this->run_repl( $shell, $dumper, $stdout );
	}

	/**
	 * Drive the REPL from the drain loop until stdin reaches EOF, reading through
	 * readline on a TTY and `fgets` otherwise.
	 *
	 * The reader is a timer-driven node rather than a blocking `while ( fgets() )`
	 * loop, so the one drain that services the graph's timers, the IPC Consumer
	 * and any cURL handles polls the keyboard as well. A blocking read stalls all
	 * of them between keystrokes, and an attached session would then render a
	 * worker's replies only when the operator happened to press a key.
	 *
	 * @param Shell_Node   $shell  The anonymous parser: the reader's sink, and the prompt it renders.
	 * @param Dumper_Node  $dumper `_output`, whose completion and EOF hooks are wired back to the reader here.
	 * @param TTY_Out_Node $stdout `_stdout`, the writer the reader puts its prompts through.
	 */
	private function run_repl( Shell_Node $shell, Dumper_Node $dumper, TTY_Out_Node $stdout ): void {
		[ $stdin, $is_tty, $has_readline ] = $this->terminal();

		// Skip prompts when stdin is piped; they break `... | grep` consumers.
		$reader = new TTY_In_Node( $shell, $stdout, $has_readline, $stdin, $is_tty );

		// Sink needed: Timer_Node::fire_cb() skips fire()/stdin-drain if none.
		$reader->sink( $shell );

		// Completion replies (KEY='completion') feed the cache, not printed.
		if ( $has_readline ) {
			$dumper->set_completion_sink(
				fn ( array $message ): bool => $reader->ingest_completion_reply( $message )
			);
			// Seed cache once intercept is wired, so first Tab has candidates.
			$reader->send_completion_queries();
		}

		// On worker's TM_EOF echo, flip exit so scripts don't orphan replies.
		$dumper->on_eof( static function () use ( $reader ): void {
			$reader->exit = true;
		} );

		// Recurring: fire() re-paces itself, never re-arms to stay alive.
		$reader->set_timer( 0 );
		Event_Framework::instance()->drain( static fn () => ! $reader->exit );

		if ( $has_readline ) {
			\readline_callback_handler_remove();
		}
		// Trailing newline on a TTY; skipped when piped (breaks consumers).
		if ( $is_tty ) {
			\WP_CLI::log( '' );
		}
	}

	/**
	 * Resolve the mode, build the graph, and stash the summary the `status`
	 * builtin prints on request.
	 *
	 * Resolving the worker's IPC paths comes before any node is constructed, so an
	 * unknown worker id is refused by `WP_CLI::error` while the failure is still a
	 * single line. The summary is stashed instead of printed for the reason the
	 * prompts and the trailing newline are suppressed off a TTY: a piped session
	 * emits what the script asked for and nothing else.
	 *
	 * @param array<int,string> $args WP-CLI positionals. Empty opens bare mode; `$args[0]` is the worker id otherwise.
	 * @return array{0:Shell_Node,1:Dumper_Node,2:TTY_Out_Node} The nodes `run_repl()` drives.
	 */
	private function prepare_repl( array $args ): array {
		// Refuse root: root cli makes IPC dirs root-owned, locks out non-root.
		CLI::refuse_root( 'cli' );

		$cli = new CLI( Bootstrap::base_dir() );

		$attached = ! empty( $args );
		$ipc     = null;

		if ( $attached ) {
			$worker_id = $args[0];
			try {
				$ipc = $cli->attach_to_worker( $worker_id );
			} catch ( \InvalidArgumentException $e ) {
				\WP_CLI::error( $e->getMessage() );
			}
		}

		[ $shell, $dumper, $stdout ] = $this->build_repl_graph( $attached, $ipc );

		// Stash the mode summary; the `status` builtin renders it on demand.
		if ( $attached && null !== $ipc ) {
			$shell->status_lines = [
				"Attached-cli mode for {$args[0]}",
				"  input  partition: {$ipc['input']}",
				"  output partition: {$ipc['output']}",
			];
		} else {
			$shell->status_lines = [
				'Bare cli mode (local nodes only).',
			];
		}

		return [ $shell, $dumper, $stdout ];
	}

	/**
	 * Build the REPL node graph: the same local nodes in both modes, plus an IPC
	 * pair when attached.
	 *
	 * The anonymous Shell sinks into the `_shell` console tap, which sinks into
	 * `_command_interpreter`, which sinks into `_router`. `_output` (the Dumper)
	 * and `_stdout` (the terminal writer) sink into the interpreter too and are
	 * reached by PATH rather than down a sink chain: the Shell stamps
	 * `FROM=_output/<pid>`, a reply comes back with TO=FROM and lands on the
	 * Dumper, and the Dumper's `target` carries the rendered line to `_stdout`.
	 * That is ADR-7 — steer with `target`, never with a bespoke sink chain.
	 *
	 * Attaching adds a `Partition_Node` named after the worker, which writes
	 * commands into the worker's input IPC dir, and a `Consumer_Node` tailing the
	 * output dir into an anonymous relay targeting `_output`. The Shell's sink is
	 * untouched; setting `path` to the worker id is the whole cd, and it is what
	 * puts `TO={worker-id}` on a default command so `_router` hands it to the
	 * Partition instead of running it locally.
	 *
	 * @param bool                                                             $attached True selects attached mode; the IPC pair needs `$ipc` non-null too.
	 * @param array{input:string,output:string,type:string,partition:int}|null $ipc      IPC paths from `CLI::attach_to_worker()`; null in bare mode.
	 * @return array{0:Shell_Node,1:Dumper_Node,2:TTY_Out_Node}
	 */
	private function build_repl_graph( bool $attached, ?array $ipc ): array {
		$pid = (string) \getmypid();

		$router = new Router_Node();
		$router->name( Node_Names::ROUTER );

		$interpreter = new Command_Interpreter_Node();
		$interpreter->name( Node_Names::COMMAND_INTERPRETER );
		$interpreter->sink( $router );

		// `_stdout`: terminal writer; Dumper reaches via target/TO (ADR-7).
		$stdout = new TTY_Out_Node();
		$stdout->name( Node_Names::STDOUT );
		$stdout->sink( $interpreter );

		// `_output`: Shell stamps FROM=_output/$pid, so replies route here.
		$dumper = new Dumper_Node();
		$dumper->name( Node_Names::OUTPUT );
		$dumper->sink( $interpreter );
		$dumper->target( Node_Names::STDOUT );

		// Tap node for introspection of what the shell is sending.
		$console_tap = new Tap_Node();
		$console_tap->name( Node_Names::CONSOLE_TAP );
		$console_tap->sink( $interpreter );

		// Shell stays anonymous (Shell::name throws); `ls` filters by sink.
		$shell = new Shell_Node();
		$shell->sink( $console_tap );

		// Empty in bare mode; defined here so it's in scope for guarded blocks.
		$worker_id = ( $attached && null !== $ipc ) ? "{$ipc['type']}.p{$ipc['partition']}" : '';
		if ( $attached && null !== $ipc ) {
			$shell->prompt = "/{$worker_id}> ";
		}

		$dumper->set_shell( $shell );
		$stdout->set_shell( $shell );
		[ , , $has_readline ] = $this->terminal();
		$stdout->set_readline_mode( $has_readline );

		if ( $attached && null !== $ipc ) {
			// 1-partition IPC; skip allow_large_writes for concurrent appends.
			$ipc_out = new Partition_Node();
			$ipc_out->arguments( Worker_Base::ipc_partition_args( $ipc['input'] ) );
			$ipc_out->name( $worker_id );
			$ipc_out->sink( $interpreter );
			$shell->path = $worker_id;

			// reply-in: ephemeral, so empty offsetlog_dir (no durable cursor).
			$reply_in = new Node();
			$reply_in->sink( $router );
			$reply_in->target( Node_Names::OUTPUT );
			$ipc_in = new Consumer_Node();
			$ipc_in->arguments( [ $ipc['output'] ] );
			$ipc_in->next_offset( 'end' );
			// Worker id at the HEAD of FROM; the tail is the worker's own text.
			$ipc_in->set_stamp_as( $worker_id );
			$ipc_in->sink( $reply_in );
		}

		// Renders only empty-TO or this-pid messages here; other sessions drop.
		$dumper->set_to_filter( $pid );

		return [ $shell, $dumper, $stdout ];
	}

	/**
	 * The stdin stream and the readline policy it implies, derived ONCE.
	 *
	 * A test may point the `$stdin` seam at a closure that opens a FRESH stream
	 * per call, so a second derivation would probe a resource nobody drains and
	 * leave the graph and the reader disagreeing about prompts and readline.
	 *
	 * @return array{0:resource,1:bool,2:bool} `[ stdin, is_tty, has_readline ]`.
	 */
	private function terminal(): array {
		if ( null === $this->terminal ) {
			// readline only on a real TTY; on a pipe it spins at 100% CPU.
			$stdin          = ( self::$stdin ?? static fn () => \STDIN )();
			$is_tty         = \function_exists( 'posix_isatty' ) && @\posix_isatty( $stdin );
			$this->terminal = [ $stdin, $is_tty, $is_tty && \function_exists( 'readline_callback_handler_install' ) ];
		}
		return $this->terminal;
	}
}
