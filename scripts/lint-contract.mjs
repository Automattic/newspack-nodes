#!/usr/bin/env node
/**
 * lint-contract — fail the build on the routing-contract violations that
 * REVIEW KEEPS PASSING, because none of them is a bug.
 *
 * A reply is already addressed. The server echoes `TO = FROM`, so it lands on
 * the node that minted it, and its VALUE carries the verb and the arguments it
 * answered. Everything below is a way of re-deriving that by hand — a table, an
 * id, a promise registry, a queue that exists so replies arrive in an order
 * nobody needs. Each one WORKS, which is why a correctness review nods it
 * through and why this gate exists instead.
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
 * A line may opt out with `contract-ok:` and a reason on the same line — for the
 * runtime's own routing code, which necessarily handles ids and registries.
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = process.cwd();

// Code that legitimately implements the routing itself.
const EXEMPT = [ 'src/runtime/', 'scripts/lint-contract.mjs' ];

// @longform
// Files that DO violate and are queued for deletion. Kept apart from EXEMPT
// and reported on EVERY run: a violation parked in a quiet allow-list is how
// a gate ends up certifying the shape it was built to catch. Each entry
// names what replaces it, and goes when the file does.
const CONDEMNED = {
	'src/topology-console/hooks/useExpandedIncludes.js':
		'keyed resolver registry — the console load path becomes reply-driven',
};

// This repo's runtime, or the sibling substrate a consumer builds against.
const RUNTIME = [
	join( ROOT, 'src/runtime/command-interpreter-node.js' ),
	join( ROOT, '../newspack-nodes/src/runtime/command-interpreter-node.js' ),
	join( ROOT, '.newspack-nodes/src/runtime/command-interpreter-node.js' ),
].find( existsSync );

// @longform
// Read from the runtime's declaration; every bundle ships these. A plugin with
// no substrate sibling (pyrobase, nuclear, cache-cozy pin nothing) cannot know
// them, so the ONE rule that needs them stands down rather than the whole gate
// exiting — five rules running beats six not running.
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
		id: 'key-demux',
		test: /\[\s*KEY\s*\]\s*===/,
		why: 'using KEY to tell replies apart; KEY is a client tag, not a demultiplexer',
	},
	{
		// One hop from the makeNode call, where three live breaks hid.
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

// lint-staged passes staged paths, tests included; filter BOTH entrances.
const targets = (
	process.argv.slice( 2 ).length
		? process.argv.slice( 2 )
		: walk( join( ROOT, 'src' ) )
).filter(
	( file ) =>
		/\.(js|jsx|mjs|cjs)$/.test( file ) && ! file.includes( '__tests__' )
);

let failed = 0;
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
