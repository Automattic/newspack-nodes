<?php
/**
 * Wp_Includes: WordPress's own functions, loaded from the install
 * `WP_ABSPATH` names, for a test of code that calls them.
 *
 * The suite shims WordPress rather than loading it, and a whole
 * `wp-includes` file cannot load beside the shims: `rest-api.php` declares
 * `rest_url()` and `register_rest_route()`, which the shims already declare.
 * So this reads the named files, declares only the functions a caller asks
 * for, and then every function of those files they call, skipping any name
 * already declared, so a shim keeps winning where one exists.
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes\Tests\Helpers;

final class Wp_Includes {

	/** The files whose functions a request can reach, relative to wp-includes. */
	private const FILES = [ 'blocks.php', 'rest-api.php', 'functions.php', 'formatting.php', 'kses.php' ];

	/**
	 * The class files `parse_blocks()` instantiates, then those `wp_kses()`
	 * reads a link through, each in dependency order.
	 */
	private const CLASSES = [
		'class-wp-block-parser-block.php',
		'class-wp-block-parser-frame.php',
		'class-wp-block-parser.php',
		'class-wp-token-map.php',
		'html-api/html5-named-character-references.php',
		'html-api/class-wp-html-attribute-token.php',
		'html-api/class-wp-html-span.php',
		'html-api/class-wp-html-text-replacement.php',
		'html-api/class-wp-html-decoder.php',
		'html-api/class-wp-html-doctype-info.php',
		'html-api/class-wp-html-tag-processor.php',
	];

	/**
	 * Function name => its source, across FILES; null until first use.
	 *
	 * @var array<string,string>|null
	 */
	private static ?array $index = null;

	/**
	 * Declare `$names` and every function of FILES they reach.
	 *
	 * @param list<string> $names Functions the test's code calls.
	 * @throws \RuntimeException When `WP_ABSPATH` names no WordPress install.
	 */
	public static function load( array $names ): void {
		$wpinc = self::wpinc();
		foreach ( self::CLASSES as $file ) {
			require_once "{$wpinc}/{$file}";
		}
		self::$index ??= self::index( $wpinc );
		$pending = $names;
		while ( [] !== $pending ) {
			$name = \strtolower( \array_pop( $pending ) );
			if ( \function_exists( $name ) || ! isset( self::$index[ $name ] ) ) {
				continue;
			}
			eval( self::$index[ $name ] ); // phpcs:ignore Squiz.PHP.Eval.Discouraged -- WordPress's own source.
			\array_push( $pending, ...self::calls( self::$index[ $name ] ) );
		}
	}

	/**
	 * The install's wp-includes directory.
	 *
	 * @throws \RuntimeException When `WP_ABSPATH` names no WordPress install.
	 */
	private static function wpinc(): string {
		$abspath = \getenv( 'WP_ABSPATH' );
		if ( ! \is_string( $abspath ) || ! \is_file( "{$abspath}/wp-includes/class-wp-block-parser.php" ) ) {
			throw new \RuntimeException( 'these tests need WP_ABSPATH naming a WordPress install, whose wp-includes they load' );
		}
		return \rtrim( $abspath, '/' ) . '/wp-includes';
	}

	/**
	 * Every top-level function FILES declare, name => source.
	 *
	 * @return array<string,string>
	 */
	private static function index( string $wpinc ): array {
		$index = [];
		foreach ( self::FILES as $file ) {
			$tokens = \PhpToken::tokenize( (string) \file_get_contents( "{$wpinc}/{$file}" ) );
			$depth  = 0;
			$count  = \count( $tokens );
			for ( $i = 0; $i < $count; $i++ ) {
				$token = $tokens[ $i ];
				if ( 0 === $depth && $token->is( \T_FUNCTION ) ) {
					[ $name, $end ] = self::declaration( $tokens, $i );
					$index[ \strtolower( $name ) ] = \implode( '', \array_map( static fn ( \PhpToken $t ): string => $t->text, \array_slice( $tokens, $i, $end - $i + 1 ) ) );
					$i = $end;
					continue;
				}
				if ( $token->is( [ '{', \T_CURLY_OPEN, \T_DOLLAR_OPEN_CURLY_BRACES ] ) ) {
					++$depth;
				} elseif ( $token->is( '}' ) ) {
					--$depth;
				}
			}
		}
		return $index;
	}

	/**
	 * The name of the function declared at `$start`, and the index of the
	 * brace closing its body.
	 *
	 * @param list<\PhpToken> $tokens The file's tokens.
	 * @return array{0:string,1:int}
	 */
	private static function declaration( array $tokens, int $start ): array {
		$name  = '';
		$depth = 0;
		$count = \count( $tokens );
		for ( $i = $start + 1; $i < $count; $i++ ) {
			if ( '' === $name && $tokens[ $i ]->is( \T_STRING ) ) {
				$name = $tokens[ $i ]->text;
			} elseif ( $tokens[ $i ]->is( [ '{', \T_CURLY_OPEN, \T_DOLLAR_OPEN_CURLY_BRACES ] ) ) {
				++$depth;
			} elseif ( $tokens[ $i ]->is( '}' ) && 0 === --$depth ) {
				return [ $name, $i ];
			}
		}
		throw new \RuntimeException( "unterminated function at token {$start}" );
	}

	/**
	 * Every name a source calls: an identifier followed by `(`, and a quoted
	 * string, which may name a callback such as `array_map()`'s.
	 *
	 * @return list<string>
	 */
	private static function calls( string $source ): array {
		$tokens = \PhpToken::tokenize( "<?php {$source}" );
		$calls  = [];
		$count  = \count( $tokens );
		for ( $i = 0; $i < $count - 1; $i++ ) {
			if ( $tokens[ $i ]->is( \T_CONSTANT_ENCAPSED_STRING ) ) {
				$calls[] = \trim( $tokens[ $i ]->text, '\'"' );
				continue;
			}
			if ( ! $tokens[ $i ]->is( [ \T_STRING, \T_NAME_FULLY_QUALIFIED ] ) ) {
				continue;
			}
			$next = $i + 1;
			while ( $next < $count && $tokens[ $next ]->isIgnorable() ) {
				++$next;
			}
			if ( $next < $count && $tokens[ $next ]->is( '(' ) ) {
				$calls[] = \ltrim( $tokens[ $i ]->text, '\\' );
			}
		}
		return $calls;
	}
}
