<?php
/**
 * Caps_CLI_Command: `wp nodes caps <status|install|uninstall>` and
 * `wp nodes hub-user <login>`.
 *
 * The operator half of `Roles`, in the order an operator runs them. `install`
 * swaps the capability map off `manage_options` onto three real capabilities,
 * granting all three to every role that already holds `manage_options` so
 * nobody loses what they could already do; `hub-user` then creates the
 * dedicated least-privilege user the log aggregator authenticates as, so its
 * application password cannot restart the fleet or read the vault. The
 * reverse order is refused: before the swap, the hub role still resolves to
 * `manage_options` and the credential would hold everything.
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes;

\defined( 'ABSPATH' ) || exit;

/**
 * The two operator verbs over `Roles`.
 */
class Caps_CLI_Command {

	/**
	 * Report or change the substrate's capability model.
	 *
	 * `status` prints which WP capability each role resolves to. `install`
	 * moves the three roles off `manage_options` onto real capabilities,
	 * granting them to every role that already holds `manage_options` and
	 * creating the `newspack_nodes_hub` role (read + tune). `uninstall`
	 * reverses both. Every action ends by printing the resulting map, so an
	 * install shows what it left behind; any other word is refused rather
	 * than reported as status, because a typo must not read as the ask.
	 *
	 * ## OPTIONS
	 *
	 * [<action>]
	 * : status (default), install, or uninstall.
	 *
	 * ## EXAMPLES
	 *
	 *     wp nodes caps
	 *     wp nodes caps install
	 *     wp nodes caps uninstall
	 *
	 * @when after_wp_load
	 *
	 * @param array<int,string>   $args       Positional arguments.
	 * @param array<string,mixed> $assoc_args Associative arguments.
	 */
	public function caps( array $args, array $assoc_args ): void {
		$action = $args[0] ?? 'status';

		if ( 'install' === $action ) {
			Roles::install();
			\WP_CLI::success( 'Granular capabilities installed; administrators keep everything they had.' );
		} elseif ( 'uninstall' === $action ) {
			Roles::uninstall();
			\WP_CLI::success( 'Reverted to manage_options for all three roles.' );
		} elseif ( 'status' !== $action ) {
			\WP_CLI::error( 'Usage: wp nodes caps <status|install|uninstall>' );
		}

		$rows = [];
		foreach ( [ Capabilities::READ, Capabilities::TUNE, Capabilities::MANAGE ] as $role ) {
			$rows[] = [
				'role'       => $role,
				'capability' => Capabilities::cap_for( $role ),
			];
		}
		\WP_CLI::line( 'granular: ' . ( Roles::granular() ? 'yes' : 'no' ) );
		\WP_CLI\Utils\format_items( 'table', $rows, [ 'role', 'capability' ] );
	}

	/**
	 * Create (or re-role) the dedicated aggregator user and issue it an
	 * application password.
	 *
	 * Refused until `wp nodes caps install` has run, since the hub role
	 * resolves to `manage_options` until then. An existing user is converted
	 * rather than added to: its other roles are removed.
	 *
	 * The password is printed ONCE and never stored here — copy it into the
	 * hub's Vault entry for this spoke. The user holds read + tune and nothing
	 * else, so this credential is permanent by design: the link is permanent,
	 * and rotating it buys nothing once the privilege is right.
	 *
	 * ## OPTIONS
	 *
	 * <login>
	 * : Username to create or convert.
	 *
	 * [--email=<email>]
	 * : Email for a newly created user. Defaults to <login>@<site host>.
	 *
	 * [--name=<name>]
	 * : Label for the application password. Defaults to "newspack-nodes hub".
	 *
	 * [--no-password]
	 * : Create/convert the user but do not issue an application password.
	 *
	 * ## EXAMPLES
	 *
	 *     wp nodes hub-user newspack-nodes-hub
	 *
	 * @when after_wp_load
	 *
	 * @param array<int,string>   $args       Positional arguments.
	 * @param array<string,mixed> $assoc_args Associative arguments.
	 */
	public function hub_user( array $args, array $assoc_args ): void {
		$login = Core::as_string( $args[0] ?? '' );
		if ( '' === $login ) {
			\WP_CLI::error( 'Usage: wp nodes hub-user <login> [--email=<email>]' );
		}
		if ( ! Roles::granular() ) {
			\WP_CLI::error( 'Run `wp nodes caps install` first — without it the hub role resolves to manage_options and grants nothing narrower.' );
		}

		$user = \get_user_by( 'login', $login );
		if ( false === $user ) {
			$email = Core::as_string( $assoc_args['email'] ?? null, '' );
			if ( '' === $email ) {
				$email = $login . '@' . Core::as_string( \wp_parse_url( \home_url(), \PHP_URL_HOST ), 'localhost' );
			}
			$id    = \wp_insert_user(
				[
					'user_login' => $login,
					'user_email' => $email,
					'user_pass'  => \wp_generate_password( 32, true, true ),
					'role'       => Roles::HUB_ROLE,
				]
			);
			if ( \is_wp_error( $id ) ) {
				\WP_CLI::error( 'Could not create the user: ' . $id->get_error_message() );
				return;
			}
			$user = \get_user_by( 'id', $id );
			if ( false === $user ) {
				\WP_CLI::error( "Created {$login} but could not read it back." );
				return;
			}
			\WP_CLI::success( "Created {$login} with the " . Roles::HUB_ROLE . ' role.' );
		} else {
			// Sole role: an aggregator that also edits isn't least-privilege.
			$user->set_role( Roles::HUB_ROLE );
			\WP_CLI::success( "Set {$login} to the " . Roles::HUB_ROLE . ' role (previous roles removed).' );
		}

		if ( isset( $assoc_args['no-password'] ) ) {
			return;
		}
		if ( ! \class_exists( '\WP_Application_Passwords' ) ) {
			\WP_CLI::warning( 'Application passwords are unavailable on this install; create the credential by hand.' );
			return;
		}
		$label  = Core::as_string( $assoc_args['name'] ?? null, '' );
		if ( '' === $label ) {
			$label = 'newspack-nodes hub';
		}
		$issued = \WP_Application_Passwords::create_new_application_password( $user->ID, [ 'name' => $label ] );
		if ( \is_wp_error( $issued ) ) {
			\WP_CLI::error( 'Could not issue an application password: ' . $issued->get_error_message() );
			return;
		}
		\WP_CLI::line( '' );
		\WP_CLI::line( "user:     {$login}" );
		\WP_CLI::line( 'password: ' . Core::as_string( $issued[0] ) );
		\WP_CLI::line( '' );
		\WP_CLI::warning( 'Shown once. Store it in the hub Vault entry for this spoke.' );
	}
}
