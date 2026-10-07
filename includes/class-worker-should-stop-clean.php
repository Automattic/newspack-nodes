<?php
/**
 * Worker_Should_Stop_Clean: the cooperative stop that lets a durable reader commit
 * past the message it was carrying instead of replaying it.
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes;

\defined( 'ABSPATH' ) || exit;

/**
 * A Worker_Should_Stop raised where the in-flight message's downstream work is
 * COMPLETE: the Partition appended the record and flushes it before letting the stop
 * unwind (`maybe_stop()`), and whatever bookkeeping the message owed is finished. On
 * that promise `Durable_Reader::drain_buffer()` advances the cursor past the record —
 * the ID crumb's offset plus length, the same advance a successful forward makes — so
 * a max_runtime recycle does not redeliver a message a snapshot node already counted.
 *
 * Three sites raise it. `Deferred_Clean_Stop::deferring()` raises it once a snapshot
 * node has finished the message it held a stop around. `Durable_Reader` and
 * `Remote_Consumer_Node` convert a bare plain stop into it when the reader's
 * `assume_clean_shutdown` declares a chain that writes durably before the stop and
 * has no snapshot node to speak for it. Converting at the raise keeps
 * `drain_buffer()` gating on `Worker_Should_Stop::is_clean()` alone.
 *
 * The subtype alone is not the promise: only a Clean stop carrying NO previous is
 * clean. PHP appends an in-flight exception as the previous of one thrown in a
 * `finally`, so a Clean stop can arrive carrying a failure, and then its record
 * never became durable. Every reader deciding "commit past" asks `is_clean()`.
 *
 * A plain Worker_Should_Stop keeps at-least-once semantics: the cursor stays put and
 * the successor replays the message (ADR-8). For that same reason a fan-out's
 * combined result is clean only when EVERY target raised a clean stop
 * (`Worker_Should_Stop::combine()`) — advancing past a message that needed a replay
 * loses it, while replaying a clean one is a duplicate the contract tolerates. Being
 * a subclass, it is also caught by every broad `catch ( Worker_Should_Stop )` on the
 * drain path (ADR-14).
 */
class Worker_Should_Stop_Clean extends Worker_Should_Stop {}
