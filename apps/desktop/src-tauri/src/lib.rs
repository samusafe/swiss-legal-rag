// Writes `contents` to `path` exactly as given — no parent-directory creation,
// no path rewriting. `path` comes from the frontend's native save dialog
// (@tauri-apps/plugin-dialog's `save()`), which is the user's consent to
// write there; this command intentionally has no broader filesystem
// permission scope of its own (see capabilities/default.json).
#[tauri::command]
fn write_export(path: String, contents: String) -> Result<(), String> {
    std::fs::write(&path, contents).map_err(|error| format!("failed to write {path}: {error}"))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_sql::Builder::default().build())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![write_export])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
