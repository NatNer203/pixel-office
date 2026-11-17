# PIXEL OFFICE v0.4.0 — demandes, SQLite et synchronisation LAN

Projet Tauri 2 + TypeScript + Phaser 3, adapté depuis `pixel-office-versionX.zip`.

## Démarrage (Windows 11)

Ouvre PowerShell dans ce dossier :

```powershell
fnm env --use-on-cd | Out-String | Invoke-Expression
fnm use 24
npm.cmd install
npm.cmd run tauri dev
```

Si `fnm` est déjà actif, les deux premières commandes ne sont pas nécessaires.
L'ajout de SQLite utilise `rusqlite` avec la fonctionnalité `bundled`. Cargo téléchargera de nouvelles dépendances à la première compilation Rust. Sur les PC configurés avec `x86_64-pc-windows-gnu`, conserve ton compilateur GCC MSYS2/UCRT64 dans le `PATH` du terminal.

## Premier lancement

1. Choisis le nom d'utilisateur du PC (`lucas`, `sarah`, `yanis`, etc., ou un autre nom en ASCII).
2. Chaque PC doit utiliser un **nom distinct**. Par sécurité, le nom ne peut pas être renommé depuis l'interface après création.
3. Clique sur le grand comptoir **ACCUEIL** pour créer une demande : destinataire, sujet, message et jusqu'à 4 pièces jointes.
4. La demande est sauvegardée immédiatement dans **SQLite**, même hors ligne.
5. Un PNJ part du bureau central vers le bureau correspondant dans l'interface de l'expéditeur.
6. Lorsqu'une demande arrive sur un PC destinataire, un PNJ avec colis se dirige vers son **guichet**. Clique dessus pour lire la feuille.
7. Depuis la feuille : **Répondre**, **Épingler/Désépingler**, **Archiver/Restaurer**. L'archivage est **local**, il n'efface pas le message chez les collègues.
8. Les tâches épinglées sont sauvegardées dans SQLite et restent après redémarrage.

## Tester la synchronisation sur deux PC

**PC A (serveur, exemple : Lucas)** :

1. Ouvre ⚙, indique un code partagé d'au moins 12 caractères et laisse le port **39427**.
2. Clique **Héberger sur ce PC**.
3. Tape `ipconfig` dans PowerShell pour repérer l'adresse IPv4 du PC A sur le LAN (par exemple `192.168.1.50`).

**PC B (client, exemple : Sarah)** :

1. Ouvre ⚙ et indique l'adresse du PC A, le port **39427** et **exactement le même code partagé**.
2. Clique **Se connecter au serveur**. Si la connexion réussit, l'indicateur passe à **Connecté** après une synchronisation.
3. Clique **ACCUEIL**, envoie une demande à `lucas`.
4. Sur le PC A, sous quelques secondes, un PNJ devrait apporter le colis au guichet.
5. Clique sur le PNJ ou **Mon guichet** : lis la demande, épingle-la ou réponds à `sarah`.
6. Sur le PC B, la réponse devrait arriver au guichet.
7. Pour tester le mode hors ligne, déconnecte le client, envoie une nouvelle demande, puis reconnecte-le : la demande conservée en SQLite est envoyée ensuite.

Le **serveur doit être allumé** pour relayer les messages. Chaque client conserve ses données localement et synchronise environ toutes les 3 secondes. Le mode réseau ne s'active pas automatiquement au redémarrage : il faut remettre le code et se reconnecter.

## Stockage

- Base SQLite créée automatiquement dans le **dossier de données de l'application** (`app_data_dir` de Tauri), sous le nom `pixel-office.sqlite3`.
- La sauvegarde de géométrie de fenêtre d'origine est conservée (`window.txt`).
- Structure de données : `settings`, `requests`, `flags` ; identifiants uniques et messages idempotents.
- Les pièces jointes sont stockées dans SQLite en data URLs encodées : jusqu'à **4 fichiers**, **1,5 Mo chacun**, **3,5 Mo au total** côté interface.
- Pour sauvegarder une copie de ta base, ferme l'application avant de copier `pixel-office.sqlite3` et ses éventuels fichiers SQLite `-wal` et `-shm`.

## ⚠️ Limites importantes du prototype LAN

- **Non chiffré** : le contenu des demandes, les pièces jointes et le code partagé traversent le réseau local en clair.
- **Pas d'identité forte par utilisateur** : une personne ayant le code commun peut techniquement se présenter sous le nom d'un autre utilisateur.
- **Pas de découverte automatique** des PC, ni TLS/mTLS, ni contrôle central des droits.
- Le protocole utilise du **TCP privé** avec des paquets JSON à longueur préfixée, et **pas** des WebSockets/HTTP.
- Les noms des six bureaux graphiques sont pour l'instant fixes et ne constituent pas une liste d'utilisateurs authentifiée.
- Le bouton **Archiver** cache la demande sur cet ordinateur ; il n'effectue pas de suppression distribuée.
- Le programme ne doit **pas** être exposé sur Internet ni utilisé avec des données sensibles/professionnelles sans couche d'authentification et de chiffrement, revue de sécurité et autorisation de l'équipe IT.
- Sur les machines d'entreprise, le pare-feu Windows ou la politique réseau peut bloquer le port TCP entrant. Ne change pas ces politiques sans accord administratif.

## Organisation des fichiers ajoutés/modifiés

- `src/main.ts` : interface, vrais formulaires, lecture de demandes, paramètres de connexion.
- `src/types.ts` : types de données partagés côté TypeScript.
- `src/game.ts` : sprites et mouvements réels des coursiers entrant/sortant.
- `src/style.css` : feuille papier, formulaire et menus.
- `src-tauri/src/backend.rs` : stockage SQLite + relais TCP LAN + commandes Tauri.
- `src-tauri/src/lib.rs` : enregistrement de l'état/commandes, conserve la fenêtre existante.
- `src-tauri/Cargo.toml` : dépendance `rusqlite` (SQLite embarqué).

## Vérifications effectuées ici

- Vérification TypeScript avec `tsc --noEmit` : **OK**.
- Requêtes SQLite de lecture et de synchronisation vérifiées via `sqlite3` : **OK**.
- **Compilation Rust/Tauri et essai entre deux Windows non réalisés** : l'environnement de préparation ne dispose pas de Rust ni du moteur WebView2 Windows. Il faut valider `npm.cmd run tauri dev` et les échanges sur tes machines.
