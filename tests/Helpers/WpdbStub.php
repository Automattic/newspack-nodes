<?php
/**
 * The `\wpdb` a suite with no WordPress stands in for core's: the class
 * `Sqlite_Wpdb` extends, and a consumer suite requires beside it so its own
 * `$wpdb` can be one.
 *
 * `Cache_Backend::salt()` reads the option row through $wpdb, not
 * get_option(), because bin/pyrate runs under SHORTINIT where the option API
 * is stubbed; the harness needs a real `\wpdb` for that branch to be
 * reachable at all.
 *
 * @package Newspack_Nodes\Tests
 */

if ( ! \class_exists( 'wpdb', false ) ) {
	class wpdb {
		public string $prefix      = 'wp_';
		public string $base_prefix = 'wp_';
		public string $options     = 'wp_options';

		/** @var array<string,string> option_name => option_value */
		public array $rows = [];

		public function prepare( string $query, mixed ...$args ): string {
			return $query . '|' . \implode( '|', \array_map( 'strval', $args ) );
		}

		public function get_var( string $prepared ): ?string {
			$name = (string) ( \explode( '|', $prepared )[2] ?? '' );
			return $this->rows[ $name ] ?? null;
		}
	}
}
