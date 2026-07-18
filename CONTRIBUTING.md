# Contributing to crablite

Small project, few rules. This file is the entry point for anyone — human or coding agent — about
to change the code.

## Read the directory map first

**Every directory carries an `index.md`.** It states what the directory is for, its entry points,
what to reuse, the anti-patterns that will get a change rejected, its data contracts, and where its
tests live.

Before changing code in a directory, read that directory's `index.md`. Start at
[`src/index.md`](src/index.md) — it covers the top-level modules and the cross-cutting rules that
apply everywhere (paths, locking, config, logging, ESM imports).

| Question | Where |
| --- | --- |
| What is this project, how do I run it? | [`README.md`](README.md) |
| How does a message flow through the code? | [`docs/architecture.md`](docs/architecture.md) |
| How do I deploy and operate it? | [`docs/deployment.md`](docs/deployment.md) |
| What lives here, what do I reuse, what must I not do? | that directory's `index.md` |
| Why is this line like this? | the module header comment in the source file |

If you add a directory, give it an `index.md`. If you change a module's purpose or contracts,
update the one that describes it in the same commit — a map that lies is worse than no map.

> Not to be confused with `workspace-template/AGENTS.md`, which is the operating policy for the
> *running assistant's* workspace, not guidance for contributors to this repository.

## Setup

Node >= 20 (CI and the Docker image run 24), pnpm 10.

```bash
pnpm install
pnpm crablite chat        # run the agent in your terminal
```

There is no build step — the project runs TypeScript directly with `tsx`, in development and in the
image alike.

## Checks

```bash
pnpm lint                 # Biome (lint + format check); pnpm lint:fix to apply
pnpm typecheck            # tsc --noEmit (strict)
pnpm test                 # Vitest
pnpm test:coverage        # coverage report; thresholds enforced
```

CI (`.github/workflows/ci.yml`) runs lint, typecheck and the coverage-gated suite on every PR. Line
coverage is gated at **≥75%** in `vitest.config.ts`. Run the same four commands locally before
opening a PR; they take seconds.

## Conventions that matter

These are the ones that cause real bugs when ignored. The full list is in each `index.md`.

- **`paths.ts` owns every path on disk.** Never build a path to the state dir by hand —
  `CRABLITE_STATE_DIR` must keep working, and the whole test suite depends on it.
- **Containment before touching model-supplied paths.** `resolveInside` / `resolveReadable`.
- **`withLock(chatId, …)` around anything that runs a turn.** Reactive and proactive turns share one
  session file; concurrent writes fork the history.
- **One inbound path.** Every channel funnels through `createInboundHandler` so admission, dedupe,
  debounce and locking apply uniformly. Calling `runTurn` directly bypasses the allowlist.
- **Admission stays fail-closed.** `allowFrom` empty means ignore everyone, on purpose.
- **`log` from `logger.ts`, never `console.*`.**
- **This is ESM:** import `./foo.js` from `foo.ts`, never the `.ts` extension.
- **Write module headers.** They explain *why* and cite the OpenClaw module being distilled; they
  are the primary in-code documentation.

## Tests

Tests live in `test/` — conventions and helpers in [`test/index.md`](test/index.md). Use `tmpState()`
for an isolated temp state dir per test. Mock only the network (model/transport) and hardware
(WhatsApp/TTY); everything else runs for real against the temp workspace.

A bug fix should come with the test that would have caught it.

## Commits and pull requests

[Conventional Commits](https://www.conventionalcommits.org/) — `type(scope): imperative summary`,
lowercase, no trailing period, ≤72 characters. Types in use: `feat`, `fix`, `docs`, `refactor`,
`perf`, `test`, `build`, `ci`, `chore`, `revert`. The changelog and release flow are generated from
this history, so the type and scope matter.

Branch off `main`, keep the PR scoped to one concern, and say in the description what you actually
ran to verify it. Don't hardcode numbers that drift (test counts, coverage percentages, line
numbers in other repositories) into documentation.

## License

MIT. By contributing you agree your contributions are licensed under it.
