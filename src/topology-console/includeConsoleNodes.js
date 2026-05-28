/**
 * The JS analog of Tachikoma's include_nodes: the runtime can't import the
 * console's node classes, so the CONSOLE registers them on the static
 * `make_node` lookup table. Import this module for its side-effect.
 */

import { CommandInterpreter } from '../runtime/command_interpreter';
import { Dumper } from './nodes/dumper';
import { Metadata } from './nodes/metadata';
import { Uptime } from './nodes/uptime';
import { Completion } from './nodes/completion';
import { Heartbeat } from '../runtime/heartbeat';
import { HttpOut } from '../runtime/httpOut';
import { SseIn } from './nodes/sseIn';

Object.assign( CommandInterpreter.includeNodes, {
	Dumper,
	Metadata,
	Uptime,
	Completion,
	Heartbeat,
	HttpOut,
	SseIn,
} );
