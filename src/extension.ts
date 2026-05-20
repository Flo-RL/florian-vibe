import * as vscode from "vscode";
import * as fs from "fs/promises";
import { randomUUID } from "crypto";
import { AcpClient } from "./acp-client";
import { prepareDiff, DiffLine } from "./diff-view";
import { askPermission } from "./permission";

const EXTENSION_VERSION = "0.1.0";

interface PromptBlock {
  type: "text";
  text: string;
}

interface SessionUpdateNotification {
  sessionId: string;
  update: any;
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
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [nodeModulesUri],
      }
    );

    const conv = new ConversationPanel(panel, this.client,
      (sessionId) => { this.panels.delete(sessionId); if (this.activePanel === conv) this.activePanel = undefined; },
      () => { this.activePanel = conv; },
      () => this.lastActiveUri,
      this.output,
      this.context.extensionUri
    );
    this.activePanel = conv;
    await conv.start((sessionId) => {
      this.panels.set(sessionId, conv);
      // état initial du fichier actif
      conv.updateActiveFile(this.activeFilePath);
    });
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
  private clientMode: ClientMode = "default";
  private static readonly ICON_IDLE = new vscode.ThemeIcon("comment-discussion");
  private static readonly ICON_UNREAD = new vscode.ThemeIcon("comment-unresolved");

  constructor(
    private readonly panel: vscode.WebviewPanel,
    private readonly client: AcpClient,
    private readonly onDispose: (sessionId: string) => void,
    private readonly onActivate: () => void,
    private readonly getActiveUri: () => vscode.Uri | undefined,
    private readonly output: vscode.OutputChannel,
    private readonly extensionUri: vscode.Uri
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
        case "send":
          this.onActivate();
          await this.sendPrompt(msg.text as string);
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
          // Re-confirme l'état au frontend
          this.post({
            type: "activeFile",
            filePath: this.currentContextFile,
            disabled: this.contextDisabled,
          });
          break;
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

  async start(register: (sessionId: string) => void): Promise<void> {
    const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();
    try {
      const result = await this.client.sendRequest("session/new", { cwd, mcpServers: [] });
      this.sessionId = result.sessionId;
      register(this.sessionId!);

      // Renomme l'onglet avec un titre court basé sur le dossier
      const folderName = vscode.workspace.workspaceFolders?.[0]?.name ?? "Vibe";
      this.panel.title = `Vibe — ${folderName}`;

      // Vibe ACP 2.x n'expose pas de modes côté serveur → on utilise nos modes client.
      const serverModes = result.modes?.availableModes?.map((m: any) => ({ value: m.id, name: m.name })) ?? [];
      const modesToSend = serverModes.length > 0 ? serverModes : CLIENT_MODES;
      const currentModeId = result.modes?.currentModeId ?? this.clientMode;
      this.post({
        type: "sessionReady",
        sessionId: this.sessionId,
        currentModelId: result.models?.currentModelId,
        modes: modesToSend,
        currentModeId,
      });
    } catch (e: any) {
      this.post({ type: "system", text: `Création de session échouée : ${e?.message}` });
    }
  }

  handleSessionUpdate(update: any): void {
    if (this.disposed) return;
    const messageId = update?._meta?.messageId ?? this.currentMessageId ?? "unknown";

    switch (update?.sessionUpdate) {
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
        });
        break;
      case "tool_call_update":
        this.post({
          type: "toolCallUpdate",
          toolCallId: update.toolCallId,
          status: update.status ?? "in_progress",
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

  private async sendPrompt(text: string): Promise<void> {
    if (!text.trim() || !this.sessionId) return;

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

    blocks.push({ type: "text", text });

    const messageId = randomUUID();
    this.currentMessageId = messageId;
    this.post({ type: "userMessage", messageId, text });

    try {
      await this.client.sendRequest("session/prompt", {
        sessionId: this.sessionId,
        prompt: blocks,
        messageId,
      });
      this.post({ type: "streamEnd", messageId });
      this.markUnread();
    } catch (e: any) {
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
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline' ${cspSource}; script-src ${cspSource} 'nonce-${nonce}';">
<link rel="stylesheet" href="${prismCss}">
<style>
  body { padding: 0; margin: 0; font-family: var(--vscode-font-family); color: var(--vscode-foreground); background: var(--vscode-editor-background); display: flex; flex-direction: column; height: 100vh; --mode-color: var(--vscode-descriptionForeground); }
  body.mode-plan { --mode-color: var(--vscode-charts-blue); }
  body.mode-accept { --mode-color: var(--vscode-charts-green); }
  body.mode-auto, body.mode-bypass { --mode-color: var(--vscode-charts-orange); }
  body.mode-chat { --mode-color: var(--vscode-charts-purple); }
  #log { flex: 1; overflow-y: auto; padding: 16px; max-width: 920px; width: 100%; margin: 0 auto; box-sizing: border-box; }
  .msg { margin: 10px 0; padding: 10px 12px; border-radius: 6px; white-space: pre-wrap; word-wrap: break-word; line-height: 1.5; }
  .msg.user { background: var(--vscode-textBlockQuote-background); border-left: 3px solid var(--vscode-textLink-foreground); }
  .msg.assistant { background: var(--vscode-editor-inactiveSelectionBackground); border-left: 3px solid var(--vscode-charts-green); }
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
  .msg.thought { background: transparent; border-left: 2px dashed var(--vscode-descriptionForeground); color: var(--vscode-descriptionForeground); font-size: 0.88em; opacity: 0.85; }
  .msg.thought .body { font-style: italic; }
  .msg.thought .body.collapsed { display: none; }
  .msg.thought .role { cursor: pointer; }
  .msg.system { color: var(--vscode-descriptionForeground); font-size: 0.85em; padding: 4px 12px; }
  .msg.tool { background: var(--vscode-textCodeBlock-background); font-family: var(--vscode-editor-font-family); font-size: 0.9em; border-left: 3px solid var(--vscode-charts-orange); }
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
  .role { font-size: 0.72em; font-weight: 600; opacity: 0.7; text-transform: uppercase; margin-bottom: 4px; display: flex; justify-content: space-between; align-items: center; }
  .toggle { cursor: pointer; user-select: none; }
  .body.collapsed { display: none; }
  #input-area { padding: 12px 16px 14px; max-width: 920px; width: 100%; margin: 0 auto; box-sizing: border-box; }
  #compose { background: var(--vscode-input-background); border: 1px solid var(--mode-color); border-radius: 12px; padding: 10px 12px; display: flex; flex-direction: column; gap: 8px; transition: border-color 0.15s, box-shadow 0.15s; }
  #compose:focus-within { box-shadow: 0 0 0 1px var(--mode-color); }
  #active-file { display: none; align-items: center; gap: 6px; font-size: 0.82em; }
  #active-file.visible { display: inline-flex; }
  #active-file .chip { background: transparent; border: 1px solid var(--vscode-input-border, var(--vscode-panel-border)); padding: 2px 8px; border-radius: 10px; font-family: var(--vscode-editor-font-family); cursor: pointer; display: inline-flex; align-items: center; gap: 6px; transition: opacity 0.15s, color 0.15s; }
  #active-file .chip:hover { background: var(--vscode-list-hoverBackground); }
  #active-file .chip.disabled { opacity: 0.55; color: var(--vscode-descriptionForeground); }
  #active-file .chip.disabled #active-file-name { text-decoration: line-through; }
  #active-file .chip .eye { width: 14px; height: 14px; flex-shrink: 0; opacity: 0.7; }
  #active-file .chip:hover .eye { opacity: 1; }
  #active-file .chip .eye-closed { display: none; }
  #active-file .chip.disabled .eye-open { display: none; }
  #active-file .chip.disabled .eye-closed { display: inline-block; }
  #active-file .label { color: var(--vscode-descriptionForeground); }
  #prompt { background: transparent; color: var(--vscode-input-foreground); border: 0; outline: none; padding: 4px 0; font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); resize: none; min-height: 28px; max-height: 200px; width: 100%; box-sizing: border-box; overflow-y: auto; }
  #compose-actions { display: flex; align-items: center; gap: 8px; }
  #compose-actions .left { display: flex; gap: 6px; align-items: center; flex: 1; }
  #compose-actions .right { display: flex; gap: 6px; align-items: center; }
  #send-btn { background: var(--mode-color); color: var(--vscode-button-foreground); border: none; width: 28px; height: 28px; border-radius: 50%; cursor: pointer; display: inline-flex; align-items: center; justify-content: center; font-size: 1em; padding: 0; transition: background 0.15s, filter 0.15s; }
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
  <div id="log"></div>
  <div id="input-area">
    <div id="compose">
      <div id="active-file">
        <span class="chip" id="active-file-chip" title="Cliquer pour inclure/exclure du contexte">
          <span id="active-file-name"></span>
          <svg class="eye eye-open" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
          <svg class="eye eye-closed" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>
        </span>
      </div>
      <textarea id="prompt" placeholder="Demande à Vibe…" rows="1" disabled></textarea>
      <div id="compose-actions">
        <div class="left">
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
  const status = document.getElementById('status');

  // Blocs indexés par (messageId + role) → garantit thought et assistant séparés.
  const blocks = new Map();
  let busy = false;
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

  function setBusy(v) {
    busy = v;
    sendBtn.disabled = v;
    cancelBtn.style.display = v ? '' : 'none';
  }

  function createBlock(role, messageId) {
    const div = document.createElement('div');
    div.className = 'msg ' + role;
    const label = document.createElement('div');
    label.className = 'role';
    const labelText = document.createElement('span');
    labelText.textContent = role === 'user' ? 'Toi'
      : role === 'assistant' ? 'Vibe'
      : role === 'thought' ? 'Réflexion'
      : 'Système';
    label.appendChild(labelText);
    const body = document.createElement('div');
    body.className = 'body';
    if (role === 'thought') {
      body.classList.add('collapsed'); // masqué par défaut
      const toggle = document.createElement('span');
      toggle.className = 'toggle';
      toggle.textContent = '[afficher]';
      label.appendChild(toggle);
      label.classList.add('toggle');
      label.addEventListener('click', () => {
        body.classList.toggle('collapsed');
        toggle.textContent = body.classList.contains('collapsed') ? '[afficher]' : '[masquer]';
      });
    }
    div.appendChild(label);
    div.appendChild(body);
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
    }
    const accumulated = (blockText.get(key) || '') + text;
    blockText.set(key, accumulated);
    const body = div.querySelector('.body');
    // Markdown rendering uniquement pour les réponses assistant ; thought/user restent en texte brut
    if (role === 'assistant') {
      const html = renderMarkdown(accumulated);
      if (html !== null) {
        body.innerHTML = html;
        // Coloration syntaxique Prism sur les blocs de code ajoutés
        if (typeof Prism !== 'undefined' && Prism.highlightAllUnder) {
          try { Prism.highlightAllUnder(body); } catch (_e) {}
        }
      } else {
        body.textContent = accumulated;
      }
    } else {
      body.textContent = accumulated;
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

  function addToolCall(toolCallId, title, kind) {
    const div = document.createElement('div');
    div.className = 'msg tool';
    div.dataset.toolCallId = toolCallId;
    const label = document.createElement('div');
    label.className = 'role';
    label.textContent = 'Outil · ' + (kind ?? 'tool') + ' · en cours';
    const body = document.createElement('div');
    body.className = 'body';
    body.textContent = title;
    div.appendChild(label);
    div.appendChild(body);
    log.appendChild(div);
    log.scrollTop = log.scrollHeight;
  }

  function send() {
    const text = input.value.trim();
    if (!text || busy) return;
    vscode.postMessage({ type: 'send', text });
    input.value = '';
    input.style.height = 'auto';
    setBusy(true);
  }

  sendBtn.addEventListener('click', send);
  cancelBtn.addEventListener('click', () => vscode.postMessage({ type: 'cancel' }));
  input.addEventListener('keydown', (e) => {
    // Entrée seule = envoyer ; Maj+Entrée = saut de ligne
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  });
  // Auto-grow du textarea selon le contenu
  input.addEventListener('input', () => {
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 200) + 'px';
  });

  window.addEventListener('message', (event) => {
    const m = event.data;
    switch (m.type) {
      case 'sessionReady':
        status.textContent = 'Session : ' + (m.currentModelId ?? 'prête');
        input.disabled = false;
        sendBtn.disabled = false;
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
      case 'userMessage':
        appendToBlock('user', m.messageId, m.text);
        break;
      case 'chunk':
        appendToBlock(m.role, m.messageId, m.text);
        break;
      case 'toolCall':
        addToolCall(m.toolCallId, m.title, m.kind);
        break;
      case 'diffProposal':
        addDiffProposal(m.diffId, m.relativePath, m.isNewFile, m.diff);
        break;
      case 'toolCallUpdate': {
        const el = log.querySelector('.msg.tool[data-tool-call-id="' + m.toolCallId + '"]');
        if (el) {
          const label = el.querySelector('.role');
          if (label) label.textContent = label.textContent.replace(/· (en cours|completed|failed|in_progress)$/, '· ' + m.status);
        }
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
    }
  });

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
    vscode.commands.registerCommand("florianVibe.open", () => app.openConversation()),
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
