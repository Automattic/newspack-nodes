<?php
/**
 * A Remote_Source subclass, for pinning that the aggregator finds a spoke
 * reader by lineage rather than by its literal token.
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes\Tests\Fixtures;

\defined( 'ABSPATH' ) || exit;

class Okapi_Pull_Node extends \Newspack_Nodes\Remote_Source_Node {}
