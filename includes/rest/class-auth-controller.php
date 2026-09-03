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
use Newspack_Nodes\Sessions;

\defined( 'ABSPATH' ) || exit;

/**
 * Issues a scoped command-signing session to a caller WordPress has already
 * authenticated, so every command that caller later mints proves its own origin.
 */
class Auth_Controller {

	/**
	 * Gate the request on the fleet site, then on the READ role. The fleet is
	 * network-global — locks, IPC and logs carry no blog namespace — so a
	 * subsite admin must not mint a session against the main site's fleet.
	 *
	 * READ rather than MANAGE because a scope is a CEILING: a session minted by
	 * a read-only user can only ever do read-only things whatever it asks for,
	 * and `issue()` clamps the granted scope to match.
	 *
	 * @param \WP_REST_Request $req Request; the gate reads nothing from it.
	 * @return bool|\WP_Error True to proceed, false when the user holds none of the three roles, a 403 on a subsite.
	 */
	public function check_permission( \WP_REST_Request $req ) {
		$gate = Bootstrap::fleet_gate();
		if ( null !== $gate ) {
			return $gate;
		}
		if ( ! Capabilities::can( Capabilities::READ ) ) {
			return false;
		}
		return true;
	}

	/**
	 * Issue a session. The response is the only place the key is ever disclosed,
	 * so a client that loses it re-auths rather than recovers it.
	 *
	 * Three optional request fields shape the session. `scope` defaults to
	 * `manage` and is CLAMPED to the highest role the minting user actually
	 * holds, so the Sessions tab lists a session's real authority rather than
	 * what it asked for; an unrecognised scope is refused outright. `ttl` is
	 * clamped to `Command_Auth::SESSION_TTL_MIN_S`..`SESSION_TTL_MAX_S`. `label`
	 * is how the session shows up in that tab, and an empty one keeps it out of
	 * the listing entirely.
	 *
	 * `highest_held()` returns null only for a user holding no role at all,
	 * which `check_permission()` has already refused; answering 403 here keeps
	 * the clamp and the refusal in one decision rather than trusting every
	 * caller to gate first.
	 *
	 * @param \WP_REST_Request $req Request carrying the optional `scope`, `ttl` and `label`.
	 * @return array{handle:string,key:string,scope:string,expires_in:int,now:int}|\WP_Error
	 * @throws \RuntimeException When no cache backend can hold the session, or the handle is taken.
	 */
	public function issue( \WP_REST_Request $req ) {
		$requested = Core::as_string( $req->get_param( 'scope' ) ?? '', Capabilities::MANAGE );
		if ( '' === $requested ) {
			$requested = Capabilities::MANAGE;
		}
		if ( ! Capabilities::scope_covers( $requested, Capabilities::READ ) ) {
			return new \WP_Error( 'invalid_scope', 'Unknown session scope.', [ 'status' => 400 ] );
		}

		$granted = Capabilities::highest_held( $requested );
		if ( null === $granted ) {
			return new \WP_Error( 'invalid_scope', 'No capability to mint a session with.', [ 'status' => 403 ] );
		}

		$ttl     = Command_Auth::bounded_ttl( Core::num_int( $req->get_param( 'ttl' ), Command_Auth::SESSION_TTL_S ) );
		$session = Command_Auth::mint_session( $granted, $ttl );
		Sessions::record(
			$session['handle'],
			$granted,
			Core::as_string( $req->get_param( 'label' ) ?? '' ),
			$ttl
		);
		return $session;
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
