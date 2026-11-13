<?php
/**
 * `POST /newspack-nodes/v1/auth`: issues the session a client signs commands with.
 *
 * A client establishes a session before it may send commands, then signs each
 * command with the session key. Signing belongs to the node that MINTS a
 * command rather than to the ingress: conferring authority on arrival makes the
 * boundary an oracle, since anything reaching it acquires authority whatever
 * put it there. ADR-15 carries the full rationale.
 *
 * The key and its handle are generated here, never taken from the caller:
 * caller entropy is unverifiable, and a caller-chosen handle could collide with
 * or fixate a live session.
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes\Rest;

use Newspack_Nodes\Bootstrap;
use Newspack_Nodes\Capabilities;
use Newspack_Nodes\Command_Auth;
use Newspack_Nodes\Core;
use Newspack_Nodes\Rate_Limit;
use Newspack_Nodes\Session_Store_Unavailable;
use Newspack_Nodes\Sessions;

\defined( 'ABSPATH' ) || exit;

/**
 * Issues a scoped command-signing session to a caller WordPress has already
 * authenticated, so every command that caller later mints proves its own origin.
 */
class Auth_Controller {

	/**
	 * Default per-user budget of mints per RATE_LIMIT_WINDOW_S. A dashboard
	 * mints once a page load and a hub once a session's life, so the cap
	 * bounds the session rows a script can write, not normal use; the
	 * `newspack_nodes/auth_rate_limit` filter raises it.
	 */
	public const RATE_LIMIT_BURST = 30;

	/** Slot TTL, in seconds: each mint holds its slot for a minute. */
	public const RATE_LIMIT_WINDOW_S = 60;

	/**
	 * Gate the request on the fleet site, then on a signed-in user, then on
	 * the user's mint budget. The fleet is network-global — locks, IPC and
	 * logs carry no blog namespace — so a subsite admin must not mint a
	 * session against the main site's fleet.
	 *
	 * A login rather than a role because a scope is a CEILING: `issue()` clamps
	 * the granted scope to the highest role the user holds, and to `none` for
	 * a user holding no role, whose session then runs only the `wp:` commands
	 * their own capabilities reach (ADR-26). Since any signed-in user may
	 * mint, each mint claims one of the user's `auth:<user>` slots through
	 * `Rate_Limit`, after the login so an anonymous flood spends none. A cache
	 * that cannot meter admits the mint and warns through `admit_unmetered()`,
	 * as `/command` does, because a dead memcached must not lock every editor
	 * and dashboard out of a session.
	 *
	 * @param \WP_REST_Request $req Request; the gate reads nothing from it.
	 * @return bool|\WP_Error True to proceed, false with nobody signed in, a 403 on a subsite, a 429 over budget.
	 */
	public function check_permission( \WP_REST_Request $req ) {
		$gate = Bootstrap::fleet_gate();
		if ( null !== $gate ) {
			return $gate;
		}
		$user = Core::current_user_id();
		if ( 0 === $user ) {
			return false;
		}
		/**
		 * Tunable mints per RATE_LIMIT_WINDOW_S, clamped to 1 through
		 * `Rate_Limit::MAX_BURST`. Defaults to RATE_LIMIT_BURST.
		 *
		 * @param int $burst Max `/auth` mints per user per window.
		 */
		$burst = Core::as_int( \apply_filters( 'newspack_nodes/auth_rate_limit', self::RATE_LIMIT_BURST ) );
		return Rate_Limit::gate( '/auth', "auth:{$user}", $burst, self::RATE_LIMIT_WINDOW_S );
	}

	/**
	 * Issue a session. The response is the only place the key is ever disclosed,
	 * so a client that loses it re-auths rather than recovers it.
	 *
	 * Three optional request fields shape the session. `scope` defaults to
	 * `manage` (`tune` for a labelled request, which may hold only a
	 * `Capabilities::LABELLED_SCOPES` scope) and is CLAMPED to the highest role the
	 * minting user holds, so the Sessions tab lists a session's real
	 * authority rather than what it asked for; an unrecognised scope is
	 * refused outright. `ttl` is clamped to
	 * `Command_Auth::SESSION_TTL_MIN_S`..`SESSION_TTL_MAX_S`. `label` is how
	 * the session shows up in that tab, and an empty one keeps it out of the
	 * listing entirely.
	 *
	 * A user holding no role at all, for whom `highest_held()` answers null,
	 * is issued an unlabelled `Capabilities::NONE` session, which covers no
	 * role and runs only the `wp:` commands their own capabilities reach. A
	 * labelled request from that user answers 403: a labelled session is a
	 * hand-issued key, for a CLI, an MCP client or a hub's vault, which every
	 * `wp:` command refuses, and every MCP door refuses a `none` session.
	 *
	 * A session the store cannot hold answers 503 `session_store_unavailable`,
	 * because the fault lies with the server rather than the caller. The backend's
	 * own cause goes to the log, never into the response.
	 *
	 * @param \WP_REST_Request $req Request carrying the optional `scope`, `ttl` and `label`.
	 * @return array{handle:string,secret:string,scope:string,expires_in:int,now:int}|\WP_Error
	 */
	public function issue( \WP_REST_Request $req ) {
		$label     = Core::as_string( $req->get_param( 'label' ) ?? '' );
		$fallback  = '' === $label ? Capabilities::MANAGE : Capabilities::TUNE;
		$requested = Core::as_string( $req->get_param( 'scope' ) ?? '', $fallback );
		if ( '' === $requested ) {
			$requested = $fallback;
		}
		$known = '' === $label
			? Capabilities::scope_covers( $requested, Capabilities::READ )
			: \in_array( $requested, Capabilities::LABELLED_SCOPES, true );
		if ( ! $known ) {
			return new \WP_Error( 'invalid_scope', 'Unknown session scope.', [ 'status' => 400 ] );
		}

		$granted = Capabilities::highest_held( $requested ) ?? ( '' === $label ? Capabilities::NONE : null );
		if ( null === $granted ) {
			return new \WP_Error( 'invalid_scope', 'No capability to mint a session with.', [ 'status' => 403 ] );
		}

		$ttl   = Command_Auth::bounded_ttl( Core::num_int( $req->get_param( 'ttl' ), Command_Auth::SESSION_TTL_S ) );
		try {
			return Sessions::issue( $label, $granted, $ttl );
		} catch ( Session_Store_Unavailable $e ) {
			Core::print_less_often( 'Auth_Controller: 503, ', $e->getMessage() );
			return new \WP_Error(
				'session_store_unavailable',
				'The session could not be stored because the session store is unavailable.',
				[ 'status' => 503 ]
			);
		}
	}

	/**
	 * Register the route. It declares no `args`: every field is optional, and
	 * `issue()` reads and bounds each one itself.
	 *
	 * @api Wired from Bootstrap::register_rest_routes().
	 */
	public function register_routes(): void {
		\register_rest_route(
			'newspack-nodes/v1',
			'/auth',
			[
				'methods'             => 'POST',
				'callback'            => [ $this, 'issue' ],
				'permission_callback' => [ $this, 'check_permission' ],
			]
		);
	}
}
