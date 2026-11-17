// Mises à jour Windows / LAN. Indépendant du rendu Phaser et de la boîte SQLite.
import { invoke } from "@tauri-apps/api/core";
import { getVersion } from "@tauri-apps/api/app";

type UpdateStatus = {
  serverEnabled: boolean;
  serverPort: number;
  remoteHost: string;
  remotePort: number;
  publishedVersion: string | null;
};
type AvailableUpdate = { version: string; notes: string };

let available: AvailableUpdate | null = null;
let checking = false;
let installing = false;
let started = false;
let announcement = "";
const UPDATE_INTERVAL_MS = 90_000;

function elem<K extends keyof HTMLElementTagNameMap>(name: K, text?: string) {
  const el = document.createElement(name);
  if (text !== undefined) el.textContent = text;
  return el;
}
function button(text: string, callback: () => void | Promise<void>) {
  const b = elem("button", text);
  b.type = "button";
  b.className = "update-btn";
  b.onclick = () => { void Promise.resolve(callback()).catch(e => { announce(String(e)); }); };
  return b;
}
function announce(text: string) {
  announcement = text;
  const msg = document.querySelector<HTMLElement>("#update-message");
  if (msg) msg.textContent = text;
  console.info("Pixel Office Update:", text);
}

function createUI() {
  if (document.getElementById("update-action")) return;
  const controls = document.querySelector<HTMLElement>(".controls");
  if (!controls) return;
  const open = button("⬆ MAJ", openPanel);
  open.id = "update-action";
  open.title = "Mises à jour de Pixel Office";
  open.style.cssText = "width:80px;font-size:12px;font-weight:bold;color:#b9e8c8;";
  controls.insertBefore(open, document.getElementById("minimize"));

  const css = elem("style");
  css.textContent = `
    #update-modal { position:fixed; inset:0; display:none; z-index:10000;
      background:#090e16bb; justify-content:center; align-items:center; padding:12px;
      color:#e5eaf2; font:13px Segoe UI, sans-serif; }
    #update-modal.visible {display:flex}
    #update-modal .update-card {background:#222f3d;border:1px solid #69859d;
      box-shadow:0 8px 30px #0009; padding:20px; width:min(490px,100%);
      max-height:92vh; overflow:auto; display:flex; flex-direction:column; gap:10px;}
    #update-modal h3 {margin:0 0 4px;font-size:16px;}
    #update-modal label {display:flex;flex-direction:column;gap:4px;}
    #update-modal input,#update-modal textarea {font:inherit;color:#f5f6f9;
      background:#131b24;border:1px solid #54677c;padding:8px;width:100%;}
    #update-modal .update-btn {background:#3e6885;border:1px solid #6993b0;
      color:#fff;padding:8px 11px;cursor:pointer;}
    #update-modal .update-btn:hover {background:#517d9e}
    #update-modal .update-muted {color:#adbfcd;font-size:12px;line-height:1.5}
    #update-modal .update-row {display:flex;flex-wrap:wrap;gap:8px;align-items:center}
    #update-modal .update-separator {border-top:1px solid #445568;margin:5px 0}
    #update-modal .update-check {display:flex;flex-direction:row;align-items:center}
    #update-modal .update-check input {width:auto}
    #update-modal #update-message {white-space:pre-wrap;color:#e5d49b;}
  `;
  document.head.append(css);

  const modal = elem("div");
  modal.id = "update-modal";
  modal.onclick = e => { if (e.target === modal) closePanel(); };
  document.body.append(modal);
}

function closePanel() {
  document.getElementById("update-modal")?.classList.remove("visible");
}
function field(label: string, id: string, value: string, multiline = false) {
  const wrap = elem("label", label);
  const input = multiline ? elem("textarea") : elem("input");
  input.id = id;
  input.value = value;
  wrap.append(input);
  return wrap;
}
function inputValue(id: string): string {
  const input = document.getElementById(id) as HTMLInputElement | HTMLTextAreaElement | null;
  return input?.value || "";
}

async function openPanel() {
  const modal = document.querySelector<HTMLElement>("#update-modal")!;
  modal.replaceChildren();
  const card = elem("div");
  card.className = "update-card";
  modal.append(card);
  const header = elem("div");
  header.className = "update-row";
  header.append(elem("h3", "⬆ Pixel Office — Mises à jour"), button("✕", closePanel));
  card.append(header);

  const status = await invoke<UpdateStatus>("updates_status");
  const description = status.serverEnabled
    ? `PC serveur : publication sur le port ${status.serverPort}.`
    : status.remoteHost
      ? `Serveur de mises à jour : ${status.remoteHost}:${status.remotePort}`
      : "Connecte Pixel Office au réseau LAN au moins une fois.";
  const info = elem("p", description);
  info.className = "update-muted";
  card.append(info);
  if (status.publishedVersion) {
    card.append(elem("div", `Version publiée : ${status.publishedVersion}`));
  }
  if (available) card.append(elem("div", `Nouvelle version disponible : ${available.version}`));
  const row = elem("div");
  row.className = "update-row";
  row.append(button("Vérifier maintenant", async () => {
    await checkUpdates(false);
    await openPanel();
  }));
  if (available) row.append(button(`Installer ${available.version}`, () => installUpdate()));
  card.append(row);

  const auto = elem("label");
  auto.className = "update-check update-muted";
  const checkbox = elem("input");
  checkbox.type = "checkbox";
  checkbox.checked = localStorage.getItem("pixel-office:auto-update") !== "off";
  checkbox.onchange = () => localStorage.setItem("pixel-office:auto-update", checkbox.checked ? "on" : "off");
  auto.append(checkbox, document.createTextNode("Installer automatiquement les MAJ au démarrage"));
  card.append(auto);

  if (status.serverEnabled) {
    const separator = elem("div");
    separator.className = "update-separator";
    card.append(separator);
    card.append(elem("h3", "Publication — PC serveur uniquement"));
    card.append(field("Version (exemple 0.4.3)", "update-version", "0.4.3"));
    card.append(field("Chemin COMPLET de l'installateur NSIS signé (.exe)", "update-path", ""));
    card.append(field("Nouveautés", "update-notes", "Corrections et améliorations de Pixel Office.", true));
    const notice = elem("div", "Le fichier .exe.sig doit être dans le même dossier que le .exe. Publie uniquement une version que tu as compilée et signée toi-même.");
    notice.className = "update-muted";
    card.append(notice);
    card.append(button("📤 Publier sur le LAN", async () => {
      const result = await invoke<string>("updates_publish", {
        installerPath: inputValue("update-path"),
        version: inputValue("update-version"),
        notes: inputValue("update-notes")
      });
      announce(result);
    }));
  }
  const uninstallInfo = elem("div", "Un installateur Windows NSIS fournit aussi une désinstallation depuis les Paramètres de Windows. Les données SQLite sont conservées séparément.");
  uninstallInfo.className = "update-muted";
  card.append(uninstallInfo);
  const message = elem("div", announcement);
  message.id = "update-message";
  card.append(message);
  modal.classList.add("visible");
}

async function syncUpdateServer() {
  try { await invoke("updates_sync_server"); }
  catch (error) { console.warn("Serveur MAJ LAN :", error); }
}

async function checkUpdates(autoInstall: boolean) {
  if (checking || installing) return;
  checking = true;
  try {
    available = await invoke<AvailableUpdate | null>("updates_check");
    const badge = document.getElementById("update-action");
    if (badge) badge.textContent = available ? "⬆ MAJ !" : "⬆ MAJ";
    if (available) {
      announce(`Version ${available.version} disponible. ${available.notes}`);
      if (autoInstall && localStorage.getItem("pixel-office:auto-update") !== "off") {
        await installUpdate();
      }
    } else if (!autoInstall) announce("Pixel Office est à jour.");
  } catch (error) {
    if (!autoInstall) announce(`Vérification impossible : ${String(error)}`);
  } finally { checking = false; }
}

async function installUpdate() {
  if (installing) return;
  installing = true;
  announce("Téléchargement et installation de la version signée… Pixel Office va se fermer sur Windows.");
  try {
    await invoke<string>("updates_install");
    announce("Installation lancée. Redémarre Pixel Office si nécessaire.");
  } catch (error) {
    announce(`Installation échouée : ${String(error)}`);
  } finally { installing = false; }
}

function boot() {
  if (started) return;
  started = true;
  createUI();
  void getVersion().then(version => {
    const versionTag = document.querySelector<HTMLElement>(".version");
    if (versionTag) versionTag.textContent = `v${version}`;
  }).catch(() => {});
  void (async () => {
    await syncUpdateServer();
    // Au démarrage, appliquer automatiquement les mises à jour disponibles.
    await checkUpdates(true);
  })();
  window.setInterval(() => { void syncUpdateServer(); }, 8_000);
  window.setInterval(() => { void checkUpdates(false); }, UPDATE_INTERVAL_MS);
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", boot, { once: true });
} else {
  boot();
}