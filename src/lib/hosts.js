export const MANAGED_START = "# BEGIN Hostdeck managed block";
export const MANAGED_END = "# END Hostdeck managed block";

const HOST_LABEL_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i;

export function isValidIp(value) {
  const ip = String(value || "").trim();
  if (!ip) return false;

  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(ip)) {
    return ip.split(".").every((part) => Number(part) >= 0 && Number(part) <= 255);
  }

  if (ip === "::" || ip === "::1") return true;
  if (!/^[0-9a-f:]+$/i.test(ip) || !ip.includes(":")) return false;

  const sections = ip.split(":");
  if (sections.length > 8) return false;
  if (ip.includes(":::")) return false;

  const compact = ip.includes("::");
  if (!compact && sections.length !== 8) return false;
  if (compact && ip.indexOf("::") !== ip.lastIndexOf("::")) return false;

  return sections.every((section) => section === "" || section.length <= 4);
}

export function isValidHostname(value) {
  const host = String(value || "").trim();
  if (!host || host.length > 253 || host.includes("..")) return false;
  if (/[/:#\s]/.test(host)) return false;
  return host.split(".").every((label) => HOST_LABEL_RE.test(label));
}

export function normalizeEntry(entry = {}) {
  return {
    id: entry.id || cryptoId("entry"),
    ip: String(entry.ip || "").trim(),
    host: String(entry.host || "").trim().toLowerCase(),
    comment: String(entry.comment || "").replace(/\s+/g, " ").trim(),
    enabled: entry.enabled !== false
  };
}

export function normalizeProfile(profile = {}) {
  return {
    id: profile.id || cryptoId("profile"),
    name: String(profile.name || "Untitled profile").trim(),
    color: normalizeColor(profile.color),
    entries: Array.isArray(profile.entries) ? profile.entries.map(normalizeEntry) : []
  };
}

export function validateProfiles(profiles) {
  const issues = [];

  for (const profile of profiles) {
    const profileHosts = new Map();

    profile.entries.forEach((entry, index) => {
      if (!entry.enabled) return;
      const label = `${profile.name} row ${index + 1}`;

      if (!entry.ip) {
        issues.push(issue("error", profile.id, entry.id, "ip", `${label} is missing an IP address.`));
      } else if (!isValidIp(entry.ip)) {
        issues.push(issue("error", profile.id, entry.id, "ip", `${label} has an invalid IP address.`));
      }

      if (!entry.host) {
        issues.push(issue("error", profile.id, entry.id, "host", `${label} is missing a host name.`));
      } else if (!isValidHostname(entry.host)) {
        issues.push(issue("error", profile.id, entry.id, "host", `${label} has an invalid host name.`));
      }

      if (isValidHostname(entry.host)) {
        const key = entry.host.toLowerCase();
        if (profileHosts.has(key)) {
          issues.push(issue("error", profile.id, entry.id, "host", `${entry.host} appears more than once in ${profile.name}.`));
        }
        profileHosts.set(key, entry.id);
      }
    });
  }

  return issues;
}

export function renderManagedBlock(profile, options = {}) {
  const updatedAt = options.updatedAt || new Date().toISOString();
  const entries = profile.entries.filter((entry) => entry.ip && entry.host);
  const lines = [
    MANAGED_START,
    `# Profile: ${sanitizeComment(profile.name)}`,
    `# Updated: ${updatedAt}`
  ];

  for (const entry of entries) {
    const comment = entry.comment ? ` # ${sanitizeComment(entry.comment)}` : "";
    const prefix = entry.enabled ? "" : "# ";
    lines.push(`${prefix}${entry.ip}\t${entry.host}${comment}`);
  }

  lines.push(MANAGED_END);
  return lines.join("\n");
}

export function stripManagedBlock(hostsText = "") {
  const source = String(hostsText);
  const pattern = new RegExp(`\\n?${escapeRegExp(MANAGED_START)}[\\s\\S]*?${escapeRegExp(MANAGED_END)}\\n?`, "g");
  return source.replace(pattern, "\n").replace(/\n{3,}/g, "\n\n").trimEnd();
}

export function applyManagedBlock(hostsText, profile, options = {}) {
  const base = stripManagedBlock(hostsText);
  const block = renderManagedBlock(profile, options);
  return `${base ? `${base}\n\n` : ""}${block}\n`;
}

export function parseHostsText(hostsText = "") {
  return String(hostsText)
    .split(/\r?\n/)
    .map((line, index) => parseHostsLine(line, index + 1))
    .filter(Boolean);
}

export function serializeProfile(profile) {
  return JSON.stringify({ version: 1, profile: normalizeProfile(profile) }, null, 2);
}

export function parseProfileJson(source) {
  const payload = JSON.parse(source);
  const profile = payload.profile || payload;
  if (!profile || typeof profile !== "object") {
    throw new Error("Import must contain a profile object.");
  }
  return normalizeProfile(profile);
}

function parseHostsLine(line, lineNumber) {
  const raw = String(line);
  const trimmed = raw.trim();
  if (!trimmed || trimmed.startsWith("#")) return null;

  const [body, ...commentParts] = raw.split("#");
  const parts = body.trim().split(/\s+/).filter(Boolean);
  if (parts.length < 2) return null;

  return {
    lineNumber,
    ip: parts[0],
    host: parts[1],
    aliases: parts.slice(2),
    comment: commentParts.join("#").trim(),
    validIp: isValidIp(parts[0]),
    validHost: isValidHostname(parts[1])
  };
}

function issue(level, profileId, entryId, field, message) {
  return { level, profileId, entryId, field, message };
}

function sanitizeComment(value) {
  return String(value || "").replace(/[\r\n#]/g, " ").replace(/\s+/g, " ").trim();
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalizeColor(value) {
  const color = String(value || "").trim();
  return /^#[0-9a-f]{6}$/i.test(color) ? color : "#0f9f8f";
}

function cryptoId(prefix) {
  if (globalThis.crypto?.randomUUID) return `${prefix}-${globalThis.crypto.randomUUID()}`;
  return `${prefix}-${Math.random().toString(36).slice(2, 10)}`;
}
