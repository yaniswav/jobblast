# Tutoriel : installer et utiliser JobBlast

English version: docs/TUTORIAL.md

Guide pas-à-pas pour quelqu'un qui n'a jamais utilisé Node.js, Docker ou une
CLI d'IA. Si vous êtes déjà à l'aise avec ces outils, le
`README.md` (Quick start) ira plus vite.

Tout ce dont vous avez besoin est gratuit : Postgres tourne chez vous (via
Docker), les sources d'offres d'emploi utilisées par défaut ne demandent
aucune clé, et l'IA (facultative) utilise votre abonnement Claude existant
plutôt qu'une clé API facturée à l'usage.

## Sommaire

1. [Installer les prérequis](#1-installer-les-prérequis)
2. [Cloner et installer le projet](#2-cloner-et-installer-le-projet)
3. [Copier les fichiers de configuration](#3-copier-les-fichiers-de-configuration)
4. [Lancer la base de données](#4-lancer-la-base-de-données)
5. [Créer les tables](#5-créer-les-tables)
6. [Lancer l'application en développement](#6-lancer-lapplication-en-développement)
7. [Remplir votre profil](#7-remplir-votre-profil)
8. [Obtenir des clés API gratuites](#8-obtenir-des-clés-api-gratuites)
9. [Adapter `jobblast.config.json` à votre profil](#9-adapter-jobblastconfigjson-à-votre-profil)
10. [Choisir un fournisseur d'IA (pour les lettres IA)](#10-choisir-un-fournisseur-dia-pour-les-lettres-ia)
11. [Déployer en « production locale »](#11-déployer-en-production-locale)
12. [Routine quotidienne d'utilisation](#12-routine-quotidienne-dutilisation)
13. [Options avancées](#13-options-avancées)
14. [FAQ / dépannage](#14-faq--dépannage)

---

## 1. Installer les prérequis

### Node.js (version 24 ou plus)

JobBlast utilise une fonctionnalité de Node.js récente
(`--env-file-if-exists`), donc il faut Node **24 ou supérieur**.

- Téléchargez-le sur [nodejs.org](https://nodejs.org/) (choisissez la
  version "Current", pas forcément la "LTS" si celle-ci est encore en
  dessous de 24), ou installez-le via un gestionnaire de versions
  ([nvm-windows](https://github.com/coreybutler/nvm-windows) sur Windows,
  [nvm](https://github.com/nvm-sh/nvm) sur macOS/Linux).
- Vérifiez l'installation :

  ```bash
  node -v
  ```

  Vous devez voir `v24.x.x` ou plus.

### pnpm (version 10)

JobBlast est un monorepo géré avec **pnpm**, pas npm ni yarn (le projet
refuse volontairement de s'installer avec un autre gestionnaire).

```bash
corepack enable
corepack prepare pnpm@10 --activate
pnpm -v
```

(Si `corepack` n'est pas disponible, installez pnpm directement :
`npm install -g pnpm@10`.)

### Docker (pour la base de données Postgres)

- **Windows / macOS** : installez
  [Docker Desktop](https://www.docker.com/products/docker-desktop/),
  lancez-le une fois pour terminer la configuration initiale.
- **Linux** : installez Docker Engine + le plugin Compose via votre gestionnaire
  de paquets (ou suivez les [instructions officielles](https://docs.docker.com/engine/install/)).

Vous n'êtes pas obligé d'utiliser Docker : si vous avez déjà un serveur
Postgres 16 quelque part, passez directement à l'étape 5 en pointant
`DATABASE_URL` dessus.

### Git

Nécessaire pour cloner le dépôt. Sur Windows, installez
[Git for Windows](https://git-scm.com/download/win) (il fournit aussi
« Git Bash », utile pour les commandes de ce tutoriel).

---

## 2. Cloner et installer le projet

```bash
git clone https://github.com/yaniswav/jobblast.git
cd jobblast
pnpm install
```

`pnpm install` télécharge toutes les dépendances du monorepo (frontend, API,
librairies partagées). Cela peut prendre quelques minutes la première fois.

---

## 3. Copier les fichiers de configuration

JobBlast garde tout ce qui est personnel (identité, clés, réglages de
scoring...) hors du code source, dans trois fichiers **non suivis par git**
(voir `docs/CONFIG.md` pour le détail). Une commande crée les trois d'un
coup à partir de leurs exemples committés :

```bash
pnpm run setup
```

Cette commande ne fait rien si les fichiers existent déjà (relancez-la sans
crainte après un `git pull`, par exemple si un nouvel exemple apparaît).
Elle crée :

| Fichier créé | À partir de | Contenu |
|---|---|---|
| `.env` | `.env.example` | Secrets et ports (base de données, clés d'API, port du serveur) |
| `jobblast.config.json` | `jobblast.config.example.json` | Identité, règles de scoring, sources activées |
| `config/cover-letter-template.txt` | `config/cover-letter-template.example.txt` | Votre lettre de motivation type, utilisée comme modèle par l'IA |

Vous éditerez `.env` à l'étape 8 (clés d'API) et `jobblast.config.json` à
l'étape 9. Pour l'instant, les valeurs par défaut suffisent pour démarrer.

---

## 4. Lancer la base de données

Depuis la racine du projet :

```bash
docker compose up -d
```

Cela démarre un conteneur Postgres 16 nommé `jobblast-pg`, avec les
identifiants déjà attendus par `.env.example`
(`postgres://postgres:postgres@localhost:5432/jobblast`). Vérifiez qu'il
tourne :

```bash
docker ps
```

Vous devriez voir une ligne `jobblast-pg` avec le statut `Up`.

---

## 5. Créer les tables

```bash
pnpm --filter @workspace/db run push
```

Cette commande (Drizzle) crée le schéma (tables `profiles`, `job_listings`,
`applications`, `documents`) dans la base que vous venez de démarrer, à
partir de `lib/db/src/schema/`. Elle est sans danger à relancer plus tard si
le schéma évolue (elle ajuste, elle ne supprime pas vos données).

---

## 6. Lancer l'application en développement

Deux processus à lancer, dans deux terminaux séparés (les deux lisent le
même `.env` à la racine) :

```bash
# Terminal 1 - l'API (port 5000 par défaut)
pnpm run dev:api
```

```bash
# Terminal 2 - le frontend (port 5173 par défaut, avec proxy vers l'API)
pnpm run dev:web
```

Ouvrez ensuite **http://localhost:5173** dans votre navigateur. Vous devriez
voir le tableau de bord JobBlast (probablement vide au premier lancement, le
temps que le premier cycle d'agrégation des offres se termine en tâche de
fond - quelques dizaines de secondes à quelques minutes selon les sources
activées).

`pnpm run dev:api` fait un build + démarrage (pas de rechargement à chaud) :
relancez la commande après une modification du code serveur. Le frontend
(Vite), lui, recharge automatiquement.

---

## 7. Remplir votre profil

Allez sur la page **Profile** (menu de gauche) :

- **Identité** : nom, headline (l'intitulé qui vous décrit, ex. « Ingénieur
  logiciel embarqué »), salaire plancher.
- **Ciblage** : rôles visés (tags, ex. « Software Engineer », « Firmware
  Engineer »), lieux visés (tags, ex. « Paris », « Remote »), entreprises
  exclues.
- **Master resume** : collez tout votre CV/parcours en texte brut - c'est la
  matière première à partir de laquelle l'IA génère des puces de CV
  adaptées à chaque offre. Plus c'est riche et concret (ce que vous avez
  fait, avec quelles technologies, quel impact), meilleures seront les
  candidatures générées.
- **Mes documents** (en bas de la page Profile) : uploadez votre **CV en
  PDF** - son texte est automatiquement extrait et vient enrichir/remplacer
  le « Master resume » ci-dessus - et votre **lettre de motivation en PDF**
  (optionnel, sert surtout de secours si `config/cover-letter-template.txt`
  n'est pas rempli). Les deux fichiers sont stockés localement dans
  `data/documents/` (non suivi par git).

Cliquez sur **Save profile** pour enregistrer.

---

## 8. Obtenir des clés API gratuites

Deux sources ont besoin d'une clé (gratuite) ; les neuf autres n'en
demandent aucune et fonctionnent déjà sans rien faire.

### France Travail

1. Allez sur [francetravail.io](https://francetravail.io/) et créez un
   compte (ou connectez-vous).
2. Dans votre espace développeur, créez une **application** (donnez-lui un
   nom, par exemple « jobblast »).
3. Dans les API disponibles pour cette application, cherchez **« Offres
   d'emploi v2 »** et souscrivez-y (accès gratuit, pas de carte bancaire).
4. Une fois souscrit, les paramètres de l'application affichent un
   **Identifiant client** et une **Clé secrète** (« Client ID » /
   « Client Secret »). Copiez-les.
5. Collez-les dans `.env` :

   ```
   FRANCETRAVAIL_CLIENT_ID=PAR_votreapp_...
   FRANCETRAVAIL_CLIENT_SECRET=...
   ```

(L'interface de francetravail.io évolue de temps en temps - le principe
reste : créer une application, souscrire à l'API "Offres d'emploi v2",
récupérer les deux identifiants OAuth2.)

### Adzuna

1. Allez sur [developer.adzuna.com](https://developer.adzuna.com/) et
   inscrivez-vous (« Register », email + mot de passe).
2. Une fois connecté, votre tableau de bord affiche directement un
   **Application ID** et une **Application Key** pour une application créée
   automatiquement (sinon, créez-en une via « Add another application »).
3. Collez-les dans `.env` :

   ```
   ADZUNA_APP_ID=...
   ADZUNA_APP_KEY=...
   ```

Le plan gratuit d'Adzuna a un quota d'appels assez bas - voir la FAQ si vous
rencontrez des erreurs 429.

**Ni l'une ni l'autre n'est obligatoire.** Sans ces clés, les sources
correspondantes sont simplement ignorées (un message dans les logs, pas
d'erreur) et JobBlast continue de fonctionner avec Greenhouse, Lever,
RemoteOK, Remotive, Himalayas, Arbeitnow, Yourator, TokyoDev et japan-dev.

---

## 9. Adapter `jobblast.config.json` à votre profil

`jobblast.config.json` (créé à l'étape 3) est livré avec des règles de
scoring taillées pour un profil « embarqué / C++ / systems » - **c'est un
exemple, pas une valeur par défaut neutre**. Éditez-le pour qu'il corresponde
à votre recherche :

- **`contact`** : votre nom, email, téléphone, ville (utilisés sur le PDF de
  lettre de motivation et dans le User-Agent HTTP sortant).
- **`scoring.rules`** : la liste des mots-clés (regex) qui font monter le
  score d'une offre, avec un poids et une explication affichée dans
  l'interface. Remplacez les règles C++/embarqué par vos propres
  compétences.
- **`scoring.penalties`** : les défauts supposent un profil junior basé en
  Europe, sans autorisation de travail US - si ce n'est pas votre cas,
  ajustez ou désactivez `usLocation` / `workAuthorization` (poids à `0` ou
  suppression de la clé).
- **`sources`** : activez/désactivez chaque source (`enabled: true/false`),
  et pour France Travail/Adzuna/Greenhouse/Lever, adaptez les mots-clés,
  départements ou boards à votre recherche.
- **`coverLetterTemplatePath`** : par défaut
  `config/cover-letter-template.txt` - le fichier édité à l'étape suivante.

Référence complète de chaque clé : **[`docs/CONFIG.md`](CONFIG.md)**.

Éditez aussi **`config/cover-letter-template.txt`** : remplacez le texte
d'exemple par votre propre lettre de motivation type (structure, ton,
formule de politesse). L'IA ne la recopie jamais mot pour mot - elle s'en
sert de modèle de structure et de ton pour rédiger une lettre différente
pour chaque offre.

Après une modification de `jobblast.config.json`, redémarrez `pnpm run
dev:api` (le fichier est relu au démarrage du serveur).

---

## 10. Choisir un fournisseur d'IA (pour les lettres IA)

Facultatif. JobBlast sait rédiger des puces de CV et une lettre de motivation
adaptées à chaque offre, et vous laisse choisir quel moteur s'en charge. Sans
fournisseur d'IA, l'application fonctionne quand même de bout en bout : vous
obtenez une lettre propre construite à partir de votre template, plus des
puces dérivées de votre profil, signalées dans l'interface comme un brouillon
template.

Choisissez une des six options ci-dessous et inscrivez-la dans
`jobblast.config.json`. Toute la section `ai` est facultative, et l'omettre
revient à choisir l'option 1.

| Option | Lettres | AI Scout | Notion Inbox | Coût |
|---|---|---|---|---|
| **0.** `none` | template seulement | non | non | gratuit |
| **1.** `claude-cli` *(par défaut)* | oui | oui | oui | votre abonnement Claude |
| **2.** `codex-cli` | oui | oui | si vous avez ajouté un serveur MCP Notion | votre offre ChatGPT / Codex |
| **3.** `gemini-cli` | oui | recherche web seulement | non | votre offre Gemini ou une clé API |
| **4.** `anthropic-api` | oui | non | non | facturé au token |
| **5.** `openai-compatible`, dont **Ollama** | oui | non | non | facturé, ou **gratuit avec Ollama** |

« AI Scout » et « Notion Inbox » sont les deux sources d'offres facultatives
de l'étape 13 (« Options avancées ») ; elles ont besoin d'un agent capable d'appeler des outils, ce
que seules les options 1 à 3 permettent.

Toutes les clés de toutes les options sont documentées dans
[`docs/CONFIG.md`](CONFIG.md#ai).

---

### Option 0 : aucune IA

```json
"ai": { "provider": "none" }
```

Rien à installer. Aucune CLI n'est lancée, aucune API n'est appelée. Chaque
offre conserve la lettre template et les puces dérivées de votre profil.
L'agrégation, le scoring, la file de revue, l'export PDF et le suivi des
candidatures fonctionnent normalement. C'est aussi une bonne façon de faire
tourner l'application d'abord et de choisir un fournisseur plus tard.

### Option 1 : CLI Claude Code (par défaut, recommandée)

C'est ce que JobBlast utilise si vous n'écrivez aucune section `ai`. C'est la
seule option où les deux sources facultatives fonctionnent pleinement, parce
que vos connecteurs claude.ai (Notion, Indeed, Snagajob...) sont accessibles
depuis une session headless.

1. Installez la CLI avec l'installeur natif (recommandé) :

   ```powershell
   # Windows (PowerShell)
   irm https://claude.ai/install.ps1 | iex
   ```

   ```bash
   # macOS / Linux
   curl -fsSL https://claude.ai/install.sh | bash
   ```

   (Également disponible via Homebrew ou WinGet. L'ancienne méthode `npm
   install -g @anthropic-ai/claude-code` fonctionne aussi si vous préférez.)

2. Connectez-la à votre compte (abonnement Claude Pro/Max, ou clé API
   Console selon votre configuration) :

   ```bash
   claude
   ```

   La première exécution ouvre automatiquement un flux de connexion dans
   votre navigateur. Suivez les instructions, puis quittez (`/exit` ou
   `Ctrl+C`). Pour vous reconnecter ou changer de compte plus tard, utilisez
   `/login` dans une session.

3. Vérifiez que ça fonctionne :

   ```bash
   claude -p "dis bonjour" --output-format json
   ```

   Vous devez obtenir un JSON avec `"is_error": false` et un `"result"`
   non vide.

4. Rien à configurer. Si vous voulez être explicite, ou changer de modèle :

   ```json
   "ai": { "provider": "claude-cli", "model": "sonnet" }
   ```

### Option 2 : CLI Codex d'OpenAI

```json
"ai": { "provider": "codex-cli", "codexCli": { "model": "" } }
```

Installez-la (`npm install -g @openai/codex`, ou Homebrew), puis lancez
`codex login` une fois. Laissez `model` vide pour utiliser le modèle déjà
configuré dans Codex.

JobBlast appelle `codex exec` en mode non interactif avec un bac à sable en
lecture seule et récupère le message final. AI Scout fonctionne (la recherche
web est activée à chaque exécution) ; la Notion Inbox aussi, mais seulement
si vous avez ajouté un serveur MCP Notion à votre propre
`~/.codex/config.toml` : Codex n'a pas de liste de connecteurs par exécution.

### Option 3 : CLI Gemini de Google

```json
"ai": { "provider": "gemini-cli", "geminiCli": { "model": "" } }
```

Installez-la (`npm install -g @google/gemini-cli`), puis lancez `gemini` une
fois pour vous authentifier, ou renseignez `GEMINI_API_KEY` dans `.env`.

Les lettres fonctionnent. AI Scout ne fonctionne que pour la moitié
« recherche web », et la Notion Inbox ne fonctionne pas : les serveurs MCP de
Gemini sont nommés dans votre propre `~/.gemini/settings.json`, que JobBlast
ne peut pas lire. Notez que les exécutions d'agent doivent passer
`--approval-mode yolo`, qui approuve automatiquement tous les outils que
l'agent décide d'appeler : préférez l'option 1 ou 2 si vous comptez activer
AI Scout.

### Option 4 : API Anthropic (facturée)

```json
"ai": { "provider": "anthropic-api", "anthropicApi": { "model": "claude-opus-5", "maxTokens": 4096 } }
```

Créez une clé sur [console.anthropic.com](https://console.anthropic.com/) et
mettez-la dans `.env` sous `ANTHROPIC_API_KEY` : jamais dans
`jobblast.config.json`, que vous pourriez vouloir partager. Lettres
uniquement, facturées au token.

### Option 5 : tout endpoint compatible OpenAI, y compris des modèles locaux gratuits

Un seul appel HTTP au format OpenAI Chat Completions, ce qui couvre OpenAI,
OpenRouter, Mistral, Groq, vLLM, LM Studio et Ollama.

**Gratuit et 100 % local, avec Ollama.** Rien ne quitte votre machine, et il
n'y a aucune facture :

```bash
# 1. Installer Ollama
winget install Ollama.Ollama              # Windows
brew install ollama                        # macOS
curl -fsSL https://ollama.com/install.sh | sh   # Linux

# 2. Télécharger un modèle (environ 4,7 Go ; llama3.2:3b ou qwen2.5:3b sont plus légers)
ollama pull llama3.1
```

```json
"ai": { "provider": "ollama" }
```

C'est toute la configuration : l'endpoint (`http://localhost:11434/v1`), le
modèle (`llama3.1`) et « pas de clé API » sont préréglés pour vous.
`"provider": "lmstudio"` fait la même chose pour LM Studio sur
`http://localhost:1234/v1`.

Deux choses à attendre d'un petit modèle local : les lettres sont plus
grossières et suivent moins fidèlement la structure et la règle de langue,
et lorsqu'une réponse revient malformée JobBlast la rejette au lieu de vous
la montrer, donc l'offre concernée conserve simplement sa lettre template.
Elle est réessayée à la passe suivante, au maximum 3 fois par exécution du
serveur.

Pour un endpoint hébergé à la place :

```json
"ai": {
  "provider": "openai-compatible",
  "openaiCompatible": {
    "baseUrl": "https://api.openai.com/v1",
    "apiKeyEnv": "OPENAI_API_KEY",
    "model": "gpt-4o-mini"
  }
}
```

et mettez `OPENAI_API_KEY` dans `.env`.

---

Quelle que soit votre option, redémarrez l'API après avoir modifié
`jobblast.config.json` : le fichier est lu au démarrage. La première ligne de
log après « Server listening » indique quel fournisseur est actif et s'il
peut exécuter des agents.

Une remarque de déploiement pour les options 1 à 3 : la CLI tourne sous le
compte système qui exécute le processus serveur, donc si vous déployez en
tâche planifiée / service (étape 11), c'est **ce compte-là** qui doit être
connecté (la CLI doit avoir été authentifiée au moins une fois sous cet
utilisateur).

Si le fournisseur choisi s'avère inutilisable (CLI non installée, clé
absente, serveur local éteint), JobBlast écrit un avertissement, bascule sur
les lettres template pour le reste de l'exécution et n'insiste pas. Corrigez
la cause et redémarrez.

---

## 11. Déployer en « production locale »

Une fois votre profil et votre config prêts, vous pouvez faire tourner
JobBlast en permanence sur votre machine (un seul processus Node sert à la
fois l'API et le frontend déjà buildé), sans dépendre d'un terminal ouvert.

### Windows

```powershell
pwsh -NoProfile -ExecutionPolicy Bypass -File .\deploy\build.ps1
pwsh -NoProfile -ExecutionPolicy Bypass -File .\deploy\register-task.ps1
```

`register-task.ps1` crée une **tâche planifiée** Windows nommée `JobBlast`
qui démarre l'application à l'ouverture de session. Détails complets,
commandes de logs, redémarrage après modification du code : voir
**[`deploy/README.md`](../deploy/README.md)**.

### Linux / macOS

```bash
chmod +x deploy/*.sh   # une fois, si le bit exécutable ne survit pas au clone
bash deploy/build.sh
bash deploy/start-jobblast.sh
```

Pour un démarrage automatique au boot : voir la section systemd (Linux) /
launchd (macOS) de **[`deploy/README.md`](../deploy/README.md)**.

Dans les deux cas, l'application tourne ensuite sur **http://localhost:5000/**.

---

## 12. Routine quotidienne d'utilisation

Une fois déployé, la routine devient très simple :

1. **Matin** : ouvrez `http://localhost:5000/review` (ou `:5173` en dev). Le
   serveur a déjà agrégé de nouvelles offres (toutes les 6h) et généré des
   lettres IA pour les plus récentes (toutes les 30 min).
2. Pour chaque offre du **Review queue** : lisez « Why this surfaced »
   (⚠ = point de vigilance, ex. « 5 ans d'XP requis »), relisez/éditez la
   lettre générée, puis :
   - **Approve & log application** → ouvre l'offre chez l'employeur dans un
     nouvel onglet, et crée une entrée « À ENVOYER » dans le tracker. Rien
     n'est jamais soumis automatiquement.
   - **Skip** → passe à la suivante.
3. Postulez réellement sur le site de l'employeur (CV et lettre en PDF sont
   accessibles directement depuis la carte de l'offre : boutons « Mon CV »
   / « Lettre en PDF »).
4. Retournez dans **Applications**, ligne correspondante, bouton **« J'ai
   postulé »** pour confirmer - la candidature passe alors de « À ENVOYER »
   à « Applied » dans le tracker.
5. Quand un recruteur répond, éditez la ligne (icône crayon) pour mettre à
   jour le statut (`Responded` / `Interview` / `Offer` / `Rejected`) et,
   si besoin, une date de relance.

Le reste (agrégation, scoring, génération IA) est automatique tant que le
serveur tourne.

---

## 13. Options avancées

### AI Scout (connecteurs claude.ai + recherche web)

Un agent Claude headless qui interroge vos connecteurs de recherche
d'emploi claude.ai (Indeed, Snagajob, Aquent, JobDataLake...) et le web pour
trouver des offres que les API structurées ne couvrent pas. Désactivé par
défaut, limité à une exécution par 24h.

1. Connectez vos connecteurs sur **claude.ai/customize/connectors**
   (chaque connecteur se configure et s'autorise là-bas, indépendamment de
   JobBlast). Une fois autorisés sur votre compte, ils deviennent
   automatiquement disponibles pour vos sessions CLI headless (`claude -p`)
   tant que la CLI est connectée à ce même compte.
2. Pour connaître le nom exact à utiliser dans `allowedConnectors`
   ci-dessous, listez les serveurs MCP visibles par la CLI :

   ```bash
   claude mcp list
   ```

   (Cette commande liste surtout les serveurs MCP ajoutés localement ; les
   connecteurs de compte claude.ai comme Notion/Indeed/Gmail sont
   disponibles même s'ils n'y apparaissent pas explicitement. En cas de
   doute sur le nom exact, gardez le format `mcp__claude_ai_<NomDuConnecteur>`
   utilisé dans `jobblast.config.example.json`.)

3. Dans `jobblast.config.json`, sous `sources.aiScout` :

   ```json
   "aiScout": {
     "enabled": true,
     "allowedConnectors": ["mcp__claude_ai_Indeed", "mcp__claude_ai_Snagajob"],
     "targetCompanies": [],
     "targetSites": [],
     "maxPostings": 15,
     "effortLevel": "high"
   }
   ```

   (Les noms de connecteurs suivent le nom listé par `claude mcp list`, en
   remplaçant espaces/points par `_` et en préfixant `mcp__`.)

Référence complète : `docs/CONFIG.md` → `sources.aiScout`.

### Notion Inbox + routine cloud

Un pont qui importe dans JobBlast les offres déposées dans une base Notion -
typiquement alimentée par une routine Claude programmée qui tourne dans le
cloud, **même quand votre machine est éteinte**.

**Étape 1 - créer la base Notion**, avec ces propriétés (les noms sont
personnalisables dans la config, ces noms-ci sont juste un exemple) :
`Title` (titre), `Company` (texte), `URL` (url), `Location` (texte), `Why`
(texte), `Source` (texte), `Imported` (case à cocher - **réservée à
l'app**, ne la cochez jamais manuellement).

**Étape 2 - configurer `jobblast.config.json`** :

```json
"notionInbox": {
  "enabled": true,
  "pageUrl": "https://app.notion.com/p/<VOTRE-PAGE-ID>",
  "dataSourceUrl": "collection://<VOTRE-DATA-SOURCE-ID>",
  "properties": {
    "title": "Title", "company": "Company", "url": "URL",
    "location": "Location", "why": "Why", "source": "Source",
    "imported": "Imported"
  }
}
```

**Étape 3 - créer la routine planifiée** qui alimente cette base. Cette
fonctionnalité s'appelle **Routines** et tourne sur l'infrastructure cloud
d'Anthropic (donc même machine éteinte) - deux façons de la créer :

- Interface web : [claude.ai/code/routines](https://claude.ai/code/routines)
  → « New routine » → prompt, connecteurs à autoriser, planification
  (quotidien/horaire/cron personnalisé).
- Depuis une session CLI : `/schedule "description de la tâche"` (Claude
  Code vous guide ensuite pas à pas).

Programmez-la par exemple tous les jours à 6h30, avec un prompt du type :

```
Tu es un scout d'offres d'emploi. Trouve des offres RÉELLES et
ACTUELLEMENT OUVERTES correspondant à ce profil :

Profil : <VOTRE HEADLINE, ex. "Ingénieur logiciel embarqué junior">
Rôles visés : <VOS RÔLES CIBLES>
Lieux visés : <VOS LIEUX CIBLES, ou "full remote">
Contraintes : pas de restriction de nationalité/visa US, niveau
junior/débutant accepté.

1. Utilise d'abord tes connecteurs d'offres d'emploi (Indeed, Snagajob,
   Aquent, JobDataLake...) puis la recherche web pour combler les trous.
2. Pour chaque offre retenue (10 maximum), vérifie que l'URL pointe vers
   UNE annonce précise (jamais une page de résultats de recherche).
3. Dépose chaque offre comme une nouvelle ligne dans la base Notion
   "<NOM DE VOTRE BASE>" (<URL DE LA PAGE NOTION>) :
   - Title = titre du poste
   - Company = entreprise
   - URL = lien direct vers l'annonce
   - Location = lieu
   - Why = 1-2 phrases expliquant pourquoi ça correspond au profil
   - Source = d'où vient l'offre (connecteur ou site web)
   Ne crée JAMAIS de doublon (vérifie par URL avant d'ajouter une ligne),
   et ne touche JAMAIS à la case "Imported" (réservée à une autre
   automatisation).
```

Le pont `sources.notionInbox` du serveur JobBlast lit ensuite cette base
(au maximum une fois toutes les 3h) et importe les lignes non encore
« Imported » dans le pipeline habituel (scoring, tailoring, review).

Référence complète : `docs/CONFIG.md` → `sources.notionInbox`.

### Résumé matinal Gmail (lecture seule)

Une routine planifiée facultative, indépendante de JobBlast, qui scanne
votre boîte Gmail chaque matin pour repérer les réponses de recruteurs et
vous éviter de fouiller manuellement. Exemple de prompt générique (à
programmer via claude.ai, connecteur Gmail autorisé au préalable, en
**lecture seule** - ne rien envoyer ni archiver) :

```
Analyse ma boîte Gmail (lecture seule, ne modifie/n'envoie rien) pour les
dernières 24h. Cherche les emails liés à ma recherche d'emploi
(candidatures envoyées à <LISTE D'ENTREPRISES OU MOTS-CLÉS, si utile>).
Classe chaque email trouvé en :
  ✅ confirmation de réception
  📅 proposition d'entretien
  🎉 réponse positive / offre
  ❌ refus
Trie avec les entretiens en premier. Pour chaque email, donne
l'entreprise, le poste (si identifiable) et un résumé d'une ligne.
Termine par un rappel : "Pense à reporter les changements de statut dans
ton tracker de candidatures (http://localhost:5000/applications)."
```

### Briefing local (santé + rafraîchissement + résumé)

Une tâche planifiée **locale** (sur votre machine, via le Planificateur de
tâches Windows / cron / launchd, pas dans le cloud - puisqu'elle a besoin
que le serveur JobBlast tourne déjà) qui vérifie que tout va bien et vous
donne un résumé du jour. Exemple de prompt, à exécuter par une CLI Claude
Code locale programmée le matin :

```
Fais ces appels dans l'ordre contre le serveur JobBlast local
(http://localhost:5000, adapte le port si besoin) :

1. GET /api/healthz - si ça échoue, dis-le et arrête-toi là (le serveur
   n'est probablement pas démarré : voir deploy/start-jobblast.*).
2. POST /api/jobs/refresh - déclenche un rafraîchissement des offres.
3. GET /api/jobs?status=queued - liste les offres en attente de revue.
4. GET /api/applications?status=approved - candidatures "À ENVOYER" pas
   encore confirmées comme envoyées.
5. GET /api/dashboard - statistiques globales.

Résume en français : les 5 meilleures offres de la file (titre,
entreprise, score), le nombre de candidatures "À ENVOYER" en attente de
confirmation, les statistiques du dashboard, et mets en avant "l'offre du
jour" (le meilleur score).
```

En pratique, cela peut être un simple script shell/PowerShell avec `curl`
enchaîné à `claude -p` pour la mise en forme, ou une tâche planifiée Claude
Code locale équivalente - l'important est juste que ça tourne **après** que
`deploy/start-jobblast.*` ait démarré le serveur.

---

## 14. FAQ / dépannage

**« Port 5000 already in use » / le port 5000 est déjà utilisé**
Un autre processus écoute déjà dessus (peut-être une instance JobBlast déjà
lancée). Changez `PORT` dans `.env`, ou trouvez et arrêtez l'ancien
processus :
- Windows : `Get-NetTCPConnection -LocalPort 5000 -State Listen` puis
  `Stop-Process -Id <PID>`, ou simplement `deploy\stop-jobblast.ps1`.
- Linux/macOS : `lsof -i :5000` puis `kill <PID>`, ou `deploy/stop-jobblast.sh`.

**Docker Desktop n'est pas lancé**
`docker compose up -d` (ou `docker ps`) échoue avec une erreur de connexion
au démon Docker. Lancez Docker Desktop et réessayez une fois l'icône stable
dans la barre système. En déploiement automatique (tâche planifiée /
service), pensez à activer « Start Docker Desktop when you log in » dans
les réglages de Docker Desktop.

**`claude` n'est pas connecté / erreurs dans les logs sur le tailoring**
L'agrégation des offres continue de fonctionner, mais les lettres restent
sur le template générique. Lancez `claude` (ou `claude -p "test"
--output-format json`) sous le même utilisateur système que celui qui fait
tourner le serveur JobBlast, et suivez le flux de connexion. Si JobBlast
tourne en tâche planifiée/service sous un utilisateur particulier, c'est
bien cet utilisateur-là qui doit avoir `claude` connecté.

**pnpm échoue à installer un binaire sur Windows (ex. erreurs de build
natif)**
Assurez-vous d'utiliser une CLI standard (PowerShell ou Git Bash), avec
Node 24+ et pnpm 10 installés correctement (`node -v`, `pnpm -v`). Certains
paquets natifs nécessitent les « Build Tools » Visual Studio si le binaire
précompilé n'est pas disponible pour votre version de Node - c'est rare
avec ce projet mais si `pnpm install` échoue sur un paquet précis, cherchez
l'erreur exacte (souvent `node-gyp`) et installez les outils qu'elle
demande.

**Adzuna renvoie des erreurs 429 / rate limit**
Le plan gratuit d'Adzuna a un quota d'appels par jour assez bas. Réduisez
`sources.adzuna.queries` (moins de mots-clés) dans `jobblast.config.json`,
ou désactivez temporairement la source (`"enabled": false`) - les 10 autres
sources continuent de fonctionner normalement.

**La source 104 (104.com.tw) ne renvoie rien**
C'est normal et volontaire : `sources.job104` est désactivée par défaut car
son endpoint de recherche est derrière une protection Cloudflare qui bloque
les requêtes automatisées. L'activer ne fait que gaspiller du budget de
requêtes pour zéro résultat - voir la note dans
`jobblast.config.example.json` / `docs/CONFIG.md`.

**Rien n'apparaît dans la file de revue après le premier lancement**
Le premier cycle d'agrégation démarre en tâche de fond au lancement du
serveur et peut prendre de quelques dizaines de secondes à quelques minutes
(selon le nombre de sources activées). Vérifiez les logs du serveur
(terminal `pnpm run dev:api`, ou `deploy/logs/jobblast.log` en production)
pour voir la progression (`"Job refresh: fetching enabled sources"` puis
`"Job refresh complete"`). Si le nombre d'offres insérées reste à 0,
vérifiez que vos règles de scoring (`jobblast.config.json` →
`scoring.rules` / `scoring.minRelevanceScore`) ne sont pas trop strictes
pour les offres réellement remontées par vos sources activées.

### J'ai déjà un Postgres (ou un autre JobBlast) dans Docker : `docker compose up -d` échoue ou réutilise le mauvais conteneur

`docker-compose.yml` nomme le conteneur `jobblast-pg` et publie le port 5432. Pour une seconde instance, modifiez le fichier compose (par exemple `container_name: jobblast-pg-2`, `"5433:5432"`), puis dans `.env` : `DATABASE_URL` sur le port 5433, `PG_CONTAINER_NAME=jobblast-pg-2`, et des ports libres avec `PORT=5010`, `FRONTEND_PORT=5174`, `API_PROXY_TARGET=http://localhost:5010`. L'API et le serveur Vite lisent tous deux le `.env` racine.

### Windows : `deploy\*.ps1` échoue avec une erreur de syntaxe

Les scripts de déploiement nécessitent PowerShell 7 (`pwsh`), pas le Windows PowerShell 5.1 livré avec Windows. Installez-le avec `winget install Microsoft.PowerShell`, puis lancez les scripts depuis un terminal `pwsh`.
