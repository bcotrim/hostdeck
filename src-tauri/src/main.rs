mod privileged;

use block2::RcBlock;
use objc2::{rc::Retained, runtime::Bool, MainThreadMarker};
use objc2_app_kit::{NSBezierPath, NSColor, NSImage, NSLineCapStyle};
use objc2_foundation::{NSPoint, NSRect, NSSize};
use serde::{Deserialize, Serialize};
use std::{
    fs,
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
        let helper_ready = privileged::status().is_ok_and(|status| status == "enabled");
        let status = if busy {
            "Working…".to_string()
        } else if !helper_ready {
            "Enable the helper in Hostdeck to toggle".to_string()
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
                helper_ready && !dirty && !busy,
                entry.enabled,
                None::<&str>,
            )?)?;
        }
        menu.append(&PredefinedMenuItem::separator(&app)?)?;
        if !helper_ready {
            menu.append(&MenuItem::with_id(
                &app,
                "helper-setup",
                "Set up helper…",
                !busy,
                None::<&str>,
            )?)?;
        }
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
            button.setImage(Some(&tray_image(active > 0)));
        })?;
        tray.set_tooltip(Some(format!("Hostdeck — {status}")))?;
        Ok(())
    };
    update().map_err(|error| format!("Could not update menu bar: {error}"))
}

fn tray_image(active: bool) -> Retained<NSImage> {
    let drawing = RcBlock::new(move |_: NSRect| {
        let color = if active {
            NSColor::colorWithSRGBRed_green_blue_alpha(
                63.0 / 255.0,
                224.0 / 255.0,
                123.0 / 255.0,
                1.0,
            )
        } else {
            NSColor::blackColor()
        };
        color.setStroke();
        let path = NSBezierPath::bezierPath();
        path.setLineWidth(2.5);
        path.setLineCapStyle(NSLineCapStyle::Round);
        for (start, end) in [
            ((3.0, 8.0), (8.5, 13.5)),
            ((5.0, 5.0), (13.0, 13.0)),
            ((9.5, 4.5), (15.0, 10.0)),
        ] {
            path.moveToPoint(NSPoint::new(start.0, start.1));
            path.lineToPoint(NSPoint::new(end.0, end.1));
        }
        path.stroke();
        Bool::YES
    });
    let image =
        NSImage::imageWithSize_flipped_drawingHandler(NSSize::new(18.0, 18.0), false, &drawing);
    image.setTemplate(!active);
    image
}

#[tauri::command]
fn open_window(app: tauri::AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window("main") {
        app.set_activation_policy(tauri::ActivationPolicy::Regular)
            .map_err(|error| error.to_string())?;
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
    expected_contents: String,
) -> Result<privileged::Response, String> {
    privileged::write(contents, expected_contents)
}

#[tauri::command(async)]
fn backup_hosts() -> Result<privileged::Response, String> {
    privileged::backup()
}

#[tauri::command(async)]
fn flush_dns() -> Result<(), String> {
    privileged::flush()
}

#[tauri::command]
fn helper_status() -> Result<String, String> {
    privileged::status()
}

#[tauri::command(async)]
fn enable_helper() -> Result<String, String> {
    privileged::enable()
}

fn main() {
    if std::env::args().any(|arg| arg == "--privileged-helper") {
        privileged::run();
    }
    tauri::Builder::default()
        .setup(|app| {
            TrayIconBuilder::with_id("hostdeck")
                .tooltip("Hostdeck")
                .menu(&Menu::new(app)?)
                .on_menu_event(|app, event| {
                    let result = match event.id.as_ref() {
                        "open" => open_window(app.clone()),
                        "helper-setup" => open_window(app.clone()).and_then(|_| {
                            app.emit("helper-setup", ())
                                .map_err(|error| error.to_string())
                        }),
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
                    if let Err(error) = window
                        .app_handle()
                        .set_activation_policy(tauri::ActivationPolicy::Accessory)
                    {
                        eprintln!("Could not hide Hostdeck from the Dock: {error}");
                    }
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            helper_status,
            enable_helper,
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
    fn tray_logo_is_native_monochrome_when_inactive_and_green_when_active() {
        use objc2_app_kit::{NSBitmapImageRep, NSColorSpace};

        for active in [false, true] {
            let image = tray_image(active);
            assert_eq!(image.size(), NSSize::new(18.0, 18.0));
            assert_eq!(image.isTemplate(), !active);
            let bitmap =
                NSBitmapImageRep::imageRepWithData(&image.TIFFRepresentation().unwrap()).unwrap();
            let color = bitmap
                .colorAtX_y(8, 9)
                .unwrap()
                .colorUsingColorSpace(&NSColorSpace::sRGBColorSpace())
                .unwrap();
            let expected = if active {
                [63.0, 224.0, 123.0]
            } else {
                [0.0; 3]
            };
            for (actual, expected) in [
                color.redComponent(),
                color.greenComponent(),
                color.blueComponent(),
            ]
            .into_iter()
            .zip(expected)
            {
                // AppKit color-manages rasterized images.
                assert!(
                    (actual - expected / 255.0).abs() < 0.1,
                    "active={active}: expected {}, got {actual}",
                    expected / 255.0
                );
            }
            assert!(color.alphaComponent() > 0.9);
            assert_eq!(bitmap.colorAtX_y(0, 0).unwrap().alphaComponent(), 0.0);
        }
    }
}
