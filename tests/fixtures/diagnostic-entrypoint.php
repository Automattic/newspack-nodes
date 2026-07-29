<?php
/**
 * Isolated production-entrypoint harness for dependency-free diagnostics.
 *
 * @package Newspack_Nodes\Tests
 */

$surface = $argv[1] ?? '';
if ( ! \in_array( $surface, [ 'site-health', 'doctor', 'health-rest', 'topology-console' ], true ) ) {
	throw new \InvalidArgumentException( 'Unknown diagnostic surface.' );
}

$blocked_parent = \tempnam( \sys_get_temp_dir(), 'newspack-nodes-blocked-parent-' );
$config_stub    = \tempnam( \sys_get_temp_dir(), 'newspack-nodes-invalid-config-' );
if ( false === $blocked_parent || false === $config_stub ) {
	throw new \RuntimeException( 'Could not create the diagnostic-entrypoint fixtures.' );
}
$config_file = $config_stub . '.php';
if ( ! \rename( $config_stub, $config_file ) ) {
	throw new \RuntimeException( 'Could not name the diagnostic-entrypoint config as PHP.' );
}

$topology_fixture = 'topology-console' === $surface;
$blocked_base     = $blocked_parent . '/diagnostic-runtime-8843';
$runtime_base     = $blocked_base;
$topology_file    = '';
if ( $topology_fixture ) {
	if ( ! \unlink( $blocked_parent ) ) {
		throw new \RuntimeException( 'Could not prepare the topology-console fixture root.' );
	}
	$runtime_base  = $blocked_parent . '/runtime';
	$topology_file = $runtime_base . '/topologies/admin-entrypoint-8843.tsl';
	if ( ! \mkdir( \dirname( $topology_file ), 0700, true ) ) {
		throw new \RuntimeException( 'Could not create the topology-console fixture directories.' );
	}
	if ( false === \file_put_contents( $topology_file, "var num_partitions = 7;\n" ) ) {
		throw new \RuntimeException( 'Could not write the topology-console fixture.' );
	}
}

$config_values = [
	'base_directory'  => $runtime_base,
	'spawn_verify_ssl' => false,
];
if ( 'site-health' === $surface ) {
	$config_values['memcache_servers'] = [ '127.0.0.1:11943' ];
}
if ( $topology_fixture ) {
	$config_values['num_partitions'] = 6;
	$config_values['topologies']     = [ 'admin-entrypoint-8843' ];
}
$config = "<?php\nreturn " . \var_export( $config_values, true ) . ";\n";
if ( false === \file_put_contents( $config_file, $config ) ) {
	throw new \RuntimeException( 'Could not write the diagnostic-entrypoint config.' );
}

\putenv( 'LOCAL_NEWSPACK_NODES_CONF=' . $config_file );
\define( 'ABSPATH', '/' );
\define( 'NONCE_SALT', 'diagnostic-entrypoint-nonce-salt-8843' );
$GLOBALS['_diagnostic_entrypoint_is_admin'] = \in_array( $surface, [ 'site-health', 'topology-console' ], true );

function is_admin(): bool {
	return (bool) $GLOBALS['_diagnostic_entrypoint_is_admin'];
}

if ( 'doctor' === $surface ) {
	\define( 'WP_CLI', true );

	class WP_CLI {
		/** @var array<string,mixed> */
		public static array $commands = [];

		/** @var list<string> */
		public static array $logs = [];

		/** @var list<string> */
		public static array $errors = [];

		public static function add_command( string $name, $callback ): void {
			self::$commands[ $name ] = $callback;
		}

		public static function log( string $message ): void {
			self::$logs[] = $message;
		}

		public static function warning( string $message ): void {
			self::$logs[] = $message;
		}

		public static function error( string $message ): void {
			self::$errors[] = $message;
			throw new \RuntimeException( 'WP_CLI_ERROR: ' . $message );
		}

		public static function success( string $message ): void {
			self::$logs[] = $message;
		}
	}
}

require_once \dirname( __DIR__ ) . '/Helpers/wp-shims.php';

$result = [];
try {
	require \dirname( __DIR__, 2 ) . '/newspack-nodes.php';

	if ( 'site-health' === $surface ) {
		\Newspack_Nodes\Cache_Backend::$apcu_usable = static fn (): bool => true;
		$selected_cache = \Newspack_Nodes\Cache_Backend::shared_first();
		$cache_backend  = null === $selected_cache ? null : $selected_cache->backend_name();
		// Avoid probing the intentionally unreachable fixture server below; the
		// assertion above already captures which production backend won.
		\Newspack_Nodes\Core::$memd = null;
		\Newspack_Nodes\Cache_Backend::$apcu_usable = static fn (): bool => false;

		\do_action( 'admin_init' );
		$tests    = \apply_filters( 'site_status_tests', [ 'direct' => [], 'async' => [] ] );
		$callback = $tests['direct'][ \Newspack_Nodes\Bootstrap::SITE_HEALTH_TEST ]['test'] ?? null;
		$health   = \is_callable( $callback ) ? $callback() : null;
		$result   = [
			'registered'  => \is_callable( $callback ),
			'status'      => \is_array( $health ) ? ( $health['status'] ?? null ) : null,
			'description' => \is_array( $health ) ? ( $health['description'] ?? null ) : null,
			'cache_backend' => $cache_backend,
		];
	} elseif ( 'doctor' === $surface ) {
		$probe_args = null;
		$body       = \wp_json_encode(
			[
				'id'       => \Newspack_Nodes\Health_Checks::CACHE_ID,
				'label'    => \Newspack_Nodes\Health_Checks::CACHE_LABEL,
				'status'   => \Newspack_Nodes\Health_Checks::STATUS_GOOD,
				'messages' => [ 'Diagnostic entrypoint cache probe 8843 succeeded.' ],
			]
		);
		\Newspack_Nodes\Health_Probe_Client::$clock = static fn (): int => 2_000_027;
		\Newspack_Nodes\Health_Probe_Client::$http_call = static function ( string $url, array $args ) use ( &$probe_args, $body ): array {
			$probe_args = $args;
			return [
				'response' => [ 'code' => 200 ],
				'body'     => $body,
			];
		};
		$callback = \WP_CLI::$commands['nodes doctor'] ?? null;
		try {
			if ( \is_callable( $callback ) ) {
				$callback( [], [] );
			}
		} catch ( \RuntimeException $e ) {
			if ( ! \str_starts_with( $e->getMessage(), 'WP_CLI_ERROR: ' ) ) {
				throw $e;
			}
		}
		$result = [
			'registered' => \is_callable( $callback ),
			'logs'       => \WP_CLI::$logs,
			'errors'     => \WP_CLI::$errors,
			'sslverify'  => \is_array( $probe_args ) ? ( $probe_args['sslverify'] ?? null ) : null,
		];
	} elseif ( 'health-rest' === $surface ) {
		\do_action( 'rest_api_init' );
		$route = null;
		foreach ( $GLOBALS['_wp_test_registered_routes'] as $registered_route ) {
			if ( '/health/cache' === $registered_route['route'] ) {
				$route = $registered_route;
				break;
			}
		}

		$permission = false;
		$status     = null;
		if ( null !== $route ) {
			$now = 2_000_027;
			\Newspack_Nodes\Rest\Health_Cache_Controller::$clock = static fn (): int => $now;
			$token = \Newspack_Nodes\Internal_Request_Token::generate(
				\Newspack_Nodes\Internal_Request_Token::PURPOSE_HEALTH_CACHE,
				$now,
				\wp_salt( 'nonce' )
			);
			$request = new \WP_REST_Request( 'POST', '/newspack-nodes/v1/health/cache' );
			$request->set_param( 'token', $token );
			$permission = ( $route['args']['permission_callback'] )( $request );
			if ( true === $permission ) {
				$response = ( $route['args']['callback'] )( $request );
				$status   = $response->get_status();
			}
		}
		$result = [
			'registered' => null !== $route,
			'permission' => true === $permission,
			'status'     => $status,
		];
	} else {
		$bundles = \apply_filters( 'newspack_nodes/devtools_tab_bundles', [] );
		$console = null;
		foreach ( $bundles as $bundle ) {
			if ( \is_array( $bundle ) && 'newspack-nodes-topology-console' === ( $bundle['handle'] ?? '' ) ) {
				$console = $bundle;
				break;
			}
		}
		$localize = \is_array( $console ) && \is_array( $console['localize'] ?? null ) ? $console['localize'] : [];
		$result   = [
			'registered'        => null !== $console,
			'topology_workers'  => $localize['topologyWorkers'] ?? null,
			'active_topologies' => $localize['activeTopologies'] ?? null,
		];
	}
} catch ( \Throwable $e ) {
	$result = [
		'error_class'   => $e::class,
		'error_message' => $e->getMessage(),
	];
} finally {
	\unlink( $config_file );
	if ( $topology_fixture ) {
		\unlink( $topology_file );
		\rmdir( \dirname( $topology_file ) );
		\rmdir( $runtime_base );
		\rmdir( $blocked_parent );
	} else {
		\unlink( $blocked_parent );
	}
}

$result['blocked_base'] = $blocked_base;
echo \json_encode( $result, \JSON_THROW_ON_ERROR );
