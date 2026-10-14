import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

const identities = execFileSync("/usr/bin/security", ["find-identity", "-v", "-p", "codesigning"], { encoding: "utf8" });
const identity = process.env.APPLE_SIGNING_IDENTITY || "Hostdeck Local Development";
assert(identities.split("\n").some((line) => line.includes(`"${identity}"`) || (identity.match(/^[A-Fa-f0-9]{40}$/) && line.includes(identity))), "Run npm run setup-signing first, or set APPLE_SIGNING_IDENTITY to an available signing identity.");
const args = process.argv.slice(2);
execFileSync(resolve("node_modules/.bin/tauri"), ["build", ...args], {
  stdio: "inherit",
  env: { ...process.env, APPLE_SIGNING_IDENTITY: identity, MACOSX_DEPLOYMENT_TARGET: "13.0" }
});
const app = resolve(`src-tauri/target/${args.includes("--debug") ? "debug" : "release"}/bundle/macos/Hostdeck.app`);
assert(existsSync(`${app}/Contents/Library/LaunchDaemons/dev.hostdeck.manager.helper.plist`), "Missing helper launch configuration.");
execFileSync("/usr/bin/codesign", ["--verify", "--strict", "--deep", app], { stdio: "inherit" });
const signature = spawnSync("/usr/bin/codesign", ["--display", "--verbose=4", app], { encoding: "utf8" });
assert.equal(signature.status, 0, signature.stderr);
assert.match(signature.stderr, /flags=.*runtime/, "The helper requires hardened runtime signing.");
assert.match(signature.stderr, /Authority=/, "The helper requires a certificate signature.");
console.log(`Signed app: ${app}`);
