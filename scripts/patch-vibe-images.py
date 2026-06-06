#!/usr/bin/env python3
"""
Patch idempotent de Mistral Vibe (vibe-acp) pour activer l'envoi d'images natives.

Pourquoi : Vibe expose `image=false` dans ses PromptCapabilities ACP et son
adaptateur ACP jette les blocs image (`_build_text_prompt` ne garde que le texte).
Pourtant tout le moteur en dessous gère la vision (ImageAttachment -> image_url),
via l'auth/abonnement Mistral existant. Ce script câble le pont manquant :
    bloc image ACP -> fichier temp -> ImageAttachment -> agent_loop.act(images=...)

Effet : les images partent au modèle vision (ex. mistral-medium-3.5) avec
l'abonnement courant, sans clé API séparée.

ATTENTION : Vibe est installé via `uv` sous ~/.local/share/uv/tools/. Un
`uv tool upgrade mistral-vibe` écrasera ce patch -> relancer ce script ensuite.

Usage :
    python3 scripts/patch-vibe-images.py          # applique le patch
    python3 scripts/patch-vibe-images.py --revert # restaure le backup
    python3 scripts/patch-vibe-images.py --check   # dit juste si patché
"""
from __future__ import annotations

import sys
from pathlib import Path

MARKER = "# [florian-vibe patch: images]"


def find_target() -> Path:
    candidates = list(
        Path.home().glob(
            ".local/share/uv/tools/mistral-vibe/lib/python*/site-packages/"
            "vibe/acp/acp_agent_loop.py"
        )
    )
    # Fallback : recherche large si l'arborescence uv change
    if not candidates:
        for base in (Path.home() / ".local/share/uv/tools/mistral-vibe",):
            candidates += list(base.rglob("vibe/acp/acp_agent_loop.py"))
    if not candidates:
        sys.exit("ERREUR : acp_agent_loop.py introuvable (Vibe installé via uv ?).")
    return candidates[0]


# (ancre exacte, remplacement). Chaque remplacement est conçu pour être unique.
REPLACEMENTS: list[tuple[str, str]] = [
    # 1) Annoncer la capacité image au client ACP
    (
        "audio=False, embedded_context=True, image=False",
        "audio=False, embedded_context=True, image=True  " + MARKER,
    ),
    # 2) Extraire les images du prompt ACP dans prompt()
    (
        "        text_prompt = self._build_text_prompt(prompt)\n"
        "        resolved_message_id = _resolved_user_message_id(message_id)",
        "        text_prompt = self._build_text_prompt(prompt)\n"
        "        images = self._extract_acp_images(prompt)  " + MARKER + "\n"
        "        resolved_message_id = _resolved_user_message_id(message_id)",
    ),
    # 3) Passer les images de prompt() -> _run_agent_loop
    (
        "            async for update in self._run_agent_loop(\n"
        "                session, text_prompt, resolved_message_id, auto_title=auto_title\n"
        "            ):",
        "            async for update in self._run_agent_loop(\n"
        "                session, text_prompt, resolved_message_id, auto_title=auto_title,\n"
        "                images=images,  " + MARKER + "\n"
        "            ):",
    ),
    # 4) Ajouter le paramètre images à la signature de _run_agent_loop
    (
        "        client_message_id: str | None = None,\n"
        "        *,\n"
        "        auto_title: str | None = None,\n"
        "    ) -> AsyncGenerator[SessionUpdate | UsageUpdate]:",
        "        client_message_id: str | None = None,\n"
        "        *,\n"
        "        auto_title: str | None = None,\n"
        "        images: list[ImageAttachment] | None = None,  " + MARKER + "\n"
        "    ) -> AsyncGenerator[SessionUpdate | UsageUpdate]:",
    ),
    # 5) Passer les images à agent_loop.act(...)
    (
        "            session.agent_loop.act(\n"
        "                rendered_prompt,\n"
        "                client_message_id=client_message_id,\n"
        "                auto_title=auto_title,\n"
        "            )",
        "            session.agent_loop.act(\n"
        "                rendered_prompt,\n"
        "                client_message_id=client_message_id,\n"
        "                auto_title=auto_title,\n"
        "                images=images,  " + MARKER + "\n"
        "            )",
    ),
    # 6) Ne pas rejeter les blocs image dans _build_text_prompt
    #    (ils sont gérés à part par _extract_acp_images)
    (
        "                case _:\n"
        "                    raise InvalidRequestError(\n"
        '                        f"We currently don\'t support {block.type} content blocks"\n'
        "                    )",
        '                case "image":  ' + MARKER + "\n"
        "                    pass  # images traitées via _extract_acp_images\n"
        "                case _:\n"
        "                    raise InvalidRequestError(\n"
        '                        f"We currently don\'t support {block.type} content blocks"\n'
        "                    )",
    ),
]

# Méthode helper injectée juste avant _build_text_prompt
HELPER = '''    def _extract_acp_images(self, acp_prompt):
        """{marker}
        Pont bloc image ACP -> ImageAttachment (fichier temp).
        Le moteur lit l'image depuis un fichier (to_data_uri), d'où le mkstemp.
        """
        import base64 as _b64, os as _os, tempfile as _tmp, time as _time
        from pathlib import Path as _Path
        from vibe.core.types import ImageAttachment as _ImageAttachment

        _dir = _Path(_tmp.gettempdir()) / "florian_vibe_acp_img"
        _dir.mkdir(parents=True, exist_ok=True)
        # Purge des images temp de plus d'1h (évite l'accumulation dans /tmp)
        _now = _time.time()
        for _old in _dir.glob("img_*"):
            try:
                if _now - _old.stat().st_mtime > 3600:
                    _old.unlink()
            except OSError:
                pass

        _ext = {{
            "image/png": ".png", "image/jpeg": ".jpg", "image/jpg": ".jpg",
            "image/gif": ".gif", "image/webp": ".webp", "image/bmp": ".bmp",
        }}
        images = []
        for block in acp_prompt:
            if getattr(block, "type", None) != "image":
                continue
            data = getattr(block, "data", None)
            if not data:
                continue
            try:
                raw = _b64.b64decode(data)
            except Exception:
                continue
            mime = getattr(block, "mime_type", None) or "image/png"
            fd, path = _tmp.mkstemp(prefix="img_", suffix=_ext.get(mime, ".png"), dir=str(_dir))
            with _os.fdopen(fd, "wb") as fh:
                fh.write(raw)
            p = _Path(path)
            images.append(_ImageAttachment(path=p, alias=p.name, mime_type=mime))
        return images

    def _build_text_prompt(self, acp_prompt: list[ContentBlock]) -> str:'''.format(marker=MARKER)

HELPER_ANCHOR = "    def _build_text_prompt(self, acp_prompt: list[ContentBlock]) -> str:"


def is_patched(text: str) -> bool:
    return MARKER in text


def apply(path: Path) -> None:
    text = path.read_text(encoding="utf-8")
    if is_patched(text):
        print("Déjà patché — rien à faire.")
        return

    backup = path.with_suffix(path.suffix + ".orig")
    if not backup.exists():
        backup.write_text(text, encoding="utf-8")
        print(f"Backup créé : {backup}")

    # Insérer le helper (une seule fois)
    if HELPER_ANCHOR not in text:
        sys.exit("ERREUR : ancre _build_text_prompt introuvable — code Vibe inattendu.")
    text = text.replace(HELPER_ANCHOR, HELPER, 1)

    for old, new in REPLACEMENTS:
        n = text.count(old)
        if n != 1:
            sys.exit(f"ERREUR : ancre attendue 1x, trouvée {n}x :\n---\n{old[:120]}…")
        text = text.replace(old, new, 1)

    path.write_text(text, encoding="utf-8")
    print(f"Patch appliqué : {path}")
    print("Relance vibe-acp (recompile inutile, Python). Teste l'envoi d'image.")


def revert(path: Path) -> None:
    backup = path.with_suffix(path.suffix + ".orig")
    if not backup.exists():
        sys.exit("Aucun backup .orig à restaurer.")
    path.write_text(backup.read_text(encoding="utf-8"), encoding="utf-8")
    print(f"Restauré depuis {backup}")


def main() -> None:
    target = find_target()
    arg = sys.argv[1] if len(sys.argv) > 1 else "apply"
    if arg == "--check":
        print("PATCHÉ" if is_patched(target.read_text(encoding="utf-8")) else "NON patché")
    elif arg == "--revert":
        revert(target)
    else:
        apply(target)


if __name__ == "__main__":
    main()
