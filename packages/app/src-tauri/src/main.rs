#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

//! Floe desktop shell.
//!
//! Deliberately thin: it starts `floe ui` (the same localhost server the web
//! shell uses) as a child process and points a webview at it. All agent logic,
//! event streaming and control flow stay in the Node engine behind the one
//! runner protocol, so the two shells can never drift apart.

use std::net::TcpStream;
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::thread::sleep;
use std::time::{Duration, Instant};

use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};

struct Sidecar(Mutex<Option<Child>>);

fn port() -> u16 {
    std::env::var("FLOE_UI_PORT")
        .ok()
        .and_then(|p| p.parse().ok())
        .unwrap_or(4321)
}

/// Path to the built CLI entrypoint: FLOE_CLI wins, else the workspace layout.
fn cli_entry() -> PathBuf {
    if let Ok(p) = std::env::var("FLOE_CLI") {
        return PathBuf::from(p);
    }
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../cli/dist/main.js")
        .canonicalize()
        .unwrap_or_else(|_| PathBuf::from("floe"))
}

/// A GUI app inherits launchd's bare PATH (`/usr/bin:/bin:…`), which almost never
/// contains the user's node. Look in the usual places, then ask a login shell.
fn node_bin() -> String {
    if let Ok(p) = std::env::var("FLOE_NODE") {
        return p;
    }
    let home = std::env::var("HOME").unwrap_or_default();
    let candidates = [
        format!("{home}/.local/bin/node"),
        "/opt/homebrew/bin/node".into(),
        "/usr/local/bin/node".into(),
        "/usr/bin/node".into(),
    ];
    for c in candidates {
        if PathBuf::from(&c).exists() {
            return c;
        }
    }
    if let Ok(out) = Command::new("/bin/bash").arg("-lc").arg("command -v node").output() {
        let path = String::from_utf8_lossy(&out.stdout).trim().to_string();
        if !path.is_empty() {
            return path;
        }
    }
    "node".into()
}

fn listening(port: u16) -> bool {
    TcpStream::connect(("127.0.0.1", port)).is_ok()
}

fn main() {
    let port = port();
    tauri::Builder::default()
        .manage(Sidecar(Mutex::new(None)))
        .setup(move |app| {
            // Reuse an already-running `floe ui` (e.g. started from a terminal).
            if !listening(port) {
                let child = Command::new(node_bin())
                    .arg(cli_entry())
                    .arg("ui")
                    .arg("--no-open")
                    .arg("--port")
                    .arg(port.to_string())
                    .stdout(Stdio::inherit())
                    .stderr(Stdio::inherit())
                    .spawn()
                    .map_err(|e| format!("could not start `floe ui`: {e}"))?;
                *app.state::<Sidecar>().0.lock().unwrap() = Some(child);

                let deadline = Instant::now() + Duration::from_secs(20);
                while !listening(port) && Instant::now() < deadline {
                    sleep(Duration::from_millis(120));
                }
            }

            let url = format!("http://127.0.0.1:{port}/");
            WebviewWindowBuilder::new(app, "main", WebviewUrl::External(url.parse().unwrap()))
                .title("Floe")
                .inner_size(1280.0, 860.0)
                .min_inner_size(920.0, 600.0)
                .build()?;
            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::Destroyed = event {
                if let Some(child) = window.state::<Sidecar>().0.lock().unwrap().as_mut() {
                    let _ = child.kill();
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("floe app failed to start");
}
