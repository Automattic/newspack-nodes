/**
 * The core blocks every composed context admits, as a reader reads them:
 * each in the element and classes core writes, so core's `wp-block-library`
 * sheet, which the page enqueues, lays out its columns. A text block's text
 * reaches the page as the server filtered it to inline formatting, on every
 * read, so it renders as HTML. A group's layout is written as the inline
 * style core's layout engine would generate, since an admin page carries no
 * theme's global styles.
 *
 * The reader half of the composition layer: it imports no block library.
 */

import { createElement } from '@wordpress/element';

/** A flex layout's `justifyContent` as CSS. */
const JUSTIFY = {
	left: 'flex-start',
	center: 'center',
	right: 'flex-end',
	'space-between': 'space-between',
	stretch: 'stretch',
};

/** A flex layout's `verticalAlignment` as CSS. */
const ALIGN = {
	top: 'flex-start',
	center: 'center',
	bottom: 'flex-end',
	stretch: 'stretch',
	'space-between': 'space-between',
};

/** A layout type whose class core spells otherwise. */
const LAYOUT_CLASS = { default: 'flow' };

/** Core's column width for a grid that names no column count. */
const GRID_MINIMUM = '12rem';

/**
 * A group's layout as the style core's layout engine gives it: a flex row
 * centres its items and wraps, a vertical one starts them at the left, and
 * a grid takes its column count or fills with columns of its minimum width.
 *
 * @param {Object} [layout] The group's `layout` attribute.
 * @return {Object|undefined} The style, or none for a stacked group.
 */
function layoutStyle( layout ) {
	if ( 'grid' === layout?.type ) {
		return {
			display: 'grid',
			gridTemplateColumns: layout.columnCount
				? `repeat(${ layout.columnCount }, minmax(0, 1fr))`
				: `repeat(auto-fill, minmax(min(${
						layout.minimumColumnWidth ?? GRID_MINIMUM
				  }, 100%), 1fr))`,
		};
	}
	if ( 'flex' !== layout?.type ) {
		return undefined;
	}
	const justify = JUSTIFY[ layout.justifyContent ];
	const align = ALIGN[ layout.verticalAlignment ];
	return 'vertical' === layout.orientation
		? {
				display: 'flex',
				flexDirection: 'column',
				alignItems: justify ?? 'flex-start',
				justifyContent: align,
		  }
		: {
				display: 'flex',
				flexDirection: 'row',
				flexWrap: layout.flexWrap ?? 'wrap',
				justifyContent: justify,
				alignItems: align ?? 'center',
		  };
}

/**
 * A text block's element holding its filtered text.
 *
 * @param {Object} props
 * @param {string} props.tag         The element.
 * @param {string} [props.className] Its class.
 * @param {string} [props.dir]       Its writing direction.
 * @param {string} props.content     The text, as the server filtered it.
 * @return {import('react').ReactElement} The element.
 */
function Text( { tag, className, dir, content } ) {
	// The server filters the text to inline formatting on every read.
	return createElement( tag, {
		className,
		dir,
		dangerouslySetInnerHTML: { __html: content },
	} );
}

/**
 * @param {Object}                           props
 * @param {{level: number, content: string}} props.attributes Its level and text.
 * @return {import('react').ReactElement} The heading.
 */
const Heading = ( { attributes } ) => (
	<Text
		tag={ `h${ attributes.level }` }
		className="wp-block-heading"
		content={ attributes.content }
	/>
);

/**
 * @param {Object}                                props
 * @param {{direction?: string, content: string}} props.attributes Its writing direction and text.
 * @return {import('react').ReactElement} The paragraph.
 */
const Paragraph = ( { attributes } ) => (
	<Text tag="p" dir={ attributes.direction } content={ attributes.content } />
);

/**
 * @param {Object}            props
 * @param {{content: string}} props.attributes Its text.
 * @return {import('react').ReactElement} The item.
 */
const ListItem = ( { attributes } ) => (
	<Text tag="li" content={ attributes.content } />
);

/**
 * @param {Object}                                                               props
 * @param {{ordered: boolean, reversed: boolean, start?: number, type?: string}} props.attributes Whether it is numbered, and how.
 * @param {import('react').ReactNode}                                            [props.children] Its items, rendered.
 * @return {import('react').ReactElement} The list.
 */
function List( { attributes, children } ) {
	if ( ! attributes.ordered ) {
		return <ul className="wp-block-list">{ children }</ul>;
	}
	return (
		<ol
			className="wp-block-list"
			start={ attributes.start }
			reversed={ attributes.reversed || undefined }
			style={
				attributes.type ? { listStyleType: attributes.type } : undefined
			}
		>
			{ children }
		</ol>
	);
}

/**
 * A container's classes and style for its layout, as core writes them: its
 * block class, and for a laid-out one the layout's classes and inline style.
 *
 * @param {string} block    The block's class.
 * @param {Object} [layout] Its `layout` attribute.
 * @return {{className: string, style: (Object|undefined)}} The props.
 */
function laidOut( block, layout ) {
	const type = LAYOUT_CLASS[ layout?.type ] ?? layout?.type;
	return {
		className: type
			? `${ block } is-layout-${ type } ${ block }-is-layout-${ type }`
			: block,
		style: layoutStyle( layout ),
	};
}

/**
 * @param {Object}                             props
 * @param {{tagName: string, layout?: Object}} props.attributes Its element and layout.
 * @param {import('react').ReactNode}          [props.children] Its blocks, rendered.
 * @return {import('react').ReactElement} The group.
 */
function Group( { attributes, children } ) {
	return createElement(
		attributes.tagName,
		laidOut( 'wp-block-group', attributes.layout ),
		children
	);
}

/**
 * @param {Object}                                                   props
 * @param {{isStackedOnMobile: boolean, verticalAlignment?: string}} props.attributes Whether it stacks on a phone, and how its columns align.
 * @param {import('react').ReactNode}                                [props.children] Its columns, rendered.
 * @return {import('react').ReactElement} The columns.
 */
function Columns( { attributes, children } ) {
	const classes = [ 'wp-block-columns' ];
	if ( attributes.verticalAlignment ) {
		classes.push(
			`are-vertically-aligned-${ attributes.verticalAlignment }`
		);
	}
	if ( false === attributes.isStackedOnMobile ) {
		classes.push( 'is-not-stacked-on-mobile' );
	}
	return <div className={ classes.join( ' ' ) }>{ children }</div>;
}

/**
 * @param {Object}                                                        props
 * @param {{verticalAlignment?: string, width?: string, layout?: Object}} props.attributes How it aligns, its width and its layout.
 * @param {import('react').ReactNode}                                     [props.children] Its blocks, rendered.
 * @return {import('react').ReactElement} The column.
 */
function Column( { attributes, children } ) {
	const { className, style } = laidOut(
		'wp-block-column',
		attributes.layout
	);
	return (
		<div
			className={
				attributes.verticalAlignment
					? `${ className } is-vertically-aligned-${ attributes.verticalAlignment }`
					: className
			}
			style={
				attributes.width
					? { ...style, flexBasis: attributes.width }
					: style
			}
		>
			{ children }
		</div>
	);
}

/**
 * @param {Object}            props
 * @param {{tagName: string}} props.attributes Its element.
 * @return {import('react').ReactElement} The separator.
 */
const Separator = ( { attributes } ) =>
	createElement( attributes.tagName, {
		className: 'wp-block-separator has-alpha-channel-opacity',
	} );

/**
 * A spacer's size, and in a flex group its size along the group's axis: a
 * fixed one's `flexSize` as its basis, a filling one growing, and a filling
 * or fitting one with no height, as core saves it.
 *
 * @param {Object}                                                                                         props
 * @param {{height: string, width?: string, style?: {layout?: {flexSize?: string, selfStretch?: string}}}} props.attributes Its size.
 * @return {import('react').ReactElement} The spacer.
 */
const Spacer = ( { attributes } ) => {
	const { flexSize, selfStretch } = attributes.style?.layout ?? {};
	return (
		<div
			className="wp-block-spacer"
			aria-hidden="true"
			style={ {
				height:
					'fill' === selfStretch || 'fit' === selfStretch
						? undefined
						: attributes.height,
				width: attributes.width,
				flexBasis: 'fixed' === selfStretch ? flexSize : undefined,
				flexGrow: 'fill' === selfStretch ? 1 : undefined,
			} }
		/>
	);
};

/** Core block name => its reader's view. */
export const CORE_VIEWS = {
	'core/heading': { View: Heading },
	'core/paragraph': { View: Paragraph },
	'core/list': { View: List },
	'core/list-item': { View: ListItem },
	'core/group': { View: Group },
	'core/columns': { View: Columns },
	'core/column': { View: Column },
	'core/separator': { View: Separator },
	'core/spacer': { View: Spacer },
};
