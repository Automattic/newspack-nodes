/**
 * Inspector view-mode rendering (edit-mode paths live in a separate file).
 */

import { render, fireEvent } from '@testing-library/react';
import Inspector from '../Inspector';
import { formatActivityWindow } from '../ProcessStats';
import { Core } from '../../../runtime/core';
import { Node } from '../../../runtime/node';
import { IoTelemetry } from '../../../runtime/io-telemetry';
import names from '../../../runtime/reserved-node-names.json';

const baseProps = {
	selectedId: null,
	parsed: { nodes: [], edges: [] },
	streamStatus: 'open',
	rateInfo: null,
	onAction: () => {},
	onSelect: () => {},
	onHover: () => {},
	nodeIds: new Set(),
	ssePid: null,
};

describe( 'Inspector (view mode)', () => {
	it( 'renders the no-node command palette when nothing is selected', () => {
		const { container } = render( <Inspector { ...baseProps } /> );
		expect(
			container.querySelector( '.topology-insp__commands' )
		).not.toBeNull();
	} );

	it( 'no-node panel in EDIT mode shows an edit hint, not the live command palette', () => {
		// Offline draft: no live command palette — edit mode shows a hint.
		const { container, queryByText } = render(
			<Inspector { ...baseProps } editMode={ true } />
		);
		expect(
			container.querySelector( '.topology-insp__commands' )
		).toBeNull();
		expect( queryByText( '_command_interpreter' ) ).toBeNull();
		expect( queryByText( /select a node/i ) ).not.toBeNull();
	} );

	it( 'shows process stats (msgs in/out) at the top of the no-node inspector', () => {
		const { getByTestId } = render(
			<Inspector
				{ ...baseProps }
				parsed={ {
					nodes: [
						{
							id: 'src',
							count: 10,
							has_target: true,
							accepts_fill: false,
						},
						{
							id: 'snk',
							count: 7,
							has_target: false,
							accepts_fill: true,
						},
					],
					edges: [],
				} }
			/>
		);
		const stats = getByTestId( 'inspector-process-stats' ).textContent;
		expect( stats ).toContain( '10' );
		expect( stats ).toContain( '7' );
	} );

	it( 'shows the current msg + byte /s rates in the no-node process header [98]', () => {
		const { getByTestId } = render(
			<Inspector
				{ ...baseProps }
				parsed={ {
					nodes: [
						{
							id: 'src',
							count: 10,
							bytesRead: 4096,
							bytesWritten: 1024,
							has_target: true,
							accepts_fill: false,
						},
					],
					edges: [],
				} }
				rateSeries={ {
					in: [ 1, 5 ],
					out: [ 0, 2 ],
					read: [ 0, 2048 ],
					write: [ 0, 512 ],
				} }
			/>
		);
		const header = getByTestId( 'inspector-process-stats' );
		const stats = header.textContent;
		// Activity: four sparkline rows (msgs in/out + bytes read/written).
		expect( stats ).toContain( 'messages in /s' );
		expect( stats ).toContain( 'messages out /s' );
		expect( stats ).toContain( 'bytes read /s' );
		expect( stats ).toContain( 'bytes written /s' );
		expect(
			header.querySelectorAll( '.topology-insp__spark-row' ).length
		).toBe( 4 );
		// Current rate = the last sample of each series, formatted /s.
		expect( stats ).toContain( '5.0 /s' ); // msgs in
		expect( stats ).toContain( '2.0 /s' ); // msgs out
		expect( stats ).toContain( '2.0 K/s' ); // bytes read (2048 B/s)
		expect( stats ).toContain( '512 B/s' ); // bytes written
	} );

	it( 'sources the no-node header from IoTelemetry for the browser/local scope (matches the Overview tab)', () => {
		IoTelemetry.reset();
		// Received: 5185 msgs / 995 bytes; sent: 118 msgs / 6300 bytes.
		IoTelemetry.recordIn( 995, 5185 );
		IoTelemetry.recordOut( 6300, 118 );
		const { getByTestId } = render(
			<Inspector
				{ ...baseProps }
				local
				parsed={ {
					// Counts differ from IoTelemetry to prove which path wins.
					nodes: [
						{
							id: 'src',
							count: 3,
							has_target: true,
							accepts_fill: false,
						},
					],
					edges: [],
				} }
			/>
		);
		const stats = getByTestId( 'inspector-process-stats' ).textContent;
		// IoTelemetry totals win, NOT the node count (3).
		expect( stats ).toContain( '5,185' ); // msgs in
		expect( stats ).toContain( '118' ); // msgs out
		expect( stats ).not.toContain( '–3' ); // not the node count
		IoTelemetry.reset();
	} );

	it( 'shows dmesg error/warning/debug counts + rate sparklines in the header', () => {
		Core.reset();
		// _dmesg node publishes classified stderr counts; header reads it.
		const dmesg = new Node();
		dmesg.name = names.DMESG;
		dmesg.setStateCache = { dmesg: { errors: 2, warnings: 1, debug: 3 } };
		const { getByTestId } = render( <Inspector { ...baseProps } /> );
		const header = getByTestId( 'inspector-process-stats' );
		const levels = header.querySelector( '.topology-insp__levels' );
		expect( levels.textContent ).toMatch( /2 err/ );
		expect( levels.textContent ).toMatch( /1 warn/ );
		expect( levels.textContent ).toMatch( /3 dbg/ );
		// Four Activity sparkline rows render even pre-data (flat baseline).
		expect(
			header.querySelectorAll( '.topology-insp__spark-row' ).length
		).toBe( 4 );
		Core.reset();
	} );

	it( 'shows no-node server-command buttons that dispatch via onAction', () => {
		const calls = [];
		const { getByText } = render(
			<Inspector
				{ ...baseProps }
				onAction={ ( ...a ) => calls.push( a ) }
			/>
		);
		fireEvent.click( getByText( 'dmesg' ) );
		expect( calls ).toContainEqual( [ 'command', null, 'dmesg' ] );
	} );

	it( 'no-node Trace fires the trace action with an explicit level (like the per-node button), not a raw command', () => {
		const calls = [];
		const { getByText } = render(
			<Inspector
				{ ...baseProps }
				parsed={ { nodes: [ { id: 'a', debugState: 0 } ], edges: [] } }
				onAction={ ( ...a ) => calls.push( a ) }
			/>
		);
		fireEvent.click( getByText( 'trace' ) );
		expect( calls ).toContainEqual( [ 'trace', '*', 1 ] );
		expect( calls ).not.toContainEqual( [ 'command', null, 'trace *' ] );
	} );

	it( 'no-node Trace reads "stop trace" when ANY node is traced, not just the first', () => {
		const { getByText } = render(
			<Inspector
				{ ...baseProps }
				parsed={ {
					nodes: [
						{ id: 'alpha', debugState: 0 },
						{ id: 'beta', debugState: 4 },
					],
					edges: [],
				} }
			/>
		);
		expect( getByText( 'stop trace' ) ).not.toBeNull();
	} );

	it( 'no-node Trace highlights + swaps to "stop trace" when tracing, and toggles to level 0', () => {
		const calls = [];
		const { getByText } = render(
			<Inspector
				{ ...baseProps }
				parsed={ { nodes: [ { id: 'a', debugState: 1 } ], edges: [] } }
				onAction={ ( ...a ) => calls.push( a ) }
			/>
		);
		const btn = getByText( 'stop trace' );
		expect( btn.className ).toContain( 'is-active' );
		fireEvent.click( btn );
		expect( calls ).toContainEqual( [ 'trace', '*', 0 ] );
	} );

	it( 'exposes list_timers/list_handles as no-node inspector commands', () => {
		const calls = [];
		const { getByText } = render(
			<Inspector
				{ ...baseProps }
				onAction={ ( ...a ) => calls.push( a ) }
			/>
		);
		fireEvent.click( getByText( 'timers' ) );
		expect( calls ).toContainEqual( [ 'command', null, 'list_timers' ] );
		fireEvent.click( getByText( 'handles' ) );
		expect( calls ).toContainEqual( [ 'command', null, 'list_handles' ] );
	} );

	it( 'exposes `profiles` (list_profiles) as a no-node command button', () => {
		const calls = [];
		const { getByText } = render(
			<Inspector
				{ ...baseProps }
				onAction={ ( ...a ) => calls.push( a ) }
			/>
		);
		fireEvent.click( getByText( 'profiles' ) );
		expect( calls ).toContainEqual( [ 'command', null, 'list_profiles' ] );
	} );

	it( 'groups the no-node strip into Views / Toggles / Commands headers', () => {
		const { getByText } = render(
			<Inspector { ...baseProps } parsed={ { nodes: [], edges: [] } } />
		);
		expect( getByText( 'Views' ) ).not.toBeNull();
		expect( getByText( 'Toggles' ) ).not.toBeNull();
		expect( getByText( 'Commands' ) ).not.toBeNull();
	} );

	it( 'no-node Profiling is ONE toggle: fires `profile on` when off, then swaps to "stop profiling" + highlights optimistically', () => {
		const calls = [];
		const { getByText, queryByText } = render(
			<Inspector
				{ ...baseProps }
				parsed={ { nodes: [], edges: [], profiling: false } }
				onAction={ ( ...a ) => calls.push( a ) }
			/>
		);
		// No `profile on` / `profile off` command pair remains in the strip.
		expect( queryByText( 'profile on' ) ).toBeNull();
		expect( queryByText( 'profile off' ) ).toBeNull();
		const btn = getByText( 'profiling' );
		expect( btn.className ).not.toContain( 'is-active' );
		fireEvent.click( btn );
		expect( calls ).toContainEqual( [ 'command', null, 'profile on' ] );
		// Optimistic: label + highlight swap now, before a poll reply confirms.
		const active = getByText( 'stop profiling' );
		expect( active.className ).toContain( 'is-active' );
		expect( queryByText( 'profiling' ) ).toBeNull();
	} );

	it( 'no-node Profiling reads server truth (parsed.profiling) and fires `profile off` when on', () => {
		const calls = [];
		const { getByText } = render(
			<Inspector
				{ ...baseProps }
				parsed={ { nodes: [], edges: [], profiling: true } }
				onAction={ ( ...a ) => calls.push( a ) }
			/>
		);
		const btn = getByText( 'stop profiling' );
		expect( btn.className ).toContain( 'is-active' );
		fireEvent.click( btn );
		expect( calls ).toContainEqual( [ 'command', null, 'profile off' ] );
	} );

	it( 'no-node Verbose is ONE toggle: fires `debug_level 2` when the live level is 0', () => {
		const calls = [];
		const { getByText } = render(
			<Inspector
				{ ...baseProps }
				debugLevel={ 0 }
				onAction={ ( ...a ) => calls.push( a ) }
			/>
		);
		const btn = getByText( 'verbose' );
		expect( btn.className ).not.toContain( 'is-active' );
		fireEvent.click( btn );
		expect( calls ).toContainEqual( [ 'command', null, 'debug_level 2' ] );
	} );

	it( 'no-node Verbose reads the live debug level (2) and fires `debug_level 0` when on', () => {
		const calls = [];
		const { getByText } = render(
			<Inspector
				{ ...baseProps }
				debugLevel={ 2 }
				onAction={ ( ...a ) => calls.push( a ) }
			/>
		);
		const btn = getByText( 'stop verbose' );
		expect( btn.className ).toContain( 'is-active' );
		fireEvent.click( btn );
		expect( calls ).toContainEqual( [ 'command', null, 'debug_level 0' ] );
	} );

	// debug + verbose are the two lights on ONE dial (the Dumper's debug_level):
	// debugOn = level >= 1, verboseOn = level >= 2. Verbose lit implies debug lit.
	it( 'no-node Debug at level 1 is lit (verbose is NOT — dial, not two switches)', () => {
		const { getByText } = render(
			<Inspector { ...baseProps } debugLevel={ 1 } />
		);
		expect( getByText( 'stop debug' ).className ).toContain( 'is-active' );
		expect( getByText( 'verbose' ).className ).not.toContain( 'is-active' );
	} );

	it( 'no-node Debug at level 2 is lit alongside verbose (verbose implies debug)', () => {
		const { getByText } = render(
			<Inspector { ...baseProps } debugLevel={ 2 } />
		);
		expect( getByText( 'stop debug' ).className ).toContain( 'is-active' );
		expect( getByText( 'stop verbose' ).className ).toContain(
			'is-active'
		);
	} );

	it( 'no-node Debug is ONE toggle: fires `debug_level 1` when the live level is 0', () => {
		const calls = [];
		const { getByText } = render(
			<Inspector
				{ ...baseProps }
				debugLevel={ 0 }
				onAction={ ( ...a ) => calls.push( a ) }
			/>
		);
		const btn = getByText( 'debug' );
		expect( btn.className ).not.toContain( 'is-active' );
		fireEvent.click( btn );
		expect( calls ).toContainEqual( [ 'command', null, 'debug_level 1' ] );
		// It is a toggle, not the old stateless dump of the bare verb.
		expect( calls ).not.toContainEqual( [
			'command',
			null,
			'debug_level',
		] );
	} );

	it( 'no-node Debug at level 2 fires `debug_level 0`, collapsing the whole dial', () => {
		const calls = [];
		const { getByText } = render(
			<Inspector
				{ ...baseProps }
				debugLevel={ 2 }
				onAction={ ( ...a ) => calls.push( a ) }
			/>
		);
		fireEvent.click( getByText( 'stop debug' ) );
		expect( calls ).toContainEqual( [ 'command', null, 'debug_level 0' ] );
	} );

	it( 'opens the wide Runtime modal from the no-node strip', () => {
		Core.reset();
		const { getByText } = render( <Inspector { ...baseProps } /> );
		expect( document.body.querySelector( '.topology-modal' ) ).toBeNull();
		fireEvent.click( getByText( 'Runtime' ) );
		const modal = document.body.querySelector( '.topology-modal' );
		expect( modal.classList.contains( 'topology-modal--large' ) ).toBe(
			true
		);
		expect(
			modal.querySelector( '[data-testid="runtime-view"]' )
		).toBeTruthy();
		Core.reset();
	} );

	it( 'opens the wide Profiler modal from the no-node strip', () => {
		Core.reset();
		const { getByText } = render( <Inspector { ...baseProps } /> );
		fireEvent.click( getByText( 'Profiler' ) );
		const modal = document.body.querySelector( '.topology-modal' );
		expect( modal.classList.contains( 'topology-modal--large' ) ).toBe(
			true
		);
		expect(
			modal.querySelector( '[data-testid="stats-view"]' )
		).toBeTruthy();
		Core.reset();
	} );

	it( 'opens the Timeline modal from the no-node strip', () => {
		Core.reset();
		const { getByText } = render( <Inspector { ...baseProps } /> );
		fireEvent.click( getByText( 'Timeline' ) );
		expect(
			document.body.querySelector( '.topology-modal .timeline-view' )
		).toBeTruthy();
		Core.reset();
	} );

	it( 'closes the strip modal via its close button', () => {
		Core.reset();
		const { getByText } = render( <Inspector { ...baseProps } /> );
		fireEvent.click( getByText( 'Runtime' ) );
		fireEvent.click(
			document.body.querySelector( '.topology-modal__close' )
		);
		expect( document.body.querySelector( '.topology-modal' ) ).toBeNull();
		Core.reset();
	} );

	it( 'does NOT show the Runtime/Profiler/Timeline strip modal buttons in edit mode', () => {
		const { queryByText } = render(
			<Inspector { ...baseProps } editMode={ true } />
		);
		expect( queryByText( 'Runtime' ) ).toBeNull();
		expect( queryByText( 'Profiler' ) ).toBeNull();
		expect( queryByText( 'Timeline' ) ).toBeNull();
	} );

	it( 'no-node Compose opens a composer that dispatches the chosen verb', () => {
		const onAction = jest.fn();
		const { getByText } = render(
			<Inspector
				{ ...baseProps }
				onAction={ onAction }
				parsed={ {
					nodes: [ { id: 'echo', class: 'Echo' } ],
					edges: [],
				} }
			/>
		);
		fireEvent.click( getByText( 'Compose' ) );
		// Pick TM_INFO (tell_node) by its option label, not a fixed index.
		const selects = document.body.querySelectorAll(
			'.topology-modal__body select'
		);
		const infoOption = Array.from( selects[ 1 ].options ).find( ( o ) =>
			/TM_INFO/.test( o.textContent )
		);
		fireEvent.change( selects[ 1 ], {
			target: { value: infoOption.value },
		} );
		fireEvent.change(
			document.body.querySelector( '#nodes-compose-value' ),
			{ target: { value: 'hi' } }
		);
		fireEvent.click(
			document.body.querySelector(
				'.topology-modal__actions .button-primary'
			)
		);
		expect( onAction ).toHaveBeenCalledWith( 'tell', 'echo', 'hi', {
			response: false,
			error: false,
		} );
	} );

	it( 'no-node Compose Cancel button closes the composer without dispatching', () => {
		const onAction = jest.fn();
		const { getByText } = render(
			<Inspector
				{ ...baseProps }
				onAction={ onAction }
				parsed={ {
					nodes: [ { id: 'echo', class: 'Echo' } ],
					edges: [],
				} }
			/>
		);
		fireEvent.click( getByText( 'Compose' ) );
		expect(
			document.body.querySelector( '.topology-modal__body' )
		).not.toBeNull();
		fireEvent.click(
			document.body.querySelector(
				'.topology-modal__actions .button:not(.button-primary)'
			)
		);
		expect(
			document.body.querySelector( '.topology-modal__body' )
		).toBeNull();
		expect( onAction ).not.toHaveBeenCalled();
	} );

	it( 'no-node Compose "To" list uses composeTargets (the full addressable surface), not just parsed.nodes', () => {
		// composeTargets is the full addressable surface, richer than nodes.
		const composeTargets = [
			'_command_interpreter',
			'echo',
			'echo:config',
			'tee_a',
			'tee_a:config',
		];
		const { getByText } = render(
			<Inspector
				{ ...baseProps }
				parsed={ {
					nodes: [ { id: 'echo', class: 'Echo' } ],
					edges: [],
				} }
				composeTargets={ composeTargets }
			/>
		);
		fireEvent.click( getByText( 'Compose' ) );
		const toSelect = document.body.querySelector( '#nodes-compose-to' );
		const optionValues = Array.from( toSelect.options ).map(
			( o ) => o.value
		);
		expect( optionValues ).toEqual( composeTargets );
		// _command_interpreter (first entry) is the default selection.
		expect( toSelect.value ).toBe( '_command_interpreter' );
	} );

	it( 'no-node Compose falls back to parsed.nodes ids when composeTargets is not supplied', () => {
		const { getByText } = render(
			<Inspector
				{ ...baseProps }
				parsed={ {
					nodes: [ { id: 'echo', class: 'Echo' } ],
					edges: [],
				} }
			/>
		);
		fireEvent.click( getByText( 'Compose' ) );
		const toSelect = document.body.querySelector( '#nodes-compose-to' );
		expect(
			Array.from( toSelect.options ).map( ( o ) => o.value )
		).toEqual( [ 'echo' ] );
	} );

	it( 'no-node Compose TM_RESPONSE / TM_ERROR checkboxes pass their flags through onConfirm', () => {
		// Inspector only carries flags to onAction; OR-ing tested elsewhere.
		const onAction = jest.fn();
		const { getByText, getByLabelText } = render(
			<Inspector
				{ ...baseProps }
				onAction={ onAction }
				parsed={ {
					nodes: [ { id: 'echo', class: 'Echo' } ],
					edges: [],
				} }
			/>
		);
		fireEvent.click( getByText( 'Compose' ) );
		fireEvent.click( getByLabelText( 'TM_RESPONSE' ) );
		fireEvent.click( getByLabelText( 'TM_ERROR' ) );
		fireEvent.change(
			document.body.querySelector( '#nodes-compose-value' ),
			{ target: { value: 'hi' } }
		);
		fireEvent.click(
			document.body.querySelector(
				'.topology-modal__actions .button-primary'
			)
		);
		expect( onAction ).toHaveBeenCalledWith( 'cmd', 'echo', 'hi', {
			response: true,
			error: true,
		} );
	} );

	it( 'no-node Compose leaves the flags unchecked on open, even after a prior send left them checked', () => {
		const onAction = jest.fn();
		const { getByText, getByLabelText } = render(
			<Inspector
				{ ...baseProps }
				onAction={ onAction }
				parsed={ {
					nodes: [ { id: 'echo', class: 'Echo' } ],
					edges: [],
				} }
			/>
		);
		fireEvent.click( getByText( 'Compose' ) );
		fireEvent.click( getByLabelText( 'TM_RESPONSE' ) );
		fireEvent.click(
			document.body.querySelector(
				'.topology-modal__actions .button-primary'
			)
		);
		// Re-open: a fresh ComposeModal mount resets both checkboxes.
		fireEvent.click( getByText( 'Compose' ) );
		fireEvent.change(
			document.body.querySelector( '#nodes-compose-value' ),
			{ target: { value: 'again' } }
		);
		fireEvent.click(
			document.body.querySelector(
				'.topology-modal__actions .button-primary'
			)
		);
		expect( onAction ).toHaveBeenLastCalledWith( 'cmd', 'echo', 'again', {
			response: false,
			error: false,
		} );
	} );

	it( 'renders the missing-node state when selectedId is absent from parsed', () => {
		const { container } = render(
			<Inspector { ...baseProps } selectedId="ghost" />
		);
		expect( container.textContent ).toMatch( /no longer present/ );
	} );

	const node = {
		id: 'echo',
		class: 'Echo',
		count: 1234,
		lgstMsg: 4096,
		bytesRead: 0,
		bytesWritten: 1024 * 1024 * 3,
	};
	const parsed = {
		nodes: [ node, { id: 'tee_a', class: 'Tee', target: [] } ],
		edges: [
			{ from: 'echo', to: 'tee_a' },
			{ from: 'echo', to: 'sink' },
		],
	};
	const renderNode = ( extra = {} ) =>
		render(
			<Inspector
				{ ...baseProps }
				selectedId="echo"
				parsed={ parsed }
				nodeIds={ new Set( [ 'echo', 'tee_a' ] ) }
				{ ...extra }
			/>
		);

	it( 'selected-node Request opens a prompt modal and dispatches with the payload; EOF dispatches directly', () => {
		const onAction = jest.fn();
		const { getByText, getByDisplayValue } = renderNode( { onAction } );
		fireEvent.click( getByText( 'Request' ) );
		// A prompt modal appears with a text input (portaled to <body>).
		const input = document.body.querySelector( '.topology-modal__input' );
		expect( input ).not.toBeNull();
		fireEvent.change( input, { target: { value: 'ping' } } );
		fireEvent.click(
			getByDisplayValue( 'ping' )
				.closest( '.topology-modal' )
				.querySelector( '.button-primary' )
		);
		expect( onAction ).toHaveBeenCalledWith( 'request', 'echo', 'ping' );
		fireEvent.click( getByText( 'EOF' ) );
		expect( onAction ).toHaveBeenCalledWith( 'send_eof', 'echo' );
	} );

	it( 'renders the node title + type with LIVE LED', () => {
		const { container } = renderNode();
		expect(
			container.querySelector( '.topology-insp__title' ).textContent
		).toBe( 'echo' );
		expect( container.textContent ).toMatch( /LIVE/ );
	} );

	it( 'shows status uppercased when streamStatus is not open', () => {
		const { container } = renderNode( { streamStatus: 'connecting' } );
		expect( container.textContent ).toMatch( /CONNECTING/ );
	} );

	it( 'live mode renders the targets editor from node.targets; chip × calls onRemoveEdge with the FULL target, dropdown calls onConnect', () => {
		const onConnect = jest.fn();
		const onRemoveEdge = jest.fn();
		// node.targets is the full runtime list; disconnect by full value.
		const teeParsed = {
			nodes: [
				{
					id: 'tee',
					class: 'Tee',
					target: [ 'a', '_sse/workers' ],
					targets: [ 'a', '_sse/workers' ],
				},
				{ id: 'a', class: 'Echo' },
				{ id: 'b', class: 'Echo' },
			],
			// A registration edge that must NOT become a chip.
			edges: [
				{ from: 'tee', to: '_sse' },
				{ from: 'tee', to: 'a', registration: true, event: 'EVT' },
			],
		};
		const { getByRole, getByDisplayValue } = render(
			<Inspector
				{ ...baseProps }
				selectedId="tee"
				parsed={ teeParsed }
				nodeIds={ new Set( [ 'tee', 'a', 'b' ] ) }
				onConnect={ onConnect }
				onRemoveEdge={ onRemoveEdge }
			/>
		);
		fireEvent.click(
			getByRole( 'button', { name: /Remove _sse\/workers/i } )
		);
		expect( onRemoveEdge ).toHaveBeenCalledWith( 'tee', '_sse/workers' );
		fireEvent.change( getByDisplayValue( '+ add target…' ), {
			target: { value: 'b' },
		} );
		expect( onConnect ).toHaveBeenCalledWith( 'tee', 'b' );
	} );

	it( 'live mode does NOT show the targets editor for a reserved node', () => {
		const onConnect = jest.fn();
		const onRemoveEdge = jest.fn();
		const parsedReserved = {
			nodes: [
				{ id: '_repl', class: 'CommandInterpreter', targets: [ 'a' ] },
				{ id: 'a', class: 'Echo' },
			],
			edges: [ { from: '_repl', to: 'a' } ],
		};
		const { queryByRole } = render(
			<Inspector
				{ ...baseProps }
				selectedId="_repl"
				parsed={ parsedReserved }
				nodeIds={ new Set( [ '_repl', 'a' ] ) }
				onConnect={ onConnect }
				onRemoveEdge={ onRemoveEdge }
			/>
		);
		// A reserved node shows read-only routing — no editor combobox.
		expect( queryByRole( 'combobox' ) ).toBeNull();
	} );

	it( 'hides the Routing section when node.has_target is false', () => {
		const { queryByText } = render(
			<Inspector
				{ ...baseProps }
				selectedId="dump"
				parsed={ {
					nodes: [
						{ id: 'dump', class: 'Dumper', has_target: false },
					],
					edges: [],
				} }
				nodeIds={ new Set( [ 'dump' ] ) }
			/>
		);
		expect( queryByText( 'Routing' ) ).toBeNull();
	} );

	it( 'hides the Routing section when the catalog schema says has_target is false', () => {
		const { queryByText } = render(
			<Inspector
				{ ...baseProps }
				selectedId="dump"
				parsed={ {
					nodes: [ { id: 'dump', class: 'Dumper' } ],
					edges: [],
				} }
				nodeIds={ new Set( [ 'dump' ] ) }
				catalog={ [ { shell_name: 'Dumper', has_target: false } ] }
			/>
		);
		expect( queryByText( 'Routing' ) ).toBeNull();
	} );

	it( 'shows the Routing section when has_target is absent (defaults to true)', () => {
		const { queryByText } = renderNode();
		expect( queryByText( 'Routing' ) ).not.toBeNull();
	} );

	it( 'renders LIVE without crashing when streamStatus is undefined (overlay case)', () => {
		// Overlay omits streamStatus (no SSE); absent must read as live.
		const { container } = renderNode( { streamStatus: undefined } );
		expect( container.textContent ).toMatch( /LIVE/ );
	} );

	it( 'lists first target under "target →" and the rest under "also →"', () => {
		const { container } = renderNode();
		const rows = container.querySelectorAll( '.topology-field-row__key' );
		const labels = Array.from( rows ).map( ( r ) => r.textContent );
		expect( labels ).toContain( 'target →' );
		expect( labels ).toContain( 'also →' );
	} );

	it( 'renders a dash for routing when there are no edges', () => {
		const { container } = render(
			<Inspector
				{ ...baseProps }
				selectedId="solo"
				parsed={ {
					nodes: [ { id: 'solo', class: 'Echo' } ],
					edges: [],
				} }
				nodeIds={ new Set( [ 'solo' ] ) }
			/>
		);
		expect(
			container.querySelector( '.topology-field-row__val--dim' )
		).not.toBeNull();
	} );

	it( 'shows a clickable name link in routing when target is a known node', () => {
		const onSelect = jest.fn();
		const { container } = renderNode( { onSelect } );
		const link = container.querySelector( '.topology-field-row__nav' );
		fireEvent.click( link );
		expect( onSelect ).toHaveBeenCalledWith( 'tee_a' );
	} );

	it( 'reports hover enter/leave for known routing target links', () => {
		const onHover = jest.fn();
		const { container } = renderNode( { onHover } );
		const link = container.querySelector( '.topology-field-row__nav' );
		fireEvent.mouseEnter( link );
		fireEvent.mouseLeave( link );
		expect( onHover.mock.calls ).toEqual( [ [ 'tee_a' ], [ null ] ] );
	} );

	it( 'omits the Activity section when rateInfo has no message/byte signals', () => {
		const { container } = renderNode();
		expect( container.textContent ).not.toMatch( /Activity/ );
	} );

	it( 'shows the Activity section + sparkline row when rateInfo flags it', () => {
		const { container } = renderNode( {
			rateInfo: {
				hasMessages: true,
				history: [ 1, 2, 3 ],
				rate: 5,
			},
		} );
		expect( container.textContent ).toMatch( /Activity/ );
		expect( container.textContent ).toMatch( /messages \/s/ );
	} );

	it( 'formats activity and throughput edge values', () => {
		jest.useFakeTimers();
		jest.setSystemTime( new Date( '2026-01-01T00:00:00Z' ) );
		try {
			const richNode = {
				id: 'echo',
				class: 'Echo',
				count: 0,
				lgstMsg: -1,
				bytesRead: 1024 * 1024 * 1024,
				bytesWritten: 0,
			};
			const { container } = render(
				<Inspector
					{ ...baseProps }
					selectedId="echo"
					parsed={ { nodes: [ richNode ], edges: [] } }
					nodeIds={ new Set( [ 'echo' ] ) }
					rateInfo={ {
						hasMessages: true,
						history: [ 0, 150 ],
						rate: 150,
						hasRead: true,
						readHistory: [ 0 ],
						readRate: 0.5,
						hasWritten: true,
						writtenHistory: [ 0, 1024 * 1024 * 1024 ],
						writtenRate: 1024 * 1024 * 1024,
						lastChangedTs: Date.now() / 1000 - 3600,
					} }
				/>
			);

			expect( container.textContent ).toMatch( /150 \/s/ );
			expect( container.textContent ).toMatch( /0 B\/s/ );
			expect( container.textContent ).toMatch( /1\.0 G\/s/ );
			expect( container.textContent ).toMatch( /1\.0 G/ );
			expect( container.textContent ).toMatch( /1h ago/ );
		} finally {
			jest.useRealTimers();
		}
	} );

	it( 'renders array-valued constructor arguments without crashing [token-array]', () => {
		// node.arguments is a token array (list<string>) post-migration; the
		// read-only Constructor view must consume it as tokens, not a string.
		const { container } = render(
			<Inspector
				{ ...baseProps }
				selectedId="lg"
				parsed={ {
					nodes: [
						{
							id: 'lg',
							class: 'Log',
							arguments: [ '/logs/x.p0', '4096' ],
						},
					],
					edges: [],
				} }
				nodeIds={ new Set( [ 'lg' ] ) }
				catalog={ [
					{
						shell_name: 'Log',
						arguments: [
							{ name: 'file', type: 'string' },
							{ name: 'segment_size', type: 'int' },
						],
					},
				] }
			/>
		);
		expect( container.textContent ).toContain( '/logs/x.p0' );
		expect( container.textContent ).toContain( '4096' );
	} );

	it( 'renders bytes formatters in Throughput rows', () => {
		const { container } = renderNode();
		// lgstMsg = 4096 → "4.0 K"
		expect( container.textContent ).toMatch( /4\.0 K/ );
		// bytesWritten = 3 MB
		expect( container.textContent ).toMatch( /3\.0 M/ );
	} );

	it( 'formats counter with locale separators', () => {
		const { container } = renderNode();
		expect( container.textContent ).toMatch( /1,234/ );
	} );

	it( 'renders Dump + Send + Trace buttons', () => {
		const { getByText } = renderNode();
		expect( getByText( 'Dump' ) ).not.toBeNull();
		expect( getByText( 'Send' ) ).not.toBeNull();
		expect( getByText( 'Trace' ) ).not.toBeNull();
	} );

	it( 'keeps action buttons enabled even when not live (live graph is hackable)', () => {
		const { getByText } = renderNode( { streamStatus: 'closed' } );
		expect( getByText( 'Dump' ).disabled ).toBe( false );
		expect( getByText( 'Send' ).disabled ).toBe( false );
		expect( getByText( 'Trace' ).disabled ).toBe( false );
	} );

	it( 'flips Trace label when node.debugState > 0', () => {
		const { getByText } = render(
			<Inspector
				{ ...baseProps }
				selectedId="echo"
				parsed={ {
					nodes: [ { ...node, debugState: 1 } ],
					edges: [],
				} }
				nodeIds={ new Set( [ 'echo' ] ) }
			/>
		);
		expect( getByText( 'Stop Trace' ) ).not.toBeNull();
	} );

	it( 'fires onAction("dump", id) when Dump is clicked', () => {
		const onAction = jest.fn();
		const { getByText } = renderNode( { onAction } );
		fireEvent.click( getByText( 'Dump' ) );
		expect( onAction ).toHaveBeenCalledWith( 'dump', 'echo' );
	} );

	it( 'fires trace and Tee tail/disconnect actions from action buttons', () => {
		const traceAction = jest.fn();
		const traceView = renderNode( { onAction: traceAction } );
		fireEvent.click( traceView.getByText( 'Trace' ) );
		expect( traceAction ).toHaveBeenCalledWith( 'trace', 'echo', 1 );
		traceView.unmount();

		const tailAction = jest.fn();
		const teeNode = {
			id: 'tee_a',
			class: 'Tee',
			count: 0,
			target: [],
			targets: [],
		};
		const tailView = render(
			<Inspector
				{ ...baseProps }
				selectedId="tee_a"
				parsed={ { nodes: [ teeNode ], edges: [] } }
				nodeIds={ new Set( [ 'tee_a' ] ) }
				onAction={ tailAction }
			/>
		);
		fireEvent.click( tailView.getByText( 'Connect' ) );
		expect( tailAction ).toHaveBeenCalledWith( 'tail', 'tee_a' );
		tailView.unmount();

		const disconnectAction = jest.fn();
		render(
			<Inspector
				{ ...baseProps }
				selectedId="tee_a"
				parsed={ {
					nodes: [
						{
							...teeNode,
							targets: [ '_output' ],
						},
					],
					edges: [],
					pwd: '_output',
				} }
				nodeIds={ new Set( [ 'tee_a' ] ) }
				onAction={ disconnectAction }
			/>
		);
		fireEvent.click( document.querySelector( 'button.is-active' ) );
		expect( disconnectAction ).toHaveBeenCalledWith(
			'disconnect',
			'tee_a'
		);
	} );

	it( 'shows the tail/tap button for a Tee SUBCLASS driven by the catalog is_tee flag', () => {
		// Tail button keys off catalog is_tee, not the runtime target shape.
		const tapAction = jest.fn();
		const tapNode = {
			id: 'tap_a',
			class: 'Tap',
			count: 0,
			target: '',
			targets: [],
		};
		const { getByText } = render(
			<Inspector
				{ ...baseProps }
				selectedId="tap_a"
				parsed={ { nodes: [ tapNode ], edges: [] } }
				nodeIds={ new Set( [ 'tap_a' ] ) }
				catalog={ [ { shell_name: 'Tap', is_tee: true } ] }
				onAction={ tapAction }
			/>
		);
		fireEvent.click( getByText( 'Connect' ) );
		expect( tapAction ).toHaveBeenCalledWith( 'tail', 'tap_a' );
	} );

	it( 'opens a send modal and fires onAction("send", id, payload) when confirmed', () => {
		const onAction = jest.fn();
		const { getByText, getByDisplayValue } = renderNode( {
			onAction,
		} );
		fireEvent.click( getByText( 'Send' ) );
		// A prompt modal appears with a text input (portaled to <body>).
		const input = document.body.querySelector( '.topology-modal__input' );
		expect( input ).not.toBeNull();
		fireEvent.change( input, { target: { value: 'hello' } } );
		fireEvent.click(
			getByDisplayValue( 'hello' )
				.closest( '.topology-modal' )
				.querySelector( '.button-primary' )
		);
		expect( onAction ).toHaveBeenCalledWith( 'send', 'echo', 'hello' );
		// Modal closes after confirm.
		expect( document.body.querySelector( '.topology-modal' ) ).toBeNull();
	} );

	it( 'does not fire onAction when the send modal is cancelled', () => {
		const onAction = jest.fn();
		const { getByText } = renderNode( { onAction } );
		fireEvent.click( getByText( 'Send' ) );
		expect(
			document.body.querySelector( '.topology-modal' )
		).not.toBeNull();
		fireEvent.click( getByText( 'Cancel' ) );
		expect( onAction ).not.toHaveBeenCalled();
		expect( document.body.querySelector( '.topology-modal' ) ).toBeNull();
	} );

	it( 'opens a Tell modal and fires onAction("tell", id, info) when confirmed', () => {
		const onAction = jest.fn();
		const { getByText, getByDisplayValue } = renderNode( { onAction } );
		fireEvent.click( getByText( 'Tell' ) );
		const input = document.body.querySelector( '.topology-modal__input' );
		expect( input ).not.toBeNull();
		fireEvent.change( input, { target: { value: 'heads up' } } );
		fireEvent.click(
			getByDisplayValue( 'heads up' )
				.closest( '.topology-modal' )
				.querySelector( '.button-primary' )
		);
		expect( onAction ).toHaveBeenCalledWith( 'tell', 'echo', 'heads up' );
	} );

	it( 'opens a Struct modal and fires onAction("send_struct", id, json) when confirmed', () => {
		const onAction = jest.fn();
		const { getByText, getByDisplayValue } = renderNode( { onAction } );
		fireEvent.click( getByText( 'Struct' ) );
		const input = document.body.querySelector( '.topology-modal__input' );
		expect( input ).not.toBeNull();
		fireEvent.change( input, { target: { value: '{"k":1}' } } );
		fireEvent.click(
			getByDisplayValue( '{"k":1}' )
				.closest( '.topology-modal' )
				.querySelector( '.button-primary' )
		);
		expect( onAction ).toHaveBeenCalledWith(
			'send_struct',
			'echo',
			'{"k":1}'
		);
	} );

	it( 'Register opens a modal that dispatches register <source> <target> <event>', () => {
		const onAction = jest.fn();
		const { getByText } = renderNode( {
			onAction,
			catalog: [ { shell_name: 'Echo', registrations: [ 'FIRE' ] } ],
		} );
		fireEvent.click( getByText( 'Register' ) );
		// event defaults to FIRE, target to the only other node (tee_a).
		const selects = document.body.querySelectorAll(
			'.topology-modal__body select'
		);
		expect( selects ).toHaveLength( 2 );
		fireEvent.click(
			document.body.querySelector(
				'.topology-modal__actions .button-primary'
			)
		);
		expect( onAction ).toHaveBeenCalledWith(
			'register',
			'echo',
			'tee_a FIRE'
		);
	} );

	it( 'Register modal Cancel button closes it without dispatching', () => {
		const onAction = jest.fn();
		const { getByText } = renderNode( {
			onAction,
			catalog: [ { shell_name: 'Echo', registrations: [ 'FIRE' ] } ],
		} );
		fireEvent.click( getByText( 'Register' ) );
		expect(
			document.body.querySelector( '.topology-modal__body' )
		).not.toBeNull();
		fireEvent.click(
			document.body.querySelector(
				'.topology-modal__actions .button:not(.button-primary)'
			)
		);
		expect(
			document.body.querySelector( '.topology-modal__body' )
		).toBeNull();
		expect( onAction ).not.toHaveBeenCalled();
	} );

	it( 'hides Register when the class declares no registration events', () => {
		const { queryByText } = renderNode( {
			catalog: [ { shell_name: 'Echo' } ],
		} );
		expect( queryByText( 'Register' ) ).toBeNull();
	} );

	it( 'lists current registrations with an × that dispatches unregister', () => {
		const onAction = jest.fn();
		const { getByRole } = render(
			<Inspector
				{ ...baseProps }
				selectedId="src"
				onAction={ onAction }
				parsed={ {
					nodes: [
						{
							id: 'src',
							class: 'Timer',
							registrations: { FIRE: [ 'lst' ] },
						},
					],
					edges: [],
				} }
				nodeIds={ new Set( [ 'src' ] ) }
			/>
		);
		fireEvent.click(
			getByRole( 'button', { name: /Unregister lst from FIRE/i } )
		);
		expect( onAction ).toHaveBeenCalledWith(
			'unregister',
			'src',
			'lst FIRE'
		);
	} );

	it( 'renders a Connect button on Tee nodes', () => {
		const teeNode = { id: 'tee_a', class: 'Tee', count: 0, target: [] };
		const { getByText } = render(
			<Inspector
				{ ...baseProps }
				selectedId="tee_a"
				parsed={ { nodes: [ teeNode ], edges: [] } }
				nodeIds={ new Set( [ 'tee_a' ] ) }
				ssePid={ 9 }
			/>
		);
		expect( getByText( 'Connect' ) ).not.toBeNull();
	} );

	it( 'flips Connect → Disconnect when parsed.pwd is in the node FULL targets (edges head-collapse to _repl)', () => {
		// Reply-path edge collapses to _repl; toggle matches pwd vs targets.
		const teeNode = {
			id: 'tee_a',
			class: 'Tee',
			count: 0,
			target: [ 'request-builder', '_repl/_output/_sse:9/_output' ],
			targets: [ 'request-builder', '_repl/_output/_sse:9/_output' ],
		};
		const { getByText } = render(
			<Inspector
				{ ...baseProps }
				selectedId="tee_a"
				parsed={ {
					nodes: [ teeNode ],
					edges: [
						{ from: 'tee_a', to: 'request-builder' },
						{ from: 'tee_a', to: '_repl' },
					],
					pwd: '_repl/_output/_sse:9/_output',
				} }
				nodeIds={ new Set( [ 'tee_a' ] ) }
			/>
		);
		expect( getByText( 'Disconnect' ) ).not.toBeNull();
	} );

	it( 'works for the in-browser JS tee where pwd is the bare _output', () => {
		const teeNode = {
			id: 'tee_a',
			class: 'Tee',
			count: 0,
			target: [ '_output' ],
			targets: [ '_output' ],
		};
		const { getByText } = render(
			<Inspector
				{ ...baseProps }
				selectedId="tee_a"
				parsed={ {
					nodes: [ teeNode ],
					edges: [],
					pwd: '_output',
				} }
				nodeIds={ new Set( [ 'tee_a' ] ) }
			/>
		);
		expect( getByText( 'Disconnect' ) ).not.toBeNull();
	} );

	it( 'stays Connect when only ANOTHER session reply path is wired (collapsed _repl edge is shared)', () => {
		// Another session's path also collapses to _repl; must stay Connect.
		const teeNode = {
			id: 'tee_a',
			class: 'Tee',
			count: 0,
			target: [ '_repl/_output/_sse:777/_output' ],
			targets: [ '_repl/_output/_sse:777/_output' ],
		};
		const { getByText } = render(
			<Inspector
				{ ...baseProps }
				selectedId="tee_a"
				parsed={ {
					nodes: [ teeNode ],
					edges: [ { from: 'tee_a', to: '_repl' } ],
					pwd: '_repl/_output/_sse:9/_output',
				} }
				nodeIds={ new Set( [ 'tee_a' ] ) }
			/>
		);
		expect( getByText( 'Connect' ) ).not.toBeNull();
	} );

	it( 'live verb modal node_name select is populated from the live graph', () => {
		const catalog = [
			{
				shell_name: 'Echo',
				commands: [
					{
						name: 'set_target',
						args: [
							{
								name: 'target',
								type: 'node_name',
								required: true,
							},
						],
					},
				],
			},
		];
		const { getByText } = renderNode( { catalog } );
		fireEvent.click( getByText( 'set_target' ) ); // opens the arg modal
		const select = document.body.querySelector( '.topology-modal select' );
		const opts = [ ...select.options ].map( ( o ) => o.value );
		expect( opts ).toContain( 'tee_a' ); // a live node from parsed.nodes
		expect( opts ).not.toContain( 'echo' ); // self excluded
	} );

	it( 'renders TM_REQUEST buttons from the catalog and wires onAction', () => {
		const onAction = jest.fn();
		const catalog = [
			{
				shell_name: 'Echo',
				requests: [ { name: 'inspect', description: 'Inspect' } ],
			},
		];
		const { getByText } = renderNode( { catalog, onAction } );
		fireEvent.click( getByText( 'inspect' ) );
		expect( onAction ).toHaveBeenCalledWith( 'invoke', 'echo', {
			verb: 'inspect',
			kind: 'request',
			positional: '',
			byName: {},
		} );
	} );

	it( 'renders argless TM_COMMAND verb buttons and fires invoke', () => {
		const onAction = jest.fn();
		const catalog = [
			{
				shell_name: 'Echo',
				commands: [ { name: 'GET_LAG', description: 'Lag' } ],
			},
		];
		const { getByText } = renderNode( { catalog, onAction } );
		fireEvent.click( getByText( 'GET_LAG' ) );
		expect( onAction ).toHaveBeenCalledWith( 'invoke', 'echo', {
			verb: 'GET_LAG',
			kind: 'command',
			positional: '',
			byName: {},
		} );
	} );

	it( 'opens an arg modal for a verb with args; Run fires invoke; Cancel closes silently', () => {
		const onAction = jest.fn();
		const catalog = [
			{
				shell_name: 'Echo',
				commands: [
					{
						name: 'with_index',
						args: [
							{
								name: 'formatter',
								type: 'string',
								required: true,
							},
						],
					},
				],
			},
		];
		const { getByText, getByLabelText, queryByText } = renderNode( {
			catalog,
			onAction,
		} );

		// Cancel path: open, then dismiss without firing.
		fireEvent.click( getByText( 'with_index' ) );
		expect( queryByText( 'Run' ) ).not.toBeNull();
		fireEvent.click( getByText( 'Cancel' ) );
		expect( onAction ).not.toHaveBeenCalled();
		expect( queryByText( 'Run' ) ).toBeNull();

		// Run path: open, fill the arg, Run.
		fireEvent.click( getByText( 'with_index' ) );
		const field = getByLabelText( /formatter/ );
		fireEvent.change( field, { target: { value: 'json' } } );
		fireEvent.click( getByText( 'Run' ) );
		expect( onAction ).toHaveBeenCalledWith( 'invoke', 'echo', {
			verb: 'with_index',
			kind: 'command',
			positional: 'json',
			byName: { formatter: 'json' },
		} );
	} );

	it( 'runs a verb with optional blank args as an empty invocation payload', () => {
		const onAction = jest.fn();
		const catalog = [
			{
				shell_name: 'Echo',
				commands: [
					{
						name: 'optional_arg',
						args: [ { name: 'maybe', type: 'string' } ],
					},
				],
			},
		];
		const { getByText } = renderNode( { catalog, onAction } );
		fireEvent.click( getByText( 'optional_arg' ) );
		fireEvent.click( getByText( 'Run' ) );
		expect( onAction ).toHaveBeenCalledWith( 'invoke', 'echo', {
			verb: 'optional_arg',
			kind: 'command',
			positional: '',
			byName: {},
		} );
	} );

	it( 'clicking a live verb button is a no-op when no action handler is wired', () => {
		const catalog = [
			{
				shell_name: 'Echo',
				commands: [ { name: 'noop', args: [] } ],
			},
		];
		const { getByText } = renderNode( { catalog, onAction: null } );
		expect( () => fireEvent.click( getByText( 'noop' ) ) ).not.toThrow();
	} );

	it( 'hides verb buttons (allow_large_writes, with_index, …) for a reserved spine node', () => {
		// Reserved spine node (by id): its verb buttons are blocked.
		const catalog = [
			{
				shell_name: 'Partition',
				commands: [ { name: 'allow_large_writes', args: [] } ],
				requests: [ { name: 'with_index', args: [] } ],
			},
		];
		const { queryByText, getByText } = render(
			<Inspector
				{ ...baseProps }
				selectedId="_repl"
				parsed={ {
					nodes: [
						{
							id: '_repl',
							class: 'Partition',
							count: 1,
						},
					],
					edges: [],
				} }
				nodeIds={ new Set( [ '_repl' ] ) }
				catalog={ catalog }
			/>
		);
		expect( queryByText( 'allow_large_writes' ) ).toBeNull();
		expect( queryByText( 'with_index' ) ).toBeNull();
		// Dump / Send / Trace stay — they're the user's inspection commands.
		expect( getByText( 'Dump' ) ).not.toBeNull();
		expect( getByText( 'Send' ) ).not.toBeNull();
		expect( getByText( 'Trace' ) ).not.toBeNull();
	} );

	it( 'hides verb buttons flagged hidden:true while keeping normal verbs', () => {
		// A hidden:true command renders no verb button; normal ones do.
		const catalog = [
			{
				shell_name: 'Echo',
				commands: [
					{ name: 'PAUSE', hidden: true },
					{ name: 'set_line_mode' },
				],
			},
		];
		const { queryByText } = renderNode( { catalog } );
		expect( queryByText( 'PAUSE' ) ).toBeNull();
		expect( queryByText( 'set_line_mode' ) ).not.toBeNull();
	} );

	// Consumer = frames + cursor; frame ids ≠ cursor seg — don't conflate.
	const consumerNode = {
		id: 'firehose-consumer',
		class: 'Consumer',
		count: 0,
		frames: [
			{ id: 5342, size: 120 },
			{ id: 5343, size: 40 },
			{ id: 5344, size: 80 },
		],
		cursor: { segment: 2, offset: 12 },
	};

	it( 'shows the Time Travel section for a node carrying frames + cursor', () => {
		const { queryByText, container } = render(
			<Inspector
				{ ...baseProps }
				selectedId="firehose-consumer"
				parsed={ { nodes: [ consumerNode ], edges: [] } }
				nodeIds={ new Set( [ 'firehose-consumer' ] ) }
			/>
		);
		expect( queryByText( 'Time Travel' ) ).not.toBeNull();
		// Ruler renders one marker per frame, straight from node.frames.
		expect(
			container.querySelectorAll( '.topology-tt__marker' )
		).toHaveLength( 3 );
	} );

	it( 'passes the polling signal to the panel — paused when polling is PAUSED', () => {
		const { getByLabelText } = render(
			<Inspector
				{ ...baseProps }
				selectedId="firehose-consumer"
				parsed={ {
					nodes: [ { ...consumerNode, polling: 'PAUSED' } ],
					edges: [],
				} }
				nodeIds={ new Set( [ 'firehose-consumer' ] ) }
			/>
		);
		// The signal alone gates the transport: pause off, step enabled.
		expect( getByLabelText( /pause/i ).disabled ).toBe( true );
		expect( getByLabelText( /step/i ).disabled ).toBe( false );
	} );

	it( 'panel is live when the consumer is polling ACTIVE', () => {
		const { getByLabelText } = render(
			<Inspector
				{ ...baseProps }
				selectedId="firehose-consumer"
				parsed={ {
					nodes: [ { ...consumerNode, polling: 'ACTIVE' } ],
					edges: [],
				} }
				nodeIds={ new Set( [ 'firehose-consumer' ] ) }
			/>
		);
		expect( getByLabelText( /pause/i ).disabled ).toBe( false );
		expect( getByLabelText( /step/i ).disabled ).toBe( true );
	} );

	it( 'does NOT show the Time Travel section for a node without frames', () => {
		const { queryByText } = render(
			<Inspector
				{ ...baseProps }
				selectedId="echo"
				parsed={ {
					nodes: [ { id: 'echo', class: 'Echo' } ],
					edges: [],
				} }
				nodeIds={ new Set( [ 'echo' ] ) }
			/>
		);
		expect( queryByText( 'Time Travel' ) ).toBeNull();
	} );

	it( 'does NOT qualify a node that has frames but no cursor (plumbing)', () => {
		const { queryByText } = render(
			<Inspector
				{ ...baseProps }
				selectedId="x"
				parsed={ {
					nodes: [ { id: 'x', class: 'Foo', frames: [] } ],
					edges: [],
				} }
				nodeIds={ new Set( [ 'x' ] ) }
			/>
		);
		expect( queryByText( 'Time Travel' ) ).toBeNull();
	} );

	it( 'routes transport buttons through onAction("invoke") as :config commands', () => {
		const onAction = jest.fn();
		const { getByLabelText } = render(
			<Inspector
				{ ...baseProps }
				selectedId="firehose-consumer"
				parsed={ { nodes: [ consumerNode ], edges: [] } }
				nodeIds={ new Set( [ 'firehose-consumer' ] ) }
				onAction={ onAction }
			/>
		);
		// PAUSE gates the transport; it wires through with no positional.
		fireEvent.click( getByLabelText( /pause/i ) );
		expect( onAction ).toHaveBeenLastCalledWith(
			'invoke',
			'firehose-consumer',
			{ verb: 'PAUSE', kind: 'command', positional: '', byName: {} }
		);
		// First rewind lands on the NEWEST keyframe 5344; positional→segment.
		fireEvent.click( getByLabelText( /rewind/i ) );
		expect( onAction ).toHaveBeenLastCalledWith(
			'invoke',
			'firehose-consumer',
			{
				verb: 'SEEK_FRAME',
				kind: 'command',
				positional: '5344',
				byName: { segment: '5344' },
			}
		);
		// Rewind again steps to the previous keyframe (5343)…
		fireEvent.click( getByLabelText( /rewind/i ) );
		expect( onAction ).toHaveBeenLastCalledWith(
			'invoke',
			'firehose-consumer',
			{
				verb: 'SEEK_FRAME',
				kind: 'command',
				positional: '5343',
				byName: { segment: '5343' },
			}
		);
		// …and fast-forward walks back to the next keyframe (5344).
		fireEvent.click( getByLabelText( /fast.?forward/i ) );
		expect( onAction ).toHaveBeenLastCalledWith(
			'invoke',
			'firehose-consumer',
			{
				verb: 'SEEK_FRAME',
				kind: 'command',
				positional: '5344',
				byName: { segment: '5344' },
			}
		);
	} );

	it( 'shows the constructor arguments read-only, paired with the schema arg names', () => {
		const part = {
			id: 'errors',
			class: 'Partition',
			arguments: [ '/tmp/logs/errors.p0', '4096', '8' ],
		};
		const { container } = render(
			<Inspector
				{ ...baseProps }
				selectedId="errors"
				parsed={ { nodes: [ part ], edges: [] } }
				catalog={ [
					{
						shell_name: 'Partition',
						arguments: [
							{ name: 'dir', required: true },
							{ name: 'segment_size' },
							{ name: 'max_segments' },
						],
					},
				] }
			/>
		);
		expect( container.textContent ).toMatch( /Constructor/ );
		// Schema arg names paired with the node's positional values.
		expect( container.textContent ).toContain( 'dir' );
		expect( container.textContent ).toContain( '/tmp/logs/errors.p0' );
		expect( container.textContent ).toContain( 'segment_size' );
		expect( container.textContent ).toContain( '4096' );
		expect( container.textContent ).toContain( 'max_segments' );
		expect( container.textContent ).toContain( '8' );
		// Read-only: the section has no editable inputs.
		expect(
			container.querySelectorAll( '.topology-insp__arg input' ).length
		).toBe( 0 );
	} );

	it( 'folds a free-form trailing argument into the final positional slot', () => {
		const fetcher = {
			id: 'f',
			class: 'Fetcher',
			arguments: [ 'overviewIn', 'overview', 'a', 'b', 'c' ],
		};
		const { container } = render(
			<Inspector
				{ ...baseProps }
				selectedId="f"
				parsed={ { nodes: [ fetcher ], edges: [] } }
				catalog={ [
					{
						shell_name: 'Fetcher',
						arguments: [
							{ name: 'receiver' },
							{ name: 'command' },
							{ name: 'arguments' },
						],
					},
				] }
			/>
		);
		const vals = [
			...container.querySelectorAll( '.topology-insp__arg-val' ),
		].map( ( el ) => el.textContent );
		expect( vals ).toEqual( [ 'overviewIn', 'overview', 'a b c' ] );
	} );

	it( 'falls back to the schema default (dimmed) for an omitted optional argument', () => {
		const part = { id: 'p', class: 'Partition', arguments: [ '/tmp/x' ] };
		const { container } = render(
			<Inspector
				{ ...baseProps }
				selectedId="p"
				parsed={ { nodes: [ part ], edges: [] } }
				catalog={ [
					{
						shell_name: 'Partition',
						arguments: [
							{ name: 'dir', required: true },
							{ name: 'segment_size', default: 4096 },
						],
					},
				] }
			/>
		);
		const vals = [
			...container.querySelectorAll( '.topology-insp__arg-val' ),
		];
		// dir was passed — normal style.
		expect( vals[ 0 ].textContent ).toBe( '/tmp/x' );
		expect( vals[ 0 ].className ).not.toMatch( /--default/ );
		// segment_size omitted — shows the schema default, dimmed.
		expect( vals[ 1 ].textContent ).toBe( '4096' );
		expect( vals[ 1 ].className ).toMatch( /--default/ );
	} );

	it( 'omits the Constructor section when the class declares no arguments', () => {
		const { container } = render(
			<Inspector
				{ ...baseProps }
				selectedId="e"
				parsed={ {
					nodes: [ { id: 'e', class: 'Echo', arguments: [] } ],
					edges: [],
				} }
				catalog={ [ { shell_name: 'Echo', arguments: [] } ] }
			/>
		);
		expect( container.textContent ).not.toMatch( /Constructor/ );
	} );
} );

// Activity window = 60 samples × poll interval (scales), not a fixed ~60s.
describe( 'formatActivityWindow', () => {
	it( 'reads ~5m for a small graph (poll cadence floored at 5s)', () => {
		// 50 nodes -> floored 5s poll -> 60 * 5s = 300s = 5m.
		expect( formatActivityWindow( 50 ) ).toBe( 'last ~5m' );
	} );

	it( 'scales to minutes for a large graph polled less often', () => {
		// 500 nodes -> 5s poll -> 60 * 5s = 300s = 5m.
		expect( formatActivityWindow( 500 ) ).toBe( 'last ~5m' );
		// 3000 nodes -> 30s poll -> 60 * 30s = 1800s = 30m.
		expect( formatActivityWindow( 3000 ) ).toBe( 'last ~30m' );
	} );
} );
