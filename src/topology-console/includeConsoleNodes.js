/**
 * The JS analog of Tachikoma's include_nodes: the runtime can't import the
 * console's node classes, so the CONSOLE registers them on the static
 * `make_node` lookup table. Import this module for its side-effect.
 */

import { CommandInterpreter } from '../runtime/command_interpreter';
import { Dumper } from '../runtime/dumper';
import { Metadata } from '../runtime/metadata';
import { Uptime } from '../runtime/uptime';
import { Completion } from '../runtime/completion';
import { Heartbeat } from '../runtime/heartbeat';
import { HttpOut } from '../runtime/httpOut';
import { SseIn } from '../runtime/sseIn';

Object.assign( CommandInterpreter.includeNodes, {
	Dumper,
	Metadata,
	Uptime,
	Completion,
	Heartbeat,
	HttpOut,
	SseIn,
} );
