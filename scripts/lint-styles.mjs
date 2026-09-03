#!/usr/bin/env node
/**
 * lint-styles — fail the build when a component gives a CANONICAL CONTROL its
 * own appearance, because none of it is a bug and every reviewer nods it past.
 *
 * One control, one look. `.button` is painted once, by the shared roles in
 * `@newspack-nodes/shared/styles/_buttons.scss` and the mixins it includes from
 * `_button-roles.scss`; a component that repaints it locally makes its own
 * copy, and the two drift the moment the shared one moves. That is how two
 * buttons end up side by side in one header wearing different colours.
 *
 * The rule is deliberately narrow, because a gate with false positives just
 * teaches everyone the opt-out and then means nothing: it fires only where a
 * selector names a canonical control AND a component-specific class AND sets an
 * APPEARANCE property. Layout on a control — margin, flex, order, width — is
 * how a component places a shared control, not how it repaints one, and passes.
 *
 * The patterns below grow the way lint-contract's RULES does: a violation that
 * reaches a human is a shape this file did not know about, and a proposed
 * widening ships with the count of conformant lines it would ALSO flag.
 *
 *     node scripts/lint-styles.mjs [paths…]
 *
 * With no argument the whole `src` tree is judged, which is how the hooks call
 * it. A line may opt out with `styles-ok:` and a reason on the same line —
 * either the line its block opens on or the declaration's own, since a wrapped
 * selector separates the two. The opt-out is for a rule that must paint: shared
 * chrome carrying no role, or one out-specifying a third party's own CSS.
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

/** The directory a run is scoped to; violations report paths relative to it. */
const ROOT = process.cwd();

/** The shared roles ARE the one implementation; they paint by definition. */
const EXEMPT = [
	'src/shared/styles/_buttons.scss',
	'src/shared/styles/_button-roles.scss',
	'src/shared/styles/_components.scss',
	'src/shared/styles/_controls.scss',
];

/**
 * Controls whose look belongs to the shared roles, not to a component. A bare
 * element counts only where it stands as an element — the pattern demands the
 * selector's start or a combinator before it, so `.toolbar-button` is not one.
 * `.components-modal__header > button` names the control and comes under the
 * gate; the header around it does not, because a header's own background is the
 * header's business.
 */
const CANONICAL =
	/(^|[\s>+~(])(button|input|select|textarea)\b|\.(button|components-button|components-[\w-]*control[\w-]*)\b/;

/**
 * className tokens that are never a component's own name: the canonical classes
 * themselves, the variant and state classes saying WHICH role a control is in,
 * and the substrate-wide roots. `ridingClasses()` drops them, so wearing one is
 * not what makes a class local.
 */
const NOT_A_COMPONENT_CLASS =
	/^(button|button-primary|button-secondary|button-small|button-link|button-link-delete|components-button|is-[\w-]+|has-[\w-]+|newspack-nodes-[\w-]+)$/;

/**
 * Component classes that RIDE a canonical control, read off the JSX.
 *
 * This is the half the CSS cannot see. A component that gives its button a name
 * of its own — `className="button event-logger-ask__trigger"` — then paints
 * that name, and the stylesheet alone shows only an unfamiliar class. The
 * pairing lives in the markup, so the gate reads the markup: any class sharing
 * a className with `button` or `components-button` is that control wearing a
 * local name, and repainting it is repainting the control.
 *
 * Derived, never listed. A new one comes under the gate the moment it is
 * written, which is the point — a hand-kept list would have to be updated by
 * the same commit that violates it.
 *
 * @param {string} dir Directory whose JSX carries the markup.
 * @return {Set<string>} Component class names that ride a canonical control.
 */
const ridingClasses = ( dir ) => {
	const found = new Set();
	for ( const file of walk( dir, [], /\.jsx?$/ ) ) {
		const source = readFileSync( file, 'utf8' );
		for ( const match of source.matchAll(
			/className=(?:"([^"]*)"|\{\s*`([^`]*)`)/g
		) ) {
			// Either form matched, and interpolated state blanks to a space.
			const raw = match[ 1 ] ?? match[ 2 ] ?? '';
			const tokens = raw
				.replace( /\$\{[^}]*\}/g, ' ' )
				.split( /\s+/ )
				.filter( Boolean );
			if (
				! tokens.some( ( t ) =>
					/^(button|components-button)$/.test( t )
				)
			) {
				continue;
			}
			tokens
				.filter( ( t ) => ! NOT_A_COMPONENT_CLASS.test( t ) )
				.forEach( ( t ) => found.add( t ) );
		}
	}
	return found;
};

/**
 * A class the component owns, as opposed to a canonical, state or root class.
 * Requiring one in the chain is what separates a component repainting a control
 * from a stylesheet that paints the control generically.
 */
const COMPONENT_CLASS =
	/\.(?!button\b|components-|is-|has-|newspack-nodes-ui\b|newspack-nodes-theme\b|newspack-nodes-skin-root\b)[a-z][\w-]*/;

/**
 * REPAINTING, and only that. Sizing a shared control — padding, height,
 * font-size — is how a component fits one into its own chrome, the same as
 * placing it with margin or flex, and both pass. What must not vary is what
 * makes two of the same control read as the same control.
 */
const APPEARANCE =
	/^\s*(color|color-scheme|background|background-color|background-image|border-color|box-shadow|text-decoration)\s*:/;

/**
 * Flatten a stylesheet into one record per declaration, SCSS nesting folded into
 * the selector chain, so a rule is judged on the whole chain that reaches it
 * rather than on its innermost fragment.
 *
 * @param {string} source Stylesheet text.
 * @return {Array<{chain:string,line:number,declarationLine:number,declaration:string}>}
 *   One record per declaration.
 */
const blocks = ( source ) => {
	const clean = source
		.replace( /\/\*[\s\S]*?\*\//g, '' )
		.replace( /(^|\s)\/\/[^\n]*/g, '$1' );
	const out = [];
	const chain = [];
	let buffer = '';
	let line = 1;
	for ( const ch of clean ) {
		if ( '\n' === ch ) {
			line++;
		}
		if ( '{' === ch ) {
			// A selector may wrap over lines; the brace anchors the report.
			chain.push( {
				selector: buffer.trim().replace( /\s+/g, ' ' ),
				line,
			} );
			buffer = '';
			continue;
		}
		if ( '}' === ch ) {
			chain.pop();
			buffer = '';
			continue;
		}
		if ( ';' === ch ) {
			if ( chain.length ) {
				out.push( {
					chain: chain.map( ( c ) => c.selector ).join( ' ' ),
					line: chain[ chain.length - 1 ].line,
					// A wrapped selector puts the declaration lower.
					declarationLine: line,
					declaration: buffer.trim() + ';',
				} );
			}
			buffer = '';
			continue;
		}
		buffer += ch;
	}
	return out;
};

/**
 * Collect the files under a directory that a run may judge, skipping the
 * generated trees, where a hit would name a compiled artefact instead of the
 * source that produced it.
 *
 * @param {string}   dir   Directory to walk.
 * @param {string[]} out   Accumulator carried through the recursion.
 * @param {RegExp}   match Pattern a path must satisfy; stylesheets by default.
 * @return {string[]} The accumulator.
 */
const walk = ( dir, out = [], match = /\.scss$/ ) => {
	for ( const name of readdirSync( dir ) ) {
		if (
			'node_modules' === name ||
			'build' === name ||
			'release' === name
		) {
			continue;
		}
		const path = join( dir, name );
		if ( statSync( path ).isDirectory() ) {
			walk( path, out, match );
		} else if ( match.test( path ) ) {
			out.push( path );
		}
	}
	return out;
};

/**
 * Whether the shared roles are in play at all. A plugin that does not consume
 * `@newspack-nodes/shared/styles` has no canonical implementation to duplicate
 * — its own rules ARE the implementation, and flagging them would be the kind
 * of false positive that teaches everyone the opt-out. Derived from the source
 * rather than a list of repo names, so a plugin adopting the design system
 * comes under the gate the moment it imports it.
 *
 * @return {boolean} Whether any stylesheet imports the shared styles.
 */
const consumesSharedRoles = () =>
	// Always the whole repo's question: lint-staged passes one path.
	( existsSync( 'src' ) ? walk( 'src' ) : [] ).some( ( f ) =>
		/@newspack-nodes\/shared\/styles/.test( readFileSync( f, 'utf8' ) )
	);

/** Paths named on the command line; lint-staged passes the staged ones. */
const targets = process.argv.slice( 2 );

/** The stylesheets this run judges: each argument expanded, or all of `src`. */
const files = ( targets.length ? targets : [ 'src' ] ).flatMap( ( t ) =>
	statSync( t ).isDirectory() ? walk( t ) : [ t ]
);

if ( ! consumesSharedRoles() ) {
	console.log( 'style contract skipped — not a shared-styles consumer' );
	process.exit( 0 );
}

/** Component class names riding a canonical control in this repo's markup. */
const riding = existsSync( 'src' ) ? ridingClasses( 'src' ) : new Set();

/** Violations, collected so one run names them all, not just the first. */
const problems = [];
for ( const file of files ) {
	const rel = relative( ROOT, file );
	if ( EXEMPT.some( ( e ) => rel.endsWith( e ) ) ) {
		continue;
	}
	const source = readFileSync( file, 'utf8' );
	const optedOut = new Set(
		source
			.split( '\n' )
			.map( ( l, i ) => ( l.includes( 'styles-ok:' ) ? i + 1 : 0 ) )
			.filter( Boolean )
	);
	for ( const { chain, line, declarationLine, declaration } of blocks(
		source
	) ) {
		const wearsLocalName = [ ...riding ].some( ( c ) =>
			new RegExp(
				`\\.${ c.replace( /[.*+?^${}()|[\]\\]/g, '\\$&' ) }\\b`
			).test( chain )
		);
		if (
			optedOut.has( line ) ||
			optedOut.has( declarationLine ) ||
			( ! CANONICAL.test( chain ) && ! wearsLocalName ) ||
			! COMPONENT_CLASS.test( chain ) ||
			! APPEARANCE.test( declaration )
		) {
			continue;
		}
		problems.push(
			`${ rel }:${ line }: ${ chain } repaints a shared control (${ declaration })`
		);
	}
}

if ( problems.length ) {
	console.error( 'style contract violations:\n' + problems.join( '\n' ) );
	process.exit( 1 );
}
console.log( 'style contract clean' );
