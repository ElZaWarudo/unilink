use std::{
    fs,
    io::{Read, Write},
    net::{Ipv4Addr, SocketAddrV4, TcpStream},
    path::Path,
    sync::Mutex,
    thread,
    time::Duration,
};

use serde_json::Value;
use tauri::{
    menu::{Menu, MenuItem, PredefinedMenuItem},
    tray::TrayIconBuilder,
    AppHandle, Manager, RunEvent, Wry,
};
use tauri_plugin_shell::{
    process::{CommandChild, CommandEvent},
    ShellExt,
};

const MENU_CONFIGURE: &str = "configure";
const MENU_INSTALL: &str = "install";
const MENU_WATCH: &str = "watch";
const MENU_COPY_WATCH: &str = "copy-watch";
const MENU_START: &str = "start";
const MENU_STOP: &str = "stop";
const MENU_RESTART: &str = "restart";
const MENU_QUIT: &str = "quit";

struct TrayItems {
    status: MenuItem<Wry>,
    configure: MenuItem<Wry>,
    install: MenuItem<Wry>,
    watch: MenuItem<Wry>,
    copy_watch: MenuItem<Wry>,
    start: MenuItem<Wry>,
    stop: MenuItem<Wry>,
    restart: MenuItem<Wry>,
}

struct AppState {
    lifecycle: Mutex<Lifecycle>,
    items: TrayItems,
}

#[derive(Clone, Copy, Debug, PartialEq)]
enum Phase {
    Starting,
    Running,
    Stopping,
    Stopped,
    Failed(&'static str),
}

struct Lifecycle {
    child: Option<CommandChild>,
    generation: u64,
    revision: u64,
    exited_generation: Option<u64>,
    phase: Phase,
    pending: bool,
    quitting: bool,
    exit_ready: bool,
}

#[derive(Clone, Copy)]
enum Operation {
    Start,
    Stop,
    Restart,
    Quit,
}

impl Lifecycle {
    fn begin(&mut self, operation: Operation) -> bool {
        if matches!(operation, Operation::Quit) {
            self.quitting = true;
        }
        if self.pending {
            return false;
        }
        if self.quitting && !matches!(operation, Operation::Quit) {
            return false;
        }
        // An external server is never stopped or restarted by this application.
        if matches!(operation, Operation::Stop | Operation::Restart) && self.child.is_none() {
            return false;
        }
        self.revision += 1;
        self.pending = true;
        self.phase = if matches!(operation, Operation::Stop | Operation::Quit) {
            Phase::Stopping
        } else {
            Phase::Starting
        };
        true
    }

    fn terminated(&mut self, generation: u64) {
        if self.generation == generation {
            self.revision += 1;
            self.exited_generation = Some(generation);
            if self.child.take().is_some() {
                self.phase = Phase::Failed("Servidor cerrado; pulse Iniciar para reintentar");
            }
        }
    }

    fn complete(&mut self, operation: Operation, result: Result<(), &'static str>) -> bool {
        self.phase = match result {
            Ok(()) if matches!(operation, Operation::Start | Operation::Restart) => {
                if matches!(self.phase, Phase::Failed(_)) {
                    self.phase
                } else {
                    Phase::Running
                }
            }
            Ok(()) => Phase::Stopped,
            Err(reason) => Phase::Failed(reason),
        };
        // Keep pending claimed until quit cleanup finishes.
        if !self.quitting {
            self.pending = false;
        }
        self.quitting
    }

    fn complete_quit(&mut self, cleanup: Result<(), &'static str>) -> bool {
        self.pending = false;
        match cleanup {
            Err(reason) => {
                self.quitting = false;
                self.phase = Phase::Failed(reason);
                false
            }
            Ok(()) => {
                self.exit_ready = true;
                true
            }
        }
    }
}

const START_FAILURE: &str = "No inicia; reintente o reinstale Unilink";
const PORT_FAILURE: &str = "Puerto ocupado; cierre la otra aplicación y reintente";
const STOP_FAILURE: &str = "No se pudo detener; reintente Detener";

fn configured_port() -> u16 {
    std::env::var("UNILINK_PORT")
        .ok()
        .and_then(|value| value.parse().ok())
        .filter(|port| *port > 0)
        .unwrap_or(17891)
}

fn local_base_url() -> String {
    format!("http://127.0.0.1:{}", configured_port())
}

fn read_http_json(path: &str) -> Option<Value> {
    let address = SocketAddrV4::new(Ipv4Addr::LOCALHOST, configured_port());
    let mut stream =
        TcpStream::connect_timeout(&address.into(), Duration::from_millis(500)).ok()?;
    stream.set_read_timeout(Some(Duration::from_secs(1))).ok()?;
    stream
        .set_write_timeout(Some(Duration::from_secs(1)))
        .ok()?;
    write!(
        stream,
        "GET {path} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n"
    )
    .ok()?;

    let mut response = String::new();
    stream.read_to_string(&mut response).ok()?;
    let (headers, body) = response.split_once("\r\n\r\n")?;
    if !headers.starts_with("HTTP/1.1 200") {
        return None;
    }
    serde_json::from_str(body).ok()
}

fn server_status() -> Option<Value> {
    let status = read_http_json("/api/status")?;
    status
        .get("serverInstanceId")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())?;
    Some(status)
}

fn watch_url() -> String {
    server_status()
        .and_then(|status| {
            status
                .get("watchUrl")
                .and_then(Value::as_str)
                .map(str::to_owned)
        })
        .unwrap_or_else(|| format!("{}/watch", local_base_url()))
}

fn open_url(url: impl AsRef<str>) {
    if let Err(error) = open::that(url.as_ref()) {
        eprintln!("No se pudo abrir {}: {error}", url.as_ref());
    }
}

// Called only by the single lifecycle worker. Menu callbacks never wait for I/O.
fn start_server(app: &AppHandle) -> Result<(), &'static str> {
    let state = app.state::<AppState>();
    if server_status().is_some() {
        return Ok(());
    }
    stop_server(app)?;
    let address = SocketAddrV4::new(Ipv4Addr::LOCALHOST, configured_port());
    if TcpStream::connect_timeout(&address.into(), Duration::from_millis(500)).is_ok() {
        return Err(PORT_FAILURE);
    }
    let data_dir = app
        .path()
        .app_data_dir()
        .map_err(|_| "Carpeta de datos inaccesible; revise permisos")?
        .join("data");
    fs::create_dir_all(&data_dir).map_err(|_| "Carpeta de datos inaccesible; revise permisos")?;
    let command = app
        .shell()
        .sidecar("unilink-server")
        .map_err(|_| "Falta el servidor; reinstale Unilink")?
        .env("UNILINK_DATA_DIR", data_dir)
        .env("UNILINK_PORT", configured_port().to_string());
    let (mut events, child) = command
        .spawn()
        .map_err(|_| "Servidor ausente o bloqueado; revise la instalación")?;
    let generation = {
        let mut lifecycle = state.lifecycle.lock().unwrap();
        lifecycle.generation += 1;
        lifecycle.exited_generation = None;
        lifecycle.child = Some(child);
        lifecycle.generation
    };
    let event_app = app.clone();
    tauri::async_runtime::spawn(async move {
        while let Some(event) = events.recv().await {
            if matches!(event, CommandEvent::Terminated(_)) {
                if let Some(state) = event_app.try_state::<AppState>() {
                    state.lifecycle.lock().unwrap().terminated(generation);
                }
                schedule_menu_refresh(&event_app);
                break;
            }
        }
    });
    for _ in 0..30 {
        {
            let lifecycle = state.lifecycle.lock().unwrap();
            if lifecycle.quitting {
                return Err(START_FAILURE);
            }
            if lifecycle.child.is_none() {
                return Err(START_FAILURE);
            }
        }
        if server_status().is_some() {
            return Ok(());
        }
        thread::sleep(Duration::from_millis(300));
    }
    stop_server(app)?;
    Err(START_FAILURE)
}

fn kill_owned_tree(child: CommandChild) -> Result<(), (CommandChild, &'static str)> {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // PID comes exclusively from our spawned sidecar; no port-owner lookup.
        let result = std::process::Command::new("taskkill.exe")
            .args(["/PID", &child.pid().to_string(), "/T", "/F"])
            .creation_flags(0x08000000)
            .output();
        if result
            .map(|result| result.status.success())
            .unwrap_or(false)
        {
            Ok(())
        } else {
            Err((child, STOP_FAILURE))
        }
    }
    #[cfg(not(windows))]
    {
        // The shell plugin has no process-group API. Linux descendant cleanup
        // remains a release verification gap; only the owned sidecar is killed.
        let result = std::process::Command::new("kill")
            .args(["-TERM", &child.pid().to_string()])
            .output();
        if result
            .map(|result| result.status.success())
            .unwrap_or(false)
        {
            Ok(())
        } else {
            Err((child, STOP_FAILURE))
        }
    }
}

fn stop_server(app: &AppHandle) -> Result<(), &'static str> {
    let state = app.state::<AppState>();
    let child = state.lifecycle.lock().unwrap().child.take();
    if let Some(child) = child {
        if let Err((child, reason)) = kill_owned_tree(child) {
            let mut lifecycle = state.lifecycle.lock().unwrap();
            // The process may have exited while taskkill was running. Its event
            // still records termination after intentional ownership removal.
            if lifecycle.exited_generation != Some(lifecycle.generation) {
                lifecycle.child = Some(child);
                return Err(reason);
            }
        }
    }
    Ok(())
}

fn request_operation(app: &AppHandle, operation: Operation) {
    if !app
        .state::<AppState>()
        .lifecycle
        .lock()
        .unwrap()
        .begin(operation)
    {
        return;
    }
    schedule_menu_refresh(app);
    let handle = app.clone();
    thread::spawn(move || {
        let result = match operation {
            Operation::Start => start_server(&handle),
            Operation::Stop | Operation::Quit => stop_server(&handle),
            Operation::Restart => stop_server(&handle).and_then(|_| start_server(&handle)),
        };
        let state = handle.state::<AppState>();
        let quitting = {
            let mut lifecycle = state.lifecycle.lock().unwrap();
            lifecycle.complete(operation, result)
        };
        if quitting {
            let cleanup = stop_server(&handle);
            let mut lifecycle = state.lifecycle.lock().unwrap();
            if lifecycle.complete_quit(cleanup) {
                drop(lifecycle);
                handle.exit(0);
                return;
            }
        }
        schedule_menu_refresh(&handle);
    });
}

fn apply_menu_state(app: &AppHandle) {
    let state = app.state::<AppState>();
    let (phase, pending, owned) = {
        let lifecycle = state.lifecycle.lock().unwrap();
        (
            lifecycle.phase,
            lifecycle.pending,
            lifecycle.child.is_some(),
        )
    };
    let running = phase == Phase::Running && !pending;
    let text = match phase {
        Phase::Starting => "Iniciando servidor…",
        Phase::Running => {
            if owned {
                "Servidor activo"
            } else {
                "Servidor activo en otra instancia"
            }
        }
        Phase::Stopping => "Deteniendo servidor…",
        Phase::Stopped => "Servidor detenido",
        Phase::Failed(reason) => reason,
    };
    let _ = state.items.status.set_text(text);
    let _ = state.items.configure.set_enabled(running);
    let _ = state.items.install.set_enabled(running);
    let _ = state.items.watch.set_enabled(running);
    let _ = state.items.copy_watch.set_enabled(running);
    let _ = state
        .items
        .start
        .set_enabled(!pending && !running && !owned);
    let _ = state.items.stop.set_enabled(!pending && owned);
    let _ = state.items.restart.set_enabled(!pending && owned);
}

fn schedule_menu_refresh(app: &AppHandle) {
    let handle = app.clone();
    // Read state on the UI thread, so queued refreshes cannot restore stale state.
    let _ = app.run_on_main_thread(move || apply_menu_state(&handle));
}

fn needs_onboarding(config_path: &Path) -> bool {
    fs::read_to_string(config_path)
        .ok()
        .and_then(|content| serde_json::from_str::<Value>(&content).ok())
        .and_then(|config| {
            config
                .get("torrentioManifestUrl")
                .and_then(Value::as_str)
                .map(|value| !value.trim().is_empty())
        })
        != Some(true)
}

fn open_onboarding_when_ready(app: AppHandle) {
    let config_path = match app.path().app_data_dir() {
        Ok(path) => path.join("data").join("config.json"),
        Err(_) => return,
    };
    if !needs_onboarding(&config_path) {
        return;
    }

    thread::spawn(move || {
        for _ in 0..20 {
            if server_status().is_some() {
                open_url(format!("{}/configure", local_base_url()));
                return;
            }
            thread::sleep(Duration::from_millis(500));
        }
    });
}

fn handle_menu_event(app: &AppHandle, id: &str) {
    match id {
        MENU_CONFIGURE => open_url(format!("{}/configure", local_base_url())),
        MENU_INSTALL => open_url(format!(
            "stremio://127.0.0.1:{}/manifest.json",
            configured_port()
        )),
        MENU_WATCH => open_url(watch_url()),
        MENU_COPY_WATCH => {
            if let Ok(mut clipboard) = arboard::Clipboard::new() {
                let _ = clipboard.set_text(watch_url());
            }
        }
        MENU_START => request_operation(app, Operation::Start),
        MENU_STOP => request_operation(app, Operation::Stop),
        MENU_RESTART => request_operation(app, Operation::Restart),
        MENU_QUIT => request_operation(app, Operation::Quit),
        _ => {}
    }
}

fn setup_tray(app: &mut tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    let status = MenuItem::with_id(app, "status", "Iniciando...", false, None::<&str>)?;
    let configure = MenuItem::with_id(
        app,
        MENU_CONFIGURE,
        "Configurar addon...",
        true,
        None::<&str>,
    )?;
    let install = MenuItem::with_id(
        app,
        MENU_INSTALL,
        "Instalar addon en Stremio",
        true,
        None::<&str>,
    )?;
    let watch = MenuItem::with_id(
        app,
        MENU_WATCH,
        "Abrir segunda pantalla",
        true,
        None::<&str>,
    )?;
    let copy_watch = MenuItem::with_id(
        app,
        MENU_COPY_WATCH,
        "Copiar enlace de segunda pantalla",
        true,
        None::<&str>,
    )?;
    let start = MenuItem::with_id(app, MENU_START, "Iniciar servidor", false, None::<&str>)?;
    let stop = MenuItem::with_id(app, MENU_STOP, "Detener servidor", true, None::<&str>)?;
    let restart = MenuItem::with_id(app, MENU_RESTART, "Reiniciar servidor", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, MENU_QUIT, "Salir de Unilink", true, None::<&str>)?;

    let first_separator = PredefinedMenuItem::separator(app)?;
    let second_separator = PredefinedMenuItem::separator(app)?;
    let third_separator = PredefinedMenuItem::separator(app)?;
    let menu = Menu::with_items(
        app,
        &[
            &status,
            &first_separator,
            &configure,
            &install,
            &watch,
            &copy_watch,
            &second_separator,
            &start,
            &stop,
            &restart,
            &third_separator,
            &quit,
        ],
    )?;

    app.manage(AppState {
        lifecycle: Mutex::new(Lifecycle {
            child: None,
            generation: 0,
            revision: 0,
            exited_generation: None,
            phase: Phase::Stopped,
            pending: false,
            quitting: false,
            exit_ready: false,
        }),
        items: TrayItems {
            status,
            configure,
            install,
            watch,
            copy_watch,
            start,
            stop,
            restart,
        },
    });

    let icon = app
        .default_window_icon()
        .cloned()
        .ok_or("No se encontró el icono de Unilink.")?;
    TrayIconBuilder::with_id("unilink")
        .icon(icon)
        .tooltip("Unilink")
        .menu(&menu)
        .show_menu_on_left_click(true)
        .on_menu_event(|app, event| handle_menu_event(app, event.id().as_ref()))
        .build(app)?;

    request_operation(app.handle(), Operation::Start);
    schedule_menu_refresh(app.handle());
    open_onboarding_when_ready(app.handle().clone());

    let handle = app.handle().clone();
    thread::spawn(move || loop {
        thread::sleep(Duration::from_secs(3));
        let state = handle.state::<AppState>();
        let revision = {
            let lifecycle = state.lifecycle.lock().unwrap();
            if lifecycle.exit_ready {
                break;
            }
            if lifecycle.pending {
                continue;
            }
            lifecycle.revision
        };
        let running = server_status().is_some();
        {
            let mut lifecycle = state.lifecycle.lock().unwrap();
            if lifecycle.pending || lifecycle.revision != revision {
                continue;
            }
            if running {
                lifecycle.phase = Phase::Running;
            } else if lifecycle.phase == Phase::Running {
                lifecycle.phase = if lifecycle.child.is_some() {
                    Phase::Failed("Servidor no responde; pulse Reiniciar")
                } else {
                    Phase::Stopped
                };
            }
        }
        schedule_menu_refresh(&handle);
    });
    Ok(())
}

pub fn run() {
    let application = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _, _| {
            open_url(format!("{}/configure", local_base_url()));
            schedule_menu_refresh(app);
        }))
        .plugin(tauri_plugin_shell::init())
        .setup(setup_tray)
        .build(tauri::generate_context!())
        .expect("No se pudo iniciar Unilink");

    application.run(|app, event| {
        if let RunEvent::ExitRequested { api, .. } = event {
            if !app.state::<AppState>().lifecycle.lock().unwrap().exit_ready {
                api.prevent_exit();
                request_operation(app, Operation::Quit);
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::{needs_onboarding, Lifecycle, Operation, Phase};

    fn stopped() -> Lifecycle {
        Lifecycle {
            child: None,
            generation: 3,
            revision: 0,
            exited_generation: None,
            phase: Phase::Stopped,
            pending: false,
            quitting: false,
            exit_ready: false,
        }
    }

    #[test]
    fn pending_operations_are_serialized_and_quit_is_retained() {
        let mut state = stopped();
        assert!(state.begin(Operation::Start));
        assert_eq!(state.phase, Phase::Starting);
        assert!(!state.begin(Operation::Start));
        assert!(!state.begin(Operation::Restart));
        assert!(!state.begin(Operation::Quit));
        assert!(state.quitting);
        assert!(state.pending);
    }

    #[test]
    fn external_server_cannot_be_stopped_or_restarted() {
        let mut state = stopped();
        state.phase = Phase::Running;
        assert!(!state.begin(Operation::Stop));
        assert!(!state.begin(Operation::Restart));
        assert_eq!(state.phase, Phase::Running);
    }

    #[test]
    fn intentional_stop_and_stale_termination_do_not_report_failure() {
        let mut state = stopped();
        state.terminated(3); // stop removes ownership before killing
        assert_eq!(state.phase, Phase::Stopped);
        state.phase = Phase::Starting;
        state.terminated(2); // a previous generation cannot change this start
        assert_eq!(state.phase, Phase::Starting);
    }

    #[test]
    fn failure_can_retry_but_quit_blocks_new_work() {
        let mut state = stopped();
        state.phase = Phase::Failed("retry");
        assert!(state.begin(Operation::Start));
        state.pending = false;
        assert!(state.begin(Operation::Quit));
        state.pending = false;
        assert!(!state.begin(Operation::Start));
    }

    #[test]
    fn quit_during_start_waits_for_cleanup_before_exit() {
        let mut state = stopped();
        assert!(state.begin(Operation::Start));
        assert!(!state.begin(Operation::Quit));
        assert!(state.complete(Operation::Start, Ok(())));
        assert!(state.pending);
        assert!(!state.exit_ready);
        assert!(state.complete_quit(Ok(())));
        assert!(state.exit_ready);
        assert!(!state.pending);
    }

    #[test]
    fn failed_quit_cleanup_allows_retry_without_authorizing_exit() {
        let mut state = stopped();
        assert!(state.begin(Operation::Quit));
        assert!(state.complete(Operation::Quit, Err("stop failed")));
        assert!(!state.complete_quit(Err("cleanup failed")));
        assert!(!state.exit_ready);
        assert!(!state.pending);
        assert!(!state.quitting);
        assert_eq!(state.phase, Phase::Failed("cleanup failed"));
        assert!(state.begin(Operation::Quit));
        assert!(state.complete(Operation::Quit, Ok(())));
        assert!(state.complete_quit(Ok(())));
    }

    #[test]
    fn completion_preserves_start_failure_and_ignores_stale_termination() {
        let mut state = stopped();
        assert!(state.begin(Operation::Start));
        state.phase = Phase::Failed("exited during startup");
        assert!(!state.complete(Operation::Start, Ok(())));
        assert_eq!(state.phase, Phase::Failed("exited during startup"));
        assert!(!state.pending);
        assert!(state.begin(Operation::Start));
        state.terminated(2);
        assert!(!state.complete(Operation::Start, Ok(())));
        assert_eq!(state.phase, Phase::Running);
    }

    use std::{fs, path::PathBuf};

    fn temporary_path(name: &str) -> PathBuf {
        std::env::temp_dir().join(format!("unilink-{name}-{}", std::process::id()))
    }

    #[test]
    fn onboarding_is_needed_until_torrentio_is_configured() {
        let path = temporary_path("missing-config.json");
        let _ = fs::remove_file(&path);
        assert!(needs_onboarding(&path));

        fs::write(&path, r#"{"torrentioManifestUrl":""}"#).unwrap();
        assert!(needs_onboarding(&path));

        fs::write(
            &path,
            r#"{"torrentioManifestUrl":"https://example.com/manifest.json"}"#,
        )
        .unwrap();
        assert!(!needs_onboarding(&path));
        fs::remove_file(path).unwrap();
    }
}
