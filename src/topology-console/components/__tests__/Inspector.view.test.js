/**
 * Inspector view-mode rendering (edit-mode paths live in a separate file).
 */

import { render, fireEvent } from '@testing-library/react';
import Inspector from '../Inspector';

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
	it( 'renders the empty-state when no node is selected', () => {
		const { container } = render( <Inspector { ...baseProps } /> );
		expect( container.textContent ).toMatch( /Select a node/ );
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
		nodes: [ node, { id: 'tee_a', class: 'Tee' } ],
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

	it( 'renders LIVE without crashing when streamStatus is undefined (overlay case)', () => {
		// The debug overlay reads the page's own Core synchronously — there is no
		// SSE stream to report, so it omits streamStatus. The Inspector used to
		// crash on `streamStatus.toUpperCase()`; now it treats absent status as
		// live (the graph it is showing literally is the local in-realm graph).
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

	it( 'fires onAction("send", id, payload) when Send prompt is confirmed', () => {
		const onAction = jest.fn();
		const origPrompt = window.prompt;
		window.prompt = () => 'hello';
		const { getByText } = renderNode( { onAction } );
		fireEvent.click( getByText( 'Send' ) );
		expect( onAction ).toHaveBeenCalledWith( 'send', 'echo', 'hello' );
		window.prompt = origPrompt;
	} );

	it( 'does not fire onAction when Send prompt is cancelled', () => {
		const onAction = jest.fn();
		const origPrompt = window.prompt;
		window.prompt = () => null;
		const { getByText } = renderNode( { onAction } );
		fireEvent.click( getByText( 'Send' ) );
		expect( onAction ).not.toHaveBeenCalled();
		window.prompt = origPrompt;
	} );

	it( 'renders a Connect button on Tee nodes', () => {
		const teeNode = { id: 'tee_a', class: 'Tee', count: 0 };
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

	it( 'flips Connect → Disconnect when an _output edge already exists', () => {
		const teeNode = { id: 'tee_a', class: 'Tee', count: 0 };
		const { getByText } = render(
			<Inspector
				{ ...baseProps }
				selectedId="tee_a"
				parsed={ {
					nodes: [ teeNode ],
					edges: [
						{
							from: 'tee_a',
							to: '_repl/_http/_sse:9/_output',
						},
					],
				} }
				nodeIds={ new Set( [ 'tee_a' ] ) }
				ssePid={ 9 }
			/>
		);
		expect( getByText( 'Disconnect' ) ).not.toBeNull();
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
		const { getByText, container } = renderNode( { catalog } );
		fireEvent.click( getByText( 'set_target' ) ); // opens the arg modal
		const select = container.querySelector( '.topology-modal select' );
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
} );
