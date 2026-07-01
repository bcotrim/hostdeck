import test from "node:test";
import assert from "node:assert/strict";
import {
  MANAGED_END,
  MANAGED_START,
  applyManagedBlock,
  buildHostsText,
  extractManagedBlock,
  findManagedHostConflicts,
  isProtectedHostname,
  isValidHostname,
  isValidIp,
  parseHostsRows,
  parseHostsText,
  parseProfileJson,
  serializeProfile,
  stripManagedBlock,
  validateProfiles
} from "../src/lib/hosts.js";

const profile = {
  id: "local",
  name: "Local dev",
  color: "#0f9f8f",
  entries: [
    { id: "one", ip: "127.0.0.1", host: "app.local", comment: "frontend", enabled: true },
    { id: "two", ip: "10.10.0.5", host: "api.local", comment: "", enabled: false }
  ]
};

test("validates hosts-file IP addresses", () => {
  assert.equal(isValidIp("127.0.0.1"), true);
  assert.equal(isValidIp("255.255.255.255"), true);
  assert.equal(isValidIp("::1"), true);
  assert.equal(isValidIp("300.0.0.1"), false);
  assert.equal(isValidIp("localhost"), false);
});

test("validates host names", () => {
  assert.equal(isValidHostname("app.local"), true);
  assert.equal(isValidHostname("localhost"), true);
  assert.equal(isValidHostname("-bad.local"), false);
  assert.equal(isValidHostname("bad host.local"), false);
  assert.equal(isValidHostname("https://app.local"), false);
});

test("detects protected system host names", () => {
  assert.equal(isProtectedHostname("localhost"), true);
  assert.equal(isProtectedHostname("broadcasthost"), true);
  assert.equal(isProtectedHostname("app.localhost"), true);
  assert.equal(isProtectedHostname("app.local"), false);
});

test("applies a managed block while preserving unmanaged content", () => {
  const original = "127.0.0.1 localhost\n\n# team entries\n10.0.0.1 old.local\n";
  const next = applyManagedBlock(original, profile, { updatedAt: "2026-06-26T10:00:00.000Z" });

  assert.match(next, /^127\.0\.0\.1 localhost/);
  assert.match(next, /# team entries\n10\.0\.0\.1 old\.local/);
  assert.match(next, new RegExp(`${MANAGED_START}[\\s\\S]*app\\.local[\\s\\S]*${MANAGED_END}`));
  assert.match(next, /# 10\.10\.0\.5\tapi\.local/);
});

test("replaces an existing managed block", () => {
  const first = applyManagedBlock("127.0.0.1 localhost\n", profile, { updatedAt: "first" });
  const nextProfile = { ...profile, entries: [{ id: "three", ip: "127.0.0.1", host: "shop.local", enabled: true }] };
  const second = applyManagedBlock(first, nextProfile, { updatedAt: "second" });

  assert.equal((second.match(new RegExp(MANAGED_START, "g")) || []).length, 1);
  assert.match(second, /shop\.local/);
  assert.doesNotMatch(second, /app\.local/);
});

test("strips managed block", () => {
  const applied = applyManagedBlock("127.0.0.1 localhost\n", profile, { updatedAt: "now" });
  assert.equal(stripManagedBlock(applied), "127.0.0.1 localhost");
});

test("reports invalid and duplicate active entries", () => {
  const profiles = [{
    ...profile,
    entries: [
      { id: "one", ip: "127.0.0.1", host: "app.local", enabled: true },
      { id: "two", ip: "999.0.0.1", host: "app.local", enabled: true }
    ]
  }];
  const issues = validateProfiles(profiles, "local").map((item) => item.message);

  assert.equal(issues.some((message) => message.includes("invalid IP")), true);
  assert.equal(issues.some((message) => message.includes("more than once")), true);
});

test("reports protected active entries", () => {
  const issues = validateProfiles([{
    ...profile,
    entries: [{ id: "system", ip: "127.0.0.1", host: "localhost", enabled: true }]
  }]).map((item) => item.message);

  assert.equal(issues.some((message) => message.includes("protected system host")), true);
});

test("parses active hosts lines", () => {
  const rows = parseHostsText("127.0.0.1 localhost\n# ignored\n10.0.0.2 app.local alias.local # app\n");

  assert.equal(rows.length, 2);
  assert.equal(rows[1].host, "app.local");
  assert.deepEqual(rows[1].aliases, ["alias.local"]);
  assert.equal(rows[1].comment, "app");
});

test("parses disabled hosts rows when requested", () => {
  const rows = parseHostsRows("# 10.0.0.2 app.local alias.local # app\n", { includeDisabled: true });

  assert.equal(rows.length, 1);
  assert.equal(rows[0].enabled, false);
  assert.equal(rows[0].host, "app.local");
  assert.deepEqual(rows[0].aliases, ["alias.local"]);
  assert.equal(rows[0].comment, "app");
});

test("extracts managed block", () => {
  const text = applyManagedBlock("127.0.0.1 localhost\n", profile, { updatedAt: "now" });
  const block = extractManagedBlock(text);

  assert.match(block, new RegExp(`^${MANAGED_START}`));
  assert.match(block, new RegExp(`${MANAGED_END}$`));
});

test("finds unmanaged primary and alias host conflicts", () => {
  const hostsText = [
    "127.0.0.1 localhost",
    "10.0.0.1 app.local",
    "10.0.0.2 other.local api.local"
  ].join("\n");
  const conflicts = findManagedHostConflicts(hostsText, profile);

  assert.deepEqual(conflicts.map((row) => row.lineNumber), [2, 3]);
  assert.deepEqual(conflicts.map((row) => row.matches), [["app.local"], ["api.local"]]);
});

test("builds hosts text by replacing primary and alias conflicts", () => {
  const hostsText = [
    "127.0.0.1 localhost",
    "10.0.0.1 app.local",
    "10.0.0.2 other.local api.local",
    "10.0.0.3 keep.local"
  ].join("\n");
  const next = buildHostsText(hostsText, profile, { updatedAt: "now" });

  assert.match(next, /127\.0\.0\.1 localhost/);
  assert.match(next, /10\.0\.0\.3 keep\.local/);
  assert.doesNotMatch(next, /10\.0\.0\.1 app\.local/);
  assert.doesNotMatch(next, /10\.0\.0\.2 other\.local api\.local/);
  assert.match(next, /127\.0\.0\.1\tapp\.local/);
  assert.match(next, /# 10\.10\.0\.5\tapi\.local/);
});

test("preserves protected system hosts when building hosts text", () => {
  const protectedProfile = {
    ...profile,
    entries: [
      { id: "system", ip: "127.0.0.1", host: "localhost", enabled: false },
      { id: "app", ip: "127.0.0.1", host: "app.local", enabled: true }
    ]
  };
  const hostsText = "127.0.0.1 localhost\n255.255.255.255 broadcasthost\n::1 localhost\n";
  const next = buildHostsText(hostsText, protectedProfile, { updatedAt: "now" });

  assert.match(next, /^127\.0\.0\.1 localhost/);
  assert.match(next, /255\.255\.255\.255 broadcasthost/);
  assert.match(next, /::1 localhost/);
  assert.doesNotMatch(next, /# 127\.0\.0\.1\tlocalhost/);
  assert.match(next, /127\.0\.0\.1\tapp\.local/);
});

test("does not report protected system rows as managed conflicts", () => {
  const protectedProfile = {
    ...profile,
    entries: [{ id: "system", ip: "127.0.0.1", host: "localhost", enabled: false }]
  };

  assert.deepEqual(findManagedHostConflicts("127.0.0.1 localhost\n", protectedProfile), []);
});

test("round trips profile JSON", () => {
  const parsed = parseProfileJson(serializeProfile(profile));

  assert.equal(parsed.name, "Local dev");
  assert.equal(parsed.entries[0].host, "app.local");
});
