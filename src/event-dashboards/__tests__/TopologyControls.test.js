import { render, fireEvent, act } from '@testing-library/react';
import TopologyControls from '../TopologyControls';

const noop = () => Promise.resolve();
function setup( props = {} ) {
	const base = {
		name: 'combined',
		active: true,
		onActivate: jest.fn( noop ),
		onDeactivate: jest.fn( noop ),
		onRestart: jest.fn( noop ),
		onError: jest.fn(),
		editHref: 'admin.php?edit=1',
	};
	const merged = { ...base, ...props };
	return { ...merged, ...render( <TopologyControls { ...merged } /> ) };
}

it( 'active: toggle is on, restart shown, edit links', () => {
	const { container } = setup( { active: true } );
	const toggle = container.querySelector( '.nodes-ctl__toggle' );
	expect( toggle.getAttribute( 'aria-checked' ) ).toBe( 'true' );
	expect( toggle.classList.contains( 'button' ) ).toBe( true );
	expect( toggle.classList.contains( 'is-active' ) ).toBe( false );
	expect( container.querySelector( '.nodes-ctl__restart' ) ).toBeTruthy();
	expect(
		container.querySelector( '.nodes-ctl__edit' ).getAttribute( 'href' )
	).toBe( 'admin.php?edit=1' );
} );

it( 'edit renders as a stock WP small secondary button', () => {
	const { container } = setup( { active: true } );
	const edit = container.querySelector( '.nodes-ctl__edit' );
	expect( edit.classList.contains( 'button' ) ).toBe( true );
	expect( edit.classList.contains( 'button-small' ) ).toBe( true );
} );

it( 'inactive: toggle is off and there is no restart button', () => {
	const { container } = setup( { active: false } );
	const toggle = container.querySelector( '.nodes-ctl__toggle' );
	expect( toggle.getAttribute( 'aria-checked' ) ).toBe( 'false' );
	expect( toggle.className ).not.toContain( 'is-on' );
	expect( container.querySelector( '.nodes-ctl__restart' ) ).toBeNull();
} );

it( 'clicking the toggle deactivates when active, activates when inactive', () => {
	const on = setup( { active: true } );
	fireEvent.click( on.container.querySelector( '.nodes-ctl__toggle' ) );
	expect( on.onDeactivate ).toHaveBeenCalledWith( 'combined' );

	const off = setup( { active: false } );
	fireEvent.click( off.container.querySelector( '.nodes-ctl__toggle' ) );
	expect( off.onActivate ).toHaveBeenCalledWith( 'combined' );
} );

it( 'clicking restart fires onRestart', () => {
	const s = setup( { active: true } );
	fireEvent.click( s.container.querySelector( '.nodes-ctl__restart' ) );
	expect( s.onRestart ).toHaveBeenCalledWith( 'combined' );
} );

it( 'surfaces a rejected mutation through onError instead of throwing', async () => {
	const onActivate = jest.fn( () =>
		Promise.reject( new Error( 'conflict' ) )
	);
	const onError = jest.fn();
	const { container } = setup( { active: false, onActivate, onError } );
	await act( async () => {
		fireEvent.click( container.querySelector( '.nodes-ctl__toggle' ) );
	} );
	expect( onError ).toHaveBeenCalledWith( {
		name: 'combined',
		message: 'conflict',
	} );
} );
