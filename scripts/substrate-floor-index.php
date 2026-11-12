<?php
/**
 * Where each substrate API a consumer reaches first exists, for
 * check-substrate-floor.sh.
 *
 * Reads the API list PHPStan collected on stdin, one per line, in the
 * spellings phpstan-substrate-floor.php writes: `Class::method()` (a static
 * call), `Class->method()` (an instance call), `Class::NAME`, `Class::$name`
 * or a bare `Class`, a member access suffixed `#protected` when made from a
 * subclass or `#private` when made from the class using the member's trait.
 * Answers one line per API:
 *
 * - `ok <api>`               — the floor's tag has it
 * - `newer <version> <api>`  — the floor's tag lacks it; the first later tag has it
 * - `unreleased <api>`       — no later tag has it; the working tree does
 * - `dropped <version> <api>` — neither has it; the newest older tag does
 * - `unresolved <api>`       — nothing has it
 *
 * and then one `broken <where> <error>` line per file that would not parse,
 * whose declarations read as missing wherever they were looked for.
 *
 * Each probed tag is parsed with the php-parser the PHPStan phar carries into
 * an index of every class, interface, trait and enum under `includes/`: what
 * it uses, extends and implements, and the constants, enum cases, static
 * properties and methods it declares, each with its visibility and, for a
 * method, whether it is static. A lookup walks that index as PHP resolves a
 * member, takes the nearest declaration, and holds it to how the API is
 * reached: from outside, public; from a subclass, protected too; from the
 * class using its trait, private too; and a static call, a static method.
 * The working tree is read as git sees it, its tracked files alone. A file is
 * parsed once per blob, so a tag that shares most of its files with another
 * costs little more than a listing.
 *
 * Usage, from the plugin root: php scripts/substrate-floor-index.php
 * <substrate-dir> <floor-tag> <tag>… (every tag, oldest first) < apis
 *
 * @package Newspack_Nodes
 */

declare( strict_types = 1 );

namespace Newspack_Nodes\Tools\Floor_Index;

use PhpParser\Modifiers;
use PhpParser\Node;
use PhpParser\NodeFinder;
use PhpParser\NodeTraverser;
use PhpParser\NodeVisitor\NameResolver;
use PhpParser\Parser;
use PhpParser\ParserFactory;

/**
 * Visibility ranks: how far a member is hidden, and how far an access reaches.
 */
const RANKS = [
	'public'    => 0,
	'protected' => 1,
	'private'   => 2,
];

/**
 * The substrate's classes, indexed per git tag or for the working tree.
 */
final class Substrate_Index {

	/**
	 * Parser shared by every file.
	 *
	 * @var Parser
	 */
	private Parser $parser;

	/**
	 * Classes per blob, keyed by blob id, so a file shared by tags parses once.
	 *
	 * @var array<string,array<string,array<string,mixed>>>
	 */
	private array $blobs = [];

	/**
	 * Index per tag, '' for the working tree.
	 *
	 * @var array<string,array<string,array<string,mixed>>>
	 */
	private array $tags = [];

	/**
	 * Each file that would not parse, as `<where> <error>`.
	 *
	 * @var list<string>
	 */
	public array $broken = [];

	/**
	 * The one `git cat-file --batch` every blob is read through, while open.
	 *
	 * @var resource|null
	 */
	private $batch_proc = null;

	/**
	 * That process's pipes.
	 *
	 * @var array<int,resource>
	 */
	private array $batch = [];

	/**
	 * Builds nothing yet; each tag is indexed on first lookup.
	 *
	 * @param string $dir The substrate checkout.
	 */
	public function __construct( private string $dir ) {
		$this->parser = ( new ParserFactory() )->createForNewestSupportedVersion();
	}

	/**
	 * Does the API resolve at the tag, or in the working tree when tag is '',
	 * reachable the way the consumer reaches it?
	 *
	 * @param string $tag The tag, or '' for the working tree.
	 * @param string $api The API in its spelling.
	 * @return bool Whether PHP would let the consumer reach it there.
	 */
	public function has( string $tag, string $api ): bool {
		$index = $this->index( $tag );
		if ( ! \preg_match( '/^(.+?)(?:(::|->)(.+?))?(?:#(protected|private))?$/', $api, $m ) ) {
			return false;
		}
		$class = \strtolower( \ltrim( $m[1], '\\' ) );
		if ( ! isset( $index[ $class ] ) ) {
			return false;
		}
		if ( ! isset( $m[3] ) || '' === $m[3] ) {
			return true;
		}
		$member = member_key( $m[3] );
		$found  = $this->nearest( $index, $class, $member );
		if ( null === $found ) {
			return false;
		}
		$reach = RANKS[ $m[4] ?? '' ] ?? 0;
		if ( $found['v'] > $reach ) {
			return false;
		}
		$static_call = '::' === $m[2] && \str_starts_with( $member, 'm:' ) && 0 === $reach;
		return ! $static_call || $found['s'];
	}

	/**
	 * Every class at a tag, built on first use. A class declared in two files
	 * is refused rather than one declaration silently winning.
	 *
	 * @param string $tag The tag, or '' for the working tree.
	 * @return array<string,array<string,mixed>> Classes by lowercased name.
	 */
	private function index( string $tag ): array {
		if ( isset( $this->tags[ $tag ] ) ) {
			return $this->tags[ $tag ];
		}
		$index = [];
		$where = [];
		foreach ( '' === $tag ? $this->working_tree() : $this->blobs_at( $tag ) as [ $id, $path, $read ] ) {
			$this->blobs[ $id ] ??= $this->classes_in( $read(), ( '' === $tag ? '' : "{$tag}:" ) . $path );
			foreach ( $this->blobs[ $id ] as $class => $record ) {
				if ( isset( $where[ $class ] ) ) {
					throw new \RuntimeException(
						"{$record['name']} is declared twice " . ( '' === $tag ? 'in the working tree' : "at {$tag}" ) . ": {$where[ $class ]} and {$path}"
					);
				}
				$where[ $class ] = $path;
				$index[ $class ] = $record;
			}
		}
		$this->tags[ $tag ] = $index;
		return $index;
	}

	/**
	 * The classes one file declares, or none when it will not parse, which
	 * is recorded against the file rather than failing the whole index.
	 *
	 * @param string $code  The file.
	 * @param string $where Where it came from, for the record.
	 * @return array<string,array<string,mixed>> Classes by lowercased name.
	 */
	private function classes_in( string $code, string $where ): array {
		try {
			$ast = $this->parser->parse( $code ) ?? [];
		} catch ( \PhpParser\Error $e ) {
			$this->broken[] = "{$where} {$e->getMessage()}";
			return [];
		}
		$traverser = new NodeTraverser( new NameResolver() );
		$classes   = [];
		foreach ( ( new NodeFinder() )->findInstanceOf( $traverser->traverse( $ast ), Node\Stmt\ClassLike::class ) as $class ) {
			if ( null === $class->namespacedName ) {
				continue;
			}
			$classes[ $class->namespacedName->toLowerString() ] = [
				'name'      => $class->namespacedName->toString(),
				'related'   => related( $class ),
				'members'   => members( $class ),
				'hidden'    => hidden( $class ),
				'overrides' => overrides( $class ),
			];
		}
		return $classes;
	}

	/**
	 * The PHP blobs under includes/ at a tag.
	 *
	 * @param string $tag The tag.
	 * @return list<array{string, string, \Closure(): string}> Id, path and reader per blob.
	 */
	private function blobs_at( string $tag ): array {
		$blobs = [];
		foreach ( \explode( "\0", git( $this->dir, [ 'ls-tree', '-r', '-z', $tag, '--', 'includes/' ] ) ) as $entry ) {
			if ( \preg_match( '/^\d+ blob ([0-9a-f]+)\t(.+\.php)$/', $entry, $m ) ) {
				$blobs[] = [ $m[1], $m[2], fn (): string => $this->cat( $m[1] ) ];
			}
		}
		return $blobs;
	}

	/**
	 * One blob's bytes, through the shared `git cat-file --batch`.
	 *
	 * @param string $id The blob id.
	 * @return string Its contents.
	 */
	private function cat( string $id ): string {
		if ( null === $this->batch_proc ) {
			$spec = [ [ 'pipe', 'r' ], [ 'pipe', 'w' ], [ 'file', 'php://stderr', 'w' ] ];
			$proc = \proc_open( [ 'git', '-C', $this->dir, 'cat-file', '--batch' ], $spec, $this->batch );
			if ( ! \is_resource( $proc ) ) {
				throw new \RuntimeException( 'cannot start git cat-file --batch' );
			}
			$this->batch_proc = $proc;
		}
		if ( false === \fwrite( $this->batch[0], $id . "\n" ) || ! \fflush( $this->batch[0] ) ) {
			throw new \RuntimeException( "git cat-file --batch stopped taking requests, at blob {$id}" );
		}
		$head = (string) \fgets( $this->batch[1] );
		if ( ! \preg_match( '/^[0-9a-f]+ blob (\d+)$/', \rtrim( $head ), $m ) ) {
			throw new \RuntimeException( "git cat-file answered '" . \rtrim( $head ) . "' for blob {$id}" );
		}
		$body = (string) \stream_get_contents( $this->batch[1], (int) $m[1] );
		\fgets( $this->batch[1] );
		return $body;
	}

	/**
	 * The working tree's PHP files under includes/ that git tracks.
	 *
	 * @return list<array{string, string, \Closure(): string}> Id, path and reader per file.
	 */
	private function working_tree(): array {
		$files = [];
		foreach ( \explode( "\0", git( $this->dir, [ 'ls-files', '-z', '--', 'includes/' ] ) ) as $path ) {
			$file = $this->dir . '/' . $path;
			if ( \str_ends_with( $path, '.php' ) && \is_file( $file ) ) {
				$files[] = [ 'worktree:' . $path, $path, static fn (): string => read_file( $file ) ];
			}
		}
		return $files;
	}

	/**
	 * Close the shared `git cat-file --batch`.
	 */
	public function close(): void {
		if ( null === $this->batch_proc ) {
			return;
		}
		\fclose( $this->batch[0] );
		\fclose( $this->batch[1] );
		\proc_close( $this->batch_proc );
		$this->batch_proc = null;
	}

	/**
	 * The nearest declaration of a member, walking the class, its traits,
	 * its parent and its interfaces in that order, as PHP resolves it.
	 *
	 * @param array<string,array<string,mixed>> $index  Classes by lowercased name.
	 * @param string                            $class  Lowercased class.
	 * @param string                            $member The member key.
	 * @return array{v: int, s: bool}|null The declaration, or null.
	 */
	private function nearest( array $index, string $class, string $member ): ?array {
		$queue = [ [ $class, null ] ];
		$seen  = [];
		while ( [] !== $queue ) {
			[ $name, $via ] = \array_shift( $queue );
			if ( isset( $seen[ $name ] ) || ! isset( $index[ $name ] ) ) {
				continue;
			}
			$seen[ $name ] = true;
			$record        = $index[ $name ];
			if ( isset( $record['members'][ $member ] ) ) {
				$found = $this->unalias( $index, $record['members'][ $member ] );
				if ( null !== $found && null !== $via && isset( $index[ $via ]['overrides'][ $member ] ) ) {
					$found['v'] = $index[ $via ]['overrides'][ $member ];
				}
				return $found;
			}
			foreach ( $record['related'] as $next ) {
				if ( ! isset( $record['hidden'][ $next ][ $member ] ) ) {
					$queue[] = [ $next, $name ];
				}
			}
		}
		return null;
	}

	/**
	 * A trait alias's declaration completed from the method it aliases: that
	 * method's static flag, and its visibility unless the alias sets one. An
	 * alias of a method its traits lack resolves to nothing, as PHP refuses it.
	 *
	 * @param array<string,array<string,mixed>> $index Classes by lowercased name.
	 * @param array<string,mixed>               $found The declaration found.
	 * @return array{v: int, s: bool}|null The declaration, or null.
	 */
	private function unalias( array $index, array $found ): ?array {
		if ( ! isset( $found['of'] ) ) {
			return $found;
		}
		foreach ( $found['of']['traits'] as $trait ) {
			$aliased = $this->nearest( $index, $trait, $found['of']['member'] );
			if ( null !== $aliased ) {
				return [
					'v' => $found['v'] ?? $aliased['v'],
					's' => $aliased['s'],
				];
			}
		}
		return null;
	}
}

/**
 * The index key for an API's member part: `m:` a lowercased method, `s:` a
 * static property, `c:` a constant or enum case.
 *
 * @param string $member `name()`, `$name` or `NAME`.
 * @return string The key.
 */
function member_key( string $member ): string {
	if ( \str_ends_with( $member, '()' ) ) {
		return 'm:' . \strtolower( \substr( $member, 0, -2 ) );
	}
	return \str_starts_with( $member, '$' ) ? 's:' . \substr( $member, 1 ) : 'c:' . $member;
}

/**
 * The classes a class takes members from, nearest first: its traits, then
 * the parent and interfaces the collector's declared_supertypes() names.
 *
 * @param Node\Stmt\ClassLike $class The class.
 * @return list<string> Lowercased names.
 */
function related( Node\Stmt\ClassLike $class ): array {
	$names = [];
	foreach ( $class->getTraitUses() as $use ) {
		\array_push( $names, ...$use->traits );
	}
	\array_push( $names, ...\Newspack_Nodes\Tools\declared_supertypes( $class ) );
	return \array_map( static fn ( Node\Name $name ): string => $name->toLowerString(), $names );
}

/**
 * The visibility rank of a modifier set.
 *
 * @param int $flags The modifiers.
 * @return int 0 public, 1 protected, 2 private.
 */
function rank( int $flags ): int {
	return match ( true ) {
		0 !== ( $flags & Modifiers::PRIVATE ) => 2,
		0 !== ( $flags & Modifiers::PROTECTED ) => 1,
		default => 0,
	};
}

/**
 * The members a class declares itself, keyed as member_key() keys them,
 * each with its visibility rank `v` and whether it is static `s`: its own,
 * the new name of each trait alias, and an enum's built-ins, `cases()` and,
 * on a backed enum, `from()` and `tryFrom()`. An alias names the method it
 * aliases under `of`, and takes `s`, and `v` unless it sets a visibility of
 * its own, from that method where the lookup finds it.
 *
 * @param Node\Stmt\ClassLike $class The class.
 * @return array<string,array<string,mixed>> The members.
 */
function members( Node\Stmt\ClassLike $class ): array {
	$keys = [];
	foreach ( $class->getConstants() as $group ) {
		foreach ( $group->consts as $const ) {
			$keys[ 'c:' . $const->name->toString() ] = [ 'v' => rank( $group->flags ), 's' => true ];
		}
	}
	foreach ( $class->stmts as $stmt ) {
		if ( $stmt instanceof Node\Stmt\EnumCase ) {
			$keys[ 'c:' . $stmt->name->toString() ] = [ 'v' => 0, 's' => true ];
		}
	}
	foreach ( $class->getProperties() as $property ) {
		foreach ( $property->isStatic() ? $property->props : [] as $prop ) {
			$keys[ 's:' . $prop->name->toString() ] = [ 'v' => rank( $property->flags ), 's' => true ];
		}
	}
	foreach ( $class->getMethods() as $method ) {
		$keys[ 'm:' . $method->name->toLowerString() ] = [ 'v' => rank( $method->flags ), 's' => $method->isStatic() ];
	}
	foreach ( $class->getTraitUses() as $use ) {
		foreach ( $use->adaptations as $adaptation ) {
			if ( $adaptation instanceof Node\Stmt\TraitUseAdaptation\Alias && null !== $adaptation->newName ) {
				$keys[ 'm:' . $adaptation->newName->toLowerString() ] = [
					'v'  => null === $adaptation->newModifier ? null : rank( $adaptation->newModifier ),
					's'  => null,
					'of' => [
						'traits' => \array_map(
							static fn ( Node\Name $trait ): string => $trait->toLowerString(),
							null === $adaptation->trait ? $use->traits : [ $adaptation->trait ]
						),
						'member' => 'm:' . $adaptation->method->toLowerString(),
					],
				];
			}
		}
	}
	if ( $class instanceof Node\Stmt\Enum_ ) {
		foreach ( null === $class->scalarType ? [ 'cases' ] : [ 'cases', 'from', 'tryfrom' ] as $builtin ) {
			$keys[ 'm:' . $builtin ] = [ 'v' => 0, 's' => true ];
		}
	}
	return $keys;
}

/**
 * The methods a class's `m as protected;` aliases give a new visibility,
 * keeping their name.
 *
 * @param Node\Stmt\ClassLike $class The class.
 * @return array<string,int> Visibility rank, by member key.
 */
function overrides( Node\Stmt\ClassLike $class ): array {
	$overrides = [];
	foreach ( $class->getTraitUses() as $use ) {
		foreach ( $use->adaptations as $adaptation ) {
			if ( $adaptation instanceof Node\Stmt\TraitUseAdaptation\Alias && null === $adaptation->newName && null !== $adaptation->newModifier ) {
				$overrides[ 'm:' . $adaptation->method->toLowerString() ] = rank( $adaptation->newModifier );
			}
		}
	}
	return $overrides;
}

/**
 * The methods an `insteadof` takes from each trait a class uses, so the walk
 * never reaches them there.
 *
 * @param Node\Stmt\ClassLike $class The class.
 * @return array<string,array<string,true>> Member keys, by lowercased trait.
 */
function hidden( Node\Stmt\ClassLike $class ): array {
	$hidden = [];
	foreach ( $class->getTraitUses() as $use ) {
		foreach ( $use->adaptations as $adaptation ) {
			if ( ! $adaptation instanceof Node\Stmt\TraitUseAdaptation\Precedence ) {
				continue;
			}
			foreach ( $adaptation->insteadof as $trait ) {
				$hidden[ $trait->toLowerString() ][ 'm:' . $adaptation->method->toLowerString() ] = true;
			}
		}
	}
	return $hidden;
}

/**
 * A git command's stdout; a nonzero exit throws with git's own stderr shown.
 *
 * @param string       $dir  The repository.
 * @param list<string> $args Arguments after `git -C <dir>`.
 * @return string Its stdout.
 */
function git( string $dir, array $args ): string {
	$spec = [ [ 'pipe', 'r' ], [ 'pipe', 'w' ], [ 'file', 'php://stderr', 'w' ] ];
	$proc = \proc_open( [ 'git', '-C', $dir, ...$args ], $spec, $pipes );
	if ( ! \is_resource( $proc ) ) {
		throw new \RuntimeException( 'cannot start git ' . \implode( ' ', $args ) );
	}
	\fclose( $pipes[0] );
	$out = (string) \stream_get_contents( $pipes[1] );
	\fclose( $pipes[1] );
	$status = \proc_close( $proc );
	if ( 0 !== $status ) {
		throw new \RuntimeException( 'git ' . \implode( ' ', $args ) . " exited {$status}" );
	}
	return $out;
}

/**
 * A working-tree file's contents, or a throw naming it.
 *
 * @param string $path The file.
 * @return string Its contents.
 */
function read_file( string $path ): string {
	$code = \file_get_contents( $path );
	if ( false === $code ) {
		throw new \RuntimeException( "cannot read {$path}" );
	}
	return $code;
}

/**
 * Where one API stands, as the line this script answers.
 *
 * @param Substrate_Index $index The index.
 * @param string          $api   The API.
 * @param list<string>    $later Tags after the floor tag, oldest first.
 * @param list<string>    $older Tags before the floor tag, newest first.
 * @param string          $floor The floor tag.
 * @return string The verdict line.
 */
function verdict( Substrate_Index $index, string $api, array $later, array $older, string $floor ): string {
	if ( $index->has( $floor, $api ) ) {
		return "ok {$api}";
	}
	foreach ( $later as $tag ) {
		if ( $index->has( $tag, $api ) ) {
			return 'newer ' . \substr( $tag, 1 ) . " {$api}";
		}
	}
	if ( $index->has( '', $api ) ) {
		return "unreleased {$api}";
	}
	foreach ( $older as $tag ) {
		if ( $index->has( $tag, $api ) ) {
			return 'dropped ' . \substr( $tag, 1 ) . " {$api}";
		}
	}
	return "unresolved {$api}";
}

/**
 * Answer every API on stdin, then name every file that would not parse.
 *
 * @param list<string> $argv The command line.
 */
function main( array $argv ): void {
	$phar = \getcwd() . '/vendor/phpstan/phpstan/phpstan.phar';
	if ( ! \is_file( $phar ) ) {
		throw new \RuntimeException( "no PHPStan phar at {$phar}; the index parses with the php-parser it carries — run composer install" );
	}
	require_once "phar://{$phar}/vendor/autoload.php";
	require_once __DIR__ . '/phpstan-substrate-floor.php';

	$args  = \array_slice( $argv, 1 );
	$dir   = \array_shift( $args );
	$floor = \array_shift( $args );
	$at    = \array_search( $floor, $args, true );
	if ( null === $dir || null === $floor || false === $at ) {
		throw new \RuntimeException( 'usage: substrate-floor-index.php <substrate-dir> <floor-tag> <tag>… (the floor among them) < apis' );
	}
	$apis = @\file( 'php://stdin', \FILE_IGNORE_NEW_LINES | \FILE_SKIP_EMPTY_LINES );
	if ( false === $apis ) {
		throw new \RuntimeException( 'cannot read the API list from stdin' );
	}
	$index = new Substrate_Index( $dir );
	$later = \array_slice( $args, $at + 1 );
	$older = \array_reverse( \array_slice( $args, 0, $at ) );
	try {
		foreach ( $apis as $api ) {
			echo verdict( $index, $api, $later, $older, $floor ), "\n";
		}
	} finally {
		$index->close();
	}
	foreach ( $index->broken as $broken ) {
		echo "broken {$broken}\n";
	}
}

\ini_set( 'display_errors', 'stderr' );
try {
	main( $argv );
} catch ( \Throwable $e ) {
	\fwrite( \STDERR, 'substrate-floor-index: ' . $e->getMessage() . "\n" );
	exit( 2 );
}
