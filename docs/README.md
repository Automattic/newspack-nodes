# Newspack Nodes — Documentation Map

Nine docs, three reading orders. New here? Read **Start here** top to bottom. Shipping something? Jump to **Take it to production**. Need a fact? Go straight to **Reference**.

## Start here

Read these in order — each builds on the last.

- **[getting-started.md](getting-started.md)** — read when you've never touched a node graph: zero to a running example pipeline you can poke at by hand, in about five minutes.
- **[writing-a-plugin.md](writing-a-plugin.md)** — read when you want to build your own: the AI-newsletter digest from an empty directory, one node at a time, run after every step.
- **[writing-a-dashboard.md](writing-a-dashboard.md)** — read when the headless pipeline works and you want a React admin dashboard that reads its live state.

## Take it to production

The toy guides above stop at "works on my page." These pick up where they leave off.

- **[writing-a-real-plugin.md](writing-a-real-plugin.md)** — read when you're taking the toy pipeline to real sources: durable ingest partition, credentials in the Vault, terminal-`DONE` auto-compose.
- **[writing-a-real-dashboard.md](writing-a-real-dashboard.md)** — read when your dashboard has to survive the Topology Console, the DevTools overlay, and `release:archive` — the shared-surface contracts you didn't sign up for.
- **[writing-a-view-node.md](writing-a-view-node.md)** — read when you need the one-page contract for a dashboard slice's terminal view node: one reply in, one render model out.

## Reference

Facts, not tutorials.

- **[architecture-guide.md](architecture-guide.md)** — read when you need the full substrate design: message format, node contracts, drain loop, REPL.
- **[architecture-decisions.md](architecture-decisions.md)** — read when you want to change a load-bearing behavior: the ADRs, why each was chosen, and the condition that would reopen it.
- **[API.md](API.md)** — read when you're calling the runtime over HTTP: the three REST endpoints and their request/response shapes.
