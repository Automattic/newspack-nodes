<?php
/**
 * One-time copy of the legacy event-logger aggregator-servers option into the
 * substrate Vault option. Ciphertext is portable (same wp_salt('auth') key),
 * so this is a value copy, not a re-encrypt. The source option is left intact.
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes;

\defined( 'ABSPATH' ) || exit;

class Vault_Migration {

	private const LEGACY_OPTION = 'newspack_event_logger_nodes_aggregator_servers';
	private const MARKER        = 'newspack_nodes_vault_migrated';

	/**
	 * Copy the legacy option into the Vault option once. Guarded by a marker
	 * option so it runs at most once; never clobbers an existing Vault.
	 *
	 * @api
	 */
	public static function maybe_migrate(): void {
		if ( ! empty( \get_option( self::MARKER ) ) ) {
			return;
		}
		if ( false !== \get_option( Vault::OPTION_KEY, false ) ) {
			\update_option( self::MARKER, '1', false );
			return;
		}
		$legacy = \get_option( self::LEGACY_OPTION, null );
		if ( \is_array( $legacy ) && ! empty( $legacy ) ) {
			\update_option( Vault::OPTION_KEY, $legacy, false );
		}
		\update_option( self::MARKER, '1', false );
	}
}
