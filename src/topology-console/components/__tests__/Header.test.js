/**
 * Header — top bar with a single cwd "Path" selector and the view/edit
 * mode toggle. The skin picker was removed (skins now switch via the
 * undocumented `set_skin` REPL builtin). Edit-only buttons appear
 * conditionally; the EDIT button shows only when canEdit (cwd names a
 * worker); LIVE LED pulses when streamStatus === 'open'.
 */

import { render, screen, fireEvent } from '@testing-library/react';
import Header from '../Header';

const baseProps = {
	pathOptions: [ '', '_sse', 'demo.p0', 'demo.p1' ],
	path: '',
	onPathChange: () => {},
	streamStatus: 'connecting',
	uptime: '',
	mode: 'view',
	canEdit: true,
};

describe( 'Header', () => {
	it( 'renders only the path selector in view mode (no skin picker)', () => {
		const { container } = render( <Header { ...baseProps } /> );
		const selects = container.querySelectorAll( 'select' );
		expect( selects ).toHaveLength( 1 );
		// Path select is selected to the current cwd ('' renders as value '').
		expect( selects[ 0 ].value ).toBe( '' );
	} );

	it( 'renders each pathOption with a /-prefixed label', () => {
		const { container } = render( <Header { ...baseProps } /> );
		const options = container
			.querySelectorAll( 'select' )[ 0 ]
			.querySelectorAll( 'option' );
		expect( Array.from( options ).map( ( o ) => o.value ) ).toEqual( [
			'',
			'_sse',
			'demo.p0',
			'demo.p1',
		] );
		expect( Array.from( options ).map( ( o ) => o.textContent ) ).toEqual( [
			'/',
			'/_sse',
			'/demo.p0',
			'/demo.p1',
		] );
	} );

	it( 'reflects the current path as the selected value', () => {
		const { container } = render(
			<Header { ...baseProps } path="demo.p1" />
		);
		expect( container.querySelectorAll( 'select' )[ 0 ].value ).toBe(
			'demo.p1'
		);
	} );

	it( 'surfaces an off-menu cwd (e.g. a REPL `cd`) as its own option so the select matches', () => {
		const { container } = render(
			<Header { ...baseProps } path="demo.p0/firehose-in" />
		);
		const select = container.querySelectorAll( 'select' )[ 0 ];
		// The select reflects the real cwd rather than snapping to the first option.
		expect( select.value ).toBe( 'demo.p0/firehose-in' );
		expect(
			Array.from( select.querySelectorAll( 'option' ) ).map(
				( o ) => o.value
			)
		).toContain( 'demo.p0/firehose-in' );
	} );

	it( 'calls onPathChange with the chosen cwd string', () => {
		const onPathChange = jest.fn();
		const { container } = render(
			<Header { ...baseProps } onPathChange={ onPathChange } />
		);
		fireEvent.change( container.querySelectorAll( 'select' )[ 0 ], {
			target: { value: 'demo.p0' },
		} );
		expect( onPathChange ).toHaveBeenCalledWith( 'demo.p0' );
	} );

	it( 'hides the path select in edit mode (no selects at all)', () => {
		const { container } = render( <Header { ...baseProps } mode="edit" /> );
		expect( container.querySelectorAll( 'select' ) ).toHaveLength( 0 );
	} );

	it( 'renders no skin picker (skins move to the set_skin REPL builtin)', () => {
		const { queryByLabelText } = render( <Header { ...baseProps } /> );
		expect( queryByLabelText( 'Skin' ) ).toBeNull();
	} );

	it( 'offers OPEN and SAVE in LIVE mode too — SAVE snapshots the live graph', () => {
		const onOpen = jest.fn();
		const onSave = jest.fn();
		const { getByText } = render(
			<Header { ...baseProps } onOpen={ onOpen } onSave={ onSave } />
		);
		fireEvent.click( getByText( 'OPEN' ) );
		expect( onOpen ).toHaveBeenCalled();
		// SAVE now works from live — it captures the live graph's dump_config.
		fireEvent.click( getByText( 'SAVE' ) );
		expect( onSave ).toHaveBeenCalled();
	} );

	it( 'shows DOWNLOAD in edit mode and wires onDownload', () => {
		const onDownload = jest.fn();
		const { getByText } = render(
			<Header { ...baseProps } mode="edit" onDownload={ onDownload } />
		);
		fireEvent.click( getByText( 'DOWNLOAD' ) );
		expect( onDownload ).toHaveBeenCalled();
	} );

	it( 'UPLOAD opens a .tsl file picker and hands the chosen file to onUpload', () => {
		const onUpload = jest.fn();
		const { getByText, container } = render(
			<Header { ...baseProps } mode="edit" onUpload={ onUpload } />
		);
		const input = container.querySelector( 'input[type="file"]' );
		expect( input.accept ).toBe( '.tsl,text/plain' );
		// The UPLOAD button proxies the click onto the hidden file input.
		const clickSpy = jest.spyOn( input, 'click' );
		fireEvent.click( getByText( 'UPLOAD' ) );
		expect( clickSpy ).toHaveBeenCalled();
		// Choosing a file fires onUpload with the File.
		const file = new File( [ 'make_node Echo up\n' ], 'up.tsl', {
			type: 'text/plain',
		} );
		fireEvent.change( input, { target: { files: [ file ] } } );
		expect( onUpload ).toHaveBeenCalledWith( file );
	} );

	it( 'hides SAVE / DOWNLOAD / UPLOAD in the debug overlay (onClose set)', () => {
		const { queryByText } = render(
			<Header
				{ ...baseProps }
				mode="edit"
				onClose={ jest.fn() }
				onSave={ jest.fn() }
				onDownload={ jest.fn() }
				onUpload={ jest.fn() }
			/>
		);
		expect( queryByText( 'SAVE' ) ).toBeNull();
		expect( queryByText( 'DOWNLOAD' ) ).toBeNull();
		expect( queryByText( 'UPLOAD' ) ).toBeNull();
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

	it( 'shows a NEW button in live (view) mode and wires onNew', () => {
		const onNew = jest.fn();
		const { getByText } = render(
			<Header { ...baseProps } mode="view" onNew={ onNew } />
		);
		fireEvent.click( getByText( 'NEW' ) );
		expect( onNew ).toHaveBeenCalled();
	} );

	it( 'hides the live NEW button in the debug overlay (onClose set)', () => {
		const { queryByText } = render(
			<Header
				{ ...baseProps }
				mode="view"
				onNew={ () => {} }
				onClose={ () => {} }
			/>
		);
		// The overlay reuses Header but has no editor to land in.
		expect( queryByText( 'NEW' ) ).toBeNull();
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

	it( 'shows a SETTINGS button in edit mode and fires onSettings', () => {
		const onSettings = jest.fn();
		render(
			<Header
				mode="edit"
				canEdit
				onSettings={ onSettings }
				themes={ [] }
			/>
		);
		const btn = screen.getByRole( 'button', { name: /settings/i } );
		fireEvent.click( btn );
		expect( onSettings ).toHaveBeenCalledTimes( 1 );
	} );

	it( 'hides the SETTINGS button outside edit mode', () => {
		render( <Header mode="view" canEdit themes={ [] } /> );
		expect(
			screen.queryByRole( 'button', { name: /settings/i } )
		).toBeNull();
	} );
} );

/**
 * Button ORDER is part of the interface: the same control must not move as you
 * change mode. Live is a prefix of edit — NEW, OPEN, then the edit-only middle,
 * then always EDIT, LIVE on the right.
 */
describe( 'Header — mode button order', () => {
	// LIVE carries an uptime suffix; compare the label word only.
	const labels = ( container ) =>
		[ ...container.querySelectorAll( '.topology-mode__btn' ) ].map(
			( b ) => ( b.textContent.trim().match( /^[A-Z]+/ ) ?? [ '' ] )[ 0 ]
		);

	it( 'live mode: NEW, OPEN, SAVE, EDIT, LIVE', () => {
		const { container } = render(
			<Header { ...baseProps } onNew={ jest.fn() } onOpen={ jest.fn() } />
		);
		expect( labels( container ) ).toEqual( [
			'NEW',
			'OPEN',
			'SAVE',
			'EDIT',
			'LIVE',
		] );
	} );

	it( 'edit mode: NEW, OPEN, SAVE, DOWNLOAD, UPLOAD, DELETE, SETTINGS, EDIT, LIVE', () => {
		const { container } = render(
			<Header
				{ ...baseProps }
				mode="edit"
				canDelete
				onNew={ jest.fn() }
				onOpen={ jest.fn() }
				onSave={ jest.fn() }
				onDownload={ jest.fn() }
				onUpload={ jest.fn() }
				onDelete={ jest.fn() }
				onSettings={ jest.fn() }
			/>
		);
		expect( labels( container ) ).toEqual( [
			'NEW',
			'OPEN',
			'SAVE',
			'DOWNLOAD',
			'UPLOAD',
			'DELETE',
			'SETTINGS',
			'EDIT',
			'LIVE',
		] );
	} );

	it( 'the debug overlay has no editor — no NEW, no OPEN', () => {
		const { container } = render(
			<Header { ...baseProps } onClose={ jest.fn() } />
		);
		expect( labels( container ) ).not.toContain( 'NEW' );
		expect( labels( container ) ).not.toContain( 'OPEN' );
	} );
} );
