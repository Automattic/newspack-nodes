/**
 * layoutStorageKey — the localStorage key the canvas position map persists under.
 *
 * View mode keys by the cwd-derived scope (so `/`, `_sse`, and each worker get
 * their own layout). Edit mode keys by the TOPOLOGY being edited, NOT the cwd:
 * an unactivated topology has no running worker to `cd` onto, so the cwd would
 * otherwise collide every edited topology onto one key (and stomp the live
 * local-scope layout). See the regression these guard against in
 * TopologyConsole's open/edit handlers.
 */

import { layoutStorageKey } from '../TopologyConsole';

describe( 'layoutStorageKey', () => {
	it( 'view mode keys by the cwd scope', () => {
		expect(
			layoutStorageKey( {
				mode: 'view',
				editingName: '',
				scopeKey: 'digest.p0',
			} )
		).toBe( 'newspack-nodes:topology:digest.p0' );
	} );

	it( 'view mode at the local graph keys by `local`', () => {
		expect(
			layoutStorageKey( {
				mode: 'view',
				editingName: '',
				scopeKey: 'local',
			} )
		).toBe( 'newspack-nodes:topology:local' );
	} );

	it( 'edit mode keys by the topology being edited, ignoring the cwd scope', () => {
		expect(
			layoutStorageKey( {
				mode: 'edit',
				editingName: 'alpha',
				scopeKey: 'local',
			} )
		).toBe( 'newspack-nodes:topology:edit:alpha' );
	} );

	it( 'edit mode gives two different topologies two different keys at the same cwd', () => {
		const alpha = layoutStorageKey( {
			mode: 'edit',
			editingName: 'alpha',
			scopeKey: 'local',
		} );
		const beta = layoutStorageKey( {
			mode: 'edit',
			editingName: 'beta',
			scopeKey: 'local',
		} );
		expect( alpha ).not.toBe( beta );
	} );

	it( 'edit mode with no topology yet (untitled draft) is not persisted (null key)', () => {
		// No topology identity to key by — an untitled draft stays in-memory only;
		// a null key tells useCanvasLayout to skip load/persist (no shared slot to
		// bleed between distinct drafts).
		expect(
			layoutStorageKey( {
				mode: 'edit',
				editingName: '',
				scopeKey: 'local',
			} )
		).toBeNull();
	} );
} );
