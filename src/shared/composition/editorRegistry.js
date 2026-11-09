/**
 * editorRegistry — where a consumer's editor bundle registers the layout
 * editor for each of its contexts, and where the page's slot finds it.
 *
 * The editor half imports `@wordpress/block-editor`, so a consumer builds it
 * as a second entry that `Composition::editor()` enqueues for a `tune` caller
 * alone. Each bundle inlines its own copy of this module, so the registry
 * hangs off one window key, as `tabRegistry` does for station tabs.
 */

/**
 * Window key holding the one registry every copy of this module shares.
 */
const GLOBAL_KEY = '__newspackNodesCompositionEditors';

/**
 * The registry: context => editor component, and its subscribers.
 *
 * @typedef {Object} EditorStore
 * @property {Map<string,import('react').ComponentType<any>>} editors   Context => editor.
 * @property {Set<() => void>}                                listeners Called after every registration.
 */

/**
 * Read the shared registry, creating it on first touch.
 *
 * @return {EditorStore} The page-wide store.
 */
function store() {
	if ( ! window[ GLOBAL_KEY ] ) {
		window[ GLOBAL_KEY ] = { editors: new Map(), listeners: new Set() };
	}
	return window[ GLOBAL_KEY ];
}

/**
 * Register the editor a context's slot renders, replacing any before it.
 *
 * @param {string}                             context   A declared context, `<namespace>/<name>`.
 * @param {import('react').ComponentType<any>} Component The editor, rendered with the slot's props.
 */
export function registerCompositionEditor( context, Component ) {
	const s = store();
	s.editors.set( context, Component );
	s.listeners.forEach( ( listener ) => listener() );
}

/**
 * The editor a context registered.
 *
 * @param {string} context A declared context.
 * @return {import('react').ComponentType<any>|undefined} Its editor, or undefined before one registers.
 */
export function compositionEditor( context ) {
	return store().editors.get( context );
}

/**
 * Subscribe to registrations, the `useSyncExternalStore` subscribe half.
 *
 * @param {() => void} listener Called after every registration.
 * @return {() => void} Unsubscribes.
 */
export function subscribeCompositionEditors( listener ) {
	const s = store();
	s.listeners.add( listener );
	return () => s.listeners.delete( listener );
}
