/**
 * A bundle's source module: one declaration, made fresh each time the module
 * is evaluated, as a second bundle inlining it evaluates it again.
 */

import { registerSource } from '../../registry';

/** What this copy declares. */
export const TUI = {
	kind: 'command',
	group: 'alpine-7820',
	ci: 'tern-7820',
	command: 'sing',
	args: () => [],
};

registerSource( 'tui-7820', TUI );
