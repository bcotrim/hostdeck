import {
  buildHostsText,
  extractManagedBlock,
  findManagedHostConflicts,
  isProtectedHostname,
  normalizeEntry,
  normalizeProfile,
  parseHostsRows,
  renderManagedBlock,
  validateProfiles
} from "./lib/hosts.js";

const STORAGE_KEY = "hostdeck-native-v1";
const MACOS_DNS_COMMAND = "sudo dscacheutil -flushcache && sudo killall -HUP mDNSResponder";
const DEFAULT_HOSTS = `##
# Host Database
##
127.0.0.1       localhost
255.255.255.255 broadcasthost
::1             localhost
`;
const invokeNative = window.__TAURI__?.core?.invoke ?? null;
document.documentElement.classList.toggle("is-native-shell", Boolean(invokeNative));

const root = document.querySelector("#app");
let state = loadState();
let toast = null;

root.addEventListener("click", handleClick);
root.addEventListener("input", handleInput);
root.addEventListener("change", handleChange);
document.addEventListener("keydown", handleKeydown, true);
window.addEventListener("beforeunload", handleBeforeUnload);

render();
if (state.dirty && invokeNative) {
  showToast("Unsaved edits restored. Reload /etc/hosts to discard.", "warn");
} else {
  loadHostsFromDisk();
}

function render(options = {}) {
  const entries = filteredEntries();
  const activeCount = state.entries.filter((entry) => entry.enabled).length;
  const inactiveCount = state.entries.length - activeCount;
  const issues = validateProfiles([environmentProfile()]);
  const issueLookup = buildIssueLookup(issues);
  const firstIssue = issues[0];
  const isReady = state.dirty && issues.length === 0;
  const sourceLabel = invokeNative ? state.hostsPath : "Browser preview";
  const syncLabel = state.loading ? "Loading" : issues.length ? `${issues.length} issue${issues.length === 1 ? "" : "s"}` : state.dirty ? "Edited" : "In sync";
  const syncState = state.loading ? "is-loading" : issues.length ? "is-warn" : state.dirty ? "is-dirty" : "is-sync";

  root.innerHTML = `
    <main class="desktop-shell">
      <section class="window">
        <header class="titlebar" data-tauri-drag-region="deep">
          <div class="brand-lockup">
            <span class="prompt-mark" aria-hidden="true"><span>~</span><strong>$</strong><i></i></span>
            <div>
              <h1>hostdeck</h1>
              <p>${e(sourceLabel)}</p>
            </div>
          </div>

          <div class="summary-strip" aria-label="Hosts summary">
            <span><strong>${activeCount}</strong> active</span>
            <span><strong>${inactiveCount}</strong> inactive</span>
            <span class="status-pill ${syncState}" title="${e(firstIssue?.message || syncLabel)}"><span class="sync-dot"></span>${e(syncLabel)}</span>
          </div>
        </header>

        <section class="toolbar">
          <div class="filters" aria-label="Entry filters">
            ${filterButton("all", "all", state.entries.length)}
            ${filterButton("active", "active", activeCount)}
            ${filterButton("inactive", "inactive", inactiveCount)}
            <span class="entry-total">${state.entries.length} entries</span>
          </div>

          <label class="search">
            ${icon("search")}
            <input id="search" type="search" placeholder="search hosts, ips, comments" aria-label="Search hosts, IPs, and comments" value="${e(state.search)}">
            <kbd>⌘K</kbd>
          </label>

          <div class="actions">
            <button class="square-button" data-action="reload" title="Reload /etc/hosts" aria-label="Reload /etc/hosts">${icon("refresh")}</button>
            <button class="square-button is-hot ${isReady ? "is-ready" : ""}" data-action="sync-hosts" title="${state.dirty ? "Apply & flush DNS" : "Flush DNS"}" aria-label="${state.dirty ? "Apply and flush DNS" : "Flush DNS"}">${icon("zap")}</button>
            <button class="add-button" data-action="add-entry" aria-label="Add entry">${icon("plus")}<span>add entry</span><kbd>⌘N</kbd></button>
          </div>
        </section>

        <section class="table-wrap">
          <table class="entries-table">
            <thead>
              <tr>
                <th class="check-cell"><input type="checkbox" ${allSelected() ? "checked" : ""} data-action="select-visible" aria-label="Select visible entries"></th>
                <th>Status</th>
                <th>IP</th>
                <th>Domain</th>
                <th>Comment</th>
                <th class="actions-cell">Actions</th>
              </tr>
            </thead>
            <tbody>
              ${entries.length ? entries.map((entry) => renderRow(entry, issueLookup)).join("") : emptyRow()}
            </tbody>
          </table>
        </section>

        <footer class="statusbar">
          <div class="sync-status">
            <span class="sync-dot ${syncState}"></span>
            <strong>${e(syncLabel)}</strong>
            ${firstIssue ? issueButton(firstIssue) : ""}
            <span>·</span>
            <span>${e(sourceLabel)}</span>
            <span>·</span>
            <span>${e(state.environment.stage)}</span>
            <span>·</span>
            <span>${activeCount}/${state.entries.length} active</span>
            <span>·</span>
            <button data-action="backup-now" aria-label="Back up /etc/hosts">Backup</button>
            <span>·</span>
            <span>${state.lastAppliedAt ? formatRelative(state.lastAppliedAt) : "just now"}</span>
          </div>
        </footer>
      </section>
      ${toast ? `<div class="toast ${toast.kind}">${e(toast.message)}</div>` : ""}
    </main>
  `;
  restoreFocus(options.focus);
}

function filterButton(filter, label, count) {
  return `
    <button class="filter ${state.filter === filter ? "is-active" : ""}" data-action="set-filter" data-filter="${filter}">
      ${label} <span>${count}</span>
    </button>
  `;
}

function renderRow(entry, issueLookup = new Map()) {
  const muted = entry.enabled ? "" : "is-muted";
  const label = e(entry.host || entry.ip || "entry");
  const ipIssue = issueLookup.get(issueKey(entry.id, "ip"));
  const hostIssue = issueLookup.get(issueKey(entry.id, "host"));
  const commentIssue = issueLookup.get(issueKey(entry.id, "comment"));
  const rowClass = [muted, ipIssue || hostIssue || commentIssue ? "has-issue" : ""].filter(Boolean).join(" ");
  return `
    <tr class="${rowClass}" data-id="${entry.id}">
      <td class="check-cell"><input type="checkbox" data-action="select-entry" data-id="${entry.id}" aria-label="Select ${label}" ${entry.selected ? "checked" : ""}></td>
      <td>
        <label class="switch">
          <input type="checkbox" data-action="toggle-entry" data-id="${entry.id}" aria-label="${entry.enabled ? "Disable" : "Enable"} ${label}" ${entry.enabled ? "checked" : ""}>
          <span></span>
        </label>
      </td>
      <td><input class="cell-input mono ${ipIssue ? "is-invalid" : ""}" data-field="ip" data-id="${entry.id}" aria-label="IP for ${label}" value="${e(entry.ip)}" ${issueAttrs(ipIssue)}></td>
      <td><input class="cell-input mono domain ${hostIssue ? "is-invalid" : ""}" data-field="host" data-id="${entry.id}" aria-label="Domain for ${label}" value="${e(entry.host)}" ${issueAttrs(hostIssue)}></td>
      <td><input class="cell-input ${commentIssue ? "is-invalid" : ""}" data-field="comment" data-id="${entry.id}" aria-label="Comment for ${label}" value="${e(entry.comment)}" ${issueAttrs(commentIssue)}></td>
      <td class="actions-cell"><button class="row-action" data-action="delete-entry" data-id="${entry.id}" title="Delete" aria-label="Delete ${label}">${icon("trash")}</button></td>
    </tr>
  `;
}

function issueButton(issue) {
  return `
    <span>·</span>
    <button class="issue-link" data-action="focus-issue" data-entry-id="${e(issue.entryId)}" data-field="${e(issue.field)}">${e(issue.message)}</button>
  `;
}

function issueAttrs(issue) {
  return issue ? `aria-invalid="true" title="${e(issue.message)}"` : "";
}

function emptyRow() {
  return `
    <tr>
      <td colspan="6" class="empty">No entries match this view.</td>
    </tr>
  `;
}

function handleClick(event) {
  const button = event.target.closest("[data-action]");
  if (!button) return;

  const action = button.dataset.action;
  if (action === "set-filter") {
    state.filter = button.dataset.filter;
    saveState();
    render();
    return;
  }

  if (action === "add-entry") {
    addEntry();
    return;
  }

  if (action === "delete-entry") {
    state.entries = state.entries.filter((entry) => entry.id !== button.dataset.id);
    markDirty();
    return;
  }

  if (action === "focus-issue") {
    focusIssue(button.dataset.entryId, button.dataset.field);
    return;
  }

  if (action === "sync-hosts") {
    if (state.dirty) {
      applyEntries();
    } else {
      flushDns();
    }
    return;
  }

  if (action === "backup-now") {
    backupHosts();
    return;
  }

  if (action === "reload") {
    reloadHostsFromDisk();
    return;
  }
}

function handleKeydown(event) {
  if (event.isComposing || !event.metaKey || event.altKey || event.ctrlKey || event.shiftKey) return;

  const key = event.key.toLowerCase();
  if (key === "k") {
    event.preventDefault();
    focusSearch();
    return;
  }

  if (key === "n") {
    event.preventDefault();
    if (!event.repeat) addEntry();
  }
}

function handleBeforeUnload(event) {
  if (!state.dirty) return;
  event.preventDefault();
  event.returnValue = "";
}

function handleInput(event) {
  const target = event.target;
  if (target.id === "search") {
    state.search = target.value;
    saveState();
    renderEntriesOnly();
    return;
  }

  if (!target.dataset.field) return;
  const entry = findEntry(target.dataset.id);
  if (!entry) return;
  const field = target.dataset.field;
  const selectionStart = target.selectionStart;
  const selectionEnd = target.selectionEnd;
  entry[field] = field === "host" ? target.value.toLowerCase() : target.value;
  state.dirty = true;
  saveState();
  render({
    focus: {
      selector: `[data-field="${field}"][data-id="${entry.id}"]`,
      selectionStart,
      selectionEnd
    }
  });
}

function addEntry() {
  const entry = normalizeUiEntry({
    id: id("entry"),
    ip: "127.0.0.1",
    host: "new.local",
    comment: "",
    enabled: true
  });

  state.search = "";
  state.filter = "all";
  state.entries.unshift(entry);
  markDirty({
    focus: {
      selector: `[data-field="host"][data-id="${entry.id}"]`,
      select: true
    }
  });
}

function handleChange(event) {
  const target = event.target;
  if (target.dataset.action === "toggle-entry") {
    const entry = findEntry(target.dataset.id);
    if (!entry) return;
    entry.enabled = target.checked;
    markDirty();
    return;
  }

  if (target.dataset.action === "select-entry") {
    const entry = findEntry(target.dataset.id);
    if (!entry) return;
    entry.selected = target.checked;
    saveState();
    render();
    return;
  }

  if (target.dataset.action === "select-visible") {
    filteredEntries().forEach((entry) => {
      entry.selected = target.checked;
    });
    saveState();
    render();
  }
}

async function applyEntries(options = {}) {
  const profile = environmentProfile();
  const issues = validateProfiles([profile]);
  if (issues.length) {
    showToast(issues[0].message, "warn");
    return;
  }

  const conflicts = findManagedHostConflicts(state.hostsText, profile);
  if (conflicts.length && !confirmUnmanagedReplacements(conflicts)) return;

  const hostsText = nextHostsText();
  if (!invokeNative) {
    state.hostsText = hostsText;
    state.lastAppliedAt = new Date().toISOString();
    state.backupCount += 1;
    state.dirty = false;
    saveState();
    showToast("Preview applied. Native app writes /etc/hosts.");
    copyText(`${renderManagedBlock(profile)}\n\n${MACOS_DNS_COMMAND}`);
    return;
  }

  state.loading = true;
  saveState();
  render();

  try {
    const result = await invokeNative("write_hosts", {
      contents: hostsText,
      expectedContents: state.hostsText
    });
    state.hostsText = hostsText;
    state.lastAppliedAt = new Date().toISOString();
    state.backupCount += 1;
    state.dirty = false;
    saveState();
    showToast(`Applied. Backup: ${result.backup_path}`);
    await loadHostsFromDisk({ quiet: true });
  } catch (error) {
    if (!options.retriedAfterReload && isStaleHostsError(error)) {
      const reloaded = await loadHostsFromDisk({ keepDirty: true, preserveEntries: true, quiet: true });
      if (reloaded) {
        await applyEntries({ retriedAfterReload: true });
        return;
      }
    }

    state.loading = false;
    saveState();
    showToast(String(error), "warn");
    render();
  }
}

function isStaleHostsError(error) {
  return String(error).includes("changed since it was loaded");
}

function confirmUnmanagedReplacements(conflicts) {
  const preview = conflicts.slice(0, 4).map((row) => `${row.matches.join(", ")} on line ${row.lineNumber}`).join("; ");
  const extra = conflicts.length > 4 ? `, and ${conflicts.length - 4} more` : "";
  const rows = conflicts.length === 1 ? "row" : "rows";
  return window.confirm(
    `Hostdeck will move ${conflicts.length} existing unmanaged host ${rows} into its managed block and remove the original ${rows}.\n\n${preview}${extra}\n\nContinue?`
  );
}

function filteredEntries() {
  const search = state.search.trim().toLowerCase();
  return state.entries.filter((entry) => {
    const matchesFilter =
      state.filter === "all" ||
      (state.filter === "active" && entry.enabled) ||
      (state.filter === "inactive" && !entry.enabled);

    if (!matchesFilter) return false;
    if (!search) return true;
    return [entry.ip, entry.host, entry.comment].some((value) => value.toLowerCase().includes(search));
  });
}

function renderEntriesOnly() {
  const entries = filteredEntries();
  const issueLookup = buildIssueLookup(validateProfiles([environmentProfile()]));
  const tbody = root.querySelector(".entries-table tbody");
  if (tbody) {
    tbody.innerHTML = entries.length ? entries.map((entry) => renderRow(entry, issueLookup)).join("") : emptyRow();
  }

  const visibleCheckbox = root.querySelector('[data-action="select-visible"]');
  if (visibleCheckbox) {
    visibleCheckbox.checked = allSelected();
  }
}

function environmentProfile() {
  return normalizeProfile({
    id: "acme-dev",
    name: `${state.environment.client} ${state.environment.stage}`,
    entries: state.entries
  });
}

function nextHostsText() {
  return buildHostsText(state.hostsText, environmentProfile());
}

function allSelected() {
  const entries = filteredEntries();
  return entries.length > 0 && entries.every((entry) => entry.selected);
}

function findEntry(entryId) {
  return state.entries.find((entry) => entry.id === entryId);
}

function focusIssue(entryId, field) {
  if (!entryId || !field) return;
  const entry = findEntry(entryId);
  if (!entry) return;

  state.search = "";
  state.filter = "all";
  saveState();
  render({
    focus: {
      selector: `[data-field="${field}"][data-id="${entry.id}"]`,
      select: true
    }
  });
}

function buildIssueLookup(issues) {
  return new Map(issues.map((item) => [issueKey(item.entryId, item.field), item]));
}

function issueKey(entryId, field) {
  return `${entryId}:${field}`;
}

function markDirty(options = {}) {
  state.dirty = true;
  saveState();
  render(options);
}

function loadState() {
  try {
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY));
    if (stored?.entries?.length) {
      return {
        ...defaultState(),
        ...stored,
        entries: stored.entries.map(normalizeUiEntry)
      };
    }
  } catch {
    localStorage.removeItem(STORAGE_KEY);
  }
  return defaultState();
}

function saveState() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

function defaultState() {
  return {
    environment: {
      client: "macOS",
      stage: "local",
      name: "macOS · hosts"
    },
    filter: "all",
    search: "",
    backupCount: 0,
    dirty: false,
    loading: false,
    hostsPath: "/etc/hosts",
    hostsText: DEFAULT_HOSTS,
    hostsModifiedAt: null,
    lastAppliedAt: null,
    entries: invokeNative ? [] : [
      row("app", "127.0.0.1", "app.dev.acme.local", "Next.js front-end", true),
      row("api", "127.0.0.1", "api.dev.acme.local", "Node backend", true),
      row("admin", "127.0.0.1", "admin.dev.acme.local", "Back-office", true),
      row("minio", "192.168.1.42", "minio.dev.acme.local", "Local S3 storage", false),
      row("mail", "127.0.0.1", "mail.dev.acme.local", "MailHog", true),
      row("ws", "127.0.0.1", "ws.dev.acme.local", "WebSockets", false)
    ]
  };
}

async function loadHostsFromDisk(options = {}) {
  if (!invokeNative) return;

  state.loading = true;
  saveState();
  render();

  try {
    const hosts = await invokeNative("read_hosts");
    state.hostsText = hosts.contents;
    state.hostsPath = hosts.path;
    state.hostsModifiedAt = hosts.modified_at;
    if (!options.preserveEntries) syncEntriesFromHosts(hosts.contents);
    state.loading = false;
    state.dirty = Boolean(options.keepDirty);
    saveState();
    if (!options.quiet) showToast(`Loaded ${hosts.path}.`);
    render();
    return true;
  } catch (error) {
    state.loading = false;
    saveState();
    showToast(String(error), "warn");
    render();
    return false;
  }
}

function reloadHostsFromDisk() {
  if (state.dirty && !window.confirm("Discard unsaved Hostdeck edits and reload /etc/hosts?")) return;
  loadHostsFromDisk();
}

async function flushDns() {
  if (!invokeNative) {
    state.lastAppliedAt = new Date().toISOString();
    saveState();
    showToast("DNS flush command copied.");
    copyText(MACOS_DNS_COMMAND);
    render();
    return;
  }

  try {
    await invokeNative("flush_dns");
    state.lastAppliedAt = new Date().toISOString();
    saveState();
    showToast("DNS cache flushed.");
    render();
  } catch (error) {
    showToast(String(error), "warn");
  }
}

async function backupHosts() {
  if (!invokeNative) {
    state.backupCount += 1;
    saveState();
    showToast("Preview backup recorded.");
    render();
    return;
  }

  try {
    const result = await invokeNative("backup_hosts");
    state.backupCount += 1;
    saveState();
    showToast(`Backup: ${result.backup_path}`);
    render();
  } catch (error) {
    showToast(String(error), "warn");
  }
}

function syncEntriesFromHosts(hostsText) {
  const previousByHost = new Map(state.entries.map((entry) => [entry.host.toLowerCase(), entry]));
  const parsedEntries = entriesFromHosts(hostsText);
  const parsedHosts = new Set(parsedEntries.map((entry) => entry.host.toLowerCase()));
  const inactiveEntries = state.entries.filter((entry) => !entry.enabled && !parsedHosts.has(entry.host.toLowerCase()));

  state.entries = [
    ...parsedEntries.map((entry) => ({
      ...entry,
      selected: previousByHost.get(entry.host.toLowerCase())?.selected ?? false
    })),
    ...inactiveEntries
  ];
}

function entriesFromHosts(hostsText) {
  const source = extractManagedBlock(hostsText) || hostsText;
  const rows = parseHostsRows(source, { includeDisabled: true }).filter((row) => row.validIp && row.validHost && !isProtectedHostname(row.host));
  const order = [];
  const byHost = new Map();

  for (const row of rows) {
    const key = row.host.toLowerCase();
    const existing = byHost.get(key);
    if (!existing) order.push(key);
    if (!existing || row.enabled || !existing.enabled) byHost.set(key, row);
  }

  return order.map((key) => {
    const row = byHost.get(key);
    return normalizeUiEntry({
      id: entryId(row.host),
      ip: row.ip,
      host: row.host,
      comment: row.comment,
      enabled: row.enabled,
      selected: false
    });
  });
}

function entryId(host) {
  return `entry-${host.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "") || id("host")}`;
}

function row(idSuffix, ip, host, comment, enabled) {
  return normalizeUiEntry({ id: `entry-${idSuffix}`, ip, host, comment, enabled, selected: false });
}

function normalizeUiEntry(entry) {
  return {
    ...normalizeEntry(entry),
    selected: Boolean(entry.selected)
  };
}

function showToast(message, kind = "ok") {
  toast = { message, kind };
  render();
  window.clearTimeout(showToast.timer);
  showToast.timer = window.setTimeout(() => {
    toast = null;
    render();
  }, 2200);
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    legacyCopyText(text);
  }
}

function legacyCopyText(text) {
  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.style.position = "fixed";
  textarea.style.top = "-1000px";
  document.body.append(textarea);
  textarea.select();
  try {
    document.execCommand("copy");
  } catch {}
  textarea.remove();
}

function formatRelative(value) {
  const seconds = Math.max(0, Math.floor((Date.now() - new Date(value).getTime()) / 1000));
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  return `${Math.floor(minutes / 60)}h ago`;
}

function id(prefix) {
  if (globalThis.crypto?.randomUUID) return `${prefix}-${globalThis.crypto.randomUUID()}`;
  return `${prefix}-${Math.random().toString(36).slice(2, 10)}`;
}

function e(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function restoreFocus(focus) {
  if (!focus?.id && !focus?.selector) return;
  const element = focus.selector ? root.querySelector(focus.selector) : document.getElementById(focus.id);
  if (!element) return;

  element.focus({ preventScroll: true });
  if (focus.select && typeof element.select === "function") {
    element.select();
  } else if (typeof element.setSelectionRange === "function") {
    element.setSelectionRange(focus.selectionStart ?? element.value.length, focus.selectionEnd ?? element.value.length);
  }
}

function focusSearch() {
  const search = document.getElementById("search");
  if (!search) return;
  search.focus({ preventScroll: true });
  search.select();
}

function icon(name) {
  const paths = {
    search: "M10.5 18a7.5 7.5 0 1 1 5.3-12.8 7.5 7.5 0 0 1-5.3 12.8Zm5.2-2.3L21 21",
    refresh: "M20 12a8 8 0 0 1-13.7 5.7M4 12A8 8 0 0 1 17.7 6.3M18 3v4h-4M6 21v-4h4",
    zap: "m13 2-8 12h7l-1 8 8-12h-7l1-8Z",
    plus: "M12 5v14M5 12h14",
    trash: "M5 7h14M10 11v6M14 11v6M7 7l1 13h8l1-13M9 7V5h6v2"
  };

  return `<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="${paths[name] || paths.plus}"></path></svg>`;
}
