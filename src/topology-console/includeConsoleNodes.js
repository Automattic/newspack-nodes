/**
 * The JS analog of Tachikoma's include_nodes: the runtime can't import the
 * console's node classes, so the CONSOLE registers them on the static
 * `make_node` lookup table. Import this module for its side-effect.
 */

import { CommandInterpreterNode } from '../runtime/command-interpreter-node';
import { DumperNode } from '../runtime/dumper-node';
import { MetadataNode } from '../runtime/metadata-node';
import { UptimeNode } from '../runtime/uptime-node';
import { CompletionNode } from '../runtime/completion-node';
import { HeartbeatNode } from '../runtime/heartbeat-node';
import { HttpOutNode } from '../runtime/http-out-node';
import { SseInNode } from '../runtime/sse-in-node';

Object.assign( CommandInterpreterNode.includeNodes, {
	Dumper: DumperNode,
	Metadata: MetadataNode,
	Uptime: UptimeNode,
	Completion: CompletionNode,
	Heartbeat: HeartbeatNode,
	HttpOut: HttpOutNode,
	SseIn: SseInNode,
} );
