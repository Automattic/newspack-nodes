<?php
/**
 * AuthController: REST endpoint that issues a command-signing session.
 *
 * A client establishes a session before it may send commands, then signs each
 * command with the session key. That moves signing from the ingress boundary to
 * the node that MINTS a command — `HTTP_In` conferring authority on arrival made
 * the boundary an oracle, since anything reaching it acquired authority whatever
 * put it there.
 *
 * The key and its handle are generated here. A caller supplies nothing: caller
 * entropy is unverifiable, and a caller-chosen handle could collide with or
 * fixate a live session.
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

class Auth_Controller {

	/**
	 * Gate: fleet site, then the READ floor. The fleet is network-global —
	 * locks, IPC and logs carry no blog namespace — so a subsite admin must not
	 * mint a session against the main site's fleet.
	 *
	 * READ rather than MANAGE because a scope is a CEILING: a session minted by
	 * a read-only user can only ever do read-only things whatever it asks for,
	 * and `issue()` clamps the label to match.
	 *
	 * @param \WP_REST_Request $req Request.
	 * @return bool|\WP_Error
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
	 * Issue a session. The response is the only place the key is ever disclosed.
	 *
	 * The requested scope is CLAMPED to the highest role the minting user
	 * actually holds, so the Sessions tab lists a session's real authority
	 * rather than what it asked for. An unrecognised scope is refused outright.
	 *
	 * @param \WP_REST_Request $req Request.
	 * @return array{handle:string,key:string,scope:string,expires_in:int,now:int}|\WP_Error
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

	/** @api Wired from Bootstrap::register_rest_routes(). */
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
