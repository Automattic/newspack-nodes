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
 * `hub-user` grants the two capabilities to the account directly and wears
 * the role on top of them only where the host carries it, so the credential
 * works on a managed host that permits no new roles. `caps` prints both
 * halves.
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
	 * Two lines head that map, because the migration has two halves and a
	 * host can accept one and refuse the other: `granular` is the capability
	 * swap, `hub role` is whether `newspack_nodes_hub` is actually there. An
	 * install that could not create it warns, naming the direct grants
	 * `hub-user` makes instead, so the absence reads as a supported
	 * deployment rather than a broken one.
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
			if ( ! Roles::hub_role_exists() ) {
				\WP_CLI::warning(
					'The ' . Roles::HUB_ROLE . ' role did not take — this host decides which roles may '
						. 'exist. Nothing is broken: `wp nodes hub-user` grants ' . Roles::CAP_READ
						. ' and ' . Roles::CAP_TUNE . ' to the aggregator user directly instead.'
				);
			}
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
		\WP_CLI::line( 'hub role: ' . ( Roles::hub_role_exists() ? 'present' : 'absent' ) );
		\WP_CLI\Utils\format_items( 'table', $rows, [ 'role', 'capability' ] );
	}

	/**
	 * Create (or re-role) the dedicated aggregator user and issue it an
	 * application password.
	 *
	 * Refused until `wp nodes caps install` has run, since the hub role
	 * resolves to `manage_options` until then.
	 *
	 * The two capabilities are granted DIRECTLY to the user, on every host,
	 * and that grant is the credential's authority: a user capability lives in
	 * that user's own meta and never consults `WP_Roles`, which is what
	 * `Capabilities::can()` reads — it resolves the role name to a capability
	 * and asks `current_user_can()`. The role is the self-documenting half,
	 * wearing the grant in wp-admin and revoking it in one place, so it is set
	 * only where `Roles::hub_role_exists()` says the host carries it. Where a
	 * host enforces its own role set, `set_role()` binds the account to a role
	 * `WP_User::get_role_caps()` filters straight back out, leaving it holding
	 * nothing and answering 401 on a credential that authenticates. Order is
	 * load-bearing: `set_role()` REPLACES the whole capability map, so a grant
	 * made ahead of it would be wiped. Where the role IS set, an existing user
	 * is converted rather than added to: its other roles are removed.
	 *
	 * It WARNS when the operator's `allowed_users` list is populated and does
	 * not name this login: that list narrows every role from inside
	 * `Capabilities::can()`, so the account would answer 401 on its first
	 * `/command` POST with nothing on the wire to say why. A warning rather
	 * than a refusal, since the list may be the operator's next edit.
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
		$verb = false === $user ? 'Created' : 'Converted';
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
		}
		// set_role() replaces the cap map, so the grants have to follow it.
		$wears_role = Roles::hub_role_exists();
		if ( $wears_role ) {
			$user->set_role( Roles::HUB_ROLE );
		}
		$user->add_cap( Roles::CAP_READ );
		$user->add_cap( Roles::CAP_TUNE );
		\WP_CLI::success(
			"{$verb} {$login}: " . Roles::CAP_READ . ' and ' . Roles::CAP_TUNE . ' granted directly'
				. ( $wears_role
					? ', under the ' . Roles::HUB_ROLE . ' role (previous roles removed).'
					: '; this host carries no ' . Roles::HUB_ROLE . ' role.' )
		);
		if ( Capabilities::operator_list_excludes( $login ) ) {
			\WP_CLI::warning(
				"The operator's allowed_users list does not name {$login}, so every request it "
					. "makes is refused at can( READ ) and answers 401. Add '{$login}' to "
					. 'allowed_users in newspack-nodes-config.php, or to the '
					. 'newspack_nodes_allowed_users option.'
			);
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
