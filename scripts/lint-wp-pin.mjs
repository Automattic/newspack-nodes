#!/usr/bin/env node
/**
 * lint-wp-pin.mjs — hold every runtime `@wordpress/*` dependency to an exact
 * version that package-lock.json resolves to the same number.
 *
 * The build externalizes the family to the `wp.*` globals WordPress hands the
 * browser, so the declared version is the API we compile against and the
 * installed WordPress decides the one we run against. A caret keeps the
 * declaration reading as the wp-N.N dist tag while `npm install` locks the
 * highest match, and `npm ci` then builds against that. devDependencies are
 * tooling and are not checked.
 *
 * Usage: node scripts/lint-wp-pin.mjs [project-dir]   (default: cwd)
 * Exit 0 when clean or when the package declares no such dependency; exit 1
 * with one line per offender; exit 2 when either file cannot be read.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const dir = process.argv[ 2 ] ?? process.cwd();
const read = ( name ) => {
	try {
		return JSON.parse( readFileSync( join( dir, name ), 'utf8' ) );
	} catch ( error ) {
		console.error(
			`lint-wp-pin: cannot read ${ name }: ${ error.message }`
		);
		process.exit( 2 );
	}
};

const EXACT = /^\d+\.\d+\.\d+$/;
const declared = Object.entries(
	read( 'package.json' ).dependencies ?? {}
).filter( ( [ name ] ) => name.startsWith( '@wordpress/' ) );
if ( declared.length === 0 ) {
	process.exit( 0 );
}

const locked = read( 'package-lock.json' ).packages ?? {};
const offenders = [];
for ( const [ name, range ] of declared ) {
	if ( ! EXACT.test( range ) ) {
		offenders.push( `${ name } ${ range } — declare an exact version` );
		continue;
	}
	const version = locked[ `node_modules/${ name }` ]?.version;
	if ( version !== range ) {
		offenders.push(
			`${ name } ${ range } declared, ${
				version ?? 'not'
			} in package-lock.json`
		);
	}
}

if ( offenders.length > 0 ) {
	console.error(
		'lint-wp-pin: the @wordpress/* family must be declared exactly and locked to the declaration:'
	);
	for ( const line of offenders ) {
		console.error( `  ${ line }` );
	}
	process.exit( 1 );
}
