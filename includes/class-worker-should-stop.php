<?php
/**
 * Worker_Should_Stop: cooperative-stop signal raised from inside a long job.
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes;

\defined( 'ABSPATH' ) || exit;

/**
 * Thrown by Event_Framework::pump() when the worker's drain continue-predicate
 * reports the worker should stop (max_runtime overrun, restart request, memory
 * watermark, lock loss) while a long in-process job is starving the drain loop.
 *
 * It lets the job unwind cooperatively from deep inside fill(): Job_Worker_Node
 * re-throws it past its per-job Throwable swallow (after_job still runs), and
 * Worker_Base::execute() catches it as a normal stop (release + respawn).
 */
class Worker_Should_Stop extends \RuntimeException {}
