#!/usr/bin/env python3
"""Download Weedy review images listed in assets/weedy-manifest.json, resize, and
rewrite the manifest to point at local optimized copies.

Why: Weedy CDN serves 300KB-1.5MB originals (avg ~580KB). 230+ tiles = 100MB+ per page
load and visibly staggered loading. Local 720px WebP (~40KB) fixes that.

Usage: python3 scripts/cache_reviews.py [--max-w 720] [--quality 78]
Output: assets/reviews/<hash>.webp, manifest 'src' rewritten; original kept in 'origin'.
Also t/<hash>.webp (360px, manifest 'thumb') and s/<hash>.webp (240px, found by
bake_magazine.py from 'thumb' for srcset).
Re-runs skip files already present; a missing s/ file is rebuilt from the local copy
without downloading.
"""
import argparse, json, hashlib, io, os, urllib.request
from PIL import Image, ImageOps

UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/130 Safari/537.36"


def fetch(url):
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Referer": "https://weedy-jp.com/"})
    with urllib.request.urlopen(req, timeout=30) as r:
        return r.read()


def save_small(im, spath, width, quality):
    # A landscape image fills a square cell by height, so 240px wide would look soft;
    # with no s/ file bake_magazine.py leaves that cell on the 360px thumb.
    if im.width > im.height:
        return
    os.makedirs(os.path.dirname(spath), exist_ok=True)
    small = im.resize((width, round(im.height * width / im.width)), Image.LANCZOS)
    small.save(spath, "WEBP", quality=quality, method=4)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--manifest", default="assets/weedy-manifest.json")
    ap.add_argument("--out-dir", default="assets/reviews")
    ap.add_argument("--max-w", type=int, default=720)
    ap.add_argument("--quality", type=int, default=78)
    ap.add_argument("--thumb-w", type=int, default=360, help="hero-wall thumbnail width")
    ap.add_argument("--small-w", type=int, default=240, help="srcset width for small grid cells and the mobile hero")
    a = ap.parse_args()
    os.makedirs(a.out_dir, exist_ok=True)

    items = json.load(open(a.manifest, encoding="utf-8"))
    done = skipped = failed = 0
    total_in = total_out = 0
    for it in items:
        origin = it.get("origin") or it["src"]
        it["origin"] = origin
        if it["type"] != "image" and not origin.lower().split("?")[0].endswith((".jpg", ".jpeg", ".png", ".webp")):
            continue  # real video file: leave as-is; .jpg covers of videos are cached like images
        name = hashlib.sha1(origin.encode()).hexdigest()[:16] + ".webp"
        path = os.path.join(a.out_dir, name)
        tpath = os.path.join(a.out_dir, "t", name)
        spath = os.path.join(a.out_dir, "s", name)
        if os.path.exists(path) and os.path.exists(tpath):
            it["src"] = path; it["thumb"] = tpath; skipped += 1
            if not os.path.exists(spath):
                try:
                    with Image.open(path) as im:
                        save_small(im.convert("RGB"), spath, a.small_w, a.quality - 8)
                except Exception as e:
                    print("FAIL", path, e); failed += 1
            continue
        try:
            raw = fetch(origin)
            im = ImageOps.exif_transpose(Image.open(io.BytesIO(raw))).convert("RGB")
            if im.width > a.max_w:
                im = im.resize((a.max_w, round(im.height * a.max_w / im.width)), Image.LANCZOS)
            im.save(path, "WEBP", quality=a.quality, method=4)
            it["src"] = path; it["w"], it["h"] = im.size
            th = im.resize((a.thumb_w, round(im.height * a.thumb_w / im.width)), Image.LANCZOS)
            tpath = os.path.join(a.out_dir, "t", name); os.makedirs(os.path.dirname(tpath), exist_ok=True)
            th.save(tpath, "WEBP", quality=a.quality - 8, method=4); it["thumb"] = tpath
            save_small(im, spath, a.small_w, a.quality - 8)
            total_in += len(raw); total_out += os.path.getsize(path); done += 1
        except Exception as e:
            print("FAIL", origin, e); failed += 1

    json.dump(items, open(a.manifest, "w", encoding="utf-8"), ensure_ascii=False, indent=1)
    slim = [{k: v for k, v in i.items() if k in ("src", "thumb", "type", "category", "alt", "permalink", "w", "h")} for i in items]
    client = a.manifest.replace(".json", ".client.json")
    json.dump(slim, open(client, "w", encoding="utf-8"), ensure_ascii=False, separators=(",", ":"))
    print(f"downloaded {done}, cached {skipped}, failed {failed}; "
          f"{total_in/1e6:.1f}MB -> {total_out/1e6:.1f}MB")


if __name__ == "__main__":
    main()
