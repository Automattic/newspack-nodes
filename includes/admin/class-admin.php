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
use Newspack_Nodes\Lock_Node;

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

	/**
	 * Substrate option names cleared by handle_reset_settings(); extend via the reset_options filter.
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

	/** Top-level menu slug for the topology console (its own admin entry, not under Settings). */
	public const TOPOLOGY_MENU_SLUG = 'newspack-nodes-topology';
	public const WORKERS_MENU_SLUG  = 'newspack-nodes-workers';
	public const RAWLOGS_MENU_SLUG  = 'newspack-nodes-rawlogs';

	public function __construct() {
		\add_action( 'admin_menu', [ $this, 'add_admin_menu' ] );
		\add_action( 'admin_menu', [ $this, 'register_topology_admin_page' ] );
		\add_action( 'admin_menu', [ $this, 'register_event_dashboard_pages' ], 11 );
		\add_action( 'admin_init', [ $this, 'register_settings' ] );
		\add_action( 'admin_post_' . self::RESET_ACTION, [ $this, 'handle_reset_settings' ] );
		\add_action( 'admin_enqueue_scripts', [ $this, 'enqueue_topology_console_assets' ] );
		\add_action( 'admin_enqueue_scripts', [ $this, 'enqueue_event_dashboards_assets' ] );

		// Both hooks so first + subsequent saves restart correctly.
		\add_action( 'updated_option', [ $this, 'maybe_request_worker_restart' ], 10, 1 );
		\add_action( 'added_option', [ $this, 'maybe_request_worker_restart' ], 10, 1 );
	}

	/**
	 * Register the Topology Console as a top-level admin menu (renders the React mount div).
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
	 * Register Workers + Raw Logs as submenus under "Nodes" (priority 11 so they follow Topology).
	 */
	public function register_event_dashboard_pages(): void {
		if ( ! self::current_user_allowed() ) {
			return;
		}
		if ( ! \function_exists( 'add_submenu_page' ) ) {
			return;
		}
		\add_submenu_page(
			self::TOPOLOGY_MENU_SLUG,
			\__( 'Workers', 'newspack-nodes' ),
			\__( 'Workers', 'newspack-nodes' ),
			'manage_options',
			self::WORKERS_MENU_SLUG,
			static fn () => print( '<div id="newspack-nodes-workers" class="newspack-nodes-workers-page"></div>' )
		);
		\add_submenu_page(
			self::TOPOLOGY_MENU_SLUG,
			\__( 'Raw Logs', 'newspack-nodes' ),
			\__( 'Raw Logs', 'newspack-nodes' ),
			'manage_options',
			self::RAWLOGS_MENU_SLUG,
			static fn () => print( '<div id="newspack-nodes-rawlogs" class="newspack-nodes-rawlogs-page"></div>' )
		);
	}

	/**
	 * Enqueue the event-dashboards bundle on the Workers / Raw Logs pages.
	 */
	public function enqueue_event_dashboards_assets( string $hook = '' ): void {
		if ( ! \function_exists( 'wp_enqueue_script' ) ) {
			return;
		}
		// phpcs:ignore WordPress.Security.NonceVerification.Recommended
		$page = isset( $_GET['page'] ) && \is_string( $_GET['page'] ) ? \sanitize_text_field( \wp_unslash( $_GET['page'] ) ) : '';
		if ( self::WORKERS_MENU_SLUG !== $page && self::RAWLOGS_MENU_SLUG !== $page ) {
			return;
		}
		$asset_path = \NEWSPACK_NODES_DIR . 'build/event-dashboards/index.js';
		$asset_url  = ( \defined( 'NEWSPACK_NODES_URL' ) ? \NEWSPACK_NODES_URL : '' ) . 'build/event-dashboards/index.js';
		if ( ! \file_exists( $asset_path ) ) {
			return;
		}
		$handle  = 'newspack-nodes-event-dashboards';
		$version = (string) ( \filemtime( $asset_path ) ?: \NEWSPACK_NODES_VERSION );
		$deps    = [ 'wp-element', 'wp-components', 'wp-api-fetch', 'wp-i18n' ];
		\wp_enqueue_script( $handle, $asset_url, $deps, $version, true );

		$css_path = \NEWSPACK_NODES_DIR . 'build/event-dashboards/index.css';
		$css_url  = ( \defined( 'NEWSPACK_NODES_URL' ) ? \NEWSPACK_NODES_URL : '' ) . 'build/event-dashboards/index.css';
		if ( \file_exists( $css_path ) ) {
			$css_version = (string) ( \filemtime( $css_path ) ?: \NEWSPACK_NODES_VERSION );
			\wp_enqueue_style( $handle, $css_url, [ 'wp-components' ], $css_version );
		}

		// REST root + nonce for the shared CommandClient.
		$rest_url = \function_exists( 'rest_url' ) ? \rest_url() : '/wp-json/';
		$nonce    = \function_exists( 'wp_create_nonce' ) ? \wp_create_nonce( 'wp_rest' ) : '';
		\wp_localize_script(
			$handle,
			'NewspackNodesData',
			[
				'restUrl' => $rest_url,
				'nonce'   => $nonce,
				'tree'    => 'event-dashboards',
				'version' => \NEWSPACK_NODES_VERSION,
			]
		);
	}

	/**
	 * Render the topology console mount element.
	 */
	public function render_topology_page(): void {
		if ( ! self::current_user_allowed() ) {
			\wp_die( \esc_html__( 'You do not have permission to access this page.', 'newspack-nodes' ) );
		}
		echo '<div id="newspack-nodes-topology-console" class="newspack-nodes-topology-console-page"></div>';
	}

	/**
	 * Enqueue the topology-console bundle on its admin page.
	 */
	public function enqueue_topology_console_assets( string $hook = '' ): void {
		if ( ! \function_exists( 'wp_enqueue_script' ) ) {
			return;
		}
		// phpcs:ignore WordPress.Security.NonceVerification.Recommended
		$page = isset( $_GET['page'] ) && \is_string( $_GET['page'] ) ? \sanitize_text_field( \wp_unslash( $_GET['page'] ) ) : '';
		if ( self::TOPOLOGY_MENU_SLUG !== $page ) {
			return;
		}
		$asset_path = \NEWSPACK_NODES_DIR . 'build/topology-console/index.js';
		$asset_url  = ( \defined( 'NEWSPACK_NODES_URL' ) ? \NEWSPACK_NODES_URL : '' ) . 'build/topology-console/index.js';
		if ( ! \file_exists( $asset_path ) ) {
			return;
		}
		$handle  = 'newspack-nodes-topology-console';
		$version = (string) ( \filemtime( $asset_path ) ?: \NEWSPACK_NODES_VERSION );
		$deps    = [ 'wp-element', 'wp-components', 'wp-api-fetch', 'wp-i18n' ];
		\wp_enqueue_script( $handle, $asset_url, $deps, $version, true );

		$css_path = \NEWSPACK_NODES_DIR . 'build/topology-console/index.css';
		$css_url  = ( \defined( 'NEWSPACK_NODES_URL' ) ? \NEWSPACK_NODES_URL : '' ) . 'build/topology-console/index.css';
		if ( \file_exists( $css_path ) ) {
			$css_version = (string) ( \filemtime( $css_path ) ?: \NEWSPACK_NODES_VERSION );
			\wp_enqueue_style( $handle, $css_url, [ 'wp-components' ], $css_version );
		}

		// Per-topology partition counts for the React dropdown: catalog count, else synthesized frontmatter.
		$topology_partitions = [];
		$catalog             = Bootstrap::get_topology_catalog();
		$config_np           = Config::load_config()['num_partitions'] ?? 1;
		$default_np          = (int) ( \is_scalar( $config_np ) ? $config_np : 1 );
		foreach ( \Newspack_Nodes\Topology_Registry::list() as $name ) {
			if ( '' === $name ) {
				continue;
			}
			$catalog_entry = $catalog[ $name ] ?? null;
			if ( \is_array( $catalog_entry ) && isset( $catalog_entry['num_partitions'] ) && \is_scalar( $catalog_entry['num_partitions'] ) ) {
				$topology_partitions[ $name ] = (int) $catalog_entry['num_partitions'];
				continue;
			}
			$synth = \Newspack_Nodes\Topology_Registry::synthesize_entry( $name, $default_np, Lock_Node::STALE_TIMEOUT );
			if ( null !== $synth && isset( $synth['num_partitions'] ) && \is_scalar( $synth['num_partitions'] ) ) {
				$topology_partitions[ $name ] = (int) $synth['num_partitions'];
			}
		}
		\ksort( $topology_partitions );

		// Active topologies (catalog + operator overlay) the supervisor would spawn.
		$active_topologies = \array_keys( Bootstrap::get_topologies() );
		\sort( $active_topologies );

		// REST root + nonce for apiFetch.
		$rest_url = \function_exists( 'rest_url' ) ? \rest_url() : '/wp-json/';
		$nonce    = \function_exists( 'wp_create_nonce' ) ? \wp_create_nonce( 'wp_rest' ) : '';
		\wp_localize_script(
			$handle,
			'NewspackNodesData',
			[
				'restUrl'             => $rest_url,
				'nonce'               => $nonce,
				'tree'                => 'topology-console',
				'version'             => \NEWSPACK_NODES_VERSION,
				'topologyPartitions'  => $topology_partitions,
				'activeTopologies'    => $active_topologies,
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
			$this->render_reset_button_handler();
			?>
		</div>
		<?php
	}

	/**
	 * Register every substrate option + the Storage and Topologies sections.
	 */
	public function register_settings(): void {
		// Path: no null bytes, no `..`, must be absolute, trailing slash stripped.
		\register_setting(
			self::OPTIONS_GROUP,
			'newspack_nodes_base_directory',
			[
				'sanitize_callback' => function ( $value ) {
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
				},
			]
		);

		// Integers — empty string = "use default".
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

		// Newline-separated host:port list. Not autoloaded (read by workers).
		\register_setting(
			self::OPTIONS_GROUP,
			'newspack_nodes_memcache_servers',
			[
				'type'              => 'array',
				'default'           => [],
				'sanitize_callback' => [ $this, 'sanitize_memcache_servers' ],
				'autoload'          => false,
			]
		);

		// Flat list of active TSL topology names; sanitizer drops names that don't resolve.
		\register_setting(
			self::OPTIONS_GROUP,
			'newspack_nodes_topologies',
			[
				'sanitize_callback' => [ $this, 'sanitize_topologies' ],
				'autoload'          => true,
			]
		);

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

		// Topologies section — checkbox list; toggling changes the `topologies` option.
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
	public function sanitize_memcache_servers( $value ): array {
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
	 * Sanitize the active-topologies list, dropping entries that don't resolve via Topology_Registry.
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
	 * Render a checkbox per known topology, from Topology_Registry::list().
	 */
	public function topologies_callback(): void {
		$available = \Newspack_Nodes\Topology_Registry::list();
		\sort( $available );
		// "Defaults" = the config-file `topologies` value (newspack-nodes-config.php,
		// or a LOCAL_NEWSPACK_NODES_CONF override) — NOT the full catalog of every
		// registered .tsl. A deployment (docker-admin, docker-render, …) declares the
		// curated set it wants active; the ↺ button and the unset-option render must
		// honour that, not check everything.
		$defaults = (array) ( Config::load_config_defaults()['topologies'] ?? [] );
		\sort( $defaults );
		// Operator overlay precedence (mirrors Config::load_config): option false/unset
		// → config-file default; [] → none; array → exact.
		$option = \get_option( 'newspack_nodes_topologies', false );
		$active = false === $option
			? $defaults
			: ( \is_array( $option ) ? $option : [] );
		if ( empty( $available ) ) {
			echo '<p class="description">' . \esc_html__( 'No topologies registered. Application plugins must call Newspack_Nodes\\Topology_Registry::register_stock_dir() at load time.', 'newspack-nodes' ) . '</p>';
			return;
		}
		// Fieldset on the left, `↺` reset chip on the right.
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

	public function base_directory_callback(): void {
		$defaults = Config::load_config_defaults();
		$base     = $defaults['base_directory'] ?? '';
		$this->render_directory_field(
			'base_directory',
			\is_scalar( $base ) ? (string) $base : '',
			\__( 'Base directory for logs, locks, and offsets.', 'newspack-nodes' )
		);
	}

	public function num_partitions_callback(): void {
		$defaults = Config::load_config_defaults();
		$this->render_number_field(
			'num_partitions',
			self::default_int( $defaults, 'num_partitions', 1 ),
			1,
			16,
			\__( 'Number of log partitions for parallel processing.', 'newspack-nodes' )
		);
	}

	public function num_segments_callback(): void {
		$defaults = Config::load_config_defaults();
		$this->render_number_field(
			'num_segments',
			self::default_int( $defaults, 'num_segments', 4 ),
			2,
			32,
			\__( 'Number of segments to retain per partition.', 'newspack-nodes' )
		);
	}

	public function segment_size_callback(): void {
		$defaults = Config::load_config_defaults();
		$this->render_number_field(
			'segment_size',
			self::default_int( $defaults, 'segment_size', 64 * 1024 * 1024 ),
			1048576,
			536870912,
			\__( 'Maximum segment size in bytes.', 'newspack-nodes' )
		);
	}

	public function max_lifespan_callback(): void {
		$defaults = Config::load_config_defaults();
		$this->render_number_field(
			'max_lifespan',
			self::default_int( $defaults, 'max_lifespan', 86400 ),
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
		// Coerce each entry to string exactly as implode/esc_* already would.
		$default_servers = \array_map( static fn ( $server ): string => \is_scalar( $server ) ? (string) $server : '', $default_servers );
		$default_text    = \implode( "\n", $default_servers );
		// Stored as the typed array shape; coerce each entry to string exactly as $default_servers does.
		$value         = \get_option( 'newspack_nodes_memcache_servers', [] );
		$value         = \is_array( $value ) ? $value : [];
		$value         = \array_map( static fn ( $server ): string => \is_scalar( $server ) ? (string) $server : '', $value );
		$value         = \implode( "\n", $value );
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
				data-newspack-nodes-reset-target="memcache_servers"
				title="<?php \esc_attr_e( 'Reset to default', 'newspack-nodes' ); ?>">↺</button>
		</div>
		<?php
	}

	/**
	 * Total-storage field: segment_size × num_segments × num_partitions × num_logs.
	 */
	public function total_storage_callback(): void {
		$defaults       = Config::load_config_defaults();
		$segment_size   = \get_option( 'newspack_nodes_segment_size', '' );
		$num_segments   = \get_option( 'newspack_nodes_num_segments', '' );
		$num_partitions = \get_option( 'newspack_nodes_num_partitions', '' );

		// Use config defaults for empty values.
		$segment_size   = '' === $segment_size ? self::default_int( $defaults, 'segment_size', 64 * 1024 * 1024 ) : ( \is_scalar( $segment_size ) ? (int) $segment_size : 0 );
		$num_segments   = '' === $num_segments ? self::default_int( $defaults, 'num_segments', 4 ) : ( \is_scalar( $num_segments ) ? (int) $num_segments : 0 );
		$num_partitions = '' === $num_partitions ? self::default_int( $defaults, 'num_partitions', 1 ) : ( \is_scalar( $num_partitions ) ? (int) $num_partitions : 0 );

		// One log stream per `{base}/logs/*.log/` directory.
		$num_logs    = \count( \Newspack_Nodes\Log_Discovery::on_disk() );
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

		// Supervisor-only (it refreshes config each loop) — no worker restart needed.
		$supervisor_only_options = [
			'num_partitions',
		];
		if ( \in_array( $short, $supervisor_only_options, true ) ) {
			return;
		}

		$all_workers_options = [
			'base_directory',
			'num_segments',
			'segment_size',
			'max_lifespan',
		];

		$request_workers_options = [
			'memcache_servers',
		];

		$worker_groups = [];
		if ( \in_array( $short, $all_workers_options, true ) ) {
			$worker_groups = [ 'request-workers', 'job-workers' ];
		} elseif ( \in_array( $short, $request_workers_options, true ) ) {
			$worker_groups = [ 'request-workers' ];
		}

		// Let extensions extend the restart groups for options they own.
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
			$config         = Config::load_config();
			$locks_dir      = Config::get_locks_directory();
			$num_partitions = self::default_int( $config, 'num_partitions', 1 );
		} catch ( \Throwable $e ) {
			// Best-effort: the next supervisor pass picks up the new config.
			return;
		}

		// Touch the restart flag in each affected lock dir; the holder exits next tick.
		for ( $p = 0; $p < $num_partitions; $p++ ) {
			foreach ( $worker_groups as $group ) {
				$lock_dir = "{$locks_dir}/{$group}.p{$p}.lock.d";
				Lock_Node::request_restart_at( $lock_dir );
			}
		}
	}

	// -- Private renderers --------------------------------------------------

	private function render_directory_field( string $field, string $default, string $description ): void {
		$value = \get_option( self::OPTION_PREFIX . $field, '' );
		$value = \is_scalar( $value ) ? (string) $value : '';
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
				data-newspack-nodes-reset-target="<?php echo \esc_attr( $field ); ?>"
				title="<?php \esc_attr_e( 'Reset to default', 'newspack-nodes' ); ?>">↺</button>
		</div>
		<?php
	}

	private function render_number_field( string $field, int $default, int $min, int $max, string $description ): void {
		$value = \get_option( self::OPTION_PREFIX . $field, '' );
		$value = \is_scalar( $value ) ? (string) $value : '';
		// Show empty (placeholder) when unset or equal to default.
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
	 * Inline `↺` reset handler: clears the bound input so its placeholder (file default) shows.
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
