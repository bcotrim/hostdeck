use objc2::{rc::Retained, MainThreadMarker};
use objc2_app_kit::{NSColor, NSFont, NSFontAttributeName, NSForegroundColorAttributeName};
use objc2_foundation::{ns_string, NSMutableAttributedString, NSRange};
use serde::{Deserialize, Serialize};
use std::{
    fs::{self, OpenOptions},
    io::Write,
    os::unix::fs::OpenOptionsExt,
    path::PathBuf,
    process::Command,
    time::{SystemTime, UNIX_EPOCH},
};
use tauri::{
    menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem},
    tray::TrayIconBuilder,
    Emitter, Manager,
};

const HOSTS_PATH: &str = "/etc/hosts";

#[derive(Serialize)]
struct HostsState {
    contents: String,
    path: String,
    modified_at: Option<u64>,
}

#[derive(Serialize)]
struct PrivilegedResult {
    backup_path: String,
}

#[derive(Deserialize)]
struct TrayEntry {
    id: String,
    host: String,
    ip: String,
    enabled: bool,
}

#[tauri::command]
fn update_tray(
    app: tauri::AppHandle,
    entries: Vec<TrayEntry>,
    dirty: bool,
    busy: bool,
) -> Result<(), String> {
    let update = || -> tauri::Result<()> {
        let Some(tray) = app.tray_by_id("hostdeck") else {
            return Ok(());
        };
        let menu = Menu::new(&app)?;
        let active = entries.iter().filter(|entry| entry.enabled).count();
        let status = if busy {
            "Working…".to_string()
        } else if dirty {
            "Apply or discard edits in Hostdeck to toggle".to_string()
        } else if entries.is_empty() {
            "Star entries in Hostdeck to add favorites".to_string()
        } else {
            format!("{active}/{} favorites active", entries.len())
        };
        menu.append(&MenuItem::new(&app, &status, false, None::<&str>)?)?;
        for entry in &entries {
            menu.append(&CheckMenuItem::with_id(
                &app,
                format!("favorite:{}", entry.id),
                format!("{} · {}", entry.host, entry.ip),
                !dirty && !busy,
                entry.enabled,
                None::<&str>,
            )?)?;
        }
        menu.append(&PredefinedMenuItem::separator(&app)?)?;
        menu.append(&MenuItem::with_id(
            &app,
            "open",
            "Open Hostdeck",
            true,
            None::<&str>,
        )?)?;
        menu.append(&MenuItem::with_id(
            &app,
            "quit",
            "Quit Hostdeck",
            !busy,
            None::<&str>,
        )?)?;
        tray.set_menu(Some(menu))?;
        tray.with_inner_tray_icon(move |inner| {
            let mtm =
                MainThreadMarker::new().expect("Tauri runs tray callbacks on the main thread");
            let button = inner
                .ns_status_item()
                .and_then(|item| item.button(mtm))
                .expect("macOS tray button is available");
            button.setAttributedTitle(&tray_label(active > 0));
        })?;
        tray.set_tooltip(Some(format!("Hostdeck — {status}")))?;
        Ok(())
    };
    update().map_err(|error| format!("Could not update menu bar: {error}"))
}

fn tray_label(active: bool) -> Retained<NSMutableAttributedString> {
    let title = NSMutableAttributedString::from_nsstring(ns_string!("~ $"));
    let font = NSFont::fontWithName_size(ns_string!("Menlo-Bold"), 18.0)
        .unwrap_or_else(|| NSFont::boldSystemFontOfSize(18.0));
    unsafe {
        title.addAttribute_value_range(NSFontAttributeName, &font, NSRange::new(0, 3));
        title.addAttribute_value_range(
            NSForegroundColorAttributeName,
            &NSColor::labelColor(),
            NSRange::new(0, 3),
        );
        if active {
            let green = NSColor::colorWithSRGBRed_green_blue_alpha(
                63.0 / 255.0,
                224.0 / 255.0,
                123.0 / 255.0,
                1.0,
            );
            title.addAttribute_value_range(
                NSForegroundColorAttributeName,
                &green,
                NSRange::new(2, 1),
            );
        }
    }
    title
}

#[tauri::command]
fn open_window(app: tauri::AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window("main") {
        window.unminimize().map_err(|error| error.to_string())?;
        window.show().map_err(|error| error.to_string())?;
        window.set_focus().map_err(|error| error.to_string())?;
    }
    Ok(())
}

#[tauri::command]
fn quit_app(app: tauri::AppHandle) {
    app.exit(0);
}

#[tauri::command]
fn read_hosts() -> Result<HostsState, String> {
    let contents = fs::read_to_string(HOSTS_PATH)
        .map_err(|error| format!("Could not read {HOSTS_PATH}: {error}"))?;
    let modified_at = fs::metadata(HOSTS_PATH)
        .ok()
        .and_then(|metadata| metadata.modified().ok())
        .and_then(system_time_millis);

    Ok(HostsState {
        contents,
        path: HOSTS_PATH.to_string(),
        modified_at,
    })
}

#[tauri::command(async)]
fn write_hosts(
    contents: String,
    expected_contents: Option<String>,
) -> Result<PrivilegedResult, String> {
    if contents.trim().is_empty() {
        return Err("Refusing to write an empty hosts file.".to_string());
    }

    ensure_hosts_unchanged(expected_contents.as_deref())?;

    let timestamp = timestamp_token()?;
    let temp_path = write_temp_hosts(&contents, &timestamp)?;
    let backup_path = format!("{HOSTS_PATH}.hostdeck.{timestamp}.bak");
    let backup_exists_message = format!("Backup already exists: {backup_path}");
    let script = format!(
        "set -e; if test -e {backup}; then echo {backup_exists_message} >&2; exit 1; fi; cp {hosts} {backup}; cp {temp} {hosts}; chown root:wheel {hosts}; chmod 644 {hosts}; dscacheutil -flushcache; killall -HUP mDNSResponder",
        hosts = shell_quote(HOSTS_PATH),
        backup = shell_quote(&backup_path),
        backup_exists_message = shell_quote(&backup_exists_message),
        temp = shell_quote(&temp_path.to_string_lossy()),
    );

    let result = run_privileged_shell(&script);
    let _ = fs::remove_file(&temp_path);
    result.map(|_| PrivilegedResult { backup_path })
}

#[tauri::command]
fn backup_hosts() -> Result<PrivilegedResult, String> {
    let timestamp = timestamp_token()?;
    let backup_path = format!("{HOSTS_PATH}.hostdeck.{timestamp}.bak");
    let backup_exists_message = format!("Backup already exists: {backup_path}");
    let script = format!(
        "set -e; if test -e {backup}; then echo {backup_exists_message} >&2; exit 1; fi; cp {hosts} {backup}; chown root:wheel {backup}; chmod 644 {backup}",
        hosts = shell_quote(HOSTS_PATH),
        backup = shell_quote(&backup_path),
        backup_exists_message = shell_quote(&backup_exists_message),
    );

    run_privileged_shell(&script).map(|_| PrivilegedResult { backup_path })
}

#[tauri::command]
fn flush_dns() -> Result<(), String> {
    run_shell("dscacheutil", &["-flushcache"])?;
    run_shell("killall", &["-HUP", "mDNSResponder"])
}

fn main() {
    tauri::Builder::default()
        .setup(|app| {
            TrayIconBuilder::with_id("hostdeck")
                .title("~ $")
                .tooltip("Hostdeck")
                .menu(&Menu::new(app)?)
                .on_menu_event(|app, event| {
                    let result = match event.id.as_ref() {
                        "open" => open_window(app.clone()),
                        "quit" => app.emit("tray-quit", ()).map_err(|error| error.to_string()),
                        id => {
                            if let Some(id) = id.strip_prefix("favorite:") {
                                app.emit("tray-toggle", id)
                                    .map_err(|error| error.to_string())
                            } else {
                                Ok(())
                            }
                        }
                    };
                    if let Err(error) = result {
                        eprintln!("{error}");
                    }
                })
                .build(app)?;
            update_tray(app.handle().clone(), vec![], false, true)?;
            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                if window.hide().is_ok() {
                    api.prevent_close();
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            backup_hosts,
            flush_dns,
            read_hosts,
            write_hosts,
            update_tray,
            open_window,
            quit_app
        ])
        .build(tauri::generate_context!())
        .expect("error while building Hostdeck")
        .run(|app, event| match event {
            tauri::RunEvent::ExitRequested {
                code: None, api, ..
            } => {
                api.prevent_exit();
                let _ = app.emit("tray-quit", ());
            }
            tauri::RunEvent::Reopen { .. } => {
                let _ = open_window(app.clone());
            }
            _ => {}
        });
}

fn write_temp_hosts(contents: &str, timestamp: &str) -> Result<PathBuf, String> {
    for attempt in 0..32 {
        let path = std::env::temp_dir().join(format!(
            "hostdeck-hosts-{}-{timestamp}-{attempt}.tmp",
            std::process::id()
        ));
        let file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(&path);

        let mut file = match file {
            Ok(file) => file,
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(format!("Could not write temporary hosts file: {error}")),
        };

        if let Err(error) = file.write_all(contents.as_bytes()) {
            let _ = fs::remove_file(&path);
            return Err(format!("Could not write temporary hosts file: {error}"));
        }

        return Ok(path);
    }

    Err("Could not create a unique temporary hosts file.".to_string())
}

fn ensure_hosts_unchanged(expected_contents: Option<&str>) -> Result<(), String> {
    ensure_file_contents_unchanged(HOSTS_PATH, expected_contents)
}

fn ensure_file_contents_unchanged(
    path: &str,
    expected_contents: Option<&str>,
) -> Result<(), String> {
    let Some(expected) = expected_contents else {
        return Ok(());
    };

    let current = fs::read_to_string(path)
        .map_err(|error| format!("Could not read {path} before writing: {error}"))?;

    if current == expected {
        return Ok(());
    }

    Err(format!(
        "Refusing to overwrite {path} because it changed since it was loaded. Reload /etc/hosts and try again."
    ))
}

fn run_privileged_shell(script: &str) -> Result<(), String> {
    let expression = format!(
        "do shell script {} with administrator privileges",
        applescript_string(script)
    );
    run_shell("osascript", &["-e", &expression])
}

fn run_shell(program: &str, args: &[&str]) -> Result<(), String> {
    let output = Command::new(program)
        .args(args)
        .output()
        .map_err(|error| format!("Could not run {program}: {error}"))?;

    if output.status.success() {
        return Ok(());
    }

    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    let details = if stderr.is_empty() { stdout } else { stderr };

    Err(if details.is_empty() {
        format!("{program} exited with {}", output.status)
    } else {
        details
    })
}

fn shell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

fn applescript_string(value: &str) -> String {
    format!("\"{}\"", value.replace('\\', "\\\\").replace('"', "\\\""))
}

fn timestamp_token() -> Result<String, String> {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_nanos().to_string())
        .map_err(|error| format!("System clock error: {error}"))
}

fn system_time_millis(value: SystemTime) -> Option<u64> {
    value
        .duration_since(UNIX_EPOCH)
        .ok()
        .and_then(|duration| u64::try_from(duration.as_millis()).ok())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tilde_keeps_native_tint_and_only_an_active_dollar_turns_green() {
        let active = tray_label(true);
        let inactive = tray_label(false);
        assert_eq!(active.string().to_string(), "~ $");
        for title in [&active, &inactive] {
            let foreground = unsafe {
                title.attribute_atIndex_effectiveRange(
                    NSForegroundColorAttributeName,
                    0,
                    std::ptr::null_mut(),
                )
            }
            .unwrap();
            assert_eq!(
                foreground.downcast_ref::<NSColor>().unwrap(),
                NSColor::labelColor().as_ref()
            );
        }
        let foreground = unsafe {
            inactive.attribute_atIndex_effectiveRange(
                NSForegroundColorAttributeName,
                2,
                std::ptr::null_mut(),
            )
        }
        .unwrap();
        assert_eq!(
            foreground.downcast_ref::<NSColor>().unwrap(),
            NSColor::labelColor().as_ref()
        );
        let green = unsafe {
            active.attribute_atIndex_effectiveRange(
                NSForegroundColorAttributeName,
                2,
                std::ptr::null_mut(),
            )
        }
        .unwrap();
        let green = green.downcast_ref::<NSColor>().unwrap();
        assert!((green.greenComponent() - 224.0 / 255.0).abs() < 0.0001);
        assert!((green.redComponent() - 63.0 / 255.0).abs() < 0.0001);
        assert!((green.blueComponent() - 123.0 / 255.0).abs() < 0.0001);
    }

    #[test]
    fn quotes_shell_values() {
        assert_eq!(shell_quote("/tmp/host deck"), "'/tmp/host deck'");
        assert_eq!(shell_quote("a'b"), "'a'\\''b'");
    }

    #[test]
    fn quotes_applescript_values() {
        assert_eq!(applescript_string("say \"hi\""), "\"say \\\"hi\\\"\"");
        assert_eq!(applescript_string("a\\b"), "\"a\\\\b\"");
    }

    #[test]
    fn creates_unique_temp_hosts_file() {
        let timestamp = timestamp_token().unwrap();
        let first = write_temp_hosts("127.0.0.1 localhost\n", &timestamp).unwrap();
        let second = write_temp_hosts("127.0.0.1 localhost\n", &timestamp).unwrap();

        assert_ne!(first, second);
        assert_eq!(fs::read_to_string(&first).unwrap(), "127.0.0.1 localhost\n");

        let _ = fs::remove_file(first);
        let _ = fs::remove_file(second);
    }

    #[test]
    fn accepts_unchanged_expected_hosts_contents() {
        let path = test_temp_path("unchanged");
        fs::write(&path, "127.0.0.1 localhost\n").unwrap();

        let result =
            ensure_file_contents_unchanged(path.to_str().unwrap(), Some("127.0.0.1 localhost\n"));

        let _ = fs::remove_file(path);
        assert!(result.is_ok());
    }

    #[test]
    fn rejects_changed_expected_hosts_contents() {
        let path = test_temp_path("changed");
        fs::write(&path, "127.0.0.1 localhost\n").unwrap();

        let result =
            ensure_file_contents_unchanged(path.to_str().unwrap(), Some("127.0.0.1 stale.local\n"));

        let _ = fs::remove_file(path);
        assert!(result.is_err());
    }

    fn test_temp_path(name: &str) -> PathBuf {
        std::env::temp_dir().join(format!(
            "hostdeck-test-{name}-{}-{}",
            std::process::id(),
            timestamp_token().unwrap()
        ))
    }
}
