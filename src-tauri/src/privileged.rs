use serde::{Deserialize, Serialize};
use std::{
    ffi::{c_char, CStr, CString},
    fs::{self, OpenOptions},
    io::{Read, Write},
    net::IpAddr,
    os::unix::fs::{MetadataExt, OpenOptionsExt},
    path::Path,
    process::Command,
    time::{SystemTime, UNIX_EPOCH},
};

const HOSTS_PATH: &str = "/etc/hosts";
// shortcut: hosts files are capped at 256 KiB; raise this with the XPC request limit for larger files.
const MAX_HOSTS_BYTES: usize = 256 * 1024;

unsafe extern "C" {
    fn hostdeck_helper_status() -> *mut c_char;
    fn hostdeck_enable_helper() -> *mut c_char;
    fn hostdeck_helper_request(request: *const c_char) -> *mut c_char;
    fn hostdeck_run_helper() -> i32;
}

#[derive(Deserialize, Serialize)]
#[serde(tag = "action", rename_all = "snake_case", deny_unknown_fields)]
enum Request {
    Write {
        contents: String,
        expected_contents: String,
    },
    Backup {},
    Flush {},
}

#[derive(Default, Deserialize, Serialize)]
pub struct Response {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub backup_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

fn take_native_string(value: *mut c_char) -> Result<String, String> {
    if value.is_null() {
        return Err("The Hostdeck helper returned no response.".into());
    }
    let result = unsafe { CStr::from_ptr(value) }
        .to_str()
        .map(str::to_owned)
        .map_err(|_| "The Hostdeck helper returned invalid text.".into());
    unsafe {
        libc::free(value.cast());
    }
    result
}

pub fn status() -> Result<String, String> {
    take_native_string(unsafe { hostdeck_helper_status() })
}

pub fn enable() -> Result<String, String> {
    decode_response(&take_native_string(unsafe { hostdeck_enable_helper() })?)?;
    status()
}

fn decode_response(source: &str) -> Result<Response, String> {
    let response: Response = serde_json::from_str(source)
        .map_err(|error| format!("Invalid helper response: {error}"))?;
    if let Some(error) = response.error {
        return Err(error);
    }
    Ok(response)
}

fn send(request: Request) -> Result<Response, String> {
    let json = CString::new(serde_json::to_string(&request).map_err(|error| error.to_string())?)
        .map_err(|_| "Invalid helper request.".to_string())?;
    decode_response(&take_native_string(unsafe {
        hostdeck_helper_request(json.as_ptr())
    })?)
}

pub fn write(contents: String, expected_contents: String) -> Result<Response, String> {
    send(Request::Write {
        contents,
        expected_contents,
    })
}

pub fn backup() -> Result<Response, String> {
    send(Request::Backup {})
}
pub fn flush() -> Result<(), String> {
    send(Request::Flush {}).map(|_| ())
}

pub fn run() -> ! {
    std::process::exit(unsafe { hostdeck_run_helper() });
}

#[no_mangle]
pub unsafe extern "C" fn hostdeck_handle_request(source: *const c_char) -> *mut c_char {
    let result = std::panic::catch_unwind(|| {
        if source.is_null() {
            return Err("Missing helper request.".to_string());
        }
        let source = unsafe { CStr::from_ptr(source) }
            .to_str()
            .map_err(|_| "Invalid request encoding.".to_string())?;
        let request: Request = serde_json::from_str(source)
            .map_err(|error| format!("Invalid helper request: {error}"))?;
        let metadata = fs::symlink_metadata(HOSTS_PATH).map_err(|error| error.to_string())?;
        if !metadata.is_file() || metadata.uid() != 0 || metadata.mode() & 0o022 != 0 {
            return Err("Refusing to access an unsafe /etc/hosts file.".into());
        }
        match request {
            Request::Write {
                contents,
                expected_contents,
            } => {
                let backup_path = write_file(Path::new(HOSTS_PATH), &contents, &expected_contents)?;
                flush_system_dns()?;
                Ok(Response {
                    backup_path: Some(backup_path),
                    error: None,
                })
            }
            Request::Backup {} => Ok(Response {
                backup_path: Some(backup_file(Path::new(HOSTS_PATH))?),
                error: None,
            }),
            Request::Flush {} => flush_system_dns().map(|_| Response::default()),
        }
    })
    .unwrap_or_else(|_| Err("Hostdeck helper operation failed.".to_string()));
    let response = result.unwrap_or_else(|error| Response {
        error: Some(error),
        ..Response::default()
    });
    CString::new(serde_json::to_string(&response).unwrap())
        .unwrap()
        .into_raw()
}

#[no_mangle]
pub unsafe extern "C" fn hostdeck_free_response(source: *mut c_char) {
    if !source.is_null() {
        drop(unsafe { CString::from_raw(source) });
    }
}

fn read_file(path: &Path) -> Result<String, String> {
    let file = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW)
        .open(path)
        .map_err(|error| format!("Could not read {}: {error}", path.display()))?;
    let mut contents = String::new();
    file.take((MAX_HOSTS_BYTES + 1) as u64)
        .read_to_string(&mut contents)
        .map_err(|error| format!("Could not read {}: {error}", path.display()))?;
    if contents.len() > MAX_HOSTS_BYTES {
        return Err("Hosts file exceeds the 256 KiB limit.".into());
    }
    Ok(contents)
}

fn protected_lines(contents: &str) -> Vec<&str> {
    contents
        .lines()
        .filter(|line| {
            let body = line
                .trim()
                .trim_start_matches('#')
                .trim()
                .split('#')
                .next()
                .unwrap_or("");
            let mut parts = body.split_whitespace();
            if !parts.next().is_some_and(|ip| ip.parse::<IpAddr>().is_ok()) {
                return false;
            }
            parts.any(|host| {
                let host = host.to_ascii_lowercase();
                host == "localhost" || host == "broadcasthost" || host.ends_with(".localhost")
            })
        })
        .collect()
}

fn valid_hostname(host: &str) -> bool {
    !host.is_empty()
        && host.len() <= 253
        && host.split('.').all(|label| {
            !label.is_empty()
                && label.len() <= 63
                && !label.starts_with('-')
                && !label.ends_with('-')
                && label
                    .bytes()
                    .all(|ch| ch.is_ascii_alphanumeric() || ch == b'-')
        })
}

fn validate_contents(contents: &str, original: &str) -> Result<(), String> {
    if contents.trim().is_empty() || contents.len() > MAX_HOSTS_BYTES || contents.contains('\0') {
        return Err("Refusing empty, oversized, or invalid hosts contents.".into());
    }
    if protected_lines(contents) != protected_lines(original) {
        return Err("Refusing to change protected system hosts.".into());
    }
    let original_lines: std::collections::HashSet<_> = original.lines().collect();
    for line in contents.lines() {
        // Preserve unmanaged syntax verbatim while validating every changed row.
        if original_lines.contains(line) {
            continue;
        }
        let line = line.split('#').next().unwrap_or("").trim();
        if line.is_empty() {
            continue;
        }
        let mut parts = line.split_whitespace();
        if parts
            .next()
            .and_then(|ip| ip.parse::<IpAddr>().ok())
            .is_none()
        {
            return Err("Invalid IP address in hosts contents.".into());
        }
        let hosts: Vec<_> = parts.collect();
        if hosts.is_empty() || hosts.iter().any(|host| !valid_hostname(host)) {
            return Err("Invalid hostname in hosts contents.".into());
        }
    }
    Ok(())
}

fn unique_file(path: &Path, suffix: &str, contents: &str) -> Result<String, String> {
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|error| error.to_string())?
        .as_nanos();
    let target = format!("{}.hostdeck.{timestamp}.{suffix}", path.display());
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o644)
        .custom_flags(libc::O_NOFOLLOW)
        .open(&target)
        .map_err(|error| format!("Could not create {target}: {error}"))?;
    if let Err(error) = file
        .write_all(contents.as_bytes())
        .and_then(|_| file.sync_all())
    {
        let _ = fs::remove_file(&target);
        return Err(format!("Could not write {target}: {error}"));
    }
    Ok(target)
}

fn backup_file(path: &Path) -> Result<String, String> {
    unique_file(path, "bak", &read_file(path)?)
}

fn write_file(path: &Path, contents: &str, expected: &str) -> Result<String, String> {
    let original = read_file(path)?;
    if original != expected {
        return Err("Refusing to overwrite /etc/hosts because it changed since it was loaded. Reload /etc/hosts and try again.".into());
    }
    validate_contents(contents, &original)?;
    let backup = unique_file(path, "bak", &original)?;
    let temporary = unique_file(path, "tmp", contents)?;
    let result = (|| {
        if read_file(path)? != original {
            return Err(
                "The hosts file changed since it was loaded. Reload /etc/hosts and try again."
                    .into(),
            );
        }
        fs::rename(&temporary, path)
            .map_err(|error| format!("Could not replace hosts file: {error}"))?;
        fs::File::open(path.parent().unwrap())
            .and_then(|directory| directory.sync_all())
            .map_err(|error| format!("Could not sync hosts directory: {error}"))?;
        Ok(backup)
    })();
    let _ = fs::remove_file(temporary);
    result
}

fn flush_system_dns() -> Result<(), String> {
    for (program, args) in [
        ("/usr/bin/dscacheutil", vec!["-flushcache"]),
        ("/usr/bin/killall", vec!["-HUP", "mDNSResponder"]),
    ] {
        let output = Command::new(program)
            .args(args)
            .env_clear()
            .output()
            .map_err(|error| error.to_string())?;
        if !output.status.success() {
            return Err(format!(
                "DNS flush failed: {}",
                String::from_utf8_lossy(&output.stderr).trim()
            ));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    const ORIGINAL: &str = "127.0.0.1 localhost\n::1 localhost\n255.255.255.255 broadcasthost\n";

    #[test]
    fn rejects_arbitrary_actions_paths_and_missing_expected_contents() {
        for source in [
            r#"{"action":"exec","command":"id"}"#,
            r#"{"action":"backup","path":"/etc/passwd"}"#,
            r#"{"action":"write","contents":"hello"}"#,
        ] {
            assert!(serde_json::from_str::<Request>(source).is_err());
        }
    }

    #[test]
    fn callback_rejects_malformed_and_missing_requests() {
        for source in [
            CString::new("not json").unwrap(),
            CString::new(vec![0xff]).unwrap(),
            CString::new(r#"{"action":"flush","command":"id"}"#).unwrap(),
        ] {
            let response = unsafe { hostdeck_handle_request(source.as_ptr()) };
            assert!(
                decode_response(unsafe { CStr::from_ptr(response) }.to_str().unwrap()).is_err()
            );
            unsafe {
                hostdeck_free_response(response);
            }
        }
        let response = unsafe { hostdeck_handle_request(std::ptr::null()) };
        assert!(decode_response(unsafe { CStr::from_ptr(response) }.to_str().unwrap()).is_err());
        unsafe {
            hostdeck_free_response(response);
        }
    }

    #[test]
    fn preserves_unchanged_unmanaged_syntax_but_rejects_new_invalid_rows() {
        let original = format!("{ORIGINAL}127.0.0.1 legacy_host.local\n");
        assert!(validate_contents(&format!("{original}127.0.0.1 app.local\n"), &original).is_ok());
        assert!(validate_contents(
            &format!("{original}127.0.0.1 new_invalid.local\n"),
            &original
        )
        .is_err());
    }

    #[test]
    fn validates_ip_hostnames_and_protected_primary_and_alias_hosts() {
        assert!(validate_contents(&format!("{ORIGINAL}127.0.0.1 app.local\n"), ORIGINAL).is_ok());
        assert!(validate_contents(&format!("{ORIGINAL}# 127.0.0.1 app.local\n"), ORIGINAL).is_ok());
        for contents in [
            "",
            "127.0.0.1 evil.local\n",
            "# 127.0.0.1 localhost\n",
            "127.0.0.1 other.local localhost\n",
        ] {
            assert!(validate_contents(contents, ORIGINAL).is_err());
        }
        for line in [
            "999.0.0.1 app.local",
            "127.0.0.1 -bad.local",
            "127.0.0.1 app.local\0",
            "::1 app..local",
        ] {
            assert!(validate_contents(&format!("{ORIGINAL}{line}\n"), ORIGINAL).is_err());
        }
        assert!(validate_contents(&"#".repeat(MAX_HOSTS_BYTES + 1), ORIGINAL).is_err());
    }

    #[test]
    fn writes_atomically_backs_up_and_rejects_stale_or_unsafe_files() {
        let dir = std::env::temp_dir().join(format!(
            "hostdeck-helper-test-{}",
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir(&dir).unwrap();
        let path = dir.join("hosts");
        fs::write(&path, ORIGINAL).unwrap();
        assert!(write_file(&path, "bad", "stale").is_err());
        assert_eq!(fs::read_dir(&dir).unwrap().count(), 1);
        let contents = format!("{ORIGINAL}127.0.0.1 app.local\n");
        let backup = write_file(&path, &contents, ORIGINAL).unwrap();
        assert_eq!(fs::read_to_string(&backup).unwrap(), ORIGINAL);
        assert_eq!(fs::read_to_string(&path).unwrap(), contents);
        assert_eq!(fs::metadata(&path).unwrap().mode() & 0o777, 0o644);
        assert!(!fs::read_dir(&dir).unwrap().any(|entry| entry
            .unwrap()
            .path()
            .extension()
            .is_some_and(|value| value == "tmp")));
        if unsafe { libc::geteuid() } != 0 {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&dir, fs::Permissions::from_mode(0o555)).unwrap();
            let result = write_file(&path, ORIGINAL, &contents);
            fs::set_permissions(&dir, fs::Permissions::from_mode(0o755)).unwrap();
            assert!(result.unwrap_err().contains("Could not create"));
            assert_eq!(fs::read_to_string(&path).unwrap(), contents);
        }
        let link = dir.join("link");
        std::os::unix::fs::symlink(&path, &link).unwrap();
        assert!(backup_file(&link).is_err());
        let blocked = dir.join("blocked");
        fs::create_dir(&blocked).unwrap();
        assert!(unique_file(&blocked.join("missing/hosts"), "bak", ORIGINAL).is_err());
        assert_eq!(fs::read_to_string(&path).unwrap(), contents);
        fs::remove_dir_all(dir).unwrap();
    }
}
