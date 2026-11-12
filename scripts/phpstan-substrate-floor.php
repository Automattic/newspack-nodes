<?php
/**
 * PHPStan collector + rule: every substrate API a consumer plugin reaches.
 *
 * The point is that it does NOT guess from the NAME. A consumer calling
 * `$wpdb->prepare()` and the substrate's `Core::prepare()` share a name and
 * nothing else; name matching cannot tell them apart, and since the floor is
 * the MAX over what it finds, one false match pins a plugin dormant against a
 * substrate that would have run it. PHPStan already resolves each type, so
 * this asks it: what class DECLARES the member this expression reaches?
 *
 * Each way of reaching an API fatals on a substrate too old for it, and each
 * is reported in its own spelling, which check-substrate-floor.sh hands to
 * substrate-floor-index.php to look up at each tag:
 *
 * - `Class->method()` — an instance call; PHPStan hands a nullsafe call over
 *                       as one
 * - `Class::method()` — a static call, or a callable array
 *                       `[ Class::class, 'method' ]`
 * - `Class::NAME`     — a class constant fetch or an enum case
 * - `Class::$name`    — a static property fetch
 * - `Class`           — a `new`, `extends`, `implements`, trait `use`,
 *                       `instanceof` or `catch`, each needing only the
 *                       class, interface or trait to exist
 *
 * A member access made from a subclass of the class declaring the member
 * takes the suffix `#protected`, and one made from the class using the
 * member's trait `#private`: each widens what the index accepts, where an
 * access from outside needs a public member, and a static call from outside
 * a static one.
 *
 * Output is one `error` per distinct API. It runs under its own config,
 * `phpstan-floor.neon` — these are findings for a script to read, not review
 * comments.
 *
 * @package Newspack_Nodes
 */

declare( strict_types = 1 );

namespace Newspack_Nodes\Tools;

use PhpParser\Node as ParserNode;
use PhpParser\Node\Expr;
use PHPStan\Analyser\Scope;
use PHPStan\Collectors\Collector;
use PHPStan\Node\CollectedDataNode;
use PHPStan\Reflection\ClassReflection;
use PHPStan\Rules\Rule;
use PHPStan\Rules\RuleErrorBuilder;
use PHPStan\Type\Type;
use PHPStan\Type\TypeCombinator;

/**
 * The namespace whose APIs a consumer's floor must cover. The trailing
 * separator is load-bearing: a bare `Newspack_Nodes` prefix would also claim
 * every class in a `Newspack_Nodes_Anything\` namespace as substrate.
 */
const SUBSTRATE_NS = 'Newspack_Nodes\\';

/**
 * The API a member resolves to, or null when the substrate does not declare it.
 *
 * A member the substrate declares is named by its receiver where that is a
 * substrate class, `Kid::moved()` even where `moved()` is declared on Kid's
 * parent: the index walks parents and traits as PHP does, so a member moved
 * up a hierarchy after an older tag still reads as present there. A receiver
 * outside the substrate, a consumer's own subclass, falls back to the class
 * that declares the member, and a member PHP itself declares, such as
 * `getMessage()` on a substrate exception, is not a substrate API at all.
 *
 * Reflection names the class that USES a trait, not the trait, so a
 * consumer class mixing in a substrate trait reports itself and would be
 * filtered out here — while still fataling on an old substrate, because the
 * member lives in the substrate's copy of the trait. So the traits are asked.
 *
 * @param Type            $receiver  The type the access is made on.
 * @param ClassReflection $declaring Class PHPStan says declares the member.
 * @param string          $suffix    The member in its spelling, `::` included.
 * @param callable        $in_trait  `fn( ClassReflection $trait ): bool`, true
 *                                   when that trait itself declares the member.
 * @return string|null The API, or null.
 */
function claim( Type $receiver, ClassReflection $declaring, string $suffix, callable $in_trait ): ?string {
	$owner = $declaring->getName();
	if ( ! \str_starts_with( $owner, SUBSTRATE_NS ) ) {
		$owner = substrate_trait_declaring( $declaring, $in_trait );
	}
	if ( null === $owner ) {
		return null;
	}
	$named = $receiver->getObjectClassNames();
	if ( 1 === \count( $named ) && \str_starts_with( $named[0], SUBSTRATE_NS ) ) {
		return $named[0] . $suffix;
	}
	return $owner . $suffix;
}

/**
 * The substrate trait declaring a member on `$class` or on one of its
 * ancestors, traits used by other traits included.
 *
 * A method is asked through `hasNativeMethod()`, which demands a real
 * declaration rather than one PHPStan synthesizes from a `@method`
 * annotation, because the wrapper then goes looking for that member's
 * declaration in the trait's file at each candidate tag. An annotated member
 * would resolve here and match nothing there.
 *
 * @param ClassReflection $class    Class using the trait.
 * @param callable        $in_trait See claim().
 * @return string|null Trait FQN, or null unless a substrate trait declares it.
 */
function substrate_trait_declaring( ClassReflection $class, callable $in_trait ): ?string {
	for ( $current = $class; null !== $current; $current = $current->getParentClass() ) {
		foreach ( $current->getTraits( true ) as $trait ) {
			if ( \str_starts_with( $trait->getName(), SUBSTRATE_NS ) && $in_trait( $trait ) ) {
				return $trait->getName();
			}
		}
	}
	return null;
}

/**
 * The type a static access names its class by.
 *
 * A `Name` — a class written out in the source, or `self`, `static`,
 * `parent` — is not an expression at all, so `resolveTypeByName()` is what
 * turns it into a type against the current scope. Anything else, `$obj::X`,
 * is an expression `getType()` reads.
 *
 * @param ParserNode $class The access's class part.
 * @param Scope      $scope Analysis scope.
 * @return Type The type.
 */
function class_type( ParserNode $class, Scope $scope ): Type {
	return $class instanceof ParserNode\Name
		? $scope->resolveTypeByName( $class )
		: $scope->getType( $class );
}

/**
 * `Class::method()` for a call, or null, spelt as the method is declared.
 *
 * A type that only MAYBE has the member — a union, `mixed` — yields null
 * here and in every reader below. Claiming an access PHPStan could not
 * resolve would raise the floor on a guess, and the floor is the max over
 * everything found. Null is stripped first: a call on a nullable substrate
 * type still fatals on a substrate without the method.
 *
 * @param Type   $type     The callee's type.
 * @param string $method   Method name as written.
 * @param Scope  $scope    Analysis scope.
 * @param string $operator `->` for an instance call, `::` for a static one.
 * @return string|null The API, or null.
 */
function method_api( Type $type, string $method, Scope $scope, string $operator ): ?string {
	$type = TypeCombinator::removeNull( $type );
	if ( ! $type->hasMethod( $method )->yes() ) {
		return null;
	}
	$reflection = $type->getMethod( $method, $scope );
	$reach      = reach( $scope, $reflection->getDeclaringClass() );
	return claim(
		$type,
		$reflection->getDeclaringClass(),
		( '' === $reach ? $operator : '::' ) . $reflection->getName() . '()' . $reach,
		static fn ( ClassReflection $trait ): bool => $trait->hasNativeMethod( $method )
	);
}

/**
 * `Class::NAME` for a constant fetch or an enum case, or null; `::class`
 * names no constant.
 *
 * @param Type   $type  The class's type.
 * @param string $name  Constant name as written.
 * @param Scope  $scope Analysis scope.
 * @return string|null The API, or null.
 */
function constant_api( Type $type, string $name, Scope $scope ): ?string {
	$type = TypeCombinator::removeNull( $type );
	if ( 'class' === \strtolower( $name ) || ! $type->hasConstant( $name )->yes() ) {
		return null;
	}
	$declaring = $type->getConstant( $name )->getDeclaringClass();
	return claim(
		$type,
		$declaring,
		'::' . $name . reach( $scope, $declaring ),
		static fn ( ClassReflection $trait ): bool => $trait->hasConstant( $name )
	);
}

/**
 * `Class::$name` for a static property fetch, or null.
 *
 * @param Type   $type  The class's type.
 * @param string $name  Property name as written, without its `$`.
 * @param Scope  $scope Analysis scope.
 * @return string|null The API, or null.
 */
function static_property_api( Type $type, string $name, Scope $scope ): ?string {
	$type = TypeCombinator::removeNull( $type );
	if ( ! $type->hasStaticProperty( $name )->yes() ) {
		return null;
	}
	$declaring = $type->getStaticProperty( $name, $scope )->getDeclaringClass();
	return claim(
		$type,
		$declaring,
		'::$' . $name . reach( $scope, $declaring ),
		static fn ( ClassReflection $trait ): bool => $trait->hasNativeProperty( $name )
	);
}

/**
 * `Class` for a substrate class named outright, or null.
 *
 * A `new`, an `extends`, an `implements`, a trait `use`, an `instanceof` and a
 * `catch` each need only the class to exist. `new $class` and an anonymous class name
 * nothing PHPStan can pin to one substrate class, so they never get here.
 *
 * @param ParserNode\Name $name  The class as written.
 * @param Scope           $scope Analysis scope.
 * @return string|null The class, or null.
 */
function class_api( ParserNode\Name $name, Scope $scope ): ?string {
	$names = $scope->resolveTypeByName( $name )->getObjectClassNames();
	if ( 1 !== \count( $names ) || ! \str_starts_with( $names[0], SUBSTRATE_NS ) ) {
		return null;
	}
	return $names[0];
}

/**
 * `Class::method()` for a callable array `[ Class::class, 'method' ]`, or
 * null for any other array.
 *
 * @param Expr\Array_ $node  The array.
 * @param Scope       $scope Analysis scope.
 * @return string|null The API, or null.
 */
function callable_api( Expr\Array_ $node, Scope $scope ): ?string {
	if ( 2 !== \count( $node->items ) ) {
		return null;
	}
	[ $class, $method ] = [ $node->items[0]->value, $node->items[1]->value ];
	if ( ! $class instanceof Expr\ClassConstFetch || ! $class->class instanceof ParserNode\Name
		|| ! $class->name instanceof ParserNode\Identifier || 'class' !== $class->name->toLowerString()
		|| ! $method instanceof ParserNode\Scalar\String_ ) {
		return null;
	}
	return method_api( $scope->resolveTypeByName( $class->class ), $method->value, $scope, '::' );
}

/**
 * How far inside a member's declaring class an access is made: `#private`
 * from that class itself, which a consumer is only through a trait it uses,
 * `#protected` from a subclass, and '' from outside.
 *
 * @param Scope           $scope     Analysis scope.
 * @param ClassReflection $declaring Class PHPStan says declares the member.
 * @return string The suffix.
 */
function reach( Scope $scope, ClassReflection $declaring ): string {
	$from = $scope->isInClass() ? $scope->getClassReflection() : null;
	return match ( true ) {
		null === $from => '',
		$from->getName() === $declaring->getName() => '#private',
		$from->isSubclassOfClass( $declaring ) => '#protected',
		default => '',
	};
}

/**
 * The classes a class-like declaration names as its parent or interfaces.
 *
 * @param ParserNode\Stmt\ClassLike $node The declaration.
 * @return list<ParserNode\Name> The names.
 */
function declared_supertypes( ParserNode\Stmt\ClassLike $node ): array {
	return match ( true ) {
		$node instanceof ParserNode\Stmt\Class_ => [ ...( null === $node->extends ? [] : [ $node->extends ] ), ...$node->implements ],
		$node instanceof ParserNode\Stmt\Interface_ => $node->extends,
		$node instanceof ParserNode\Stmt\Enum_ => $node->implements,
		default => [],
	};
}

/**
 * Collects every node that reaches a substrate API.
 *
 * Keyed to PHPStan's root node type, because the shapes span expressions
 * (calls, fetches, `new`, `instanceof`, a callable array) and statements (a
 * class's `extends` and `implements`, a trait `use`, a `catch`). A dynamic name, which has
 * nothing to resolve, yields nothing.
 */
class Substrate_Api_Collector implements Collector {

	/**
	 * PHPStan hands `processNode()` every node in the analysed sources.
	 *
	 * @return class-string<ParserNode>
	 */
	public function getNodeType(): string {
		return ParserNode::class;
	}

	/**
	 * The APIs this node reaches, or null when it reaches none.
	 *
	 * @param ParserNode $node  The node.
	 * @param Scope      $scope Analysis scope.
	 * @return list<string>|null The APIs in their spellings, or null.
	 */
	public function processNode( ParserNode $node, Scope $scope ): ?array {
		$apis = \array_values(
			\array_filter(
				\array_map(
					static fn ( ParserNode\Name $name ): ?string => class_api( $name, $scope ),
					names_of( $node )
				)
			)
		);
		$api  = api_of( $node, $scope );
		if ( null !== $api ) {
			$apis[] = $api;
		}
		return [] === $apis ? null : $apis;
	}
}

/**
 * The classes a node names outright: a `new`'s, an `instanceof`'s, a
 * `catch`'s, a trait use's, or a declaration's parent and interfaces.
 *
 * @param ParserNode $node The node.
 * @return list<ParserNode\Name> The names.
 */
function names_of( ParserNode $node ): array {
	$names = match ( true ) {
		$node instanceof Expr\New_, $node instanceof Expr\Instanceof_ => [ $node->class ],
		$node instanceof ParserNode\Stmt\Catch_ => $node->types,
		$node instanceof ParserNode\Stmt\TraitUse => $node->traits,
		$node instanceof ParserNode\Stmt\ClassLike => declared_supertypes( $node ),
		default => [],
	};
	return \array_values( \array_filter( $names, static fn ( $name ): bool => $name instanceof ParserNode\Name ) );
}

/**
 * The member a call, a fetch or a callable array reaches, or null.
 *
 * @param ParserNode $node  The node.
 * @param Scope      $scope Analysis scope.
 * @return string|null The API, or null.
 */
function api_of( ParserNode $node, Scope $scope ): ?string {
	if ( $node instanceof Expr\Array_ ) {
		return callable_api( $node, $scope );
	}
	$named = $node instanceof Expr\MethodCall || $node instanceof Expr\StaticCall
		|| $node instanceof Expr\ClassConstFetch || $node instanceof Expr\StaticPropertyFetch;
	if ( ! $named || ! $node->name instanceof ParserNode\Identifier ) {
		return null;
	}
	$name = $node->name->toString();
	return match ( true ) {
		$node instanceof Expr\MethodCall => method_api( $scope->getType( $node->var ), $name, $scope, '->' ),
		$node instanceof Expr\StaticCall => method_api( class_type( $node->class, $scope ), $name, $scope, '::' ),
		$node instanceof Expr\ClassConstFetch => constant_api( class_type( $node->class, $scope ), $name, $scope ),
		$node instanceof Expr\StaticPropertyFetch => static_property_api( class_type( $node->class, $scope ), $name, $scope ),
		default => null,
	};
}

/**
 * Reports the collected set, one line each, for the wrapper to read.
 *
 * Reporting here rather than from the collector is what collapses one API
 * reached across forty files into one line: this node carries every find,
 * keyed by file, and fires once when the analysis is done.
 */
class Substrate_Floor_Rule implements Rule {

	/**
	 * PHPStan emits this virtual node once, after every file is analysed.
	 *
	 * @return class-string<CollectedDataNode>
	 */
	public function getNodeType(): string {
		return CollectedDataNode::class;
	}

	/**
	 * Emits one error per distinct substrate API, deduplicated across files.
	 *
	 * The identifier is what satisfies the `Rule` contract's
	 * `list<IdentifierRuleError>` return; nothing reads it. The wrapper matches
	 * the `SUBSTRATE_API ` prefix on the message.
	 *
	 * @param CollectedDataNode $node  The collected data.
	 * @param Scope             $scope Analysis scope.
	 * @return list<\PHPStan\Rules\IdentifierRuleError> One per distinct API.
	 */
	public function processNode( ParserNode $node, Scope $scope ): array {
		$found = [];
		foreach ( $node->get( Substrate_Api_Collector::class ) as $per_file ) {
			foreach ( $per_file as $apis ) {
				foreach ( $apis as $api ) {
					$found[ $api ] = true;
				}
			}
		}
		$out = [];
		foreach ( \array_keys( $found ) as $api ) {
			$out[] = RuleErrorBuilder::message( 'SUBSTRATE_API ' . $api )
				->identifier( 'newspackNodes.substrateApi' )
				->build();
		}
		return $out;
	}
}
