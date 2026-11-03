#!/usr/bin/env python3
"""Optimize brand logos and bake them into the index.html brand wall.

Why: sources are 800x500 PNGs that are mostly transparent padding. Trimmed WebP
keeps all logos light and lets them line up by their visible edges.

Usage: python3 scripts/bake_brands.py [--src assets/IMG/brands/src]
Input: "<order>_<Brand Name>.(png|jpg|jpeg|webp|svg)"; order is numeric, the name
becomes alt/aria-label with trailing dots stripped.
Output: assets/IMG/brands/<slug>.webp (.svg sources are copied as-is, untrimmed), and
the region between <!-- brands:wall --> and <!-- /brands:wall --> in index.html rewritten,
along with the brand count (see COUNT_SUBS). Logos in KEEP_COLOR skip the white filter.
Repeated names get -2, -3... in order. Outputs are rebuilt on every run, so renumbering
same-named logos can't leave a stale image under a slug.
A missing or empty --src is an error, not 0 logos: src is gitignored, so a fresh
clone must not silently wipe the live wall.
"""
import argparse, functools, html, os, re, shutil, subprocess, sys, unicodedata

RASTER_EXTS = (".png", ".jpg", ".jpeg", ".webp")
EXTS = RASTER_EXTS + (".svg",)
NAME_RE = re.compile(r"^(\d+)_(.+)$")
WALL_RE = re.compile(r"<!-- brands:wall -->.*?<!-- /brands:wall -->", re.S)
# Source file names (no extension) shown in original colors, because the white
# filter flattens them into an unreadable shape.
KEEP_COLOR = {"7_CHASIN'RABBITS", "59_Maeil"}
# Comments can't sit inside attribute values, so the meta tags and the stat's
# data attribute are matched by their surrounding text instead of by markers.
COUNT_SUBS = [
    (re.compile(r"(<!-- brands:count -->)\d+(<!-- /brands:count -->)"), 2),
    (re.compile(r"(K-뷰티 )\d+(개 브랜드의)"), 3),
    (re.compile(r'(data-seed-num=")\d+(개" data-ads-text="브랜드별 개별 집행")'), 1),
]
SVG_SIZE_RE = re.compile(r'viewBox="\s*[-\d.]+[\s,]+[-\d.]+[\s,]+([\d.]+)[\s,]+([\d.]+)\s*"')
MAX_H, MAX_W = 160, 480  # never upscaled; 3x the largest size the chips display
QUALITY = "85"
# Faint halos around a logo shouldn't count as content when trimming.
ALPHA_MIN = 8
IS_CONTENT = bytes(1 if a > ALPHA_MIN else 0 for a in range(256))
INDENT = "      "


def on_path(name):
    for d in os.environ.get("PATH", "").split(os.pathsep):
        exe = os.path.join(d, name)
        if os.path.isfile(exe) and os.access(exe, os.X_OK):
            yield exe


@functools.lru_cache(maxsize=None)
def ffmpeg_with(encoder):
    """First ffmpeg on PATH that has the encoder: some builds (e.g. Homebrew's) lack libwebp."""
    for exe in on_path("ffmpeg"):
        p = subprocess.run([exe, "-hide_banner", "-encoders"], stdout=subprocess.PIPE,
                           stderr=subprocess.DEVNULL, universal_newlines=True)
        if f" {encoder} " in p.stdout:
            return exe
    sys.exit(f"no ffmpeg on PATH has the {encoder} encoder")


@functools.lru_cache(maxsize=None)
def ffprobe_exe():
    for exe in on_path("ffprobe"):
        return exe
    sys.exit("ffprobe not found on PATH (it ships with ffmpeg)")


def run(cmd):
    p = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    if p.returncode != 0:
        sys.exit(f"command failed: {' '.join(cmd)}\n{p.stderr.decode(errors='replace').strip()[-800:]}")
    return p.stdout


def source_size(path):
    out = run([ffprobe_exe(), "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height",
               "-of", "csv=p=0", path]).decode().strip()
    try:
        w, h = out.split(",")[:2]
        return int(w), int(h)
    except ValueError:
        sys.exit(f"not a readable image: {path}")


def alpha_bbox(path, w, h):
    """(x, y, width, height) of the visible content, or None if there is none."""
    raw = run([ffmpeg_with("libwebp"), "-v", "error", "-i", path, "-frames:v", "1",
               "-f", "rawvideo", "-pix_fmt", "rgba", "-"])
    mask = raw[3::4].translate(IS_CONTENT)
    rows = [mask[y * w:(y + 1) * w] for y in range(h)]
    ys = [y for y, row in enumerate(rows) if 1 in row]
    if not ys:
        return None
    left = min(rows[y].find(1) for y in ys)
    right = max(rows[y].rfind(1) for y in ys)
    return left, ys[0], right - left + 1, ys[-1] - ys[0] + 1


def bake_raster(src, dst):
    w, h = source_size(src)
    box = alpha_bbox(src, w, h)
    if box is None:
        sys.exit(f"image is fully transparent: {src}")
    x, y, cw, ch = box
    if (cw, ch) == (w, h):
        # The CSS filter turns every opaque pixel white, so this would show as a solid block.
        print(f"warning: no transparent padding, may show as a white box: {os.path.basename(src)}", file=sys.stderr)
    scale = min(1, MAX_H / ch, MAX_W / cw)
    ow, oh = max(1, round(cw * scale)), max(1, round(ch * scale))
    # Output goes to a temp name first so an interrupted run never leaves a partial logo.
    tmp = dst + ".tmp.webp"
    run([ffmpeg_with("libwebp"), "-y", "-v", "error", "-i", src, "-frames:v", "1",
         "-vf", f"crop={cw}:{ch}:{x}:{y},scale={ow}:{oh}:flags=lanczos,format=yuva420p",
         "-map_metadata", "-1", "-c:v", "libwebp", "-quality", QUALITY, "-compression_level", "6", tmp])
    os.replace(tmp, dst)
    return ow, oh


def bake_svg(src, dst):
    with open(src, encoding="utf-8") as f:
        m = SVG_SIZE_RE.search(f.read())
    if not m:
        sys.exit(f"SVG needs a viewBox: {src}")
    shutil.copyfile(src, dst)
    return round(float(m.group(1))), round(float(m.group(2)))


def slugify(name, order):
    ascii_name = unicodedata.normalize("NFKD", name).encode("ascii", "ignore").decode()
    # An apostrophe joins its word (It'SSKIN -> itsskin); other punctuation separates.
    slug = re.sub(r"[^a-z0-9]+", "-", ascii_name.lower().replace("'", "")).strip("-")
    return slug or f"brand-{order}"


def read_sources(src):
    logos, bad = [], []
    for n in os.listdir(src):
        stem, ext = os.path.splitext(n)
        if n.startswith(".") or ext.lower() not in EXTS:
            continue
        m = NAME_RE.match(unicodedata.normalize("NFC", stem))
        name = m.group(2).strip().rstrip(".").rstrip() if m else ""
        if not name:
            bad.append(n)
            continue
        logos.append((int(m.group(1)), name, ext.lower(), n))
    if bad:
        sys.exit("expected <order>_<Brand Name>.<ext>, nothing was changed:\n  " + "\n  ".join(sorted(bad)))
    return sorted(logos)


def chip_html(name, path, w, h, keep_color):
    label = html.escape(name, quote=True)
    cls = "brand-chip is-color" if keep_color else "brand-chip"
    return (f'<button type="button" class="{cls}" aria-label="{label}">'
            f'<img src="{path}" alt="{label}" width="{w}" height="{h}" loading="lazy" decoding="async">'
            f'<span class="brand-name">{html.escape(name, quote=False)}</span></button>')


def rewrite_html(path, chips):
    # newline="": keep the file's line endings so a no-op bake is byte-identical.
    with open(path, encoding="utf-8", newline="") as f:
        doc = f.read()
    if not WALL_RE.search(doc):
        sys.exit(f"could not locate <!-- brands:wall --> block in {path}")
    body = "".join(f"{INDENT}{c}\n" for c in chips)
    new = WALL_RE.sub(lambda m: f"<!-- brands:wall -->\n{body}{INDENT}<!-- /brands:wall -->", doc)
    for pattern, expected in COUNT_SUBS:
        new, found = pattern.subn(lambda m: f"{m.group(1)}{len(chips)}{m.group(2)}", new)
        if found != expected:
            sys.exit(f"expected {expected} brand count matches for {pattern.pattern} in {path}, found {found}; "
                     "nothing was changed")
    if new != doc:
        with open(path, "w", encoding="utf-8", newline="") as f:
            f.write(new)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--src", default="assets/IMG/brands/src")
    ap.add_argument("--html", default="index.html")
    ap.add_argument("--out", default="assets/IMG/brands")
    a = ap.parse_args()

    if not os.path.isdir(a.src):
        sys.exit(f"source directory not found: {a.src} (create it and add logos; nothing was changed)")
    logos = read_sources(a.src)
    if not logos:
        sys.exit(f"no logos in {a.src}; nothing was changed")
    web_dir = os.path.relpath(a.out, os.path.dirname(a.html) or ".").replace(os.sep, "/")

    chips, used, total = [], {}, 0
    for order, name, ext, filename in logos:
        slug = slugify(name, order)
        used[slug] = used.get(slug, 0) + 1
        if used[slug] > 1:
            slug = f"{slug}-{used[slug]}"
        out_name = slug + (".svg" if ext == ".svg" else ".webp")
        dst = os.path.join(a.out, out_name)
        src = os.path.join(a.src, filename)
        w, h = bake_svg(src, dst) if ext == ".svg" else bake_raster(src, dst)
        total += os.path.getsize(dst)
        keep_color = os.path.splitext(unicodedata.normalize("NFC", filename))[0] in KEEP_COLOR
        chips.append((out_name, chip_html(name, f"{web_dir}/{out_name}", w, h, keep_color)))

    rewrite_html(a.html, [c for _, c in chips])

    stems = {os.path.splitext(unicodedata.normalize("NFC", l[3]))[0] for l in logos}
    for stem in sorted(KEEP_COLOR - stems):
        print(f"warning: KEEP_COLOR entry matches no source: {stem}", file=sys.stderr)

    keep = {n for n, _ in chips}
    orphans = sorted(n for n in os.listdir(a.out)
                     if n.endswith((".webp", ".svg")) and n not in keep)
    if orphans:
        print(f"note: {len(orphans)} files in {a.out} are no longer used; git rm them if removed for good:")
        for n in orphans:
            print(f"  {n}")
    print(f"brands: {len(chips)} logos, {total / 1024:.0f} KB")


if __name__ == "__main__":
    main()
