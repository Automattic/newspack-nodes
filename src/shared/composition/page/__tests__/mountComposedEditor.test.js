/* eslint-env jest */
/**
 * A page's layout editor mounted in one call: the localized context's blocks
 * registered against the consumer's views, the substrate's aside among them,
 * each View providing `editing` to the write controls it holds, and an editor
 * for the page's slot that stands inside the consumer's providers, previews
 * through the consumer's `preview` and sends for the page's group.
 *
 * `@wordpress/blocks` and the command wire run for real;
 * `@wordpress/block-editor` is the stand-in `CompositionEditor.test.js`
 * describes.
 */

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import {
	getBlockType,
	getBlockTypes,
	unregisterBlockType,
} from '@wordpress/blocks';
import { Core, VALUE } from '@newspack-nodes/runtime';
import { installFakeCommandWire } from '@newspack-nodes/shared/test-utils/fakeCommandWire';
import { compositionEditor } from '../../editorRegistry';
import { ASIDE, ComposedPage, useWriteControl } from '..';
import { mountComposedEditor } from '../mountComposedEditor';
import { registerSource, useSource } from '../../../sources';

jest.mock( '@wordpress/block-editor', () => {
	const pass = ( { children } ) => <div>{ children }</div>;
	return {
		BlockEditorProvider: ( { children } ) => children,
		BlockTools: pass,
		WritingFlow: pass,
		ObserveTyping: pass,
		BlockList: () => <div data-testid="block-list" />,
		BlockInspector: () => null,
		Inserter: () => null,
		InspectorControls: pass,
		InnerBlocks: () => <div data-testid="inner-blocks" />,
		useBlockProps: () => ( {} ),
	};
} );

const CONTEXT = 'kaka-7730/roost';

/** What `Composition::editor()` localizes for the context. */
const LOCALIZED = {
	context: CONTEXT,
	max_blocks: 13,
	blocks: {
		'kaka-7730/perch': {
			title: 'Perch',
			attributes: { label: { type: 'string', default: '' } },
			container: false,
			multiple: true,
		},
		[ ASIDE ]: {
			title: 'Aside',
			attributes: {},
			container: true,
			multiple: false,
		},
	},
	patterns: [],
};

/** A write the perch holds one component down. */
const onFeed = jest.fn();

const Feed = () => (
	<button type="button" { ...useWriteControl( onFeed ) }>
		Feed the kaka
	</button>
);

/**
 * @param {Object} props
 * @param {Object} props.attributes Its attributes.
 * @return {import('react').ReactElement} The perch.
 */
const Perch = ( { attributes } ) => (
	<p data-testid="perch">
		{ attributes.label }
		<Feed />
	</p>
);

/** Every view the consumer has, one of them on another context. */
const VIEWS = {
	'kaka-7730/perch': { View: Perch },
	'kaka-7730/nest': { View: () => <p>Nest</p> },
};

/** The page the consumer's wrap provides. */
const PAGE = {
	group: 'kaka-desk',
	canTune: true,
	onRestored: () => {},
};

/**
 * A registered block's edit, rendered as the editor renders it.
 *
 * @param {string} name       The block name.
 * @param {Object} attributes Its attributes.
 */
function renderEdit( name, attributes ) {
	const { edit: Edit } = getBlockType( name );
	render( <Edit attributes={ attributes } setAttributes={ () => {} } /> );
}

beforeEach( () => {
	Core.reset();
	onFeed.mockClear();
	window.NewspackNodesData = { restUrl: '/wp-json/', nonce: 'NONCE' };
	installFakeCommandWire( () => ( {
		context: CONTEXT,
		source: 'default',
		blocks: [],
		saved_ts: null,
		actor: null,
	} ) );
} );

afterEach( () => {
	getBlockTypes().forEach( ( { name } ) => unregisterBlockType( name ) );
} );

registerSource( 'kaka-7734', {
	kind: 'command',
	group: 'kaka-desk',
	ci: 'roost-7734',
	command: 'perch_count',
	args: () => [],
} );

/**
 * A preview reading the roost's perches through a source.
 *
 * @return {import('react').ReactElement} The preview.
 */
function SourcedPreview() {
	const { loading } = useSource( 'kaka-7734' );
	return (
		<span data-testid="preview">
			{ loading ? 'counting perches' : 'perches counted' }
		</span>
	);
}

describe( 'mountComposedEditor', () => {
	it( 'serves a preview’s sources with no provider of the consumer’s own', async () => {
		mountComposedEditor( LOCALIZED, VIEWS, {
			heading: 'Edit the roost at Pier 7734',
			wrap: ( children ) => (
				<ComposedPage.Provider value={ PAGE }>
					{ children }
				</ComposedPage.Provider>
			),
			preview: SourcedPreview,
		} );
		const Editor = compositionEditor( CONTEXT );
		render( <Editor onDone={ jest.fn() } onDirty={ jest.fn() } /> );

		expect( screen.getByTestId( 'preview' ).textContent ).toBe(
			'counting perches'
		);
		expect( await screen.findByText( 'perches counted' ) ).toBeTruthy();
	} );

	it( 'registers the localized blocks alone, the aside by AsideView', () => {
		mountComposedEditor( LOCALIZED, VIEWS, { heading: 'Edit the roost' } );

		expect(
			getBlockTypes()
				.map( ( { name } ) => name )
				.sort()
		).toEqual( [ 'kaka-7730/perch', ASIDE ] );
		renderEdit( ASIDE, {} );
		expect(
			document.querySelector( 'aside.newspack-nodes-composed-aside' )
		).not.toBeNull();
		expect( screen.getByTestId( 'inner-blocks' ) ).toBeTruthy();
	} );

	it( 'leaves a write control inside a block’s View inert', () => {
		mountComposedEditor( LOCALIZED, VIEWS, { heading: 'Edit the roost' } );
		renderEdit( 'kaka-7730/perch', { label: 'Perch 7732' } );
		const button = screen.getByRole( 'button', { name: 'Feed the kaka' } );

		fireEvent.click( button );

		expect( screen.getByTestId( 'perch' ).textContent ).toContain(
			'Perch 7732'
		);
		expect( onFeed ).not.toHaveBeenCalled();
		expect( button.getAttribute( 'aria-disabled' ) ).toBe( 'true' );
	} );

	it( 'renders the editor inside the consumer’s wrap, previewing through its preview', async () => {
		mountComposedEditor( LOCALIZED, VIEWS, {
			heading: 'Edit the roost at Kaka Point',
			wrap: ( children, props ) => (
				<ComposedPage.Provider value={ PAGE }>
					<div data-testid="wrap" data-pier={ props.pier }>
						{ children }
					</div>
				</ComposedPage.Provider>
			),
			preview: ( props ) => (
				<span data-testid="preview">{ `Preview with ${ props.pier }` }</span>
			),
		} );
		const Editor = compositionEditor( CONTEXT );
		render(
			<Editor
				pier="Pier 7731"
				onDone={ jest.fn() }
				onDirty={ jest.fn() }
			/>
		);

		const wrap = screen.getByTestId( 'wrap' );
		expect( wrap.dataset.pier ).toBe( 'Pier 7731' );
		expect(
			wrap.querySelector(
				'.newspack-nodes-composition-editor__header [data-testid="preview"]'
			).textContent
		).toBe( 'Preview with Pier 7731' );
		expect( screen.getByRole( 'heading' ).textContent ).toBe(
			'Edit the roost at Kaka Point'
		);
		await waitFor( () =>
			expect(
				Core.node( 'compositions:kaka-7730:roost:get:fetch' )?.target
			).toBe( 'kaka-desk:shell/_http/compositions' )
		);
	} );

	it( 'stands under the page’s own ComposedPage when given no wrap', async () => {
		mountComposedEditor( LOCALIZED, VIEWS, {
			heading: 'Edit the roost at Pier 7733',
		} );
		const Editor = compositionEditor( CONTEXT );
		render(
			<ComposedPage.Provider value={ { ...PAGE, group: 'ruru-desk' } }>
				<Editor onDone={ jest.fn() } onDirty={ jest.fn() } />
			</ComposedPage.Provider>
		);

		expect( screen.getByRole( 'heading' ).textContent ).toBe(
			'Edit the roost at Pier 7733'
		);
		expect( screen.queryByTestId( 'preview' ) ).toBeNull();
		await waitFor( () =>
			expect(
				Core.node( 'compositions:kaka-7730:roost:get:fetch' )?.target
			).toBe( 'ruru-desk:shell/_http/compositions' )
		);
	} );

	it( 'refuses a localized block that has no view, as registration does', () => {
		const localized = {
			...LOCALIZED,
			blocks: {
				...LOCALIZED.blocks,
				'kaka-7730/branch': {
					title: 'Branch',
					attributes: {},
					container: false,
					multiple: true,
				},
			},
		};

		expect( () =>
			mountComposedEditor( localized, VIEWS, {
				heading: 'Edit the roost',
			} )
		).toThrow( 'kaka-7730/branch has no view' );
	} );
} );

describe( 'a page’s source declarations across its two entries', () => {
	const HIHI_CONTEXT = 'hihi-7841/canopy';

	/** What `Composition::editor()` localizes for the canopy. */
	const HIHI_LOCALIZED = {
		context: HIHI_CONTEXT,
		max_blocks: 4,
		blocks: {
			'hihi-7841/flock': {
				title: 'Flock',
				attributes: { tree: { type: 'string', default: '' } },
				container: false,
				multiple: true,
			},
		},
		patterns: [],
	};

	/**
	 * Load an entry as a bundle of its own: a module copy, with the React,
	 * renderer and command wire that copy renders and posts through. Its
	 * renderer registers its own cleanup, so it loads as the suite collects.
	 *
	 * @param {string} path The entry.
	 * @return {Object} Its exports, `rtl` and `wire`.
	 */
	function loadEntry( path ) {
		let entry;
		jest.isolateModules( () => {
			entry = {
				...require( path ),
				rtl: require( '@testing-library/react' ),
				wire: require( '@newspack-nodes/shared/test-utils/fakeCommandWire' ),
			};
		} );
		return entry;
	}

	const reader = loadEntry( './fixtures/hihiReaderEntry' );
	const editor = loadEntry( './fixtures/hihiEditorEntry' );
	const bare = loadEntry( './fixtures/hihiEditorEntryWithoutSources' );

	/**
	 * Answer a copy's commands: the flock's count, and the canopy's default.
	 *
	 * @param {Object} entry What `loadEntry()` answered.
	 */
	function answer( entry ) {
		entry.wire.installFakeCommandWire( ( m ) =>
			'flock' === m[ VALUE ].name
				? { birds: 23 }
				: {
						context: HIHI_CONTEXT,
						source: 'default',
						blocks: [],
						saved_ts: null,
						actor: null,
				  }
		);
	}

	/**
	 * Mount an entry's editor, previewing its flock block, and render it.
	 *
	 * @param {Object} entry What `loadEntry()` answered.
	 */
	function renderEditor( entry ) {
		const { View } = entry.HIHI_VIEWS[ 'hihi-7841/flock' ];
		entry.mountComposedEditor( HIHI_LOCALIZED, entry.HIHI_VIEWS, {
			heading: 'Edit the canopy at Hihi 7841',
			wrap: ( children ) => (
				<entry.ComposedPage.Provider
					value={ { ...PAGE, group: 'hihi-desk' } }
				>
					{ children }
				</entry.ComposedPage.Provider>
			),
			preview: () => <View attributes={ { tree: 'rimu-7841' } } />,
		} );
		const Editor = entry.compositionEditor( HIHI_CONTEXT );
		entry.rtl.render(
			<Editor onDone={ jest.fn() } onDirty={ jest.fn() } />
		);
	}

	it( 'serves a block’s source in the editor when both entries import the declarations', async () => {
		answer( reader );
		reader.rtl.render(
			<reader.ComposedLayout
				layout={ {
					context: HIHI_CONTEXT,
					blocks: [
						{
							name: 'hihi-7841/flock',
							attributes: { tree: 'kanuka-7841' },
							inner: [],
						},
					],
				} }
				views={ reader.HIHI_VIEWS }
				page={ { ...PAGE, group: 'hihi-desk' } }
			/>
		);
		expect(
			await reader.rtl.screen.findByText( '23 birds in kanuka-7841' )
		).toBeTruthy();
		reader.rtl.cleanup();

		answer( editor );
		renderEditor( editor );

		expect(
			await editor.rtl.screen.findByText( '23 birds in rimu-7841' )
		).toBeTruthy();
	} );

	it( 'refuses a block’s source in an editor entry that leaves the declarations to the reader', () => {
		jest.spyOn( console, 'error' ).mockImplementation( () => {} );
		answer( bare );

		expect( () => renderEditor( bare ) ).toThrow(
			"no source is declared as 'hihi-7841'"
		);
	} );
} );
