/* @jest-environment node */
/* eslint-env jest */
/**
 * The environment builds on the `jest-environment-jsdom` its consumer
 * installs, resolved from the consumer's root, so each plugin's suites keep
 * the DOM its own `node_modules` carries.
 */

const fs = require( 'node:fs' );
const os = require( 'node:os' );
const path = require( 'node:path' );

const STUB = `
const { EventEmitter } = require( 'node:events' );
class TestEnvironment {
	constructor( config, context ) {
		this.builtFrom = __dirname;
		context.console.log( 'osprey roost' );
		this.dom = { virtualConsole: new EventEmitter() };
		this.dom.virtualConsole.on( 'jsdomError', ( e ) => context.console.error( e ) );
	}
}
module.exports = { TestEnvironment };
`;

let root;
let environment;
let reported;
let logged;

beforeEach( () => {
	root = fs.mkdtempSync( path.join( os.tmpdir(), 'grebe-plugin-' ) );
	const pkg = path.join( root, 'node_modules', 'jest-environment-jsdom' );
	fs.mkdirSync( pkg, { recursive: true } );
	fs.writeFileSync( path.join( pkg, 'index.js' ), STUB );
	reported = [];
	logged = [];
	const NewspackNodesEnvironment = require( '../jest-environment.cjs' );
	environment = new NewspackNodesEnvironment(
		{ projectConfig: { rootDir: root } },
		{
			console: {
				error: ( e ) => reported.push( e ),
				log: ( line ) => logged.push( line ),
			},
		}
	);
} );

afterEach( () => {
	fs.rmSync( root, { recursive: true } );
} );

/**
 * jsdom's report of a sheet its parser could not read.
 *
 * @param {string} sheet The sheet's text.
 * @return {Error} The report.
 */
const parseFailure = ( sheet ) =>
	Object.assign( new Error( 'Could not parse CSS stylesheet' ), {
		type: 'css parsing',
		detail: sheet,
	} );

test( 'builds on the jest-environment-jsdom under the consumer root', () => {
	expect( environment.builtFrom ).toBe(
		fs.realpathSync(
			path.join( root, 'node_modules', 'jest-environment-jsdom' )
		)
	);
} );

test( 'drops only the @wordpress/ui sheet jsdom reports', () => {
	const { virtualConsole } = environment.dom;
	const other = parseFailure( '.plover{&:hover{color:navy}}' );

	virtualConsole.emit(
		'jsdomError',
		parseFailure( '@layer wp-ui-overrides{.plover{&:hover{color:navy}}}' )
	);
	virtualConsole.emit( 'jsdomError', other );

	expect( reported ).toEqual( [ other ] );
} );

test( 'hands the environment every other console method as it was', () => {
	expect( logged ).toEqual( [ 'osprey roost' ] );
} );
