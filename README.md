# Florian Vibe — Mistral Vibe pour VSCode

Une extension VSCode pour [Mistral Vibe](https://docs.mistral.ai/mistral-vibe/introduction/install) avec une UX proche de Claude Code : chat panel, multi-conversations en onglets, diff inline, mode selector, markdown coloré.

## Pourquoi ce projet ?

L'extension officielle [`clementp0.mistral-vibe-for-vscode`](https://open-vsx.org/extension/clementp0/mistral-vibe-for-vscode) se contente de lancer le binaire dans un terminal latéral.

L'extension communautaire [`nmallet.vscode-mistral-vibe`](https://web.archive.org/web/2026/https://marketplace.visualstudio.com/items?itemName=nmallet.vscode-mistral-vibe) faisait beaucoup mieux (30+ versions itérées sur 6 mois) mais a été **dépubliée du marketplace** début mai 2026. Sa licence Apache-2.0 autorise les forks.

Florian Vibe **reprend l'idée** — communication ACP, chat sidebar, diff review — en réécrivant tout from scratch en TypeScript propre, et en ajoutant :

- **Multi-conversations en onglets** d'éditeur (Ctrl+Alt+V ouvre un nouvel onglet, comme un fichier)
- **Diff inline dans le chat** (à la Claude Code) avec boutons Appliquer/Refuser
- **Séparation propre du thinking** et de la réponse finale (bug n°1 de l'extension Mallet)
- **Mode selector** Default / Plan / Accept Edits / Auto Approve / Chat, avec **couleurs propagées** sur le compose (Shift+Tab pour cycler)
- **Markdown rendering** complet avec coloration syntaxique Prism sur 12 langages
- **Badge "à lire"** sur l'onglet quand une réponse arrive panel inactif
- **Auto-context** : le fichier ouvert est inclus dans le prompt, chip toggleable œil ouvert/fermé
- **Menu contextuel** "Lancer Florian Vibe sur ce fichier" dans l'explorer

## Crédits

Inspiré du travail de **Nicolas Mallet** ([`nmallet.vscode-mistral-vibe`](https://marketplace.visualstudio.com/items?itemName=nmallet.vscode-mistral-vibe), Apache-2.0). Ce projet **n'est pas un fork de son code source** (qui n'est pas public) mais reprend les choix d'architecture qu'on peut observer dans son extension compilée (protocole ACP, structure des messages, mode selector, diff provider).

Pas affilié à Mistral AI.

## Pré-requis

1. **Mistral Vibe CLI installé** :
   ```bash
   curl -LsSf https://mistral.ai/vibe/install.sh | bash
   ```

2. **Clé API Vibe configurée** (différente d'une clé API Mistral classique — chercher la section "Vibe CLI" sur [console.mistral.ai](https://console.mistral.ai)) :
   ```bash
   vibe --setup
   ```

3. Vérifier que `vibe-acp` est dans le PATH :
   ```bash
   which vibe-acp
   ```

## Installation (en attendant la publication marketplace)

```bash
git clone https://github.com/<TODO-username>/florian-vibe.git
cd florian-vibe
npm install
npm run compile
# Pour packager : npm install -g @vscode/vsce && vsce package
# Pour tester en dev : ouvrir le dossier dans VSCode + F5
```

## Utilisation

- **Ctrl+Alt+V** : nouvel onglet de conversation
- **Entrée** : envoyer ; **Maj+Entrée** : nouvelle ligne
- **Shift+Tab** : cycler entre les modes
- **Clic-droit sur un fichier** dans l'explorer → "Florian Vibe: Nouvelle conversation avec ce fichier"

## Roadmap

- [x] **Upload d'images — vision native** (bouton + / drag&drop / coller). L'extension envoie des blocs image ACP ; le modèle vision (ex. `mistral-medium-3.5`) les lit **via l'abonnement Mistral, sans clé API**.
  - Prérequis : patcher `vibe-acp`, qui par défaut jette les images en ACP (`image=false`, pas de « sidecar plumbing »). Voir [`scripts/patch-vibe-images.py`](scripts/patch-vibe-images.py).
  - ⚠️ `vibe-acp` est installé via `uv` → un `uv tool upgrade mistral-vibe` écrase le patch. **Relancer `python3 scripts/patch-vibe-images.py` après chaque upgrade.**
  - `@chemin/image.png` fonctionne nativement dans le CLI/TUI (sidecar) mais **pas** en ACP sans le patch.
  - Fallback `src/vision.ts` (description texte) conservé comme filet de sécurité si le patch est absent ; bug d'origine du revert = `img-src` manquant dans le CSP (corrigé).
- [ ] Support terminal (vibe-acp `terminal/*`)
- [ ] Slash commands
- [ ] Persistence des conversations

## Licence

Apache-2.0 (même licence que l'extension de Nicolas Mallet dont ce projet s'inspire).
