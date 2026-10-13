import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import * as hosts from "../src/lib/hosts.js";

const source = (await readFile(new URL("../src/main.js", import.meta.url), "utf8"))
  .replace(/^import \{([\s\S]*?)\} from "\.\/lib\/hosts.js";/, "const {$1} = hosts;");
const initialHosts = hosts.applyManagedBlock("127.0.0.1 localhost\n", {
  name: "macOS local",
  entries: [{ ip: "127.0.0.1", host: "app.local", enabled: true }]
});

async function app(options = {}) {
  let disk = initialHosts;
  const calls = [];
  const listeners = new Map();
  const storage = new Map([["hostdeck-native-v1", JSON.stringify({
    entries: [{ id: "app", ip: "127.0.0.1", host: "app.local", enabled: true, favorite: true }],
    hostsText: initialHosts,
    ...options.stored
  })]]);
  const root = { innerHTML: "", addEventListener() {}, querySelector() { return null; }, querySelectorAll() { return []; } };
  const context = vm.createContext({
    hosts,
    console,
    document: {
      documentElement: { classList: { toggle() {} } },
      querySelector() { return root; },
      addEventListener() {}
    },
    localStorage: {
      getItem(key) { return storage.get(key) ?? null; },
      setItem(key, value) { storage.set(key, value); },
      removeItem(key) { storage.delete(key); }
    },
    window: {
      addEventListener() {}, clearTimeout() {}, setTimeout() {},
      confirm() { return options.confirm !== false; },
      __TAURI__: {
        event: { async listen(name, callback) { listeners.set(name, callback); } },
        core: { async invoke(command, args) {
          calls.push({ command, args });
          if (command === "read_hosts") return { contents: disk, path: "/etc/hosts", modified_at: 0 };
          if (command === "write_hosts") {
            if (options.writeError) throw new Error(options.writeError);
            if (options.beforeWrite) await options.beforeWrite();
            assert.equal(args.expectedContents, disk);
            disk = args.contents;
            if (options.writeErrorAfterWrite) throw new Error(options.writeErrorAfterWrite);
            return { backup_path: "/etc/hosts.test.bak" };
          }
        } }
      }
    }
  });
  vm.runInContext(`${source}\nglobalThis.app = {
    get state() { return state; },
    get toast() { return toast; },
    handleClick, syncTray, saveState,
    settle: async () => { await trayUpdate; }
  };`, context);
  await new Promise((resolve) => setImmediate(resolve));
  await context.app.settle();
  return {
    ...context.app,
    get state() { return context.app.state; },
    get disk() { return disk; },
    get html() { return root.innerHTML; },
    calls, storage,
    toggle: () => listeners.get("tray-toggle")({ payload: context.app.state.entries[0].id }),
    quit: () => listeners.get("tray-quit")(),
    favorite() {
      context.app.handleClick({ target: { closest() {
        return { dataset: { action: "favorite-entry", id: context.app.state.entries[0].id } };
      } } });
    }
  };
}

test("stars survive disk reload and restart without dirtying hosts", async () => {
  const first = await app();
  assert.equal(first.state.entries[0].favorite, true);
  assert.equal(first.state.dirty, false);
  assert.match(first.html, /aria-pressed="true"/);
  first.favorite();
  await first.settle();
  assert.equal(first.state.entries[0].favorite, false);
  assert.equal(first.state.dirty, false);
  assert.equal(first.calls.some((call) => call.command === "write_hosts"), false);
  const stored = JSON.parse(first.storage.get("hostdeck-native-v1"));
  const restarted = await app({ stored });
  assert.equal(restarted.state.entries[0].favorite, false);
});

test("menu toggle applies one host, retains its star, and updates the checkmark", async () => {
  const instance = await app();
  await instance.toggle();
  await instance.settle();
  assert.match(instance.disk, /# 127\.0\.0\.1\tapp\.local/);
  assert.equal(instance.state.entries[0].enabled, false);
  assert.equal(instance.state.entries[0].favorite, true);
  assert.equal(instance.state.dirty, false);
  assert.equal(instance.calls.filter((call) => call.command === "write_hosts").length, 1);
  const menu = instance.calls.filter((call) => call.command === "update_tray").at(-1).args;
  assert.equal(menu.entries[0].enabled, false);
  assert.equal(menu.busy, false);
});

test("cancelled authorization restores the applied toggle and favorite", async () => {
  const instance = await app({ writeError: "User canceled." });
  await instance.toggle();
  await instance.settle();
  assert.equal(instance.disk, initialHosts);
  assert.equal(instance.state.entries[0].enabled, true);
  assert.equal(instance.state.entries[0].favorite, true);
  assert.equal(instance.state.dirty, false);
  assert.equal(instance.calls.some((call) => call.command === "open_window"), true);
});

test("a DNS flush failure reflects a write that already reached disk", async () => {
  const instance = await app({ writeErrorAfterWrite: "Could not flush DNS." });
  await instance.toggle();
  await instance.settle();
  assert.match(instance.disk, /# 127\.0\.0\.1\tapp\.local/);
  assert.equal(instance.state.entries[0].enabled, false);
  assert.equal(instance.state.entries[0].favorite, true);
  assert.equal(instance.state.dirty, false);
  const menu = instance.calls.filter((call) => call.command === "update_tray").at(-1).args;
  assert.equal(menu.entries[0].enabled, false);
});

test("a stale-file error aborts a menu apply without retrying the write", async () => {
  const instance = await app({ writeError: "The file changed since it was loaded." });
  await instance.toggle();
  assert.equal(instance.calls.filter((call) => call.command === "write_hosts").length, 1);
  assert.equal(instance.state.entries[0].enabled, true);
});

test("unsaved edits disable menu toggles and show the applied checkmark", async () => {
  const instance = await app({ stored: {
    dirty: true,
    entries: [{ id: "app", ip: "127.0.0.1", host: "app.local", enabled: false, favorite: true }]
  } });
  const menu = instance.calls.filter((call) => call.command === "update_tray").at(-1).args;
  assert.equal(menu.dirty, true);
  assert.equal(menu.entries[0].enabled, true);
  await instance.toggle();
  assert.equal(instance.calls.some((call) => call.command === "write_hosts"), false);
  assert.equal(instance.state.entries[0].enabled, false);
});

test("rapid menu clicks do not start concurrent writes", async () => {
  let finishWrite;
  const pendingWrite = new Promise((resolve) => { finishWrite = resolve; });
  const instance = await app({ beforeWrite: () => pendingWrite });
  const first = instance.toggle();
  await new Promise((resolve) => setImmediate(resolve));
  await instance.toggle();
  assert.equal(instance.calls.filter((call) => call.command === "write_hosts").length, 1);
  finishWrite();
  await first;
});

test("quit confirmation preserves drafts and cancellation keeps the app open", async () => {
  const instance = await app({ stored: { dirty: true }, confirm: false });
  await instance.quit();
  assert.equal(instance.calls.some((call) => call.command === "open_window"), true);
  assert.equal(instance.calls.some((call) => call.command === "quit_app"), false);
  assert.equal(JSON.parse(instance.storage.get("hostdeck-native-v1")).dirty, true);
});

test("restored loading state does not strand the menu", async () => {
  const instance = await app({ stored: { loading: true, dirty: true } });
  assert.equal(instance.state.loading, false);
  const menu = instance.calls.filter((call) => call.command === "update_tray").at(-1).args;
  assert.equal(menu.busy, false);
});

test("an empty restored draft stays empty", async () => {
  const instance = await app({ stored: { entries: [], dirty: true } });
  assert.equal(instance.state.entries.length, 0);
  assert.equal(instance.state.dirty, true);
});
