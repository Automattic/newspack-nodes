<?php
namespace Newspack_Nodes\Tests;

use Newspack_Nodes\Command_Auth;

/**
 * The two builders every MCP door test reaches for: a JSON-RPC POST carrying
 * a bearer, and a command session minted with its `<handle>.<key>` bearer.
 */
trait Mcp_Requests {

	/** A POST whose body is `$body` as JSON, with `$bearer` and `$route` when given. */
	private function request( array $body, ?string $bearer = null, string $route = '' ): \WP_REST_Request {
		$req = new \WP_REST_Request();
		$req->set_body( (string) \wp_json_encode( $body ) );
		if ( '' !== $route ) {
			$req->set_route( $route );
		}
		if ( null !== $bearer ) {
			$req->set_header( 'authorization', "Bearer {$bearer}" );
		}
		return $req;
	}

	/**
	 * A session of `$scope` minted for 900 s under `$label`, and its bearer.
	 *
	 * @return array{0:array<string,mixed>,1:string}
	 */
	private function session( string $scope, string $label = '' ): array {
		$minted = Command_Auth::mint_session( $scope, 900, $label );
		return [ $minted, $minted['handle'] . '.' . $minted['secret'] ];
	}
}
