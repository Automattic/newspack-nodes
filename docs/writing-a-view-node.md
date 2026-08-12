# Writing a View Node

A **view node** is the terminal node of a dashboard slice: it receives *one*
command reply, parses it into a render model, and publishes that model for a
React widget. Nothing downstream. This is the one-page contract — the full
walkthrough is [writing-a-dashboard.md](writing-a-dashboard.md), and the base
class is [`@newspack-nodes/shared/nodes/slice-view-node`](../src/shared/nodes/slice-view-node.js).

Extend `SliceViewNode`, override `emptySlice()` (and `_parse()` when the reply
payload isn't already your model), and you have a correct view node:

```js
import { SliceViewNode } from '@newspack-nodes/shared/nodes/slice-view-node';

export class SourceCountsViewNode extends SliceViewNode {
	emptySlice() {
		// Shaped-but-empty so a render BEFORE the first reply is valid.
		return { counts: {}, loading: true, error: null };
	}
	_parse( payload ) {
		// payload = the slice verb's reply, a JSON string.
		const slice = super._parse( payload ); // JSON.parse; null on garbage
		return slice && { counts: slice, loading: false, error: null };
	}
}
```

Register the class — `CommandInterpreterNode.registerNodeClasses( {
SourceCountsView: SourceCountsViewNode } )` (import `CommandInterpreterNode`
from `@newspack-nodes/runtime`) — and React reads it with
`useNodeState( 'source-counts:view', 'view' )`.

## 3 routing facts

1. **A view node is a terminal — no `target`, no `sink`** (`has_target: false`).
   It receives, parses, publishes, stops. If you catch yourself forwarding out
   of a view, it isn't a view — it's a `Tee` or a transform.

2. **You never fetch your own data — the `TO = FROM` reply delivers it.**
   Upstream, a `Timer → Tee → Fetcher` poll sends your slice verb to the service
   CI, stamping **`FROM = your receiver`**. The server replies **`TO = FROM`**, so
   the reply routes back to your receiver `Tee`, which fans it to your view. Your
   `fill()` handles the arriving reply; it never sends the request.

3. **One slice per view — replies never cross.** Each slice verb has its own
   Fetcher → receiver → view path, so the `counts` reply lands ONLY on
   `source-counts:view`, never on a sibling. There is no god node holding
   `{ counts, top, accumulated }` — decompose the command *and* the view. A view
   sitting at counter `0 / 0 B` in the topology console is a god node with a
   React app stapled on.

## `setState( 'view', model )`

Publish the model under the **`view`** key — the key
`useNodeState( '<name>:view', 'view' )` reads:

```js
this.setState( 'view', this.model );
```

- **Seed it in the constructor** from `emptySlice()` so a render before the first
  reply is valid (the base does this). A shaped `{ loading: true }` beats
  `undefined`.
- **`setState`, not `notify`.** `setState` caches the latest payload, so a widget
  that mounts *after* the reply still gets the current model (a late `register()`
  replays the cache).

## No throw from `fill()`

`fill()` runs synchronously in the drain, and the Router dispatches it with
`target.fill( message )` — **no per-message try/catch.** A throw there propagates
up and aborts the whole message turn (the poll/dispatch that delivered the
reply). So `fill()` must be *total*: every message shape returns cleanly.

The base `SliceViewNode.fill()` already gives you this — preserve it if you
override:

- **`TM_ERROR` first.** A transport error (e.g. the Router's `NOT_AVAILABLE`)
  arrives as a bare *string* `VALUE`. Surface it as
  `{ ...this.model, error, loading: false }` and `return` — keep the slice
  already on screen, and stop the spinner, so one transient failure neither
  blanks a working widget nor leaves it loading forever.
- **Garbage keeps the prior slice.** A non-object `VALUE`, or a payload that fails
  `JSON.parse`, must `return` and leave the last good model in place — a transient
  bad reply must never blank a working widget. `_parse` returns `null` for this,
  and the base skips the `setState`.
- **Wrap the parse.** `JSON.parse` throws on malformed input; the base's `_parse`
  try/catches it. If you parse anything yourself, do the same.

Never `throw` to signal a bad reply — `return`, and either surface an error slice
or keep the prior one.
