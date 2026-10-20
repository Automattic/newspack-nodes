/**
 * nextTask — wait one task, so whatever `_http` held for the next task has
 * been posted by the time the wait resolves.
 *
 * It waits on a channel task, as HttpOut's own flush is posted, rather than a
 * 0ms timeout: fake timers hold a timeout until the clock is advanced, but not
 * a channel task, so one helper serves a suite on either clock.
 */

/**
 * Resolve on a task posted after every one already queued.
 *
 * @return {Promise<void>} Settles on that task.
 */
export function nextTask() {
	return new Promise( ( resolve ) => {
		const channel = new MessageChannel();
		channel.port1.onmessage = () => resolve();
		channel.port2.postMessage( null );
	} );
}
