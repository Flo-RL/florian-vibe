import { ChildProcessWithoutNullStreams, spawn } from "child_process";
import { EventEmitter } from "events";

type JsonRpcId = number | string;
type RequestHandler = (params: any) => Promise<any> | any;
type NotificationHandler = (params: any) => void;

interface PendingRequest {
  resolve: (value: any) => void;
  reject: (err: Error) => void;
}

/**
 * Client JSON-RPC sur stdio pour parler à vibe-acp.
 * Protocole : line-delimited JSON (un message JSON par ligne).
 */
export class AcpClient extends EventEmitter {
  private process?: ChildProcessWithoutNullStreams;
  private nextId = 1;
  private pending = new Map<JsonRpcId, PendingRequest>();
  private requestHandlers = new Map<string, RequestHandler>();
  private notificationHandlers = new Map<string, NotificationHandler>();
  private stdoutBuffer = "";
  private stderrBuffer = "";

  constructor(private readonly binaryPath: string) {
    super();
  }

  start(): void {
    if (this.process) throw new Error("AcpClient déjà démarré");
    const child = spawn(this.binaryPath, [], { stdio: "pipe" });
    this.process = child;

    child.stdout.on("data", (chunk: Buffer) => this.onStdout(chunk.toString("utf8")));
    child.stderr.on("data", (chunk: Buffer) => {
      this.stderrBuffer += chunk.toString("utf8");
      const lines = this.stderrBuffer.split("\n");
      this.stderrBuffer = lines.pop() ?? "";
      for (const line of lines) {
        if (line.trim()) this.emit("stderr", line);
      }
    });
    child.on("exit", (code, signal) => {
      this.emit("exit", { code, signal });
      this.failAllPending(new Error(`vibe-acp s'est terminé (code=${code}, signal=${signal})`));
    });
    child.on("error", (err) => {
      this.emit("error", err);
      this.failAllPending(err);
    });
  }

  stop(): void {
    if (!this.process) return;
    this.process.kill("SIGTERM");
    this.process = undefined;
  }

  /** Enregistre un handler pour les requêtes envoyées par le serveur ACP. */
  onRequest(method: string, handler: RequestHandler): void {
    this.requestHandlers.set(method, handler);
  }

  /** Enregistre un handler pour les notifications envoyées par le serveur ACP. */
  onNotification(method: string, handler: NotificationHandler): void {
    this.notificationHandlers.set(method, handler);
  }

  /** Envoie une requête au serveur et attend la réponse. */
  sendRequest<T = any>(method: string, params?: any): Promise<T> {
    if (!this.process) return Promise.reject(new Error("AcpClient pas démarré"));
    const id = this.nextId++;
    const message = { jsonrpc: "2.0", id, method, params };
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.write(message);
    });
  }

  /** Envoie une notification (sans attendre de réponse). */
  sendNotification(method: string, params?: any): void {
    if (!this.process) return;
    this.write({ jsonrpc: "2.0", method, params });
  }

  private write(message: any): void {
    if (!this.process) return;
    this.process.stdin.write(JSON.stringify(message) + "\n");
  }

  private onStdout(chunk: string): void {
    this.stdoutBuffer += chunk;
    const lines = this.stdoutBuffer.split("\n");
    this.stdoutBuffer = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      let msg: any;
      try {
        msg = JSON.parse(line);
      } catch {
        this.emit("stderr", `JSON invalide: ${line}`);
        continue;
      }
      this.dispatch(msg);
    }
  }

  private dispatch(msg: any): void {
    if (msg.id !== undefined && msg.method !== undefined) {
      // Requête du serveur vers nous
      this.handleServerRequest(msg.id, msg.method, msg.params);
    } else if (msg.id !== undefined) {
      // Réponse à une de nos requêtes
      const pending = this.pending.get(msg.id);
      if (!pending) return;
      this.pending.delete(msg.id);
      if (msg.error) pending.reject(new Error(msg.error.message ?? "Erreur ACP"));
      else pending.resolve(msg.result);
    } else if (msg.method !== undefined) {
      // Notification du serveur
      const handler = this.notificationHandlers.get(msg.method);
      if (handler) {
        try {
          handler(msg.params);
        } catch (e: any) {
          this.emit("error", e);
        }
      }
    }
  }

  private async handleServerRequest(id: JsonRpcId, method: string, params: any): Promise<void> {
    const handler = this.requestHandlers.get(method);
    if (!handler) {
      this.write({
        jsonrpc: "2.0",
        id,
        error: { code: -32601, message: `Méthode non gérée : ${method}` },
      });
      return;
    }
    try {
      const result = await handler(params);
      this.write({ jsonrpc: "2.0", id, result: result ?? null });
    } catch (e: any) {
      this.write({
        jsonrpc: "2.0",
        id,
        error: { code: -32000, message: e?.message ?? "Erreur handler" },
      });
    }
  }

  private failAllPending(err: Error): void {
    for (const p of this.pending.values()) p.reject(err);
    this.pending.clear();
  }
}
