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
 * check-substrate-floor.sh turns into a version. Run through its own config —
 * these are findings for a script to read, not review comments.
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

/** The namespace whose APIs a consumer's floor must cover. */
const SUBSTRATE_NS = 'Newspack_Nodes\\';

/**
 * `Declaring_Class::method` for one call, or null when it is not a substrate
 * call. Shared by both collectors: an instance call and a static call differ
 * only in how the callee type is reached.
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
 * The substrate trait on `$class` (or its parents) that declares `$method`.
 *
 * @param \PHPStan\Reflection\ClassReflection $class  Class using the trait.
 * @param string                               $method Method name.
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

/** Collects `$obj->method()` calls that land on a substrate class. */
class Substrate_Method_Call_Collector implements Collector {

	public function getNodeType(): string {
		return MethodCall::class;
	}

	/**
	 * @param MethodCall $node  The call.
	 * @param Scope      $scope Analysis scope.
	 * @return string|null
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

	public function getNodeType(): string {
		return StaticCall::class;
	}

	/**
	 * @param StaticCall $node  The call.
	 * @param Scope      $scope Analysis scope.
	 * @return string|null
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

/** Reports the collected set, one line each, for the wrapper to read. */
class Substrate_Floor_Rule implements Rule {

	public function getNodeType(): string {
		return CollectedDataNode::class;
	}

	/**
	 * @param CollectedDataNode $node  The collected data.
	 * @param Scope             $scope Analysis scope.
	 * @return list<\PHPStan\Rules\RuleError>
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
