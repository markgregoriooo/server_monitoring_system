// Guards the metric contract that is hand-duplicated between the Go agent and
// this backend (server-metrics.md §10 flags the drift hazard explicitly).
//
// It parses the REAL go-agent/internal/collector/metrics.go and asserts its json
// tags still match what the handler validates. Adding a field on one side without
// the other now fails here instead of silently 400-ing every agent in the field.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { NUMERIC_FIELDS } from "../services/serverMetricUtils.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const METRICS_GO = path.resolve(HERE, "../../go-agent/internal/collector/metrics.go");

const source = readFileSync(METRICS_GO, "utf8");

// Pull out `type <Name> struct { ... }` — brace-counting rather than a greedy
// regex, so a later struct in the file can't bleed into the match.
function structBody(name) {
  const start = source.indexOf(`type ${name} struct {`);
  assert.notEqual(start, -1, `struct ${name} not found in metrics.go`);
  let depth = 0;
  for (let i = source.indexOf("{", start); i < source.length; i++) {
    if (source[i] === "{") depth++;
    else if (source[i] === "}" && --depth === 0) {
      return source.slice(source.indexOf("{", start) + 1, i);
    }
  }
  throw new Error(`unterminated struct ${name}`);
}

// Field name → json tag, ignoring commented-out lines.
function jsonTags(body) {
  const tags = [];
  for (const line of body.split("\n")) {
    const clean = line.trim();
    if (!clean || clean.startsWith("//")) continue;
    const m = clean.match(/`json:"([^",]+)([^"]*)"`/);
    if (m) tags.push({ name: m[1], omitempty: m[2].includes("omitempty") });
  }
  return tags;
}

const metricTags = jsonTags(structBody("ServerMetrics"));
const payloadTags = jsonTags(structBody("Payload"));
const volumeTags = jsonTags(structBody("Volume"));

test("every required backend field is sent by the agent", () => {
  const sent = new Set(metricTags.map((t) => t.name));
  for (const field of [...NUMERIC_FIELDS, "process_count"]) {
    assert.ok(sent.has(field), `metrics.go is missing json tag "${field}"`);
  }
});

test("the agent sends no unknown required fields", () => {
  // Anything the agent sends that the backend doesn't validate must be optional
  // (omitempty), otherwise it's a field someone added on one side only.
  const known = new Set([...NUMERIC_FIELDS, "process_count"]);
  for (const tag of metricTags) {
    if (known.has(tag.name)) continue;
    assert.ok(
      tag.omitempty,
      `metrics.go sends "${tag.name}" which the backend does not validate — ` +
        `add it to NUMERIC_FIELDS or mark it omitempty`,
    );
  }
});

test("required metric fields are NOT omitempty", () => {
  // A required field marked omitempty would vanish from the JSON at its zero
  // value — 0% CPU is legitimate, and the handler would reject the post as
  // "missing field". This is a real bug shape, so pin it.
  for (const tag of metricTags) {
    if (!NUMERIC_FIELDS.includes(tag.name) && tag.name !== "process_count") continue;
    assert.equal(tag.omitempty, false, `"${tag.name}" must not be omitempty`);
  }
});

test("Volume carries the fields the backend tags and stores", () => {
  const sent = new Set(volumeTags.map((t) => t.name));
  for (const field of ["mount", "fstype", "total_gb", "used_gb", "percent"]) {
    assert.ok(sent.has(field), `Volume is missing json tag "${field}"`);
  }
});

test("Payload's optional extras stay optional", () => {
  // These ride along on some posts only; without omitempty every post would
  // carry an empty host object and a zero interval, and the backend would
  // treat the zero interval as a real cadence.
  const byName = Object.fromEntries(payloadTags.map((t) => [t.name, t]));
  for (const field of ["host", "interval_seconds", "collected_at"]) {
    assert.ok(byName[field], `Payload is missing json tag "${field}"`);
    assert.equal(byName[field].omitempty, true, `"${field}" must be omitempty`);
  }
});

test("Payload embeds ServerMetrics so the metric contract stays flat", () => {
  // If someone nests it (`Metrics ServerMetrics \`json:"metrics"\``) the wire
  // shape changes and every deployed agent breaks.
  const body = structBody("Payload");
  assert.match(
    body,
    /^\s*ServerMetrics\s*$/m,
    "Payload must embed ServerMetrics anonymously, not nest it under a key",
  );
});

test("the agent's volume cap is not above the backend's", () => {
  // The backend truncates at MAX_VOLUMES; an agent cap above it would silently
  // drop volumes server-side instead of reporting them.
  const m = source.match(/maxVolumes\s*=\s*(\d+)/) ?? readFileSync(
    path.resolve(HERE, "../../go-agent/internal/collector/collector.go"), "utf8",
  ).match(/maxVolumes\s*=\s*(\d+)/);
  assert.ok(m, "could not find maxVolumes in the Go agent");
  assert.ok(
    Number(m[1]) <= 32,
    `agent maxVolumes (${m[1]}) exceeds the backend's MAX_VOLUMES (32)`,
  );
});
