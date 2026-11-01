# Conformance suite

Hub-side conformance tests live in `server/test/conformance/*.test.ts`. They run against a real spawned hub (`server/test/helpers/hub.ts`), so build first.

```bash
npm run build
npx vitest run server/test/conformance   # the suite
npm run check:conformance                # the spec ↔ test gate
```

## ID scheme

`TEST-<AREA>-<NN>`, e.g. `TEST-LOBBY-03`. Areas:

| Area | Covers |
|---|---|
| SESS | hello, registerGame, session state |
| LOBBY / JOIN / COMM | lobby lifecycle, join requests, relay |
| RECON | reconnect grace, takeover |
| DATA | user data, visibility, leaderboard |
| AUTH / LIMIT / INFRA | token lifecycle, rate limits, health |
| FRIEND / PRES / NOTIF / DM / INVITE / SYNC | social features |
| GS | game-server sessions, assignment, rebind |
| PROC / SEC | subprocess games, malicious subprocess behaviour |
| LOAD / GENRE | load smoke test, genre scenarios |

The expected behaviour of each ID is the table in [`server-feature-spec.md` §12](server-feature-spec.md).

## Adding a test

1. Add a row `| TEST-AREA-NN | expected behaviour |` to the §12 table (new area: pick a short upper-case name).
2. Add an `it('TEST-AREA-NN: …', …)` to a file in `server/test/conformance/`. The title must start with the ID. Use the helpers in `server/test/conformance/util.ts` (`live`, `befriend`, `gameServer`, …).
3. Run `npm run check:conformance`.

## The gate

`scripts/check-conformance.mjs` reads the IDs from the §12 table and from `it('TEST-…` titles under `server/test/conformance`. It fails if a spec ID has no test, a test uses an ID that is not in the spec, or an ID is used by more than one test. CI runs it in the `test` job after the build and before vitest.
