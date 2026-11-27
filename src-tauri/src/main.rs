// Hide the console window on Windows release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use tauri::{Emitter, Manager};
use tauri_plugin_window_state::StateFlags;

/// File paths in a command line (a double-clicked .psd, "Open with"), without the program and flags.
fn files_in(args: impl IntoIterator<Item = String>) -> Vec<String> {
    args.into_iter().skip(1).filter(|a| !a.starts_with('-')).collect()
}

/// The files PhotoPane was started with; the page asks once it is ready.
#[tauri::command]
fn startup_files() -> Vec<String> {
    files_in(std::env::args())
}

/// Windows: PhotoPane as the program for .psd files of this user (Help → Open PSD files in PhotoPane).
#[tauri::command]
fn associate_psd() -> Result<(), String> {
    #[cfg(windows)]
    {
        use winreg::{enums::HKEY_CURRENT_USER, RegKey};
        let err = |e: std::io::Error| e.to_string();
        let exe = std::env::current_exe().map_err(err)?.to_string_lossy().to_string();
        let hkcu = RegKey::predef(HKEY_CURRENT_USER);
        let (prog, _) = hkcu.create_subkey("Software\\Classes\\PhotoPane.psd").map_err(err)?;
        prog.set_value("", &"Photoshop document").map_err(err)?;
        let (icon, _) = hkcu.create_subkey("Software\\Classes\\PhotoPane.psd\\DefaultIcon").map_err(err)?;
        icon.set_value("", &format!("\"{}\",0", exe)).map_err(err)?;
        let (cmd, _) = hkcu.create_subkey("Software\\Classes\\PhotoPane.psd\\shell\\open\\command").map_err(err)?;
        cmd.set_value("", &format!("\"{}\" \"%1\"", exe)).map_err(err)?;
        let (ext, _) = hkcu.create_subkey("Software\\Classes\\.psd").map_err(err)?;
        ext.set_value("", &"PhotoPane.psd").map_err(err)?;
        let (with, _) = hkcu.create_subkey("Software\\Classes\\.psd\\OpenWithProgids").map_err(err)?;
        with.set_value("PhotoPane.psd", &"").map_err(err)?;
        Ok(())
    }
    #[cfg(not(windows))]
    {
        Err("only on Windows".into())
    }
}

fn main() {
    tauri::Builder::default()
        // a second launch (a file opened from Explorer while PhotoPane runs) brings this window forward and
        // opens the file here
        .plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.unminimize();
                let _ = w.set_focus();
            }
            let files = files_in(args);
            if !files.is_empty() {
                let _ = app.emit("open-files", files);
            }
        }))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_http::init())
        // the window opens where and as large as it was closed (also maximized). It starts hidden (tauri.conf.json)
        // and is put in place while hidden; the page shows it once its first frame is drawn. Shown at once, it
        // came up white at the default size, then moved, then maximized.
        .plugin(
            tauri_plugin_window_state::Builder::default()
                .with_state_flags(StateFlags::SIZE | StateFlags::POSITION | StateFlags::MAXIMIZED | StateFlags::FULLSCREEN)
                .build(),
        )
        .setup(|app| {
            // should the page never show the window (a script that failed), it is shown anyway
            if let Some(w) = app.get_webview_window("main") {
                std::thread::spawn(move || {
                    std::thread::sleep(std::time::Duration::from_secs(4));
                    if !w.is_visible().unwrap_or(true) {
                        let _ = w.show();
                        let _ = w.set_focus();
                    }
                });
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![startup_files, associate_psd])
        .build(tauri::generate_context!())
        .expect("error while building PhotoPane")
        .run(|_app, _event| {
            // macOS: files opened from Finder arrive as an event
            #[cfg(target_os = "macos")]
            if let tauri::RunEvent::Opened { urls } = _event {
                let files: Vec<String> = urls
                    .iter()
                    .filter_map(|u| u.to_file_path().ok())
                    .map(|p| p.to_string_lossy().to_string())
                    .collect();
                if !files.is_empty() {
                    let _ = _app.emit("open-files", files);
                }
            }
        });
}
