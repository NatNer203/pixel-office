# PIXEL OFFICE
## Guide d’utilisation et d’administration — version 0.4.2

**Destinataires :** collaborateurs, référent informatique, responsable des mises à jour.  
**Plateforme :** Windows x64 — application Tauri / bureau pixel art.  
**Édition :** 17 novembre 2026.  
**Statut :** guide fondé sur le code et les instructions de la v0.4.2 fournis pour ce projet. **La compilation native, le déploiement LAN et les mises à jour sur plusieurs PC restent à valider en conditions réelles.**

> **À retenir :** Pixel Office est un prototype de communication sur réseau local. Les demandes et pièces jointes ne sont **pas chiffrées en transit** ; le code partagé n’est pas une authentification forte. L’entreprise doit approuver l’utilisation, les ports et la politique de données avant tout déploiement professionnel. Ne pas y mettre de données confidentielles à ce stade.

---

# PARTIE A — POUR TOUS LES UTILISATEURS

## 1. À quoi sert Pixel Office ?

Pixel Office représente une équipe dans un petit bureau pixel art. On peut adresser des demandes à un collègue, les recevoir au guichet, répondre, joindre des fichiers et épingler les éléments importants. Des PNJ/coursiers symbolisent les livraisons. Une base SQLite locale conserve les demandes et les paramètres de l’application.

### Repères dans la fenêtre

| Élément visible | À quoi il sert |
|---|---|
| **📦 Mon guichet** | Afficher les demandes reçues, ouvrir une feuille et consulter les pièces jointes. |
| **✉ Nouvelle demande** | Préparer un message adressé à un collègue. |
| **↗ Demandes envoyées** | Retrouver ses envois. |
| **Tâches épinglées** | Garder certaines demandes visibles dans le volet latéral. |
| **⚙ Paramètres** | Consulter le profil, se connecter au LAN, régler le démarrage Windows et tester le son. |
| **● Hors ligne / Serveur LAN / Connexion…** | Voir l’état du réseau ; un clic ouvre les paramètres. |
| **⬆ MAJ** | Vérifier les nouvelles versions ; sur le serveur principal, publier une version signée. |
| **− / ▣ / ×** | Réduire, remettre la position de la fenêtre par défaut, fermer. |

Le bureau central permet aussi de créer une demande et le guichet personnel ouvre la boîte de réception. La fenêtre est déplaçable et redimensionnable.

## 2. Première utilisation

1. Le service informatique installe **Pixel Office** avec son installateur Windows `*-setup.exe`.
2. Au premier lancement, choisir **un nom de profil local unique**, différent de celui des collègues. Le code attend un nom simple : lettres minuscules, chiffres, tiret ou `_`, de 2 à 24 caractères.
3. Ouvrir **⚙ Paramètres**. Si le réseau est déjà configuré par l’administrateur, vérifier que la connexion fonctionne ; sinon suivre la procédure réseau de la partie B.
4. Cliquer sur **Mon guichet** pour voir les demandes, ou sur **Nouvelle demande** pour envoyer un premier message de test.

**Attention :** le nom du profil est présenté comme fixe dans l’interface actuelle. Choisir le bon nom dès le départ ; éviter deux postes portant le même nom.

## 3. Envoyer une demande

1. Cliquer sur **✉ Nouvelle demande** ou sur le bureau central.
2. Saisir le **destinataire** (son nom de profil), le **sujet** et le **contenu**.
3. Ajouter si besoin des pièces jointes : **4 au maximum**, **1,5 Mo chacune** et **3,5 Mo au total**.
4. Cliquer sur **📦 Confier au coursier**.
5. Retrouver l’envoi dans **↗ Demandes envoyées**.

Si la connexion est interrompue, l’envoi reste localement en attente dans SQLite. La feuille peut afficher **« En attente de synchronisation réseau »** ; la transmission sera retentée lors de la synchronisation. Ne pas supposer qu’un destinataire a reçu une demande avant d’avoir vérifié le réseau.

## 4. Lire, répondre et organiser

1. Lorsqu’un coursier arrive au guichet, cliquer sur le PNJ ou sur **📦 Mon guichet**.
2. Cliquer sur la demande pour ouvrir sa **feuille** (expéditeur, destinataire, date, sujet, texte, fichiers).
3. Utiliser **⬇ [nom de fichier]** pour enregistrer une pièce jointe ; les images PNG/JPEG/GIF/WebP peuvent être prévisualisées.
4. Choisir **↩ Répondre**, **📌 Épingler** ou **Archiver**, selon le besoin. Une demande archivée n’est plus dans la liste courante et peut être restaurée depuis sa feuille lorsqu’elle est accessible.

**Son de notification :** à l’arrivée d’un coursier avec une demande non consultée, l’application tente de jouer `ding.mp3`, puis de rappeler **toutes les 2 minutes** jusqu’à l’ouverture de la feuille. L’ouverture enregistre normalement la lecture en SQLite ; la demande reste dans la liste. Le son dépend des autorisations audio de Windows/WebView et de la présence réelle du fichier dans l’application installée.

## 5. Régler le démarrage avec Windows

1. Ouvrir **⚙ Paramètres**.
2. Activer **« Démarrer Pixel Office à l’ouverture de ma session Windows et afficher sa fenêtre au premier plan »**.
3. Pour annuler, désactiver le même commutateur.

Ce choix est **désactivé par défaut** et ne s’applique qu’au compte Windows courant. La fonction est désactivée lors des essais `tauri dev` ; la tester avec l’application **installée**. Pixel Office demande à Windows de mettre sa fenêtre en avant, mais Windows peut refuser de lui donner le focus. **Ce réglage ne lance pas forcément l’hébergement du serveur de demandes : le rôle « Héberger sur ce PC » peut devoir être réactivé après redémarrage.**

Dans **⚙ Paramètres**, le bouton **▶ Tester le son** sert à vérifier `ding.mp3`.

## 6. Quitter ou désinstaller

Fermer avec **×**. Pour désinstaller : **Paramètres Windows → Applications → Applications installées → Pixel Office → Désinstaller**. Le mécanisme est fourni par l’installateur NSIS ; les données SQLite et paramètres enregistrés dans AppData sont normalement **conservés**. Demander au service informatique avant toute suppression manuelle des données résiduelles.

---

# PARTIE B — POUR LE RÉFÉRENT INFORMATIQUE / ADMINISTRATEUR

## 7. Architecture du réseau local

```text
                  Réseau local autorisé (LAN)
      ┌─────────────────────────────────────────┐
      │ PC principal — Pixel Office             │
      │ • Serveur de demandes : TCP 39427       │
      │ • Serveur de mises à jour : HTTP 39428  │
      └───────────────┬─────────────────────────┘
                      │
          ┌───────────┴───────────┐
          │                       │
   PC collègue A           PC collègue B
   • Client LAN            • Client LAN
   • Base SQLite locale    • Base SQLite locale
   • MAJ signées           • MAJ signées
```

Les ports indiqués sont les **valeurs par défaut**. Le service de mises à jour utilise le port de demandes **+ 1** (39428 lorsque le port des demandes est 39427). Les clients doivent pouvoir joindre le serveur. L’équipe informatique doit contrôler les règles de pare-feu et éviter toute exposition à Internet. Le prototype de mise à jour utilise **HTTP sans chiffrement**, avec contrôle de signature des paquets.

## 8. Installer et connecter les postes

### Sur le PC principal

1. Installer la **même version de Pixel Office** que sur les clients.
2. Lancer Pixel Office, choisir un profil unique.
3. Ouvrir **⚙ Paramètres**.
4. Choisir le port **39427** (ou le port convenu avec l’IT).
5. Choisir un **code partagé d’au moins 12 caractères**, à communiquer par un moyen interne approuvé, sans l’inclure dans la documentation distribuée.
6. Cliquer **« Héberger sur ce PC »**. L’indicateur doit afficher **Serveur LAN**. Le service HTTP de mises à jour est lié au rôle serveur.
7. Dans PowerShell, utiliser `ipconfig` pour relever l’**IPv4 du PC principal** accessible par les clients.

### Sur chaque PC client

1. Installer Pixel Office et créer un **profil unique**.
2. Ouvrir **⚙ Paramètres**, saisir le même **port**, le même **code partagé** et l’**IPv4 du PC principal**.
3. Cliquer **« Se connecter au serveur »**.
4. Tester une demande simple entre deux profils. L’adresse du serveur de mises à jour est mémorisée après la connexion initiale.

**À vérifier après redémarrage du PC principal :** l’hébergement des **demandes** peut nécessiter un nouveau clic sur **« Héberger sur ce PC »**, même si le serveur de mises à jour se relance selon sa configuration enregistrée. Ne pas confondre ces deux services.

## 9. Diffuser une mise à jour à tous les clients

**Une première installation manuelle est nécessaire** sur les postes qui ne disposent pas encore du système de mises à jour. Les mises à jour LAN concernent la version **Windows x64 installée avec NSIS**, pas `tauri dev`.

### Étape 1 — Préparer la nouvelle version sur le PC de développement

1. Sauvegarder le projet et tester les modifications.
2. Augmenter le numéro de version **dans les trois fichiers** : `package.json`, `src-tauri/Cargo.toml` et `src-tauri/tauri.conf.json`. Les valeurs doivent correspondre (exemple **0.4.2 → 0.4.3**).
3. Garder **exactement la même paire de clés Tauri** que lors de la première version distribuée. Conserver la clé privée et son mot de passe **hors du projet**.
4. Vérifier que `src-tauri/tauri.conf.json` contient la **clé publique encodée**, et non un chemin ni une valeur vide (`"pubkey": ""`).
5. Compiler avec les commandes ci-dessous, dans PowerShell à la racine du projet :

```powershell
$env:TAURI_SIGNING_PRIVATE_KEY = "$HOME\.tauri\pixel-office.key"
$secure = Read-Host "Mot de passe de ta clé" -AsSecureString
$env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD = [System.Net.NetworkCredential]::new("", $secure).Password
npm.cmd run tauri build
```

6. Vérifier que la compilation **se termine sans erreur**, et que ce dossier contient **les deux fichiers** :

```text
src-tauri\target\release\bundle\nsis\
  pixel-office_0.4.3_x64-setup.exe
  pixel-office_0.4.3_x64-setup.exe.sig
```

Les noms sont indicatifs : utiliser ceux réellement générés. **La présence de l’installateur seul ne suffit pas** : si la commande termine par une erreur de signature, la version **n’est pas prête à être publiée**.

7. Nettoyer les variables de signature après usage :

```powershell
Remove-Item Env:TAURI_SIGNING_PRIVATE_KEY -ErrorAction SilentlyContinue
Remove-Item Env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD -ErrorAction SilentlyContinue
```

### Étape 2 — Publier depuis le PC principal

1. Copier **le nouvel `.exe` et son `.exe.sig`** sur le PC principal, dans **le même dossier**.
2. Sur le PC principal, lancer l’hébergement si nécessaire : **⚙ → Héberger sur ce PC**.
3. Cliquer sur **⬆ MAJ**. La rubrique **« Publication — PC serveur uniquement »** doit apparaître.
4. Renseigner : **version** exacte (par exemple `0.4.3`), **chemin absolu Windows du fichier `.exe` présent sur ce PC**, et **notes de version**.
5. Cliquer sur **📤 Publier sur le LAN** et lire le message de confirmation ou d’erreur.
6. Vérifier sur **un seul PC pilote** avec **⬆ MAJ → Vérifier maintenant**, avant d’étendre l’opération aux autres.

### Étape 3 — Installation sur les clients

- Au lancement, un client déjà connecté au LAN peut vérifier puis **installer automatiquement** une version supérieure si l’option **« Installer automatiquement les MAJ au démarrage »** est activée (réglage activé par défaut dans l’interface de cette version).
- En cours de session, les nouvelles versions sont **signalées** ; l’utilisateur peut aller dans **⬆ MAJ → Installer [version]**. Il faut prévenir les collègues car l’installateur peut fermer ou redémarrer Pixel Office.
- Pour éviter l’automatisme, chaque client peut désactiver **« Installer automatiquement les MAJ au démarrage »** depuis **⬆ MAJ**.
- Après installation, contrôler le numéro de version affiché, la connexion au LAN, la lecture d’une demande et la persistance des données.

**Point important :** cliquer sur « Publier » ne force pas immédiatement le redémarrage de tous les PC. Les clients doivent être connectés et effectuer leur vérification/installation ; des PC éteints ou hors réseau restent sur l’ancienne version jusqu’à leur retour.

## 10. Éviter les erreurs de signature et de compilation

| Symptôme | Cause probable / action |
|---|---|
| `Missing comment in public key` | Dans `src-tauri/tauri.conf.json`, le champ `plugins.updater.pubkey` est vide ou incorrect. Y mettre le **contenu** du `.key.pub`, jamais le chemin du fichier. |
| `expected value at line 1 column 1` | Certains Windows PowerShell enregistrent le JSON en **UTF-8 avec BOM**. Réenregistrer `tauri.conf.json` en **UTF-8 sans BOM** dans VS Code ou avec une API .NET appropriée. |
| `Finished 1 bundle`, puis erreur | L’installateur peut avoir été créé, **mais la signature et la compilation complète ont échoué**. Ne pas distribuer comme mise à jour automatique. |
| La version affichée est incohérente | Vérifier les trois numéros de version dans `package.json`, `Cargo.toml` et `tauri.conf.json`. |
| Client ne voit pas la MAJ | Vérifier que le PC serveur héberge, que le client connaît son adresse, que le port HTTP (39428 par défaut) est autorisé et que la version publiée est supérieure. |
| MAJ refusée par signature | Vérifier les fichiers `.exe` et `.sig`, et l’identité de la **clé privée ayant signé** le paquet ; ne pas régénérer la clé pour « réparer ». |
| Le bouton MAJ fonctionne en développement mais n’installe rien | L’installation automatique ne concerne que les versions NSIS installées. |
| Avertissement Vite sur 500 kB | Avertissement sur la taille JavaScript ; ce n’est normalement pas une erreur bloquante. |
| Avertissement sur `com.pixeloffice.app` | Identifiant déconseillé notamment pour macOS ; ne pas le changer à la légère après distribution sans plan de migration. |

## 11. Diagnostic des demandes, du son et du démarrage

**Les demandes n’arrivent pas :** vérifier l’indicateur réseau, l’IP, le port, le code partagé, l’état du serveur et les règles de pare-feu. Si une demande mentionne une synchronisation en attente, vérifier la reconnexion avant de la renvoyer manuellement pour éviter les doublons.

**Le PNJ ne joue aucun son :** ouvrir **⚙ → ▶ Tester le son**, vérifier les paramètres de volume Windows, puis la présence du fichier `public/sounds/ding.mp3` **au moment de la compilation**. Un fichier ajouté uniquement dans le dossier de développement *après* la compilation ne figure pas nécessairement dans l’application installée. Certains moteurs WebView bloquent l’audio tant que l’utilisateur n’a pas interagi avec l’interface.

**Le PNJ continue de sonner après lecture :** la fonction `mark_request_viewed` doit être enregistrée dans le gestionnaire de commandes Tauri. **Dans un journal de compilation de la v0.4.2 transmis pendant le développement, Rust indiquait `function mark_request_viewed is never used`.** Faire vérifier ce branchement et tester une vraie demande avant le déploiement : l’enregistrement de la lecture et l’arrêt du rappel ne sont pas encore confirmés sur une version installée.

**L’application ne démarre pas avec Windows :** utiliser une version installée, activer le commutateur dans **⚙**, vérifier les paramètres Windows des applications au démarrage et la politique IT. Windows ne garantit pas que la fenêtre prendra le focus dans toutes les situations.

**Les mises à jour sont indisponibles après redémarrage du serveur :** vérifier séparément la disponibilité du port des demandes et celle du service HTTP de mises à jour. Le statut du serveur de mises à jour peut être restauré sans que l’hébergement des demandes soit actif.

## 12. Sauvegardes, sécurité et passation à l’entreprise

### Sauvegardes conseillées

- Conserver un **exemplaire du code source**, des dépendances verrouillées, et du dernier installateur **avec sa signature `.sig`**.
- Conserver la **clé privée de signature et son mot de passe** dans un coffre-fort ou dispositif approuvé, avec accès très limité. **Jamais** dans un partage LAN, un ZIP transmis aux utilisateurs ou un dépôt Git.
- Définir une procédure de sauvegarde des données SQLite des utilisateurs, si le service informatique décide de conserver des données professionnelles ; valider les modalités de sauvegarde/restauration avant utilisation.
- Prévoir un **PC serveur identifié**, une IPv4 stable ou une réservation DHCP et une personne responsable du suivi des versions.

### Contrôles obligatoires avant la mise en production

1. Tester la synchronisation sur **deux postes réels**, notamment en cas de coupure du réseau.
2. Tester une **mise à jour signée** de bout en bout : 0.4.2 → version suivante, installation et conservation des données.
3. Corriger/valider le traitement `mark_request_viewed` et le son sur une application Windows installée.
4. Vérifier les règles de pare-feu, le chiffrement et l’authentification. **Le prototype LAN ne convient pas à des informations confidentielles.**
5. Faire approuver la diffusion de l’installateur, l’exécution au démarrage, la gestion des mises à jour et les opérations de désinstallation par l’équipe informatique.
6. Définir qui peut publier une nouvelle version : dans le prototype, **la publication n’est pas protégée par une identité d’administrateur distincte**. L’accès au PC serveur doit donc être strictement contrôlé.

### Fiche de déploiement à remplir par l’entreprise

| Information | Valeur à renseigner |
|---|---|
| Responsable de l’application | __________________________ |
| PC serveur / nom Windows | __________________________ |
| Adresse IP locale du serveur | __________________________ |
| Port des demandes | 39427 (ou __________) |
| Port des mises à jour | 39428 (ou __________) |
| Version installée | __________________________ |
| Emplacement des installateurs signés | __________________________ |
| Emplacement approuvé des sauvegardes | __________________________ |
| Canal interne de support | __________________________ |

*Ne jamais inscrire le code réseau partagé ou le mot de passe de signature dans cette fiche distribuée.*

---

**Document de passation — Pixel Office v0.4.2.** Le manuel décrit les fonctions présentes dans les sources de cette version et les procédures prévues. Les points non validés doivent être testés avant tout déploiement réel.
