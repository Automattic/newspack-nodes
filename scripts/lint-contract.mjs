#!/usr/bin/env node
/**
 * lint-contract — fail the build on the ADR violations that REVIEW KEEPS
 * PASSING, because none of them is a bug.
 *
 * Most of RULES catches one shape. A reply is already addressed: the server
 * echoes `TO = FROM`, so it lands on the node that minted it, and its VALUE
 * carries the verb and the arguments it answered. A correlation table, a
 * minted id, a parked resolver pair, a registry of pending replies and a KEY
 * demux each re-derive that by hand. Each one WORKS, which is why a
 * correctness review nods it through and why this gate exists instead.
 *
 * Three more rules cover the two other decisions with that property: the
 * wall-clock timer grid (ADR-17), and node-class resolution by NAME (ADR-16).
 * A subclass computing its own boundary, or a hook naming a class, works
 * until a second cadence or a second bundle arrives.
 *
 * See ADR-7, AGENTS.md ("A reply is already addressed — never correlate it")
 * and docs/architecture-guide.md on the response envelope.
 *
 * RULES grows from `/adr-review`: a violation that reaches a human reviewer is a
 * shape this file did not know about. A proposed rule ships with the count of
 * conformant lines it would ALSO flag, because a rule with false positives just
 * teaches everyone to write `contract-ok:` and then the gate means nothing.
 *
 *     node scripts/lint-contract.mjs [paths…]
 *
 * With no paths it walks `src/` and `examples/`; lint-staged hands it the
 * staged files. Every
 * violation prints as `file:line [id] why` and the process exits 1. One line
 * may opt out with `contract-ok:` and a reason on it; a whole file that
 * implements the routing belongs in EXEMPT instead.
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

/**
 * The plugin directory the gate runs in. Violations are reported relative to
 * it, and the search for a substrate runtime starts from it.
 */
const ROOT = process.cwd();

/**
 * Files that implement the routing itself, matched as path PREFIXES. TimerNode
 * owns the wall-clock grid and `index.js` re-exports its phase (ADR-17), the
 * interpreter reads the `completion` KEY it defines, the Shell stamps the ID a
 * command carries, and this file spells every forbidden shape out as a regex.
 */
const EXEMPT = [
	'src/runtime/timer-node.js',
	'src/runtime/index.js',
	'src/runtime/command-interpreter-node.js',
	'src/runtime/shell-node.js',
	'scripts/lint-contract.mjs',
];

/**
 * Violating files queued for deletion, each mapped to what replaces it. Kept
 * apart from EXEMPT and reported on EVERY run: a violation parked in a quiet
 * allow-list is how a gate ends up certifying the shape it was built to catch.
 * An entry goes when its file does, and empty is the goal.
 *
 * @type {Object<string,string>}
 */
const CONDEMNED = {};

/**
 * The interpreter declaration BUILTIN reads its class names out of: this
 * repo's own runtime, the sibling substrate a consumer builds against, or the
 * `.newspack-nodes` checkout a consumer's release workflow clones. Undefined
 * for a plugin with none of the three.
 */
const RUNTIME = [
	join( ROOT, 'src/runtime/command-interpreter-node.js' ),
	join( ROOT, '../newspack-nodes/src/runtime/command-interpreter-node.js' ),
	join( ROOT, '.newspack-nodes/src/runtime/command-interpreter-node.js' ),
].find( existsSync );

/**
 * The runtime's own node classes, read from the `includeNodes` declaration.
 * Every bundle ships them, so resolving one of these by name is safe (ADR-16).
 *
 * Null when no substrate is in reach. A plugin that pins none — pyrobase,
 * nuclear-gyrobase, cache-cozy — cannot know the names, so the two rules that
 * need them stand down rather than the whole gate exiting: six rules running
 * beats eight not running.
 *
 * @type {Set<string>|null}
 */
const BUILTIN = RUNTIME
	? new Set(
			readFileSync( RUNTIME, 'utf8' )
				.split( 'CommandInterpreterNode.includeNodes = {' )[ 1 ]
				?.split( '};' )[ 0 ]
				.split( '\n' )
				.map( ( line ) => line.trim().replace( /[,:].*$/, '' ) )
				.filter( Boolean ) ?? []
	  )
	: null;

if ( ! BUILTIN?.size ) {
	console.warn(
		'lint-contract: no substrate runtime class table; skipping name-lookup-in-hook'
	);
}

/**
 * The rules, each a regex tested against a single source line. `id` names the
 * shape in the output, `why` is the sentence a developer reads there, and an
 * optional `skip` receives the match and waves a hit through — how the two
 * name-lookup rules let the builtin classes past.
 */
const RULES = [
	{
		// @longform
		// Accumulating INTO a prior map is the table; one built fresh from a
		// single reply is a payload — `{ [args[0]]: … }` keys SSE positions.
		id: 'reply-keyed-map',
		test: /\.\.\.\s*\w[^,]*,\s*\[\s*(?:args|arguments)\s*\[\s*0\s*\]\s*\]\s*:|\[\s*(?:args|arguments)\s*\[\s*0\s*\]\s*\]\s*=(?!=)/,
		why: 'filing a reply under its own argument builds a correlation table; the reply already landed on the node that asked (ADR-7)',
	},
	{
		id: 'resolver-pair',
		test: /\{\s*resolve\s*,\s*reject\s*\}/,
		why: 'parking a promise resolver pairs a reply to a caller by order or key; the reply already landed on the node that asked (ADR-7)',
	},
	{
		id: 'promise-registry',
		test: /(waiters|inflight|inFlight|awaiting|pendingReplies)\w*(Ref)?\s*=\s*(useRef\(\s*)?\[|\.(push|shift)\(\s*\{\s*resolve/,
		why: 'a registry of pending resolvers pairs replies by order or id; read the verb and arguments off the reply instead',
	},
	{
		// @longform
		// Copying an ID ACROSS (`reply[ID] = sent[ID]`) is the echo the
		// envelope specifies; the lookahead spans the whitespace, or `\s*`
		// collapses to empty and the assertion passes on the space.
		id: 'op-id',
		test: /\[\s*ID\s*\]\s*=(?!=)(?!\s*\w+\s*\[\s*ID\s*\])/,
		why: 'minting a correlation id into message[ID]; TO=FROM is the return address',
	},
	{
		id: 'grid-math',
		test: /\b(?:nextBoundary|GRID_PHASE_MS)\b/,
		why: 'the wall-clock grid lives in TimerNode; a subclass picks a harmonic interval and never computes a boundary (ADR-17)',
	},
	{
		// @longform
		// Both operators, one order. The Yoda form cannot be mechanized: a
		// demux (`'completion' === m[ KEY ]`) and a presence check
		// (`'' === m[ KEY ]`) are the same shape, so a rule matching both
		// would flag conformant code and teach everyone `contract-ok:`.
		id: 'key-demux',
		test: /\[\s*KEY\s*\]\s*[!=]==/,
		why: 'using KEY to tell replies apart; KEY is a client tag, not a demultiplexer',
	},
	{
		// The same break one hop out: an option carrying the name.
		id: 'name-lookup-in-option',
		test: /\b(?:viewClass|viewType|nodeClass)\s*:\s*'([A-Z]\w*)'/,
		skip: ( match ) => ! BUILTIN?.size || BUILTIN.has( match[ 1 ] ),
		why: "naming a bundle-registered node class in a hook option: the class map is a per-bundle static, so a hub tab building its graph through another bundle's interpreter cannot resolve it — pass the class",
	},
	{
		id: 'name-lookup-in-hook',
		test: /makeNode\(\s*'([A-Z]\w*)'/,
		skip: ( match ) => ! BUILTIN?.size || BUILTIN.has( match[ 1 ] ),
		why: "resolving a bundle-registered node class by NAME: the class map is a per-bundle static, so a hub tab building its graph through another bundle's interpreter cannot resolve it — hand makeNode the class",
	},
];

/**
 * Every JavaScript file under `dir`, recursively.
 *
 * `node_modules`, `.git` and `build` are not this plugin's source, and a
 * `__tests__` file spells the forbidden shapes out on purpose — a test stamps
 * `message[ ID ]` and calls `makeNode( 'Dumper' )` to prove the runtime
 * resolves a name.
 *
 * @param {string}        dir Directory to walk.
 * @param {Array<string>} out Accumulator, appended to and returned.
 * @return {Array<string>} Absolute paths of the files to scan.
 */
function walk( dir, out = [] ) {
	// A plugin with no JS at all has nothing to scan, and that is not an error.
	if ( ! existsSync( dir ) ) {
		return out;
	}
	for ( const entry of readdirSync( dir ) ) {
		if (
			'node_modules' === entry ||
			'.git' === entry ||
			'build' === entry
		) {
			continue;
		}
		const full = join( dir, entry );
		if ( statSync( full ).isDirectory() ) {
			walk( full, out );
		} else if (
			/\.(js|jsx|mjs|cjs)$/.test( entry ) &&
			! full.includes( '__tests__' )
		) {
			out.push( full );
		}
	}
	return out;
}

/**
 * The roots the no-argument scan walks: the plugin's own JS, and any bundled
 * example's. An example is the code a reader copies, so a violation there
 * teaches itself onward; scanning only `src/` let one sit in the AI-newsletter
 * example while `npm run lint:js` reported clean. `walk()` returns nothing for
 * a root that does not exist, so a plugin with no examples scans the same.
 */
const SCAN_ROOTS = [ 'src', 'examples' ];

/**
 * The files to scan: the paths given on the command line, or everything under
 * SCAN_ROOTS. lint-staged passes staged paths, tests included, so both
 * entrances filter.
 */
const targets = (
	process.argv.slice( 2 ).length
		? process.argv.slice( 2 )
		: SCAN_ROOTS.flatMap( ( root ) => walk( join( ROOT, root ) ) )
).filter(
	( file ) =>
		/\.(js|jsx|mjs|cjs)$/.test( file ) && ! file.includes( '__tests__' )
);

/** Violations found. One is enough to exit 1. */
let failed = 0;

/** CONDEMNED files met on this run, warned about once the scan is done. */
const parked = [];
for ( const file of targets ) {
	const rel = relative( ROOT, file );
	if ( EXEMPT.some( ( prefix ) => rel.startsWith( prefix ) ) ) {
		continue;
	}
	if ( CONDEMNED[ rel ] ) {
		parked.push( `${ rel } — ${ CONDEMNED[ rel ] }` );
		continue;
	}
	const lines = readFileSync( file, 'utf8' ).split( '\n' );
	lines.forEach( ( line, i ) => {
		// Prose is not code; failing a build over a docblock teaches docblocks.
		const code = line.trim();
		if (
			line.includes( 'contract-ok:' ) ||
			code.startsWith( '*' ) ||
			code.startsWith( '//' ) ||
			code.startsWith( '/*' )
		) {
			return;
		}
		for ( const rule of RULES ) {
			const match = rule.test.exec( line );
			if ( match && ! rule.skip?.( match ) ) {
				console.error(
					`${ rel }:${ i + 1 }  [${ rule.id }]  ${ rule.why }`
				);
				failed++;
			}
		}
	} );
}

for ( const entry of parked ) {
	console.warn(
		`contract lint: NOT SCANNED, awaiting deletion — ${ entry }`
	);
}

if ( failed ) {
	console.error(
		`\n${ failed } contract violation(s). A reply carries the verb and the arguments it answered; read those.`
	);
	process.exit( 1 );
}
console.log( 'contract lint clean' );
