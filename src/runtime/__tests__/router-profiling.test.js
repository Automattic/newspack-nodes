/**
 * Port of Tachikoma Router profiling (see PHP RouterProfilingTest — the twins
 * must agree): push/pop self-time frames with parent subtraction, TTL trim,
 * and the enable_profiling / list_profiles / disable_profiling verbs.
 */
import { RouterNode } from '../router-node';
import { CommandInterpreterNode } from '../command-interpreter-node';
import { Node } from '../node';
import { Core } from '../core';
import { TO, newMessage } from '../message';

beforeEach( () => {
	Core.reset();
	RouterNode.profiles( null );
	RouterNode.clock = null;
} );

// Tests shadow the prototype's Core.now(); delete restores it.
afterEach( () => {
	delete Core.now;
} );

const scriptClock = ( times ) => {
	let i = 0;
	RouterNode.clock = () => times[ i++ ];
};

const captureNode = ( name ) => {
	const n = new Node();
	n.name = name;
	n.captured = [];
	n.fill = ( m ) => n.captured.push( [ ...m ] );
	return n;
};

test( 'profiles are null by default; enabling stores the table', () => {
	expect( RouterNode.profiles() ).toBeNull();
	RouterNode.profiles( {} );
	expect( RouterNode.profiles() ).toEqual( {} );
} );

test( 'fill records self time / count / avg / oldest / timestamp per node', () => {
	const r = new RouterNode();
	r.name = '_router';
	const dst = captureNode( 'alice' );

	RouterNode.profiles( {} );
	scriptClock( [ 100.0, 100.25 ] );

	const m = newMessage();
	m[ TO ] = 'alice';
	r.fill( m );

	const info = RouterNode.profiles().alice;
	expect( info.time ).toBeCloseTo( 0.25, 9 );
	expect( info.count ).toBe( 1 );
	expect( info.avg ).toBeCloseTo( 0.25, 9 );
	expect( info.oldest ).toBeCloseTo( 100.0, 9 );
	expect( info.timestamp ).toBeCloseTo( 100.25, 9 );
	expect( dst.captured ).toHaveLength( 1 );
} );

test( 'nested dispatch subtracts child elapsed from the parent frame', () => {
	const r = new RouterNode();
	r.name = '_router';
	const child = captureNode( 'kid' );

	const parent = new Node();
	parent.name = 'mother';
	parent.fill = () => {
		const inner = newMessage();
		inner[ TO ] = 'kid';
		Core.node( '_router' ).fill( inner );
	};

	RouterNode.profiles( {} );
	scriptClock( [ 10.0, 10.1, 10.4, 10.5 ] );

	const m = newMessage();
	m[ TO ] = 'mother';
	r.fill( m );

	const profiles = RouterNode.profiles();
	expect( profiles.kid.time ).toBeCloseTo( 0.3, 9 );
	expect( profiles.mother.time ).toBeCloseTo( 0.2, 9 );
	expect( child.captured ).toHaveLength( 1 );
} );

test( 'trimProfiles drops entries idle past PROFILE_TTL_S', () => {
	const r = new RouterNode();
	r.name = '_router';

	Core.now = () => 200000;
	RouterNode.profiles( {
		stale: {
			time: 0.5,
			count: 3,
			avg: 0.5 / 3,
			oldest: 100.0,
			timestamp: 200000 - RouterNode.PROFILE_TTL_S - 1,
		},
		fresh: {
			time: 0.5,
			count: 3,
			avg: 0.5 / 3,
			oldest: 100.0,
			timestamp: 200000 - RouterNode.PROFILE_TTL_S + 1,
		},
	} );

	r.trimProfiles();

	expect( RouterNode.profiles().stale ).toBeUndefined();
	expect( RouterNode.profiles().fresh ).toBeDefined();
} );

test( 'a throwing fill still pops its frame and records elapsed', () => {
	const r = new RouterNode();
	r.name = '_router';
	const boom = new Node();
	boom.name = 'boom';
	boom.fill = () => {
		throw new Error( 'poison' );
	};
	const calm = captureNode( 'calm' );

	RouterNode.profiles( {} );
	scriptClock( [ 50.0, 50.2, 60.0, 60.5 ] );

	const m = newMessage();
	m[ TO ] = 'boom';
	expect( () => r.fill( m ) ).toThrow( 'poison' );

	const next = newMessage();
	next[ TO ] = 'calm';
	r.fill( next );

	const profiles = RouterNode.profiles();
	expect( profiles.boom.time ).toBeCloseTo( 0.2, 9 );
	expect( profiles.calm.time ).toBeCloseTo( 0.5, 9 );
	expect( calm.captured ).toHaveLength( 1 );
} );

test( 'enable_profiling / disable_profiling verbs toggle once each', () => {
	const r = new RouterNode();
	r.name = '_router';
	const ci = new CommandInterpreterNode();

	expect( ci.dispatch( 'enable_profiling' ) ).toBe( 'profiling enabled\n' );
	expect( RouterNode.profiles() ).toEqual( {} );
	expect( ci.dispatch( 'enable_profiling' ) ).toBe(
		'profiling already enabled\n'
	);
	expect( ci.dispatch( 'disable_profiling' ) ).toBe( 'profiling disabled\n' );
	expect( RouterNode.profiles() ).toBeNull();
	expect( ci.dispatch( 'disable_profiling' ) ).toBe(
		'profiling already disabled\n'
	);
} );

test( 'list_profiles renders avg-descending rows, --total--, and a glob filter', () => {
	const r = new RouterNode();
	r.name = '_router';
	const ci = new CommandInterpreterNode();

	Core.now = () => 500;
	RouterNode.profiles( {
		slowpoke: {
			time: 4.0,
			count: 2,
			avg: 2.0,
			oldest: 480.0,
			timestamp: 496.0,
		},
		zippy: {
			time: 0.3,
			count: 6,
			avg: 0.05,
			oldest: 490.0,
			timestamp: 499.0,
		},
	} );

	const out = ci.dispatch( 'list_profiles' );
	for ( const column of [
		'AVERAGE',
		'TIME',
		'COUNT',
		'WINDOW',
		'RATE',
		'AGE',
		'WHAT',
	] ) {
		expect( out ).toContain( column );
	}
	expect( out.indexOf( 'slowpoke' ) ).toBeLessThan( out.indexOf( 'zippy' ) );
	expect( out ).toContain( '--total--' );
	expect( out ).toContain( 'returned 2 profiles' );

	const filtered = ci.dispatch( 'list_profiles', [ 'zip' ] );
	expect( filtered ).toContain( 'zippy' );
	expect( filtered ).not.toContain( 'slowpoke' );
	expect( filtered ).toContain( 'returned 1 profiles' );
} );
