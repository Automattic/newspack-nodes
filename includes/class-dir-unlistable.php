<?php
/**
 * Dir_Unlistable: a dir that is there will not list.
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes;

\defined( 'ABSPATH' ) || exit;

/**
 * Raised by `Core::dir_entries()` for a dir that exists and will not list, its
 * message `dir <dir> will not list`. A dir that is not there lists as empty
 * and raises nothing.
 *
 * A type of its own so the paths that would otherwise end a worker on it
 * catch exactly this and say so once through `print_less_often()`:
 * `Timer_Node::fire_cb()`, which costs any timer its tick; `Event_Framework`'s
 * completion dispatch, which costs one cURL completion; `Probe_Node`'s
 * per-node sweep, which passes one node by; `Partition_Node::flush()`, which
 * quarantines the batch whole; `Remote_Consumer_Node::fill()`, which fails a
 * step as refused; `Remote_Broker_Node::consumer_for()`, which refuses a glob
 * reader; and event-logger-nodes' `Owner`. A worker ending on it would only
 * end again on its successor's first tick. Two of them combined into one
 * `Failures`, and a failed quarantine combined with what it was quarantining,
 * are not this type and still propagate. It extends `\RuntimeException`, so a
 * caller that does not care which it was still catches both.
 */
class Dir_Unlistable extends \RuntimeException {}
