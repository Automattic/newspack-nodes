/**
 * The `@newspack-nodes/runtime` surface — the browser node graph as a plugin
 * outside this repo imports it.
 *
 * `src/build-kit/alias-map.cjs` points that one specifier at this file for
 * esbuild and jest alike, so the re-exports below ARE the cross-repo contract.
 * The substrate's own bundles reach individual runtime modules by relative
 * path, which is what keeps `poller-node`, `probe-record`, `shell-node` and
 * the rest off the list: adding a name here promises to keep it working for
 * every consumer pinned to a substrate tag.
 *
 * knip counts this file as an entry, so an export nothing imports raises no
 * finding. Removing a name needs a manual sweep of the sibling plugins.
 *
 * Node classes ship as classes. A consumer subclasses `Node`, hands its own
 * classes back through `CommandInterpreterNode.registerNodeClasses`, and may
 * pass a class straight to `makeNode` rather than a shell name (ADR-16).
 */
export * from './message';
export { Core } from './core';
export { Node, truthy } from './node';
export { RouterNode } from './router-node';
export { TeeNode } from './tee-node';
export { HookNode } from './hook-node';
export { CallbackNode } from './callback-node';
export { EchoNode } from './echo-node';
export { TimerNode, GRID_PHASE_MS } from './timer-node';
export { HeartbeatNode } from './heartbeat-node';
export { CommandInterpreterNode } from './command-interpreter-node';
export { StubNode } from './stub-node';
export { DraftInterpreterNode } from './draft-interpreter-node';
export { mountExospine } from './exospine';
export { nodesData } from './nodes-data';
/**
 * The reserved node names, for shared code that cannot reach the JSON itself.
 */
export { default as reservedNames } from './reserved-node-names.json';
export { SseInNode } from './sse-in-node';
export { RemoteLinkNode } from './remote-link-node';
export { RemoteIpcNode } from './remote-ipc-node';
export { HttpOutNode } from './http-out-node';
export { CompletionNode } from './completion-node';
export { DumperNode } from './dumper-node';
export { UptimeNode } from './uptime-node';
export { commandTransport, defaultTransport } from './command-transport';
export { formatCommandArgs, parseCommandArgs } from './command-args';
export {
	useNodeState,
	useNodeEvent,
	useNodeFill,
	useGraphGeneration,
} from './react';
export {
	ensureSession,
	hasSession,
	readyToMint,
	renewSession,
	forgetSession,
	invalidateAuth,
	markLocal,
	signCommand,
	__setAuthFetch,
} from './command-auth';
