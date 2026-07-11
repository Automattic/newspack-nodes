<?php
/**
 * Worker_Should_Stop_Clean: a cooperative stop raised at a message boundary where
 * the in-flight message is already fully processed.
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes;

\defined( 'ABSPATH' ) || exit;

/**
 * A Worker_Should_Stop variant meaning "the stop was honored at a point where the
 * current message's downstream work is COMPLETE": every partition write is durable
 * (Partition beats the heartbeat AFTER its write) and the snapshot node finished its
 * per-message bookkeeping before re-raising this. It lets the Consumer commit PAST
 * the message (checkpoint at the ID's offset+length) instead of re-delivering it, so
 * a clean max_runtime recycle doesn't replay-and-dedup the last-consumed message.
 *
 * Plain Worker_Should_Stop keeps its at-least-once semantics: a job interrupted
 * mid-run (Job_Worker) raises the plain form, so the Consumer leaves the cursor put
 * and the successor replays it (ADR-8). The subtype is the only signal that gates
 * advance-past — no per-consumer flag. Being a subclass, every existing broad
 * `catch ( Worker_Should_Stop )` (ADR-14) still catches it unchanged.
 */
class Worker_Should_Stop_Clean extends Worker_Should_Stop {}
