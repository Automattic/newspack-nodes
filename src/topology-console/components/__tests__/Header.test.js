/**
 * Header — top bar with a single cwd "Path" selector and the view/edit
 * mode toggle. Edit-only buttons appear conditionally; the EDIT button
 * shows only when canEdit (cwd names a worker); LIVE LED pulses when
 * streamStatus === 'open'.
 */

import { render, fireEvent } from '@testing-library/react';
import Header from '../Header';

const baseProps = {
	pathOptions: [ '', '_sse', '_sse/demo.p0', '_sse/demo.p1' ],
	path: '',
	onPathChange: () => {},
	streamStatus: 'connecting',
	uptime: '',
	mode: 'view',
	canEdit: true,
	theme: 'current',
	onThemeChange: () => {},
	themes: [
		{ slug: 'current', label: 'Current' },
		{ slug: 'blueprint', label: 'Blueprint' },
	],
};

describe( 'Header', () => {
	it( 'renders the path selector and the skin picker in view mode', () => {
		const { container } = render( <Header { ...baseProps } /> );
		const selects = container.querySelectorAll( 'select' );
		expect( selects ).toHaveLength( 2 );
		// Path select is selected to the current cwd ('' renders as value '').
		expect( selects[ 0 ].value ).toBe( '' );
		expect( selects[ 1 ].value ).toBe( 'current' );
	} );

	it( 'renders each pathOption with a /-prefixed label', () => {
		const { container } = render( <Header { ...baseProps } /> );
		const options = container
			.querySelectorAll( 'select' )[ 0 ]
			.querySelectorAll( 'option' );
		expect( Array.from( options ).map( ( o ) => o.value ) ).toEqual( [
			'',
			'_sse',
			'_sse/demo.p0',
			'_sse/demo.p1',
		] );
		expect( Array.from( options ).map( ( o ) => o.textContent ) ).toEqual( [
			'/',
			'/_sse',
			'/_sse/demo.p0',
			'/_sse/demo.p1',
		] );
	} );

	it( 'reflects the current path as the selected value', () => {
		const { container } = render(
			<Header { ...baseProps } path="_sse/demo.p1" />
		);
		expect( container.querySelectorAll( 'select' )[ 0 ].value ).toBe(
			'_sse/demo.p1'
		);
	} );

	it( 'surfaces an off-menu cwd (e.g. a REPL `cd`) as its own option so the select matches', () => {
		const { container } = render(
			<Header { ...baseProps } path="_sse/demo.p0/firehose-in" />
		);
		const select = container.querySelectorAll( 'select' )[ 0 ];
		// The select reflects the real cwd rather than snapping to the first option.
		expect( select.value ).toBe( '_sse/demo.p0/firehose-in' );
		expect(
			Array.from( select.querySelectorAll( 'option' ) ).map(
				( o ) => o.value
			)
		).toContain( '_sse/demo.p0/firehose-in' );
	} );

	it( 'calls onPathChange with the chosen cwd string', () => {
		const onPathChange = jest.fn();
		const { container } = render(
			<Header { ...baseProps } onPathChange={ onPathChange } />
		);
		fireEvent.change( container.querySelectorAll( 'select' )[ 0 ], {
			target: { value: '_sse/demo.p0' },
		} );
		expect( onPathChange ).toHaveBeenCalledWith( '_sse/demo.p0' );
	} );

	it( 'hides the path select in edit mode but keeps the skin picker', () => {
		const { container, getByLabelText } = render(
			<Header { ...baseProps } mode="edit" />
		);
		const selects = container.querySelectorAll( 'select' );
		expect( selects ).toHaveLength( 1 );
		expect( getByLabelText( 'Skin' ) ).toBe( selects[ 0 ] );
	} );

	it( 'renders the skin picker and fires onThemeChange', () => {
		const onThemeChange = jest.fn();
		const { getByLabelText } = render(
			<Header { ...baseProps } onThemeChange={ onThemeChange } />
		);
		const skin = getByLabelText( 'Skin' );
		expect( skin.value ).toBe( 'current' );
		fireEvent.change( skin, { target: { value: 'blueprint' } } );
		expect( onThemeChange ).toHaveBeenCalledWith( 'blueprint' );
	} );

	it( 'lists every supplied skin as an option', () => {
		const { getByLabelText } = render( <Header { ...baseProps } /> );
		expect(
			getByLabelText( 'Skin' ).querySelectorAll( 'option' )
		).toHaveLength( 2 );
	} );

	it( 'shows NEW/OPEN/SAVE buttons in edit mode and wires them', () => {
		const onNew = jest.fn();
		const onOpen = jest.fn();
		const onSave = jest.fn();
		const { getByText } = render(
			<Header
				{ ...baseProps }
				mode="edit"
				onNew={ onNew }
				onOpen={ onOpen }
				onSave={ onSave }
			/>
		);
		fireEvent.click( getByText( 'NEW' ) );
		fireEvent.click( getByText( 'OPEN' ) );
		fireEvent.click( getByText( 'SAVE' ) );
		expect( onNew ).toHaveBeenCalled();
		expect( onOpen ).toHaveBeenCalled();
		expect( onSave ).toHaveBeenCalled();
	} );

	it( 'shows DELETE only when canDelete is true', () => {
		const onDelete = jest.fn();
		const { getByText, rerender, queryByText } = render(
			<Header
				{ ...baseProps }
				mode="edit"
				canDelete
				onDelete={ onDelete }
			/>
		);
		fireEvent.click( getByText( 'DELETE' ) );
		expect( onDelete ).toHaveBeenCalled();
		rerender( <Header { ...baseProps } mode="edit" canDelete={ false } /> );
		expect( queryByText( 'DELETE' ) ).toBeNull();
	} );

	it( 'shows the EDIT button when canEdit is true and hides it otherwise', () => {
		const { getByText, queryByText, rerender } = render(
			<Header { ...baseProps } canEdit />
		);
		expect( getByText( 'EDIT' ) ).not.toBeNull();
		rerender( <Header { ...baseProps } canEdit={ false } /> );
		expect( queryByText( 'EDIT' ) ).toBeNull();
	} );

	it( 'keeps the LIVE button visible regardless of canEdit', () => {
		const { getByText } = render(
			<Header { ...baseProps } canEdit={ false } />
		);
		expect( getByText( 'LIVE' ) ).not.toBeNull();
	} );

	it( 'invokes onModeChange with view/edit on the mode toggle buttons', () => {
		const onModeChange = jest.fn();
		const { getByText } = render(
			<Header { ...baseProps } canEdit onModeChange={ onModeChange } />
		);
		fireEvent.click( getByText( 'EDIT' ) );
		fireEvent.click( getByText( 'LIVE' ) );
		expect( onModeChange ).toHaveBeenNthCalledWith( 1, 'edit' );
		expect( onModeChange ).toHaveBeenNthCalledWith( 2, 'view' );
	} );

	it( 'marks LIVE button active when mode=view + streamStatus=open', () => {
		const { container } = render(
			<Header { ...baseProps } mode="view" streamStatus="open" />
		);
		const live = container.querySelector( '.topology-mode__btn--live' );
		expect( live.className ).toContain( 'is-active' );
	} );

	it( 'shows an em-dash uptime placeholder until first uptime tick', () => {
		const { container } = render( <Header { ...baseProps } /> );
		const uptime = container.querySelector( '.topology-uptime' );
		expect( uptime.textContent ).toBe( '—' );
	} );

	it( 'shows the supplied uptime when set', () => {
		const { container } = render( <Header { ...baseProps } uptime="5m" /> );
		const uptime = container.querySelector( '.topology-uptime' );
		expect( uptime.textContent ).toBe( '5m' );
	} );
} );
