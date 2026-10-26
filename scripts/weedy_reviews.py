#!/usr/bin/env python3
"""Pull 베스트 리뷰 from Weedy (weedy-jp.com) and emit wall-manifest.json format.

Source: GET https://weedy-jp.com/api/common/getprimreview  (public, no login)
  -> {"codeName":0, "dataTable":"<json string of rows>"}
Row fields used: media_uri (image.weedy-jp.com CDN), media_type (PT=photo, MV=video),
  large_cd/middle_cd (category), permalink (instagram), campaign_nm, sns_type.

Category map (Weedy -> landing tabs):
  BT/SK -> skin   BT/CR -> tone   BT/BD -> body   FD/* -> food
  LF/* (lifestyle), BT/ET (etc) -> dropped unless --keep-other

Usage:
  python3 scripts/weedy_reviews.py                       # -> assets/weedy-manifest.json
  python3 scripts/weedy_reviews.py -o /path/out.json --per-cat 24
"""
import argparse, json, sys, urllib.request, collections

API = "https://weedy-jp.com/api/common/getprimreview"
CAT = {("BT", "SK"): "skin", ("BT", "CR"): "tone", ("BT", "BD"): "body", ("BT", "ET"): "body",
       ("LF", "PP"): "life", ("LF", "LF"): "life"}
ALT = {"skin": "스킨케어 제품 사용 리뷰 게시물", "tone": "색조 제품 사용 리뷰 게시물",
       "body": "바디 제품 사용 리뷰 게시물", "food": "식품 사용 리뷰 게시물", "life": "생활용품 사용 리뷰 게시물", "other": "리뷰 게시물"}


def category(r):
    if r.get("large_cd") == "FD":
        return "food"
    return CAT.get((r.get("large_cd"), r.get("middle_cd")), "other")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("-o", "--out", default="assets/weedy-manifest.json")
    ap.add_argument("--per-cat", type=int, default=0, help="cap per category (0 = all)")
    ap.add_argument("--keep-other", action="store_true")
    ap.add_argument("--ig-only", action="store_true", help="drop TW/RL rows")
    a = ap.parse_args()

    req = urllib.request.Request(API, headers={"User-Agent": "enclu-landing/1.0"})
    with urllib.request.urlopen(req, timeout=20) as resp:
        env = json.load(resp)
    if env.get("codeName") != 0:
        sys.exit(f"API error: {env}")
    rows = json.loads(env["dataTable"])

    out, seen, count = [], set(), collections.Counter()
    for r in rows:
        uri = r.get("media_uri")
        if not uri or uri in seen:
            continue
        if a.ig_only and r.get("sns_type") != "IG":
            continue
        cat = category(r)
        if cat == "other" and not a.keep_other:
            continue
        if a.per_cat and count[cat] >= a.per_cat:
            continue
        seen.add(uri); count[cat] += 1
        out.append({
            "src": uri,
            "type": "video" if uri.lower().split("?")[0].endswith((".mp4", ".mov", ".webm", ".m4v")) else "image",
            "category": cat,
            "alt": ALT[cat],
            "permalink": r.get("permalink"),
            "campaign": r.get("campaign_nm"),
            "sns": r.get("sns_type"),
        })

    with open(a.out, "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, indent=1)
    print(f"wrote {a.out}: {len(out)} items  {dict(count)}  (source rows {len(rows)})")


if __name__ == "__main__":
    main()
