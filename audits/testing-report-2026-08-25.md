# Testing Review — CSPC-ICTU Monitoring System

**Date:** 2026-08-25
**Scope:** `backend/tests/` (18 files), `frontend/` (none), `agent/` (Go, not assessed)
**Companions:** the eight other 2026-08-25 audits in this folder

---

## 0. Verdict

**The tests that exist are genuinely good. There are just very few of them.**

`npm test` reports this:

```
# all files | 98.84 | 94.94 | 97.87 |
```

**That number is misleading, and it is the most important finding in this audit.** Node's
coverage reporter only lists files that were *loaded*. 98.84% is the coverage of the 13
modules the tests import — not of the codebase.

| Metric | Value |
|---|---|
| Backend source modules | **81** |
| Modules any test loads | **16** (14 meaningfully exercised) |
| **True module coverage** | **≈ 17%** |
| Frontend modules | 88 |
| **Frontend test coverage** | **0%** — no test framework installed |
| Integration tests | **0** |
| E2E tests | **0** |
| Test suite runtime | **1.1 s for 266 tests** |

| ID | Finding | Imp | Status |
|----|---------|-----|--------|
| **T-01** | Reported 98.84% coverage is coverage *of the covered files* — real figure ≈17% | **8** | ⏳ Documented |
| **T-02** | **No frontend test infrastructure at all** — 88 modules, zero coverage | **7** | ⏳ Open |
| **T-03** | Security-critical pure logic had no tests: the **sign-in gate** and the **authorization rule** | **7** | ✅ **Fixed** |
| **T-04** | No integration tests — every DB-touching service and all 3 ingest paths are uncovered | **6** | ⏳ Open |
| **T-05** | 3 of 18 test files parse **source text**, not behaviour — brittle by construction | **4** | ✅ Justified |
| **T-06** | Stateful tests self-isolate by hand; a throwing test leaks state to the next | **3** | ⏳ Open |
| **T-07** | Test pyramid is a single layer — all unit, no middle, no top | **5** | ⏳ Open |

**266/266 tests pass** (248 → 266 this session), in 1.1 seconds.

---

## 1. Coverage

### T-01 — The headline number measures the wrong denominator (importance 8)

Run `node --test --experimental-test-coverage` and the report ends with **98.84%**. That
figure covers 13 files. The other **68 backend modules were never loaded**, so they do not
appear in the report at all — and absence reads as if it were not there to measure.

**Coverage by layer:**

| Layer | Modules | Covered |
|---|---|---|
| Pure logic (`analyticsMath`, `snmpUtils`, `pingOutput`, …) | 14 | **~100%** |
| `services/` (DB-touching) | 48 | **0** |
| `routes/` | 17 | **0** |
| `handlers/` | 7 | **0** |
| `middleware/` | 2 | 1 partial (37%) |
| `sockets/`, `src/` | 2 | **0** |

**This is not an accident, and the codebase says so.** `CLAUDE.md` describes the pure
modules as *"deliberately import-free so `backend/tests/` runs with no MySQL/InfluxDB/.env."*
That design decision is why 266 tests run in 1.1 seconds — and also why everything with a
dependency is untested. **The architecture that makes the tests fast is the same one that
caps them at 17%.**

**Fix — stop the number lying, first:**

```jsonc
// backend/package.json
"scripts": {
  "test": "node --test \"tests/*.test.js\"",
  "test:coverage": "node --test --experimental-test-coverage \"tests/*.test.js\"",
}
```

and record in the script's output — or in `CLAUDE.md` — that the percentage is *of loaded
files*. A reader who sees 98.84% and stops looking is worse off than one who sees 17%.

⚠️ **Do not chase the percentage.** Coverage of the pure tier is already ~100%; the number
only moves by testing the I/O tier, which needs the work in T-04 — not by adding assertions
to modules that are already covered.

---

## 2. Test quality — the strong part

### Naming ✅ describes behaviour, not implementation

```js
test("confirmRecovery holds until N consecutive normals, then confirms", …)
test("a LOOK-ALIKE domain is rejected — the endsWith() trap", …)
test("the token_version comparison is STRICT — no type coercion", …)
```

Each names an observable behaviour and, where relevant, the hazard it guards. A failure
message tells you what broke without opening the file.

### Zero mocks ✅ and that is correct

There is not one `mock`, `stub`, `spy` or `sinon` in `backend/tests/`. That is not an
omission — **everything currently tested is pure**, so there is nothing to fake. It is also
the clearest statement of the coverage problem: the untested layer is exactly the layer
that *would* need test doubles.

### Arrange-Act-Assert ✅ present, unlabelled

```js
test("cross-field validation sees the MERGED row on a patch", () => {
  assert.doesNotThrow(() =>
    cleanRule({ interfaceName: "ether1" }, { partial: true, existing: { device_id: 4 } }));
  …
});
```

Small enough that the three phases are obvious without comments. No action.

### Speed ✅ 266 tests in 1.1 s

Fast enough to run on every save. This is a real asset and worth protecting: any move
toward integration tests should keep `npm test` as the fast tier and put slower tests behind
a separate script.

### T-06 — Stateful tests isolate by hand (importance 3)

`alertBandState` is module-level mutable state, and its tests manage isolation manually:

```js
test("confirmRecovery holds until N consecutive normals, then confirms", () => {
  alertBandState.resetBand(1, "cpu");     // arrange
  …
  alertBandState.resetBand(1, "cpu");     // manual cleanup at the END
});
```

It works, but **a test that throws mid-way never reaches its cleanup**, leaving state for
the next test — which then fails for an unrelated reason. There are no `beforeEach`/
`afterEach` hooks anywhere in the suite.

**Fix:**

```js
import { beforeEach } from "node:test";

beforeEach(() => alertBandState.resetDevice(1));   // runs even after a failure
```

`beforeEach` (rather than `afterEach`) is the safer half: it guarantees a clean start
regardless of how the previous test ended.

---

## 3. Test patterns

### T-07 — The pyramid is one layer (importance 5)

```
        E2E          0
   Integration       0
      Unit         266   <- all of it
```

There is no inverted-pyramid problem — there is no pyramid. The consequence is specific:
**nothing tests that the pieces fit together.** Every audit in this series verified
integration by hand — booting the server, curling endpoints, minting a JWT, sending
SIGTERM. Those checks were real, and none of them is repeatable.

### T-05 — Three tests assert on source text, not behaviour (importance 4) ✅ Justified

| File | What it parses |
|---|---|
| `contract.test.js` | `agent/internal/collector/metrics.go` — json tags vs `NUMERIC_FIELDS` |
| `authContract.test.js` | `middleware/auth.js` + `frontend/src/api/client.ts` — the 401 contract |
| `routeErrorHandling.test.js` | all `routes/*.js` — every async handler has an error path |

This is the classic "testing implementation, not behaviour" anti-pattern, and normally I
would flag it as a defect. Here it is **the right trade**, for one reason: each guards a
contract that spans a boundary no runtime test can cross — Go↔Node, backend↔frontend
package, and "did someone add a route without error handling".

The cost is real and should be acknowledged: **they break on refactoring even when
behaviour is unchanged.** Two mitigations are already in place and should stay —

- every failure message explains the *rule*, not just the mismatch, so a false positive is
  diagnosable;
- `routeErrorHandling.test.js` includes an anti-vacuous check
  (`expected many async handlers, found N`) so a broken regex cannot make it pass silently.

**No action** — but do not add a fourth without the same two properties.

### No brittle time/order dependencies ✅

No `setTimeout`, no sleeps, no date-freezing, no reliance on execution order (beyond T-06).
`backfillTime.test.js` passes `now` explicitly rather than reading the clock — which is why
it is deterministic.

---

## 4. Missing tests

### T-03 — Two security-critical pure modules had none ✅ Fixed (importance 7)

Both were pure, dependency-free, and testable with zero infrastructure. Neither had a test.

**1. `services/googleDomain.js` — the sign-in gate.** Its own header calls it *"the single
check standing between an arbitrary Google account and a session on this system"*, and
warns that rewriting it with `endsWith` *"looks equivalent and is not — it would admit
`attacker@notcspc.edu.ph`, and nothing would appear to break."*

✅ **10 tests added** (`tests/googleDomain.test.js`), written from the hazards the source
itself names:

```js
test("a LOOK-ALIKE domain is rejected — the endsWith() trap", () => {
  const allowed = parseAllowedDomains(DEFAULT_ALLOWED_DOMAINS);
  for (const email of ["attacker@notcspc.edu.ph", "attacker@xcspc.edu.ph",
                       "attacker@evil-cspc.edu.ph"]) {
    assert.equal(isAllowedDomain(email, allowed), false, `${email} must be rejected`);
  }
});
```

Also covered: subdomain attacks (`attacker@cspc.edu.ph.attacker.com`), malformed input
failing **closed**, multiple-`@` addresses, and the regression where a blank
`GOOGLE_ALLOWED_DOMAINS=` produced an empty list that **silently locked out every account**.
`googleDomain.js` is now at **100% line, branch and function coverage.**

**2. `middleware/auth.js` — the authorization rule.** `sessionIsLive` /
`sessionRevocationReason` decide whether a disabled account keeps streaming live data, and
are enforced in three places (HTTP middleware, socket handshake, revocation sweep). Created
during the error-handling audit; never tested.

✅ **8 tests added** (`tests/sessionLiveness.test.js`), including the one that matters most:

```js
test("the token_version comparison is STRICT — no type coercion", () => {
  // Loose equality would let "5" == 5 pass — the silent widening that makes a
  // revocation check stop revoking.
  assert.equal(sessionIsLive(live, "5"), false);
});
```

Plus: every non-`active` status fails closed (so a *new* status is rejected by default), the
three rejection reasons keep their priority order (`socketSessions` reports them to the
client), and the two predicates agree across a 20-case matrix.

### T-02 — The frontend has no test infrastructure at all (importance 7)

```
frontend/package.json  ->  no "test" script
devDependencies        ->  no vitest, jest, testing-library, playwright or cypress
frontend/src           ->  88 modules, 0 test files
```

Uncovered and high-value: `api/client.ts`'s session interceptor (the token-rotation race
its comment describes at length), `utils/envThresholds.ts` (pure, and the source warns that
an earlier version *"flipped both comparisons… every band came out scrambled"*),
`utils/format.ts`, `utils/tempZone.ts`, `theme/gf.ts`.

**Fix — start with the pure utils, which need no DOM:**

```bash
npm i -D vitest
```

```jsonc
// frontend/package.json
"scripts": { "test": "vitest run", "test:watch": "vitest" }
```

```ts
// frontend/src/utils/envThresholds.test.ts
import { describe, it, expect } from "vitest";
import { bandFor } from "./envThresholds";

describe("bandFor", () => {
  it("is always higher-is-worse, even when crit is set below warn", () => {
    // The regression the source documents: an earlier version inferred direction from
    // the bounds, so TESTING a rule (dropping crit below the live reading) scrambled
    // every band.
    expect(bandFor(35, 30, 34)).toBe("critical");
    expect(bandFor(31, 30, 34)).toBe("warning");
    expect(bandFor(29, 30, 34)).toBe("normal");
    expect(bandFor(35, 30, 25)).toBe("critical"); // crit < warn, still higher-is-worse
  });
});
```

⚠️ **Not installed.** Adding a dev dependency and a test runner to the frontend is a
tooling decision with build implications, and the project is close to deployment. The
snippet above is what to run when you want it.

### T-04 — No integration coverage of the three ingest paths (importance 6)

The system's whole purpose is ingesting from three sources; **none has an automated test.**

| Path | Entry point | Coverage |
|---|---|---|
| ESP32 → Socket.IO | `sockets/connectionHandler.js` → `sensorHandler` | 0 |
| Go agent → HTTP | `routes/servers.js` → `serverMetricsHandler` | 0 |
| SNMP/MikroTik → poll | `snmpPollerService.pollAll` | 0 |

`CLAUDE.md` documents the workaround: `npm run link:check`, `npm run probe`,
`npm run analytics:check` exist *because* these paths fail invisibly. **Those are manual
diagnostics standing in for tests.**

**Fix — the cheapest real integration test needs no database.** `serverMetricsHandler`'s
validation and shaping can be exercised with a fake `writeClient`:

```js
// tests/serverMetricsHandler.integration.test.js  (run under a separate script)
// Proves: a malformed sample is rejected, a valid one produces the expected Points.
```

⚠️ **Unable to verify** whether that is possible without refactoring: the handler imports
`writeClient` directly from `config/influx.js` with no injection seam (see the SOLID audit,
D-01). **What would prove it:** whether `writeSamplePoints` can be exported and called with
an injected client — if yes, this test is ~30 lines; if no, it needs D-01 first.

### Other gaps, ranked

| Gap | Why it matters | Testable today? |
|---|---|---|
| `alertRulesService.nextBand` (hysteresis) | Decides whether an alert fires | ⚠️ Needs the DB-coupled service split |
| `deviceAlerts.checkRouter/checkUps` | Raises the router/UPS alerts | ⚠️ Same |
| `agentService.checkThresholds` | Worst-volume disk alerting | ⚠️ Same |
| `userService` role/status rules | Who can do what | ⚠️ Needs D-01 |
| **Performance tests** | None. No load profile exists for the pool sizing (S-03) or the Influx flush (A-05) | ❌ Needs a load harness |
| **Security tests** | Now partly covered by T-03. Still untested: rate-limit key derivation, `requireRole` | ⚠️ Mixed |

---

## 5. Test improvement plan

**Ordered by value per unit of effort. Steps 1–2 are done.**

1. ✅ **The sign-in gate** — `googleDomain`, 10 tests, 100% coverage.
2. ✅ **The authorization rule** — `sessionIsLive`, 8 tests.
3. **Make the coverage number honest** — add `test:coverage` and note that the percentage
   is *of loaded files*. Nothing is worse than a false 98.84%.
4. **`beforeEach` for the stateful suite** (T-06) — three lines, removes a real flake.
5. **Frontend: vitest + the pure utils** (T-02) — `envThresholds`, `format`, `tempZone`.
   No DOM, no components, no config beyond installing the runner.
6. **One integration test** for whichever ingest path next has a bug — and invert that one
   module to get it (SOLID D-01). Not speculatively.
7. **E2E** — only after step 5 exists. A single Playwright path (sign in → dashboard loads →
   an alert appears) would cover more real risk than fifty more unit tests, but it needs a
   seeded database and is a deployment-time investment.

**What to protect while doing all of this:** `npm test` finishing in ~1 second. Put anything
slower behind `npm run test:integration` so the fast tier stays fast enough to run on save.

---

## 6. Unable to verify

- **Whether `serverMetricsHandler` is testable without refactoring** (T-04). **What would
  prove it:** whether `writeSamplePoints` can accept an injected write client.
- **Real branch coverage of the pure tier.** The reporter shows 94.94% branch across loaded
  files, but `analyticsMath.js` has uncovered lines (51-52, 173, 550) I did not inspect.
  **What would prove it:** read those lines and decide whether they are reachable.
- **The Go agent's tests.** Not assessed — this audit is JS-only. **What would prove it:**
  `go test ./... -cover` in `agent/`.
- **Whether any test is flaky under repetition.** Each suite was run once or twice. **What
  would prove it:** `for i in {1..20}; do npm test || break; done`.

---

## 7. Applied this session

| ID | Change | Verification |
|----|--------|--------------|
| T-03a | `tests/googleDomain.test.js` — 10 tests on the sign-in gate: look-alike domains, subdomains, fail-closed input, the blank-env lockout regression | 10/10 pass; `googleDomain.js` at 100% line/branch/function |
| T-03b | `tests/sessionLiveness.test.js` — 8 tests on the authorization rule: strict `token_version` comparison, non-active statuses fail closed, reason priority, 20-case agreement matrix | 8/8 pass |

**Suite: 248 → 266 tests, 1.1 s, all passing. Modules loaded by tests: 13 → 16.**

---

*Reviewed 2026-08-25. Method: `node --test --experimental-test-coverage` for real line/branch/
function figures; module census to establish the true denominator the reporter omits;
per-file test and assertion counts; grep census for test doubles and setup hooks; and
manual reading of each test file for naming, AAA structure and independence.*
