#!/usr/bin/env python3
"""Transcode short-form source videos and bake them into the index.html reels strip.

Why: raw phone/Instagram exports are 10-100MB each. Muted 720p-ish H.264 with
faststart plus a small WebP poster keeps the strip light on GitHub Pages.

Usage: python3 scripts/bake_reels.py [--src assets/reels/src] [--links links.txt]
Output: assets/reels/<sha1(content)[:12]>.mp4 + .webp, and the region between
<!-- reels:strip --> and <!-- /reels:strip --> in index.html rewritten.
Re-runs skip outputs already present. 0 videos empties the region and hides
<section id="reels">. A missing --src directory is an error, not 0 videos: src is
gitignored, so a fresh clone must not silently wipe the live strip.
"""
import argparse, functools, hashlib, html, os, re, subprocess, sys

EXTS = (".mp4", ".mov", ".m4v", ".webm")
MAX_SECONDS = 30
POSTER_AT = 1.0
EAGER_CARDS = 4  # cards past this get preload="none"
STRIP_RE = re.compile(r'<!-- reels:strip -->.*?<!-- /reels:strip -->', re.S)
SECTION_RE = re.compile(r'<section id="reels"[^>]*>')
INDENT = "        "


def run(cmd):
    p = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, universal_newlines=True)
    if p.returncode != 0:
        sys.exit(f"command failed: {' '.join(cmd)}\n{p.stderr.strip()[-800:]}")
    return p.stdout.strip()


@functools.lru_cache(maxsize=None)
def ffmpeg_with(encoder):
    """First ffmpeg on PATH that has the encoder: some builds (e.g. Homebrew's) lack libwebp."""
    for d in os.environ.get("PATH", "").split(os.pathsep):
        exe = os.path.join(d, "ffmpeg")
        if not os.access(exe, os.X_OK):
            continue
        p = subprocess.run([exe, "-hide_banner", "-encoders"], stdout=subprocess.PIPE,
                           stderr=subprocess.DEVNULL, universal_newlines=True)
        if f" {encoder} " in p.stdout:
            return exe
    sys.exit(f"no ffmpeg on PATH has the {encoder} encoder")


def content_key(path):
    h = hashlib.sha1()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()[:12]


def duration(path):
    out = run(["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries", "format=duration",
               "-of", "default=noprint_wrappers=1:nokey=1", path])
    try:
        return float(out)
    except ValueError:
        sys.exit(f"no readable video duration: {path}")


def transcode(src, dst):
    # trunc(.../2)*2: an odd source height would otherwise be rejected by yuv420p.
    # Output goes to a temp name first so an interrupted run is never skipped as done.
    tmp = dst + ".tmp.mp4"
    run([ffmpeg_with("libx264"), "-y", "-v", "error", "-i", src, "-t", str(MAX_SECONDS),
         "-map", "0:v:0", "-an", "-sn", "-dn", "-map_metadata", "-1",
         "-vf", "scale=-2:'trunc(min(1280,ih)/2)*2'",
         "-c:v", "libx264", "-profile:v", "high", "-pix_fmt", "yuv420p",
         "-crf", "28", "-preset", "slow", "-movflags", "+faststart", tmp])
    os.replace(tmp, dst)


def poster(src, dst):
    # Clips under 2s have no frame at 1s to spare, so fall back to the midpoint.
    at = min(POSTER_AT, duration(src) / 2)
    tmp = dst + ".tmp.webp"
    run([ffmpeg_with("libwebp"), "-y", "-v", "error", "-ss", f"{at:.3f}", "-i", src, "-map", "0:v:0",
         "-frames:v", "1", "-vf", "scale=540:-2", "-map_metadata", "-1",
         "-c:v", "libwebp", "-quality", "78", tmp])
    os.replace(tmp, dst)


def read_links(path, count):
    """One URL per line in source order; a blank line means that video has no link."""
    with open(path, encoding="utf-8") as f:
        links = [line.strip() for line in f]
    while links and not links[-1]:
        links.pop()
    for url in links:
        if url and not url.startswith(("https://", "http://")):
            sys.exit(f"not an http(s) URL in {path}: {url}")
    if len(links) > count:
        print(f"warning: {len(links)} links for {count} videos, extras ignored", file=sys.stderr)
    return links + [""] * (count - len(links))


def card_html(n, stem, link, web_dir):
    preload = "metadata" if n <= EAGER_CARDS else "none"
    label = f"숏폼 리뷰 영상 {n}"
    video = (f'<video muted playsinline loop preload="{preload}" poster="{web_dir}/{stem}.webp" '
             f'src="{web_dir}/{stem}.mp4"></video>')
    if link:
        return (f'<a class="reel-card" href="{html.escape(link, quote=True)}" target="_blank" rel="noopener" '
                f'aria-label="{label}, 인스타그램에서 보기">{video}</a>')
    return f'<div class="reel-card" role="img" aria-label="{label}">{video}</div>'


def rewrite_html(path, cards):
    # newline="": keep the file's line endings so a no-op bake is byte-identical.
    with open(path, encoding="utf-8", newline="") as f:
        doc = f.read()
    if not STRIP_RE.search(doc) or not SECTION_RE.search(doc):
        sys.exit(f'could not locate <!-- reels:strip --> block or <section id="reels"> in {path}')
    body = "".join(f"{INDENT}{c}\n" for c in cards)
    new = STRIP_RE.sub(lambda m: f"<!-- reels:strip -->\n{body}{INDENT}<!-- /reels:strip -->", doc)
    def set_hidden(m):
        tag = m.group(0).replace(" hidden", "")
        return tag if cards else tag[:-1] + " hidden>"
    new = SECTION_RE.sub(set_hidden, new)
    if new != doc:
        with open(path, "w", encoding="utf-8", newline="") as f:
            f.write(new)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--src", default="assets/reels/src")
    ap.add_argument("--links", help="text file: one Instagram URL per line, same order as the sorted sources")
    ap.add_argument("--html", default="index.html")
    ap.add_argument("--out", default="assets/reels")
    a = ap.parse_args()

    if not os.path.isdir(a.src):
        sys.exit(f"source directory not found: {a.src} (create it and add videos; nothing was changed)")
    os.makedirs(a.out, exist_ok=True)

    names = sorted(n for n in os.listdir(a.src)
                   if n.lower().endswith(EXTS) and not n.startswith("."))
    links = read_links(a.links, len(names)) if a.links else [""] * len(names)
    web_dir = os.path.relpath(a.out, os.path.dirname(a.html) or ".").replace(os.sep, "/")

    cards, stems = [], set()
    done = skipped = 0
    total = 0
    for n, (name, link) in enumerate(zip(names, links), 1):
        src = os.path.join(a.src, name)
        stem = content_key(src)
        stems.add(stem)
        mp4, webp = os.path.join(a.out, stem + ".mp4"), os.path.join(a.out, stem + ".webp")
        if os.path.exists(mp4) and os.path.exists(webp):
            skipped += 1
        else:
            if not os.path.exists(mp4):
                transcode(src, mp4)
            if not os.path.exists(webp):
                poster(src, webp)
            done += 1
        total += os.path.getsize(mp4) + os.path.getsize(webp)
        cards.append(card_html(n, stem, link, web_dir))

    rewrite_html(a.html, cards)

    orphans = sorted(n for n in os.listdir(a.out)
                     if n.endswith((".mp4", ".webp")) and os.path.splitext(n)[0] not in stems)
    if orphans:
        print(f"note: {len(orphans)} files in {a.out} are no longer used; git rm them if replaced for good")
    print(f"reels: {len(cards)} videos, {total / 1024 / 1024:.1f} MB ({done} transcoded, {skipped} skipped)")


if __name__ == "__main__":
    main()
