import * as vscode from "vscode";

interface AcpPermissionOption {
  optionId: string;
  name: string;
  kind?: string; // "allow_once" | "allow_always" | "reject_once" | "reject_always" | ...
}

interface PermissionRequest {
  sessionId?: string;
  description?: string;
  toolCall?: {
    title?: string;
    kind?: string;
    toolCallId?: string;
  };
  options: AcpPermissionOption[];
}

/**
 * Format de réponse ACP attendu par vibe-acp.
 * - "selected" + optionId : le user a choisi explicitement une option
 * - "cancelled"           : le user a fermé la notif sans choisir
 */
type PermissionOutcome =
  | { outcome: { outcome: "selected"; optionId: string } }
  | { outcome: { outcome: "cancelled" } };

export async function askPermission(req: PermissionRequest): Promise<PermissionOutcome> {
  const options = req.options ?? [];
  if (options.length === 0) {
    return { outcome: { outcome: "cancelled" } };
  }

  const title =
    req.description ??
    req.toolCall?.title ??
    req.toolCall?.kind ??
    "une action";
  const message = `Vibe demande à exécuter : ${title}`;

  // Ordre des boutons : allow d'abord (action principale), reject en dernier
  const ordered = [...options].sort((a, b) => weight(a) - weight(b));
  const labels = ordered.map((o) => o.name);

  const choice = await vscode.window.showWarningMessage(
    message,
    { modal: false },
    ...labels
  );

  if (!choice) {
    return { outcome: { outcome: "cancelled" } };
  }

  const picked = ordered.find((o) => o.name === choice);
  if (!picked) {
    return { outcome: { outcome: "cancelled" } };
  }

  return { outcome: { outcome: "selected", optionId: picked.optionId } };
}

function weight(o: AcpPermissionOption): number {
  // Plus le poids est petit, plus l'option apparaît à gauche (bouton principal)
  const id = (o.optionId ?? "").toLowerCase();
  const kind = (o.kind ?? "").toLowerCase();
  if (id.startsWith("allow_always") || kind.includes("allow_always")) return 0;
  if (id.startsWith("allow") || kind.includes("allow")) return 1;
  if (id.startsWith("reject_always") || kind.includes("reject_always")) return 9;
  if (id.startsWith("reject") || kind.includes("reject")) return 8;
  return 5; // neutre
}
