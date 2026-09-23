<?php
/**
 * Session_Store_Unavailable: a command session was minted but not stored.
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes;

\defined( 'ABSPATH' ) || exit;

/**
 * Raised by `Command_Auth::mint_session()` when no cache backend is usable or
 * the one selected refused the write. The session key never leaves the mint,
 * because a key its verifier cannot resolve signs nothing.
 *
 * A type of its own so `/auth` can answer 503 for exactly this and still let
 * anything else propagate. It extends `\RuntimeException`, so a service CI's
 * central catch reports it as TM_ERROR like any other refusal.
 */
class Session_Store_Unavailable extends \RuntimeException {}
