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

- macOS 11 or newer
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

Build the macOS app:

```sh
npm run tauri:build
```

The built app is created at:

```text
src-tauri/target/release/bundle/macos/Hostdeck.app
```

## Security Notes

The browser preview uses local state. The Tauri app reads `/etc/hosts` directly.

Writing `/etc/hosts` requires administrator permission on macOS. Hostdeck asks macOS for admin approval only when applying changes, writes a backup first, then flushes DNS.

Menu bar toggles apply immediately using the same backup and administrator approval flow. Apply or discard unsaved edits in the main window before using them. Stars are saved locally and do not modify `/etc/hosts`.

Closing the window keeps Hostdeck in the menu bar. Use **Open Hostdeck** to return or **Quit Hostdeck** to exit. The menu bar is available in the native app; the browser preview supports stars only.

## License

MIT
