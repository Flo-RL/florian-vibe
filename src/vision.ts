import * as vscode from "vscode";

/** Image jointe au prompt, en base64 (sans le préfixe `data:<mime>;base64,`). */
export interface InlineImage {
  mimeType: string;
  data: string;
}

/**
 * Chemin B (fallback) — décrire / OCR une image via un modèle vision externe,
 * pour l'injecter en TEXTE quand `vibe-acp` refuse les blocs image natifs (chemin A).
 *
 * Le modèle est volontairement NON câblé pour l'instant (décision modèle reportée).
 * Pour activer le fallback, brancher ici le modèle vision choisi (Pixtral via l'API
 * Mistral, ou autre), en lisant la config `florianVibe.vision.*` :
 *   1. lire apiKey / endpoint / model
 *   2. POSTer l'image (base64) au modèle vision
 *   3. retourner la description / OCR en texte
 */
export async function describeImage(_image: InlineImage): Promise<string> {
  if (!isVisionConfigured()) {
    throw new Error(
      "Fallback vision non configuré. vibe-acp a refusé l'image native (chemin A) " +
        "et aucun modèle vision n'est branché (florianVibe.vision.apiKey / .model). " +
        "Renseigne ces réglages, ou implémente l'appel dans src/vision.ts."
    );
  }
  // TODO(décision modèle reportée) : appel réel au modèle vision sélectionné.
  throw new Error("Fallback vision : appel au modèle non encore implémenté (src/vision.ts).");
}

/** True si un modèle vision est configuré pour le fallback (chemin B). */
export function isVisionConfigured(): boolean {
  const cfg = vscode.workspace.getConfiguration("florianVibe.vision");
  return !!cfg.get<string>("apiKey") && !!cfg.get<string>("model");
}
