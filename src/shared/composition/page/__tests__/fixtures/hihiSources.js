/**
 * A page's source declarations, in a module of their own that both its
 * reader and its editor entries import.
 */

import { registerSource } from '../../../../sources';

registerSource( 'hihi-7841', {
	kind: 'command',
	group: 'hihi-desk',
	ci: 'canopy-7841',
	command: 'flock',
	args: ( { tree } ) => [ tree ],
} );
