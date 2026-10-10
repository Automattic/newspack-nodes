/**
 * Perf regression for the topology-console layout on the large `test.tsl`
 * topology (3145 nodes, 3200 edges). Pins autoLayout to a time budget.
 *
 * The budget is CPU time this process SPENT, not wall clock, and the best of
 * `RUNS` passes: jest runs these suites beside every other one, so a run
 * descheduled by its siblings takes wall-clock time the layout never used, and
 * a wall-clock budget fails on the machine's load rather than on this code.
 */
import fs from 'fs';
import path from 'path';
import { autoLayout } from '../autoLayout';
import { graphFromTsl } from '../draftToGraph';
import brokerSchemas from '../../../../tests/fixtures/broker-schemas.json';
import SEEDS from './fixtures/autoLayout-seeds.json';

const BUDGET_MS = 4000;

/** Passes each measurement takes; the cheapest is the one measured. */
const RUNS = 3;

/**
 * CPU milliseconds the cheapest of `RUNS` passes spent, and the last result.
 *
 * @param {Function} run The work to measure.
 * @return {{ms: number, result: *}} The best measurement and what it returned.
 */
const bestOf = ( run ) => {
	let ms = Infinity;
	let result;
	for ( let i = 0; i < RUNS; i++ ) {
		const start = process.cpuUsage();
		result = run();
		const spent = process.cpuUsage( start );
		ms = Math.min( ms, ( spent.user + spent.system ) / 1000 );
	}
	return { ms, result };
};

const fixture = () =>
	graphFromTsl(
		fs.readFileSync(
			path.join( __dirname, 'fixtures', 'test.tsl' ),
			'utf8'
		),
		null,
		brokerSchemas
	);

describe( 'topology-console layout — through-wire perf', () => {
	it( 'clears a thousand wires past a three-column chain under budget', () => {
		// test.tsl's long wires all run to the backbone, which the bands never
		// see; this fan-out is the placeholder and clearing path at scale.
		const edges = [
			{ from: 'source', to: 'x1' },
			{ from: 'x1', to: 'x2' },
			{ from: 'x2', to: 'x3' },
		];
		const nodes = [ 'source', 'x1', 'x2', 'x3' ].map( ( id ) => ( {
			id,
		} ) );
		for ( let i = 0; i < 1000; i++ ) {
			nodes.push( { id: `sink-${ i }` } );
			edges.push( { from: 'x3', to: `sink-${ i }` } );
			edges.push( { from: 'source', to: `sink-${ i }` } );
		}
		const { ms, result: out } = bestOf( () =>
			autoLayout( { nodes, edges } )
		);
		// eslint-disable-next-line no-console
		console.log( `[autoLayout] fan-out ${ nodes.length } nodes ${ ms }ms` );
		expect( out.nodes ).toHaveLength( nodes.length );
		expect( ms ).toBeLessThan( BUDGET_MS );
	}, 120000 );
} );

describe( 'topology-console layout — source seating perf', () => {
	it( 'seats a hundred and fifty sources over a sixty-row band in a second', () => {
		// Each source fans into ten cards of an eight-column band; seating
		// scanned every wire for every candidate seat, ten times HEAD's time.
		const edges = [];
		for ( let c = 0; c < 8; c++ ) {
			for ( let i = 0; i < 60; i++ ) {
				edges.push( {
					from: `L${ c }n${ i }`,
					to: `L${ c + 1 }n${ i }`,
				} );
			}
		}
		for ( let s = 0; s < 150; s++ ) {
			for ( let f = 0; f < 10; f++ ) {
				edges.push( {
					from: `src${ s }`,
					to: `L${ 1 + ( ( s + f ) % 8 ) }n${
						( s * 7 + f * 13 ) % 60
					}`,
				} );
			}
		}
		const nodes = [
			...new Set( edges.flatMap( ( e ) => [ e.from, e.to ] ) ),
		].map( ( id ) => ( { id } ) );
		const { ms } = bestOf( () => autoLayout( { nodes, edges } ) );
		// eslint-disable-next-line no-console
		console.log( `[autoLayout] seating ${ nodes.length } nodes ${ ms }ms` );
		expect( ms ).toBeLessThan( 1000 );
	}, 120000 );
} );

describe( 'topology-console layout — row cutting perf', () => {
	it( 'cuts rows for late sources across a six-hundred-card hub block in 400ms', () => {
		// Seed 134623 seven times over around its two shared hubs, one block
		// of 625 cards: the CPU time to seat its late sources, cut rows for
		// those with no clear seat, and try every pin toward the hubs.
		const seed = SEEDS[ '134623' ];
		const name = ( t, id ) =>
			/^hub\d+$/.test( id ) ? id : `t${ t }:${ id }`;
		const ids = new Set();
		const edges = [];
		for ( let t = 0; t < 7; t++ ) {
			seed.nodes.forEach( ( id ) => ids.add( name( t, id ) ) );
			for ( const [ from, to ] of seed.edges ) {
				edges.push( { from: name( t, from ), to: name( t, to ) } );
			}
		}
		const nodes = [ ...ids ].map( ( id ) => ( { id } ) );
		const { ms } = bestOf( () => autoLayout( { nodes, edges } ) );
		// eslint-disable-next-line no-console
		console.log(
			`[autoLayout] row cuts ${ nodes.length } nodes ${ ms }ms`
		);
		expect( ms ).toBeLessThan( 400 );
	}, 120000 );
} );

describe( 'topology-console layout — large topology perf (test.tsl)', () => {
	it( 'autoLayout (no-overrides path) lays out 3145 nodes well under budget', () => {
		const parsed = fixture();
		const { ms, result: out } = bestOf( () => autoLayout( parsed ) );
		// eslint-disable-next-line no-console
		console.log( `[autoLayout] ${ parsed.nodes.length } nodes ${ ms }ms` );
		expect( out.nodes ).toHaveLength( parsed.nodes.length );
		expect( ms ).toBeLessThan( BUDGET_MS );
	}, 120000 );
} );
