<?php
/**
 * Table_Unavailable: a Table's backend cannot open on this host.
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes;

\defined( 'ABSPATH' ) || exit;

/**
 * Raised by `Table_Node::arguments()` when the arm its backend names cannot
 * open here: pdo_sqlite missing, a SQLite file or directory that cannot open
 * or refuses WAL mode, a SQLite mount in a process running as root, a `wpdb`
 * table the server will not create or a packet limit it will not report, no
 * memcached handle, or APCu unusable. The arm's own refusal is the previous.
 * A SQLite mount whose file does not exist yet is not one: its worker has
 * written nothing, so the mount reads as empty.
 *
 * A type of its own so a reader can degrade for exactly this while a
 * misconfiguration — a Table two topologies declare differently, a bad TTL,
 * a name no file can carry, a topology that will not read — still fails
 * loud. It extends `\RuntimeException`, so every catch that took the plain
 * refusal takes this one.
 */
class Table_Unavailable extends \RuntimeException {}
