<?php
/**
 * The substrate's declared-key schema and its defaults must live in CODE.
 *
 * Deriving either from `newspack-nodes-config.php` means an install whose file
 * predates a key declares nothing for it, and the first `Config::value()` read
 * throws "unknown config key" — fataling every request. Nuclear Gyrobase took
 * the live site down that way on 2026-07-13; the substrate's version of the
 * same bug was quieter, because a key absent from an operator's older file
 * resolved to null forever and the feature shipped inert.
 *
 * So: Settings_Schema declares every key AND its default, and the config file
 * is a commented ledger of the same values — an override surface, never the
 * definition. These tests hold the two together.
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes\Tests\Unit;

use PHPUnit\Framework\Attributes\CoversClass;
use Newspack_Nodes\Config;
use Newspack_Nodes\Settings_Schema;
use Newspack_Nodes\SSE_Slot_Pool;
use Newspack_Nodes\Tests\TestCase;

#[CoversClass( Settings_Schema::class )]
#[CoversClass( Config::class )]
class ConfigSchemaTest extends TestCase {

	/** Overrides seeded here are distinct from every schema default. */
	private const SSE_OVERRIDES = [
		'sse_max_streams'    => 23,
		'sse_reserved_slots' => 4,
		'sse_max_slots'      => 7,
		'sse_slot_ttl'       => 91,
	];

	protected function setUp(): void {
		parent::setUp();
		$schema = new \ReflectionProperty( Settings_Schema::class, 'schema' );
		$schema->setValue( null, null );
		SSE_Slot_Pool::$max_slots      = null;
		SSE_Slot_Pool::$max_streams    = null;
		SSE_Slot_Pool::$reserved_slots = null;
		SSE_Slot_Pool::$ttl            = null;
	}

	protected function tearDown(): void {
		Config::$read_shipped_config   = null;
		Config::reset();
		SSE_Slot_Pool::$max_slots      = null;
		SSE_Slot_Pool::$max_streams    = null;
		SSE_Slot_Pool::$reserved_slots = null;
		SSE_Slot_Pool::$ttl            = null;
		parent::tearDown();
	}

	/**
	 * Every key the substrate reads through `Config::value()` is schema-declared.
	 *
	 * The stronger form of the old bootstrap-only scrape: a key read anywhere in
	 * the plugin but declared nowhere throws at the read, and the config file
	 * can no longer supply the declaration.
	 */
	public function test_the_schema_declares_every_key_the_substrate_reads(): void {
		$declared = Settings_Schema::get()->overlay_keys();
		$missing  = [];
		foreach ( self::keys_read_by_the_substrate() as $key => $where ) {
			if ( ! \in_array( $key, $declared, true ) ) {
				$missing[] = "{$key} (read in {$where})";
			}
		}

		$this->assertSame( [], $missing, "keys read but not declared:\n" . \implode( "\n", $missing ) );
	}

	/** Every declared key carries its default in code, so no file is required. */
	public function test_the_schema_supplies_a_default_for_every_declared_key(): void {
		$defaults = Settings_Schema::get()->defaults();

		$this->assertSame(
			[],
			\array_values( \array_diff( Settings_Schema::get()->overlay_keys(), \array_keys( $defaults ) ) ),
			'a declared key with no code default is null on every install whose file predates it'
		);
	}

	/** The four SSE knobs resolve to the platform budget with no config file. */
	public function test_the_sse_budget_resolves_from_the_schema_without_a_config_file(): void {
		\putenv( 'LOCAL_NEWSPACK_NODES_CONF' );
		Config::reset();

		$this->assertSame( 6, Config::value( 'sse_max_streams' ) );
		$this->assertSame( 0, Config::value( 'sse_reserved_slots' ) );
		$this->assertSame( 3, Config::value( 'sse_max_slots' ) );
		$this->assertSame( 60, Config::value( 'sse_slot_ttl' ) );

		$this->assertSame( 6, SSE_Slot_Pool::max_streams() );
		$this->assertSame( 0, SSE_Slot_Pool::reserved_slots() );
		$this->assertSame( 3, SSE_Slot_Pool::max_slots() );
		$this->assertSame( 60, SSE_Slot_Pool::ttl() );
	}

	/** A config file still overrides the schema default, key by key. */
	public function test_a_config_file_entry_overrides_the_schema_default(): void {
		$dir = $this->make_temp_dir();
		$this->use_base_dir( $dir, self::SSE_OVERRIDES );

		$this->assertSame( 23, SSE_Slot_Pool::max_streams() );
		$this->assertSame( 4, SSE_Slot_Pool::reserved_slots() );
		$this->assertSame( 7, SSE_Slot_Pool::max_slots() );
		$this->assertSame( 91, SSE_Slot_Pool::ttl() );
	}

	/**
	 * The shipped file's ledger matches the schema, key for key and value for
	 * value. A documented default drifts silently, which is the whole failure
	 * this pair of files exists to close.
	 */
	public function test_the_documented_ledger_matches_the_schema_defaults(): void {
		$schema = Settings_Schema::get()->defaults();
		$ledger = $this->documented_ledger();
		\ksort( $schema );
		\ksort( $ledger );

		$this->assertSame( $schema, $ledger );
	}

	/** A key the schema does not know is an operator typo, and it is NAMED. */
	public function test_unknown_keys_names_the_stray_key(): void {
		$this->assertSame(
			[ 'base_directroy' ],
			Config::unknown_keys( [ 'base_directroy' => '/opt/wrong' ] )
		);
	}

	/** The shipped file names only keys the schema declares. */
	public function test_the_shipped_config_file_only_names_known_keys(): void {
		$this->assertSame( [], Config::unknown_keys( $this->documented_ledger() ) );
	}

	/**
	 * An unknown key in the SHIPPED config file must never fatal the request.
	 *
	 * `setup/newspack-nodes.sh` copies the operator's server config over that
	 * exact path after install, so the file is theirs, not ours. Throwing here
	 * runs at `plugins_loaded:-10001` and takes down every request including
	 * wp-admin, recoverable only over SSH — the 2026-07-13 outage shape. It is
	 * reported instead: rate-limited to stderr, and in Site Health / doctor.
	 */
	public function test_an_unknown_shipped_key_is_reported_not_thrown(): void {
		\putenv( 'LOCAL_NEWSPACK_NODES_CONF' );
		Config::$read_shipped_config = static fn ( array $base ): array =>
			[ ...$base, 'retired_knob' => 'left over from a rename' ];
		Config::reset();

		$this->assertSame( '/tmp/newspack-nodes', Config::value( 'base_directory' ) );
		$this->assertSame( [ 'retired_knob' ], Config::unrecognized_keys() );
	}

	/** A clean shipped file leaves nothing for Site Health to report. */
	public function test_a_clean_shipped_file_reports_no_unrecognized_keys(): void {
		Config::$read_shipped_config = static fn ( array $base ): array => $base;
		Config::reset();
		Config::value( 'base_directory' );

		$this->assertSame( [], Config::unrecognized_keys() );
	}

	/**
	 * A null in the config file falls back to the DECLARED default, not zero.
	 *
	 * `Config_Utils::validate_config_values()` accepts null, and `Core::num_int`
	 * defaults to 0, so an operator writing `'sse_max_streams' => null` would
	 * otherwise collapse the whole-host cap to 1 and every reader with it.
	 */
	public function test_a_null_config_value_falls_back_to_the_declared_default(): void {
		\putenv( 'LOCAL_NEWSPACK_NODES_CONF' );
		Config::$read_shipped_config = static fn ( array $base ): array => [
			...$base,
			'sse_max_streams'    => null,
			'sse_max_slots'      => null,
			'sse_reserved_slots' => null,
			'sse_slot_ttl'       => null,
		];
		Config::reset();

		$this->assertSame( 6, SSE_Slot_Pool::max_streams() );
		$this->assertSame( 3, SSE_Slot_Pool::max_slots() );
		$this->assertSame( 0, SSE_Slot_Pool::reserved_slots() );
		$this->assertSame( 60, SSE_Slot_Pool::ttl() );
	}

	/** Site Health and `wp nodes doctor` both surface the stray key by name. */
	public function test_site_health_reports_an_unrecognized_config_key(): void {
		Config::$read_shipped_config = static fn ( array $base ): array =>
			[ ...$base, 'retired_knob' => 1 ];
		Config::reset();
		Config::value( 'base_directory' );

		$ids = [];
		foreach ( \Newspack_Nodes\Health_Checks::evaluate() as $result ) {
			$ids[ $result['id'] ] = $result;
		}
		$this->assertArrayHasKey( 'config-keys', $ids );
		$this->assertSame( 'critical', $ids['config-keys']['status'] );
		$this->assertStringContainsString( 'retired_knob', $ids['config-keys']['messages'][0] );
	}

	/**
	 * The vault trio is overlay-only. `vault` IS the encrypted credential store
	 * (`newspack_nodes_vault`), and a ui-visible Field's option auto-joins the
	 * Config Audit VALUES allowlist; the two SSL keys turn certificate
	 * verification OFF, which is a config-file decision like `spawn_verify_ssl`,
	 * not a checkbox.
	 */
	public function test_the_vault_trio_is_declared_but_never_rendered(): void {
		$schema = Settings_Schema::get();

		foreach ( [ 'vault', 'vault_verify_ssl', 'vault_require_ssl' ] as $key ) {
			$field = $schema->field_for_short( $key );
			$this->assertNotNull( $field, "{$key} must be declared" );
			$this->assertFalse( $field->ui, "{$key} must never render in the settings page" );
			$this->assertContains( $key, $schema->overlay_keys() );
			$this->assertNotContains( 'newspack_nodes_' . $key, $schema->setting_option_names() );
		}
	}

	/**
	 * A TSL `<config:vault>` token must never hand out the credential store.
	 *
	 * Declaring `vault` as a keyed Field puts it in `overlay_keys()`, so
	 * `Options_Overlay` merges the encrypted `newspack_nodes_vault` option into
	 * `load_config()` — which is exactly what the token namespace resolves off.
	 */
	public function test_the_config_token_namespace_refuses_the_vault(): void {
		\putenv( 'LOCAL_NEWSPACK_NODES_CONF' );
		Config::reset();
		Config::register_token_namespace();
		$resolve = \Newspack_Nodes\Core::$config_resolvers['config'] ?? null;

		$this->assertNotNull( $resolve, 'the config token namespace must be registered' );
		$this->assertNull( $resolve( 'vault' ) );
		$this->assertSame( '/tmp/newspack-nodes', $resolve( 'base_directory' ) );
	}

	/**
	 * The config file's commented ledger, parsed back into the array it
	 * documents. Every key ships commented out beside its default, so this
	 * reads the `// 'key' => value,` lines and evaluates them.
	 *
	 * @return array<string,mixed>
	 */
	private function documented_ledger(): array {
		$path  = \dirname( __DIR__, 2 ) . '/newspack-nodes-config.php';
		$lines = \explode( "\n", (string) \file_get_contents( $path ) );
		$body  = [];
		foreach ( $lines as $line ) {
			if ( \preg_match( "/^\s*\/\/ +('[a-z0-9_]+'\s*=>.*,)$/", $line, $m ) ) {
				$body[] = $m[1];
			}
		}
		$this->assertNotEmpty( $body, 'the config file documents no keys at all' );

		$file = $this->make_temp_dir() . '/ledger.php';
		\file_put_contents( $file, "<?php\nreturn [\n" . \implode( "\n", $body ) . "\n];\n" );
		/** @var array<string,mixed> $ledger */
		$ledger = require $file;
		\unlink( $file );
		return $ledger;
	}

	/**
	 * Scrape every `Config::value( 'key' )` read out of the substrate source.
	 *
	 * @return array<string,string> key => the file it is read in.
	 */
	private static function keys_read_by_the_substrate(): array {
		$root  = \dirname( __DIR__, 2 );
		$files = [ $root . '/newspack-nodes.php' ];

		$iterator = new \RecursiveIteratorIterator(
			new \RecursiveDirectoryIterator( $root . '/includes' )
		);
		foreach ( $iterator as $file ) {
			if ( 'php' === $file->getExtension() ) {
				$files[] = $file->getPathname();
			}
		}

		$keys = [];
		foreach ( $files as $file ) {
			\preg_match_all(
				"/(?:Config|RuntimeConfig|self)::value\(\s*'([a-z0-9_]+)'/i",
				(string) \file_get_contents( $file ),
				$matches
			);
			foreach ( $matches[1] as $key ) {
				$keys[ $key ] = \basename( $file );
			}
		}

		return $keys;
	}
}
