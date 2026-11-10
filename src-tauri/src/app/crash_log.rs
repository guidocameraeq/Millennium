//! Gancho de pánico: deja el detalle de un crash en crash.log antes de que muera la app.
//!
//! Movido tal cual desde `lib.rs` (encargo 04 de puesta-a-punto): solo cambian los `use` y la visibilidad.

pub(crate) fn install_panic_hook() {
    // Resolve %APPDATA%/com.guidocameraeq.millennium/ manually so this
    // hook is installable BEFORE Tauri exists and gives us app.path().
    let data_dir = std::env::var_os("APPDATA")
        .map(|p| std::path::PathBuf::from(p).join("com.guidocameraeq.millennium"));

    let original_hook = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        // Let the default handler run too (writes to stderr if attached).
        original_hook(info);

        let payload = info
            .payload()
            .downcast_ref::<&str>()
            .map(|s| s.to_string())
            .or_else(|| info.payload().downcast_ref::<String>().cloned())
            .unwrap_or_else(|| "unknown panic payload".to_string());
        let loc = info
            .location()
            .map(|l| format!("{}:{}:{}", l.file(), l.line(), l.column()))
            .unwrap_or_else(|| "unknown location".to_string());
        let when = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0);
        let backtrace = std::backtrace::Backtrace::force_capture();
        let entry = format!(
            "=== panic @ {when} (millennium v{}) ===\nlocation: {loc}\nmessage:  {payload}\nbacktrace:\n{backtrace}\n\n",
            env!("CARGO_PKG_VERSION"),
        );
        if let Some(dir) = &data_dir {
            let _ = std::fs::create_dir_all(dir);
            let path = dir.join("crash.log");
            use std::io::Write;
            if let Ok(mut f) = std::fs::OpenOptions::new()
                .create(true)
                .append(true)
                .open(&path)
            {
                let _ = f.write_all(entry.as_bytes());
            }
        }
    }));
}
