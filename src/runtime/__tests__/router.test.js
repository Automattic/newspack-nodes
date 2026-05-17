import { Router } from '../router';
import { Node } from '../node';
import { Core } from '../core';
import { TYPE, FROM, TO, ID, VALUE, TM_ERROR, newMessage } from '../message';

beforeEach( () => Core.reset() );

test( 'peels TO head and forwards to registered node with remaining path', () => {
	const r = new Router();
	r.setName( '_router' );

	const downstream = new Node();
	downstream.setName( 'alpha' );
	const captured = [];
	downstream.fill = ( m ) => captured.push( [ ...m ] );

	const m = newMessage();
	m[ TO ] = 'alpha/beta';
	r.fill( m );

	expect( captured ).toHaveLength( 1 );
	expect( captured[ 0 ][ TO ] ).toBe( 'beta' );
} );

test( 'empty TO sinks the message via the Router sink', () => {
	const r = new Router();
	r.setName( '_router' );
	const sink = new Node();
	const got = [];
	sink.fill = ( m ) => got.push( [ ...m ] );
	r.sink = sink;

	const m = newMessage();
	r.fill( m );
	expect( got ).toHaveLength( 1 );
} );

test( 'unknown TO head yields NOT_AVAILABLE error walked back to FROM', () => {
	const r = new Router();
	r.setName( '_router' );

	const origin = new Node();
	origin.setName( 'origin' );
	const got = [];
	origin.fill = ( m ) => got.push( [ ...m ] );

	const m = newMessage();
	m[ FROM ] = 'origin';
	m[ TO ] = 'missing/nope';
	m[ ID ] = 'cmd-42';
	r.fill( m );

	expect( got ).toHaveLength( 1 );
	// eslint-disable-next-line no-bitwise
	expect( got[ 0 ][ TYPE ] & TM_ERROR ).toBeTruthy();
	expect( got[ 0 ][ ID ] ).toBe( 'cmd-42' );
	expect( got[ 0 ][ VALUE ] ).toMatch( /NOT_AVAILABLE/ );
} );

test( 'TM_ERROR on a missing TO is dropped (no error-on-error bounce)', () => {
	const r = new Router();
	r.setName( '_router' );

	const m = newMessage();
	m[ TYPE ] = TM_ERROR;
	m[ TO ] = 'missing';
	// No throw, no infinite loop — silently consumed.
	expect( () => r.fill( m ) ).not.toThrow();
} );
