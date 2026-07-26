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

\defined( 'ABSPATH' ) || exit;

class Auth_Controller {

	/**
	 * Gate: fleet site, then capability. The fleet is network-global — locks, IPC
	 * and logs carry no blog namespace — so a subsite admin must not mint a
	 * session against the main site's fleet.
	 *
	 * @param \WP_REST_Request $req Request.
	 * @return bool|\WP_Error
	 */
	public function check_permission( \WP_REST_Request $req ) {
		if ( ! Bootstrap::fleet_site() ) {
			return new \WP_Error( 'newspack_nodes_not_fleet_site', 'multisite subsite: the fleet runs on the main site only', [ 'status' => 403 ] );
		}
		if ( ! \function_exists( 'current_user_can' ) || ! Capabilities::can( Capabilities::MANAGE ) ) {
			return false;
		}
		return true;
	}

	/**
	 * Issue a session. The response is the only place the key is ever disclosed.
	 *
	 * @param \WP_REST_Request $req Request.
	 * @return array{handle:string,key:string,expires_in:int}
	 */
	public function issue( \WP_REST_Request $req ): array {
		return Command_Auth::mint_session();
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
