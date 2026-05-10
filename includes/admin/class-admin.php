<?php
/**
 * Admin: substrate-side WP-Settings-API surface.
 *
 * Owns ONLY the substrate-level options:
 *   - enable_workers
 *   - base_directory
 *   - num_partitions
 *   - num_segments
 *   - segment_size
 *   - max_lifespan
 *   - memcache_servers
 *   - aggregator_servers
 *
 * Application-level options (logging toggles, URL filters, hook lists, etc.)
 * live in the application plugin's own Admin class. The application Admin
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
		'newspack_nodes_enable_workers',
		'newspack_nodes_base_directory',
		'newspack_nodes_num_partitions',
		'newspack_nodes_num_segments',
		'newspack_nodes_segment_size',
		'newspack_nodes_max_lifespan',
		'newspack_nodes_memcache_servers',
		'newspack_nodes_aggregator_servers',
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

	public function __construct() {
		\add_action( 'admin_menu', [ $this, 'add_admin_menu' ] );
		\add_action( 'admin_init', [ $this, 'register_settings' ] );
		\add_action( 'admin_post_' . self::RESET_ACTION, [ $this, 'handle_reset_settings' ] );

		// Per-option granular worker-restart on save. Both `added_option` (first
		// save) and `updated_option` (subsequent saves) fire this so newly-added
		// options trigger the right restart class too.
		\add_action( 'updated_option', [ $this, 'maybe_request_worker_restart' ], 10, 1 );
		\add_action( 'added_option', [ $this, 'maybe_request_worker_restart' ], 10, 1 );
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
		// Boolean toggle.
		\register_setting(
			self::OPTIONS_GROUP,
			'newspack_nodes_enable_workers',
			[ 'sanitize_callback' => 'absint' ]
		);

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

		// Aggregator-server list (typed array). Not autoloaded.
		\register_setting(
			self::OPTIONS_GROUP,
			'newspack_nodes_aggregator_servers',
			[
				'sanitize_callback' => [ $this, 'sanitize_aggregator_servers' ],
				'autoload'          => false,
			]
		);

		// General section.
		\add_settings_section(
			'newspack_nodes_general_section',
			\__( 'General', 'newspack-nodes' ),
			[ $this, 'general_section_callback' ],
			self::SETTINGS_PAGE
		);
		\add_settings_field(
			'enable_workers',
			\__( 'Enable Workers', 'newspack-nodes' ),
			[ $this, 'enable_workers_callback' ],
			self::SETTINGS_PAGE,
			'newspack_nodes_general_section'
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
	 * Sanitize the `aggregator_servers` option.
	 *
	 * Stored as `[ server_id => [ url, auth_username, auth_password, enabled ] ]`.
	 * URL must be HTTPS. Non-array input becomes an empty array.
	 *
	 * @param mixed $value Aggregator-servers map.
	 * @return array<string,array<string,mixed>> Sanitized map.
	 */
	public function sanitize_aggregator_servers( $value ): array {
		if ( ! \is_array( $value ) ) {
			return [];
		}
		$result = [];
		foreach ( $value as $server_id => $config ) {
			if ( ! \is_array( $config ) ) {
				continue;
			}
			$server_id = \sanitize_text_field( (string) $server_id );
			if ( '' === $server_id ) {
				continue;
			}
			$url = $config['url'] ?? '';
			if ( ! \is_string( $url ) || 0 !== \strpos( $url, 'https://' ) ) {
				continue;
			}
			$result[ $server_id ] = [
				'url'           => \esc_url_raw( $url ),
				'auth_username' => \sanitize_text_field( (string) ( $config['auth_username'] ?? '' ) ),
				'auth_password' => \sanitize_text_field( (string) ( $config['auth_password'] ?? '' ) ),
				'enabled'       => (bool) ( $config['enabled'] ?? true ),
			];
		}
		return $result;
	}

	// -- Section callbacks --------------------------------------------------

	public function general_section_callback(): void {
		echo '<p>' . \esc_html__( 'Substrate runtime toggles. Disabling workers stops the supervisor from spawning new workers; existing workers exit at their next graceful checkpoint.', 'newspack-nodes' ) . '</p>';
	}

	public function storage_section_callback(): void {
		echo '<p>' . \esc_html__( 'Configure log storage and memcache infrastructure. Changing storage layout (base directory, segment size, retention) restarts every worker.', 'newspack-nodes' ) . '</p>';
	}

	// -- Field callbacks ----------------------------------------------------

	public function enable_workers_callback(): void {
		$config  = Config::load_config( 'full' );
		$enabled = \get_option( 'newspack_nodes_enable_workers', $config['enable_workers'] ?? 1 );
		?>
		<input type="hidden" name="newspack_nodes_enable_workers" value="0" />
		<input type="checkbox" id="enable_workers" name="newspack_nodes_enable_workers" value="1" <?php \checked( 1, $enabled ); ?> />
		<label for="enable_workers"><?php \esc_html_e( 'Enable supervisor / worker fleet for this node.', 'newspack-nodes' ); ?></label>
		<?php
	}

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
			'enable_workers',
			'aggregator_servers',
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
				data-field="<?php echo \esc_attr( $field ); ?>"
				title="<?php \esc_attr_e( 'Clear (use default)', 'newspack-nodes' ); ?>">↺</button>
		</div>
		<?php
	}
}
