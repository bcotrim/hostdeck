# Hostdeck

Hostdeck is a macOS app for reading, editing, and applying `/etc/hosts` entries from a compact desktop table UI.

It is built with Tauri and intentionally focuses on one local hosts file: `/etc/hosts`.

## Features

- Reads the current macOS `/etc/hosts` file
- Shows active entries and commented-out entries
- All / Active / Inactive filters
- Individual row toggles
- Star favorite entries for quick toggles from the macOS menu bar
- Menu bar prompt uses native tint, with a green `$` when any favorite is active
- Search by IP, domain, or comment
- Adds, edits, disables, and deletes host entries
- Writes a managed hosts block while preserving unmanaged content
- Creates timestamped `/etc/hosts.hostdeck.<timestamp>.bak` backups
- Flushes macOS DNS after applying changes
- Validates IPs, host names, and duplicate active entries

## Requirements

- macOS 13 or newer
- Node.js
- Rust / Cargo

## Development

Run the browser preview:

```sh
npm run dev
```

Then open `http://localhost:5174`.

Run the macOS app:

```sh
npm run tauri
```

Run tests:

```sh
npm test
```

The Rust checks run with `cargo test --manifest-path src-tauri/Cargo.toml --locked`. After signing setup, run `HOSTDECK_TEST_SIGNING_IDENTITY="Hostdeck Local Development" npm test` to include certificate and native XPC authentication checks; plain `npm test` checks unsigned-code rejection.

Create a local signing identity once (stored in your login Keychain):

```sh
npm run setup-signing
```

Build the signed macOS app:

```sh
npm run tauri:build
```

For a Developer ID build, set `APPLE_SIGNING_IDENTITY` to your certificate name. Keep the same identity across updates.

The built app is created at:

```text
src-tauri/target/release/bundle/macos/Hostdeck.app
```

Install it at `/Applications/Hostdeck.app`, open it, and click **Enable helper**. Approve Hostdeck in **System Settings → General → Login Items** (called **Login Items & Extensions** on newer macOS). After approval, menu bar toggles apply without another password prompt.

After replacing the installed app with an update, click **Re-enable helper** to restart it. You can disable it in System Settings. An unsigned `npm run tauri` development session can edit drafts and read hosts, but cannot perform privileged operations.

## Security Notes

The browser preview uses local state. The Tauri app reads `/etc/hosts` directly.

Writing `/etc/hosts` uses a macOS-managed privileged helper approved once by an administrator. Hostdeck does not save your administrator password. The app and helper authenticate each other using the same signing identity; keep that private key secure. The local identity is trusted only for code signing on this Mac; distribution to other Macs requires Developer ID signing and notarization.

The helper accepts only hosts writes, backups, and DNS flushes, with fixed paths and commands. It validates hosts contents, preserves protected system entries, refuses stale writes, and creates a backup before atomically replacing the file. Hosts files are limited to 256 KiB.

Menu bar toggles apply immediately using the approved helper and the same backup flow. Apply or discard unsaved edits in the main window before using them. Stars are saved locally and do not modify `/etc/hosts`.

Closing the window hides Hostdeck from the Dock and keeps its menu bar controls running. Use **Open Hostdeck** to restore the window and Dock icon, or **Quit Hostdeck** to exit. The menu bar is available in the native app; the browser preview supports stars only.

## License

MIT
