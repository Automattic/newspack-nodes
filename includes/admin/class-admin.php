<?php
/**
 * Admin: substrate-side WP-Settings-API surface.
 *
 * Owns ONLY substrate options — the field list lives in `Settings_Schema`
 * (the single source of truth), never here. Saving a restart-classified field
 * triggers a per-partition worker-restart request via `Restart_Planner`.
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes\Admin;

use Newspack_Nodes\Capabilities;

use Newspack_Nodes\Bootstrap;
use Newspack_Nodes\CLI;
use Newspack_Nodes\Cache_Backend;
use Newspack_Nodes\Config;
use Newspack_Nodes\Config_System\Field_Reset_Assets;
use Newspack_Nodes\Config_System\Reset_Gate;
use Newspack_Nodes\Config_System\Restart_Planner;
use Newspack_Nodes\Config_System\Settings_Renderer;
use Newspack_Nodes\Core;
use Newspack_Nodes\Lock_Node;
use Newspack_Nodes\Log_Sources;
use Newspack_Nodes\Settings_Schema;
use Newspack_Nodes\Worker_Base;

\defined( 'ABSPATH' ) || exit;

/**
 * Substrate admin settings page.
 */
class Admin {

	/** Top-level menu slug for the DevTools hub — the "Nodes" landing page (Console + Topologies + Raw Logs tabs, deep-linked via `&tab=`). */
	public const HUB_MENU_SLUG = 'newspack-nodes-hub';

	/** Menu page slug for add_options_page() (the `?page=` fragment). */
	public const MENU_SLUG = 'newspack-nodes';

	/** Settings group for register_setting() / options.php. */
	public const OPTIONS_GROUP = 'newspack_nodes';

	/** WP-option name prefix; worker-restart classification keys off it. */
	public const OPTION_PREFIX = 'newspack_nodes_';

	/** Nonce action / field for the reset-to-defaults form. */
	public const RESET_ACTION = 'newspack_nodes_reset_settings';

	/** Hidden-input array name carrying per-field reset marks ({option} => "1"). */
	public const RESET_MARK_FIELD = 'newspack_nodes_reset';
	public const RESET_NONCE  = 'newspack_nodes_reset_nonce';

	/** THE cache flush: rotates the shared salt every plugin's keys hang off. */
	public const FLUSH_ACTION = 'newspack_nodes_flush_cache';
	public const FLUSH_NONCE  = 'newspack_nodes_flush_nonce';

	/** Settings page slug for add_settings_field() / do_settings_sections(). */
	public const SETTINGS_PAGE = 'newspack_nodes';

	public function __construct() {
		\add_action( 'admin_menu', [ $this, 'add_admin_menu' ] );
		\add_action( 'admin_menu', [ $this, 'register_topology_admin_page' ] );
		\add_action( 'admin_menu', [ $this, 'register_event_dashboard_pages' ], 11 );
		\add_action( 'admin_init', [ $this, 'register_settings' ] );
		\add_action( 'admin_post_' . self::RESET_ACTION, [ $this, 'handle_reset_settings' ] );
		\add_action( 'admin_post_' . self::FLUSH_ACTION, [ $this, 'handle_flush_cache' ] );
		// Priority 1: register the token sheet before any dashboard deps on it.
		\add_action( 'admin_enqueue_scripts', [ $this, 'register_theme_style' ], 1 );
		\add_action( 'admin_enqueue_scripts', [ $this, 'register_ui_style' ], 2 );
		\add_action( 'admin_enqueue_scripts', [ $this, 'register_graph_style' ], 3 );
		\add_action( 'admin_enqueue_scripts', [ $this, 'enqueue_settings_style' ], 4 );
		\add_action( 'admin_enqueue_scripts', [ $this, 'enqueue_event_dashboards_assets' ] );
		\add_action( 'admin_enqueue_scripts', [ $this, 'enqueue_devtools_hub_assets' ] );
		\add_action( 'admin_enqueue_scripts', [ $this, 'enqueue_devtools_tab_bundles' ] );

		// Console + Topology Manager load on the top-level hub as tab bundles.
		\add_filter( 'newspack_nodes/devtools_tab_bundles', [ $this, 'register_event_dashboards_tab_bundle' ] );
		\add_filter( 'newspack_nodes/devtools_tab_bundles', [ $this, 'register_vault_tab_bundle' ] );
		\add_filter( 'newspack_nodes/devtools_tab_bundles', [ $this, 'register_aggregator_tab_bundle' ] );
		\add_filter( 'newspack_nodes/devtools_tab_bundles', [ $this, 'register_topology_console_tab_bundle' ] );

		// Both hooks so first + subsequent saves restart correctly.
		\add_action( 'updated_option', [ $this, 'maybe_request_worker_restart' ], 10, 1 );
		\add_action( 'added_option', [ $this, 'maybe_request_worker_restart' ], 10, 1 );

		// Read-only "Effective Configuration" panel below the settings form.
		\add_action( 'newspack_nodes/settings_after_form', [ $this, 'render_effective_config_section' ] );

		// One fleet-alert summary notice on the Nodes admin pages.
		\add_action( 'admin_notices', [ $this, 'render_alert_notice' ] );
	}

	/**
	 * Enqueue the event-dashboards bundle on the top-level "Nodes" hub page,
	 * where its `host:'hub'` tabs (Topology Manager + Raw Logs) register.
	 */
	public function enqueue_event_dashboards_assets( string $hook = '' ): void {
		self::enqueue_react_page(
			[
				'handle'   => 'newspack-nodes-event-dashboards',
				'page'     => self::HUB_MENU_SLUG,
				'dir'      => self::build_dir( 'event-dashboards' ),
				'url'      => self::build_url( 'event-dashboards' ),
				'localize' => [
					'tree'    => 'event-dashboards',
					'version' => \NEWSPACK_NODES_VERSION,
				],
			]
		);
	}

	/**
	 * Enqueue the DevTools hub bundle on the top-level "Nodes" page.
	 */
	public function enqueue_devtools_hub_assets( string $hook = '' ): void {
		self::enqueue_react_page(
			[
				'handle'     => 'newspack-nodes-devtools-hub',
				'page'       => self::HUB_MENU_SLUG,
				'dir'        => self::build_dir( 'devtools-hub' ),
				'url'        => self::build_url( 'devtools-hub' ),
				'style_deps' => [ 'wp-components', 'newspack-nodes-graph' ],
				'localize'   => [
					'tree'    => 'devtools-hub',
					'version' => \NEWSPACK_NODES_VERSION,
				],
			]
		);
	}

	/**
	 * Enqueue every plugin-registered DevTools tab bundle on both hosts.
	 *
	 * A contributor returns `{ handle, dir, url }` (the `enqueue_react_page` shape)
	 * via the `newspack_nodes/devtools_tab_bundles` filter; each is enqueued on the
	 * top-level "Nodes" hub page so its tabs register in whichever host they
	 * target (the hub renders the overlay on every non-console tab). The
	 * per-bundle page-gate + existence/manifest handling is `enqueue_react_page`'s.
	 */
	public function enqueue_devtools_tab_bundles( string $hook = '' ): void {
		// Hub-only: the lazy branch stats/hashes build files on every fire.
		// phpcs:ignore WordPress.Security.NonceVerification.Recommended
		$page = isset( $_GET['page'] ) && \is_string( $_GET['page'] ) ? \sanitize_text_field( \wp_unslash( $_GET['page'] ) ) : '';
		if ( self::HUB_MENU_SLUG !== $page ) {
			return;
		}
		$bundles = \apply_filters( 'newspack_nodes/devtools_tab_bundles', [] );
		if ( ! \is_array( $bundles ) ) {
			return;
		}
		$pages = [ self::HUB_MENU_SLUG ];
		$lazy  = [];
		foreach ( $bundles as $bundle ) {
			if ( ! \is_array( $bundle ) || ! isset( $bundle['handle'], $bundle['dir'], $bundle['url'] ) ) {
				continue;
			}
			if ( ! \is_scalar( $bundle['handle'] ) || ! \is_scalar( $bundle['dir'] ) || ! \is_scalar( $bundle['url'] ) ) {
				continue;
			}
			$raw      = $bundle['localize'] ?? null;
			$localize = \is_array( $raw ) ? \array_filter( $raw, '\is_string', \ARRAY_FILTER_USE_KEY ) : [];

			// A `lazy` bundle ships on tab-click, not up front.
			if ( ! empty( $bundle['lazy'] ) ) {
				$entry = self::lazy_tab_script( (string) $bundle['dir'], (string) $bundle['url'], $localize );
				if ( null !== $entry ) {
					$lazy[ (string) $bundle['handle'] ] = $entry;
				}
				continue;
			}
			self::enqueue_react_page(
				[
					'handle'   => (string) $bundle['handle'],
					'page'     => $pages,
					'dir'      => (string) $bundle['dir'],
					'url'      => (string) $bundle['url'],
					'localize' => $localize,
				]
			);
		}

		if ( [] !== $lazy ) {
			\wp_localize_script( 'newspack-nodes-devtools-hub', 'NewspackNodesLazyTabs', $lazy );
		}
	}

	/**
	 * Shared React-dashboard enqueue registrar.
	 *
	 * Performs ONLY the mechanics every dashboard enqueue site duplicated:
	 * page-gate, index.js existence gate, manifest-vs-fallback deps/version,
	 * CSS sidecar (+ RTL activation), and the NewspackNodesData localize.
	 * Returns the script handle so callers can layer per-tree extras
	 * (inline scripts, secondary bundles) on top, or null if it did not enqueue.
	 *
	 * @param array{handle:string, page:string|array<int,string>, dir:string, url:string,
	 *   localize?:array<string,mixed>, version_fallback?:string, style_deps?:array<int,string>} $args
	 * @return string|null Enqueued script handle, or null if nothing was enqueued.
	 */
	public static function enqueue_react_page( array $args ): ?string {
		if ( ! \function_exists( 'wp_enqueue_script' ) ) {
			return null;
		}

		// phpcs:ignore WordPress.Security.NonceVerification.Recommended
		$page  = isset( $_GET['page'] ) && \is_string( $_GET['page'] ) ? \sanitize_text_field( \wp_unslash( $_GET['page'] ) ) : '';
		$pages = (array) $args['page'];
		if ( ! \in_array( $page, $pages, true ) ) {
			return null;
		}

		$dir     = \rtrim( $args['dir'], '/' );
		$url     = \rtrim( $args['url'], '/' );
		$js_path = "{$dir}/index.js";
		if ( ! \file_exists( $js_path ) ) {
			return null;
		}

		$fallback           = $args['version_fallback'] ?? \NEWSPACK_NODES_VERSION;
		[ $deps, $version ] = self::bundle_manifest( $dir, $js_path, $fallback );

		$handle = $args['handle'];
		\wp_enqueue_script( $handle, "{$url}/index.js", $deps, $version, true );

		if ( \file_exists( "{$dir}/index.css" ) ) {
				// Canonical appearance also provides the token sheet.
			$style_deps    = $args['style_deps'] ?? [ 'wp-components', 'newspack-nodes-ui' ];
			$style_version = self::css_cache_version( "{$dir}/index.css", $version );
			\wp_enqueue_style( $handle, "{$url}/index.css", $style_deps, $style_version );
			if ( \file_exists( "{$dir}/index-rtl.css" ) && \function_exists( 'wp_style_add_data' ) ) {
				\wp_style_add_data( $handle, 'rtl', 'replace' );
			}
		}

		\wp_localize_script( $handle, 'NewspackNodesData', self::localize_data( $args['localize'] ?? [] ) );

		return $handle;
	}

	/**
	 * Build the on-demand load recipe for one lazy DevTools tab bundle: the
	 * versioned script URL, the optional style URL, and the localize payload the
	 * bundle reads (the same `NewspackNodesData` — restUrl/nonce + per-tab extras —
	 * it would receive if enqueued). Returns null when the bundle has no built
	 * `index.js` (so a missing build never poisons the lazy map).
	 *
	 * @param string               $dir      Filesystem path to the build subdir.
	 * @param string               $url      Public URL of the build subdir.
	 * @param array<string,mixed> $localize Per-tab localize payload (string keys only).
	 * @return array{src:string, data:array<string,mixed>, style?:string}|null
	 */
	private static function lazy_tab_script( string $dir, string $url, array $localize ): ?array {
		$dir = \rtrim( $dir, '/' );
		$url = \rtrim( $url, '/' );
		$js  = "{$dir}/index.js";
		if ( ! \file_exists( $js ) ) {
			return null;
		}

		[ , $version ] = self::bundle_manifest( $dir, $js, \NEWSPACK_NODES_VERSION );
		$entry         = [
			'src'  => "{$url}/index.js?ver=" . \rawurlencode( $version ),
			'data' => self::localize_data( $localize ),
		];

		$css = "{$dir}/index.css";
		if ( \file_exists( $css ) ) {
			$style_version   = self::css_cache_version( $css, $version );
			$entry['style'] = "{$url}/index.css?ver=" . \rawurlencode( $style_version );
		}

		return $entry;
	}

	/**
	 * The `NewspackNodesData` payload: shared restUrl/nonce under per-bundle
	 * extras — one shape for enqueued and lazily-injected bundles alike.
	 *
	 * @param array<string,mixed> $localize Per-bundle extras (string keys).
	 * @return array<string,mixed>
	 */
	private static function localize_data( array $localize ): array {
		$rest_url = \function_exists( 'rest_url' ) ? \rest_url() : '/wp-json/';
		$nonce    = \function_exists( 'wp_create_nonce' ) ? \wp_create_nonce( 'wp_rest' ) : '';
		return \array_merge(
			[
				'restUrl' => \esc_url_raw( $rest_url ),
				'nonce'   => $nonce,
			],
			$localize
		);
	}

	/**
	 * Deps + version for a built bundle — wp-scripts manifest first, else static
	 * deps + filemtime, else the fallback. The ONE resolver the eager enqueue
	 * and the lazy tab recipe both use (they must never drift).
	 *
	 * @param string $dir      Filesystem path to the build subdir.
	 * @param string $js_path  Path to the bundle's index.js.
	 * @param string $fallback Version when neither manifest nor mtime resolve.
	 * @return array{0: list<string>, 1: string} [deps, version].
	 */
	private static function bundle_manifest( string $dir, string $js_path, string $fallback ): array {
		$asset_path = "{$dir}/index.asset.php";
		$asset      = \file_exists( $asset_path ) ? require $asset_path : null;
		if ( \is_array( $asset ) ) {
			$manifest_deps = \is_array( $asset['dependencies'] ?? null ) ? $asset['dependencies'] : [];
			return [
				\array_values( \array_filter( $manifest_deps, '\is_string' ) ),
				\is_string( $asset['version'] ?? null ) ? $asset['version'] : $fallback,
			];
		}
		return [
			[ 'wp-element', 'wp-components', 'wp-api-fetch', 'wp-i18n' ],
			(string) ( \filemtime( $js_path ) ?: $fallback ),
		];
	}

	public static function num_partitions_callback(): void {
		self::render_number( 'num_partitions', \__( 'Number of log partitions for parallel processing.', 'newspack-nodes' ) );
	}

	public static function min_segments_callback(): void {
		self::render_number( 'min_segments', \__( 'Floor for the age rule: keep at least this many segments even when pruning old ones by max lifetime.', 'newspack-nodes' ) );
	}

	public static function num_segments_callback(): void {
		self::render_number( 'num_segments', \__( 'Count-rule target: prune the oldest back to this many segments — but only ones older than min lifetime.', 'newspack-nodes' ) );
	}

	public static function max_segments_callback(): void {
		self::render_number( 'max_segments', \__( 'True hard cap: prune the oldest UNCONDITIONALLY above this many segments (min lifetime does not protect them). 0 = automatic (twice num segments).', 'newspack-nodes' ) );
	}

	public static function segment_size_callback(): void {
		self::render_number( 'segment_size', \__( 'Maximum segment size in bytes.', 'newspack-nodes' ) );
	}

	public static function min_lifetime_callback(): void {
		self::render_number( 'min_lifetime', \__( 'Floor for the count rule: keep segments younger than this many seconds even when over num segments. 0 = pure count-based.', 'newspack-nodes' ) );
	}

	public static function lifetime_callback(): void {
		self::render_number( 'lifetime', \__( 'Age rule: prune segments older than this many seconds down to min segments. 0 = disabled (no age-based pruning).', 'newspack-nodes' ) );
	}

	public static function remote_num_segments_callback(): void {
		self::render_number( 'remote_num_segments', \__( 'Count-rule target: number of log segments to keep on remote servers (2-16).', 'newspack-nodes' ) );
	}

	public static function remote_min_segments_callback(): void {
		self::render_number( 'remote_min_segments', \__( 'Floor for the age rule: keep at least this many segments on remote servers even when pruning by lifetime.', 'newspack-nodes' ) );
	}

	public static function remote_lifetime_callback(): void {
		self::render_number( 'remote_lifetime', \__( 'Age rule: prune remote segments older than this many seconds down to remote min segments. 0 = disabled.', 'newspack-nodes' ) );
	}

	public static function remote_max_segments_callback(): void {
		self::render_number( 'remote_max_segments', \__( 'True hard cap on remote servers: prune the oldest UNCONDITIONALLY above this many segments. 0 = automatic (twice remote num segments).', 'newspack-nodes' ) );
	}

	public static function remote_segment_size_callback(): void {
		self::render_number( 'remote_segment_size', \__( 'Segment size on remote servers in bytes (1MB-256MB).', 'newspack-nodes' ) );
	}

	public static function remote_min_lifetime_callback(): void {
		self::render_number( 'remote_min_lifetime', \__( 'Minimum retention on remote servers in seconds. Spokes keep data at least this long for the aggregator to pull. 0 = disabled (pure count-based).', 'newspack-nodes' ) );
	}

	public static function alert_lag_threshold_callback(): void {
		self::render_number( 'alert_lag_threshold', \__( 'Warn when a consumer falls more than this many bytes behind its partition end. 0 = warn on any lag.', 'newspack-nodes' ) );
	}

	public static function alert_deadletter_threshold_callback(): void {
		self::render_number( 'alert_deadletter_threshold', \__( 'Warn when more than this many dead-letter segments are quarantined. 0 = warn on the first.', 'newspack-nodes' ) );
	}

	public static function alert_emit_interval_callback(): void {
		self::render_number( 'alert_emit_interval', \__( 'Minimum seconds between alert-action emission bursts (rate limit).', 'newspack-nodes' ) );
	}

	/** Echo a number field: default from the config file, value from the stored option. */
	private static function render_number( string $field, string $description ): void {
		$bounds = Settings_Schema::get()->field_for_short( $field );
		if ( null === $bounds || null === $bounds->min || null === $bounds->max ) {
			// Unbounded rendered number = schema bug; don't paper over it.
			throw new \RuntimeException(
				\esc_html( "settings field declares no bounds: {$field}" )
			);
		}
		$min     = $bounds->min;
		$max     = $bounds->max;
		$default = self::default_int(
			Config::load_config_defaults(),
			$field,
			$bounds->default ?? 0
		);
		$value   = \get_option( self::OPTION_PREFIX . $field, '' );
		$html    = Settings_Renderer::number(
			$field,
			self::OPTION_PREFIX . $field,
			Core::as_string( $value ),
			$default,
			$min,
			$max,
			$description,
			self::reset_mark_name( $field )
		);
		echo $html; // phpcs:ignore WordPress.Security.EscapeOutput.OutputNotEscaped -- Settings_Renderer escapes every field.
	}

	/**
	 * Advertise the event-dashboards bundle as a DevTools tab bundle so the hub
	 * page enqueues it and its `host: 'hub'` tabs (Topology Manager + Raw Logs)
	 * register there. (event-dashboards is also enqueued directly on the hub page
	 * via enqueue_event_dashboards_assets; wp dedupes by handle, so the double
	 * enqueue is harmless.)
	 *
	 * @param array<int,mixed> $bundles Existing tab bundles.
	 * @return array<int,mixed> Bundles with the event-dashboards bundle appended.
	 */
	public function register_event_dashboards_tab_bundle( array $bundles ): array {
		return self::append_tab_bundle( $bundles, 'newspack-nodes-event-dashboards', 'event-dashboards' );
	}

	/**
	 * Advertise the vault bundle as a DevTools tab bundle so the hub page
	 * enqueues it and its `host: 'hub'` Vault tab registers there.
	 *
	 * @param array<int,mixed> $bundles Existing tab bundles.
	 * @return array<int,mixed> Bundles with the vault bundle appended.
	 */
	public function register_vault_tab_bundle( array $bundles ): array {
		return self::append_tab_bundle( $bundles, 'newspack-nodes-vault', 'vault', [], true );
	}

	/**
	 * Advertise the aggregator bundle as a DevTools tab bundle so the hub page
	 * enqueues it and its `host: 'hub'` Aggregator tab registers there.
	 *
	 * @param array<int,mixed> $bundles Existing tab bundles.
	 * @return array<int,mixed> Bundles with the aggregator bundle appended.
	 */
	public function register_aggregator_tab_bundle( array $bundles ): array {
		return self::append_tab_bundle( $bundles, 'newspack-nodes-aggregator-tab', 'event-aggregator', [], true );
	}

	/**
	 * Advertise the topology-console bundle as a DevTools tab bundle so the hub
	 * page enqueues it and its `host: 'hub'` Console tab registers there. Carries
	 * the partition snapshot the React dropdown reads (the SAME canonical
	 * derivation the `topologies.list` verb uses, so the page-load snapshot and
	 * the live refetch can't disagree).
	 *
	 * @param array<int,mixed> $bundles Existing tab bundles.
	 * @return array<int,mixed> Bundles with the topology-console bundle appended.
	 */
	public function register_topology_console_tab_bundle( array $bundles ): array {
		Bootstrap::ensure_runtime_wired();

		// Per-topology partition counts for the React dropdown.
		$topology_workers = [];
		foreach ( \Newspack_Nodes\Topology_Registry::list() as $name ) {
			if ( '' === $name ) {
				continue;
			}
			$topology_workers[ $name ] = Bootstrap::num_partitions_for( $name );
		}
		\ksort( $topology_workers );

		// Active topologies (catalog + operator overlay) the fleet spawns.
		$active_topologies = \array_keys( Bootstrap::get_topologies() );
		\sort( $active_topologies );

		// Client fallbacks for the settings panel's unset-frontmatter hints.
		$config_np  = Config::value( 'num_partitions' );
		$default_np = Core::as_int( $config_np, 1 );
		$idle       = \max( 0, Core::num_int( Config::value( 'on_demand_idle' ), 0 ) );

		return self::append_tab_bundle(
			$bundles,
			'newspack-nodes-topology-console',
			'topology-console',
			[
				'tree'                => 'topology-console',
				'version'             => \NEWSPACK_NODES_VERSION,
				'topologyWorkers'     => $topology_workers,
				'activeTopologies'    => $active_topologies,
				'configNumPartitions' => $default_np,
				'configStaleTimeout'  => Lock_Node::STALE_TIMEOUT,
				'configOnDemandIdle'  => $idle,
			],
			true
		);
	}

	/**
	 * Append one DevTools tab bundle (the shared `{handle, dir, url[, localize]}`
	 * shape) to the running list. Each `register_*_tab_bundle` filter callback
	 * delegates the append here; topology-console also builds a localize payload.
	 *
	 * @param array<int,mixed>     $bundles  Existing tab bundles.
	 * @param string               $handle   Script handle.
	 * @param string               $subdir   Build subdir under `build/`.
	 * @param array<string,mixed>  $localize Optional localize payload.
	 * @param bool                 $lazy     Load on first tab activation instead of up front.
	 * @return array<int,mixed>
	 */
	private static function append_tab_bundle( array $bundles, string $handle, string $subdir, array $localize = [], bool $lazy = false ): array {
		$bundle = [
			'handle' => $handle,
			'dir'    => self::build_dir( $subdir ),
			'url'    => self::build_url( $subdir ),
		];
		if ( [] !== $localize ) {
			$bundle['localize'] = $localize;
		}
		if ( $lazy ) {
			$bundle['lazy'] = true;
		}
		$bundles[] = $bundle;
		return $bundles;
	}

	/**
	 * Register the public product-token stylesheet.
	 */
	public function register_theme_style(): void {
		$this->register_built_style( 'newspack-nodes-theme', 'theme', [] );
	}

	/**
	 * Register the opt-in Nodes and Event Logger appearance stylesheet.
	 */
	public function register_ui_style(): void {
		$this->register_built_style(
			'newspack-nodes-ui',
			'ui',
			[ 'newspack-nodes-theme' ]
		);
	}

	/**
	 * Register graph-only artwork and layout after canonical UI appearance.
	 */
	public function register_graph_style(): void {
		$this->register_built_style(
			'newspack-nodes-graph',
			'graph',
			[ 'newspack-nodes-ui' ]
		);
	}

	/**
	 * Register one built stylesheet and its RTL replacement.
	 *
	 * @param string   $handle Style handle.
	 * @param string   $subdir Build subdirectory.
	 * @param string[] $deps   Style dependencies.
	 */
	private function register_built_style(
		string $handle,
		string $subdir,
		array $deps
	): void {
		if (
			! \function_exists( 'wp_register_style' )
			|| \wp_style_is( $handle, 'registered' )
		) {
			return;
		}

		$dir = self::build_dir( $subdir );
		$url = self::build_url( $subdir );
		$css = "{$dir}/index.css";
		if ( ! \file_exists( $css ) ) {
			return;
		}

		$version = self::css_cache_version( $css, \NEWSPACK_NODES_VERSION );
		\wp_register_style( $handle, "{$url}/index.css", $deps, $version );
		if ( \file_exists( "{$dir}/index-rtl.css" ) && \function_exists( 'wp_style_add_data' ) ) {
			\wp_style_add_data( $handle, 'rtl', 'replace' );
		}
	}

	/**
	 * Cache-bust a stylesheet on its OWN content hash, not the JS bundle hash or
	 * plugin version: a SCSS-only rebuild leaves the JS hash / version unchanged,
	 * so reusing those would serve the stylesheet from cache behind a stale ?ver=
	 * (a CSS-only change would need a hard-refresh to land). Returns the fallback
	 * (the prior version value) when the file isn't readable — gated so we never
	 * call md5_file on a non-readable path and emit a warning.
	 *
	 * @param string $css_path Filesystem path to the stylesheet.
	 * @param string $fallback Version to use when the file isn't readable.
	 * @return string Content hash, or the fallback.
	 */
	public static function css_cache_version( string $css_path, string $fallback ): string {
		if ( ! \is_readable( $css_path ) ) {
			return $fallback;
		}
		return \md5_file( $css_path ) ?: $fallback;
	}

	/** Public URL of a build subdir; the URL constant may be absent in CLI/test contexts. */
	private static function build_url( string $subdir ): string {
		return ( \defined( 'NEWSPACK_NODES_URL' ) ? \NEWSPACK_NODES_URL : '' ) . 'build/' . $subdir;
	}

	/** Filesystem path to a build subdir (e.g. 'vault' → '{plugin}/build/vault'). */
	private static function build_dir( string $subdir ): string {
		return \NEWSPACK_NODES_DIR . 'build/' . $subdir;
	}

	/**
	 * Render ONE fleet-alert notice summarizing the Alerts evaluator's count +
	 * worst severity, shown only on the substrate's own admin pages to
	 * manage_options users. Nothing renders when the fleet is clean.
	 */
	public function render_alert_notice(): void {
		if ( ! self::current_user_allowed() ) {
			return;
		}
		// phpcs:ignore WordPress.Security.NonceVerification.Recommended
		$page = isset( $_GET['page'] ) && \is_string( $_GET['page'] ) ? \sanitize_text_field( \wp_unslash( $_GET['page'] ) ) : '';
		if ( ! \str_starts_with( $page, 'newspack-nodes' ) ) {
			return;
		}
		$alerts = \Newspack_Nodes\Alerts::evaluate();
		if ( empty( $alerts ) ) {
			return;
		}
		$worst = \Newspack_Nodes\Alerts::worst_severity( $alerts );
		$class = \Newspack_Nodes\Alerts::SEVERITY_CRITICAL === $worst ? 'notice-error' : 'notice-warning';
		$message = \sprintf(
			/* translators: 1: number of active fleet alerts, 2: worst severity (warning|critical). */
			\__( 'Newspack Nodes: %1$d fleet alert(s), worst severity %2$s.', 'newspack-nodes' ),
			\count( $alerts ),
			$worst
		);
		\printf(
			'<div class="notice %s"><p>%s <a href="%s">%s</a></p></div>',
			\esc_attr( $class ),
			\esc_html( $message ),
			\esc_url( \admin_url( 'site-health.php' ) ),
			\esc_html__( 'View fleet health', 'newspack-nodes' )
		);
	}

	/**
	 * Register the DevTools hub as the top-level "Nodes" admin menu (renders the
	 * hub React mount div; the Console + Topologies load on it as tab bundles).
	 */
	public function register_topology_admin_page(): void {
		if ( ! self::current_user_allowed() ) {
			return;
		}
		if ( ! \function_exists( 'add_menu_page' ) ) {
			return;
		}
		\add_menu_page(
			\__( 'Newspack Nodes', 'newspack-nodes' ),
			\__( 'Nodes', 'newspack-nodes' ),
			Capabilities::cap_for( Capabilities::MANAGE ),
			self::HUB_MENU_SLUG,
			[ $this, 'render_hub_page' ],
			'dashicons-networking',
			81
		);
	}

	/**
	 * Registers the event-dashboard admin pages. Every event dashboard is now a
	 * `host:'hub'` DevTools tab on the top-level "Nodes" page (Raw Logs was the
	 * last standalone submenu; it became a hub tab), so there are no standalone
	 * submenus left to register. Kept as the `admin_menu` (priority 11) seam in
	 * case a future dashboard needs its own page.
	 */
	public function register_event_dashboard_pages(): void {
		if ( ! self::current_user_allowed() ) {
			return;
		}
	}

	/**
	 * Render the DevTools hub mount element — the top-level "Nodes" landing page
	 * (Console + Topologies tabs load on it via the devtools_tab_bundles filter).
	 */
	public function render_hub_page(): void {
		if ( ! self::current_user_allowed() ) {
			\wp_die( \esc_html__( 'You do not have permission to access this page.', 'newspack-nodes' ) );
		}
		echo '<div id="newspack-nodes-hub" class="newspack-nodes-hub-page"></div>';
	}

	/**
	 * Settings submenu under Settings → Nodes Runtime.
	 */
	public function add_admin_menu(): void {
		if ( ! self::current_user_allowed() ) {
			return;
		}
		if ( ! \function_exists( 'add_options_page' ) ) {
			return;
		}
		\add_options_page(
			\__( 'Nodes Runtime Settings', 'newspack-nodes' ),
			\__( 'Nodes Runtime', 'newspack-nodes' ),
			Capabilities::cap_for( Capabilities::MANAGE ),
			self::MENU_SLUG,
			[ $this, 'render_settings_page' ]
		);
	}

	/**
	 * Render the settings page: main form + hidden Reset-to-Defaults form.
	 */
	public function render_settings_page(): void {
		if ( ! self::current_user_allowed() ) {
			\wp_die( \esc_html__( 'You do not have permission to access this page.', 'newspack-nodes' ) );
		}
		$reset_url = \function_exists( 'admin_url' )
			? \admin_url( 'admin-post.php' )
			: '/wp-admin/admin-post.php';
		?>
		<div class="wrap newspack-nodes-settings-wrap newspack-nodes-theme newspack-nodes-ui">
			<h1><?php \esc_html_e( 'Nodes Runtime Settings', 'newspack-nodes' ); ?></h1>
			<form method="post" action="options.php">
				<?php
				\settings_fields( self::OPTIONS_GROUP );
				\do_settings_sections( self::SETTINGS_PAGE );
				?>
				<p class="submit">
					<?php \submit_button( \__( 'Save Settings', 'newspack-nodes' ), 'primary', 'submit', false ); ?>
					<span style="display:inline-block; margin-left: 10px;">
						<input type="button" class="button button-secondary"
							value="<?php \esc_attr_e( 'Reset to Defaults', 'newspack-nodes' ); ?>"
							onclick="if ( confirm( '<?php echo \esc_js( \__( 'Are you sure you want to reset all substrate settings to defaults? This cannot be undone.', 'newspack-nodes' ) ); ?>' ) ) { document.getElementById( 'newspack-nodes-reset-form' ).submit(); }" />
					</span>
				</p>
			</form>
			<form id="newspack-nodes-reset-form" method="post" action="<?php echo \esc_url( $reset_url ); ?>" style="display:none;">
				<input type="hidden" name="action" value="<?php echo \esc_attr( self::RESET_ACTION ); ?>">
				<?php \wp_nonce_field( self::RESET_ACTION, self::RESET_NONCE ); ?>
			</form>
			<form method="post" action="<?php echo \esc_url( $reset_url ); ?>">
				<input type="hidden" name="action" value="<?php echo \esc_attr( self::FLUSH_ACTION ); ?>">
				<?php \wp_nonce_field( self::FLUSH_ACTION, self::FLUSH_NONCE ); ?>
				<p>
					<?php \submit_button( \__( 'Flush Caches', 'newspack-nodes' ), 'secondary', 'submit', false ); ?>
				</p>
			</form>
			<?php
			// Extension plugins inject sections below the form.
			\do_action( 'newspack_nodes/settings_after_form' );
			Field_Reset_Assets::enqueue();
			echo Field_Reset_Assets::highlight_style(); // phpcs:ignore WordPress.Security.EscapeOutput.OutputNotEscaped -- static CSS literal.
			?>
		</div>
		<?php
	}

	public static function base_directory_callback(): void {
		$defaults = Config::load_config_defaults();
		$base     = $defaults['base_directory'] ?? '';
		$value    = \get_option( 'newspack_nodes_base_directory', '' );
		$html     = Settings_Renderer::directory(
			'base_directory',
			'newspack_nodes_base_directory',
			Core::as_string( $value ),
			Core::as_string( $base ),
			\__( 'Base directory for logs, locks, and offsets.', 'newspack-nodes' ),
			self::reset_mark_name( 'base_directory' )
		);
		echo $html; // phpcs:ignore WordPress.Security.EscapeOutput.OutputNotEscaped -- Settings_Renderer escapes every field.
	}

	/**
	 * Memcache servers field: newline-separated `host:port` textarea, default in
	 * the placeholder (and listed in the description).
	 */
	public static function memcache_servers_callback(): void {
		$defaults        = Config::load_config_defaults();
		$default_servers = $defaults['memcache_servers'] ?? [ '127.0.0.1:11211' ];
		if ( ! \is_array( $default_servers ) ) {
			$default_servers = [ '127.0.0.1:11211' ];
		}
		// Coerce each entry to string exactly as implode/esc_* already would.
		$default_servers = \array_map( static fn ( $server ): string => Core::as_string( $server ), $default_servers );
		// Stored as typed array shape; textarea joins entries with newlines.
		$value = \get_option( 'newspack_nodes_memcache_servers', [] );
		$value = Core::arr( $value );
		$value = \array_map( static fn ( $server ): string => Core::as_string( $server ), $value );
		$html  = Settings_Renderer::textarea(
			'memcache_servers',
			'newspack_nodes_memcache_servers',
			\implode( "\n", $value ),
			\implode( "\n", $default_servers ),
			\sprintf(
				/* translators: %s: comma-separated default server list. */
				\__( 'Memcache servers (one per line, format: host:port). Used for stats aggregation and SSE. Default: %s', 'newspack-nodes' ),
				\implode( ', ', $default_servers )
			),
			self::reset_mark_name( 'memcache_servers' )
		);
		echo $html; // phpcs:ignore WordPress.Security.EscapeOutput.OutputNotEscaped -- Settings_Renderer escapes every field.
	}

	/**
	 * Log sources field: newline-separated `name=/absolute/path` textarea. Extra
	 * `/log/stream` + `taillog` sources layered over the built-ins and the
	 * topology-inferred set (see Log_Sources).
	 */
	public static function log_sources_callback(): void {
		$value = \get_option( 'newspack_nodes_log_sources', [] );
		$value = Core::arr( $value );
		$value = \array_map( static fn ( $entry ): string => Core::as_string( $entry ), $value );
		$html  = Settings_Renderer::textarea(
			'log_sources',
			'newspack_nodes_log_sources',
			\implode( "\n", $value ),
			'',
			\__( 'Extra log sources for the log stream and taillog (one per line, format: name=/absolute/path). Built-ins and active-topology logs are always included.', 'newspack-nodes' ),
			self::reset_mark_name( 'log_sources' )
		);
		echo $html; // phpcs:ignore WordPress.Security.EscapeOutput.OutputNotEscaped -- Settings_Renderer escapes every field.
	}

	/** Hidden-input name that flags $field for per-field reset (deleted on Save). */
	private static function reset_mark_name( string $field ): string {
		return Reset_Gate::mark_name( self::RESET_MARK_FIELD, self::OPTION_PREFIX . $field );
	}

	/**
	 * Total-storage field: the TRUE disk ceiling — segment_size × the effective
	 * hard cap (max_segments, or 2 × num_segments when auto) × on-disk log-partition
	 * dirs. Uses the hard cap, not the count target, so what's shown is the ceiling
	 * cleanup_segments() actually enforces rather than an underestimate.
	 */
	public static function total_storage_callback(): void {
		$defaults     = Config::load_config_defaults();
		$segment_size = \get_option( 'newspack_nodes_segment_size', '' );
		$num_segments = \get_option( 'newspack_nodes_num_segments', '' );
		$max_segments = \get_option( 'newspack_nodes_max_segments', '' );

		// Use config defaults for empty values.
		$segment_size = '' === $segment_size ? self::default_int( $defaults, 'segment_size', 64 * 1024 * 1024 ) : Core::as_int( $segment_size );
		$num_segments = '' === $num_segments ? self::default_int( $defaults, 'num_segments', 8 ) : Core::as_int( $num_segments );
		$max_segments = '' === $max_segments ? self::default_int( $defaults, 'max_segments', 0 ) : Core::as_int( $max_segments );
		$max_segments = \Newspack_Nodes\Partition_Node::derive_max_segments( $num_segments, $max_segments );

		// on_disk() is already per-partition; don't multiply by num_partitions.
		$num_log_dirs = \count( \Newspack_Nodes\Log_Discovery::on_disk() );
		$total_bytes  = $segment_size * $max_segments * $num_log_dirs;
		$total_mb     = \round( $total_bytes / ( 1024 * 1024 ) );
		$total_gb     = \round( $total_bytes / ( 1024 * 1024 * 1024 ), 2 );
		$segment_mb   = \round( $segment_size / ( 1024 * 1024 ) );

		if ( $total_gb >= 1 ) {
			$display = \sprintf( '%s MB (%s GB)', \number_format( $total_mb ), \number_format( $total_gb, 2 ) );
		} else {
			$display = \sprintf( '%s MB', \number_format( $total_mb ) );
		}
		?>
		<div id="total_storage_display" style="font-weight: 500; font-size: 14px; padding: 8px 0;">
			<?php echo \esc_html( $display ); ?>
		</div>
		<p class="description">
		<?php
		\printf(
			/* translators: 1: segment size in MB, 2: hard-cap segment count, 3: number of on-disk log partitions */
			\esc_html__( 'Calculated as: %1$s MB segment × %2$s hard-cap segments × %3$s log partitions', 'newspack-nodes' ),
			\esc_html( (string) $segment_mb ),
			\esc_html( (string) $max_segments ),
			\esc_html( (string) $num_log_dirs )
		);
		?>
		</p>
		<?php
	}

	/**
	 * Read an int config default, coercing scalars exactly as `(int)` would and falling back when non-scalar.
	 *
	 * @param array<string,mixed> $defaults Config defaults.
	 * @param string               $key      Key to read.
	 * @param int                  $fallback Default when missing/non-scalar.
	 */
	private static function default_int( array $defaults, string $key, int $fallback ): int {
		$value = $defaults[ $key ] ?? $fallback;
		return Core::as_int( $value, $fallback );
	}

	/**
	 * Rotate the install's cache salt — THE flush.
	 *
	 * One rotation orphans every Newspack plugin's cached values at once, and
	 * touches no co-tenant install sharing the server. Plugins deliberately keep
	 * no salt of their own: three independent rotations meant flushing one left
	 * the other two serving stale values.
	 */
	public function handle_flush_cache(): void {
		// phpcs:ignore WordPress.Security.ValidatedSanitizedInput.InputNotSanitized
		$nonce = isset( $_POST[ self::FLUSH_NONCE ] ) && \is_string( $_POST[ self::FLUSH_NONCE ] ) ? \sanitize_text_field( \wp_unslash( $_POST[ self::FLUSH_NONCE ] ) ) : '';
		if ( '' === $nonce || ! \wp_verify_nonce( $nonce, self::FLUSH_ACTION ) ) {
			\wp_die( \esc_html__( 'Security check failed.', 'newspack-nodes' ) );
		}
		if ( ! self::current_user_allowed() ) {
			\wp_die( \esc_html__( 'You do not have permission to perform this action.', 'newspack-nodes' ) );
		}

		Cache_Backend::rotate_salt();

		// @longform The scope is memoized per process, so a live worker keeps
		// writing the old one until it restarts. Best-effort: a failure only
		// delays the new scope to the next spawn, so it is logged not surfaced.
		try {
			( new CLI( Config::get_base_directory() ) )->restart_workers( Bootstrap::expand_workers(), [], -1 );
		} catch ( \Throwable $e ) {
			Core::print_less_often( 'Cache flush: restart_workers failed — ', $e->getMessage() );
		}

		// options-general.php: MENU_SLUG is an add_options_page() submenu.
		\wp_safe_redirect(
			\add_query_arg(
				[
					'page'    => self::MENU_SLUG,
					'flushed' => '1',
				],
				\admin_url( 'options-general.php' )
			)
		);
		exit;
	}

	/**
	 * Reset-to-defaults admin-post handler (nonce + permission checked before deleting options).
	 */
	public function handle_reset_settings(): void {
		// phpcs:ignore WordPress.Security.ValidatedSanitizedInput.InputNotSanitized
		$nonce = isset( $_POST[ self::RESET_NONCE ] ) && \is_string( $_POST[ self::RESET_NONCE ] ) ? \sanitize_text_field( \wp_unslash( $_POST[ self::RESET_NONCE ] ) ) : '';
		if ( '' === $nonce || ! \wp_verify_nonce( $nonce, self::RESET_ACTION ) ) {
			\wp_die( \esc_html__( 'Security check failed.', 'newspack-nodes' ) );
		}
		if ( ! self::current_user_allowed() ) {
			\wp_die( \esc_html__( 'You do not have permission to perform this action.', 'newspack-nodes' ) );
		}

		$options = Settings_Schema::get()->setting_option_names();
		foreach ( $options as $option ) {
			if ( \str_starts_with( $option, self::OPTION_PREFIX ) ) {
				\delete_option( $option );
			}
		}

		\wp_safe_redirect(
			\add_query_arg(
				[
					'page'  => self::MENU_SLUG,
					'reset' => '1',
				],
				\admin_url( 'options-general.php' )
			)
		);
		exit;
	}

	/**
	 * Permission gate: `manage_options` baseline + optional `allowed_users`
	 * whitelist from Config.
	 *
	 * Empty `allowed_users` means "all users with manage_options". When the
	 * whitelist is populated, the current user's `user_login` must be a member —
	 * manage_options is still required, so a demoted account loses access
	 * immediately without editing the whitelist.
	 *
	 * @return bool True if user is allowed.
	 */
	public static function current_user_allowed(): bool {
		if ( ! Capabilities::can( Capabilities::MANAGE ) ) {
			return false;
		}

		$allowed_users = Config::value( 'allowed_users' );
		if ( empty( $allowed_users ) || ! \is_array( $allowed_users ) ) {
			return true;
		}

		return \in_array( \wp_get_current_user()->user_login, $allowed_users, true );
	}

	/**
	 * Enqueue canonical UI appearance on the server-rendered Nodes settings page.
	 *
	 * @param string $hook Current admin-page hook suffix.
	 */
	public function enqueue_settings_style( string $hook = '' ): void {
		// phpcs:ignore WordPress.Security.NonceVerification.Recommended
		$page = isset( $_GET['page'] ) && \is_string( $_GET['page'] ) ? \sanitize_text_field( \wp_unslash( $_GET['page'] ) ) : '';
		if ( self::MENU_SLUG !== $page ) {
			return;
		}
		\wp_enqueue_style( 'newspack-nodes-ui' );
	}

	/**
	 * Shared registry of admin page slugs (besides the hub) that mount the debug
	 * overlay.
	 *
	 * The `newspack_nodes/devtools_overlay_pages` filter collects the slugs of
	 * admin pages that embed `<DebugOverlay>`. Overlay-tab-providing bundles (e.g.
	 * ELN's `current-request`) enqueue their tab on these pages so any plugin's
	 * overlay gets the full tab set — not just the hub and the tab provider's own
	 * pages.
	 *
	 * @api Consumed by sibling plugins (e.g. ELN's current-request overlay tab).
	 * @return string[] Deduplicated overlay-page slugs (non-strings filtered out).
	 */
	public static function devtools_overlay_pages(): array {
		return \array_values( \array_unique( \array_filter(
			(array) \apply_filters( 'newspack_nodes/devtools_overlay_pages', [] ),
			'\is_string'
		) ) );
	}

	/**
	 * Render the read-only "Effective Configuration" table below the settings
	 * form. Hooked to `newspack_nodes/settings_after_form`; delegates to the
	 * shared Settings_Renderer (panel logic lives in exactly one place across
	 * plugins). The per-row data shape is exercised by SettingsRendererEffectiveConfigTest.
	 */
	public function render_effective_config_section(): void {
		Settings_Renderer::render_effective_config_section( Settings_Schema::get(), self::OPTION_PREFIX, Config::load_config() );
	}

	/**
	 * Register every substrate option + the Storage and Topologies sections,
	 * all derived from the single Settings_Schema declaration.
	 */
	public function register_settings(): void {
		$schema = Settings_Schema::get();
		$schema->register_options( self::OPTIONS_GROUP );

		// Reset toggle or blanked field deletes row so the file default wins.
		Reset_Gate::register(
			self::RESET_MARK_FIELD,
			$schema->setting_option_names(),
			$schema->delete_on_blank_options()
		);

		$schema->register_sections_and_fields( self::SETTINGS_PAGE );
	}

	/**
	 * Sanitize a base-directory path: no null bytes, no `..`, must be absolute,
	 * trailing slash stripped; '' on any violation.
	 *
	 * @param mixed $value Input value.
	 */
	public static function sanitize_base_directory( $value ): string {
		if ( ! \is_string( $value ) ) {
			return '';
		}
		$value = \sanitize_text_field( $value );
		if ( \str_contains( $value, "\0" ) || \str_contains( $value, '..' ) ) {
			return '';
		}
		if ( '' === $value || '/' !== $value[0] ) {
			return '';
		}
		return \rtrim( $value, '/' );
	}

	/**
	 * Sanitize memcache servers (newline-separated host:port; underscores allowed in hostnames).
	 *
	 * Stores the typed (array) shape so the raw option overlay in Config::load_config()
	 * yields an array directly — consumers (Consumer_Node, ELN init_memcached) gate on is_array().
	 *
	 * @param mixed $value Newline-separated server list.
	 * @return array<int,string> Validated `host:port` entries, or empty array if all invalid.
	 */
	public static function sanitize_memcache_servers( $value ): array {
		if ( ! \is_scalar( $value ) ) {
			return [];
		}
		$lines           = \explode( "\n", (string) $value );
		$sanitized_lines = [];
		foreach ( $lines as $line ) {
			$line = \trim( $line );
			if ( '' === $line ) {
				continue;
			}
			if ( \preg_match( '/^[a-zA-Z0-9._\-]+:\d{1,5}$/', $line ) ) {
				$sanitized_lines[] = $line;
			}
		}
		return $sanitized_lines;
	}

	/**
	 * Sanitize log sources (newline-separated `name=/absolute/path`; the name/path
	 * rule is Log_Sources::parse_entry — the ONE rule the registry reads with).
	 *
	 * Stores the typed (array) shape so the raw option overlay in Config::load_config()
	 * yields an array directly, matching the memcache_servers pattern.
	 *
	 * @param mixed $value Newline-separated source list.
	 * @return array<int,string> Validated `name=/absolute/path` entries, or empty array if all invalid.
	 */
	public static function sanitize_log_sources( $value ): array {
		if ( ! \is_scalar( $value ) ) {
			return [];
		}
		$sanitized_lines = [];
		foreach ( \explode( "\n", (string) $value ) as $line ) {
			$line = \trim( $line );
			if ( '' === $line || null === Log_Sources::parse_entry( $line ) ) {
				continue;
			}
			$sanitized_lines[] = $line;
		}
		return $sanitized_lines;
	}

	public static function storage_section_callback(): void {
		echo '<p>' . \esc_html__( 'Configure log storage and memcache infrastructure. Changing storage layout (base directory, segment size, retention) restarts every worker.', 'newspack-nodes' ) . '</p>';
	}

	public static function remote_settings_section_callback(): void {
		echo '<p>' . \esc_html__( 'Storage geometry pushed to remote spokes (may differ from hub settings). Blank fields use the config-file default.', 'newspack-nodes' ) . '</p>';
	}
	public static function alerting_section_callback(): void {
		echo '<p>' . \esc_html__( 'Thresholds for the fleet-health alerts (Site Health, admin notice, alert action). Read live each fleet sweep; no worker restart. Blank fields use the config-file default.', 'newspack-nodes' ) . '</p>';
	}

	/**
	 * Per-option granular worker-restart on save (restart picked up at the next graceful exit).
	 *
	 * @param string $option Option name (full WP option key).
	 */
	public function maybe_request_worker_restart( string $option ): void {
		if ( ! \str_starts_with( $option, self::OPTION_PREFIX ) ) {
			return;
		}

		// Reset cached config so this request sees the new value.
		Config::reset();

		$short = \substr( $option, \strlen( self::OPTION_PREFIX ) );

		Restart_Planner::plan( Settings_Schema::get()->restart_for( $short ) );
	}

}
