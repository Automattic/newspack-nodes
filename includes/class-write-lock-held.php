<?php
/**
 * Write_Lock_Held: another live writer holds a Partition's write lock.
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes;

\defined( 'ABSPATH' ) || exit;

/**
 * Raised by `Partition_Node::allow_large_writes()` when the write lock is still
 * held at the deadline — contention, as `Lock_Node::acquire_failure()` reports
 * `lock_held`. A lock that cannot be taken for any other reason, an unwritable
 * or missing directory among them, raises a plain `\RuntimeException` instead.
 *
 * A type of its own so the callers that answer contention — `Job_Intake::queue()`
 * with false, `Job_Delay::sweep()` by circulating the entry — catch exactly this
 * and let every other failure propagate. It extends `\RuntimeException`, so a
 * caller that does not care which it was still catches both.
 */
class Write_Lock_Held extends \RuntimeException {}
