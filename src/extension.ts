import * as vscode from "vscode";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { execFile } from "child_process";
import { randomUUID } from "crypto";
import { AcpClient } from "./acp-client";
import { prepareDiff, DiffLine } from "./diff-view";
import { askPermission } from "./permission";
import { describeImage, InlineImage } from "./vision";

const EXTENSION_VERSION = "0.1.0";

type PromptBlock =
  | { type: "text"; text: string }
  | { type: "image"; mimeType: string; data: string }; // data = base64 sans préfixe `data:`

interface SessionUpdateNotification {
  sessionId: string;
  update: any;
}

/** Extrait le texte affichable depuis `content` d'un tool_call ou tool_call_update ACP. */
function extractToolContent(content: any): string | undefined {
  if (!Array.isArray(content) || content.length === 0) return undefined;
  const texts: string[] = [];
  for (const c of content) {
    if (!c) continue;
    if (c.type === "content" && c.content?.text) {
      texts.push(String(c.content.text));
    } else if (typeof c.text === "string") {
      texts.push(c.text);
    } else if (c.type === "diff" && c.path) {
      texts.push(`(diff sur ${c.path})`);
    } else if (c.type === "terminal") {
      texts.push(`(terminal ${c.terminalId})`);
    }
  }
  return texts.length > 0 ? texts.join("\n") : undefined;
}

const CLIENT_MODES = [
  { value: "default", name: "Default" },
  { value: "auto-edit", name: "Auto Edit" },
  { value: "bypass", name: "Bypass (YOLO)" },
];
type ClientMode = "default" | "auto-edit" | "bypass";

/**
 * État partagé entre tous les onglets de conversation.
 * Un seul processus vibe-acp pour N sessions (un onglet = une session).
 */
class FlorianVibe {
  private client?: AcpClient;
  private connecting?: Promise<void>;
  private readonly panels = new Map<string, ConversationPanel>(); // sessionId → panel
  private readonly toolCallTitles = new Map<string, string>();    // toolCallId → title
  private activePanel?: ConversationPanel;                        // dernier panel actif
  private readonly output: vscode.OutputChannel;

  private lastActiveUri?: vscode.Uri;

  constructor(private readonly context: vscode.ExtensionContext) {
    this.output = vscode.window.createOutputChannel("Florian Vibe");
    context.subscriptions.push(this.output);

    // État initial : seulement les fichiers du disque, pas les éditeurs custom (output, etc.)
    const initialEditor = vscode.window.activeTextEditor;
    if (initialEditor && initialEditor.document.uri.scheme === "file") {
      this.lastActiveUri = initialEditor.document.uri;
    }

    // Track le dernier fichier (uri) actif. Le webview rend activeTextEditor undefined → on ignore.
    context.subscriptions.push(
      vscode.window.onDidChangeActiveTextEditor((editor) => {
        if (editor && editor.document.uri.scheme === "file") {
          this.lastActiveUri = editor.document.uri;
          const filePath = vscode.workspace.asRelativePath(editor.document.uri);
          this.output.appendLine(`[ctx] fichier actif → ${filePath}`);
          for (const p of this.panels.values()) p.updateActiveFile(filePath);
        }
      })
    );
  }

  get activeUri(): vscode.Uri | undefined {
    return this.lastActiveUri;
  }

  get activeFilePath(): string | undefined {
    return this.lastActiveUri ? vscode.workspace.asRelativePath(this.lastActiveUri) : undefined;
  }

  async ensureConnected(): Promise<void> {
    if (this.client) return;
    if (this.connecting) {
      await this.connecting;
      return;
    }
    this.connecting = this.connect();
    try {
      await this.connecting;
    } finally {
      this.connecting = undefined;
    }
  }

  private async connect(): Promise<void> {
    const cfg = vscode.workspace.getConfiguration("florianVibe");
    const customPath = cfg.get<string>("acpBinaryPath", "").trim();
    const binaryPath = customPath || "vibe-acp";

    this.output.appendLine(`[ACP] Démarrage de ${binaryPath}`);
    const client = new AcpClient(binaryPath);

    client.on("stderr", (line) => this.output.appendLine(`[ACP stderr] ${line}`));
    client.on("error", (err) => this.output.appendLine(`[ACP error] ${err.message}`));
    client.on("exit", ({ code, signal }) => {
      this.output.appendLine(`[ACP] vibe-acp terminé (code=${code}, signal=${signal})`);
      this.client = undefined;
      for (const panel of this.panels.values()) panel.notifyDisconnected();
      this.panels.clear();
    });

    this.registerAcpHandlers(client);
    client.start();
    this.client = client;

    const initResult = await client.sendRequest("initialize", {
      protocolVersion: 1,
      clientInfo: { name: "florian-vibe", version: EXTENSION_VERSION },
      clientCapabilities: {
        terminal: false,
        fs: { readTextFile: true, writeTextFile: true },
      },
    });
    this.output.appendLine(`[ACP] Connecté à ${initResult?.agentInfo?.title} v${initResult?.agentInfo?.version}`);

    // Détecte si vibe-acp accepte les images (patché). Sinon, propose le patch.
    // Non bloquant : on n'attend pas la réponse de l'utilisateur pour finir la connexion.
    const imageSupported = initResult?.agentCapabilities?.promptCapabilities?.image === true;
    void this.checkImageSupport(imageSupported);
  }

  /**
   * Si vibe-acp n'annonce pas le support image, c'est que le patch est absent
   * (typiquement après un `uv tool upgrade mistral-vibe`). On propose de le relancer.
   */
  private async checkImageSupport(supported: boolean): Promise<void> {
    if (supported) return;
    this.output.appendLine("[ACP] vibe-acp sans support image (patch absent)");
    const choice = await vscode.window.showWarningMessage(
      "Florian Vibe : vibe-acp ne supporte pas les images (patch absent — souvent après une mise à jour de Vibe). L'upload d'images ne fonctionnera pas.",
      "Appliquer le patch",
      "Ignorer"
    );
    if (choice !== "Appliquer le patch") return;
    try {
      const out = await this.applyImagePatch();
      this.output.appendLine(`[patch] ${out}`);
      vscode.window.showInformationMessage(
        "Patch image appliqué. Rechargez la fenêtre (commande « Developer: Reload Window ») pour relancer vibe-acp."
      );
    } catch (e: any) {
      vscode.window.showErrorMessage(`Échec du patch image : ${e?.message}`);
    }
  }

  /** Lance scripts/patch-vibe-images.py (livré avec l'extension). */
  private applyImagePatch(): Promise<string> {
    const script = vscode.Uri.joinPath(
      this.context.extensionUri,
      "scripts",
      "patch-vibe-images.py"
    ).fsPath;
    return new Promise<string>((resolve, reject) => {
      execFile("python3", [script], { timeout: 30000 }, (err, stdout, stderr) => {
        if (err) reject(new Error(stderr.trim() || err.message));
        else resolve((stdout + stderr).trim());
      });
    });
  }

  private registerAcpHandlers(client: AcpClient): void {
    client.onNotification("session/update", (params: SessionUpdateNotification) => {
      // Mémorise les titres des tool calls — utile quand une permission arrive
      // plus tard et que son toolCall.title n'est pas inclus.
      const u = params.update;
      if (u?.sessionUpdate === "tool_call" && u.toolCallId && u.title) {
        this.toolCallTitles.set(u.toolCallId, u.title);
      }
      const panel = this.panels.get(params.sessionId);
      if (panel) panel.handleSessionUpdate(u);
    });

    client.onRequest("fs/read_text_file", async (p: { path: string }) => {
      const content = await fs.readFile(p.path, "utf8");
      return { content };
    });

    client.onRequest("fs/write_text_file", async (p: { path: string; content: string }) => {
      const panel = this.activePanel;
      if (!panel) {
        throw new Error("Pas de panel chat actif pour afficher le diff");
      }
      const prep = await prepareDiff(p.path, p.content);
      if (prep.unchanged) return null;

      const mode = panel.currentClientMode;
      // Modes "auto-edit" et "bypass" → on écrit sans demander, juste un toast info
      if (mode === "auto-edit" || mode === "bypass") {
        await prep.writeIfAccepted();
        panel.notifySystem(`📝 (${mode}) ${vscode.workspace.asRelativePath(p.path)}`);
        return null;
      }

      // Default : diff view + confirmation
      const accepted = await panel.askDiff(prep.filePath, prep.isNewFile, prep.diff);
      if (!accepted) {
        panel.notifySystem(`❌ écriture refusée : ${vscode.workspace.asRelativePath(p.path)}`);
        throw new Error("Écriture refusée par l'utilisateur");
      }
      await prep.writeIfAccepted();
      panel.notifySystem(`📝 fichier écrit : ${vscode.workspace.asRelativePath(p.path)}`);
      return null;
    });

    client.onRequest("session/request_permission", async (p: any) => {
      // Enrichit avec le title stocké si la requête n'en porte pas
      if (p?.toolCall?.toolCallId && !p.toolCall.title) {
        const stored = this.toolCallTitles.get(p.toolCall.toolCallId);
        if (stored) p.toolCall.title = stored;
      }
      // En mode bypass, on auto-allow la première option qui ressemble à allow
      if (this.activePanel?.currentClientMode === "bypass") {
        const options = p?.options ?? [];
        const allow = options.find((o: any) =>
          /allow|approve|accept/i.test(o.optionId ?? "") || /allow|approve|accept/i.test(o.name ?? "")
        );
        const picked = allow ?? options[0];
        if (picked) {
          this.output.appendLine(`[ACP permission] (bypass) auto-allow → ${picked.optionId}`);
          return { outcome: { outcome: "selected", optionId: picked.optionId } };
        }
      }
      this.output.appendLine(`[ACP permission] ${JSON.stringify({
        description: p?.description,
        title: p?.toolCall?.title,
        kind: p?.toolCall?.kind,
      })}`);
      return askPermission(p);
    });

    const noTerminal = async () => { throw new Error("Terminal non supporté en V0"); };
    client.onRequest("terminal/create", noTerminal);
    client.onRequest("terminal/output", noTerminal);
    client.onRequest("terminal/wait_for_exit", noTerminal);
    client.onRequest("terminal/release", noTerminal);
    client.onRequest("terminal/kill", noTerminal);
  }

  /** Crée l'objet ConversationPanel autour d'un WebviewPanel (neuf ou restauré) avec les callbacks standard. */
  private buildPanel(panel: vscode.WebviewPanel): ConversationPanel {
    const conv: ConversationPanel = new ConversationPanel(panel, this.client!,
      (sessionId) => { this.panels.delete(sessionId); if (this.activePanel === conv) this.activePanel = undefined; },
      () => { this.activePanel = conv; },
      () => this.lastActiveUri,
      this.output,
      this.context.extensionUri,
      () => this.listSessionsForHistory(),
      (sessionId, title) => { void this.openSessionById(sessionId, title); },
      () => { void this.openConversation(); }
    );
    return conv;
  }

  /** Callback d'enregistrement : référence le panel par sessionId + pousse le fichier actif. */
  private registerPanel(conv: ConversationPanel): (sessionId: string) => void {
    return (sessionId: string) => {
      this.panels.set(sessionId, conv);
      conv.updateActiveFile(this.activeFilePath);
    };
  }

  async openConversation(): Promise<void> {
    try {
      await this.ensureConnected();
    } catch (e: any) {
      vscode.window.showErrorMessage(`Florian Vibe : ${e?.message}. Vérifie florianVibe.acpBinaryPath.`);
      return;
    }
    if (!this.client) return;

    const nodeModulesUri = vscode.Uri.joinPath(this.context.extensionUri, "node_modules");
    const panel = vscode.window.createWebviewPanel(
      "florianVibe.chat",
      "Vibe",
      vscode.ViewColumn.Active,
      { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [nodeModulesUri] }
    );

    const conv = this.buildPanel(panel);
    this.activePanel = conv;
    await conv.start(this.registerPanel(conv));
  }

  /**
   * Appelé par le WebviewPanelSerializer au reload de VSCode : VSCode recrée le panel vide,
   * on réapplique les options webview puis on reprend la session via session/load.
   */
  async restoreConversation(panel: vscode.WebviewPanel, sessionId?: string, title?: string): Promise<void> {
    const nodeModulesUri = vscode.Uri.joinPath(this.context.extensionUri, "node_modules");
    panel.webview.options = { enableScripts: true, localResourceRoots: [nodeModulesUri] };
    try {
      await this.ensureConnected();
    } catch (e: any) {
      panel.webview.html = `<body style="font-family:sans-serif;padding:16px">Florian Vibe : connexion à vibe-acp échouée (${e?.message}). Rechargez la fenêtre.</body>`;
      return;
    }
    if (!this.client) return;

    const conv = this.buildPanel(panel);
    this.activePanel = conv;
    if (sessionId) {
      await conv.restore(this.registerPanel(conv), sessionId, title);
    } else {
      // Pas de sessionId persisté → on repart sur une session neuve
      await conv.start(this.registerPanel(conv));
    }
  }

  private fmtSessionDate(v: any): string {
    if (!v) return "";
    const d = new Date(typeof v === "number" && v < 1e12 ? v * 1000 : v);
    return isNaN(d.getTime()) ? String(v) : d.toLocaleString();
  }

  /** Liste des conversations enregistrées (alimente le panneau in-app via session/list). */
  async listSessionsForHistory(): Promise<{ sessionId: string; title: string; date: string }[]> {
    try {
      await this.ensureConnected();
    } catch {
      return [];
    }
    if (!this.client) return [];
    const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();
    try {
      const res = await this.client.sendRequest("session/list", { cwd });
      const sessions: any[] = res?.sessions ?? [];
      return sessions
        .filter((s) => s?.sessionId)
        .map((s) => ({
          sessionId: s.sessionId as string,
          title: s.title?.trim() || "(sans titre)",
          date: this.fmtSessionDate(s.updatedAt),
        }));
    } catch (e: any) {
      this.output.appendLine(`[session/list] échec : ${e?.message}`);
      return [];
    }
  }

  /** Ouvre (ou met au premier plan) une conversation par son id — un onglet = une session. */
  async openSessionById(sessionId: string, title?: string): Promise<void> {
    const existing = this.panels.get(sessionId);
    if (existing) { existing.reveal(); return; }
    try {
      await this.ensureConnected();
    } catch (e: any) {
      vscode.window.showErrorMessage(`Florian Vibe : ${e?.message}.`);
      return;
    }
    if (!this.client) return;
    const nodeModulesUri = vscode.Uri.joinPath(this.context.extensionUri, "node_modules");
    const panel = vscode.window.createWebviewPanel(
      "florianVibe.chat",
      title?.trim() || "Vibe",
      vscode.ViewColumn.Active,
      { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [nodeModulesUri] }
    );
    const conv = this.buildPanel(panel);
    this.activePanel = conv;
    await conv.restore(this.registerPanel(conv), sessionId, title);
  }

  /** Commande "Historique" (icône horloge de l'onglet) → ouvre le panneau in-app du panel actif. */
  async showHistory(): Promise<void> {
    let panel = this.activePanel;
    if (!panel) {
      await this.openConversation();
      panel = this.activePanel;
    }
    panel?.openHistoryOverlay();
  }
}

class ConversationPanel {
  private sessionId?: string;
  private currentMessageId?: string;
  private disposed = false;
  private pendingDiffs = new Map<string, (accepted: boolean) => void>();
  private contextDisabled = false;
  private currentContextFile?: string;
  private hasUnread = false;
  private titleSetFromPrompt = false;
  private clientMode: ClientMode = "default";
  private sessionTitle?: string;
  // Handshake : le webview poste { type: 'ready' } quand son script est prêt à recevoir des messages.
  // Indispensable pour le replay (session/load) : les chunks rejoués ne doivent pas arriver avant.
  private readyResolve: () => void = () => {};
  private readonly ready: Promise<void> = new Promise<void>((r) => { this.readyResolve = r; });
  // Icône style Claude (étoile orange). sparkle existe en codicon natif.
  private static readonly ICON_IDLE = new vscode.ThemeIcon("sparkle", new vscode.ThemeColor("charts.orange"));
  private static readonly ICON_UNREAD = new vscode.ThemeIcon("sparkle-filled", new vscode.ThemeColor("charts.orange"));

  constructor(
    private readonly panel: vscode.WebviewPanel,
    private readonly client: AcpClient,
    private readonly onDispose: (sessionId: string) => void,
    private readonly onActivate: () => void,
    private readonly getActiveUri: () => vscode.Uri | undefined,
    private readonly output: vscode.OutputChannel,
    private readonly extensionUri: vscode.Uri,
    private readonly listSessions: () => Promise<{ sessionId: string; title: string; date: string }[]>,
    private readonly openSession: (sessionId: string, title?: string) => void,
    private readonly openNew: () => void
  ) {
    panel.webview.html = this.html();
    panel.iconPath = ConversationPanel.ICON_IDLE;

    panel.onDidChangeViewState((e) => {
      if (e.webviewPanel.active) {
        this.onActivate();
        // Quand le user regarde le panel, on efface le badge "à lire"
        if (this.hasUnread) {
          this.hasUnread = false;
          panel.iconPath = ConversationPanel.ICON_IDLE;
        }
      }
    });

    panel.webview.onDidReceiveMessage(async (msg) => {
      switch (msg.type) {
        case "ready":
          this.readyResolve();
          break;
        case "requestHistory": {
          const sessions = await this.listSessions();
          this.post({ type: "historyList", sessions });
          break;
        }
        case "openSession":
          this.openSession(msg.sessionId as string, msg.title as string | undefined);
          break;
        case "renameSession":
          await this.renameSession(msg.title as string);
          break;
        case "newConversation":
          this.openNew();
          break;
        case "send":
          this.onActivate();
          await this.sendPrompt(msg.text as string, (msg.images as InlineImage[]) ?? []);
          break;
        case "cancel":
          this.cancel();
          break;
        case "setMode":
          await this.setMode(msg.modeId as string);
          break;
        case "diffDecision": {
          const resolver = this.pendingDiffs.get(msg.diffId);
          if (resolver) {
            this.pendingDiffs.delete(msg.diffId);
            resolver(!!msg.accepted);
          }
          break;
        }
        case "debug":
          this.output.appendLine(`[webview] ${msg.text}`);
          break;
        case "toggleContext":
          this.contextDisabled = !this.contextDisabled;
          this.post({
            type: "activeFile",
            filePath: this.currentContextFile,
            disabled: this.contextDisabled,
          });
          break;
        case "invokeSkill": {
          const skillName = msg.skillName as string;
          const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();
          const candidates = [
            path.join(os.homedir(), ".vibe", "skills", skillName, "SKILL.md"),
            path.join(cwd, ".vibe", "skills", skillName, "SKILL.md"),
          ];
          let body = "";
          for (const candidate of candidates) {
            try {
              const content = await fs.readFile(candidate, "utf8");
              const parts = content.split(/^---\s*$/m);
              body = parts.length >= 3 ? parts.slice(2).join("---").trim() : content.trim();
              break;
            } catch { continue; }
          }
          if (body) {
            this.onActivate();
            await this.sendPrompt(body, []);
          }
          break;
        }
      }
    });

    panel.onDidDispose(() => {
      this.disposed = true;
      // Résout les diffs en attente comme refus pour ne pas bloquer l'agent
      for (const resolver of this.pendingDiffs.values()) resolver(false);
      this.pendingDiffs.clear();
      if (this.sessionId) this.onDispose(this.sessionId);
    });
  }

  askDiff(filePath: string, isNewFile: boolean, diff: DiffLine[]): Promise<boolean> {
    if (this.disposed) return Promise.resolve(false);
    const diffId = randomUUID();
    const promise = new Promise<boolean>((resolve) => {
      this.pendingDiffs.set(diffId, resolve);
    });
    this.post({
      type: "diffProposal",
      diffId,
      filePath,
      relativePath: vscode.workspace.asRelativePath(filePath),
      isNewFile,
      diff,
    });
    this.markUnread();
    return promise;
  }

  private markUnread(): void {
    if (this.disposed || this.panel.active) return;
    if (this.hasUnread) return;
    this.hasUnread = true;
    this.panel.iconPath = ConversationPanel.ICON_UNREAD;
  }

  reveal(): void {
    this.panel.reveal();
  }

  /** Ouvre le panneau historique in-app (déclenché par l'icône horloge de l'onglet). */
  openHistoryOverlay(): void {
    this.panel.reveal();
    this.post({ type: "openHistory" });
  }

  /** Renomme la session via l'extension ACP `_session/set_title` puis synchronise l'onglet + le header. */
  private async renameSession(title: string): Promise<void> {
    const clean = (title ?? "").trim();
    if (!this.sessionId || !clean) return;
    try {
      await this.client.sendRequest("_session/set_title", { sessionId: this.sessionId, title: clean });
      this.sessionTitle = clean;
      this.panel.title = clean;
      this.post({ type: "titleSet", sessionId: this.sessionId, title: clean });
    } catch (e: any) {
      this.output.appendLine(`[session/set_title] échec : ${e?.message}`);
      this.post({ type: "system", text: `Renommage échoué : ${e?.message}` });
      this.post({ type: "titleSet", sessionId: this.sessionId, title: this.sessionTitle ?? "Nouvelle conversation" });
    }
  }

  /** Attend le handshake 'ready' du webview (avec garde-fou de 1.5s au cas où). */
  private async awaitWebviewReady(): Promise<void> {
    await Promise.race([this.ready, new Promise<void>((r) => setTimeout(r, 1500))]);
  }

  /** Scanne ~/.vibe/skills/ et .vibe/skills/ (projet) et retourne les skills trouvés. */
  private async scanSkills(): Promise<{ name: string; description: string }[]> {
    const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();
    const dirs = [
      path.join(os.homedir(), ".vibe", "skills"),
      path.join(cwd, ".vibe", "skills"),
    ];
    const skills: { name: string; description: string }[] = [];
    const seen = new Set<string>();
    for (const dir of dirs) {
      let entries: string[];
      try { entries = await fs.readdir(dir); } catch { continue; }
      for (const entry of entries) {
        const skillFile = path.join(dir, entry, "SKILL.md");
        let content: string;
        try { content = await fs.readFile(skillFile, "utf8"); } catch { continue; }
        const parts = content.split(/^---\s*$/m);
        if (parts.length < 3) continue;
        const fm = parts[1];
        const nameMatch = fm.match(/^name\s*:\s*["']?(.+?)["']?\s*$/m);
        const descMatch = fm.match(/^description\s*:\s*["']?(.+?)["']?\s*$/m);
        const name = (nameMatch?.[1] ?? entry).trim();
        const description = (descMatch?.[1] ?? "").replace(/^"|"$/g, "").trim();
        if (!seen.has(name)) { seen.add(name); skills.push({ name, description }); }
      }
    }
    return skills;
  }

  /** Active l'input et transmet modes/modèle — commun à session/new et session/load. */
  private postSessionReady(result: any): void {
    const serverModes = result?.modes?.availableModes?.map((m: any) => ({ value: m.id, name: m.name })) ?? [];
    const modesToSend = serverModes.length > 0 ? serverModes : CLIENT_MODES;
    const currentModeId = result?.modes?.currentModeId ?? this.clientMode;
    this.post({
      type: "sessionReady",
      sessionId: this.sessionId,
      currentModelId: result?.models?.currentModelId,
      modes: modesToSend,
      currentModeId,
      title: this.sessionTitle,
    });
    this.scanSkills().then((skills) => {
      if (skills.length > 0) this.post({ type: "skillsReady", skills });
    });
  }

  async start(register: (sessionId: string) => void): Promise<void> {
    const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();
    try {
      const result = await this.client.sendRequest("session/new", { cwd, mcpServers: [] });
      this.sessionId = result.sessionId;
      register(this.sessionId!);

      // Renomme l'onglet avec un titre court basé sur le dossier
      const folderName = vscode.workspace.workspaceFolders?.[0]?.name ?? "Vibe";
      this.panel.title = `Vibe — ${folderName}`;

      await this.awaitWebviewReady();
      this.postSessionReady(result);
    } catch (e: any) {
      this.post({ type: "system", text: `Création de session échouée : ${e?.message}` });
    }
  }

  /**
   * Reprend une session existante (au reload de VSCode, ou depuis l'historique).
   * Enregistre le panel AVANT session/load pour que les session/update rejoués soient routés ici,
   * puis attend le handshake webview pour ne pas perdre les chunks du replay.
   */
  async restore(register: (sessionId: string) => void, sessionId: string, title?: string): Promise<void> {
    this.sessionId = sessionId;
    register(sessionId); // panels.set AVANT le load → le replay arrive bien dans ce panel
    if (title?.trim()) {
      this.sessionTitle = title.trim();
      this.panel.title = this.sessionTitle;
    } else {
      const folderName = vscode.workspace.workspaceFolders?.[0]?.name ?? "Vibe";
      this.panel.title = `Vibe — ${folderName}`;
    }

    await this.awaitWebviewReady();
    const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();
    try {
      const result = await this.client.sendRequest("session/load", { sessionId, cwd, mcpServers: [] });
      this.postSessionReady(result);
    } catch (e: any) {
      // Session introuvable / load refusé → on bascule sur une session neuve pour garder l'onglet utilisable
      this.output.appendLine(`[session] reprise ${sessionId} échouée (${e?.message}) → nouvelle session`);
      this.post({ type: "system", text: `Reprise impossible (${e?.message}) — nouvelle session.` });
      this.sessionId = undefined;
      await this.start(register);
    }
  }

  handleSessionUpdate(update: any): void {
    if (this.disposed) return;
    // En live : on groupe sous currentMessageId (le prompt en cours). En replay (session/load) :
    // currentMessageId est absent → on prend le messageId porté par chaque update rejoué, ce qui
    // sépare bien chaque message historique dans son propre bloc.
    const messageId =
      this.currentMessageId ??
      update?.messageId ?? update?.message_id ?? update?._meta?.messageId ?? "unknown";

    switch (update?.sessionUpdate) {
      case "user_message_chunk":
        // Émis uniquement au replay (session/load) — affiche les prompts de l'utilisateur.
        this.post({ type: "chunk", messageId, role: "user", text: update.content?.text ?? "" });
        break;
      case "agent_message_chunk":
        this.post({ type: "chunk", messageId, role: "assistant", text: update.content?.text ?? "" });
        break;
      case "agent_thought_chunk":
        this.post({ type: "chunk", messageId, role: "thought", text: update.content?.text ?? "" });
        break;
      case "tool_call":
        this.post({
          type: "toolCall",
          messageId,
          toolCallId: update.toolCallId,
          title: update.title ?? update.kind ?? "tool",
          kind: update.kind,
          content: extractToolContent(update.content),
        });
        break;
      case "tool_call_update":
        this.post({
          type: "toolCallUpdate",
          toolCallId: update.toolCallId,
          status: update.status ?? "in_progress",
          content: extractToolContent(update.content),
        });
        break;
      case "current_mode_update":
        // Le serveur informe d'un changement de mode (par ex. après un set_mode ou un déclencheur côté agent)
        this.post({ type: "modeChanged", modeId: update.currentModeId });
        break;
    }
  }

  notifySystem(text: string): void {
    this.post({ type: "system", text });
  }

  updateActiveFile(filePath: string | undefined): void {
    // Si le fichier change, on réactive le contexte par défaut
    if (filePath !== this.currentContextFile) {
      this.contextDisabled = false;
      this.currentContextFile = filePath;
    }
    // Le chip reste affiché même si désactivé — seul l'état visuel change (œil ouvert/fermé)
    this.post({
      type: "activeFile",
      filePath: filePath,
      disabled: this.contextDisabled,
    });
  }

  notifyDisconnected(): void {
    this.post({ type: "system", text: "Connexion ACP perdue." });
  }

  private async sendPrompt(text: string, images: InlineImage[] = []): Promise<void> {
    if ((!text.trim() && images.length === 0) || !this.sessionId) return;

    // Premier prompt → met à jour le titre de l'onglet avec un résumé du prompt
    if (!this.titleSetFromPrompt) {
      const summary = text.replace(/\s+/g, " ").trim().slice(0, 50);
      if (summary) {
        this.panel.title = summary + (text.length > 50 ? "…" : "");
        this.titleSetFromPrompt = true;
      }
    }

    const blocks: PromptBlock[] = [];

    // Auto-context : lit le document FRAIS depuis l'URI (évite TextEditor obsolète/disposé)
    const ctxUri = this.contextDisabled ? undefined : this.getActiveUri();
    if (ctxUri) {
      const filePath = vscode.workspace.asRelativePath(ctxUri);
      try {
        const doc = await vscode.workspace.openTextDocument(ctxUri);
        // Sélection : seulement si un éditeur visible existe pour ce doc
        const visible = vscode.window.visibleTextEditors.find(
          (e) => e.document.uri.toString() === ctxUri.toString()
        );
        const selectionText = visible && !visible.selection.isEmpty
          ? doc.getText(visible.selection)
          : "";

        if (selectionText) {
          blocks.push({
            type: "text",
            text: `[Sélection dans ${filePath}]\n\`\`\`\n${selectionText}\n\`\`\`\n`,
          });
          this.output.appendLine(`[ctx] envoi sélection de ${filePath} (${selectionText.length} chars)`);
        } else {
          const content = doc.getText();
          const truncated = content.length > 10000 ? content.slice(0, 10000) + "\n...(tronqué)" : content;
          blocks.push({
            type: "text",
            text: `[Fichier actif : ${filePath}]\n\`\`\`\n${truncated}\n\`\`\`\n`,
          });
          this.output.appendLine(`[ctx] envoi fichier ${filePath} (${content.length} chars)`);
        }
      } catch (e: any) {
        this.output.appendLine(`[ctx] échec lecture ${filePath} : ${e?.message}`);
      }
    } else {
      this.output.appendLine(`[ctx] aucun contexte fichier (disabled=${this.contextDisabled}, uri=${this.getActiveUri()?.toString() ?? "none"})`);
    }

    if (text.trim()) blocks.push({ type: "text", text });

    // Chemin A : blocs image natifs ACP (`{ type: "image", mimeType, data }`).
    for (const img of images) {
      blocks.push({ type: "image", mimeType: img.mimeType, data: img.data });
    }
    if (images.length > 0) {
      this.output.appendLine(`[image] ${images.length} image(s) jointe(s) (chemin A : bloc ACP natif)`);
    }

    const messageId = randomUUID();
    this.currentMessageId = messageId;
    // L'affichage des images se fait côté webview via des chips cliquables (pas de suffixe texte).
    const userText = text;
    this.post({ type: "userMessage", messageId, text: userText });

    try {
      await this.client.sendRequest("session/prompt", {
        sessionId: this.sessionId,
        prompt: blocks,
        messageId,
      });
      this.post({ type: "streamEnd", messageId });
      this.markUnread();
    } catch (e: any) {
      // Chemin A a échoué. Si des images étaient jointes, c'est probablement que
      // vibe-acp refuse les blocs image → fallback B : on les décrit en texte.
      if (images.length > 0) {
        this.output.appendLine(
          `[image] chemin A refusé (${e?.message}) → fallback B (description texte)`
        );
        try {
          const textBlocks: PromptBlock[] = blocks.filter((b) => b.type === "text");
          for (let i = 0; i < images.length; i++) {
            const desc = await describeImage(images[i]);
            textBlocks.push({
              type: "text",
              text: `[Image ${i + 1} (jointe, décrite automatiquement)]\n${desc}\n`,
            });
          }
          await this.client.sendRequest("session/prompt", {
            sessionId: this.sessionId,
            prompt: textBlocks,
            messageId,
          });
          this.post({ type: "system", text: "ℹ️ Images transmises via description texte (fallback)." });
          this.post({ type: "streamEnd", messageId });
          this.markUnread();
          return;
        } catch (e2: any) {
          this.post({ type: "streamEnd", messageId, error: e2?.message });
          this.post({
            type: "system",
            text: `Image non transmise — chemin A : ${e?.message} ; fallback B : ${e2?.message}`,
          });
          this.markUnread();
          return;
        }
      }
      this.post({ type: "streamEnd", messageId, error: e?.message });
      this.post({ type: "system", text: `Prompt échoué : ${e?.message}` });
      this.markUnread();
    } finally {
      this.currentMessageId = undefined;
    }
  }

  private cancel(): void {
    if (this.sessionId) {
      this.client.sendNotification("session/cancel", { sessionId: this.sessionId });
    }
  }

  get currentClientMode(): ClientMode {
    return this.clientMode;
  }

  private async setMode(modeId: string): Promise<void> {
    if (!this.sessionId || !modeId) return;
    // Si c'est un de nos modes client, on l'applique localement
    if (CLIENT_MODES.some((m) => m.value === modeId)) {
      this.clientMode = modeId as ClientMode;
      this.post({ type: "modeChanged", modeId });
      return;
    }
    // Sinon on tente la voie ACP serveur (au cas où Vibe expose des modes dans une future version)
    try {
      await this.client.sendRequest("session/set_mode", {
        sessionId: this.sessionId,
        modeId,
      });
      this.post({ type: "modeChanged", modeId });
    } catch (e: any) {
      this.post({ type: "system", text: `Changement de mode échoué : ${e?.message}` });
    }
  }

  private post(payload: unknown): void {
    if (this.disposed) return;
    this.panel.webview.postMessage(payload);
  }

  private html(): string {
    const nonce = Math.random().toString(36).slice(2);
    const webview = this.panel.webview;
    const markedUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, "node_modules", "marked", "lib", "marked.umd.js")
    );
    const purifyUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, "node_modules", "dompurify", "dist", "purify.min.js")
    );
    const prismJs = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, "node_modules", "prismjs", "prism.js")
    );
    const prismCss = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, "node_modules", "prismjs", "themes", "prism-tomorrow.css")
    );
    const prismLangs = ["bash", "python", "typescript", "tsx", "jsx", "json", "yaml", "markdown", "css", "go", "rust", "sql"]
      .map((lang) => webview.asWebviewUri(
        vscode.Uri.joinPath(this.extensionUri, "node_modules", "prismjs", "components", `prism-${lang}.js`)
      ));
    const cspSource = webview.cspSource;
    return /* html */ `<!doctype html>
<html lang="fr">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${cspSource} data: blob:; style-src 'unsafe-inline' ${cspSource}; script-src ${cspSource} 'nonce-${nonce}';">
<link rel="stylesheet" href="${prismCss}">
<style>
  body { padding: 0; margin: 0; font-family: var(--vscode-font-family); color: var(--vscode-foreground); background: var(--vscode-editor-background); display: flex; flex-direction: column; height: 100vh; --mode-color: var(--vscode-descriptionForeground); --send-color: var(--vscode-charts-orange); }
  body.mode-plan { --mode-color: var(--vscode-charts-blue); }
  body.mode-accept { --mode-color: var(--vscode-charts-green); }
  body.mode-auto, body.mode-bypass { --mode-color: var(--vscode-charts-orange); }
  body.mode-chat { --mode-color: var(--vscode-charts-purple); }
  #log { flex: 1; overflow-y: auto; padding: 16px 20px; width: 100%; margin: 0 auto; box-sizing: border-box; }
  .msg { margin: 18px 0; padding: 0; background: transparent; border: 0; line-height: 1.55; }
  .msg.user { background: transparent; padding: 8px 12px; border-radius: 8px; border-left: 0; color: var(--vscode-foreground); border: 1px solid var(--vscode-input-border, var(--vscode-panel-border)); white-space: pre-wrap; word-wrap: break-word; }
  .msg.assistant { display: flex; align-items: flex-start; gap: 10px; white-space: normal; word-wrap: break-word; }
  .msg.assistant::before { content: "●"; color: var(--vscode-charts-green); flex-shrink: 0; font-size: 0.7em; line-height: 1; margin-top: 0.55em; }
  .msg.assistant > .body { flex: 1; min-width: 0; }
  .msg.assistant .body { white-space: normal; }
  .msg.assistant .body p { margin: 0.5em 0; white-space: pre-wrap; }
  .msg.assistant .body p:first-child { margin-top: 0; }
  .msg.assistant .body p:last-child { margin-bottom: 0; }
  .msg.assistant .body h1, .msg.assistant .body h2, .msg.assistant .body h3, .msg.assistant .body h4 { margin: 0.8em 0 0.3em; line-height: 1.2; }
  .msg.assistant .body h1 { font-size: 1.4em; border-bottom: 1px solid var(--vscode-panel-border); padding-bottom: 0.2em; }
  .msg.assistant .body h2 { font-size: 1.2em; }
  .msg.assistant .body h3 { font-size: 1.08em; }
  .msg.assistant .body h4 { font-size: 1em; opacity: 0.85; }
  .msg.assistant .body ul, .msg.assistant .body ol { margin: 0.4em 0; padding-left: 1.5em; }
  .msg.assistant .body li { margin: 0.15em 0; }
  .msg.assistant .body code { background: var(--vscode-textCodeBlock-background); padding: 1px 5px; border-radius: 3px; font-family: var(--vscode-editor-font-family); font-size: 0.92em; }
  .msg.assistant .body pre { background: var(--vscode-textCodeBlock-background) !important; padding: 10px 12px; border-radius: 4px; overflow-x: auto; margin: 0.5em 0; font-family: var(--vscode-editor-font-family); }
  .msg.assistant .body pre[class*="language-"] { background: var(--vscode-textCodeBlock-background) !important; text-shadow: none; }
  .msg.assistant .body pre code { background: transparent !important; padding: 0; font-size: 0.9em; line-height: 1.4; font-family: var(--vscode-editor-font-family); text-shadow: none; }
  .msg.assistant .body code[class*="language-"], .msg.assistant .body pre[class*="language-"] { font-family: var(--vscode-editor-font-family); text-shadow: none; }
  .msg.assistant .body blockquote { border-left: 3px solid var(--vscode-textBlockQuote-border, var(--vscode-panel-border)); margin: 0.4em 0; padding: 2px 12px; background: var(--vscode-textBlockQuote-background); color: var(--vscode-descriptionForeground); }
  .msg.assistant .body table { border-collapse: collapse; margin: 0.5em 0; }
  .msg.assistant .body th, .msg.assistant .body td { border: 1px solid var(--vscode-panel-border); padding: 4px 8px; }
  .msg.assistant .body th { background: var(--vscode-editor-background); font-weight: 600; }
  .msg.assistant .body a { color: var(--vscode-textLink-foreground); }
  .msg.assistant .body hr { border: 0; border-top: 1px solid var(--vscode-panel-border); margin: 0.8em 0; }
  .msg.assistant .body strong { font-weight: 600; }
  .msg.thought { display: flex; align-items: flex-start; gap: 10px; color: var(--vscode-descriptionForeground); font-size: 0.92em; }
  .msg.thought::before { content: "●"; flex-shrink: 0; font-size: 0.7em; line-height: 1; margin-top: 0.55em; color: var(--vscode-descriptionForeground); }
  .msg.thought .body { flex: 1; min-width: 0; color: var(--vscode-descriptionForeground); }
  .msg.thought .thinking-label { font-weight: 500; cursor: pointer; user-select: none; display: inline-flex; align-items: center; gap: 4px; }
  .msg.thought .thinking-label .caret { opacity: 0.5; font-size: 0.85em; transition: transform 0.15s; }
  .msg.thought.expanded .thinking-label .caret { transform: rotate(180deg); }
  .msg.thought .thinking-content { font-style: italic; margin-top: 6px; white-space: pre-wrap; word-wrap: break-word; padding-left: 0; border-left: 0; }
  .msg.thought .thinking-content.collapsed { display: none; }
  .msg.system { color: var(--vscode-descriptionForeground); font-size: 0.85em; padding: 4px 12px; white-space: pre-wrap; }
  #slash-menu { position: absolute; bottom: calc(100% + 4px); left: 0; right: 0; max-width: 540px; background: var(--vscode-menu-background, var(--vscode-editor-background)); border: 1px solid var(--vscode-menu-border, var(--vscode-panel-border)); border-radius: 8px; padding: 4px 0; display: none; z-index: 9999; box-shadow: 0 6px 20px rgba(0,0,0,0.5); }
  #slash-menu.visible { display: block; }
  .slash-item { padding: 6px 12px; cursor: pointer; display: flex; align-items: center; gap: 8px; border-radius: 4px; margin: 1px 3px; }
  .slash-item:hover, .slash-item.active { background: var(--vscode-list-hoverBackground); }
  .slash-item .slash-name { font-family: var(--vscode-editor-font-family); font-weight: 600; color: var(--vscode-charts-orange); min-width: 80px; }
  .slash-item.skill .slash-name { color: var(--vscode-charts-blue, #75beff); }
  .slash-item .slash-args { font-family: var(--vscode-editor-font-family); color: var(--vscode-descriptionForeground); font-size: 0.85em; min-width: 55px; }
  .slash-item .slash-desc { color: var(--vscode-descriptionForeground); font-size: 0.88em; flex: 1; }
  .thinking-indicator { display: flex; align-items: center; gap: 10px; color: var(--vscode-descriptionForeground); font-size: 0.92em; margin: 18px 0; padding: 0; }
  .thinking-indicator::before { content: "●"; color: var(--vscode-charts-orange); flex-shrink: 0; font-size: 0.7em; line-height: 1; margin-top: 0.55em; animation: vibe-pulse 1.2s ease-in-out infinite; }
  @keyframes vibe-pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.3; } }
  .msg.tool { display: flex; align-items: flex-start; gap: 10px; }
  .msg.tool::before { content: "●"; color: var(--vscode-charts-orange); flex-shrink: 0; font-size: 0.7em; line-height: 1; margin-top: 0.55em; }
  .msg.tool.tool-completed::before { color: var(--vscode-charts-green); }
  .msg.tool.tool-failed::before { color: var(--vscode-charts-red); }
  .msg.tool .body { flex: 1; min-width: 0; }
  .msg.tool .tool-header { font-weight: 600; margin-bottom: 6px; line-height: 1.4; }
  .msg.tool .tool-header .tool-kind { color: var(--vscode-charts-orange); font-family: var(--vscode-editor-font-family); }
  .msg.tool .tool-header .tool-title { color: var(--vscode-descriptionForeground); font-weight: normal; margin-left: 6px; font-size: 0.95em; }
  .msg.tool .tool-block { font-family: var(--vscode-editor-font-family); font-size: 0.88em; background: var(--vscode-textCodeBlock-background); border-radius: 4px; padding: 8px 10px; margin: 4px 0; max-height: 240px; overflow-y: auto; }
  .msg.tool .tool-block-label { font-size: 0.7em; font-weight: 600; opacity: 0.6; text-transform: uppercase; margin-bottom: 4px; letter-spacing: 0.5px; }
  .msg.tool .tool-block-content { white-space: pre-wrap; word-wrap: break-word; }
  .msg.diff { background: var(--vscode-editorWidget-background); border: 1px solid var(--vscode-panel-border); padding: 0; overflow: hidden; }
  .diff-header { padding: 8px 12px; display: flex; justify-content: space-between; align-items: center; background: var(--vscode-editor-background); border-bottom: 1px solid var(--vscode-panel-border); font-size: 0.9em; }
  .diff-header .path { font-family: var(--vscode-editor-font-family); font-weight: 600; }
  .diff-header .badge { padding: 2px 8px; border-radius: 10px; font-size: 0.75em; background: var(--vscode-charts-blue); color: var(--vscode-foreground); }
  .diff-header .badge.new { background: var(--vscode-charts-green); }
  .diff-body { font-family: var(--vscode-editor-font-family); font-size: 0.85em; max-height: 300px; overflow-y: auto; }
  .diff-line { display: block; padding: 1px 12px 1px 28px; white-space: pre; position: relative; }
  .diff-line::before { position: absolute; left: 8px; opacity: 0.6; }
  .diff-line.add { background: rgba(46, 160, 67, 0.15); color: var(--vscode-charts-green); }
  .diff-line.add::before { content: "+"; }
  .diff-line.del { background: rgba(248, 81, 73, 0.15); color: var(--vscode-charts-red); }
  .diff-line.del::before { content: "−"; }
  .diff-line.same { color: var(--vscode-descriptionForeground); opacity: 0.6; }
  .diff-actions { padding: 8px 12px; display: flex; gap: 8px; justify-content: flex-end; background: var(--vscode-editor-background); border-top: 1px solid var(--vscode-panel-border); }
  .diff-actions button { font-size: 0.85em; }
  .diff-actions .accept { background: var(--vscode-charts-green); color: var(--vscode-foreground); }
  .diff-actions .reject { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
  .diff-actions .done { color: var(--vscode-descriptionForeground); padding: 4px 14px; font-size: 0.85em; }
  #input-area { padding: 12px 16px 14px; max-width: 920px; width: 100%; margin: 0 auto; box-sizing: border-box; position: relative; }
  #compose { background: var(--vscode-input-background); border: 1px solid var(--mode-color); border-radius: 12px; padding: 10px 12px; display: flex; flex-direction: column; gap: 8px; transition: border-color 0.15s, box-shadow 0.15s; }
  #compose:focus-within { box-shadow: 0 0 0 1px var(--mode-color); }
  #compose.dragover { border-color: var(--mode-color); box-shadow: 0 0 0 2px var(--mode-color); }
  #attachments { display: flex; flex-wrap: wrap; gap: 6px; }
  #attachments:empty { display: none; }
  .attachment { position: relative; width: 52px; height: 52px; border-radius: 8px; overflow: hidden; border: 1px solid var(--vscode-panel-border); background: var(--vscode-input-background); }
  .attachment img { width: 100%; height: 100%; object-fit: cover; display: block; }
  .attachment .remove { position: absolute; top: 1px; right: 1px; width: 16px; height: 16px; border-radius: 50%; border: 0; cursor: pointer; background: rgba(0,0,0,0.6); color: #fff; font-size: 11px; line-height: 16px; padding: 0; display: flex; align-items: center; justify-content: center; }
  .attachment .remove:hover { background: rgba(0,0,0,0.85); }
  .msg .user-image { max-width: 220px; max-height: 220px; border-radius: 8px; margin-top: 6px; display: block; }
  .msg .user-images { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 8px; }
  .img-chip { display: inline-flex; align-items: center; gap: 7px; max-width: 100%; padding: 4px 10px 4px 5px; border: 1px solid var(--vscode-input-border, var(--vscode-panel-border)); border-radius: 8px; background: var(--vscode-input-background); cursor: pointer; font-size: 0.85em; transition: background 0.15s, border-color 0.15s; }
  .img-chip:hover { background: var(--vscode-list-hoverBackground); border-color: var(--mode-color); }
  .img-chip .thumb { width: 26px; height: 26px; border-radius: 5px; object-fit: cover; flex-shrink: 0; display: block; }
  .img-chip .name { color: var(--vscode-foreground); font-family: var(--vscode-editor-font-family); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 180px; }
  .img-chip .dims { color: var(--vscode-descriptionForeground); flex-shrink: 0; }
  #lightbox { position: fixed; inset: 0; background: rgba(0,0,0,0.8); display: none; align-items: center; justify-content: center; z-index: 99999; cursor: zoom-out; padding: 32px; box-sizing: border-box; }
  #lightbox.visible { display: flex; }
  #lightbox img { max-width: 100%; max-height: 100%; border-radius: 6px; box-shadow: 0 8px 40px rgba(0,0,0,0.6); }
  /* Barre d'en-tête (titre + actions), façon Claude Code — tout en haut */
  #header { display: flex; align-items: center; gap: 6px; padding: 7px 12px; border-bottom: 1px solid var(--vscode-panel-border); flex-shrink: 0; }
  #conv-title { flex: 1; min-width: 0; font-weight: 600; font-size: 0.95em; color: var(--vscode-foreground); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; cursor: text; padding: 3px 6px; border-radius: 6px; }
  #conv-title:hover { background: var(--vscode-list-hoverBackground); }
  #conv-title-input { flex: 1; min-width: 0; font-weight: 600; font-size: 0.95em; font-family: var(--vscode-font-family); background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--mode-color); border-radius: 6px; padding: 3px 6px; outline: none; display: none; }
  .header-btn { background: transparent; color: var(--vscode-descriptionForeground); border: 0; padding: 4px 6px; border-radius: 6px; cursor: pointer; display: inline-flex; align-items: center; justify-content: center; min-width: 26px; }
  .header-btn:hover { background: var(--vscode-list-hoverBackground); color: var(--vscode-foreground); }
  /* Historique des conversations (panneau in-app façon Claude) — descend depuis le header */
  #history-overlay { position: fixed; left: 0; right: 0; top: 46px; margin: 0 auto; max-width: 880px; width: calc(100% - 32px); max-height: 52vh; background: var(--vscode-menu-background, var(--vscode-editor-background)); border: 1px solid var(--vscode-menu-border, var(--vscode-panel-border)); border-radius: 12px; box-shadow: 0 10px 40px rgba(0,0,0,0.55); display: none; flex-direction: column; overflow: hidden; z-index: 9998; }
  #history-overlay.visible { display: flex; }
  #history-search { background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 0; border-bottom: 1px solid var(--vscode-panel-border); padding: 10px 14px; outline: none; font-family: var(--vscode-font-family); font-size: 0.92em; }
  #history-list { overflow-y: auto; padding: 5px; }
  .history-item { padding: 8px 12px; border-radius: 7px; cursor: pointer; display: flex; justify-content: space-between; align-items: center; gap: 12px; }
  .history-item:hover { background: var(--vscode-list-hoverBackground); }
  .history-item .h-title { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; color: var(--vscode-foreground); }
  .history-item .h-date { flex-shrink: 0; color: var(--vscode-descriptionForeground); font-size: 0.8em; }
  .history-empty { padding: 16px; color: var(--vscode-descriptionForeground); font-size: 0.88em; text-align: center; }
  #active-file { display: none; align-items: center; gap: 4px; font-size: 0.82em; }
  #active-file.visible { display: inline-flex; }
  #active-file .chip { background: transparent; border: 0; padding: 2px 6px; border-radius: 6px; font-family: var(--vscode-editor-font-family); cursor: pointer; display: inline-flex; align-items: center; gap: 5px; color: var(--vscode-descriptionForeground); transition: color 0.15s, background 0.15s; }
  #active-file .chip:hover { background: var(--vscode-list-hoverBackground); color: var(--vscode-foreground); }
  #active-file .chip.disabled { opacity: 0.5; }
  #active-file .chip.disabled #active-file-name { text-decoration: line-through; }
  #active-file .chip .eye { width: 13px; height: 13px; flex-shrink: 0; opacity: 0.7; }
  #active-file .chip:hover .eye { opacity: 1; }
  #active-file .chip .eye-closed { display: none; }
  #active-file .chip.disabled .eye-open { display: none; }
  #active-file .chip.disabled .eye-closed { display: inline-block; }
  #active-file .file-icon { font-size: 0.95em; opacity: 0.7; }
  .compose-action-btn { background: transparent; color: var(--vscode-descriptionForeground); border: 0; padding: 4px 6px; border-radius: 6px; cursor: pointer; font-size: 1em; line-height: 1; display: inline-flex; align-items: center; justify-content: center; min-width: 22px; }
  .compose-action-btn:hover { background: var(--vscode-list-hoverBackground); color: var(--vscode-foreground); }
  #prompt { background: transparent; color: var(--vscode-input-foreground); border: 0; outline: none; padding: 4px 0; font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); resize: none; min-height: 28px; max-height: 200px; width: 100%; box-sizing: border-box; overflow-y: auto; }
  #compose-actions { display: flex; align-items: center; gap: 8px; }
  #compose-actions .left { display: flex; gap: 6px; align-items: center; flex: 1; }
  #compose-actions .right { display: flex; gap: 6px; align-items: center; }
  #send-btn { background: var(--send-color); color: var(--vscode-button-foreground); border: none; width: 28px; height: 28px; border-radius: 50%; cursor: pointer; display: inline-flex; align-items: center; justify-content: center; font-size: 1em; padding: 0; transition: filter 0.15s; }
  #send-btn:hover { filter: brightness(1.15); }
  #send-btn:disabled { opacity: 0.4; cursor: not-allowed; }
  #cancel-btn { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); border: none; padding: 3px 10px; border-radius: 12px; font-size: 0.82em; cursor: pointer; }
  #status { font-size: 0.78em; color: var(--vscode-descriptionForeground); padding: 0 4px; margin-top: 4px; }
  /* Bouton mode (intégré dans le compose) */
  #mode-wrapper { position: relative; display: none; }
  #mode-wrapper.visible { display: inline-block; }
  #mode-btn { background: transparent; color: var(--vscode-descriptionForeground); border: 0; padding: 3px 8px; border-radius: 10px; font-size: 0.82em; cursor: pointer; display: inline-flex; align-items: center; gap: 4px; }
  #mode-btn:hover { background: var(--vscode-list-hoverBackground); color: var(--vscode-foreground); }
  #mode-btn .icon-bolt { display: inline-block; width: 12px; }
  #mode-btn.mode-plan { color: var(--vscode-charts-blue); }
  #mode-btn.mode-accept { color: var(--vscode-charts-green); }
  #mode-btn.mode-auto, #mode-btn.mode-bypass { color: var(--vscode-charts-orange); }
  #mode-btn.mode-chat { color: var(--vscode-charts-purple); }
  #mode-menu { position: absolute; bottom: calc(100% + 6px); right: 0; background: var(--vscode-menu-background, var(--vscode-editor-background)); border: 1px solid var(--vscode-menu-border, var(--vscode-panel-border)); border-radius: 6px; padding: 4px 0; min-width: 220px; display: none; z-index: 9999; box-shadow: 0 4px 12px rgba(0,0,0,0.5); }
  #mode-menu.visible { display: block; }
  #mode-menu .mode-item { padding: 6px 14px; cursor: pointer; font-size: 0.88em; display: flex; align-items: center; justify-content: space-between; gap: 10px; color: var(--vscode-foreground); }
  #mode-menu .mode-item:hover { background: var(--vscode-menu-selectionBackground, var(--vscode-list-hoverBackground)); color: var(--vscode-menu-selectionForeground); }
  #mode-menu .mode-item .check { opacity: 0; }
  #mode-menu .mode-item.current .check { opacity: 1; }
  button { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: none; padding: 6px 14px; border-radius: 3px; cursor: pointer; font-size: 0.9em; }
  button:hover { background: var(--vscode-button-hoverBackground); }
  button.secondary { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
  button:disabled { opacity: 0.5; cursor: not-allowed; }
</style>
</head>
<body>
  <div id="header">
    <div id="conv-title" title="Cliquer pour renommer">Nouvelle conversation</div>
    <input id="conv-title-input" type="text" autocomplete="off">
    <button class="header-btn" id="header-history-btn" type="button" title="Historique des conversations">
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><polyline points="12 7.5 12 12 15 14"/></svg>
    </button>
    <button class="header-btn" id="header-new-btn" type="button" title="Nouvelle conversation">
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
    </button>
  </div>
  <div id="log"></div>
  <div id="input-area">
    <div id="slash-menu"></div>
    <div id="compose">
      <div id="attachments"></div>
      <textarea id="prompt" placeholder="ctrl esc to focus or unfocus Vibe" rows="1" disabled></textarea>
      <input type="file" id="file-input" accept="image/*" multiple style="display:none">
      <div id="compose-actions">
        <div class="left">
          <button class="compose-action-btn" id="upload-btn" type="button" title="Joindre une image (ou coller / glisser-déposer)" disabled>+</button>
          <button class="compose-action-btn" id="slash-btn" type="button" title="Slash commands">/</button>
          <div id="active-file">
            <span class="chip" id="active-file-chip" title="Cliquer pour inclure/exclure du contexte">
              <span class="file-icon">📄</span>
              <span id="active-file-name"></span>
              <svg class="eye eye-open" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
              <svg class="eye eye-closed" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>
            </span>
          </div>
        </div>
        <div class="right">
          <div id="mode-wrapper">
            <button id="mode-btn" type="button" title="Changer de mode">
              <span class="icon-bolt">⚡</span>
              <span id="mode-label">Mode</span>
            </button>
            <div id="mode-menu"></div>
          </div>
          <button id="cancel-btn" style="display:none" title="Annuler la requête">Annuler</button>
          <button id="send-btn" disabled title="Entrée">↑</button>
        </div>
      </div>
    </div>
    <div id="status">Connexion à vibe-acp…</div>
  </div>
  <div id="lightbox"><img alt="aperçu"></div>
  <div id="history-overlay">
    <input id="history-search" type="text" placeholder="Rechercher une conversation…" autocomplete="off">
    <div id="history-list"></div>
  </div>
<script nonce="${nonce}">
  let vscode;
  try { vscode = acquireVsCodeApi(); } catch (e) { console.error('acquireVsCodeApi failed', e); }
  function debug(msg) {
    try { if (vscode) vscode.postMessage({ type: 'debug', text: msg }); } catch (_) {}
  }
  // marked et DOMPurify sont chargés APRÈS ce script (en fin de body). On les résout lazy.
  let markdownErrorLogged = false;
  function renderMarkdown(text) {
    // Résout lazy : marked et DOMPurify sont chargés après ce script
    const md = (typeof marked !== 'undefined') ? marked : null;
    const purify = (typeof DOMPurify !== 'undefined') ? DOMPurify : null;
    if (!md || !purify) return null;
    try {
      const html = md.parse(text);
      if (typeof html !== 'string') {
        if (!markdownErrorLogged) { debug('marked.parse returned non-string: ' + typeof html); markdownErrorLogged = true; }
        return null;
      }
      return purify.sanitize(html, { USE_PROFILES: { html: true } });
    } catch (e) {
      if (!markdownErrorLogged) { debug('markdown error: ' + (e && e.message ? e.message : e)); markdownErrorLogged = true; }
      return null;
    }
  }
  const log = document.getElementById('log');
  const input = document.getElementById('prompt');
  const sendBtn = document.getElementById('send-btn');
  const cancelBtn = document.getElementById('cancel-btn');
  const composeEl = document.getElementById('compose');
  const uploadBtn = document.getElementById('upload-btn');
  const fileInput = document.getElementById('file-input');
  const attachmentsEl = document.getElementById('attachments');
  const status = document.getElementById('status');

  // Blocs indexés par (messageId + role) → garantit thought et assistant séparés.
  const blocks = new Map();
  let busy = false;
  let thinkingIndicator = null;

  function showThinkingIndicator() {
    if (thinkingIndicator) return;
    thinkingIndicator = document.createElement('div');
    thinkingIndicator.className = 'thinking-indicator';
    thinkingIndicator.textContent = 'Processing…';
    log.appendChild(thinkingIndicator);
    log.scrollTop = log.scrollHeight;
  }
  function hideThinkingIndicator() {
    if (thinkingIndicator) {
      thinkingIndicator.remove();
      thinkingIndicator = null;
    }
  }
  const activeFileEl = document.getElementById('active-file');
  const activeFileNameEl = document.getElementById('active-file-name');
  const modeWrapperEl = document.getElementById('mode-wrapper');
  const modeBtnEl = document.getElementById('mode-btn');
  const modeLabelEl = document.getElementById('mode-label');
  const modeMenuEl = document.getElementById('mode-menu');
  let availableModes = [];
  let currentModeId = null;

  function classifyMode(modeId) {
    const id = (modeId || '').toLowerCase();
    if (id.includes('plan')) return 'mode-plan';
    if (id.includes('accept')) return 'mode-accept';
    if (id.includes('bypass') || id.includes('auto') || id.includes('yolo')) return 'mode-auto';
    if (id.includes('chat')) return 'mode-chat';
    return '';
  }

  function modeLabelFor(modeId) {
    const m = availableModes.find(x => x.value === modeId);
    return m ? m.name : (modeId || 'Mode');
  }

  function renderModeMenu() {
    debug('renderModeMenu start — availableModes.length: ' + availableModes.length + ', modeMenuEl exists: ' + !!modeMenuEl);
    if (!modeMenuEl) return;
    modeMenuEl.innerHTML = '';
    for (const m of availableModes) {
      const item = document.createElement('div');
      item.className = 'mode-item' + (m.value === currentModeId ? ' current' : '');
      const left = document.createElement('span');
      left.textContent = m.name;
      const check = document.createElement('span');
      check.className = 'check';
      check.textContent = '✓';
      item.appendChild(left);
      item.appendChild(check);
      item.addEventListener('click', () => {
        modeMenuEl.classList.remove('visible');
        if (m.value !== currentModeId) {
          vscode.postMessage({ type: 'setMode', modeId: m.value });
          currentModeId = m.value;
          updateModeButton();
        }
      });
      modeMenuEl.appendChild(item);
    }
    debug('renderModeMenu done — children after: ' + modeMenuEl.children.length);
  }

  function updateModeButton() {
    modeLabelEl.textContent = modeLabelFor(currentModeId);
    modeBtnEl.className = '';
    const cls = classifyMode(currentModeId);
    if (cls) modeBtnEl.classList.add(cls);
    // Propage la classe au body pour pouvoir styler la bordure du compose + bouton Envoyer via CSS vars
    document.body.classList.remove('mode-plan', 'mode-accept', 'mode-auto', 'mode-bypass', 'mode-chat');
    if (cls) document.body.classList.add(cls);
    renderModeMenu();
  }

  let menuOpening = false;
  modeBtnEl.addEventListener('click', (e) => {
    e.stopPropagation();
    e.preventDefault();
    menuOpening = true;
    debug('mode-btn click — items rendered: ' + modeMenuEl.children.length + ', wasVisible: ' + modeMenuEl.classList.contains('visible'));
    modeMenuEl.classList.toggle('visible');
    setTimeout(() => { menuOpening = false; }, 50);
  });
  document.addEventListener('click', (e) => {
    if (menuOpening) return;
    if (!modeWrapperEl.contains(e.target)) {
      if (modeMenuEl.classList.contains('visible')) {
        debug('doc.click closing menu — target: ' + (e.target && e.target.tagName));
      }
      modeMenuEl.classList.remove('visible');
    }
  });

  function cycleMode() {
    if (availableModes.length === 0) return;
    const idx = availableModes.findIndex(x => x.value === currentModeId);
    const next = availableModes[(idx + 1) % availableModes.length];
    currentModeId = next.value;
    updateModeButton();
    vscode.postMessage({ type: 'setMode', modeId: next.value });
  }
  // Shift+Tab dans le textarea cycle les modes (façon Claude Code)
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Tab' && e.shiftKey) {
      e.preventDefault();
      cycleMode();
    }
  });
  // Shift+Tab partout dans la webview aussi (au cas où le textarea n'a pas le focus)
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Tab' && e.shiftKey && document.activeElement !== input) {
      e.preventDefault();
      cycleMode();
    }
  });
  const activeFileChipEl = document.getElementById('active-file-chip');
  activeFileChipEl.addEventListener('click', () => {
    // Toggle visuel optimiste — le backend confirmera via un message activeFile
    activeFileChipEl.classList.toggle('disabled');
    vscode.postMessage({ type: 'toggleContext' });
  });

  const defaultPlaceholder = 'ctrl esc to focus or unfocus Vibe';
  const busyPlaceholder = 'Queue another message…';
  function setBusy(v) {
    busy = v;
    sendBtn.disabled = v;
    cancelBtn.style.display = v ? '' : 'none';
    input.placeholder = v ? busyPlaceholder : defaultPlaceholder;
    if (v) showThinkingIndicator();
    else hideThinkingIndicator();
  }

  function createBlock(role, messageId) {
    const div = document.createElement('div');
    div.className = 'msg ' + role;

    if (role === 'thought') {
      // ● Thinking ▾ (collapsible, OUVERT par défaut pour visibilité)
      const body = document.createElement('div');
      body.className = 'body';
      const label = document.createElement('span');
      label.className = 'thinking-label';
      label.innerHTML = 'Thinking <span class="caret">▾</span>';
      const content = document.createElement('div');
      content.className = 'thinking-content';
      div.classList.add('expanded');
      label.addEventListener('click', () => {
        content.classList.toggle('collapsed');
        div.classList.toggle('expanded');
      });
      body.appendChild(label);
      body.appendChild(content);
      div.appendChild(body);
    } else {
      // user / assistant / system : juste un body, le puce est en CSS ::before
      const body = document.createElement('div');
      body.className = 'body';
      div.appendChild(body);
    }

    log.appendChild(div);
    return div;
  }

  // Stockage du texte brut accumulé par bloc → permet de re-parser le markdown à chaque chunk
  const blockText = new Map();

  function appendToBlock(role, messageId, text) {
    const key = messageId + ':' + role;
    let div = blocks.get(key);
    if (!div) {
      div = createBlock(role, messageId);
      blocks.set(key, div);
      blockText.set(key, '');
      // Garde "Processing…" en bas, après tout nouveau message
      if (thinkingIndicator) log.appendChild(thinkingIndicator);
    }
    const accumulated = (blockText.get(key) || '') + text;
    blockText.set(key, accumulated);
    // Pour les thought, on écrit dans .thinking-content (préserve le label "● Thinking ▾")
    const target = role === 'thought'
      ? div.querySelector('.thinking-content')
      : div.querySelector('.body');
    // Markdown rendering uniquement pour les réponses assistant ; thought/user restent en texte brut
    if (role === 'assistant') {
      const html = renderMarkdown(accumulated);
      if (html !== null) {
        target.innerHTML = html;
        // Coloration syntaxique Prism sur les blocs de code ajoutés
        if (typeof Prism !== 'undefined' && Prism.highlightAllUnder) {
          try { Prism.highlightAllUnder(target); } catch (_e) {}
        }
      } else {
        target.textContent = accumulated;
      }
    } else {
      target.textContent = accumulated;
    }
    log.scrollTop = log.scrollHeight;
  }

  function addSystemMessage(text) {
    const div = document.createElement('div');
    div.className = 'msg system';
    div.textContent = text;
    log.appendChild(div);
    log.scrollTop = log.scrollHeight;
  }

  function addDiffProposal(diffId, relativePath, isNewFile, diff) {
    const div = document.createElement('div');
    div.className = 'msg diff';
    div.dataset.diffId = diffId;

    const header = document.createElement('div');
    header.className = 'diff-header';
    const pathSpan = document.createElement('span');
    pathSpan.className = 'path';
    pathSpan.textContent = relativePath;
    const badge = document.createElement('span');
    badge.className = isNewFile ? 'badge new' : 'badge';
    let adds = 0, dels = 0;
    for (const l of diff) { if (l.type === 'add') adds++; else if (l.type === 'del') dels++; }
    badge.textContent = isNewFile ? 'nouveau · +' + adds : '+' + adds + ' / -' + dels;
    header.appendChild(pathSpan);
    header.appendChild(badge);

    const body = document.createElement('div');
    body.className = 'diff-body';
    // Si beaucoup de lignes inchangées, on tronque les paquets de >5 lignes
    let i = 0;
    while (i < diff.length) {
      if (diff[i].type === 'same') {
        // skip blocs >5 same consécutives au début/milieu
        let j = i;
        while (j < diff.length && diff[j].type === 'same') j++;
        const sameCount = j - i;
        const context = 2;
        if (sameCount > 2 * context + 2) {
          for (let k = 0; k < context; k++) {
            const line = document.createElement('span');
            line.className = 'diff-line same';
            line.textContent = diff[i + k].text;
            body.appendChild(line);
          }
          const ellipsis = document.createElement('span');
          ellipsis.className = 'diff-line same';
          ellipsis.style.textAlign = 'center';
          ellipsis.style.opacity = '0.4';
          ellipsis.textContent = '… ' + (sameCount - 2 * context) + ' lignes inchangées …';
          body.appendChild(ellipsis);
          for (let k = sameCount - context; k < sameCount; k++) {
            const line = document.createElement('span');
            line.className = 'diff-line same';
            line.textContent = diff[i + k].text;
            body.appendChild(line);
          }
        } else {
          for (let k = 0; k < sameCount; k++) {
            const line = document.createElement('span');
            line.className = 'diff-line same';
            line.textContent = diff[i + k].text;
            body.appendChild(line);
          }
        }
        i = j;
      } else {
        const line = document.createElement('span');
        line.className = 'diff-line ' + diff[i].type;
        line.textContent = diff[i].text;
        body.appendChild(line);
        i++;
      }
    }

    const actions = document.createElement('div');
    actions.className = 'diff-actions';
    const rejectBtn = document.createElement('button');
    rejectBtn.className = 'reject';
    rejectBtn.textContent = 'Refuser';
    const acceptBtn = document.createElement('button');
    acceptBtn.className = 'accept';
    acceptBtn.textContent = isNewFile ? 'Créer' : 'Appliquer';
    actions.appendChild(rejectBtn);
    actions.appendChild(acceptBtn);

    function decide(accepted) {
      vscode.postMessage({ type: 'diffDecision', diffId, accepted });
      actions.innerHTML = '';
      const done = document.createElement('span');
      done.className = 'done';
      done.textContent = accepted ? '✓ appliqué' : '✗ refusé';
      actions.appendChild(done);
    }
    acceptBtn.addEventListener('click', () => decide(true));
    rejectBtn.addEventListener('click', () => decide(false));

    div.appendChild(header);
    div.appendChild(body);
    div.appendChild(actions);
    log.appendChild(div);
    log.scrollTop = log.scrollHeight;
  }

  function addToolCall(toolCallId, title, kind, content) {
    const div = document.createElement('div');
    div.className = 'msg tool';
    div.dataset.toolCallId = toolCallId;

    const body = document.createElement('div');
    body.className = 'body';

    // Header : kind (Bash, Read, Edit...) + title descriptif (List files...)
    const header = document.createElement('div');
    header.className = 'tool-header';
    const kindSpan = document.createElement('span');
    kindSpan.className = 'tool-kind';
    kindSpan.textContent = capitalize(kind || 'Tool');
    header.appendChild(kindSpan);
    if (title && title !== kind) {
      const titleSpan = document.createElement('span');
      titleSpan.className = 'tool-title';
      titleSpan.textContent = title;
      header.appendChild(titleSpan);
    }
    body.appendChild(header);

    // Bloc IN (commande)
    if (content) {
      appendToolBlock(body, 'IN', content);
    }

    div.appendChild(body);
    log.appendChild(div);
    if (thinkingIndicator) log.appendChild(thinkingIndicator); // remet en bas
    log.scrollTop = log.scrollHeight;
  }

  function appendToolBlock(toolBodyEl, labelText, contentText) {
    const blockEl = document.createElement('div');
    blockEl.className = 'tool-block';
    const lbl = document.createElement('div');
    lbl.className = 'tool-block-label';
    lbl.textContent = labelText;
    const cnt = document.createElement('div');
    cnt.className = 'tool-block-content';
    cnt.textContent = contentText;
    blockEl.appendChild(lbl);
    blockEl.appendChild(cnt);
    toolBodyEl.appendChild(blockEl);
  }

  function capitalize(s) {
    if (!s) return '';
    return String(s).charAt(0).toUpperCase() + String(s).slice(1);
  }

  // --- Pièces jointes images (chemin A : bloc ACP natif, fallback B côté extension) ---
  // Plafond aligné sur la limite vision de l'API Mistral (Pixtral / mistral-medium) : 8 images / requête.
  const MAX_IMAGES = 8;
  let attachments = []; // [{ mimeType, data (base64), dataUrl, name, width, height }]
  let pendingReads = 0; // lectures FileReader en cours (compte pour le plafond avant le push)
  let sendRequested = false; // envoi demandé pendant que des images chargent encore
  let pendingUserImages = []; // images du dernier envoi, en attente d'affichage dans le message user

  function openLightbox(src) {
    const lb = document.getElementById('lightbox');
    lb.querySelector('img').src = src;
    lb.classList.add('visible');
  }
  (function () {
    const lb = document.getElementById('lightbox');
    if (lb) lb.addEventListener('click', () => lb.classList.remove('visible'));
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && lb) lb.classList.remove('visible');
    });
  })();

  // --- En-tête : titre éditable + nouvelle conversation ---
  const convTitleEl = document.getElementById('conv-title');
  const convTitleInput = document.getElementById('conv-title-input');
  const headerNewBtn = document.getElementById('header-new-btn');
  let currentSessionTitle = 'Nouvelle conversation';
  let renaming = false;

  function setTitleDisplay(title) {
    currentSessionTitle = title && title.trim() ? title.trim() : 'Nouvelle conversation';
    convTitleEl.textContent = currentSessionTitle;
  }
  function beginRename() {
    renaming = true;
    convTitleInput.value = currentSessionTitle === 'Nouvelle conversation' ? '' : currentSessionTitle;
    convTitleEl.style.display = 'none';
    convTitleInput.style.display = 'block';
    convTitleInput.focus();
    convTitleInput.select();
  }
  function endRename(save) {
    if (!renaming) return; // évite un double déclenchement (Enter/Échap puis blur)
    renaming = false;
    const val = convTitleInput.value.trim();
    convTitleInput.style.display = 'none';
    convTitleEl.style.display = 'block';
    if (save && val && val !== currentSessionTitle) {
      setTitleDisplay(val); // optimiste
      vscode.postMessage({ type: 'renameSession', title: val });
    }
  }
  convTitleEl.addEventListener('click', beginRename);
  convTitleInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); endRename(true); }
    else if (e.key === 'Escape') { e.preventDefault(); endRename(false); }
  });
  convTitleInput.addEventListener('blur', () => endRename(true));
  headerNewBtn.addEventListener('click', () => vscode.postMessage({ type: 'newConversation' }));

  // --- Historique des conversations (panneau in-app) ---
  const historyBtn = document.getElementById('header-history-btn');
  const historyOverlay = document.getElementById('history-overlay');
  const historySearch = document.getElementById('history-search');
  const historyList = document.getElementById('history-list');
  let historyData = [];

  function openHistory() {
    historyOverlay.classList.add('visible');
    historySearch.value = '';
    historyList.innerHTML = '<div class="history-empty">Chargement…</div>';
    vscode.postMessage({ type: 'requestHistory' });
    historySearch.focus();
  }
  function closeHistory() { historyOverlay.classList.remove('visible'); }

  function renderHistory() {
    const q = historySearch.value.toLowerCase();
    const items = historyData.filter((s) => !q || (s.title || '').toLowerCase().includes(q));
    if (!items.length) {
      historyList.innerHTML = '<div class="history-empty">Aucune conversation.</div>';
      return;
    }
    historyList.innerHTML = '';
    items.forEach((s) => {
      const it = document.createElement('div');
      it.className = 'history-item';
      const t = document.createElement('span');
      t.className = 'h-title';
      t.textContent = s.title || '(sans titre)';
      const d = document.createElement('span');
      d.className = 'h-date';
      d.textContent = s.date || '';
      it.appendChild(t);
      it.appendChild(d);
      it.addEventListener('click', () => { vscode.postMessage({ type: 'openSession', sessionId: s.sessionId, title: s.title }); closeHistory(); });
      historyList.appendChild(it);
    });
  }

  historyBtn.addEventListener('click', () => {
    if (historyOverlay.classList.contains('visible')) closeHistory(); else openHistory();
  });
  historySearch.addEventListener('input', renderHistory);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && historyOverlay.classList.contains('visible')) closeHistory();
  });
  // Clic en dehors du panneau (et pas sur le bouton) → ferme
  document.addEventListener('click', (e) => {
    if (!historyOverlay.classList.contains('visible')) return;
    if (historyOverlay.contains(e.target) || historyBtn.contains(e.target)) return;
    closeHistory();
  });

  // Affiche les images d'un message user sous forme de chips cliquables (façon Claude Code)
  function attachUserImages(messageId, imgs) {
    const div = blocks.get(messageId + ':user');
    if (!div) return;
    const body = div.querySelector('.body') || div;
    const row = document.createElement('div');
    row.className = 'user-images';
    imgs.forEach((im) => {
      const chip = document.createElement('div');
      chip.className = 'img-chip';
      chip.title = 'Cliquer pour agrandir';
      const thumb = document.createElement('img');
      thumb.className = 'thumb';
      thumb.src = im.dataUrl;
      const name = document.createElement('span');
      name.className = 'name';
      name.textContent = im.name || 'image.png';
      chip.appendChild(thumb);
      chip.appendChild(name);
      if (im.width && im.height) {
        const dims = document.createElement('span');
        dims.className = 'dims';
        dims.textContent = im.width + '×' + im.height;
        chip.appendChild(dims);
      }
      chip.addEventListener('click', () => openLightbox(im.dataUrl));
      row.appendChild(chip);
    });
    body.appendChild(row);
    log.scrollTop = log.scrollHeight;
  }

  function renderAttachments() {
    attachmentsEl.innerHTML = '';
    attachments.forEach((att, idx) => {
      const wrap = document.createElement('div');
      wrap.className = 'attachment';
      const img = document.createElement('img');
      img.src = att.dataUrl;
      wrap.appendChild(img);
      const rm = document.createElement('button');
      rm.className = 'remove';
      rm.type = 'button';
      rm.textContent = '×';
      rm.title = 'Retirer';
      rm.addEventListener('click', () => { attachments.splice(idx, 1); renderAttachments(); });
      wrap.appendChild(rm);
      attachmentsEl.appendChild(wrap);
    });
  }

  // Renvoie false si l'image est refusée (pas une image, ou plafond MAX_IMAGES atteint).
  function addImageFile(file) {
    if (!file || !file.type || file.type.indexOf('image/') !== 0) return false;
    if (attachments.length + pendingReads >= MAX_IMAGES) return false;
    pendingReads++;
    const reader = new FileReader();
    reader.onload = () => {
      pendingReads--;
      const dataUrl = String(reader.result);
      const comma = dataUrl.indexOf(',');
      const data = comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl; // base64 sans préfixe
      const att = { mimeType: file.type, data, dataUrl, name: file.name || 'image.png', width: 0, height: 0 };
      attachments.push(att);
      // Mesure les dimensions réelles pour le chip "nom · LxH" (façon Claude Code)
      const probe = new Image();
      probe.onload = () => { att.width = probe.naturalWidth; att.height = probe.naturalHeight; };
      probe.src = dataUrl;
      renderAttachments();
      // Si un envoi a été demandé pendant le chargement, on l'enchaîne dès que tout est prêt
      if (pendingReads === 0 && sendRequested) send();
    };
    reader.onerror = () => {
      pendingReads--;
      debug('lecture image échouée');
      if (pendingReads === 0 && sendRequested) send();
    };
    reader.readAsDataURL(file);
    return true;
  }

  function addFiles(fileList) {
    let skipped = false;
    for (const f of fileList) {
      if (f && f.type && f.type.indexOf('image/') === 0 && !addImageFile(f)) skipped = true;
    }
    if (skipped) addSystemMessage('Limite de ' + MAX_IMAGES + ' images par message atteinte (limite API Mistral vision).');
  }

  uploadBtn.addEventListener('click', () => { if (!busy) fileInput.click(); });
  fileInput.addEventListener('change', () => { addFiles(fileInput.files); fileInput.value = ''; });

  // Coller une image depuis le presse-papier
  input.addEventListener('paste', (e) => {
    const items = (e.clipboardData && e.clipboardData.items) || [];
    let hadImage = false;
    for (const it of items) {
      if (it.kind === 'file' && it.type.indexOf('image/') === 0) {
        const file = it.getAsFile();
        if (file) {
          hadImage = true;
          if (!addImageFile(file)) addSystemMessage('Limite de ' + MAX_IMAGES + ' images par message atteinte (limite API Mistral vision).');
        }
      }
    }
    if (hadImage) e.preventDefault();
  });

  // Glisser-déposer sur le compose
  ['dragenter', 'dragover'].forEach((ev) => composeEl.addEventListener(ev, (e) => {
    e.preventDefault(); composeEl.classList.add('dragover');
  }));
  ['dragleave', 'drop'].forEach((ev) => composeEl.addEventListener(ev, (e) => {
    e.preventDefault(); composeEl.classList.remove('dragover');
  }));
  composeEl.addEventListener('drop', (e) => {
    if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length) addFiles(e.dataTransfer.files);
  });

  function send() {
    if (busy) return;
    const text = input.value.trim();
    if (text.charAt(0) === '/') {
      var sp = text.indexOf(' ');
      var scmd = sp >= 0 ? text.slice(1, sp) : text.slice(1);
      var sargs = sp >= 0 ? text.slice(sp + 1).trim() : '';
      if (scmd.length > 0 && executeSlashCommand(scmd, sargs)) {
        input.value = '';
        input.style.height = 'auto';
        closeSlashMenu();
        return;
      }
    }
    if (!text && attachments.length === 0 && pendingReads === 0) return;
    // Des images finissent de charger : on diffère l'envoi (relancé depuis FileReader.onload)
    if (pendingReads > 0) {
      sendRequested = true;
      status.textContent = 'Chargement des images…';
      return;
    }
    sendRequested = false;
    const images = attachments.map((a) => ({ mimeType: a.mimeType, data: a.data }));
    vscode.postMessage({ type: 'send', text, images });
    input.value = '';
    input.style.height = 'auto';
    pendingUserImages = attachments.slice(); // gardés pour l'affichage en chips au retour du userMessage
    attachments = [];
    renderAttachments();
    setBusy(true);
  }

  sendBtn.addEventListener('click', send);
  cancelBtn.addEventListener('click', () => vscode.postMessage({ type: 'cancel' }));
  input.addEventListener('keydown', (e) => {
    var menuOpen = slashMenuEl && slashMenuEl.classList.contains('visible');
    if (menuOpen) {
      if (e.key === 'ArrowDown') { e.preventDefault(); moveSlashSelection(1); return; }
      if (e.key === 'ArrowUp') { e.preventDefault(); moveSlashSelection(-1); return; }
      if (e.key === 'Escape') { e.preventDefault(); closeSlashMenu(); return; }
      if (e.key === 'Tab' && !e.shiftKey) { e.preventDefault(); completeSlashItem(slashFiltered[slashSelectedIdx]); return; }
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); completeSlashItem(slashFiltered[slashSelectedIdx]); return; }
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  });
  // Auto-grow du textarea selon le contenu
  input.addEventListener('input', () => {
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 200) + 'px';
    updateSlashMenu();
  });

  window.addEventListener('message', (event) => {
    const m = event.data;
    switch (m.type) {
      case 'sessionReady':
        status.textContent = 'Session : ' + (m.currentModelId ?? 'prête');
        if (m.title) setTitleDisplay(m.title);
        // Persisté pour le WebviewPanelSerializer : recharge CETTE conversation (et son titre) au reload
        try { vscode.setState({ sessionId: m.sessionId, title: currentSessionTitle }); } catch (_) {}
        input.disabled = false;
        sendBtn.disabled = false;
        uploadBtn.disabled = false;
        input.focus();
        availableModes = Array.isArray(m.modes) ? m.modes : [];
        currentModeId = m.currentModeId || (availableModes[0] && availableModes[0].value) || null;
        debug('sessionReady — modes: ' + JSON.stringify(availableModes) + ', currentModeId: ' + currentModeId);
        if (availableModes.length > 0) {
          modeWrapperEl.classList.add('visible');
          updateModeButton();
        }
        break;
      case 'modeChanged':
        currentModeId = m.modeId;
        updateModeButton();
        break;
      case 'historyList':
        historyData = Array.isArray(m.sessions) ? m.sessions : [];
        renderHistory();
        break;
      case 'openHistory':
        openHistory();
        break;
      case 'titleSet':
        // Confirmation (ou correction) du titre après renommage côté serveur
        setTitleDisplay(m.title);
        try { vscode.setState({ sessionId: m.sessionId, title: currentSessionTitle }); } catch (_) {}
        break;
      case 'userMessage':
        appendToBlock('user', m.messageId, m.text);
        if (pendingUserImages.length) {
          attachUserImages(m.messageId, pendingUserImages);
          pendingUserImages = [];
        }
        break;
      case 'chunk':
        appendToBlock(m.role, m.messageId, m.text);
        break;
      case 'toolCall':
        addToolCall(m.toolCallId, m.title, m.kind, m.content);
        break;
      case 'diffProposal':
        addDiffProposal(m.diffId, m.relativePath, m.isNewFile, m.diff);
        break;
      case 'toolCallUpdate': {
        const el = log.querySelector('.msg.tool[data-tool-call-id="' + m.toolCallId + '"]');
        if (!el) break;
        const toolBody = el.querySelector('.body');
        if (m.content && toolBody && !el.dataset.hasOut) {
          appendToolBlock(toolBody, 'OUT', m.content);
          el.dataset.hasOut = '1';
        }
        if (m.status === 'completed') el.classList.add('tool-completed');
        else if (m.status === 'failed') el.classList.add('tool-failed');
        break;
      }
      case 'streamEnd':
        setBusy(false);
        break;
      case 'system':
        addSystemMessage(m.text);
        break;
      case 'activeFile':
        if (m.filePath) {
          activeFileNameEl.textContent = m.filePath;
          activeFileEl.classList.add('visible');
          if (m.disabled) activeFileChipEl.classList.add('disabled');
          else activeFileChipEl.classList.remove('disabled');
        } else {
          activeFileEl.classList.remove('visible');
        }
        break;
      case 'skillsReady':
        vibeSkills = m.skills || [];
        break;
    }
  });

  // --- Slash menu ---
  var slashMenuEl = document.getElementById('slash-menu');
  var slashBtn = document.getElementById('slash-btn');
  var SLASH_COMMANDS = [
    { name: 'clear',   args: '',         desc: 'Efface la conversation' },
    { name: 'new',     args: '',         desc: 'Nouvelle conversation' },
    { name: 'mode',    args: '[nom]',    desc: 'Affiche ou change le mode' },
    { name: 'context', args: '[on|off]', desc: 'Active/desactive le contexte' },
    { name: 'help',    args: '',         desc: 'Liste les commandes' },
  ];
  var slashFiltered = [];
  var slashSelectedIdx = -1;
  var vibeSkills = [];

  function openSlashMenu(items) {
    slashFiltered = items;
    slashSelectedIdx = 0;
    slashMenuEl.innerHTML = '';
    for (var i = 0; i < items.length; i++) {
      var cmd = items[i];
      var item = document.createElement('div');
      item.className = 'slash-item' + (i === 0 ? ' active' : '') + (cmd.type === 'skill' ? ' skill' : '');
      var nameEl = document.createElement('span');
      nameEl.className = 'slash-name';
      nameEl.textContent = '/' + cmd.name;
      var argsEl = document.createElement('span');
      argsEl.className = 'slash-args';
      argsEl.textContent = cmd.args;
      var descEl = document.createElement('span');
      descEl.className = 'slash-desc';
      descEl.textContent = cmd.desc;
      item.appendChild(nameEl);
      item.appendChild(argsEl);
      item.appendChild(descEl);
      item.dataset.idx = String(i);
      item.addEventListener('mousedown', function(ev) {
        ev.preventDefault();
        completeSlashItem(slashFiltered[parseInt(this.dataset.idx, 10)]);
      });
      slashMenuEl.appendChild(item);
    }
    slashMenuEl.classList.add('visible');
  }

  function closeSlashMenu() {
    slashMenuEl.classList.remove('visible');
    slashFiltered = [];
    slashSelectedIdx = -1;
  }

  function updateSlashMenu() {
    var val = input.value;
    if (val.indexOf('/') !== 0 || val.indexOf(' ') >= 0) { closeSlashMenu(); return; }
    var typed = val.slice(1).toLowerCase();
    var filtered = SLASH_COMMANDS.filter(function(c) { return c.name.indexOf(typed) === 0; });
    for (var vi = 0; vi < vibeSkills.length; vi++) {
      var sk = vibeSkills[vi];
      if (sk.name.toLowerCase().indexOf(typed) === 0) {
        var shortDesc = sk.description.length > 55 ? sk.description.slice(0, 52) + '...' : sk.description;
        filtered.push({ name: sk.name, args: '', desc: shortDesc, type: 'skill' });
      }
    }
    if (filtered.length === 0) { closeSlashMenu(); return; }
    openSlashMenu(filtered);
  }

  function completeSlashItem(cmd) {
    var suffix = cmd.args ? ' ' : '';
    input.value = '/' + cmd.name + suffix;
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 200) + 'px';
    closeSlashMenu();
    input.focus();
  }

  function moveSlashSelection(delta) {
    if (slashFiltered.length === 0) return;
    slashSelectedIdx = Math.max(0, Math.min(slashFiltered.length - 1, slashSelectedIdx + delta));
    var items = slashMenuEl.querySelectorAll('.slash-item');
    for (var i = 0; i < items.length; i++) {
      items[i].classList.toggle('active', i === slashSelectedIdx);
    }
  }

  function executeSlashCommand(cmd, args) {
    var cmdLow = cmd.toLowerCase();
    var cmdFound = false;
    for (var ci = 0; ci < SLASH_COMMANDS.length; ci++) {
      if (SLASH_COMMANDS[ci].name === cmdLow) { cmdFound = true; break; }
    }
    if (!cmdFound) return false;
    if (cmdLow === 'clear') {
      log.innerHTML = '';
      blocks.clear();
      blockText.clear();
      addSystemMessage('Conversation effacee.');
    } else if (cmdLow === 'new') {
      vscode.postMessage({ type: 'newConversation' });
    } else if (cmdLow === 'help') {
      var helpLines = ['Commandes :'];
      for (var hi = 0; hi < SLASH_COMMANDS.length; hi++) {
        var hcmd = SLASH_COMMANDS[hi];
        helpLines.push('  /' + hcmd.name + (hcmd.args ? ' ' + hcmd.args : '') + ' - ' + hcmd.desc);
      }
      addSystemMessage(helpLines.join('\\n'));
    } else if (cmdLow === 'context') {
      vscode.postMessage({ type: 'toggleContext' });
    } else if (cmdLow === 'mode') {
      if (args) {
        var argLow2 = args.toLowerCase();
        var modeTarget2 = null;
        for (var mi2 = 0; mi2 < availableModes.length; mi2++) {
          var mm2 = availableModes[mi2];
          if (mm2.value.toLowerCase() === argLow2 || mm2.value.toLowerCase().indexOf(argLow2) === 0) {
            modeTarget2 = mm2; break;
          }
        }
        if (modeTarget2) {
          currentModeId = modeTarget2.value;
          updateModeButton();
          vscode.postMessage({ type: 'setMode', modeId: modeTarget2.value });
        } else {
          var modeNames2 = availableModes.map(function(x) { return x.value; }).join(', ');
          addSystemMessage('Mode inconnu. Disponibles : ' + modeNames2);
        }
      } else {
        var modeLines2 = ['Mode actif : ' + modeLabelFor(currentModeId)];
        for (var mii2 = 0; mii2 < availableModes.length; mii2++) {
          modeLines2.push('  /mode ' + availableModes[mii2].value);
        }
        addSystemMessage(modeLines2.join('\\n'));
      }
    } else {
      for (var ski = 0; ski < vibeSkills.length; ski++) {
        if (vibeSkills[ski].name.toLowerCase() === cmdLow) {
          vscode.postMessage({ type: 'invokeSkill', skillName: vibeSkills[ski].name });
          return true;
        }
      }
      return false;
    }
    return true;
  }

  slashBtn.addEventListener('click', function() {
    if (busy) return;
    if (!input.value) { input.value = '/'; input.focus(); updateSlashMenu(); }
    else input.focus();
  });

  document.addEventListener('click', function(e) {
    if (!slashMenuEl.classList.contains('visible')) return;
    if (!slashMenuEl.contains(e.target) && e.target !== input && e.target !== slashBtn) closeSlashMenu();
  });

  // Handshake : signale à l'extension que le webview est prêt à recevoir des messages
  // (sessionReady / chunks de replay). Doit partir APRÈS l'enregistrement du listener ci-dessus.
  vscode.postMessage({ type: 'ready' });

</script>
<!-- Libs chargées en bas pour ne pas bloquer le main script -->
<script src="${markedUri}"></script>
<script src="${purifyUri}"></script>
<script src="${prismJs}"></script>
${prismLangs.map((uri) => `<script src="${uri}"></script>`).join("\n")}
</body>
</html>`;
  }
}

let app: FlorianVibe;

export function activate(context: vscode.ExtensionContext) {
  app = new FlorianVibe(context);
  context.subscriptions.push(
    // Restaure les onglets de conversation après un reload de la fenêtre VSCode
    vscode.window.registerWebviewPanelSerializer("florianVibe.chat", {
      deserializeWebviewPanel: async (panel, state: any) => {
        await app.restoreConversation(panel, state?.sessionId, state?.title);
      },
    }),
    vscode.commands.registerCommand("florianVibe.open", () => app.openConversation()),
    vscode.commands.registerCommand("florianVibe.history", () => app.showHistory()),
    vscode.commands.registerCommand("florianVibe.openWithFile", async (uri?: vscode.Uri) => {
      // uri vient du menu contextuel ; si appelé via palette/raccourci, fallback sur le doc actif
      let target = uri ?? vscode.window.activeTextEditor?.document.uri;
      if (!target) {
        vscode.window.showWarningMessage("Aucun fichier sélectionné.");
        return;
      }
      // Ouvre le fichier dans un éditeur (pour qu'il devienne le 'lastActiveEditor')
      await vscode.window.showTextDocument(target, { preview: false });
      // Puis ouvre le panel chat — le fichier sera automatiquement utilisé comme contexte
      await app.openConversation();
    })
  );
}

export function deactivate() {}
