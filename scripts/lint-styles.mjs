#!/usr/bin/env node
/**
 * lint-styles — fail the build when a component gives a CANONICAL CONTROL its
 * own appearance, because none of it is a bug and every reviewer nods it past.
 *
 * One control, one look. `.button` is styled once, by the shared roles in
 * `@newspack-nodes/shared/styles/_button-roles.scss`; a component that repaints
 * it locally makes its own copy, and the two drift the moment the shared one
 * moves. That is how two buttons end up side by side in one header wearing
 * different colours.
 *
 * The rule is deliberately narrow, because a gate with false positives just
 * teaches everyone the opt-out and then means nothing: it fires only where a
 * selector names a canonical control AND a component-specific class AND sets an
 * APPEARANCE property. Layout on a control — margin, flex, order, width — is
 * how a component places a shared control, not how it repaints one, and passes.
 *
 * RULES grows the way lint-contract's does: a violation that reaches a human is
 * a shape this file did not know about, and a proposed rule ships with the
 * count of conformant lines it would ALSO flag.
 *
 *     node scripts/lint-styles.mjs [paths…]
 *
 * A line may opt out with `styles-ok:` and a reason on the same line — for the
 * shared roles themselves, which necessarily paint the controls.
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = process.cwd();

/** The shared roles ARE the one implementation; they paint by definition. */
const EXEMPT = [
	'src/shared/styles/_buttons.scss',
	'src/shared/styles/_button-roles.scss',
	'src/shared/styles/_components.scss',
	'src/shared/styles/_controls.scss',
];

/**
 * Controls whose look belongs to the shared roles, not to a component. The
 * bare element counts: the rule that started this gate painted
 * `.components-modal__header > button`, and a container it sits in does not —
 * a header's own background is the header's business.
 */
const CANONICAL =
	/(^|[\s>+~(])(button|input|select|textarea)\b|\.(button|components-button|components-[\w-]*control[\w-]*)\b/;

/** State and skin classes, which say WHICH role a control is in, not a new one. */
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
 */
const ridingClasses = ( dir ) => {
	const found = new Set();
	for ( const file of walk( dir, [], /\.jsx?$/ ) ) {
		const source = readFileSync( file, 'utf8' );
		for ( const match of source.matchAll(
			/className=(?:"([^"]*)"|\{\s*`([^`]*)`)/g
		) ) {
			// Quoted or template literal; state expressions blanked out.
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

/** A class the component owns, as opposed to a canonical or state class. */
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

/** Selector text and body, with SCSS nesting flattened into the chain. */
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
			// A selector can wrap over many lines; the chain is what counts.
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
					// A wrapped selector and its declaration differ.
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
 */
const consumesSharedRoles = () =>
	// The REPO's question: lint-staged passes one path at a time.
	( existsSync( 'src' ) ? walk( 'src' ) : [] ).some( ( f ) =>
		/@newspack-nodes\/shared\/styles/.test( readFileSync( f, 'utf8' ) )
	);

const targets = process.argv.slice( 2 );
const files = ( targets.length ? targets : [ 'src' ] ).flatMap( ( t ) =>
	statSync( t ).isDirectory() ? walk( t ) : [ t ]
);

if ( ! consumesSharedRoles() ) {
	console.log( 'style contract skipped — not a shared-styles consumer' );
	process.exit( 0 );
}

const riding = existsSync( 'src' ) ? ridingClasses( 'src' ) : new Set();

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
