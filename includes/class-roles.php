<?php
/**
 * Roles: the opt-in migration from `manage_options` to real capabilities.
 *
 * `Capabilities` cuts authority into read / tune / manage, but all three
 * default to `manage_options` — so on a stock install the cut is descriptive,
 * not enforced, and every caller is an administrator. A log aggregator that
 * only pulls a read-only stream from each spoke must therefore authenticate
 * with an ADMINISTRATOR's application password.
 *
 * Installing swaps the defaults to three real capabilities and grants all
 * three, in the same step, to every role that already holds `manage_options`,
 * so nobody who could do something before loses it. It also creates `newspack_nodes_hub`, a role
 * holding read + tune and nothing else — not even `read` in the WordPress
 * sense — which is what the aggregator's dedicated user wears. That user's
 * application password is then structurally incapable of restarting the fleet
 * or reading the vault, which is the point: the exposure is PRIVILEGE, not
 * credential lifetime, and a permanent link is right to hold a permanent
 * credential.
 *
 * Operators reach all of this through `wp nodes caps` and `wp nodes hub-user`.
 * It is reversible: `uninstall()` puts the map back and drops the role, and
 * `uninstall.php` calls it because these capabilities live in WordPress's own
 * roles option, which no `newspack_nodes_` option sweep touches.
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes;

\defined( 'ABSPATH' ) || exit;

/**
 * Installs, reverses and reports the granular capability migration.
 */
class Roles {

	/** The capability `Capabilities::READ` resolves to once installed. */
	public const CAP_READ = 'newspack_nodes_read';

	/** The capability `Capabilities::TUNE` resolves to once installed. */
	public const CAP_TUNE = 'newspack_nodes_tune';

	/** The capability `Capabilities::MANAGE` resolves to once installed. */
	public const CAP_MANAGE = 'newspack_nodes_manage';

	/** The dedicated aggregator role: read + tune, nothing else. */
	public const HUB_ROLE = 'newspack_nodes_hub';

	/** Autoloaded switch. Its presence IS the statement that the caps exist. */
	public const OPTION = 'newspack_nodes_granular_caps';

	/**
	 * The role-to-capability defaults `Capabilities::cap_for()` starts from,
	 * chosen by whether the migration is installed. A site filter still
	 * overrides them; this only moves the baseline.
	 *
	 * @return array<string,string>
	 */
	public static function defaults(): array {
		if ( ! self::granular() ) {
			return [
				Capabilities::READ   => 'manage_options',
				Capabilities::TUNE   => 'manage_options',
				Capabilities::MANAGE => 'manage_options',
			];
		}
		return [
			Capabilities::READ   => self::CAP_READ,
			Capabilities::TUNE   => self::CAP_TUNE,
			Capabilities::MANAGE => self::CAP_MANAGE,
		];
	}

	/** Whether the granular capabilities are installed and in force. */
	public static function granular(): bool {
		return (bool) \get_option( self::OPTION, false );
	}

	/**
	 * Grant the caps to every role that can already do this, create the hub
	 * role, then flip the switch. The ORDER is the whole safety property:
	 * flipping first refuses everyone for as long as the grant takes.
	 *
	 * "Every role that can already do this" is not just `administrator`. A
	 * site with a custom Ops role holding `manage_options` — or an editor
	 * granted it by another plugin — would otherwise lose the entire
	 * substrate in one step, which is the opposite of a non-breaking
	 * migration.
	 */
	public static function install(): void {
		foreach ( self::current_map() as $role_slug ) {
			$role = \get_role( $role_slug );
			if ( null === $role ) {
				continue;
			}
			foreach ( [ self::CAP_READ, self::CAP_TUNE, self::CAP_MANAGE ] as $cap ) {
				$role->add_cap( $cap );
			}
		}
		$caps = [
			self::CAP_READ => true,
			self::CAP_TUNE => true,
		];
		// VIP's wrapper reconciles an existing role; the fallback no-ops.
		if ( \function_exists( 'wpcom_vip_add_role' ) ) {
			\wpcom_vip_add_role( self::HUB_ROLE, 'Newspack Nodes Hub', $caps );
		} else {
			// phpcs:ignore WordPressVIPMinimum.Functions.RestrictedFunctions.custom_role_add_role -- the VIP wrapper is used above where it exists.
			\add_role( self::HUB_ROLE, 'Newspack Nodes Hub', $caps );
		}
		\update_option( self::OPTION, 1, true );
	}

	/**
	 * Role slugs that reach the substrate before the migration: every role the
	 * roles table shows holding `manage_options`, which is the one capability
	 * the un-migrated map resolves all three roles to. Administrator is
	 * included whether or not the roles table is readable, because it always
	 * holds it.
	 *
	 * @return list<string>
	 */
	public static function current_map(): array {
		$slugs = [ 'administrator' ];
		foreach ( self::role_table() as $slug => $definition ) {
			$caps = \is_array( $definition ) ? ( $definition['capabilities'] ?? [] ) : [];
			if ( \is_array( $caps ) && ! empty( $caps['manage_options'] ) && ! \in_array( $slug, $slugs, true ) ) {
				$slugs[] = $slug;
			}
		}
		return $slugs;
	}

	/**
	 * Undo install(): drop the option first, so the map is back on
	 * `manage_options` before the capabilities it named disappear — the
	 * reverse order opens a window where every caller is refused. The sweep
	 * then covers every declared role rather than the ones install() granted,
	 * because the roles table can have changed in between and removing a
	 * capability a role never held costs nothing.
	 */
	public static function uninstall(): void {
		\delete_option( self::OPTION );
		foreach ( self::all_role_slugs() as $role_slug ) {
			$role = \get_role( $role_slug );
			if ( null === $role ) {
				continue;
			}
			foreach ( [ self::CAP_READ, self::CAP_TUNE, self::CAP_MANAGE ] as $cap ) {
				$role->remove_cap( $cap );
			}
		}
		\remove_role( self::HUB_ROLE );
	}

	/**
	 * Every declared role slug, with `administrator` always among them so a
	 * site whose roles table is unreadable still gets its grant reversed.
	 *
	 * @return list<string>
	 */
	private static function all_role_slugs(): array {
		$slugs = \array_keys( self::role_table() );
		return \in_array( 'administrator', $slugs, true ) ? $slugs : [ 'administrator', ...$slugs ];
	}

	/**
	 * The WP roles table, keyed by slug. `$wp_roles` is untyped global state,
	 * so this is where the coercion happens once rather than at each read. An
	 * absent or malformed global yields an empty table, which leaves both
	 * callers holding `administrator` alone.
	 *
	 * @return array<string,mixed>
	 */
	private static function role_table(): array {
		$roles = $GLOBALS['wp_roles'] ?? null;
		if ( ! \is_object( $roles ) || ! isset( $roles->roles ) || ! \is_array( $roles->roles ) ) {
			return [];
		}
		$out = [];
		foreach ( $roles->roles as $slug => $definition ) {
			$out[ (string) $slug ] = $definition;
		}
		return $out;
	}
}
