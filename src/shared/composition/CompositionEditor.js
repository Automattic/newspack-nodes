/**
 * CompositionEditor — a context's layout in the block editor, on the page it
 * lays out.
 *
 * It edits a fresh `compositions get`, never the page's own copy, which
 * another editor's save may have outdated. The canvas admits the consumer's
 * blocks alone; a 320 px inspector holds the selected block's Controls; the
 * heading row carries the page's `preview`, a "Start from" picker of the
 * context's patterns where it offers any, and the three ways out. A pattern
 * replaces the canvas unsaved, asking first when a change is pending; Restore
 * default always asks.
 *
 * `onDone( answer, verb )` hands the page the layout it renders next and the
 * write that produced it: `save` or `restore`, or null for Cancel and Back,
 * whose answer is the fresh read, or null where the editor read none. The
 * page shows the "Layout saved." snackbar for a `save`, because the editor
 * is gone by then.
 *
 * Below EDITOR_MIN_PX the editor stays mounted and shows a notice in place
 * of its canvas, so a narrow spell keeps the edits.
 *
 * The editor half of the composition layer: the page builds it into a bundle
 * of its own, which `Composition::editor()` enqueues for a `tune` caller, and
 * reaches it through `CompositionEditSlot`.
 */

import { BlockInspector, Inserter } from '@wordpress/block-editor';
import { createBlock, parse, serializeRawBlock } from '@wordpress/blocks';
import { Notice, SelectControl, Spinner } from '@wordpress/components';
import { useEffect, useMemo, useRef, useState } from '@wordpress/element';
import { __ } from '@wordpress/i18n';
import BlockCanvas from '../components/BlockCanvas';
import { Confirm } from '../components/Modal';
import { useWidthBelow } from '../hooks/useNarrow';
import { primaryButtonClass } from '../utils/buttonClass';
import { useComposition } from './useComposition';
import './CompositionEditor.scss';

/**
 * The narrowest viewport, in CSS pixels, that holds the canvas beside its
 * inspector.
 */
export const EDITOR_MIN_PX = 960;

/** A block name as `registerBlockType()` accepts one. */
const BLOCK_NAME = /[a-z][a-z0-9-]*\/[a-z][a-z0-9-]*/g;

/**
 * An editor block as the raw block `serializeRawBlock()` writes, a
 * container's children in its content, which a `save: () => null` block's
 * own markup would drop.
 *
 * @param {{name: string, attributes: Object, innerBlocks: Array}} block An editor block.
 * @return {Object} The raw block.
 */
function rawBlock( { name, attributes, innerBlocks } ) {
	return {
		blockName: name,
		attrs: attributes,
		innerBlocks: innerBlocks.map( rawBlock ),
		innerContent: innerBlocks.map( () => null ),
	};
}

/**
 * Editor blocks as the layout markup `compositions save` takes: delimiters
 * and their escaped JSON attributes, nothing else.
 *
 * @param {Array<{name: string, attributes: Object, innerBlocks: Array}>} blocks The editor's blocks.
 * @return {string} The markup.
 */
export function serializeLayout( blocks ) {
	return blocks
		.map( ( block ) => serializeRawBlock( rawBlock( block ) ) )
		.join( '' );
}

/**
 * A layout's tree as editor blocks.
 *
 * @param {import('./CompositionView').CompositionNode} node One node.
 * @return {Object} Its block.
 */
function toBlock( { name, attributes, inner } ) {
	return createBlock( name, attributes, inner.map( toBlock ) );
}

/**
 * The first block, depth first, carrying `name`.
 *
 * @param {Array}  blocks Editor blocks.
 * @param {string} name   A block name.
 * @return {?string} Its client id, or null for none.
 */
function firstNamed( blocks, name ) {
	for ( const block of blocks ) {
		if ( name === block.name ) {
			return block.clientId;
		}
		const inner = firstNamed( block.innerBlocks, name );
		if ( null !== inner ) {
			return inner;
		}
	}
	return null;
}

/**
 * The first declared block a refusal names, past the context it opens with.
 *
 * @param {string} refusal What the server refused.
 * @param {string} context The context refused.
 * @param {Object} schemas Block name => schema.
 * @return {?string} The block name, or null where it names none.
 */
function refusedName( refusal, context, schemas ) {
	const prefix = `composition ${ context }: `;
	const why = refusal.startsWith( prefix )
		? refusal.slice( prefix.length )
		: refusal;
	return (
		why
			.match( BLOCK_NAME )
			?.find( ( name ) => Object.hasOwn( schemas, name ) ) ?? null
	);
}

/**
 * Every block name in a list of editor blocks, depth first.
 *
 * @param {Array} blocks Editor blocks.
 * @return {string[]} Their names.
 */
function namesIn( blocks ) {
	return blocks.flatMap( ( { name, innerBlocks } ) => [
		name,
		...namesIn( innerBlocks ),
	] );
}

/**
 * A pattern the context offers, as `Composition::schemas()` lists it.
 *
 * @typedef {Object} CompositionPattern
 * @property {string} name   Its slug.
 * @property {string} title  The picker's name for it.
 * @property {string} markup The layout it starts from.
 */

/**
 * The layout editor.
 *
 * @param {Object}                                                                         props
 * @param {string}                                                                         props.group      The surface the commands are sent for.
 * @param {string}                                                                         props.context    The context edited, `<namespace>/<name>`.
 * @param {string}                                                                         props.heading    The editor's heading, in the consumer's words.
 * @param {Object<string,import('./registerCompositionBlocks').CompositionSchema>}         props.schemas    The blocks the context admits; pass a stable object, since a new one reselects a refused block.
 * @param {CompositionPattern[]}                                                           [props.patterns] The layouts the context offers to start from.
 * @param {import('react').ReactNode}                                                      [props.preview]  What the blocks preview with, beside the buttons.
 * @param {(answer: ?import('./useComposition').CompositionAnswer, verb: ?string) => void} props.onDone     Takes the layout the page renders next and the write behind it.
 * @param {(dirty: boolean) => void}                                                       [props.onDirty]  Told whether the layout holds a change not yet saved, as that turns.
 * @return {import('react').ReactElement} The editor.
 */
export default function CompositionEditor( {
	group,
	context,
	heading,
	schemas,
	patterns = [],
	preview,
	onDone,
	onDirty,
} ) {
	const narrow = useWidthBelow( EDITOR_MIN_PX );
	const [ asking, setAsking ] = useState(
		/** @type {null|'restore'|{then: ?CompositionPattern}} */ ( null )
	);
	const { answer, error, save, restore, refusal, writing } = useComposition(
		group,
		context,
		onDone
	);
	const [ blocks, setBlocks ] = useState( null );
	const [ dirty, setDirty ] = useState( false );
	const [ selection, setSelection ] = useState(
		/** @type {?{selectionStart: {clientId: string}, selectionEnd: {clientId: string}}} */ (
			null
		)
	);
	useEffect( () => {
		onDirty?.( dirty );
	}, [ dirty, onDirty ] );
	const blocksRef = useRef( blocks );
	blocksRef.current = blocks;

	useEffect( () => {
		if ( answer && null === blocksRef.current ) {
			setBlocks( answer.blocks.map( toBlock ) );
		}
	}, [ answer ] );

	useEffect( () => {
		const named = refusal ? refusedName( refusal, context, schemas ) : null;
		const current = blocksRef.current;
		const clientId =
			null !== named && current ? firstNamed( current, named ) : null;
		if ( null !== clientId ) {
			setSelection( {
				selectionStart: { clientId },
				selectionEnd: { clientId },
			} );
			// A fresh list resets the provider, which applies a selection.
			setBlocks( [ ...current ] );
		}
	}, [ refusal, context, schemas ] );

	const settings = useMemo(
		() => ( { allowedBlockTypes: Object.keys( schemas ) } ),
		[ schemas ]
	);
	const edit = ( next ) => {
		setBlocks( next );
		setDirty( true );
		setSelection( null );
	};
	const leave = () => {
		setSelection( null );
		onDone( answer, null );
	};
	const cancel = () => ( dirty ? setAsking( { then: null } ) : leave() );
	const start = ( pattern ) => {
		const parsed = parse( pattern.markup );
		const stray = namesIn( parsed ).find(
			( name ) => ! Object.hasOwn( schemas, name )
		);
		if ( undefined !== stray ) {
			throw new Error(
				`pattern ${ pattern.name } names ${ stray }, which ${ context } does not offer`
			);
		}
		setAsking( null );
		edit( parsed );
	};
	const choose = ( name ) => {
		const pattern = patterns.find( ( one ) => name === one.name );
		if ( dirty ) {
			setAsking( { then: pattern } );
		} else {
			start( pattern );
		}
	};

	let body = null;
	if ( narrow ) {
		body = (
			<div className="newspack-nodes-composition-editor__narrow">
				<p>
					{ __(
						'Edit the layout on a wider screen.',
						'newspack-nodes'
					) }
				</p>
				<button
					type="button"
					className="button"
					disabled={ writing }
					onClick={ cancel }
				>
					{ __( 'Back', 'newspack-nodes' ) }
				</button>
			</div>
		);
	} else if ( blocks ) {
		body = (
			<div className="newspack-nodes-composition-editor__canvas">
				<BlockCanvas
					blocks={ blocks }
					onInput={ edit }
					onChange={ edit }
					settings={ settings }
					selection={ selection }
				>
					<div className="newspack-nodes-composition-editor__inserter">
						<Inserter />
					</div>
					<aside className="newspack-nodes-composition-editor__inspector">
						<BlockInspector />
					</aside>
				</BlockCanvas>
			</div>
		);
	} else if ( ! error ) {
		body = <Spinner />;
	}

	return (
		<div className="newspack-nodes-composition-editor">
			<div className="newspack-nodes-composition-editor__header">
				<h2 className="newspack-nodes-composition-editor__heading">
					{ heading }
				</h2>
				{ preview }
				{ 0 < patterns.length && (
					<SelectControl
						__next40pxDefaultSize
						__nextHasNoMarginBottom
						label={ __( 'Start from', 'newspack-nodes' ) }
						labelPosition="side"
						value=""
						disabled={ writing }
						options={ [
							{
								value: '',
								label: __(
									'Choose a pattern',
									'newspack-nodes'
								),
								disabled: true,
							},
							...patterns.map( ( { name, title } ) => ( {
								value: name,
								label: title,
							} ) ),
						] }
						onChange={ choose }
					/>
				) }
				<button
					type="button"
					className="button"
					disabled={ writing }
					onClick={ () => setAsking( 'restore' ) }
				>
					{ __( 'Restore default', 'newspack-nodes' ) }
				</button>
				<button
					type="button"
					className="button"
					disabled={ writing }
					onClick={ cancel }
				>
					{ __( 'Cancel', 'newspack-nodes' ) }
				</button>
				<button
					type="button"
					className={ primaryButtonClass( ! blocks || writing ) }
					disabled={ ! blocks || writing }
					onClick={ () => save( serializeLayout( blocks ) ) }
				>
					{ __( 'Save layout', 'newspack-nodes' ) }
				</button>
			</div>
			{ error && (
				<Notice status="error" isDismissible={ false }>
					{ error }
				</Notice>
			) }
			{ refusal && (
				<Notice status="error" isDismissible={ false }>
					{ refusal }
				</Notice>
			) }
			{ body }
			{ null !== asking && 'restore' !== asking && (
				<Confirm
					title={ __(
						'Discard your changes to this layout?',
						'newspack-nodes'
					) }
					yes={ __( 'Discard changes', 'newspack-nodes' ) }
					no={ __( 'Keep editing', 'newspack-nodes' ) }
					onYes={ () =>
						asking.then ? start( asking.then ) : leave()
					}
					onNo={ () => setAsking( null ) }
				/>
			) }
			{ 'restore' === asking && (
				<Confirm
					title={ __(
						'Restore the default layout?',
						'newspack-nodes'
					) }
					body={ __(
						'Everyone who opens this page will see the default.',
						'newspack-nodes'
					) }
					yes={ __( 'Restore default', 'newspack-nodes' ) }
					no={ __( 'Cancel', 'newspack-nodes' ) }
					onYes={ () => {
						setAsking( null );
						restore();
					} }
					onNo={ () => setAsking( null ) }
				/>
			) }
		</div>
	);
}
