<?php
/**
 * A Partition subclass, for pinning that the write-set gate identifies writers
 * by TYPE rather than by literal token. A plugin that subclasses Partition to
 * add behaviour still writes the same log, so it must appear in the write set —
 * `find_conflicts` and `Log_Cleaner`'s declared-dir set both read it.
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes\Tests\Fixtures;

\defined( 'ABSPATH' ) || exit;

class Wombat_Partition_Node extends \Newspack_Nodes\Partition_Node {}
