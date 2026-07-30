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
    server: Mutex<Option<CommandChild>>,
    menu_state: Mutex<Option<MenuState>>,
    items: TrayItems,
}

#[derive(Clone, Copy, PartialEq)]
struct MenuState {
    running: bool,
    owned: bool,
}

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

fn start_server(app: &AppHandle) -> Result<(), String> {
    if server_status().is_some() {
        return Ok(());
    }

    let state = app.state::<AppState>();
    if let Some(child) = state
        .server
        .lock()
        .map_err(|_| "No se pudo bloquear el estado del servidor.")?
        .take()
    {
        let _ = child.kill();
    }

    let data_dir = app
        .path()
        .app_data_dir()
        .map_err(|error| error.to_string())?
        .join("data");
    fs::create_dir_all(&data_dir).map_err(|error| error.to_string())?;

    let command = app
        .shell()
        .sidecar("unilink-server")
        .map_err(|error| error.to_string())?
        .env("UNILINK_DATA_DIR", data_dir)
        .env("UNILINK_PORT", configured_port().to_string());
    let (mut events, child) = command.spawn().map_err(|error| error.to_string())?;
    let child_pid = child.pid();

    *state
        .server
        .lock()
        .map_err(|_| "No se pudo guardar el proceso del servidor.")? = Some(child);

    let event_app = app.clone();
    tauri::async_runtime::spawn(async move {
        while let Some(event) = events.recv().await {
            if matches!(event, CommandEvent::Terminated(_)) {
                if let Some(state) = event_app.try_state::<AppState>() {
                    if let Ok(mut server) = state.server.lock() {
                        if server.as_ref().map(CommandChild::pid) == Some(child_pid) {
                            server.take();
                        }
                    }
                }
                schedule_menu_refresh(&event_app);
                break;
            }
        }
    });
    Ok(())
}

fn stop_server(app: &AppHandle) {
    let Some(state) = app.try_state::<AppState>() else {
        return;
    };
    let child = state
        .server
        .lock()
        .ok()
        .and_then(|mut server| server.take());
    if let Some(child) = child {
        let _ = child.kill();
    }
}

fn probe_menu_state(app: &AppHandle) -> Option<MenuState> {
    let Some(state) = app.try_state::<AppState>() else {
        return None;
    };
    Some(MenuState {
        running: server_status().is_some(),
        owned: state
            .server
            .lock()
            .map(|server| server.is_some())
            .unwrap_or(false),
    })
}

fn apply_menu_state(app: &AppHandle, next: MenuState) {
    let Some(state) = app.try_state::<AppState>() else {
        return;
    };
    if let Ok(mut current) = state.menu_state.lock() {
        if current.as_ref() == Some(&next) {
            return;
        }
        *current = Some(next);
    }

    let _ = state.items.status.set_text(if next.running {
        "Servidor activo"
    } else {
        "Servidor detenido"
    });
    let _ = state.items.configure.set_enabled(next.running);
    let _ = state.items.install.set_enabled(next.running);
    let _ = state.items.watch.set_enabled(next.running);
    let _ = state.items.copy_watch.set_enabled(next.running);
    let _ = state.items.start.set_enabled(!next.running);
    let _ = state.items.stop.set_enabled(next.running && next.owned);
    let _ = state.items.restart.set_enabled(next.owned);
}

fn schedule_menu_refresh(app: &AppHandle) {
    let handle = app.clone();
    thread::spawn(move || {
        let Some(next) = probe_menu_state(&handle) else {
            return;
        };
        let refresh_handle = handle.clone();
        let _ = handle.run_on_main_thread(move || apply_menu_state(&refresh_handle, next));
    });
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
        MENU_START => {
            let handle = app.clone();
            thread::spawn(move || {
                if let Err(error) = start_server(&handle) {
                    eprintln!("No se pudo iniciar Unilink: {error}");
                }
                schedule_menu_refresh(&handle);
            });
        }
        MENU_STOP => {
            stop_server(app);
            schedule_menu_refresh(app);
        }
        MENU_RESTART => {
            let handle = app.clone();
            thread::spawn(move || {
                stop_server(&handle);
                thread::sleep(Duration::from_millis(250));
                if let Err(error) = start_server(&handle) {
                    eprintln!("No se pudo reiniciar Unilink: {error}");
                }
                schedule_menu_refresh(&handle);
            });
        }
        MENU_QUIT => {
            app.exit(0);
        }
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
        server: Mutex::new(None),
        menu_state: Mutex::new(None),
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

    start_server(app.handle()).map_err(|error| -> Box<dyn std::error::Error> { error.into() })?;
    schedule_menu_refresh(app.handle());
    open_onboarding_when_ready(app.handle().clone());

    let handle = app.handle().clone();
    thread::spawn(move || loop {
        thread::sleep(Duration::from_secs(3));
        let Some(next) = probe_menu_state(&handle) else {
            break;
        };
        let refresh_handle = handle.clone();
        if handle
            .run_on_main_thread(move || apply_menu_state(&refresh_handle, next))
            .is_err()
        {
            break;
        }
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
        if matches!(event, RunEvent::Exit) {
            stop_server(app);
        }
    });
}

#[cfg(test)]
mod tests {
    use super::needs_onboarding;
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
