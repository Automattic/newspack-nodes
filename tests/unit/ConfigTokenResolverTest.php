<?php
declare(strict_types=1);

namespace Newspack_Nodes\Tests\Unit;

use Newspack_Nodes\Config;
use Newspack_Nodes\Core;
use Newspack_Nodes\Shell_Node;
use Newspack_Nodes\Tests\TestCase;

class ConfigTokenResolverTest extends TestCase {

	/** Snapshot of the process-lifetime resolver registry, restored in tearDown. */
	private array $saved_resolvers;

	protected function setUp(): void {
		parent::setUp();
		$this->saved_resolvers = Core::$config_resolvers;
	}

	protected function tearDown(): void {
		Core::$config_resolvers = $this->saved_resolvers;
		parent::tearDown();
	}

	public function test_register_and_resolve_returns_resolver_value(): void {
		Core::register_config_namespace( 'acme', static fn ( string $key ): string => 'value-for-' . $key );
		$this->assertSame( 'value-for-foo', Core::resolve_config_token( 'acme', 'foo' ) );
	}

	public function test_resolve_unknown_namespace_returns_empty_string(): void {
		$this->assertSame( '', Core::resolve_config_token( 'no-such-ns', 'foo' ) );
	}

	public function test_resolve_null_from_resolver_returns_empty_string(): void {
		Core::register_config_namespace( 'acme', static fn ( string $key ) => null );
		$this->assertSame( '', Core::resolve_config_token( 'acme', 'missing' ) );
	}

	public function test_resolve_non_scalar_value_returns_empty_string(): void {
		// Real resolvers (e.g. the `config` ns) can return arrays for keys like
		// `topologies` / `memcache_servers`. A token resolving to a non-scalar is
		// not string-interpolatable — it must return '' (with a warning), not fatal
		// on the `: string` return type.
		Core::register_config_namespace( 'acme', static fn ( string $key ) => [ 'not', 'a', 'string' ] );
		$this->assertSame( '', Core::resolve_config_token( 'acme', 'topologies' ) );
	}

	public function test_interpolate_namespaced_token_uses_registered_resolver(): void {
		Core::register_config_namespace( 'acme', static fn ( string $key ): string => 'bar' );
		$shell = new Shell_Node();
		$this->assertSame( 'bar', $shell->interpolate( '<acme:foo>' ) );
	}

	public function test_interpolate_bare_token_reads_core_var(): void {
		Core::$var['bare'] = 'from-var';
		$shell             = new Shell_Node();
		$this->assertSame( 'from-var', $shell->interpolate( '<bare>' ) );
	}

	public function test_interpolate_unregistered_namespace_expands_to_empty(): void {
		$shell = new Shell_Node();
		$this->assertSame( '', $shell->interpolate( '<unreg:x>' ) );
	}

	public function test_substrate_config_namespace_resolves_logs_dir(): void {
		Config::register_token_namespace();
		$this->assertStringEndsWith( '/logs', Core::resolve_config_token( 'config', 'logs_dir' ) );
	}

	public function test_substrate_config_namespace_resolves_offsets_dir(): void {
		Config::register_token_namespace();
		$this->assertStringEndsWith( '/offsets', Core::resolve_config_token( 'config', 'offsets_dir' ) );
	}

	public function test_substrate_config_namespace_resolves_config_value_as_string(): void {
		Config::register_token_namespace();
		// num_partitions is 1 in the test config; tokens always resolve to strings.
		$this->assertSame( '1', Core::resolve_config_token( 'config', 'num_partitions' ) );
	}

	public function test_resolvers_survive_core_reset(): void {
		Core::register_config_namespace( 'acme', static fn ( string $key ): string => 'persisted' );
		Core::reset();
		$this->assertSame( 'persisted', Core::resolve_config_token( 'acme', 'foo' ) );
	}

	public function test_resolve_unknown_namespace_warns_on_stderr(): void {
		$buf = '';
		Core::set_stderr_handler( function ( $msg ) use ( &$buf ) { $buf .= $msg; } );

		// Unknown namespace returns '' for back-compat but must surface a
		// rate-limited warning so a typo in `<unknown:key>` is diagnosable.
		$this->assertSame( '', Core::resolve_config_token( 'no-such-ns', 'foo' ) );

		$this->assertStringContainsString( 'no-such-ns', $buf );
	}

	public function test_resolve_null_value_warns_on_stderr(): void {
		$buf = '';
		Core::set_stderr_handler( function ( $msg ) use ( &$buf ) { $buf .= $msg; } );

		Core::register_config_namespace( 'acme', static fn ( string $key ) => null );
		// Null result returns '' for back-compat but must surface a
		// rate-limited warning so a typo in `<acme:missing>` is diagnosable.
		$this->assertSame( '', Core::resolve_config_token( 'acme', 'missing' ) );

		$this->assertStringContainsString( 'acme', $buf );
		$this->assertStringContainsString( 'missing', $buf );
	}
}
