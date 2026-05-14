<?php
/**
 * Admin: substrate-side WP-Settings-API surface.
 *
 * Owns ONLY the substrate-level options:
 *   - base_directory
 *   - num_partitions
 *   - num_segments
 *   - segment_size
 *   - max_lifespan
 *   - memcache_servers
 *
 * Application-level options (logging toggles, URL filters, hook lists, the
 * aggregator spoke list, etc.) live in the application plugin's own Admin
 * class. The application Admin
 * may READ substrate values via `\Newspack_Nodes\Config` but must NOT WRITE
 * substrate options.
 *
 * Settings group / option-prefix logic matches `\Newspack_Nodes\Config`:
 *   - Settings group:  `newspack_nodes`
 *   - Option prefix:   `newspack_nodes_`
 *   - Settings page slug: `newspack_nodes`
 *   - Menu page slug:  `newspack-nodes` (mounted under
 *     Settings → Nodes Runtime).
 *
 * Per-option granular worker-restart on save: substrate options that affect
 * the file segment layout or memcache topology trigger a restart request via
 * `Lock::request_restart_at()` for every active partition. Application
 * plugins can extend the worker-group set via the
 * `newspack_nodes/worker_restart_groups` filter.
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes\Admin;

use Newspack_Nodes\Bootstrap;
use Newspack_Nodes\Config;
use Newspack_Nodes\Lock;

\defined( 'ABSPATH' ) || exit;

/**
 * Substrate admin settings page.
 */
class Admin {

	/**
	 * Settings group registered with `register_setting()`. WordPress uses this
	 * to scope nonce verification and validation when the form posts to
	 * `options.php`.
	 */
	public const OPTIONS_GROUP = 'newspack_nodes';

	/**
	 * Settings page slug used by `add_settings_section/field()` and
	 * `do_settings_sections()`. Distinct from the menu-page slug below.
	 */
	public const SETTINGS_PAGE = 'newspack_nodes';

	/**
	 * Menu page slug used by `add_options_page()` (the URL fragment after
	 * `?page=`).
	 */
	public const MENU_SLUG = 'newspack-nodes';

	/**
	 * WP-option name prefix. All admin-managed options live under this prefix.
	 * Worker-restart classification (see `maybe_request_worker_restart`) keys
	 * off it.
	 */
	public const OPTION_PREFIX = 'newspack_nodes_';

	/**
	 * Nonce action / field name for the reset-to-defaults form.
	 */
	public const RESET_ACTION = 'newspack_nodes_reset_settings';
	public const RESET_NONCE  = 'newspack_nodes_reset_nonce';

	/**
	 * Substrate option names cleared by `handle_reset_settings()`.
	 *
	 * Kept on the class so external callers can extend via the
	 * `newspack_nodes/reset_options` filter without re-listing these.
	 *
	 * @var string[]
	 */
	private static array $option_names = [
		'newspack_nodes_base_directory',
		'newspack_nodes_num_partitions',
		'newspack_nodes_num_segments',
		'newspack_nodes_segment_size',
		'newspack_nodes_max_lifespan',
		'newspack_nodes_memcache_servers',
	];

	/**
	 * Permission gate: `manage_options` baseline. Substrate admin doesn't
	 * gate behind an `allowed_users` whitelist — the application plugin owns
	 * that list, and substrate must remain reachable to bootstrap-level
	 * admins regardless of application-level access policy.
	 *
	 * @return bool True if user is allowed.
	 */
	public static function current_user_allowed(): bool {
		if ( ! \function_exists( 'current_user_can' ) ) {
			return true; // CLI / no user context — don't lock out admins running CLI tools.
		}
		return (bool) \current_user_can( 'manage_options' );
	}

	/**
	 * Top-level menu slug for the topology console. Distinct from the
	 * Settings-API slug above so the console gets its own first-class
	 * admin entry rather than living under Settings.
	 */
	public const TOPOLOGY_MENU_SLUG = 'newspack-nodes-topology';

	public function __construct() {
		\add_action( 'admin_menu', [ $this, 'add_admin_menu' ] );
		\add_action( 'admin_menu', [ $this, 'register_topology_admin_page' ] );
		\add_action( 'admin_init', [ $this, 'register_settings' ] );
		\add_action( 'admin_post_' . self::RESET_ACTION, [ $this, 'handle_reset_settings' ] );
		\add_action( 'admin_enqueue_scripts', [ $this, 'enqueue_topology_console_assets' ] );

		// Per-option granular worker-restart on save. Both `added_option` (first
		// save) and `updated_option` (subsequent saves) fire this so newly-added
		// options trigger the right restart class too.
		\add_action( 'updated_option', [ $this, 'maybe_request_worker_restart' ], 10, 1 );
		\add_action( 'added_option', [ $this, 'maybe_request_worker_restart' ], 10, 1 );
	}

	/**
	 * Register the Topology Console as a top-level admin menu. The
	 * page renders a single mount div the React tree hooks onto.
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
			self::TOPOLOGY_MENU_SLUG,
			[ $this, 'render_topology_page' ],
			'dashicons-networking',
			81
		);
	}

	/**
	 * Render the topology console mount element. The React bundle
	 * (enqueued in enqueue_topology_console_assets) finds this id and
	 * mounts itself.
	 */
	public function render_topology_page(): void {
		if ( ! self::current_user_allowed() ) {
			\wp_die( \esc_html__( 'You do not have permission to access this page.', 'newspack-nodes' ) );
		}
		echo '<div id="event-logger-topology-console" class="event-logger-topology-console-page"></div>';
	}

	/**
	 * Enqueue the topology-console asset bundle on its admin page.
	 *
	 * The React tree imports @wordpress/element + @wordpress/api-fetch,
	 * mounts on `#event-logger-topology-console`, and talks to the
	 * substrate's REST controllers via the localized REST URL + nonce.
	 */
	public function enqueue_topology_console_assets( string $hook = '' ): void {
		if ( ! \function_exists( 'wp_enqueue_script' ) ) {
			return;
		}
		// phpcs:ignore WordPress.Security.NonceVerification.Recommended
		$page = isset( $_GET['page'] ) ? \sanitize_text_field( \wp_unslash( $_GET['page'] ) ) : '';
		if ( self::TOPOLOGY_MENU_SLUG !== $page ) {
			return;
		}
		$asset_path = \NEWSPACK_NODES_DIR . 'build/topology-console/index.js';
		$asset_url  = ( \defined( 'NEWSPACK_NODES_URL' ) ? \NEWSPACK_NODES_URL : '' ) . 'build/topology-console/index.js';
		if ( ! \file_exists( $asset_path ) ) {
			return;
		}
		$handle  = 'newspack-nodes-topology-console';
		$version = \filemtime( $asset_path ) ?: \NEWSPACK_NODES_VERSION;
		$deps    = [ 'wp-element', 'wp-components', 'wp-api-fetch', 'wp-i18n' ];
		\wp_enqueue_script( $handle, $asset_url, $deps, $version, true );

		$css_path = \NEWSPACK_NODES_DIR . 'build/topology-console/index.css';
		$css_url  = ( \defined( 'NEWSPACK_NODES_URL' ) ? \NEWSPACK_NODES_URL : '' ) . 'build/topology-console/index.css';
		if ( \file_exists( $css_path ) ) {
			$css_version = \filemtime( $css_path ) ?: \NEWSPACK_NODES_VERSION;
			\wp_enqueue_style( $handle, $css_url, [ 'wp-components' ], $css_version );
		}

		// Per-topology partition counts. The React tree reads these to
		// size its partition dropdown so it can't show p0–p3 for a
		// 1-partition aggregator (nor stop at p3 when num_partitions
		// was bumped). Use the full catalog (not the active overlay)
		// so the dropdown sees every topology that could spawn workers,
		// not just the operator-selected subset.
		$topology_partitions = [];
		foreach ( Bootstrap::get_topology_catalog() as $name => $def ) {
			if ( \is_string( $name ) && \is_array( $def ) && isset( $def['num_partitions'] ) ) {
				$topology_partitions[ $name ] = (int) $def['num_partitions'];
			}
		}

		// REST root + nonce for apiFetch wrappers in the React tree.
		$rest_url    = \function_exists( 'rest_url' ) ? \rest_url() : '/wp-json/';
		$nonce       = \function_exists( 'wp_create_nonce' ) ? \wp_create_nonce( 'wp_rest' ) : '';
		// Separate save-topology nonce — REST PromptModal POSTs use this.
		// Distinct action from the wp_rest cookie nonce so a leaked
		// wp_rest nonce doesn't grant authoring rights to the topology
		// dir; mirror SpawnController's per-action nonce policy.
		$save_nonce  = \function_exists( 'wp_create_nonce' )
			? \wp_create_nonce( \Newspack_Nodes\Rest\TopologiesController::NONCE_ACTION )
			: '';
		$layout_nonce = \function_exists( 'wp_create_nonce' )
			? \wp_create_nonce( \Newspack_Nodes\Rest\LayoutsController::NONCE_ACTION )
			: '';
		\wp_localize_script(
			$handle,
			'NewspackNodesData',
			[
				'restUrl'             => $rest_url,
				'nonce'               => $nonce,
				'saveTopologyNonce'   => $save_nonce,
				'saveLayoutNonce'     => $layout_nonce,
				'tree'                => 'topology-console',
				'version'             => \NEWSPACK_NODES_VERSION,
				'topologyPartitions'  => $topology_partitions,
			]
		);
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
	 * Render the settings page: form + Reset-to-Defaults secondary form.
	 *
	 * The reset is in a separate hidden form so cancelling the confirm()
	 * dialog leaves the main form's pending edits intact.
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
			// Allow extension plugins to inject sections below the form.
			\do_action( 'newspack_nodes/settings_after_form' );
			$this->render_reset_button_handler();
			?>
		</div>
		<?php
	}

	/**
	 * Register settings with the WP Settings API.
	 *
	 * Wires every substrate option, plus the General + Storage sections.
	 */
	public function register_settings(): void {
		// Path. Sanitize: no null bytes, no `..`, must be absolute, trailing slash stripped.
		\register_setting(
			self::OPTIONS_GROUP,
			'newspack_nodes_base_directory',
			[
				'sanitize_callback' => function ( $value ) {
					$value = \sanitize_text_field( $value );
					if ( \str_contains( $value, "\0" ) || \str_contains( $value, '..' ) ) {
						return '';
					}
					if ( '' === $value || '/' !== $value[0] ) {
						return '';
					}
					return \rtrim( $value, '/' );
				},
			]
		);

		// Integers — empty string preserved for "use default".
		\register_setting(
			self::OPTIONS_GROUP,
			'newspack_nodes_num_partitions',
			[ 'sanitize_callback' => [ $this, 'sanitize_int_or_empty' ] ]
		);
		\register_setting(
			self::OPTIONS_GROUP,
			'newspack_nodes_num_segments',
			[ 'sanitize_callback' => [ $this, 'sanitize_int_or_empty' ] ]
		);
		\register_setting(
			self::OPTIONS_GROUP,
			'newspack_nodes_segment_size',
			[ 'sanitize_callback' => [ $this, 'sanitize_int_or_empty' ] ]
		);
		\register_setting(
			self::OPTIONS_GROUP,
			'newspack_nodes_max_lifespan',
			[ 'sanitize_callback' => [ $this, 'sanitize_int_or_empty' ] ]
		);

		// Newline-separated host:port list. Not autoloaded (read by workers, not request path).
		\register_setting(
			self::OPTIONS_GROUP,
			'newspack_nodes_memcache_servers',
			[
				'sanitize_callback' => [ $this, 'sanitize_memcache_servers' ],
				'autoload'          => false,
			]
		);

		// Flat list of active TSL topology names. Sanitizer drops
		// names that don't resolve via Topology_Registry so a typo
		// can't cause the supervisor to spawn a nonexistent fleet.
		\register_setting(
			self::OPTIONS_GROUP,
			'newspack_nodes_topologies',
			[
				'sanitize_callback' => [ $this, 'sanitize_topologies' ],
				'autoload'          => true,
			]
		);

		// General section.
		// Storage section.
		\add_settings_section(
			'newspack_nodes_storage_section',
			\__( 'Storage Settings', 'newspack-nodes' ),
			[ $this, 'storage_section_callback' ],
			self::SETTINGS_PAGE
		);
		\add_settings_field(
			'num_partitions',
			\__( 'Num Partitions', 'newspack-nodes' ),
			[ $this, 'num_partitions_callback' ],
			self::SETTINGS_PAGE,
			'newspack_nodes_storage_section'
		);
		\add_settings_field(
			'num_segments',
			\__( 'Num Segments', 'newspack-nodes' ),
			[ $this, 'num_segments_callback' ],
			self::SETTINGS_PAGE,
			'newspack_nodes_storage_section'
		);
		\add_settings_field(
			'segment_size',
			\__( 'Segment Size', 'newspack-nodes' ),
			[ $this, 'segment_size_callback' ],
			self::SETTINGS_PAGE,
			'newspack_nodes_storage_section'
		);
		\add_settings_field(
			'max_lifespan',
			\__( 'Minimum Retention', 'newspack-nodes' ),
			[ $this, 'max_lifespan_callback' ],
			self::SETTINGS_PAGE,
			'newspack_nodes_storage_section'
		);
		\add_settings_field(
			'total_storage',
			\__( 'Total Log Storage', 'newspack-nodes' ),
			[ $this, 'total_storage_callback' ],
			self::SETTINGS_PAGE,
			'newspack_nodes_storage_section'
		);
		\add_settings_field(
			'base_directory',
			\__( 'Base Directory', 'newspack-nodes' ),
			[ $this, 'base_directory_callback' ],
			self::SETTINGS_PAGE,
			'newspack_nodes_storage_section'
		);
		\add_settings_field(
			'memcache_servers',
			\__( 'Memcache Servers', 'newspack-nodes' ),
			[ $this, 'memcache_servers_callback' ],
			self::SETTINGS_PAGE,
			'newspack_nodes_storage_section'
		);

		// Topologies section — flat checkbox list of every topology
		// the registry knows about. Toggling an entry changes the
		// `topologies` option; the supervisor picks up the new list
		// on its next loop.
		\add_settings_section(
			'newspack_nodes_topologies_section',
			\__( 'Topologies', 'newspack-nodes' ),
			[ $this, 'topologies_section_callback' ],
			self::SETTINGS_PAGE
		);
		\add_settings_field(
			'topologies',
			\__( 'Active Topologies', 'newspack-nodes' ),
			[ $this, 'topologies_callback' ],
			self::SETTINGS_PAGE,
			'newspack_nodes_topologies_section'
		);
	}

	// -- Sanitizers ---------------------------------------------------------

	/**
	 * Sanitize integer option, preserving empty string for "use default".
	 *
	 * @param mixed $input Input value.
	 * @return string|int Empty string or sanitized integer.
	 */
	public function sanitize_int_or_empty( $input ) {
		if ( '' === $input || null === $input ) {
			return '';
		}
		return \absint( $input );
	}

	/**
	 * Sanitize memcache servers option (newline-separated host:port list).
	 *
	 * Underscore is allowed in hostnames so Docker container names like
	 * `mem_cache_1` validate.
	 *
	 * @param mixed $value Newline-separated server list.
	 * @return string Sanitized servers (one per line) or empty string if all invalid.
	 */
	public function sanitize_memcache_servers( $value ): string {
		if ( '' === $value || null === $value ) {
			return '';
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
		return \implode( "\n", $sanitized_lines );
	}

	/**
	 * Sanitize the active-topologies list. Drops entries that don't
	 * resolve via Topology_Registry — a typo (or removed plugin)
	 * shouldn't leave the supervisor trying to spawn a phantom fleet.
	 *
	 * @param mixed $value Posted form value (array of topology names).
	 * @return array<int,string>
	 */
	public function sanitize_topologies( $value ): array {
		if ( ! \is_array( $value ) ) {
			return [];
		}
		$out = [];
		foreach ( $value as $name ) {
			if ( ! \is_string( $name ) || '' === $name ) {
				continue;
			}
			if ( null !== \Newspack_Nodes\Topology_Registry::resolve( $name ) ) {
				$out[] = $name;
			}
		}
		return \array_values( \array_unique( $out ) );
	}

// -- Section callbacks --------------------------------------------------

	public function storage_section_callback(): void {
		echo '<p>' . \esc_html__( 'Configure log storage and memcache infrastructure. Changing storage layout (base directory, segment size, retention) restarts every worker.', 'newspack-nodes' ) . '</p>';
	}

	public function topologies_section_callback(): void {
		echo '<p>' . \esc_html__( 'Pick which TSL topologies the supervisor spawns workers for. Each entry runs as its own worker fleet, named after the topology.', 'newspack-nodes' ) . '</p>';
	}

	/**
	 * Render a checkbox per known topology. Names come from
	 * Topology_Registry::list() (user dir + every plugin-registered
	 * stock dir). Empty state surfaces a help line so a fresh
	 * deployment knows where to look.
	 */
	public function topologies_callback(): void {
		$available = \Newspack_Nodes\Topology_Registry::list();
		\sort( $available );
		// The application publishes its file-default catalog (and ONLY
		// that) via `newspack_nodes/topologies`. The substrate owns the
		// operator-overlay option `newspack_nodes_topologies`:
		//  - option === false → no operator preference; default to
		//    every file-default topology being active (sensible fresh-
		//    install behavior).
		//  - option === []    → operator unchecked everything; spawn
		//    nothing (distinct from never having saved).
		//  - option array     → exact active list.
		$defaults = \array_keys( Bootstrap::get_topology_catalog() );
		\sort( $defaults );
		$option = \get_option( 'newspack_nodes_topologies', false );
		$active = false === $option
			? $defaults
			: ( \is_array( $option ) ? $option : [] );
		if ( empty( $available ) ) {
			echo '<p class="description">' . \esc_html__( 'No topologies registered. Application plugins must call Newspack_Nodes\\Topology_Registry::register_stock_dir() at load time.', 'newspack-nodes' ) . '</p>';
			return;
		}
		// Mirror render_number_field's chip layout: fieldset on the left,
		// `↺` reset chip on the right. Click restores the resolved-filter
		// list (application's file defaults).
		echo '<div style="display: flex; align-items: flex-start; gap: 10px;">';
		echo '<div style="flex: 1;">';
		echo '<fieldset id="newspack-nodes-topologies-fieldset">';
		foreach ( $available as $name ) {
			$checked = \in_array( $name, $active, true ) ? ' checked' : '';
			echo '<label style="display:block; margin-bottom: 4px;">';
			echo '<input type="checkbox" name="newspack_nodes_topologies[]" value="' . \esc_attr( $name ) . '"' . \esc_attr( $checked ) . ' /> ';
			echo '<code>' . \esc_html( $name ) . '</code>';
			echo '</label>';
		}
		echo '</fieldset>';
		echo '<p class="description">' . \esc_html__( 'Each checked topology becomes one worker fleet. The supervisor picks up changes on its next loop (~1 minute). Click ↺ to restore the application-shipped defaults, then Save Settings to commit.', 'newspack-nodes' ) . '</p>';
		echo '</div>';
		echo '<button type="button" class="button button-secondary newspack-nodes-reset-number"'
			. ' data-newspack-nodes-load-defaults="' . \esc_attr( (string) \wp_json_encode( $defaults ) ) . '"'
			. ' title="' . \esc_attr__( 'Load defaults from config file', 'newspack-nodes' ) . '">↺</button>';
		echo '</div>';
		echo '<script>(function(){
			var btn = document.querySelector( "button[data-newspack-nodes-load-defaults]" );
			if ( ! btn ) { return; }
			btn.addEventListener( "click", function () {
				var defaults;
				try { defaults = JSON.parse( btn.getAttribute( "data-newspack-nodes-load-defaults" ) ) || []; }
				catch ( e ) { defaults = []; }
				var fieldset = document.getElementById( "newspack-nodes-topologies-fieldset" );
				if ( ! fieldset ) { return; }
				fieldset.querySelectorAll( "input[type=checkbox][name=\"newspack_nodes_topologies[]\"]" ).forEach( function ( cb ) {
					cb.checked = defaults.indexOf( cb.value ) !== -1;
				} );
			} );
		})();</script>';
	}

	// -- Field callbacks ----------------------------------------------------

	public function base_directory_callback(): void {
		$defaults = Config::load_config_defaults();
		$this->render_directory_field(
			'base_directory',
			(string) ( $defaults['base_directory'] ?? '/tmp/newspack-nodes' ),
			\__( 'Base directory for logs, locks, and offsets.', 'newspack-nodes' )
		);
	}

	public function num_partitions_callback(): void {
		$defaults = Config::load_config_defaults();
		$this->render_number_field(
			'num_partitions',
			(int) ( $defaults['num_partitions'] ?? 1 ),
			1,
			16,
			\__( 'Number of log partitions for parallel processing.', 'newspack-nodes' )
		);
	}

	public function num_segments_callback(): void {
		$defaults = Config::load_config_defaults();
		$this->render_number_field(
			'num_segments',
			(int) ( $defaults['num_segments'] ?? 4 ),
			2,
			32,
			\__( 'Number of segments to retain per partition.', 'newspack-nodes' )
		);
	}

	public function segment_size_callback(): void {
		$defaults = Config::load_config_defaults();
		$this->render_number_field(
			'segment_size',
			(int) ( $defaults['segment_size'] ?? ( 64 * 1024 * 1024 ) ),
			1048576,
			536870912,
			\__( 'Maximum segment size in bytes.', 'newspack-nodes' )
		);
	}

	public function max_lifespan_callback(): void {
		$defaults = Config::load_config_defaults();
		$this->render_number_field(
			'max_lifespan',
			(int) ( $defaults['max_lifespan'] ?? 86400 ),
			0,
			604800,
			\__( 'Minimum retention in seconds. 0 = disabled (pure count-based).', 'newspack-nodes' )
		);
	}

	/**
	 * Memcache servers field callback. Newline-separated `host:port` textarea
	 * with placeholder showing the configured defaults.
	 */
	public function memcache_servers_callback(): void {
		$defaults        = Config::load_config_defaults();
		$default_servers = $defaults['memcache_servers'] ?? [ '127.0.0.1:11211' ];
		if ( ! \is_array( $default_servers ) ) {
			$default_servers = [ '127.0.0.1:11211' ];
		}
		$default_text = \implode( "\n", $default_servers );
		$value        = \get_option( 'newspack_nodes_memcache_servers', '' );
		?>
		<div style="display: flex; align-items: flex-start; gap: 10px;">
			<div style="flex: 1;">
				<textarea id="memcache_servers" name="newspack_nodes_memcache_servers" rows="3" class="regular-text code" placeholder="<?php echo \esc_attr( $default_text ); ?>"><?php echo \esc_textarea( $value ); ?></textarea>
				<p class="description">
					<?php \esc_html_e( 'Memcache servers (one per line, format: host:port). Used for stats aggregation and SSE.', 'newspack-nodes' ); ?>
					<br><?php \esc_html_e( 'Default:', 'newspack-nodes' ); ?> <?php echo \esc_html( \implode( ', ', $default_servers ) ); ?>
				</p>
			</div>
			<button type="button" class="button button-secondary newspack-nodes-reset-text"
				data-field="memcache_servers" data-default=""
				title="<?php \esc_attr_e( 'Reset to default', 'newspack-nodes' ); ?>">↺</button>
		</div>
		<?php
	}

	/**
	 * Total-storage field. Computed bytes display: `segment_size × num_segments
	 * × num_partitions × num_logs`. `num_logs` is filterable so plugins (Jobs,
	 * Performance, etc.) can register their additional log streams.
	 */
	public function total_storage_callback(): void {
		$defaults       = Config::load_config_defaults();
		$segment_size   = \get_option( 'newspack_nodes_segment_size', '' );
		$num_segments   = \get_option( 'newspack_nodes_num_segments', '' );
		$num_partitions = \get_option( 'newspack_nodes_num_partitions', '' );

		// Use config defaults for empty values.
		$segment_size   = '' === $segment_size ? (int) ( $defaults['segment_size'] ?? ( 64 * 1024 * 1024 ) ) : (int) $segment_size;
		$num_segments   = '' === $num_segments ? (int) ( $defaults['num_segments'] ?? 4 ) : (int) $num_segments;
		$num_partitions = '' === $num_partitions ? (int) ( $defaults['num_partitions'] ?? 1 ) : (int) $num_partitions;

		$num_logs    = (int) \apply_filters( 'newspack_nodes/num_logs', 0 );
		$total_bytes = $segment_size * $num_segments * $num_partitions * $num_logs;
		$total_mb    = \round( $total_bytes / ( 1024 * 1024 ) );
		$total_gb    = \round( $total_bytes / ( 1024 * 1024 * 1024 ), 2 );
		$segment_mb  = \round( $segment_size / ( 1024 * 1024 ) );

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
			/* translators: 1: segment size in MB, 2: number of segments, 3: number of partitions, 4: number of logs */
			\esc_html__( 'Calculated as: %1$s MB segment × %2$s segments × %3$s partitions × %4$s logs', 'newspack-nodes' ),
			\esc_html( (string) $segment_mb ),
			\esc_html( (string) $num_segments ),
			\esc_html( (string) $num_partitions ),
			\esc_html( (string) $num_logs )
		);
		?>
		</p>
		<?php
	}

	/**
	 * Reset-to-defaults handler — admin-post target.
	 *
	 * Nonce + permission checks before deleting any options. Allows extensions
	 * to extend the reset list via the `newspack_nodes/reset_options` filter.
	 */
	public function handle_reset_settings(): void {
		// phpcs:ignore WordPress.Security.ValidatedSanitizedInput.InputNotSanitized
		$nonce = isset( $_POST[ self::RESET_NONCE ] ) ? \sanitize_text_field( \wp_unslash( $_POST[ self::RESET_NONCE ] ) ) : '';
		if ( '' === $nonce || ! \wp_verify_nonce( $nonce, self::RESET_ACTION ) ) {
			\wp_die( \esc_html__( 'Security check failed.', 'newspack-nodes' ) );
		}
		if ( ! self::current_user_allowed() ) {
			\wp_die( \esc_html__( 'You do not have permission to perform this action.', 'newspack-nodes' ) );
		}

		$options = self::$option_names;
		if ( \function_exists( 'apply_filters' ) ) {
			$filtered = \apply_filters( 'newspack_nodes/reset_options', $options );
			if ( \is_array( $filtered ) ) {
				$options = $filtered;
			}
		}
		foreach ( $options as $option ) {
			if ( \is_string( $option ) && \str_starts_with( $option, self::OPTION_PREFIX ) ) {
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
	 * Per-option granular worker-restart on save.
	 *
	 * Workers pick up restart requests on their next graceful exit point
	 * (segment-close in WorkerBase). Categories — for substrate options:
	 *
	 *  supervisor_only_options:  the supervisor refreshes config each loop;
	 *                            no worker restart needed.
	 *  all_workers_options:      base directory / segment layout changes —
	 *                            every worker must rebuild file handles.
	 *  request_workers_options:  memcache topology — only the request-side
	 *                            workers (which read/write memcache stats)
	 *                            need to restart.
	 *
	 * Default substrate worker groups: `request-workers` + `job-workers`.
	 * Application plugins can extend the set via the
	 * `newspack_nodes/worker_restart_groups` filter.
	 *
	 * @param string $option Option name (full WP option key).
	 */
	public function maybe_request_worker_restart( string $option ): void {
		if ( ! \str_starts_with( $option, self::OPTION_PREFIX ) ) {
			return;
		}

		// Reset cached config so this process sees the new value if it reads
		// later in the same request.
		Config::reset();

		$short = \substr( $option, \strlen( self::OPTION_PREFIX ) );

		// Supervisor-only options (it refreshes config each loop).
		$supervisor_only_options = [
			'num_partitions',
		];
		if ( \in_array( $short, $supervisor_only_options, true ) ) {
			return;
		}

		// All workers (request + job) need restart.
		$all_workers_options = [
			'base_directory',
			'num_segments',
			'segment_size',
			'max_lifespan',
		];

		// Request-side workers only.
		$request_workers_options = [
			'memcache_servers',
		];

		$worker_groups = [];
		if ( \in_array( $short, $all_workers_options, true ) ) {
			$worker_groups = [ 'request-workers', 'job-workers' ];
		} elseif ( \in_array( $short, $request_workers_options, true ) ) {
			$worker_groups = [ 'request-workers' ];
		}

		// Allow extensions to extend the restart map for options they own.
		// Filter receives [ option_short_name => [ group1, group2, ... ] ] and
		// returns a (possibly extended) array of groups to restart.
		if ( \function_exists( 'apply_filters' ) ) {
			$filtered = \apply_filters( 'newspack_nodes/worker_restart_groups', $worker_groups, $short );
			if ( \is_array( $filtered ) ) {
				$worker_groups = \array_values( \array_unique( \array_filter( $filtered, 'is_string' ) ) );
			}
		}

		if ( empty( $worker_groups ) ) {
			return;
		}

		try {
			$config         = Config::load_config( 'full' );
			$locks_dir      = Config::get_locks_directory();
			$num_partitions = (int) ( $config['num_partitions'] ?? 1 );
		} catch ( \Throwable $e ) {
			// Locks dir not creatable, base dir misconfigured, etc. Best-effort:
			// the next supervisor pass will pick up the new config.
			return;
		}

		// Touch the restart flag file inside each affected lock dir. The lock
		// holder polls should_restart() from its drain loop and exits cleanly
		// at the next tick. No-op if the dir doesn't exist (worker was never
		// started, or dir was cleaned up after a deploy).
		for ( $p = 0; $p < $num_partitions; $p++ ) {
			foreach ( $worker_groups as $group ) {
				$lock_dir = "{$locks_dir}/{$group}.p{$p}.lock.d";
				Lock::request_restart_at( $lock_dir );
			}
		}
	}

	// -- Private renderers --------------------------------------------------

	private function render_directory_field( string $field, string $default, string $description ): void {
		$value = \get_option( self::OPTION_PREFIX . $field, '' );
		?>
		<div style="display: flex; align-items: flex-start; gap: 10px;">
			<div style="flex: 1;">
				<input type="text" id="<?php echo \esc_attr( $field ); ?>"
					name="<?php echo \esc_attr( self::OPTION_PREFIX . $field ); ?>"
					value="<?php echo \esc_attr( $value ); ?>"
					class="regular-text code"
					placeholder="<?php echo \esc_attr( $default ); ?>" />
				<p class="description">
					<?php echo \esc_html( $description ); ?>
					(<?php \esc_html_e( 'default', 'newspack-nodes' ); ?>: <?php echo \esc_html( $default ); ?>)
				</p>
			</div>
			<button type="button" class="button button-secondary newspack-nodes-reset-text"
				data-field="<?php echo \esc_attr( $field ); ?>" data-default=""
				title="<?php \esc_attr_e( 'Reset to default', 'newspack-nodes' ); ?>">↺</button>
		</div>
		<?php
	}

	private function render_number_field( string $field, int $default, int $min, int $max, string $description ): void {
		$value = \get_option( self::OPTION_PREFIX . $field, '' );
		// Show empty (with placeholder) if not set or equals default.
		$display_value = ( '' === $value || (int) $value === $default ) ? '' : $value;
		$input_class   = $max > 999 ? 'regular-text' : 'small-text';
		?>
		<div style="display: flex; align-items: flex-start; gap: 10px;">
			<div style="flex: 1;">
				<input type="number" id="<?php echo \esc_attr( $field ); ?>"
					name="<?php echo \esc_attr( self::OPTION_PREFIX . $field ); ?>"
					value="<?php echo \esc_attr( $display_value ); ?>"
					min="<?php echo \esc_attr( (string) $min ); ?>"
					max="<?php echo \esc_attr( (string) $max ); ?>"
					class="<?php echo \esc_attr( $input_class ); ?>"
					placeholder="<?php echo \esc_attr( (string) $default ); ?>" />
				<p class="description"><?php echo \esc_html( $description ); ?></p>
			</div>
			<button type="button" class="button button-secondary newspack-nodes-reset-number"
				data-newspack-nodes-reset-target="<?php echo \esc_attr( $field ); ?>"
				title="<?php \esc_attr_e( 'Clear (use default from config file)', 'newspack-nodes' ); ?>">↺</button>
		</div>
		<?php
	}

	/**
	 * Inline `↺` reset handler. The button clears the bound input so the
	 * placeholder (which renders the file default) shows through. Storing
	 * empty triggers `skip_default_writes` on save → option row deleted →
	 * next read picks up the file default.
	 *
	 * Lives here (not enqueued) because it's a 10-line behavior that only
	 * runs on the settings page and doesn't justify a separate asset.
	 */
	public function render_reset_button_handler(): void {
		?>
		<script>(function () {
			document.querySelectorAll( 'button[data-newspack-nodes-reset-target]' ).forEach( function ( btn ) {
				btn.addEventListener( 'click', function () {
					var id = btn.getAttribute( 'data-newspack-nodes-reset-target' );
					var el = document.getElementById( id );
					if ( el ) {
						el.value = '';
						el.dispatchEvent( new Event( 'input', { bubbles: true } ) );
					}
				} );
			} );
		})();</script>
		<?php
	}
}
