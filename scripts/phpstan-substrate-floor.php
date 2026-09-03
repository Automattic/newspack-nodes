<?php
/**
 * PHPStan collector + rule: every substrate API a consumer plugin calls.
 *
 * The point is that it does NOT guess from the method NAME. A consumer calling
 * `$wpdb->prepare()` and the substrate's `Core::prepare()` share a name and
 * nothing else; name matching cannot tell them apart, and since the floor is
 * the MAX over what it finds, one false match pins a plugin dormant against a
 * substrate that would have run it. PHPStan already resolves the callee's
 * type, so this asks it: what class DECLARES the method this call reaches?
 *
 * Output is one `error` per distinct `Declaring_Class::method`, which
 * check-substrate-floor.sh turns into a version. It runs under its own config,
 * `phpstan-floor.neon` — these are findings for a script to read, not review
 * comments.
 *
 * @package Newspack_Nodes
 */

declare( strict_types = 1 );

namespace Newspack_Nodes\Tools;

use PhpParser\Node as ParserNode;
use PhpParser\Node\Expr\MethodCall;
use PhpParser\Node\Expr\StaticCall;
use PHPStan\Analyser\Scope;
use PHPStan\Collectors\Collector;
use PHPStan\Node\CollectedDataNode;
use PHPStan\Rules\Rule;
use PHPStan\Rules\RuleErrorBuilder;

/**
 * The namespace whose APIs a consumer's floor must cover. The trailing
 * separator is load-bearing: a bare `Newspack_Nodes` prefix would also claim
 * every class in a `Newspack_Nodes_Anything\` namespace as substrate.
 */
const SUBSTRATE_NS = 'Newspack_Nodes\\';

/**
 * `Declaring_Class::method` for one call, or null when it is not a substrate
 * call. Shared by both collectors: an instance call and a static call differ
 * only in how the callee type is reached.
 *
 * A type that only MAYBE has the method — a union, `mixed` — yields null.
 * Claiming a call PHPStan could not resolve would raise the floor on a guess,
 * and the floor is the max over everything found.
 *
 * @param \PHPStan\Type\Type $type   Resolved type of the callee.
 * @param string             $method Method name as written.
 * @param Scope              $scope  Analysis scope.
 * @return string|null The declaring class and method, or null.
 */
function declaring( $type, string $method, Scope $scope ): ?string {
	if ( ! $type->hasMethod( $method )->yes() ) {
		return null;
	}
	$class    = $type->getMethod( $method, $scope )->getDeclaringClass();
	$declared = $class->getName();
	if ( \str_starts_with( $declared, SUBSTRATE_NS ) ) {
		return $declared . '::' . $method;
	}
	// @longform Reflection names the class that USES a trait, not the trait, so
	// a consumer class mixing in a substrate trait reports itself and would be
	// filtered out here — while still fataling on an old substrate, because the
	// method lives in the substrate's copy of the trait. Ask the traits.
	$trait = substrate_trait_declaring( $class, $method );
	return null === $trait ? null : $trait . '::' . $method;
}

/**
 * The substrate trait declaring `$method` on `$class` or on one of its
 * ancestors, traits used by other traits included.
 *
 * `hasNativeMethod()` demands a real declaration rather than one PHPStan
 * synthesizes from a `@method` annotation, because the wrapper then goes
 * looking for that method's BODY in the trait's file at each candidate tag.
 * An annotated method would resolve here and match nothing there.
 *
 * @param \PHPStan\Reflection\ClassReflection $class  Class using the trait.
 * @param string                              $method Method name.
 * @return string|null Trait FQN, or null when no substrate trait declares it.
 */
function substrate_trait_declaring( $class, string $method ): ?string {
	for ( $current = $class; null !== $current; $current = $current->getParentClass() ) {
		foreach ( $current->getTraits( true ) as $trait ) {
			$name = $trait->getName();
			if ( \str_starts_with( $name, SUBSTRATE_NS ) && $trait->hasNativeMethod( $method ) ) {
				return $name;
			}
		}
	}
	return null;
}

/**
 * Collects `$obj->method()` calls that land on a substrate class.
 *
 * PHPStan keys a collector to ONE parser node type, so instance calls and
 * static calls are two classes rather than one class with a branch.
 */
class Substrate_Method_Call_Collector implements Collector {

	/**
	 * PHPStan hands `processNode()` every instance call in the analysed sources.
	 *
	 * @return class-string<MethodCall>
	 */
	public function getNodeType(): string {
		return MethodCall::class;
	}

	/**
	 * Resolves the callee's type, then asks which class declares the method.
	 *
	 * @param MethodCall $node  The call.
	 * @param Scope      $scope Analysis scope.
	 * @return string|null `Declaring_Class::method`, or null for a non-substrate call.
	 */
	public function processNode( ParserNode $node, Scope $scope ): ?string {
		if ( ! $node->name instanceof ParserNode\Identifier ) {
			return null; // Dynamic name: nothing to resolve, nothing to claim.
		}
		return declaring( $scope->getType( $node->var ), $node->name->toString(), $scope );
	}
}

/** Collects `Class::method()` calls that land on a substrate class. */
class Substrate_Static_Call_Collector implements Collector {

	/**
	 * PHPStan hands `processNode()` every static call in the analysed sources.
	 *
	 * @return class-string<StaticCall>
	 */
	public function getNodeType(): string {
		return StaticCall::class;
	}

	/**
	 * Resolves the callee's type, then asks which class declares the method.
	 *
	 * A static call names its class two ways. A `Name` — a class written out
	 * in the source, or `self`, `static`, `parent` — is not an expression at
	 * all, so `resolveTypeByName()` is what turns it into a type against the
	 * current scope. Anything else is an expression `getType()` reads.
	 *
	 * @param StaticCall $node  The call.
	 * @param Scope      $scope Analysis scope.
	 * @return string|null `Declaring_Class::method`, or null for a non-substrate call.
	 */
	public function processNode( ParserNode $node, Scope $scope ): ?string {
		if ( ! $node->name instanceof ParserNode\Identifier ) {
			return null;
		}
		$type = $node->class instanceof ParserNode\Name
			? $scope->resolveTypeByName( $node->class )
			: $scope->getType( $node->class );
		return declaring( $type, $node->name->toString(), $scope );
	}
}

/**
 * Reports the collected set, one line each, for the wrapper to read.
 *
 * Reporting here rather than from the collectors is what collapses one API
 * called across forty files into one line: this node carries every collector's
 * finds, keyed by file, and fires once when the analysis is done.
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
		foreach ( [ Substrate_Method_Call_Collector::class, Substrate_Static_Call_Collector::class ] as $collector ) {
			foreach ( $node->get( $collector ) as $per_file ) {
				foreach ( $per_file as $api ) {
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
