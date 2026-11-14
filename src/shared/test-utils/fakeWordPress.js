/**
 * A stand-in for the `wp` namespace the composition canvas confines: the
 * hooks registry, the two stores it reads and writes, rich-text's format
 * registry, which a test may register a format in late, and dom-ready, each
 * recording what it was asked.
 * `applyRegisterFilter( settings, name )` runs a registration through every
 * `blocks.registerBlockType` filter added, and `loadPage()` runs what was
 * queued for dom-ready.
 *
 * @param {Array<{name: string, tagName: string}>} [formats] The format types registered.
 * @return {Object} The namespace.
 */
export function fakeWordPress( formats = [] ) {
	const ready = [];
	const wp = {
		filters: [],
		reapplied: 0,
		unregistered: [],
		hooks: {
			addFilter: ( hook, namespace, callback ) =>
				wp.filters.push( { hook, namespace, callback } ),
			hasFilter: ( hook, namespace ) =>
				wp.filters.some(
					( one ) => hook === one.hook && namespace === one.namespace
				),
		},
		data: {
			dispatch: ( store ) => {
				if ( 'core/blocks' !== store ) {
					throw new Error( `fakeWordPress dispatches no ${ store }` );
				}
				return {
					reapplyBlockTypeFilters: () => {
						wp.reapplied++;
					},
				};
			},
			select: ( store ) => {
				if ( 'core/rich-text' !== store ) {
					throw new Error( `fakeWordPress selects no ${ store }` );
				}
				return {
					getFormatTypes: () =>
						formats.filter(
							( { name } ) => ! wp.unregistered.includes( name )
						),
				};
			},
		},
		richText: {
			registerFormatType: ( name, { tagName } ) =>
				formats.push( { name, tagName } ),
			unregisterFormatType: ( name ) => wp.unregistered.push( name ),
		},
		domReady: ( callback ) => ready.push( callback ),
		applyRegisterFilter: ( settings, name ) =>
			wp.filters
				.filter( ( { hook } ) => 'blocks.registerBlockType' === hook )
				.reduce(
					( next, { callback } ) => callback( next, name ),
					settings
				),
		loadPage: () => ready.splice( 0 ).forEach( ( callback ) => callback() ),
	};
	return wp;
}
