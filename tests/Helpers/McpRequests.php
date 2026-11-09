<?php
namespace Newspack_Nodes\Tests;

use Newspack_Nodes\Command_Auth;
use Newspack_Nodes\Core;
use Newspack_Nodes\Mcp_Door;
use Newspack_Nodes\Tests\Helpers\InMemoryMemcached;

/**
 * What every MCP door test reaches for: a JSON-RPC POST carrying a bearer, a
 * command session minted with its `<handle>.<key>` bearer, a door's listing
 * and one tool call through it, and an in-memory memcached to meter in.
 */
trait Mcp_Requests {

	/** The memcached `use_in_memory_memcached()` replaced, which `restore_memcached()` puts back. */
	private ?\Memcached $prev_memd = null;

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

	/**
	 * The tools `$door` lists for the session `$bearer` names, keyed by name in listing order.
	 *
	 * @return array<string,array<string,mixed>>
	 */
	private function listed( Mcp_Door $door, string $bearer ): array {
		$tools = $door->dispatch( $this->request( [ 'jsonrpc' => '2.0', 'id' => 31, 'method' => 'tools/list' ], $bearer ) )['result']['tools'];
		return \array_column( $tools, null, 'name' );
	}

	/** One `tools/call` of `$tool` through `$door`, under JSON-RPC id `$id`. */
	private function call( Mcp_Door $door, string $bearer, string $tool, array $arguments, int $id = 5 ): array {
		return $door->dispatch(
			$this->request(
				[
					'jsonrpc' => '2.0',
					'id'      => $id,
					'method'  => 'tools/call',
					'params'  => [ 'name' => $tool, 'arguments' => $arguments ],
				],
				$bearer
			)
		);
	}

	/** Meter in an in-memory memcached; call after the parent `setUp()`, which resets `Core::$memd`. */
	private function use_in_memory_memcached(): void {
		$this->prev_memd = Core::$memd;
		Core::$memd      = new InMemoryMemcached();
	}

	/** Put back the memcached `use_in_memory_memcached()` replaced. */
	private function restore_memcached(): void {
		Core::$memd = $this->prev_memd;
	}
}
