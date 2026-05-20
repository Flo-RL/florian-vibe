import * as fs from "fs/promises";
import * as path from "path";

export interface DiffLine {
  type: "add" | "del" | "same";
  text: string;
}

/**
 * Diff ligne par ligne basé sur LCS (Longest Common Subsequence).
 * Suffisant pour un affichage chat — pas optimisé pour des fichiers énormes.
 */
export function computeDiff(oldText: string, newText: string): DiffLine[] {
  const a = oldText.split("\n");
  const b = newText.split("\n");
  const m = a.length;
  const n = b.length;

  // DP table pour LCS
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (a[i - 1] === b[j - 1]) dp[i][j] = dp[i - 1][j - 1] + 1;
      else dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
    }
  }

  // Backtrack pour reconstruire la séquence d'opérations
  const out: DiffLine[] = [];
  let i = m;
  let j = n;
  while (i > 0 && j > 0) {
    if (a[i - 1] === b[j - 1]) {
      out.unshift({ type: "same", text: a[i - 1] });
      i--;
      j--;
    } else if (dp[i - 1][j] >= dp[i][j - 1]) {
      out.unshift({ type: "del", text: a[i - 1] });
      i--;
    } else {
      out.unshift({ type: "add", text: b[j - 1] });
      j--;
    }
  }
  while (i > 0) {
    out.unshift({ type: "del", text: a[--i] });
  }
  while (j > 0) {
    out.unshift({ type: "add", text: b[--j] });
  }
  return out;
}

/**
 * Lit l'ancien contenu (vide si nouveau fichier), calcule le diff, et renvoie
 * un payload prêt à être posté à la webview.
 * Renvoie aussi un callback writeIfAccepted() à appeler si l'user accepte.
 */
export async function prepareDiff(filePath: string, newContent: string): Promise<{
  filePath: string;
  isNewFile: boolean;
  diff: DiffLine[];
  unchanged: boolean;
  writeIfAccepted: () => Promise<void>;
}> {
  let oldContent = "";
  let isNewFile = false;
  try {
    oldContent = await fs.readFile(filePath, "utf8");
  } catch {
    isNewFile = true;
  }

  const unchanged = !isNewFile && oldContent === newContent;
  const diff = unchanged ? [] : computeDiff(oldContent, newContent);

  return {
    filePath,
    isNewFile,
    diff,
    unchanged,
    writeIfAccepted: async () => {
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      await fs.writeFile(filePath, newContent, "utf8");
    },
  };
}
