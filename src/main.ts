import { getCurrentWindow } from "@tauri-apps/api/window";
import { invoke } from "@tauri-apps/api/core";
import { startGame, setDeliveryRequests, animateOutgoingCourier, testNotificationSound } from "./game";
import type { Attachment, NewRequest, NetStatus, OfficeRequest } from "./types";
import "./style.css";

const appWindow = getCurrentWindow();
const TEAM = ["lucas", "sarah", "yanis", "maya", "noa", "ines"];
let username = "";
let requests: OfficeRequest[] = [];
let network: NetStatus = { mode: "offline", address: "", port: 39427 };
let tickBusy = false;
let networkError = "";
let networkVerified = false;

// Keep the working Tauri window layout and Phaser scene.
document.body.innerHTML = `
  <div class="office">
    <header class="titlebar">
      <div class="drag-area" id="drag">
        <span class="handle">⠿</span><span>PIXEL OFFICE</span>
        <span class="version">v0.4.2</span>
      </div>
      <div class="controls">
        <button id="network-indicator" class="network-indicator" title="Paramètres réseau">● Hors ligne</button>
        <button id="settings" title="Profil et réseau">⚙</button>
        <button id="minimize" title="Réduire">−</button>
        <button id="reset" title="Position par défaut">▣</button>
        <button id="close" title="Fermer">×</button>
      </div>
    </header>
    <main class="workspace">
      <section class="panel pinned-tasks">
        <div class="panel-title">TÂCHES ÉPINGLÉES</div>
        <div id="tasks-list" class="tasks-list"></div>
        <button class="side-action" id="open-inbox">📦 Mon guichet</button>
        <button class="side-action" id="open-compose">✉ Nouvelle demande</button>
        <button class="side-action" id="open-sent">↗ Demandes envoyées</button>
      </section>
      <section class="world-wrap">
        <section class="world" id="game-container"></section>
        <div id="overlay" class="overlay hidden">
          <div class="overlay-card" role="dialog" aria-modal="true" aria-labelledby="overlay-title">
            <div class="overlay-header">
              <div class="overlay-title" id="overlay-title">Détail</div>
              <button class="overlay-close" id="overlay-close" title="Fermer">×</button>
            </div>
            <div id="overlay-body" class="overlay-body"></div>
            <div id="overlay-actions" class="overlay-actions"></div>
          </div>
        </div>
      </section>
    </main>
    <div class="resize-handle" id="resize" title="Redimensionner"></div>
  </div>
`;

type Action = { label: string; kind?: "primary" | "danger" | "neutral"; onClick: () => void | Promise<void> };
const overlay = document.querySelector<HTMLDivElement>("#overlay")!;
const overlayTitle = document.querySelector<HTMLDivElement>("#overlay-title")!;
const overlayBody = document.querySelector<HTMLDivElement>("#overlay-body")!;
const overlayActions = document.querySelector<HTMLDivElement>("#overlay-actions")!;
const tasksList = document.querySelector<HTMLDivElement>("#tasks-list")!;
const networkIndicator = document.querySelector<HTMLButtonElement>("#network-indicator")!;

function escapeHtml(s: string) {
  return s.replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}
function niceTime(ms: number) { return new Date(ms).toLocaleString("fr-FR"); }
function reportError(error: unknown) {
  console.error("Pixel Office", error);
  alert(`Une action a échoué : ${String(error)}`);
}
function closeOverlay() { overlay.classList.add("hidden"); }
function openOverlay(title: string, html: string, actions: Action[] = []) {
  overlayTitle.textContent = title;
  overlayBody.innerHTML = html;
  overlayActions.replaceChildren();
  for (const action of actions) {
    const button = document.createElement("button");
    button.className = `overlay-action ${action.kind || "neutral"}`;
    button.textContent = action.label;
    button.addEventListener("click", () => { void Promise.resolve(action.onClick()).catch(reportError); });
    overlayActions.append(button);
  }
  overlay.classList.remove("hidden");
}
function textError(error: unknown, target = "#form-error") {
  const node = overlayBody.querySelector<HTMLElement>(target);
  if (node) node.textContent = String(error);
  else reportError(error);
}
function requireProfile() {
  if (!username) { openProfileSetup(); return false; }
  return true;
}

function renderTasks() {
  tasksList.replaceChildren();
  const pinned = requests.filter(r => r.pinned && !r.archived);
  if (!pinned.length) {
    const empty = document.createElement("div");
    empty.className = "task-card";
    empty.textContent = "Aucune tâche épinglée.";
    tasksList.append(empty);
  }
  for (const req of pinned) {
    const item = document.createElement("div");
    item.className = "task-card";
    const title = document.createElement("div");
    title.className = "task-text";
    title.textContent = `${req.subject} — ${req.sender}`;
    const open = document.createElement("button");
    open.className = "task-remove";
    open.textContent = "Ouvrir";
    open.onclick = () => showRequest(req);
    const remove = document.createElement("button");
    remove.className = "task-remove";
    remove.textContent = "Désépingler";
    remove.onclick = () => { void updateFlags(req, false, req.archived).catch(reportError); };
    item.append(title, open, remove);
    tasksList.append(item);
  }
  const count = requests.filter(r => r.recipient === username && !r.archived).length;
  document.querySelector<HTMLButtonElement>("#open-inbox")!.textContent = `📦 Mon guichet (${count})`;
  setDeliveryRequests(game, requests.filter(r => r.recipient === username && !r.archived));
}

async function refreshRequests() {
  if (!username) return;
  requests = await invoke<OfficeRequest[]>("list_requests");
  renderTasks();
}
async function updateFlags(req: OfficeRequest, pinned: boolean, archived: boolean) {
  await invoke("set_request_flags", { id: req.id, pinned, archived });
  await refreshRequests();
}

function showRequest(req: OfficeRequest) {
  const inbound = req.recipient === username;
  const attachments = req.attachments || [];
  openOverlay(inbound ? "📦 Feuille de demande" : "📨 Demande envoyée", `
    <div class="sheet">
      <div class="sheet-heading">PIXEL OFFICE · DOCUMENT</div>
      <div class="sheet-meta"><b>De :</b> ${escapeHtml(req.sender)}　 <b>À :</b> ${escapeHtml(req.recipient)}</div>
      <div class="sheet-meta"><b>Date :</b> ${escapeHtml(niceTime(req.createdAt))}</div>
      <div class="sheet-subject">${escapeHtml(req.subject)}</div>
      <div class="sheet-message">${escapeHtml(req.body || "(Pas de texte)")}</div>
      <div class="attachments"><strong>Pièces jointes (${attachments.length})</strong><div id="attachment-list"></div></div>
      ${req.syncState === "queued" ? '<p class="notice">⏳ En attente de synchronisation réseau.</p>' : ""}
    </div>
  `, [
    { label: req.pinned ? "Désépingler" : "📌 Épingler", kind: "primary", onClick: async () => {
      await updateFlags(req, !req.pinned, req.archived);
      closeOverlay();
    } },
    { label: inbound ? "↩ Répondre" : "↗ Relancer", onClick: () => composeRequest(inbound ? req : { ...req, sender: req.recipient }) },
    { label: req.archived ? "Restaurer" : "Archiver", kind: "danger", onClick: async () => {
      await updateFlags(req, false, !req.archived);
      closeOverlay();
    } }
  ]);
  // La lecture est validée seulement à l'ouverture de la feuille de demande.
  // L'état en SQLite survit aux redémarrages et stoppe le coursier et son ding.
  if (inbound && !req.viewed) {
    void invoke("mark_request_viewed", { id: req.id })
      .then(async () => {
        req.viewed = true;
        await refreshRequests();
      })
      .catch(reportError);
  }
  const list = overlayBody.querySelector<HTMLElement>("#attachment-list")!;
  for (const att of attachments) {
    const button = document.createElement("button");
    button.className = "attachment-button";
    button.textContent = `⬇ ${att.name}`;
    button.title = `Enregistrer ${att.name}`;
    button.onclick = () => {
      // Do not navigate to untrusted user-supplied HTML/SVG data URLs.
      // Save all received files as opaque bytes instead.
      const encoded = att.dataUrl.split(",", 2)[1];
      if (!encoded) { reportError("Pièce jointe illisible"); return; }
      try {
        const raw = atob(encoded);
        const bytes = Uint8Array.from(raw, c => c.charCodeAt(0));
        const blob = new Blob([bytes], { type: "application/octet-stream" });
        const href = URL.createObjectURL(blob);
        const link = document.createElement("a");
        link.href = href;
        link.download = att.name.replace(/[\\/]/g, "_");
        link.click();
        window.setTimeout(() => URL.revokeObjectURL(href), 10000);
      } catch (error) { reportError(error); }
    };
    list.append(button);
    // Preview only inert raster image formats (never SVG/HTML).
    if (/^data:image\/(png|jpeg|gif|webp);base64,/i.test(att.dataUrl)) {
      const image = document.createElement("img");
      image.className = "attachment-image";
      image.alt = att.name;
      image.src = att.dataUrl;
      list.append(image);
    }
  }
}

function listInbox(sent = false) {
  if (!requireProfile()) return;
  const visible = requests.filter(r => (sent ? r.sender : r.recipient) === username && !r.archived);
  const label = sent ? "Mes envois" : "Demandes à mon guichet";
  openOverlay(label, `<div class="mail-list" id="mail-list"></div>`, [
    { label: "Nouvelle demande", kind: "primary", onClick: () => composeRequest() },
    { label: "Fermer", onClick: closeOverlay }
  ]);
  const list = overlayBody.querySelector<HTMLElement>("#mail-list")!;
  if (!visible.length) {
    list.textContent = sent ? "Aucune demande envoyée." : "Aucun colis au guichet pour le moment.";
  }
  for (const req of visible) {
    const button = document.createElement("button");
    button.className = "mail-item";
    const who = sent ? `À ${req.recipient}` : `De ${req.sender}`;
    button.textContent = `${req.subject} — ${who} · ${niceTime(req.createdAt)}${req.pinned ? " 📌" : ""}`;
    button.onclick = () => showRequest(req);
    list.append(button);
  }
}

async function readAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error(`Impossible de lire ${file.name}`));
    reader.readAsDataURL(file);
  });
}

function composeRequest(reply?: OfficeRequest) {
  if (!requireProfile()) return;
  const options = TEAM.filter(n => n !== username)
    .map(n => `<option value="${escapeHtml(n)}"></option>`).join("");
  openOverlay(reply ? "Répondre à la demande" : "✉ Nouvelle demande", `
    <form id="compose-form" class="compose-form">
      <label>Destinataire
        <input id="send-to" name="recipient" list="team-names" required maxlength="24" autocomplete="off"
          placeholder="Ex. lucas" value="${escapeHtml(reply?.sender || "")}" />
        <datalist id="team-names">${options}</datalist>
      </label>
      <label>Sujet
        <input id="send-subject" name="subject" required maxlength="160"
          value="${escapeHtml(reply ? `Re: ${reply.subject}`.slice(0, 160) : "")}" placeholder="Objet de la demande" />
      </label>
      <label>Contenu de la feuille
        <textarea id="send-body" name="body" maxlength="15000" rows="6"
          placeholder="Explique la demande au destinataire..."></textarea>
      </label>
      <label>Pièces jointes (4 maximum, 1,5 Mo par fichier)
        <input id="send-files" type="file" multiple />
      </label>
      <div class="notice">Les fichiers sont enregistrés avec la demande dans SQLite. En réseau local, leur transfert n'est pas chiffré.</div>
      <div class="form-error" id="form-error"></div>
      <button type="submit" class="submit-button" id="send-button">📦 Confier au coursier</button>
    </form>
  `);
  overlayBody.querySelector<HTMLFormElement>("#compose-form")!.onsubmit = async (e) => {
    e.preventDefault();
    const button = overlayBody.querySelector<HTMLButtonElement>("#send-button")!;
    button.disabled = true;
    const recipient = (overlayBody.querySelector<HTMLInputElement>("#send-to")!.value).trim().toLowerCase();
    const subject = overlayBody.querySelector<HTMLInputElement>("#send-subject")!.value.trim();
    const body = overlayBody.querySelector<HTMLTextAreaElement>("#send-body")!.value;
    const files = Array.from(overlayBody.querySelector<HTMLInputElement>("#send-files")!.files || []);
    try {
      if (!/^[a-z0-9_-]{2,24}$/.test(recipient)) throw Error("Destinataire invalide : 2 à 24 lettres/chiffres/_/-.");
      if (recipient === username) throw Error("Choisis un autre destinataire.");
      if (!subject) throw Error("Ajoute un sujet.");
      if (files.length > 4 || files.some(file => file.size > 1_500_000) || files.reduce((s, f) => s + f.size, 0) > 3_500_000) {
        throw Error("Pièces jointes : 4 fichiers max, 1,5 Mo chacun, 3,5 Mo au total.");
      }
      const attachments: Attachment[] = [];
      for (const file of files) attachments.push({
        name: file.name.slice(0, 180),
        mime: (file.type || "application/octet-stream").slice(0, 120),
        dataUrl: await readAsDataUrl(file)
      });
      const draft: NewRequest = { recipient, subject, body, replyTo: reply?.id || null, attachments };
      await invoke<OfficeRequest>("create_request", { draft });
      animateOutgoingCourier(game, recipient);
      await refreshRequests();
      closeOverlay();
      // Network failure does not discard the request; it stays queued in SQLite.
      void networkTick();
    } catch (error) {
      textError(error);
      button.disabled = false;
    }
  };
}

function openProfileSetup() {
  openOverlay("Bienvenue dans Pixel Office", `
    <form id="profile-form" class="compose-form">
      <p>Choisis le nom qui représente cet ordinateur dans l'équipe.</p>
      <label>Mon nom d'utilisateur
        <input id="profile-name" required minlength="2" maxlength="24" list="team-names"
          placeholder="Ex. lucas" autocomplete="off" value="${escapeHtml(username)}" />
        <datalist id="team-names">${TEAM.map(x => `<option value="${x}"></option>`).join("")}</datalist>
      </label>
      <div class="notice">Le nom est fixe pour ce profil local. Chaque ordinateur doit utiliser un nom différent.</div>
      <div id="form-error" class="form-error"></div>
      <button class="submit-button" type="submit">Continuer</button>
    </form>
  `);
  overlayBody.querySelector<HTMLFormElement>("#profile-form")!.onsubmit = async (event) => {
    event.preventDefault();
    try {
      username = await invoke<string>("set_profile", {
        name: overlayBody.querySelector<HTMLInputElement>("#profile-name")!.value
      });
      closeOverlay();
      await refreshRequests();
      openSettings();
    } catch (error) { textError(error); }
  };
}

function updateIndicator() {
  networkIndicator.textContent = network.mode === "host" ? "● Serveur LAN"
    : network.mode === "client" && !networkError && networkVerified ? "● Connecté"
    : network.mode === "client" ? "● Connexion..." : "● Hors ligne";
  networkIndicator.classList.toggle("online", network.mode === "host" || (network.mode === "client" && !networkError && networkVerified));
  networkIndicator.title = networkError || (network.mode === "offline" ? "Configurer le réseau" : `${network.mode}: ${network.address}`);
}

async function refreshNetworkStatus() {
  network = await invoke<NetStatus>("network_status");
  updateIndicator();
}
function openSettings() {
  if (!requireProfile()) return;
  openOverlay("⚙ Paramètres Pixel Office", `
    <div class="network-pane">
      <p>Profil local : <strong>${escapeHtml(username)}</strong></p>
      <section class="startup-prefs" aria-labelledby="startup-heading">
        <h3 id="startup-heading">⚡ Démarrage de Windows</h3>
        <label class="startup-switch" for="startup-toggle">
          <input type="checkbox" id="startup-toggle" />
          <span>Démarrer Pixel Office à l'ouverture de ma session Windows et afficher sa fenêtre au premier plan</span>
        </label>
        <p class="notice">Option désactivée par défaut. Le réglage s'applique à ce PC et à ce compte Windows, pas aux collègues.</p>
        <div id="startup-status" class="startup-status" role="status">Vérification du démarrage automatique…</div>
      </section>
      <section class="startup-prefs" aria-label="Notifications sonores">
        <h3>🔔 Notifications des demandes</h3>
        <p class="notice">Un ding.mp3 à l'arrivée du coursier, puis un rappel toutes les 2 minutes jusqu'à l'ouverture de sa demande.</p>
        <button id="test-ding" class="overlay-action neutral" type="button">▶ Tester le son</button>
        <div id="sound-status" class="startup-status" role="status"></div>
      </section>
      <p>État : <strong>${escapeHtml(network.mode === "host" ? "Serveur" : network.mode === "client" ? "Client" : "Hors ligne")}</strong></p>
      <div class="notice">🔒 Prototype LAN : code partagé, mais communications <b>non chiffrées</b>. À utiliser seulement sur un réseau de test autorisé, sans données confidentielles. Aucun port Internet à ouvrir.</div>
      <label>Port TCP
        <input type="number" id="net-port" min="1024" max="65535" value="${network.port || 39427}" />
      </label>
      <label>Code partagé (12 caractères minimum)
        <input type="password" id="net-secret" placeholder="Même code sur tous les PC" autocomplete="new-password" />
      </label>
      <label>Adresse IP du PC serveur (pour les clients)
        <input id="net-address" placeholder="Ex. 192.168.1.50" value="${escapeHtml(network.mode === "client" ? network.address.split(":")[0] : "")}" />
      </label>
      <div id="form-error" class="form-error">${escapeHtml(networkError)}</div>
      <div class="network-buttons">
        <button id="net-host" class="overlay-action primary">Héberger sur ce PC</button>
        <button id="net-client" class="overlay-action primary">Se connecter au serveur</button>
        <button id="net-off" class="overlay-action danger">Se déconnecter</button>
      </div>
      <p class="notice">Sur le PC serveur, lance <code>ipconfig</code> dans PowerShell pour trouver son adresse IPv4. Les autres PC indiquent cette adresse, le même port et le même code.</p>
    </div>
  `, [{ label: "Fermer", onClick: closeOverlay }]);
  const startupToggle = overlayBody.querySelector<HTMLInputElement>("#startup-toggle")!;
  const startupStatus = overlayBody.querySelector<HTMLDivElement>("#startup-status")!;
  if (import.meta.env.DEV) {
    startupToggle.disabled = true;
    startupStatus.textContent = "Teste cette option après installation de la version release : elle n'enregistrera pas le binaire temporaire de tauri dev.";
  } else {
    void invoke<boolean>("autostart_status")
      .then(enabled => {
        if (!startupToggle.isConnected) return;
        startupToggle.checked = enabled;
        startupStatus.textContent = enabled ? "✓ Pixel Office démarrera avec Windows." : "Démarrage avec Windows désactivé.";
      })
      .catch(error => { startupStatus.textContent = `État indisponible : ${String(error)}`; });
    startupToggle.onchange = async () => {
      const desired = startupToggle.checked;
      startupToggle.disabled = true;
      startupStatus.textContent = "Enregistrement du paramètre Windows…";
      try {
        const actual = await invoke<boolean>("autostart_set", { enabled: desired });
        startupToggle.checked = actual;
        startupStatus.textContent = actual
          ? "✓ Activé : Pixel Office s'ouvrira au premier plan à la prochaine connexion Windows."
          : "Désactivé : Pixel Office ne sera plus lancé par Windows.";
      } catch (error) {
        startupToggle.checked = !desired;
        startupStatus.textContent = `Impossible de changer ce réglage : ${String(error)}`;
      } finally {
        startupToggle.disabled = false;
      }
    };
  }
  overlayBody.querySelector<HTMLButtonElement>("#test-ding")!.onclick = () => {
    const played = testNotificationSound(game);
    const status = overlayBody.querySelector<HTMLDivElement>("#sound-status")!;
    status.textContent = played ? "Lecture du son demandée." : "Son indisponible : vérifie public/sounds/ding.mp3 et relance Pixel Office.";
  };
  const portEl = overlayBody.querySelector<HTMLInputElement>("#net-port")!;
  const secretEl = overlayBody.querySelector<HTMLInputElement>("#net-secret")!;
  const addressEl = overlayBody.querySelector<HTMLInputElement>("#net-address")!;
  const runNetwork = async (command: string, args: Record<string, unknown>) => {
    try {
      await invoke(command, args);
      networkError = "";
      networkVerified = false;
      await refreshNetworkStatus();
      closeOverlay();
      void networkTick();
    } catch (error) { textError(error); }
  };
  overlayBody.querySelector<HTMLButtonElement>("#net-host")!.onclick = () => {
    void runNetwork("network_host", { port: Number(portEl.value), secret: secretEl.value });
  };
  overlayBody.querySelector<HTMLButtonElement>("#net-client")!.onclick = () => {
    void runNetwork("network_connect", { host: addressEl.value, port: Number(portEl.value), secret: secretEl.value });
  };
  overlayBody.querySelector<HTMLButtonElement>("#net-off")!.onclick = () => {
    void runNetwork("network_disconnect", {});
  };
}

async function networkTick() {
  if (!username || tickBusy) return;
  tickBusy = true;
  try {
    await invoke("network_tick");
    networkVerified = true;
    networkError = "";
    await refreshRequests();
  } catch (error) {
    networkVerified = false;
    networkError = String(error);
    console.warn("Synchronisation LAN :", networkError);
  } finally {
    updateIndicator();
    tickBusy = false;
  }
}

document.querySelector("#overlay-close")!.addEventListener("click", closeOverlay);
overlay.addEventListener("click", e => { if (e.target === overlay) closeOverlay(); });
document.addEventListener("keydown", e => { if (e.key === "Escape") closeOverlay(); });
document.querySelector("#settings")!.addEventListener("click", openSettings);
networkIndicator.addEventListener("click", openSettings);
document.querySelector("#open-inbox")!.addEventListener("click", () => listInbox());
document.querySelector("#open-sent")!.addEventListener("click", () => listInbox(true));
document.querySelector("#open-compose")!.addEventListener("click", () => composeRequest());

const container = document.querySelector<HTMLElement>("#game-container")!;
const game = startGame(container, {
  onOpenCentralDesk: () => composeRequest(),
  onOpenPersonalDesk: () => listInbox(),
  onOpenRequest: showRequest
});
game.events.on("pixel-office:ready", () => {
  renderTasks();
});

// Preserve all window commands and user settings from v0.3.
document.querySelector("#drag")!.addEventListener("mousedown", event => {
  if ((event as MouseEvent).button === 0) appWindow.startDragging().catch(reportError);
});
document.querySelector("#minimize")!.addEventListener("click", () => appWindow.minimize().catch(reportError));
document.querySelector("#close")!.addEventListener("click", () => appWindow.close().catch(reportError));
document.querySelector("#reset")!.addEventListener("click", () => invoke("reset_window").catch(reportError));
document.querySelector("#resize")!.addEventListener("mousedown", event => {
  if ((event as MouseEvent).button === 0) appWindow.startResizeDragging("SouthEast").catch(reportError);
});

void (async () => {
  try {
    username = await invoke<string>("get_profile");
    await refreshNetworkStatus();
    if (!username) openProfileSetup();
    else await refreshRequests();
  } catch (error) { reportError(error); }
})();
// À l'ouverture de session Windows, demander à nouveau le focus une fois la page prête.
void invoke("focus_on_autostart").catch(error => console.warn("Fenêtre au démarrage :", error));
// The UI polls its local SQLite mailbox. On the host, this also picks up messages
// accepted by the TCP listener; on clients, it also pushes queued messages.
window.setInterval(() => { void networkTick(); }, 3000);