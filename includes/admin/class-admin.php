<?php
/**
 * Admin: substrate-side WP-Settings-API surface.
 *
 * Owns ONLY substrate options (base_directory, num_partitions, num_segments,
 * segment_size, max_lifespan, memcache_servers). Saving layout/memcache options
 * triggers a per-partition worker-restart request.
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes\Admin;

use Newspack_Nodes\Bootstrap;
use Newspack_Nodes\Config;
use Newspack_Nodes\Config_System\Field_Reset_Assets;
use Newspack_Nodes\Config_System\Reset_Gate;
use Newspack_Nodes\Config_System\Restart_Planner;
use Newspack_Nodes\Config_System\Settings_Renderer;
use Newspack_Nodes\Core;
use Newspack_Nodes\Lock_Node;
use Newspack_Nodes\Settings_Schema;

\defined( 'ABSPATH' ) || exit;

/**
 * Substrate admin settings page.
 */
class Admin {

	/** Settings group for register_setting() / options.php. */
	public const OPTIONS_GROUP = 'newspack_nodes';

	/** Settings page slug for add_settings_field() / do_settings_sections(). */
	public const SETTINGS_PAGE = 'newspack_nodes';

	/** Menu page slug for add_options_page() (the `?page=` fragment). */
	public const MENU_SLUG = 'newspack-nodes';

	/** WP-option name prefix; worker-restart classification keys off it. */
	public const OPTION_PREFIX = 'newspack_nodes_';

	/** Nonce action / field for the reset-to-defaults form. */
	public const RESET_ACTION = 'newspack_nodes_reset_settings';
	public const RESET_NONCE  = 'newspack_nodes_reset_nonce';

	/** Hidden-input array name carrying per-field reset marks ({option} => "1"). */
	public const RESET_MARK_FIELD = 'newspack_nodes_reset';

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
		if ( ! \function_exists( 'current_user_can' ) ) {
			return true; // CLI / no user context — don't lock out CLI tools.
		}
		if ( ! \current_user_can( 'manage_options' ) ) {
			return false;
		}

		$config        = Config::load_config();
		$allowed_users = $config['allowed_users'] ?? [];
		if ( empty( $allowed_users ) || ! \is_array( $allowed_users ) ) {
			return true;
		}

		if ( ! \function_exists( 'wp_get_current_user' ) ) {
			return true; // No user context — don't lock out CLI tools.
		}
		$current_user = \wp_get_current_user();
		return \in_array( $current_user->user_login, $allowed_users, true );
	}

	/** Top-level menu slug for the DevTools hub — the "Nodes" landing page (Console + Topologies + Raw Logs tabs, deep-linked via `&tab=`). */
	public const HUB_MENU_SLUG = 'newspack-nodes-hub';

	public function __construct() {
		\add_action( 'admin_menu', [ $this, 'add_admin_menu' ] );
		\add_action( 'admin_menu', [ $this, 'register_topology_admin_page' ] );
		\add_action( 'admin_menu', [ $this, 'register_event_dashboard_pages' ], 11 );
		\add_action( 'admin_init', [ $this, 'register_settings' ] );
		\add_action( 'admin_post_' . self::RESET_ACTION, [ $this, 'handle_reset_settings' ] );
		// Register the canonical Newspack token stylesheet early (priority 1) so it
		// exists before any dashboard enqueues with it as a dependency — including
		// the sibling plugins' (event-logger-nodes, pyrobase), which run on the same
		// admin pages while nodes is active (a hard `Requires Plugins` dep).
		\add_action( 'admin_enqueue_scripts', [ $this, 'register_theme_style' ], 1 );
		\add_action( 'admin_enqueue_scripts', [ $this, 'enqueue_event_dashboards_assets' ] );
		\add_action( 'admin_enqueue_scripts', [ $this, 'enqueue_devtools_hub_assets' ] );
		\add_action( 'admin_enqueue_scripts', [ $this, 'enqueue_devtools_tab_bundles' ] );

		// The hub is the top-level "Nodes" page; the console + Topology Manager
		// load on it as DevTools tab bundles (the console carries the partition
		// snapshot its dropdown reads).
		\add_filter( 'newspack_nodes/devtools_tab_bundles', [ $this, 'register_event_dashboards_tab_bundle' ] );
		\add_filter( 'newspack_nodes/devtools_tab_bundles', [ $this, 'register_vault_tab_bundle' ] );
		\add_filter( 'newspack_nodes/devtools_tab_bundles', [ $this, 'register_aggregator_tab_bundle' ] );
		\add_filter( 'newspack_nodes/devtools_tab_bundles', [ $this, 'register_topology_console_tab_bundle' ] );

		// Both hooks so first + subsequent saves restart correctly.
		\add_action( 'updated_option', [ $this, 'maybe_request_worker_restart' ], 10, 1 );
		\add_action( 'added_option', [ $this, 'maybe_request_worker_restart' ], 10, 1 );

		// Read-only "Effective Configuration" panel below the settings form.
		\add_action( 'newspack_nodes/settings_after_form', [ $this, 'render_effective_config_section' ] );
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
			'manage_options',
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

		// Deps + version come from the wp-scripts manifest when present, so a
		// cache-bust rides the content hash; otherwise hardcoded deps + filemtime.
		$fallback   = $args['version_fallback'] ?? \NEWSPACK_NODES_VERSION;
		$asset_path = "{$dir}/index.asset.php";
		$asset      = \file_exists( $asset_path ) ? require $asset_path : null;
		if ( \is_array( $asset ) ) {
			$manifest_deps = \is_array( $asset['dependencies'] ?? null ) ? $asset['dependencies'] : [];
			$deps          = \array_values( \array_filter( $manifest_deps, '\is_string' ) );
			$version       = \is_string( $asset['version'] ?? null ) ? $asset['version'] : $fallback;
		} else {
			$deps    = [ 'wp-element', 'wp-components', 'wp-api-fetch', 'wp-i18n' ];
			$version = (string) ( \filemtime( $js_path ) ?: $fallback );
		}

		$handle = $args['handle'];
		\wp_enqueue_script( $handle, "{$url}/index.js", $deps, $version, true );

		if ( \file_exists( "{$dir}/index.css" ) ) {
			// Default every dashboard onto the Newspack token sheet so its
			// var(--np-*) references resolve (the `.newspack-nodes-theme` root
			// class carries the tokens; this loads their definitions).
			$style_deps    = $args['style_deps'] ?? [ 'wp-components', 'newspack-nodes-theme' ];
			$style_version = self::css_cache_version( "{$dir}/index.css", $version );
			\wp_enqueue_style( $handle, "{$url}/index.css", $style_deps, $style_version );
			if ( \file_exists( "{$dir}/index-rtl.css" ) && \function_exists( 'wp_style_add_data' ) ) {
				\wp_style_add_data( $handle, 'rtl', 'replace' );
			}
		}

		$rest_url  = \function_exists( 'rest_url' ) ? \rest_url() : '/wp-json/';
		$nonce     = \function_exists( 'wp_create_nonce' ) ? \wp_create_nonce( 'wp_rest' ) : '';
		$localized = \array_merge(
			[
				'restUrl' => \esc_url_raw( $rest_url ),
				'nonce'   => $nonce,
			],
			$args['localize'] ?? []
		);
		\wp_localize_script( $handle, 'NewspackNodesData', $localized );

		return $handle;
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

	/**
	 * Register the canonical Newspack theme stylesheet — the `newspack-nodes-theme`
	 * handle that ships the `--np-*` design tokens. Dashboards (this plugin's and
	 * the sibling plugins') enqueue it as a style dependency and carry the
	 * `.newspack-nodes-theme` root class, then reference `var(--np-*)`. Idempotent
	 * so the multiple consumers registering it (each plugin defensively) collapse
	 * to one registration.
	 */
	public function register_theme_style(): void {
		if (
			! \function_exists( 'wp_register_style' )
			|| \wp_style_is( 'newspack-nodes-theme', 'registered' )
		) {
			return;
		}
		$dir = \NEWSPACK_NODES_DIR . 'build/theme';
		$url = ( \defined( 'NEWSPACK_NODES_URL' ) ? \NEWSPACK_NODES_URL : '' ) . 'build/theme';
		$css = "{$dir}/index.css";
		if ( ! \file_exists( $css ) ) {
			return;
		}
		$version = (string) ( \filemtime( $css ) ?: \NEWSPACK_NODES_VERSION );
		\wp_register_style( 'newspack-nodes-theme', "{$url}/index.css", [], $version );
		if ( \file_exists( "{$dir}/index-rtl.css" ) && \function_exists( 'wp_style_add_data' ) ) {
			\wp_style_add_data( 'newspack-nodes-theme', 'rtl', 'replace' );
		}
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
				'dir'      => \NEWSPACK_NODES_DIR . 'build/event-dashboards',
				'url'      => ( \defined( 'NEWSPACK_NODES_URL' ) ? \NEWSPACK_NODES_URL : '' ) . 'build/event-dashboards',
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
				'handle'   => 'newspack-nodes-devtools-hub',
				'page'     => self::HUB_MENU_SLUG,
				'dir'      => \NEWSPACK_NODES_DIR . 'build/devtools-hub',
				'url'      => ( \defined( 'NEWSPACK_NODES_URL' ) ? \NEWSPACK_NODES_URL : '' ) . 'build/devtools-hub',
				'localize' => [
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
		$bundles = \apply_filters( 'newspack_nodes/devtools_tab_bundles', [] );
		if ( ! \is_array( $bundles ) ) {
			return;
		}
		$pages = [ self::HUB_MENU_SLUG ];
		foreach ( $bundles as $bundle ) {
			if ( ! \is_array( $bundle ) || ! isset( $bundle['handle'], $bundle['dir'], $bundle['url'] ) ) {
				continue;
			}
			if ( ! \is_scalar( $bundle['handle'] ) || ! \is_scalar( $bundle['dir'] ) || ! \is_scalar( $bundle['url'] ) ) {
				continue;
			}
			$localize = $bundle['localize'] ?? null;
			self::enqueue_react_page(
				[
					'handle'   => (string) $bundle['handle'],
					'page'     => $pages,
					'dir'      => (string) $bundle['dir'],
					'url'      => (string) $bundle['url'],
					'localize' => \is_array( $localize ) ? \array_filter( $localize, '\is_string', \ARRAY_FILTER_USE_KEY ) : [],
				]
			);
		}
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
		$bundles[] = [
			'handle' => 'newspack-nodes-event-dashboards',
			'dir'    => \NEWSPACK_NODES_DIR . 'build/event-dashboards',
			'url'    => ( \defined( 'NEWSPACK_NODES_URL' ) ? \NEWSPACK_NODES_URL : '' ) . 'build/event-dashboards',
		];
		return $bundles;
	}

	/**
	 * Advertise the vault bundle as a DevTools tab bundle so the hub page
	 * enqueues it and its `host: 'hub'` Vault tab registers there.
	 *
	 * @param array<int,mixed> $bundles Existing tab bundles.
	 * @return array<int,mixed> Bundles with the vault bundle appended.
	 */
	public function register_vault_tab_bundle( array $bundles ): array {
		$bundles[] = [
			'handle' => 'newspack-nodes-vault',
			'dir'    => \NEWSPACK_NODES_DIR . 'build/vault',
			'url'    => ( \defined( 'NEWSPACK_NODES_URL' ) ? \NEWSPACK_NODES_URL : '' ) . 'build/vault',
		];
		return $bundles;
	}

	/**
	 * Advertise the aggregator bundle as a DevTools tab bundle so the hub page
	 * enqueues it and its `host: 'hub'` Aggregator tab registers there.
	 *
	 * @param array<int,mixed> $bundles Existing tab bundles.
	 * @return array<int,mixed> Bundles with the aggregator bundle appended.
	 */
	public function register_aggregator_tab_bundle( array $bundles ): array {
		$bundles[] = [
			'handle' => 'newspack-nodes-aggregator-tab',
			'dir'    => \NEWSPACK_NODES_DIR . 'build/event-aggregator',
			'url'    => ( \defined( 'NEWSPACK_NODES_URL' ) ? \NEWSPACK_NODES_URL : '' ) . 'build/event-aggregator',
		];
		return $bundles;
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
		// Per-topology partition counts for the React dropdown.
		$topology_partitions = [];
		foreach ( \Newspack_Nodes\Topology_Registry::list() as $name ) {
			if ( '' === $name ) {
				continue;
			}
			$topology_partitions[ $name ] = Bootstrap::num_partitions_for( $name );
		}
		\ksort( $topology_partitions );

		// Active topologies (catalog + operator overlay) the supervisor would spawn.
		$active_topologies = \array_keys( Bootstrap::get_topologies() );
		\sort( $active_topologies );

		// Config default partition count — the client's fallback for a topology
		// whose live `topologies.list` entry omits num_partitions.
		$config_np  = Config::load_config()['num_partitions'] ?? 1;
		$default_np = (int) ( \is_scalar( $config_np ) ? $config_np : 1 );

		$bundles[] = [
			'handle'   => 'newspack-nodes-topology-console',
			'dir'      => \NEWSPACK_NODES_DIR . 'build/topology-console',
			'url'      => ( \defined( 'NEWSPACK_NODES_URL' ) ? \NEWSPACK_NODES_URL : '' ) . 'build/topology-console',
			'localize' => [
				'tree'                => 'topology-console',
				'version'             => \NEWSPACK_NODES_VERSION,
				'topologyPartitions'  => $topology_partitions,
				'activeTopologies'    => $active_topologies,
				'configNumPartitions' => $default_np,
			],
		];
		return $bundles;
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
			'manage_options',
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
		<div class="wrap newspack-nodes-settings-wrap">
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
			<?php
			// Extension plugins inject sections below the form.
			\do_action( 'newspack_nodes/settings_after_form' );
			Field_Reset_Assets::enqueue();
			echo Field_Reset_Assets::highlight_style(); // phpcs:ignore WordPress.Security.EscapeOutput.OutputNotEscaped -- static CSS literal.
			?>
		</div>
		<?php
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

		// Shared per-field reset / delete-on-blank gate (Config_System\Reset_Gate):
		// a reset toggle (any field) OR a blanked text-like field deletes the row
		// so the file default resurfaces.
		Reset_Gate::register(
			self::RESET_MARK_FIELD,
			$schema->setting_option_names(),
			$schema->delete_on_blank_options()
		);

		$schema->register_sections_and_fields( self::SETTINGS_PAGE );
	}

	// -- Sanitizers ---------------------------------------------------------

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
	 * Sanitize integer option, preserving empty string for "use default".
	 *
	 * @param mixed $input Input value.
	 * @return string|int Empty string or sanitized integer.
	 */
	public static function sanitize_int_or_empty( $input ) {
		if ( '' === $input || null === $input ) {
			return '';
		}
		if ( ! \is_scalar( $input ) && ! \is_array( $input ) ) {
			return '';
		}
		return \absint( $input );
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
	 * Sanitize the remote num_segments setting: clamp to [2, 16], or '' when unset.
	 *
	 * @param int|string|null $value Raw option value (WP sanitize_callback may pass null).
	 * @return int|string Clamped segment count, or '' when blank/unset.
	 */
	public static function sanitize_remote_num_segments( int|string|null $value ): int|string {
		if ( '' === $value || null === $value ) {
			return '';
		}
		return \max( 2, \min( 16, \absint( $value ) ) );
	}

	/**
	 * Sanitize the remote segment_size setting: clamp to [1MB, 256MB], or '' when unset.
	 *
	 * @param int|string|null $value Raw option value (WP sanitize_callback may pass null).
	 * @return int|string Clamped byte size, or '' when blank/unset.
	 */
	public static function sanitize_remote_segment_size( int|string|null $value ): int|string {
		if ( '' === $value || null === $value ) {
			return '';
		}
		return \max( 1024 * 1024, \min( 256 * 1024 * 1024, \absint( $value ) ) );
	}

	/**
	 * Sanitize the remote max_lifespan setting: clamp to [0, 604800] seconds, or '' when unset.
	 * 0 = disabled (pure count-based), matching the hub max_lifespan.
	 *
	 * @param int|string|null $value Raw option value (WP sanitize_callback may pass null).
	 * @return int|string Clamped lifespan in seconds, or '' when blank/unset.
	 */
	public static function sanitize_remote_max_lifespan( int|string|null $value ): int|string {
		if ( '' === $value || null === $value ) {
			return '';
		}
		return \max( 0, \min( 604800, \absint( $value ) ) );
	}

	// -- Section callbacks --------------------------------------------------

	public static function storage_section_callback(): void {
		echo '<p>' . \esc_html__( 'Configure log storage and memcache infrastructure. Changing storage layout (base directory, segment size, retention) restarts every worker.', 'newspack-nodes' ) . '</p>';
	}

	public static function remote_settings_section_callback(): void {
		echo '<p>' . \esc_html__( 'Storage geometry pushed to remote spokes (may differ from hub settings). Blank fields use the config-file default.', 'newspack-nodes' ) . '</p>';
	}

	// -- Field callbacks ----------------------------------------------------

	/**
	 * Read an int config default, coercing scalars exactly as `(int)` would and falling back when non-scalar.
	 *
	 * @param array<string, mixed> $defaults Config defaults.
	 * @param string               $key      Key to read.
	 * @param int                  $fallback Default when missing/non-scalar.
	 */
	private static function default_int( array $defaults, string $key, int $fallback ): int {
		$value = $defaults[ $key ] ?? $fallback;
		return \is_scalar( $value ) ? (int) $value : $fallback;
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

	public static function num_partitions_callback(): void {
		self::render_number( 'num_partitions', 1, 1, 16, \__( 'Number of log partitions for parallel processing.', 'newspack-nodes' ) );
	}

	public static function num_segments_callback(): void {
		self::render_number( 'num_segments', 4, 2, 32, \__( 'Number of segments to retain per partition.', 'newspack-nodes' ) );
	}

	public static function segment_size_callback(): void {
		self::render_number( 'segment_size', 64 * 1024 * 1024, 1048576, 536870912, \__( 'Maximum segment size in bytes.', 'newspack-nodes' ) );
	}

	public static function max_lifespan_callback(): void {
		self::render_number( 'max_lifespan', 86400, 0, 604800, \__( 'Minimum retention in seconds. 0 = disabled (pure count-based).', 'newspack-nodes' ) );
	}

	public static function remote_num_segments_callback(): void {
		self::render_number( 'remote_num_segments', 2, 2, 16, \__( 'Number of log segments on remote servers (2-16).', 'newspack-nodes' ) );
	}

	public static function remote_segment_size_callback(): void {
		self::render_number( 'remote_segment_size', 33554432, 1024 * 1024, 256 * 1024 * 1024, \__( 'Segment size on remote servers in bytes (1MB-256MB).', 'newspack-nodes' ) );
	}

	public static function remote_max_lifespan_callback(): void {
		self::render_number( 'remote_max_lifespan', 3600, 0, 604800, \__( 'Minimum retention on remote servers in seconds. Spokes keep data at least this long for the aggregator to pull. 0 = disabled (pure count-based).', 'newspack-nodes' ) );
	}

	/** Echo a number field: default from the config file, value from the stored option. */
	private static function render_number( string $field, int $fallback, int $min, int $max, string $description ): void {
		$default = self::default_int( Config::load_config_defaults(), $field, $fallback );
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
		// Stored as the typed array shape; the textarea joins entries with newlines.
		$value = \get_option( 'newspack_nodes_memcache_servers', [] );
		$value = \is_array( $value ) ? $value : [];
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
	 * Total-storage field: segment_size × num_segments × (count of on-disk log-partition dirs).
	 */
	public static function total_storage_callback(): void {
		$defaults     = Config::load_config_defaults();
		$segment_size = \get_option( 'newspack_nodes_segment_size', '' );
		$num_segments = \get_option( 'newspack_nodes_num_segments', '' );

		// Use config defaults for empty values.
		$segment_size = '' === $segment_size ? self::default_int( $defaults, 'segment_size', 64 * 1024 * 1024 ) : ( \is_scalar( $segment_size ) ? (int) $segment_size : 0 );
		$num_segments = '' === $num_segments ? self::default_int( $defaults, 'num_segments', 4 ) : ( \is_scalar( $num_segments ) ? (int) $num_segments : 0 );

		// `Log_Discovery::on_disk()` returns the concrete per-partition dir
		// names (e.g. `firehose.p0`), so the partition dimension is already in
		// this count — don't multiply by num_partitions again.
		$num_log_dirs = \count( \Newspack_Nodes\Log_Discovery::on_disk() );
		$total_bytes  = $segment_size * $num_segments * $num_log_dirs;
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
			/* translators: 1: segment size in MB, 2: number of segments, 3: number of on-disk log partitions */
			\esc_html__( 'Calculated as: %1$s MB segment × %2$s segments × %3$s log partitions', 'newspack-nodes' ),
			\esc_html( (string) $segment_mb ),
			\esc_html( (string) $num_segments ),
			\esc_html( (string) $num_log_dirs )
		);
		?>
		</p>
		<?php
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

		$redirect = \function_exists( 'admin_url' )
			? \add_query_arg(
				[
					'page'  => self::MENU_SLUG,
					'reset' => '1',
				],
				\admin_url( 'options-general.php' )
			)
			: '';
		if ( '' !== $redirect ) {
			\wp_safe_redirect( $redirect );
			exit;
		}
		exit;
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

		// Reset cached config so this process sees the new value later in the same request.
		Config::reset();

		$short = \substr( $option, \strlen( self::OPTION_PREFIX ) );

		// Wrap the whole resolve+touch: the planner re-enters Config::load_config() via Bootstrap.
		try {
			$locks_dir = Config::get_locks_directory();
			Restart_Planner::request_restarts( Settings_Schema::get()->restart_for( $short ), $locks_dir );
		} catch ( \Throwable $e ) {
			// Best-effort: the next supervisor pass picks up the new config.
			return;
		}
	}

	/** Hidden-input name that flags $field for per-field reset (deleted on Save). */
	private static function reset_mark_name( string $field ): string {
		return Reset_Gate::mark_name( self::RESET_MARK_FIELD, self::OPTION_PREFIX . $field );
	}

}
