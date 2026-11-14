/**
 * The composition canvas offers only what a layout keeps. The server stores
 * a core block's declared attributes and a text block's inline formatting
 * alone, so every control that would set anything else is switched off
 * before a curator can use it: the settings through `CANVAS_FEATURES`, which
 * the editor hands its provider, and the supports, the block styles and the
 * formats through `confineCanvas()`, which the editor's mount runs once.
 *
 * The editor half of the composition layer.
 */

/** No preset of an origin-mapped setting, from any origin. */
const NO_PRESETS = Object.freeze( { default: [], theme: [], custom: [] } );

/**
 * The block-editor settings that would write a `style`, a preset class or
 * an attribute the server refuses, each switched off.
 */
export const CANVAS_FEATURES = Object.freeze( {
	color: {
		background: false,
		button: false,
		caption: false,
		custom: false,
		customDuotone: false,
		customGradient: false,
		defaultDuotone: false,
		defaultGradients: false,
		defaultPalette: false,
		duotone: NO_PRESETS,
		gradients: NO_PRESETS,
		heading: false,
		link: false,
		palette: NO_PRESETS,
		text: false,
	},
	typography: {
		customFontSize: false,
		defaultFontSizes: false,
		dropCap: false,
		fitText: false,
		fontFamilies: NO_PRESETS,
		fontSizes: NO_PRESETS,
		fontStyle: false,
		fontWeight: false,
		letterSpacing: false,
		lineHeight: false,
		textAlign: false,
		textColumns: false,
		textDecoration: false,
		textIndent: false,
		textTransform: false,
		writingMode: false,
	},
	spacing: {
		blockGap: false,
		customSpacingSize: false,
		defaultSpacingSizes: false,
		margin: false,
		padding: false,
		spacingSizes: NO_PRESETS,
		units: [],
	},
	border: { color: false, radius: false, style: false, width: false },
	dimensions: {
		aspectRatio: false,
		aspectRatios: NO_PRESETS,
		defaultAspectRatios: false,
		minHeight: false,
		minWidth: false,
	},
	shadow: { defaultPresets: false, presets: NO_PRESETS },
	background: { backgroundImage: false, backgroundSize: false },
	position: { fixed: false, sticky: false },
} );

/**
 * The supports whose attributes a layout does not keep, each switched off,
 * on core's blocks and on every block a context declares.
 */
export const UNKEPT_SUPPORTS = Object.freeze( {
	align: false,
	allowedBlocks: false,
	anchor: false,
	className: false,
	customClassName: false,
	customCSS: false,
	html: false,
	lock: false,
	renaming: false,
	reusable: false,
	typography: false,
	visibility: false,
} );

/**
 * A core block's supports less the ones a layout does not keep: those in
 * `UNKEPT_SUPPORTS`, and the width a flex or grid group gives each child,
 * which writes a `style` the server refuses.
 *
 * @param {Object} [supports] The supports it registered with.
 * @return {Object} The supports the canvas offers.
 */
function unkept( supports = {} ) {
	const confined = { ...supports, ...UNKEPT_SUPPORTS };
	if ( supports.layout?.allowSizingOnChildren ) {
		confined.layout = { ...supports.layout, allowSizingOnChildren: false };
	}
	return confined;
}

/** The registration filter's namespace, which marks a page already confined. */
const FILTER_NAMESPACE = 'newspack-nodes/composition-canvas';

/**
 * Confine `wp`'s editor to what a layout keeps: each of the `core` blocks
 * registers without `UNKEPT_SUPPORTS`, a group's child sizing and its
 * styles, through a `blocks.registerBlockType` filter (`unkept()`) that the
 * block registry applies again to what already registered, and every format
 * whose element is not `inline` is unregistered. Both wait for the page's
 * scripts, which register core's blocks and their formats in whatever order
 * the page prints them.
 *
 * @param {Object}   wp     The `wp` namespace WordPress hands the page, passed
 *                          in because the build externalizes no hooks,
 *                          rich-text or dom-ready package: an import would
 *                          bundle a registry WordPress never reads.
 * @param {string[]} core   The core block names the context admits.
 * @param {string[]} inline The elements a text block keeps.
 */
export function confineCanvas( wp, core, inline ) {
	if ( wp.hooks.hasFilter( 'blocks.registerBlockType', FILTER_NAMESPACE ) ) {
		return;
	}
	wp.hooks.addFilter(
		'blocks.registerBlockType',
		FILTER_NAMESPACE,
		( settings, name ) =>
			core.includes( name )
				? {
						...settings,
						supports: unkept( settings.supports ),
						styles: [],
				  }
				: settings
	);
	wp.domReady( () => {
		wp.data.dispatch( 'core/blocks' ).reapplyBlockTypeFilters();
		sweepFormats( wp, inline );
	} );
}

/**
 * Unregister every format `wp` holds whose element is not `inline`, which
 * the canvas's mount runs again for a format a script registered late.
 *
 * @param {Object}   wp     The `wp` namespace, as `confineCanvas()` takes it.
 * @param {string[]} inline The elements a text block keeps.
 */
export function sweepFormats( wp, inline ) {
	for ( const { name, tagName } of wp.data
		.select( 'core/rich-text' )
		.getFormatTypes() ) {
		if ( ! inline.includes( tagName ) ) {
			wp.richText.unregisterFormatType( name );
		}
	}
}
