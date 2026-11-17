//! Distribution locale de mises à jour signées Tauri v2.
//! HTTP sur le LAN : les binaires ne sont pas confidentiels, mais l'Updater
//! vérifie leur signature avant installation. Ne pas exposer à Internet.

use std::{
    fs::{self, File},
    io::{Read, Write},
    net::{TcpListener, TcpStream},
    path::{Path, PathBuf},
    sync::{atomic::{AtomicBool, Ordering}, Arc, Mutex},
    thread,
    time::Duration,
};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, State};
use tauri_plugin_updater::UpdaterExt;

use crate::backend::{self, Backend};

#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Config {
    server_enabled: bool,
    server_port: u16,
    remote_host: String,
    remote_port: u16,
}

#[derive(Clone, Serialize, Deserialize)]
struct Release {
    version: String,
    notes: String,
    signature: String,
    filename: String,
}

struct Server {
    stop: Arc<AtomicBool>,
    thread: thread::JoinHandle<()>,
}

struct Runtime {
    config: Config,
    server: Option<Server>,
}

pub struct UpdateService {
    directory: PathBuf,
    runtime: Mutex<Runtime>,
    installing: AtomicBool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateStatus {
    server_enabled: bool,
    server_port: u16,
    remote_host: String,
    remote_port: u16,
    published_version: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AvailableUpdate {
    version: String,
    notes: String,
}

fn get_net(state: State<'_, Backend>) -> Result<(String, String, u16), String> {
    // NetStatus conserve ses champs privés dans backend.rs. Le sérialiser évite
    // de modifier le fonctionnement du réseau de demandes existant.
    let status = backend::network_status(state)?;
    let data = serde_json::to_value(status).map_err(|e| e.to_string())?;
    let mode = data["mode"].as_str().unwrap_or("offline").to_owned();
    let address = data["address"].as_str().unwrap_or("").to_owned();
    let port = data["port"].as_u64().unwrap_or(39427) as u16;
    Ok((mode, address, port))
}

impl UpdateService {
    pub fn new(directory: PathBuf) -> Result<Self, String> {
        fs::create_dir_all(&directory).map_err(|e| e.to_string())?;
        let path = directory.join("settings.json");
        let config = fs::read(&path)
            .ok()
            .and_then(|s| serde_json::from_slice::<Config>(&s).ok())
            .unwrap_or_default();
        Ok(Self {
            directory,
            runtime: Mutex::new(Runtime { config, server: None }),
            installing: AtomicBool::new(false),
        })
    }

    fn save(&self, config: &Config) -> Result<(), String> {
        let bytes = serde_json::to_vec_pretty(config).map_err(|e| e.to_string())?;
        fs::write(self.directory.join("settings.json"), bytes).map_err(|e| e.to_string())
    }

    pub fn bootstrap(&self) -> Result<(), String> {
        let mut runtime = self.runtime.lock().map_err(|_| "Mises à jour indisponibles")?;
        if runtime.config.server_enabled {
            let port = runtime.config.server_port;
            start_server(&mut runtime, port, &self.directory)?;
        }
        Ok(())
    }

    fn endpoint(&self) -> Result<String, String> {
        let runtime = self.runtime.lock().map_err(|_| "Mises à jour indisponibles")?;
        let (host, port) = if runtime.config.server_enabled {
            ("127.0.0.1".to_string(), runtime.config.server_port)
        } else {
            (runtime.config.remote_host.clone(), runtime.config.remote_port)
        };
        if host.is_empty() || port < 1024 {
            return Err("Configure d'abord le réseau local dans Pixel Office.".into());
        }
        Ok(format!(
            "http://{host}:{port}/v1/update/{{{{target}}}}/{{{{arch}}}}/{{{{current_version}}}}"
        ))
    }
}

fn start_server(runtime: &mut Runtime, port: u16, dir: &Path) -> Result<(), String> {
    if runtime.server.is_some() { return Ok(()); }
    if port < 1024 { return Err("Port des mises à jour invalide".into()); }
    let listener = TcpListener::bind(("0.0.0.0", port))
        .map_err(|e| format!("Port HTTP {port} indisponible : {e}"))?;
    listener.set_nonblocking(true).map_err(|e| e.to_string())?;
    let stop = Arc::new(AtomicBool::new(false));
    let stopping = Arc::clone(&stop);
    let dir = dir.to_path_buf();
    let thread = thread::spawn(move || {
        while !stopping.load(Ordering::SeqCst) {
            match listener.accept() {
                Ok((stream, _)) => {
                    let dir = dir.clone();
                    thread::spawn(move || {
                        if let Err(e) = serve(stream, &dir, port) {
                            eprintln!("Serveur de mise à jour : {e}");
                        }
                    });
                }
                Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                    thread::sleep(Duration::from_millis(120));
                }
                Err(_) => thread::sleep(Duration::from_millis(250)),
            }
        }
    });
    runtime.server = Some(Server { stop, thread });
    Ok(())
}

fn stop_server(runtime: &mut Runtime) {
    if let Some(server) = runtime.server.take() {
        server.stop.store(true, Ordering::SeqCst);
        let _ = server.thread.join();
    }
}

fn response(stream: &mut TcpStream, status: &str, content_type: &str, body: &[u8]) -> std::io::Result<()> {
    write!(stream, "HTTP/1.1 {status}\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n", body.len())?;
    stream.write_all(body)
}

fn load_release(dir: &Path) -> Option<Release> {
    let bytes = fs::read(dir.join("latest.json")).ok()?;
    serde_json::from_slice::<Release>(&bytes).ok()
}

fn serve(mut stream: TcpStream, dir: &Path, port: u16) -> Result<(), String> {
    stream.set_read_timeout(Some(Duration::from_secs(5))).map_err(|e| e.to_string())?;
    stream.set_write_timeout(Some(Duration::from_secs(90))).map_err(|e| e.to_string())?;
    let mut buffer = [0u8; 8192];
    let len = stream.read(&mut buffer).map_err(|e| e.to_string())?;
    let line = String::from_utf8_lossy(&buffer[..len]);
    let mut words = line.lines().next().unwrap_or("").split_whitespace();
    let method = words.next().unwrap_or("");
    let path = words.next().unwrap_or("");
    if method != "GET" {
        response(&mut stream, "405 Method Not Allowed", "text/plain", b"GET only").map_err(|e| e.to_string())?;
        return Ok(());
    }
    let Some(release) = load_release(dir) else {
        response(&mut stream, "204 No Content", "text/plain", &[]).map_err(|e| e.to_string())?;
        return Ok(());
    };

    if let Some(current) = path.strip_prefix("/v1/update/windows/x86_64/") {
        let newer = match (semver::Version::parse(&release.version), semver::Version::parse(current)) {
            (Ok(latest), Ok(installed)) => latest > installed,
            _ => false,
        };
        if !newer {
            response(&mut stream, "204 No Content", "text/plain", &[]).map_err(|e| e.to_string())?;
            return Ok(());
        }
        let address = stream.local_addr().map_err(|e| e.to_string())?.ip();
        let body = serde_json::json!({
            "version": release.version,
            "notes": release.notes,
            "signature": release.signature,
            "url": format!("http://{address}:{port}/v1/download/{}", release.filename)
        });
        let json = serde_json::to_vec(&body).map_err(|e| e.to_string())?;
        response(&mut stream, "200 OK", "application/json", &json).map_err(|e| e.to_string())?;
        return Ok(());
    }

    if path == format!("/v1/download/{}", release.filename) {
        let file_path = dir.join("releases").join(&release.filename);
        let mut file = File::open(file_path).map_err(|e| e.to_string())?;
        let len = file.metadata().map_err(|e| e.to_string())?.len();
        write!(stream, "HTTP/1.1 200 OK\r\nContent-Type: application/octet-stream\r\nContent-Length: {len}\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n").map_err(|e| e.to_string())?;
        std::io::copy(&mut file, &mut stream).map_err(|e| e.to_string())?;
        return Ok(());
    }

    response(&mut stream, "404 Not Found", "text/plain", b"Not found").map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn updates_sync_server(
    updates: State<'_, UpdateService>,
    backend: State<'_, Backend>,
) -> Result<UpdateStatus, String> {
    let (mode, address, port) = get_net(backend)?;
    let mut runtime = updates.runtime.lock().map_err(|_| "Mises à jour indisponibles")?;
    if mode == "host" {
        let update_port = port.checked_add(1).ok_or("Port TCP trop élevé pour le serveur de mises à jour")?;
        if runtime.config.server_port != update_port { stop_server(&mut runtime); }
        start_server(&mut runtime, update_port, &updates.directory)?;
        runtime.config.server_enabled = true;
        runtime.config.server_port = update_port;
    } else if mode == "client" {
        stop_server(&mut runtime);
        runtime.config.server_enabled = false;
        let (host, _) = address.rsplit_once(':').ok_or("Adresse réseau incorrecte")?;
        runtime.config.remote_host = host.to_string();
        runtime.config.remote_port = port.checked_add(1).ok_or("Port de mise à jour invalide")?;
    } else if runtime.config.server_enabled {
        // Le serveur de mises à jour reste actif après redémarrage du PC hôte,
        // même avant la reconnexion au relais de demandes.
        let saved_port = runtime.config.server_port;
        start_server(&mut runtime, saved_port, &updates.directory)?;
    }
    updates.save(&runtime.config)?;
    Ok(status_locked(&runtime, &updates.directory))
}

fn status_locked(runtime: &Runtime, dir: &Path) -> UpdateStatus {
    UpdateStatus {
        server_enabled: runtime.config.server_enabled,
        server_port: runtime.config.server_port,
        remote_host: runtime.config.remote_host.clone(),
        remote_port: runtime.config.remote_port,
        published_version: load_release(dir).map(|r| r.version),
    }
}

#[tauri::command]
pub fn updates_status(updates: State<'_, UpdateService>) -> Result<UpdateStatus, String> {
    let runtime = updates.runtime.lock().map_err(|_| "Mises à jour indisponibles")?;
    Ok(status_locked(&runtime, &updates.directory))
}

#[tauri::command]
pub fn updates_publish(
    updates: State<'_, UpdateService>,
    installer_path: String,
    version: String,
    notes: String,
) -> Result<String, String> {
    {
        let runtime = updates.runtime.lock().map_err(|_| "Mises à jour indisponibles")?;
        if !runtime.config.server_enabled || runtime.server.is_none() {
            return Err("La publication est réservée au PC serveur actif.".into());
        }
    }
    let version = version.trim();
    let next_version = semver::Version::parse(version)
        .map_err(|_| "Version invalide (exemple : 0.4.2)")?;
    if let Some(previous) = load_release(&updates.directory) {
        let last_version = semver::Version::parse(&previous.version).map_err(|e| e.to_string())?;
        if next_version <= last_version {
            return Err(format!("La version doit dépasser {}", previous.version));
        }
    }
    if notes.len() > 3000 { return Err("Notes de version trop longues".into()); }
    let source = PathBuf::from(installer_path.trim().trim_matches('"'));
    if !source.is_file() || source.extension().and_then(|x| x.to_str()) != Some("exe") {
        return Err("Sélectionne le chemin complet de l'installateur NSIS .exe compilé sur ce PC.".into());
    }
    let sig_path = PathBuf::from(format!("{}.sig", source.display()));
    let signature = fs::read_to_string(&sig_path).map_err(|_| format!("Signature absente : {}", sig_path.display()))?;
    if signature.trim().len() < 50 || !signature.trim().is_ascii() {
        return Err("Signature Tauri invalide ou vide".into());
    }
    let releases = updates.directory.join("releases");
    fs::create_dir_all(&releases).map_err(|e| e.to_string())?;
    let filename = format!("PixelOffice-{version}.exe");
    let target = releases.join(&filename);
    let temp = releases.join(format!("PixelOffice-{version}.part"));
    fs::copy(&source, &temp).map_err(|e| e.to_string())?;
    if target.exists() { fs::remove_file(&target).map_err(|e| e.to_string())?; }
    fs::rename(&temp, &target).map_err(|e| e.to_string())?;
    let manifest = Release { version: version.to_string(), notes, signature: signature.trim().to_string(), filename };
    let bytes = serde_json::to_vec_pretty(&manifest).map_err(|e| e.to_string())?;
    let tmp_meta = updates.directory.join("latest.tmp");
    fs::write(&tmp_meta, bytes).map_err(|e| e.to_string())?;
    let meta = updates.directory.join("latest.json");
    if meta.exists() { fs::remove_file(&meta).map_err(|e| e.to_string())?; }
    fs::rename(tmp_meta, meta).map_err(|e| e.to_string())?;
    Ok(format!("Version {version} publiée sur le réseau local."))
}

fn update_endpoint(updates: &UpdateService) -> Result<url::Url, String> {
    updates.endpoint()?.parse().map_err(|e| format!("URL de mise à jour invalide : {e}"))
}

#[tauri::command]
pub async fn updates_check(
    app: AppHandle,
    updates: State<'_, UpdateService>,
) -> Result<Option<AvailableUpdate>, String> {
    if cfg!(debug_assertions) {
        return Err("Vérification désactivée en tauri dev : teste avec une version installée.".into());
    }
    let endpoint = update_endpoint(&updates)?;
    let updater = app.updater_builder()
        .endpoints(vec![endpoint]).map_err(|e| e.to_string())?
        .timeout(Duration::from_secs(8))
        .build().map_err(|e| e.to_string())?;
    let next = updater.check().await.map_err(|e| e.to_string())?;
    Ok(next.map(|u| AvailableUpdate { version: u.version, notes: u.body.unwrap_or_default() }))
}

#[tauri::command]
pub async fn updates_install(
    app: AppHandle,
    updates: State<'_, UpdateService>,
) -> Result<String, String> {
    if cfg!(debug_assertions) {
        return Err("Pour installer une MAJ, lance une version Windows compilée et installée (pas tauri dev).".into());
    }
    if updates.installing.swap(true, Ordering::SeqCst) {
        return Err("Une installation est déjà en cours".into());
    }
    let result = async {
        let endpoint = update_endpoint(&updates)?;
        let updater = app.updater_builder()
            .endpoints(vec![endpoint]).map_err(|e| e.to_string())?
            .timeout(Duration::from_secs(15))
            .build().map_err(|e| e.to_string())?;
        let next = updater.check().await.map_err(|e| e.to_string())?;
        let Some(next) = next else { return Ok("Aucune nouvelle version".to_owned()); };
        next.download_and_install(|_, _| {}, || {}).await.map_err(|e| e.to_string())?;
        Ok("Installation lancée".to_owned())
    }.await;
    updates.installing.store(false, Ordering::SeqCst);
    result
}
