<?php
/**
 * Topology_Missing: an active topology name that does not resolve to any
 * `.tsl`.
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes;

\defined( 'ABSPATH' ) || exit;

/**
 * What `Bootstrap::split_readable()` records for an active name that does not
 * resolve to any `.tsl`, typically a plugin removed while its topology stayed
 * active. Such a name declares nothing, so a table or dir lookup reads past it,
 * while a `.tsl` that will not read may declare what is asked and fails the
 * lookup. Every reader that reports topologies — `wp nodes doctor`, the
 * spawn gate, `dump_graph` — still names it. It extends `\RuntimeException`,
 * so every catch that took the plain refusal takes this one.
 */
final class Topology_Missing extends \RuntimeException {}
