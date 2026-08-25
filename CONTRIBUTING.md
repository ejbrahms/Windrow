# Contributing

## Getting set up

```bash
npm run install:all
npm run setup            # choose "standalone node" for development
npm start                # API on :4000

# Enroll a `dev` mTLS client credential so the dashboard proxy has a certificate to
# present — without it the first API call 401s. Grab an enrollment token from the running
# node, then:
node -e "require('./server/enrollment/client').enroll({name:'dev', \
  baseUrl:'https://localhost:4443', enrollmentToken:'<token>'})"

npm run dev:client       # dashboard on :5173
```

The API authenticates with per-node mTLS client certificates, not a bearer token; the dev proxy
presents the `dev` credential on the browser's behalf (see `client/vite.config.ts` and
[docs/design/per-node-enrollment-credentials.md](docs/design/per-node-enrollment-credentials.md)).

[docs/quickstart.md](docs/quickstart.md) walks the same ground with more explanation.

## Running the tests

`npm test` at the repo root runs the server's whole no-database suite — every script in
`server/package.json`'s `test`, in order, stopping at the first red. Each suite is also a script of
its own, which is what you want while you are iterating. The ones that matter most when touching
the enforcement path:

```bash
npm test                                        # all of it; what CI gates on
npm run smoke:policy --prefix server            # the policy core
npm run test:decision --prefix server           # the hook decision path, end to end
npm run test:enforce --prefix server            # the @windrow/enforce in-process SDK
npm run test:velocity --prefix server           # the per-principal token bucket
npm run test:supervisor --prefix server         # port parking across a restart
npm run test:enforcement-pause --prefix server  # the bounded debugging window
npm run test:authority --prefix server          # node vs central policy authority
npm run smoke:schema --prefix server            # migrations
```

> [!note]
> `npm test` includes `test:supervisor`, which asserts wall-clock port-parking behaviour and is
> therefore host-timing coupled. CI runs every other suite for that reason —
> [.github/workflows/ci.yml](.github/workflows/ci.yml) says why in full.

Central's own suites need a Postgres:

```bash
npm run central:db                              # docker compose, port 5432
npm run smoke:central --prefix server
npm run smoke:central-policy --prefix server
```

The dashboard has its own two gates, and CI runs both:

```bash
npm run lint --prefix client                    # ESLint 9, flat config, zero warnings tolerated
cd client && npx tsc -b                         # the type gate; `npm run build` runs it first
```

`client/eslint.config.js` says what each rule is for and why type-aware linting is deliberately off.

And a whole-system check that does not need a test harness:

```bash
npm run verify:topology
```

It checks both listeners, the credential, policy authority, the central handshake, the database and
the partition health, and prints a line per check. A green run is the closest thing to an
integration gate.

## Things worth knowing before you change them

> [!warning]
> **`server/hooks/lib.js` is the enforcement point.** All three backend adapters share it, and a
> mistake there is a fleet-wide denial or a fleet-wide allow. It fails open only where the fault
> ladder says it may — see [docs/architecture.md](docs/architecture.md#decisions-not-denials).

- **Hooks are fresh processes, ~20 ms each.** Nothing on that path may add a network round trip or
  a module load. `docs/design/latency-breakdown.md` has the measurements.
- **`:4000` is loopback-bound on purpose.** That bind is the security control, not a default.
- **Restart with `npm run restart`,** not by stopping the service — the supervisor holds the port so
  a reload is latency rather than a denial.
- **Migrations are owned by `server/schema/migrator.js`.** Do not add DDL anywhere else.

## Documentation

Documentation follows [Diátaxis](https://diataxis.fr/): `quickstart.md` teaches, `setup.md` and the
troubleshooting sections help you do a task, `reference/` states facts, and `design/` explains why.

`docs/design/` is a decision record. Add a note there when a change turns on a decision someone
would otherwise have to reverse-engineer — and mark the note it supersedes rather than deleting it.
Working documents with their own lifecycle — TODOs, dated reviews, investigation write-ups — belong
in the issue tracker or the wiki, not in the tree.

## Commits

Explain *why* in the message; the diff already covers what. Branch off `main`.
