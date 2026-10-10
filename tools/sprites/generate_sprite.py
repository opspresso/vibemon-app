#!/usr/bin/env python3
"""Generate a character sprite sheet with OpenAI image API using spritesheet.md prompt."""
import base64
import os
import sys
from pathlib import Path

import urllib.request

PROMPTS = Path(__file__).resolve().parent
ROOT = PROMPTS.parent.parent


def load_env(path: Path) -> dict:
    env = {}
    for line in path.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        env[key.strip()] = value.strip().strip('"').strip("'")
    return env


def build_prompt(character_description: str) -> str:
    template = (PROMPTS / "spritesheet.md").read_text()
    return template.replace("[CHARACTER DESCRIPTION]", character_description)


CHARACTER_DESCRIPTION = """\
Use the attached reference image as the exact character.
It is "Daangni": a cute chubby mascot wearing a soft white rabbit costume with two long rounded ears,
a round peach-colored face opening, simple black oval eyes, a small black nose with a tiny smile,
a fluffy green leaf-like hair tuft (three rounded green puffs) on the forehead,
and holding a small orange carrot with green leaves in one hand.
Soft 3D-rendered toy-like style, smooth matte surfaces, pastel colors, gentle studio lighting.
Keep this exact identity, colors, proportions, and rendering style in every frame."""


def main() -> None:
    env_file = ROOT / ".env.local"
    env = load_env(env_file) if env_file.exists() else {}
    api_key = os.environ.get("OPENAI_API_KEY") or env.get("OPENAI_API_KEY")
    if not api_key:
        raise SystemExit("Set OPENAI_API_KEY in the environment or the repository .env.local")
    model = os.environ.get("IMAGE_MODEL") or env.get("IMAGE_MODEL", "gpt-image-2")
    size = sys.argv[1] if len(sys.argv) > 1 else "1536x1024"
    out_path = Path(sys.argv[2]) if len(sys.argv) > 2 else PROMPTS / "spritesheet_out.png"

    prompt = build_prompt(CHARACTER_DESCRIPTION)

    boundary = "----spritegenboundary"
    ref_image = (PROMPTS / "daangni.png").read_bytes()

    def part(name: str, value: str) -> bytes:
        return (
            f"--{boundary}\r\nContent-Disposition: form-data; name=\"{name}\"\r\n\r\n{value}\r\n"
        ).encode()

    body = b""
    body += part("model", model)
    body += part("prompt", prompt)
    body += part("size", size)
    if os.environ.get("SPRITE_TRANSPARENT_PARAM") == "1":
        body += part("background", "transparent")
    body += part("output_format", "png")
    body += part("quality", "high")
    body += (
        f"--{boundary}\r\nContent-Disposition: form-data; name=\"image[]\"; filename=\"daangni.png\"\r\n"
        "Content-Type: image/png\r\n\r\n"
    ).encode() + ref_image + b"\r\n"
    template_path = PROMPTS / "grid_template.png"
    if template_path.exists():
        body += (
            f"--{boundary}\r\nContent-Disposition: form-data; name=\"image[]\"; filename=\"grid_template.png\"\r\n"
            "Content-Type: image/png\r\n\r\n"
        ).encode() + template_path.read_bytes() + b"\r\n"
    body += f"--{boundary}--\r\n".encode()

    req = urllib.request.Request(
        "https://api.openai.com/v1/images/edits",
        data=body,
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": f"multipart/form-data; boundary={boundary}",
        },
        method="POST",
    )
    print(f"Requesting {model} size={size} ...", flush=True)
    try:
        with urllib.request.urlopen(req, timeout=600) as resp:
            import json

            data = json.loads(resp.read())
    except urllib.error.HTTPError as e:
        print(f"Image request failed (HTTP {e.code})")
        sys.exit(1)

    b64 = data["data"][0]["b64_json"]
    out_path.write_bytes(base64.b64decode(b64))
    print(f"Saved {out_path}")


if __name__ == "__main__":
    main()
