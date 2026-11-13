/* eslint-env jest */
/**
 * The layout editor: a block canvas over a fresh read of the context, the
 * consumer's blocks alone admitted, and three ways out — a save, a restore and
 * a cancel — each confirmed where it loses work, each handing the page the
 * layout it renders next and the write that produced it.
 *
 * The command wire is the fake server, so `useComposition` and
 * `useCommandOnce` run for real, and so does `@wordpress/blocks`: the blocks
 * register through `registerCompositionBlocks` and serialize through
 * `serializeRawBlock`. `@wordpress/block-editor` is a stand-in recording what
 * the provider is handed, because the real one needs the single
 * `wp.privateApis` copy WordPress hands every package. The real inserter
 * listing only the admitted blocks is owed to the eve run.
 */

import fs from 'fs';
import path from 'path';
import {
	act,
	fireEvent,
	render,
	screen,
	waitFor,
	within,
} from '@testing-library/react';
import { getBlockTypes, unregisterBlockType } from '@wordpress/blocks';
import { Core, VALUE } from '@newspack-nodes/runtime';
import { installFakeCommandWire } from '@newspack-nodes/shared/test-utils/fakeCommandWire';
import { installViewport } from '@newspack-nodes/shared/test-utils/viewportWidth';
import CompositionEditor, {
	EDITOR_MIN_PX,
	serializeLayout,
} from '../CompositionEditor';
import { registerCompositionBlocks } from '../registerCompositionBlocks';

const mockProvider = { props: null };

jest.mock( '@wordpress/block-editor', () => {
	const pass = ( { children } ) => <div>{ children }</div>;
	return {
		BlockEditorProvider: ( props ) => {
			mockProvider.props = props;
			return props.children;
		},
		BlockTools: pass,
		WritingFlow: pass,
		ObserveTyping: pass,
		BlockList: () => <div data-testid="block-list" />,
		BlockInspector: () => <div data-testid="block-inspector" />,
		Inserter: () => <div data-testid="inserter" />,
		InspectorControls: pass,
		InnerBlocks: () => null,
		useBlockProps: () => ( {} ),
	};
} );

const MARKUP_CASES = JSON.parse(
	fs.readFileSync(
		path.join(
			__dirname,
			'../../../../tests/fixtures/composition-markup.json'
		),
		'utf8'
	)
);

const CONTEXT = 'acme-desk/board';
const GROUP = 'quayside';

const SCHEMAS = {
	'acme-desk/tally': {
		title: 'Tally',
		attributes: {
			max: { type: 'integer', default: 10 },
			label: { type: 'string', default: '' },
		},
		container: false,
		multiple: true,
	},
	'acme-desk/column': {
		title: 'Column',
		attributes: {},
		container: true,
		multiple: false,
	},
};

// A block named as the context is, for the refusal that names both.
const BOARD = {
	'acme-desk/board': {
		title: 'Board',
		attributes: {},
		container: false,
		multiple: true,
	},
};

// The server's fresh read: a column holding a tally, then a second tally.
const SAVED = {
	context: CONTEXT,
	source: 'saved',
	blocks: [
		{
			name: 'acme-desk/column',
			attributes: {},
			inner: [
				{
					name: 'acme-desk/tally',
					attributes: { max: 4, label: 'Ferry' },
					inner: [],
				},
			],
		},
		{
			name: 'acme-desk/tally',
			attributes: { max: 7, label: 'Dock' },
			inner: [],
		},
	],
	saved_ts: 1912345678.5,
	actor: 'lakeside-editor',
};
const RESAVED = { ...SAVED, saved_ts: 1912349999.75 };
const DEFAULTED = { ...SAVED, source: 'default', blocks: [], actor: null };

// Two patterns the context offers, as `Composition::schemas()` lists them.
const PATTERNS = [
	{
		name: 'tui-7720',
		title: 'Tui at dawn',
		markup: '<!-- wp:acme-desk/tally {"max":3,"label":"Tui"} /-->',
	},
	{
		name: 'ruru-7721',
		title: 'Ruru roost',
		markup: '<!-- wp:acme-desk/column -->\n<!-- wp:acme-desk/tally {"max":9,"label":"Ruru"} /-->\n<!-- /wp:acme-desk/column -->\n<!-- wp:acme-desk/tally {"label":"Kea"} /-->',
	},
];

const WAIT = { timeout: 4000 };

let replyFor;
let viewport;

const sent = ( name ) =>
	replyFor.mock.calls
		.map( ( [ m ] ) => m[ VALUE ] )
		.filter( ( value ) => name === value.name );

const button = ( name ) => screen.getByRole( 'button', { name } );

// The editor itself, apart from the live regions a notice also speaks into.
const editor = () =>
	within( document.querySelector( '.newspack-nodes-composition-editor' ) );

/**
 * Render the editor.
 *
 * @param {Object} [extra] Props over the defaults.
 * @return {jest.Mock} The `onDone` handed in.
 */
function mount( extra = {} ) {
	const onDone = jest.fn();
	render(
		<CompositionEditor
			group={ GROUP }
			context={ CONTEXT }
			heading="Edit the pier board"
			schemas={ SCHEMAS }
			preview={ <span data-testid="preview">Preview with Pier 9</span> }
			onDone={ onDone }
			{ ...extra }
		/>
	);
	return onDone;
}

/**
 * Render the editor and wait for its fresh read to reach the canvas.
 *
 * @param {Object} [extra] Props over the defaults.
 * @return {Promise<jest.Mock>} The `onDone` handed in.
 */
async function mountLoaded( extra ) {
	const onDone = mount( extra );
	await waitFor(
		() => expect( mockProvider.props?.value ).toBeTruthy(),
		WAIT
	);
	return onDone;
}

/**
 * Edit the canvas as the block editor would: one committed change.
 *
 * @param {Array} blocks The block list after the edit.
 */
function edit( blocks ) {
	act( () => {
		mockProvider.props.onChange( blocks );
	} );
}

beforeAll( () => {
	registerCompositionBlocks(
		{ ...SCHEMAS, ...BOARD },
		{
			'acme-desk/tally': { View: () => null },
			'acme-desk/column': { View: () => null },
			'acme-desk/board': { View: () => null },
		}
	);
} );

afterAll( () => {
	getBlockTypes().forEach( ( { name } ) => unregisterBlockType( name ) );
} );

beforeEach( () => {
	Core.reset();
	mockProvider.props = null;
	window.NewspackNodesData = { restUrl: '/wp-json/', nonce: 'NONCE' };
	replyFor = jest.fn( ( m ) => {
		const { name } = m[ VALUE ];
		if ( 'save' === name ) {
			return RESAVED;
		}
		return 'restore' === name ? DEFAULTED : SAVED;
	} );
	installFakeCommandWire( ( m ) => replyFor( m ) );
} );

afterEach( () => {
	viewport?.restore();
	viewport = null;
} );

describe( 'serializeLayout', () => {
	it.each( MARKUP_CASES.map( ( one ) => [ one.name, one ] ) )(
		'writes %s as the markup the server parses back',
		( _name, { blocks, markup } ) => {
			expect( serializeLayout( blocks ) ).toBe( markup );
		}
	);
} );

describe( 'CompositionEditor', () => {
	it( 'edits a fresh read of the context, admitting only the schemas’ blocks', async () => {
		await mountLoaded();
		expect( sent( 'get' ) ).toEqual( [
			expect.objectContaining( { arguments: [ CONTEXT ] } ),
		] );
		expect( mockProvider.props.settings.allowedBlockTypes ).toEqual( [
			'acme-desk/tally',
			'acme-desk/column',
		] );
		const [ column, tally ] = mockProvider.props.value;
		expect( column.name ).toBe( 'acme-desk/column' );
		expect( column.innerBlocks[ 0 ].attributes ).toEqual( {
			max: 4,
			label: 'Ferry',
		} );
		expect( tally.attributes ).toEqual( { max: 7, label: 'Dock' } );
		expect( screen.getByTestId( 'inserter' ) ).toBeTruthy();
		expect( screen.getByTestId( 'block-inspector' ) ).toBeTruthy();
		expect( screen.getByRole( 'heading' ).textContent ).toBe(
			'Edit the pier board'
		);
		expect( screen.getByTestId( 'preview' ).textContent ).toBe(
			'Preview with Pier 9'
		);
	} );

	it( 'saves the edited layout once and hands onDone the reply and the save', async () => {
		const onDone = await mountLoaded();
		const [ , tally ] = mockProvider.props.value;
		edit( [ tally ] );

		fireEvent.click( button( 'Save layout' ) );
		fireEvent.click( button( 'Save layout' ) );
		await waitFor(
			() => expect( onDone ).toHaveBeenCalledTimes( 1 ),
			WAIT
		);
		expect( onDone ).toHaveBeenCalledWith( RESAVED, 'save' );
		expect( sent( 'save' ) ).toEqual( [
			expect.objectContaining( {
				arguments: [
					CONTEXT,
					'<!-- wp:acme-desk/tally {"max":7,"label":"Dock"} /-->',
				],
			} ),
		] );
		// The page owns the snackbar.
		expect( document.querySelector( '.components-snackbar' ) ).toBeNull();
	} );

	it( 'holds Cancel while a save is outstanding', async () => {
		let answer;
		const onDone = await mountLoaded();
		replyFor.mockImplementation(
			() =>
				new Promise( ( resolve ) => {
					answer = resolve;
				} )
		);

		fireEvent.click( button( 'Save layout' ) );
		await waitFor( () => expect( answer ).toBeDefined(), WAIT );
		expect( button( 'Cancel' ).disabled ).toBe( true );
		fireEvent.click( button( 'Cancel' ) );
		expect( onDone ).not.toHaveBeenCalled();

		await act( async () => answer( RESAVED ) );
		await waitFor(
			() => expect( onDone ).toHaveBeenCalledTimes( 1 ),
			WAIT
		);
		expect( onDone ).toHaveBeenCalledWith( RESAVED, 'save' );
		expect( button( 'Cancel' ).disabled ).toBe( false );
	} );

	it( 'leaves at once on Cancel with nothing changed', async () => {
		const onDone = await mountLoaded();
		fireEvent.click( button( 'Cancel' ) );
		expect( onDone ).toHaveBeenCalledWith( SAVED, null );
		expect( screen.queryByRole( 'dialog' ) ).toBeNull();
	} );

	it( 'asks before discarding a change, and sends nothing', async () => {
		const onDone = await mountLoaded();
		const [ column ] = mockProvider.props.value;
		edit( [ column ] );

		fireEvent.click( button( 'Cancel' ) );
		const dialog = screen.getByRole( 'dialog' );
		expect( dialog.textContent ).toContain(
			'Discard your changes to this layout?'
		);
		fireEvent.click( button( 'Keep editing' ) );
		expect( screen.queryByRole( 'dialog' ) ).toBeNull();
		expect( onDone ).not.toHaveBeenCalled();

		fireEvent.click( button( 'Cancel' ) );
		fireEvent.click( button( 'Discard changes' ) );
		expect( onDone ).toHaveBeenCalledWith( SAVED, null );
		expect( sent( 'save' ) ).toEqual( [] );
		expect( sent( 'restore' ) ).toEqual( [] );
	} );

	it( 'tells onDirty when the layout first holds a change, and not before', async () => {
		const onDirty = jest.fn();
		await mountLoaded( { onDirty } );
		expect( onDirty ).not.toHaveBeenCalledWith( true );
		const [ column ] = mockProvider.props.value;
		edit( [ column ] );
		expect( onDirty ).toHaveBeenLastCalledWith( true );
	} );

	it( 'asks before restoring the default, then restores it', async () => {
		const onDone = await mountLoaded();
		fireEvent.click( button( 'Restore default' ) );
		const dialog = screen.getByRole( 'dialog' );
		expect( dialog.textContent ).toContain(
			'Restore the default layout?Everyone who opens this page will see the default.'
		);
		expect( sent( 'restore' ) ).toEqual( [] );

		fireEvent.click(
			within( dialog ).getByRole( 'button', { name: 'Restore default' } )
		);
		await waitFor(
			() => expect( onDone ).toHaveBeenCalledTimes( 1 ),
			WAIT
		);
		expect( onDone ).toHaveBeenCalledWith( DEFAULTED, 'restore' );
		expect( sent( 'restore' ) ).toEqual( [
			expect.objectContaining( { arguments: [ CONTEXT ] } ),
		] );
	} );

	it( 'shows a refused save’s words and selects the first block it names', async () => {
		const onDone = await mountLoaded();
		const read = mockProvider.props.value;
		const words =
			'composition acme-desk/board: acme-desk/tally attribute max: max must be at most 20';
		replyFor.mockImplementation( () => new Error( words ) );

		fireEvent.click( button( 'Save layout' ) );
		await waitFor(
			() => expect( editor().getByText( words ) ).toBeTruthy(),
			WAIT
		);
		const inner = read[ 0 ].innerBlocks[ 0 ].clientId;
		await waitFor(
			() =>
				expect( mockProvider.props.selection ).toEqual( {
					selectionStart: { clientId: inner },
					selectionEnd: { clientId: inner },
				} ),
			WAIT
		);
		// A fresh list of the same blocks, so the provider applies the selection.
		expect( mockProvider.props.value ).not.toBe( read );
		expect( mockProvider.props.value ).toEqual( read );
		expect( onDone ).not.toHaveBeenCalled();
	} );

	it( 'forgets a refused block’s selection once the layout is edited', async () => {
		viewport = installViewport( false );
		await mountLoaded();
		const read = mockProvider.props.value;
		replyFor.mockImplementation(
			() =>
				new Error(
					'composition acme-desk/board: acme-desk/tally attribute max: max must be at most 20'
				)
		);
		fireEvent.click( button( 'Save layout' ) );
		await waitFor(
			() => expect( mockProvider.props.selection ).not.toBeNull(),
			WAIT
		);

		edit( [ read[ 1 ] ] );
		act( () => viewport.setNarrow( true ) );
		act( () => viewport.setNarrow( false ) );
		expect( mockProvider.props.selection ).toBeNull();
	} );

	it( 'reads the context’s name as no block in a refusal', async () => {
		// A block named as the context is, standing in the layout.
		const named = { ...SCHEMAS, ...BOARD };
		replyFor.mockImplementation( () => ( {
			...SAVED,
			blocks: [ { name: 'acme-desk/board', attributes: {}, inner: [] } ],
		} ) );
		await mountLoaded( { schemas: named } );
		replyFor.mockImplementation(
			() =>
				new Error(
					'composition acme-desk/board: 25 blocks, more than the 24 it holds'
				)
		);
		fireEvent.click( button( 'Save layout' ) );
		await waitFor(
			() => expect( editor().getByText( /25 blocks/ ) ).toBeTruthy(),
			WAIT
		);
		expect( mockProvider.props.selection ).toBeNull();
	} );

	it( 'shows a refused read in place of the canvas, still offering the default', async () => {
		const words =
			'composition acme-desk/board: acme-desk/beacon is not a declared block';
		replyFor.mockImplementation( ( m ) =>
			'get' === m[ VALUE ].name ? new Error( words ) : DEFAULTED
		);
		const onDone = mount();
		await waitFor(
			() => expect( editor().getByText( words ) ).toBeTruthy(),
			WAIT
		);
		expect( mockProvider.props ).toBeNull();
		expect( button( 'Save layout' ).disabled ).toBe( true );
		fireEvent.click( button( 'Restore default' ) );
		fireEvent.click(
			within( screen.getByRole( 'dialog' ) ).getByRole( 'button', {
				name: 'Restore default',
			} )
		);
		await waitFor(
			() => expect( onDone ).toHaveBeenCalledTimes( 1 ),
			WAIT
		);
		expect( onDone ).toHaveBeenCalledWith( DEFAULTED, 'restore' );
	} );

	it( 'asks for a wider screen below its minimum, and Back leaves', async () => {
		viewport = installViewport( true );
		const onDone = mount();
		expect( EDITOR_MIN_PX ).toBe( 960 );
		expect( viewport.queries ).toContain( '(width < 960px)' );
		expect(
			editor().getByText( 'Edit the layout on a wider screen.' )
		).toBeTruthy();
		await waitFor( () => expect( sent( 'get' ) ).toHaveLength( 1 ), WAIT );
		await waitFor(
			() => expect( button( 'Save layout' ).disabled ).toBe( false ),
			WAIT
		);
		expect( mockProvider.props ).toBeNull();

		fireEvent.click( button( 'Back' ) );
		expect( onDone ).toHaveBeenCalledWith( SAVED, null );
	} );

	it( 'keeps its edits across a narrow spell', async () => {
		viewport = installViewport( false );
		await mountLoaded();
		const [ , tally ] = mockProvider.props.value;
		const edited = [ tally ];
		edit( edited );

		act( () => viewport.setNarrow( true ) );
		expect(
			editor().getByText( 'Edit the layout on a wider screen.' )
		).toBeTruthy();
		expect( screen.queryByTestId( 'block-list' ) ).toBeNull();

		act( () => viewport.setNarrow( false ) );
		expect( mockProvider.props.value ).toBe( edited );
	} );

	it( 'asks before Back discards a change', async () => {
		viewport = installViewport( false );
		const onDone = await mountLoaded();
		const [ column ] = mockProvider.props.value;
		edit( [ column ] );
		act( () => viewport.setNarrow( true ) );

		fireEvent.click( button( 'Back' ) );
		expect( screen.getByRole( 'dialog' ).textContent ).toContain(
			'Discard your changes to this layout?'
		);
		expect( onDone ).not.toHaveBeenCalled();
		fireEvent.click( button( 'Discard changes' ) );
		expect( onDone ).toHaveBeenCalledWith( SAVED, null );
	} );

	describe( 'Start from', () => {
		const picker = () =>
			screen.getByRole( 'combobox', { name: 'Start from' } );
		const choose = ( name ) =>
			fireEvent.change( picker(), { target: { value: name } } );
		// A canvas block as its name, attributes and children.
		const shape = ( { name, attributes, innerBlocks, isValid } ) => ( {
			name,
			attributes,
			isValid,
			innerBlocks: innerBlocks.map( shape ),
		} );

		it( 'lists every pattern the context offers by its title', async () => {
			await mountLoaded( { patterns: PATTERNS } );
			expect(
				within( picker() )
					.getAllByRole( 'option' )
					.map( ( option ) => [ option.value, option.textContent ] )
					.filter( ( [ value ] ) => '' !== value )
			).toEqual( [
				[ 'tui-7720', 'Tui at dawn' ],
				[ 'ruru-7721', 'Ruru roost' ],
			] );
		} );

		it( 'puts a chosen pattern’s blocks on the canvas, unsaved', async () => {
			const onDirty = jest.fn();
			await mountLoaded( { patterns: PATTERNS, onDirty } );

			choose( 'ruru-7721' );

			expect( mockProvider.props.value.map( shape ) ).toEqual( [
				{
					name: 'acme-desk/column',
					attributes: {},
					isValid: true,
					innerBlocks: [
						{
							name: 'acme-desk/tally',
							attributes: { max: 9, label: 'Ruru' },
							isValid: true,
							innerBlocks: [],
						},
					],
				},
				{
					name: 'acme-desk/tally',
					attributes: { max: 10, label: 'Kea' },
					isValid: true,
					innerBlocks: [],
				},
			] );
			expect( onDirty ).toHaveBeenLastCalledWith( true );
			expect( screen.queryByRole( 'dialog' ) ).toBeNull();
			expect( sent( 'save' ) ).toEqual( [] );
		} );

		it( 'asks before a pattern replaces a change, and keeps the canvas on no', async () => {
			await mountLoaded( { patterns: PATTERNS } );
			const [ , tally ] = mockProvider.props.value;
			const edited = [ tally ];
			edit( edited );

			choose( 'tui-7720' );
			expect( screen.getByRole( 'dialog' ).textContent ).toContain(
				'Discard your changes to this layout?'
			);
			fireEvent.click( button( 'Keep editing' ) );
			expect( screen.queryByRole( 'dialog' ) ).toBeNull();
			expect( mockProvider.props.value ).toBe( edited );

			choose( 'tui-7720' );
			fireEvent.click( button( 'Discard changes' ) );
			expect( mockProvider.props.value.map( shape ) ).toEqual( [
				{
					name: 'acme-desk/tally',
					attributes: { max: 3, label: 'Tui' },
					isValid: true,
					innerBlocks: [],
				},
			] );
			expect( sent( 'save' ) ).toEqual( [] );
		} );

		it( 'saves a chosen pattern once Save layout is pressed', async () => {
			const onDone = await mountLoaded( { patterns: PATTERNS } );

			choose( 'ruru-7721' );
			fireEvent.click( button( 'Save layout' ) );
			await waitFor(
				() => expect( onDone ).toHaveBeenCalledTimes( 1 ),
				WAIT
			);

			expect( sent( 'save' ) ).toEqual( [
				expect.objectContaining( {
					arguments: [
						CONTEXT,
						'<!-- wp:acme-desk/column -->\n<!-- wp:acme-desk/tally {"max":9,"label":"Ruru"} /-->\n<!-- /wp:acme-desk/column --><!-- wp:acme-desk/tally {"max":10,"label":"Kea"} /-->',
					],
				} ),
			] );
		} );

		it( 'refuses a pattern naming a block the context does not offer', async () => {
			// A block the editor registered, which these schemas do not offer.
			const stray = {
				name: 'kea-7724',
				title: 'Kea at the board',
				markup: '<!-- wp:acme-desk/column --><!-- wp:acme-desk/board /--><!-- /wp:acme-desk/column -->',
			};
			await mountLoaded( { patterns: [ ...PATTERNS, stray ] } );
			const read = mockProvider.props.value;
			// React reports a handler's throw to the window, not to fireEvent.
			const thrown = [];
			const onError = ( event ) => {
				thrown.push( event.error );
				event.preventDefault();
			};
			window.addEventListener( 'error', onError );
			const error = jest
				.spyOn( console, 'error' )
				.mockImplementation( () => {} );
			try {
				choose( 'kea-7724' );
			} finally {
				window.removeEventListener( 'error', onError );
				error.mockRestore();
			}
			// React's development build reports one handler throw twice.
			expect( [
				...new Set( thrown.map( ( e ) => e.message ) ),
			] ).toEqual( [
				'pattern kea-7724 names acme-desk/board, which acme-desk/board does not offer',
			] );
			expect( mockProvider.props.value ).toBe( read );
		} );

		it( 'is not offered where the context offers no pattern', async () => {
			await mountLoaded( { patterns: [] } );
			expect(
				screen.queryByRole( 'combobox', { name: 'Start from' } )
			).toBeNull();
		} );
	} );
} );
