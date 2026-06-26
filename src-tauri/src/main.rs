use serde::Serialize;
use std::{
    fs,
    os::unix::fs::PermissionsExt,
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
    let contents = fs::read_to_string(HOSTS_PATH).map_err(|error| {
        format!("Could not read {HOSTS_PATH}: {error}")
    })?;
    let modified_at = fs::metadata(HOSTS_PATH)
        .ok()
        .and_then(|metadata| metadata.modified().ok())
        .and_then(system_time_secs);

    Ok(HostsState {
        contents,
        path: HOSTS_PATH.to_string(),
        modified_at,
    })
}

#[tauri::command]
fn write_hosts(contents: String) -> Result<PrivilegedResult, String> {
    if contents.trim().is_empty() {
        return Err("Refusing to write an empty hosts file.".to_string());
    }

    let timestamp = now_secs()?;
    let temp_path = write_temp_hosts(&contents, timestamp)?;
    let backup_path = format!("{HOSTS_PATH}.hostdeck.{timestamp}.bak");
    let script = format!(
        "set -e; cp {hosts} {backup}; cp {temp} {hosts}; chown root:wheel {hosts}; chmod 644 {hosts}; dscacheutil -flushcache; killall -HUP mDNSResponder",
        hosts = shell_quote(HOSTS_PATH),
        backup = shell_quote(&backup_path),
        temp = shell_quote(&temp_path.to_string_lossy()),
    );

    let result = run_privileged_shell(&script);
    let _ = fs::remove_file(&temp_path);
    result.map(|_| PrivilegedResult { backup_path })
}

#[tauri::command]
fn backup_hosts() -> Result<PrivilegedResult, String> {
    let timestamp = now_secs()?;
    let backup_path = format!("{HOSTS_PATH}.hostdeck.{timestamp}.bak");
    let script = format!(
        "set -e; cp {hosts} {backup}; chown root:wheel {backup}; chmod 644 {backup}",
        hosts = shell_quote(HOSTS_PATH),
        backup = shell_quote(&backup_path),
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

fn write_temp_hosts(contents: &str, timestamp: u64) -> Result<PathBuf, String> {
    let path = std::env::temp_dir().join(format!(
        "hostdeck-hosts-{}-{timestamp}.tmp",
        std::process::id()
    ));
    fs::write(&path, contents).map_err(|error| {
        format!("Could not write temporary hosts file: {error}")
    })?;
    fs::set_permissions(&path, fs::Permissions::from_mode(0o644)).map_err(|error| {
        format!("Could not set temporary hosts file permissions: {error}")
    })?;
    Ok(path)
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

fn now_secs() -> Result<u64, String> {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .map_err(|error| format!("System clock error: {error}"))
}

fn system_time_secs(value: SystemTime) -> Option<u64> {
    value.duration_since(UNIX_EPOCH).ok().map(|duration| duration.as_secs())
}
