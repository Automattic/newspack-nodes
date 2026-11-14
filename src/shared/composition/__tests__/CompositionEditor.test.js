/* eslint-env jest */
/**
 * The layout editor: a block canvas over a fresh read of the context, the
 * schemas' blocks alone admitted, and three ways out — a save, a restore and
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
import {
	getBlockTypes,
	registerBlockType,
	unregisterBlockType,
} from '@wordpress/blocks';
import { Core, VALUE } from '@newspack-nodes/runtime';
import { installFakeCommandWire } from '@newspack-nodes/shared/test-utils/fakeCommandWire';
import { installViewport } from '@newspack-nodes/shared/test-utils/viewportWidth';
import { fakeWordPress } from '@newspack-nodes/shared/test-utils/fakeWordPress';
import CompositionEditor, {
	EDITOR_MIN_PX,
	serializeLayout,
} from '../CompositionEditor';
import { CANVAS_FEATURES } from '../confineCanvas';
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
		blocks: [
			{
				name: 'acme-desk/tally',
				attributes: { max: 3, label: 'Tui' },
				inner: [],
			},
		],
	},
	{
		name: 'ruru-7721',
		title: 'Ruru roost',
		blocks: [
			{
				name: 'acme-desk/column',
				attributes: {},
				inner: [
					{
						name: 'acme-desk/tally',
						attributes: { max: 9, label: 'Ruru' },
						inner: [],
					},
				],
			},
			{
				name: 'acme-desk/tally',
				attributes: { max: 10, label: 'Kea' },
				inner: [],
			},
		],
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
			inline={ [ 'strong', 'em' ] }
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
	window.wp = fakeWordPress();
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

// Core blocks as `Composition::schemas()` lists them, `text` the tag a block's text is written in.
const CORE = {
	'core/columns': {
		title: 'Columns',
		attributes: { isStackedOnMobile: { type: 'boolean', default: true } },
		container: true,
		multiple: true,
		core: true,
		text: null,
	},
	'core/column': {
		title: 'Column',
		attributes: { width: { type: 'string' } },
		container: true,
		multiple: true,
		core: true,
		text: null,
	},
	'core/heading': {
		title: 'Heading',
		attributes: { level: { type: 'integer', default: 2 } },
		container: false,
		multiple: true,
		core: true,
		text: 'h2',
	},
	'core/paragraph': {
		title: 'Paragraph',
		attributes: {},
		container: false,
		multiple: true,
		core: true,
		text: 'p',
	},
	'core/spacer': {
		title: 'Spacer',
		attributes: { height: { type: 'string', default: '100px' } },
		container: false,
		multiple: true,
		core: true,
		text: null,
	},
};

describe( 'serializeLayout', () => {
	it.each( MARKUP_CASES.map( ( one ) => [ one.name, one ] ) )(
		'writes %s as the markup the server parses back',
		( _name, { blocks, markup } ) => {
			expect( serializeLayout( blocks, { ...SCHEMAS, ...CORE } ) ).toBe(
				markup
			);
		}
	);

	it( 'leaves out an attribute holding its declared default, which the server lays back', () => {
		const blocks = [
			{
				name: 'acme-desk/tally',
				attributes: { max: 10, label: 'Weka 7954' },
				innerBlocks: [],
			},
		];

		expect( serializeLayout( blocks, SCHEMAS ) ).toBe(
			'<!-- wp:acme-desk/tally {"label":"Weka 7954"} /-->'
		);
	} );

	it( 'writes a core block’s declared attributes alone, and its rich text as its HTML', () => {
		const blocks = [
			{
				name: 'core/paragraph',
				attributes: {
					dropCap: true,
					// A rich-text value spells itself as its HTML.
					content: { toString: () => 'Moor <em>7930</em>' },
				},
				innerBlocks: [],
			},
		];

		expect( serializeLayout( blocks, CORE ) ).toBe(
			'<!-- wp:paragraph -->\n<p>Moor <em>7930</em></p>\n<!-- /wp:paragraph -->'
		);
	} );
} );

describe( 'CompositionEditor', () => {
	it( 'stays clean when the canvas writes back what the layout already held', async () => {
		const onDone = await mountLoaded();

		edit( mockProvider.props.value.map( ( block ) => ( { ...block } ) ) );
		fireEvent.click( button( 'Cancel' ) );

		expect( screen.queryByRole( 'dialog' ) ).toBeNull();
		expect( onDone ).toHaveBeenCalledWith( SAVED, null );
	} );

	it( 'offers no format a script registered after the page loaded', async () => {
		window.wp.loadPage();
		window.wp.richText.registerFormatType( 'kotuku/sparkle-7955', {
			tagName: 'mark',
		} );
		window.wp.richText.registerFormatType( 'kotuku/bold-7955', {
			tagName: 'strong',
		} );

		await mountLoaded();

		expect( window.wp.unregistered ).toEqual( [ 'kotuku/sparkle-7955' ] );
	} );

	it( 'hands the canvas no colour, typography, spacing or border setting', async () => {
		await mountLoaded();
		expect( mockProvider.props.settings.__experimentalFeatures ).toBe(
			CANVAS_FEATURES
		);
	} );

	it( 'refuses an indented list item, keeping the layout as it stood', async () => {
		const onDone = await mountLoaded();
		const before = mockProvider.props.value;

		edit( [
			{
				name: 'core/list',
				attributes: {},
				innerBlocks: [
					{
						name: 'core/list-item',
						attributes: { content: 'Skiff 7944' },
						innerBlocks: [
							{
								name: 'core/list',
								attributes: {},
								innerBlocks: [],
							},
						],
					},
				],
			},
		] );

		expect( mockProvider.props.value ).toEqual( before );
		expect( mockProvider.props.value ).not.toBe( before );
		fireEvent.click( button( 'Cancel' ) );
		expect( onDone ).toHaveBeenCalledWith( SAVED, null );
	} );

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

	describe( 'leaving the page', () => {
		/**
		 * Dispatch a cancelable `beforeunload`, as a navigation away does.
		 *
		 * @return {boolean} Whether a listener cancelled it.
		 */
		const held = () => {
			const event = new Event( 'beforeunload', { cancelable: true } );
			window.dispatchEvent( event );
			return event.defaultPrevented;
		};

		it( 'asks before the page goes while the layout holds a change', async () => {
			await mountLoaded();
			const [ column ] = mockProvider.props.value;
			edit( [ column ] );
			expect( held() ).toBe( true );
		} );

		it( 'lets the page go while the layout holds no change', async () => {
			await mountLoaded();
			expect( held() ).toBe( false );
		} );

		it( 'lets the page go once the change is saved', async () => {
			const onDone = await mountLoaded();
			const [ , tally ] = mockProvider.props.value;
			edit( [ tally ] );
			fireEvent.click( button( 'Save layout' ) );
			await waitFor(
				() => expect( onDone ).toHaveBeenCalledTimes( 1 ),
				WAIT
			);
			expect( held() ).toBe( false );
		} );
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
						'<!-- wp:acme-desk/column -->\n<!-- wp:acme-desk/tally {"max":9,"label":"Ruru"} /-->\n<!-- /wp:acme-desk/column --><!-- wp:acme-desk/tally {"label":"Kea"} /-->',
					],
				} ),
			] );
		} );

		it( 'opens a pattern holding a level-four heading in columns with no invalid block', async () => {
			const container = { save: () => null, category: 'design' };
			registerBlockType( 'core/columns', {
				...container,
				apiVersion: 3,
				title: 'Columns',
				attributes: {},
			} );
			registerBlockType( 'core/column', {
				...container,
				apiVersion: 3,
				title: 'Column',
				attributes: {},
			} );
			registerBlockType( 'core/heading', {
				apiVersion: 3,
				title: 'Heading',
				category: 'text',
				attributes: {
					level: { type: 'number', default: 2 },
					content: { type: 'string' },
				},
				save: ( { attributes } ) =>
					`<h${ attributes.level }>${ attributes.content }</h${ attributes.level }>`,
			} );
			const kotare = {
				name: 'kotare-7953',
				title: 'Kotare perch',
				blocks: [
					{
						name: 'core/columns',
						attributes: {},
						inner: [
							{
								name: 'core/column',
								attributes: {},
								inner: [
									{
										name: 'core/heading',
										attributes: {
											level: 4,
											content: 'Kotare 7953',
										},
										inner: [],
									},
								],
							},
						],
					},
				],
			};
			await mountLoaded( {
				patterns: [ ...PATTERNS, kotare ],
				schemas: { ...SCHEMAS, ...CORE },
			} );

			choose( 'kotare-7953' );

			expect( mockProvider.props.value.map( shape ) ).toEqual( [
				{
					name: 'core/columns',
					attributes: {},
					isValid: true,
					innerBlocks: [
						{
							name: 'core/column',
							attributes: {},
							isValid: true,
							innerBlocks: [
								{
									name: 'core/heading',
									attributes: {
										level: 4,
										content: 'Kotare 7953',
									},
									isValid: true,
									innerBlocks: [],
								},
							],
						},
					],
				},
			] );
		} );

		it( 'is not offered where the context offers no pattern', async () => {
			await mountLoaded( { patterns: [] } );
			expect(
				screen.queryByRole( 'combobox', { name: 'Start from' } )
			).toBeNull();
		} );
	} );
} );
