//! Pixel Office: local SQLite mailbox and a LAN-only synchronisation prototype.
//! Each workstation keeps its own SQLite database; the host relays messages.
//! The TCP protocol uses a shared secret but is NOT encrypted. Use on trusted LANs only.

use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream, ToSocketAddrs};
use std::path::Path;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::State;

const MAX_PACKET: usize = 10 * 1024 * 1024;
const MAX_ATTACHMENTS_JSON: usize = 5 * 1024 * 1024;
const DEFAULT_PORT: u16 = 39427;
static COUNTER: AtomicU64 = AtomicU64::new(0);

type Db = Arc<Mutex<Connection>>;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Attachment {
    name: String,
    mime: String,
    data_url: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OfficeRequest {
    pub id: String,
    pub sender: String,
    pub recipient: String,
    pub subject: String,
    pub body: String,
    pub created_at: i64,
    pub reply_to: Option<String>,
    #[serde(default)]
    pub attachments: Vec<Attachment>,
    #[serde(default)]
    pub pinned: bool,
    #[serde(default)]
    pub archived: bool,
    #[serde(default)]
    pub viewed: bool,
    #[serde(default)]
    pub sync_state: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NewRequest {
    recipient: String,
    subject: String,
    body: String,
    reply_to: Option<String>,
    #[serde(default)]
    attachments: Vec<Attachment>,
}

#[derive(Clone)]
struct ClientConfig {
    address: String,
    secret: String,
}

struct HostControl {
    stop: Arc<AtomicBool>,
    port: u16,
    thread: Option<thread::JoinHandle<()>>,
}

#[derive(Default)]
struct NetworkRuntime {
    host: Option<HostControl>,
    client: Option<ClientConfig>,
}

pub struct Backend {
    db: Db,
    network: Mutex<NetworkRuntime>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NetStatus {
    mode: String,
    address: String,
    port: u16,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncReport {
    mode: String,
    sent: usize,
    received: usize,
    online: bool,
}

#[derive(Serialize, Deserialize)]
struct WirePacket {
    protocol: u8,
    secret: String,
    profile: String,
    after: i64,
    outgoing: Vec<OfficeRequest>,
}

#[derive(Serialize, Deserialize)]
struct SequencedRequest {
    sequence: i64,
    request: OfficeRequest,
}

#[derive(Serialize, Deserialize)]
struct WireResponse {
    error: Option<String>,
    accepted: Vec<String>,
    incoming: Vec<SequencedRequest>,
    cursor: i64,
}

fn lock_db(db: &Db) -> Result<std::sync::MutexGuard<'_, Connection>, String> {
    db.lock().map_err(|_| "Verrou SQLite indisponible".to_string())
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
}

fn generate_id() -> String {
    let nanos = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_nanos();
    let n = COUNTER.fetch_add(1, Ordering::Relaxed);
    format!("px-{nanos:x}-{:x}-{n:x}", std::process::id())
}

fn validate_name(name: &str) -> Result<String, String> {
    let name = name.trim().to_ascii_lowercase();
    if name.len() < 2 || name.len() > 24 || !name.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-') {
        return Err("Le nom doit contenir 2 à 24 caractères : lettres sans accents, chiffres, _ ou -.".into());
    }
    Ok(name)
}

fn validate_request(req: &OfficeRequest) -> Result<(), String> {
    validate_name(&req.sender)?;
    validate_name(&req.recipient)?;
    if req.sender == req.recipient { return Err("Choisis un autre destinataire.".into()); }
    if req.id.len() > 96 || req.id.len() < 5 || !req.id.is_ascii() { return Err("Identifiant de demande invalide".into()); }
    if req.subject.trim().is_empty() || req.subject.len() > 160 { return Err("Le sujet est obligatoire (160 caractères max).".into()); }
    if req.body.chars().count() > 15000 { return Err("Le texte est trop long (15 000 caractères max).".into()); }
    if req.attachments.len() > 4 { return Err("Maximum 4 pièces jointes.".into()); }
    let encoded = serde_json::to_vec(&req.attachments).map_err(|e| e.to_string())?;
    if encoded.len() > MAX_ATTACHMENTS_JSON { return Err("Pièces jointes trop volumineuses (5 Mo encodés maximum).".into()); }
    for attachment in &req.attachments {
        if attachment.name.is_empty() || attachment.name.len() > 180 || attachment.mime.len() > 120 || !attachment.data_url.starts_with("data:") {
            return Err("Pièce jointe invalide.".into());
        }
    }
    Ok(())
}

fn get_setting(conn: &Connection, key: &str) -> Result<String, String> {
    conn.query_row("SELECT value FROM settings WHERE key=?1", [key], |r| r.get(0))
        .optional().map_err(|e| e.to_string())
        .map(|opt| opt.unwrap_or_default())
}
fn set_setting(conn: &Connection, key: &str, value: &str) -> Result<(), String> {
    conn.execute("INSERT INTO settings(key,value) VALUES(?1,?2) ON CONFLICT(key) DO UPDATE SET value=excluded.value", params![key,value])
        .map_err(|e| e.to_string())?;
    Ok(())
}
fn profile(conn: &Connection) -> Result<String, String> {
    let name = get_setting(conn, "profile")?;
    if name.is_empty() { return Err("Choisis d'abord ton nom dans les paramètres.".into()); }
    Ok(name)
}

fn row_to_request(row: &rusqlite::Row<'_>) -> rusqlite::Result<OfficeRequest> {
    let attachments_json: String = row.get(7)?;
    let attachments = serde_json::from_str(&attachments_json).unwrap_or_default();
    Ok(OfficeRequest {
        id: row.get(0)?, sender: row.get(1)?, recipient: row.get(2)?,
        subject: row.get(3)?, body: row.get(4)?, created_at: row.get(5)?,
        reply_to: row.get(6)?, attachments,
        pinned: row.get::<_, i64>(8)? != 0,
        archived: row.get::<_, i64>(9)? != 0,
        sync_state: row.get(10)?,
        viewed: row.get::<_, i64>(11)? != 0,
    })
}

const SELECT_REQUEST: &str = "SELECT r.id,r.sender,r.recipient,r.subject,r.body,r.created_at,r.reply_to,r.attachments,\
  COALESCE(f.pinned,0),COALESCE(f.archived,0),r.sync_state,\
  CASE WHEN v.request_id IS NULL THEN 0 ELSE 1 END FROM requests r \
  LEFT JOIN flags f ON r.id=f.request_id \
  LEFT JOIN viewed_requests v ON r.id=v.request_id";

fn insert_request(conn: &Connection, req: &OfficeRequest, state: &str) -> Result<(), String> {
    let attachments = serde_json::to_string(&req.attachments).map_err(|e| e.to_string())?;
    conn.execute(
        "INSERT OR IGNORE INTO requests(id,sender,recipient,subject,body,created_at,reply_to,attachments,sync_state) \
         VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9)",
        params![req.id,req.sender,req.recipient,req.subject,req.body,req.created_at,req.reply_to,attachments,state]
    ).map_err(|e| e.to_string())?;
    Ok(())
}

impl Backend {
    pub fn open(path: &Path) -> Result<Self, String> {
        if let Some(parent) = path.parent() { std::fs::create_dir_all(parent).map_err(|e| e.to_string())?; }
        let conn = Connection::open(path).map_err(|e| e.to_string())?;
        conn.execute_batch("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=3000;\
          CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);\
          CREATE TABLE IF NOT EXISTS requests (\
            id TEXT PRIMARY KEY, sender TEXT NOT NULL, recipient TEXT NOT NULL,\
            subject TEXT NOT NULL, body TEXT NOT NULL, created_at INTEGER NOT NULL,\
            reply_to TEXT, attachments TEXT NOT NULL DEFAULT '[]',\
            sync_state TEXT NOT NULL DEFAULT 'queued'\
          );\
          CREATE INDEX IF NOT EXISTS requests_recipient_idx ON requests(recipient);\
          CREATE INDEX IF NOT EXISTS requests_sender_idx ON requests(sender);\
          CREATE TABLE IF NOT EXISTS flags (\
            request_id TEXT PRIMARY KEY, pinned INTEGER NOT NULL DEFAULT 0,\
            archived INTEGER NOT NULL DEFAULT 0,\
            FOREIGN KEY(request_id) REFERENCES requests(id)\
          );\
          CREATE TABLE IF NOT EXISTS viewed_requests (request_id TEXT PRIMARY KEY,\
            FOREIGN KEY(request_id) REFERENCES requests(id)\
          );")
          .map_err(|e| e.to_string())?;
        Ok(Self { db: Arc::new(Mutex::new(conn)), network: Mutex::new(NetworkRuntime::default()) })
    }
}

#[tauri::command]
pub fn get_profile(state: State<'_, Backend>) -> Result<String, String> {
    let conn = lock_db(&state.db)?;
    get_setting(&conn, "profile")
}

#[tauri::command]
pub fn set_profile(state: State<'_, Backend>, name: String) -> Result<String, String> {
    let name = validate_name(&name)?;
    let conn = lock_db(&state.db)?;
    let current = get_setting(&conn, "profile")?;
    if !current.is_empty() && current != name {
        return Err("Le profil de cet ordinateur est déjà défini. Pour éviter de mélanger les demandes, il ne peut pas être renommé ici.".into());
    }
    set_setting(&conn, "profile", &name)?;
    Ok(name)
}

#[tauri::command]
pub fn list_requests(state: State<'_, Backend>) -> Result<Vec<OfficeRequest>, String> {
    let conn = lock_db(&state.db)?;
    let user = profile(&conn)?;
    let query = format!("{} WHERE (r.sender=?1 OR r.recipient=?1) ORDER BY r.created_at DESC LIMIT 1000", SELECT_REQUEST);
    let mut stmt = conn.prepare(&query).map_err(|e| e.to_string())?;
    let rows = stmt.query_map(params![user], row_to_request).map_err(|e| e.to_string())?;
    rows.collect::<rusqlite::Result<Vec<_>>>().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn create_request(state: State<'_, Backend>, draft: NewRequest) -> Result<OfficeRequest, String> {
    let conn = lock_db(&state.db)?;
    let sender = profile(&conn)?;
    let recipient = validate_name(&draft.recipient)?;
    let host_running = state.network.lock().map_err(|_| "Réseau indisponible")?.host.is_some();
    let sync_state = if host_running { "server" } else { "queued" }.to_string();
    let req = OfficeRequest {
        id: generate_id(), sender, recipient,
        subject: draft.subject.trim().to_owned(), body: draft.body,
        created_at: now_ms(), reply_to: draft.reply_to,
        attachments: draft.attachments, pinned: false, archived: false, viewed: false, sync_state,
    };
    validate_request(&req)?;
    insert_request(&conn, &req, &req.sync_state)?;
    Ok(req)
}

#[tauri::command]
pub fn set_request_flags(state: State<'_, Backend>, id: String, pinned: bool, archived: bool) -> Result<(), String> {
    let conn = lock_db(&state.db)?;
    let user = profile(&conn)?;
    let belongs: bool = conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM requests WHERE id=?1 AND (sender=?2 OR recipient=?2))",
        params![id,user], |r| r.get(0)
    ).map_err(|e| e.to_string())?;
    if !belongs { return Err("Demande introuvable".into()); }
    conn.execute("INSERT INTO flags(request_id,pinned,archived) VALUES(?1,?2,?3) \
                  ON CONFLICT(request_id) DO UPDATE SET pinned=excluded.pinned,archived=excluded.archived",
        params![id,pinned as i64,archived as i64]).map_err(|e| e.to_string())?;
    Ok(())
}

/// « Consulter » signifie ouvrir la feuille d'une demande reçue, pas juste la liste.
/// Local à chaque PC : la lecture ne doit pas être propagée par le serveur LAN.
#[tauri::command]
pub fn mark_request_viewed(state: State<'_, Backend>, id: String) -> Result<(), String> {
    let conn = lock_db(&state.db)?;
    let user = profile(&conn)?;
    let changed = conn.execute(
        "INSERT OR IGNORE INTO viewed_requests(request_id) \
         SELECT id FROM requests WHERE id=?1 AND recipient=?2",
        params![id, user],
    ).map_err(|e| e.to_string())?;
    if changed == 0 {
        // Si la ligne existe déjà, l'opération est idempotente.
        let already_viewed: bool = conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM viewed_requests v JOIN requests r \
             ON v.request_id=r.id WHERE v.request_id=?1 AND r.recipient=?2)",
            params![id, user], |row| row.get(0),
        ).map_err(|e| e.to_string())?;
        if !already_viewed { return Err("Demande reçue introuvable".into()); }
    }
    Ok(())
}

fn stop_network(runtime: &mut NetworkRuntime) {
    if let Some(mut host) = runtime.host.take() {
        host.stop.store(true, Ordering::SeqCst);
        if let Some(thread) = host.thread.take() { let _ = thread.join(); }
    }
    runtime.client = None;
}

#[tauri::command]
pub fn network_disconnect(state: State<'_, Backend>) -> Result<(), String> {
    let mut net = state.network.lock().map_err(|_| "Réseau indisponible")?;
    stop_network(&mut net);
    Ok(())
}

#[tauri::command]
pub fn network_status(state: State<'_, Backend>) -> Result<NetStatus, String> {
    let net = state.network.lock().map_err(|_| "Réseau indisponible")?;
    if let Some(ref h) = net.host {
        Ok(NetStatus { mode: "host".into(), address: "0.0.0.0".into(), port: h.port })
    } else if let Some(ref c) = net.client {
        let port = c.address.rsplit_once(':').and_then(|(_,p)| p.parse().ok()).unwrap_or(DEFAULT_PORT);
        Ok(NetStatus { mode: "client".into(), address: c.address.clone(), port })
    } else {
        Ok(NetStatus { mode: "offline".into(), address: String::new(), port: DEFAULT_PORT })
    }
}

fn validate_secret(secret: &str) -> Result<(), String> {
    if !(12..=96).contains(&secret.len()) || !secret.is_ascii() || secret.contains('\n') {
        return Err("Choisis un code réseau de 12 à 96 caractères ASCII.".into());
    }
    Ok(())
}

#[tauri::command]
pub fn network_host(state: State<'_, Backend>, port: u16, secret: String) -> Result<NetStatus, String> {
    validate_secret(&secret)?;
    if port < 1024 { return Err("Choisis un port entre 1024 et 65535.".into()); }
    { let conn = lock_db(&state.db)?; profile(&conn)?; }
    let listener = TcpListener::bind(("0.0.0.0", port)).map_err(|e| format!("Impossible d'ouvrir le port {port} : {e}"))?;
    listener.set_nonblocking(true).map_err(|e| e.to_string())?;
    let db = Arc::clone(&state.db);
    let stop = Arc::new(AtomicBool::new(false));
    let stop_thread = Arc::clone(&stop);
    let mut net = state.network.lock().map_err(|_| "Réseau indisponible")?;
    if net.host.is_some() || net.client.is_some() { return Err("Déconnecte le réseau actuel avant d'en démarrer un autre.".into()); }
    let listener_thread = thread::spawn(move || {
        while !stop_thread.load(Ordering::SeqCst) {
            match listener.accept() {
                Ok((stream, _)) => {
                    let db = Arc::clone(&db);
                    let secret = secret.clone();
                    thread::spawn(move || { let _ = serve_once(stream, &db, &secret); });
                }
                Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => thread::sleep(Duration::from_millis(90)),
                Err(_) => thread::sleep(Duration::from_millis(150)),
            }
        }
    });
    // Offline requests created on this host are already available to clients.
    if let Ok(conn) = lock_db(&state.db) {
        let _ = conn.execute("UPDATE requests SET sync_state='server' WHERE sync_state='queued' AND sender=(SELECT value FROM settings WHERE key='profile')", []);
    }
    net.host = Some(HostControl { stop, port, thread: Some(listener_thread) });
    Ok(NetStatus { mode: "host".into(), address: "0.0.0.0".into(), port })
}

#[tauri::command]
pub fn network_connect(state: State<'_, Backend>, host: String, port: u16, secret: String) -> Result<NetStatus, String> {
    validate_secret(&secret)?;
    if port < 1024 { return Err("Port invalide.".into()); }
    { let conn = lock_db(&state.db)?; profile(&conn)?; }
    let host = host.trim();
    if host.is_empty() || host.len() > 253 || host.contains(|c: char| c.is_whitespace() || c == '/' || c == '@') {
        return Err("Adresse IP ou nom d'hôte invalide.".into());
    }
    // IPv4 or DNS hostname only for this LAN prototype.
    if host.contains(':') { return Err("Utilise une adresse IPv4 ou un nom de PC (sans port).".into()); }
    let address = format!("{host}:{port}");
    let mut net = state.network.lock().map_err(|_| "Réseau indisponible")?;
    if net.host.is_some() { return Err("Cet ordinateur héberge déjà un serveur. Déconnecte-le avant.".into()); }
    net.client = Some(ClientConfig { address: address.clone(), secret });
    Ok(NetStatus { mode: "client".into(), address, port })
}

fn write_frame<T: Serialize>(stream: &mut TcpStream, value: &T) -> Result<(), String> {
    let bytes = serde_json::to_vec(value).map_err(|e| e.to_string())?;
    if bytes.len() > MAX_PACKET { return Err("Paquet réseau trop volumineux".into()); }
    stream.write_all(&(bytes.len() as u32).to_be_bytes()).map_err(|e| e.to_string())?;
    stream.write_all(&bytes).map_err(|e| e.to_string())?;
    Ok(())
}

fn read_frame<T: for<'a> Deserialize<'a>>(stream: &mut TcpStream) -> Result<T, String> {
    let mut header = [0u8;4];
    stream.read_exact(&mut header).map_err(|e| e.to_string())?;
    let len = u32::from_be_bytes(header) as usize;
    if len == 0 || len > MAX_PACKET { return Err("Taille de paquet invalide".into()); }
    let mut bytes = vec![0u8;len];
    stream.read_exact(&mut bytes).map_err(|e| e.to_string())?;
    serde_json::from_slice(&bytes).map_err(|e| e.to_string())
}

fn serve_once(mut stream: TcpStream, db: &Db, expected_secret: &str) -> Result<(), String> {
    stream.set_read_timeout(Some(Duration::from_secs(7))).map_err(|e| e.to_string())?;
    stream.set_write_timeout(Some(Duration::from_secs(7))).map_err(|e| e.to_string())?;
    let packet: WirePacket = read_frame(&mut stream)?;
    let response = if packet.protocol != 1 || packet.secret != expected_secret {
        WireResponse { error: Some("Code réseau ou version de protocole invalide".into()), accepted:vec![],incoming:vec![],cursor:packet.after }
    } else {
        match process_packet(packet, db) {
            Ok(r) => r,
            Err(e) => WireResponse { error: Some(e), accepted:vec![],incoming:vec![],cursor:0 }
        }
    };
    write_frame(&mut stream, &response)
}

fn process_packet(packet: WirePacket, db: &Db) -> Result<WireResponse, String> {
    let user = validate_name(&packet.profile)?;
    if packet.after < 0 || packet.outgoing.len() > 16 { return Err("Paquet de synchronisation invalide".into()); }
    let mut conn = lock_db(db)?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    let mut accepted = Vec::new();
    for req in &packet.outgoing {
        validate_request(req)?;
        if req.sender != user { return Err("Expéditeur non autorisé".into()); }
        insert_request(&tx, req, "server")?;
        accepted.push(req.id.clone());
    }
    tx.commit().map_err(|e| e.to_string())?;
    let sql = format!("{} WHERE r.recipient=?1 AND r.rowid>?2 ORDER BY r.rowid LIMIT 35", SELECT_REQUEST.replacen("SELECT ", "SELECT r.rowid, ", 1));
    let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
    let rows = stmt.query_map(params![user,packet.after], |row| {
        Ok(SequencedRequest { sequence: row.get(0)?, request: row_to_request_shifted(row)? })
    }).map_err(|e| e.to_string())?;
    // Respect the frame limit even when several messages contain attachments.
    let mut incoming = Vec::new();
    let mut response_size = 0usize;
    for row in rows {
        let item = row.map_err(|e| e.to_string())?;
        let size = serde_json::to_vec(&item).map_err(|e| e.to_string())?.len();
        if !incoming.is_empty() && response_size + size > 7 * 1024 * 1024 { break; }
        response_size += size;
        incoming.push(item);
    }
    let cursor = incoming.last().map(|x| x.sequence).unwrap_or(packet.after);
    Ok(WireResponse { error:None,accepted,incoming,cursor })
}

fn row_to_request_shifted(row: &rusqlite::Row<'_>) -> rusqlite::Result<OfficeRequest> {
    let attachments_json: String = row.get(8)?;
    let attachments = serde_json::from_str(&attachments_json).unwrap_or_default();
    Ok(OfficeRequest {
        id: row.get(1)?, sender: row.get(2)?, recipient: row.get(3)?,
        subject: row.get(4)?, body: row.get(5)?, created_at: row.get(6)?,
        reply_to: row.get(7)?, attachments,
        pinned: row.get::<_,i64>(9)? != 0,
        archived: row.get::<_,i64>(10)? != 0,
        sync_state: row.get(11)?,
        viewed: row.get::<_,i64>(12)? != 0,
    })
}

fn perform_tick(db: Db, client: ClientConfig) -> Result<SyncReport, String> {
    let (user, cursor, outgoing) = {
        let conn = lock_db(&db)?;
        let user = profile(&conn)?;
        let cursor_key = format!("cursor:{}:{}", client.address, user);
        let cursor = get_setting(&conn, &cursor_key)?.parse::<i64>().unwrap_or(0);
        let sql = format!("{} WHERE r.sender=?1 AND r.sync_state='queued' ORDER BY r.created_at ASC LIMIT 12", SELECT_REQUEST);
        let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
        let rows = stmt.query_map(params![user], row_to_request).map_err(|e| e.to_string())?;
        let mut outgoing = Vec::new();
        let mut request_size = 0usize;
        for row in rows {
            let item = row.map_err(|e| e.to_string())?;
            let size = serde_json::to_vec(&item).map_err(|e| e.to_string())?.len();
            if !outgoing.is_empty() && request_size + size > 7 * 1024 * 1024 { break; }
            request_size += size;
            outgoing.push(item);
        }
        (user, cursor, outgoing)
    };
    let packet = WirePacket { protocol:1,secret:client.secret, profile:user.clone(),after:cursor,outgoing };
    let addr = client.address.to_socket_addrs().map_err(|e| e.to_string())?.next().ok_or("Adresse réseau introuvable")?;
    let mut stream = TcpStream::connect_timeout(&addr, Duration::from_secs(3)).map_err(|e| format!("Serveur injoignable : {e}"))?;
    stream.set_read_timeout(Some(Duration::from_secs(7))).map_err(|e| e.to_string())?;
    stream.set_write_timeout(Some(Duration::from_secs(7))).map_err(|e| e.to_string())?;
    write_frame(&mut stream, &packet)?;
    let reply: WireResponse = read_frame(&mut stream)?;
    if let Some(error) = reply.error { return Err(error); }
    // Persist messages and cursor together, preventing skipped deliveries after crashes.
    let mut conn = lock_db(&db)?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    for incoming in &reply.incoming {
        validate_request(&incoming.request)?;
        if incoming.request.recipient != user { return Err("Destinataire du paquet invalide".into()); }
        insert_request(&tx, &incoming.request, "received")?;
    }
    for id in &reply.accepted {
        tx.execute("UPDATE requests SET sync_state='server' WHERE id=?1 AND sender=?2", params![id,user])
            .map_err(|e| e.to_string())?;
    }
    let cursor_key = format!("cursor:{}:{}", client.address, user);
    set_setting(&tx, &cursor_key, &reply.cursor.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(SyncReport { mode:"client".into(), sent:reply.accepted.len(), received:reply.incoming.len(), online:true })
}

#[tauri::command]
pub async fn network_tick(state: State<'_, Backend>) -> Result<SyncReport, String> {
    let client = {
        let net = state.network.lock().map_err(|_| "Réseau indisponible")?;
        if net.host.is_some() { return Ok(SyncReport { mode:"host".into(),sent:0,received:0,online:true }); }
        net.client.clone()
    };
    match client {
        Some(client) => {
            let db = Arc::clone(&state.db);
            tauri::async_runtime::spawn_blocking(move || perform_tick(db, client))
                .await.map_err(|e| e.to_string())?
        }
        None => Ok(SyncReport { mode:"offline".into(), sent:0,received:0,online:false })
    }
}