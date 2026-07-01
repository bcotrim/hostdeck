use serde::Serialize;
use std::{
    fs::{self, OpenOptions},
    io::Write,
    os::unix::fs::OpenOptionsExt,
    path::PathBuf,
    process::Command,
    time::{SystemTime, UNIX_EPOCH},
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

#[tauri::command]
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
        .invoke_handler(tauri::generate_handler![
            backup_hosts,
            flush_dns,
            read_hosts,
            write_hosts
        ])
        .run(tauri::generate_context!())
        .expect("error while running Hostdeck");
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
