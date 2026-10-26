#!/usr/bin/env python3
"""Bake Weedy reviews into v7-magazine.html as category "chapters" using a
SIMPLE SQUARE-CELL GRID: CSS dense auto-flow does all the placement (no
explicit grid-column/row, no custom properties). Only three tile sizes
exist -- 1x1 square, 2x1 (two squares wide), 2x2 (two squares square) --
chosen so that a plain row-major first-fit dense auto-placement, simulated
here in Python for BOTH the 6-column desktop grid and the 4-column mobile
grid, produces a perfect hole-free rectangle on each. Because every size
is itself square-multiple, rows are always flush and nothing can overlap.

History (user feedback, verbatim in Korean):
  "리뷰가 너무 대충이다 그냥 서로 겹치지 않게 해주고 네모칸도 좀 정사각형으로
  해서 해줘" -- the previous skyline/row packer (baked explicit --dgc/--dgr/
  --dar custom properties) produced inconsistent row heights, wide thin
  strips and holes once '더 보기' removed a trailing data-row-hide item
  (explicit positions don't reflow). This version removes ALL explicit
  placement; sizing/order is chosen so dense auto-flow alone is correct.

ALGORITHM
  1. Per chapter, decide counts of 2x2 (n22, ~15-20% of items) and 2x1
     (n21, as few as needed) such that total cells
         n1 + 4*n22 + 2*n21   (n1 = remaining 1x1 count)
     is a multiple of 12 (lcm(6,4)*... actually lcm of the two column
     counts' "rectangle" requirement: a multiple of 12 guarantees an
     integer number of both 6-wide and 4-wide rows).
  2. Deterministically shuffle item order (seed = chapter name, bumped
     until simulation passes) and assign sizes to positions such that:
       - no two 2x2 appear adjacent in the shuffled sequence
       - the LAST 8 items are forced to 1x1 (pure backfill, these are what
         plug any dense-packing holes at the tail)
  3. Simulate real CSS grid "dense" auto-placement (row-major scan,
     first-fit-that-clears, dense backfill into earlier holes) for both
     6 and 4 columns. Assert zero holes and that the grid height is an
     integer number of full rows (last row entirely filled).
  4. If the simulation fails, try the next seed. Iterate until pass (or
     give up after many tries, which should not happen given the size
     mix above -- the assertion guards this).
  5. Pick a '더 보기' cut: the largest index <= ~28 such that the VISIBLE
     PREFIX (items[:cut]) independently simulates to a hole-free rectangle
     on BOTH widths too (so collapsing never shows a partial/holey grid).
     If none exists, show the whole chapter (expected for food's 12 items).

Usage:
  python3 scripts/bake_magazine.py --html v7-magazine.html

Idempotent: regions are delimited by <!-- weedy:chapter:CAT --> markers;
re-running regenerates them from the manifest without drifting.
"""
import argparse, json, re, html, random

CAT_ORDER = ["skin", "tone", "body", "food", "life"]
CAT_KO = {"skin": "스킨케어", "tone": "색조", "body": "바디", "food": "식품", "life": "생활용품"}
PANEL_KEY = {"skin": "skin", "tone": "tone", "body": "bocy", "food": "food", "life": "life"}  # legacy data-panel ids kept for tab jump targets

DESKTOP_COLS = 6
MOBILE_COLS = 4
VISIBLE_TARGET = 28  # approx tiles shown before "더 보기"
VISIBLE_MIN = 18     # do not accept a seed whose valid cut shows fewer than this
TAIL_1X1 = 8         # last N items of a chapter are forced 1x1 (hole backfill)
MAX_SEED_TRIES = 500

# --------------------------------------------------------- dense simulator --

def simulate_dense(sizes, cols):
    """Simulate CSS grid-auto-flow:dense placement for a sequence of
    (w, h) cell sizes into a grid with `cols` columns. Mirrors the CSS
    spec's algorithm closely enough for our restricted size vocabulary
    (1x1, 2x1, 2x2): scan row-major from the top-left; for each item find
    the FIRST position (row-major order, dense = may go back to earlier
    rows) where a w x h block fits entirely within unoccupied cells and
    within `cols` columns; occupy it. Returns (n_rows, holes, occ) where
    holes is the count of empty cells within the bounding n_rows x cols
    rectangle (0 == perfect rectangle, since n_rows is derived from actual
    occupancy, this checks the LAST row is fully packed too)."""
    occ = set()  # set of (row, col)
    max_row = -1
    for (w, h) in sizes:
        row = 0
        placed = False
        while not placed:
            for col in range(0, cols - w + 1):
                fits = True
                for yy in range(row, row + h):
                    for xx in range(col, col + w):
                        if (yy, xx) in occ:
                            fits = False
                            break
                    if not fits:
                        break
                if fits:
                    for yy in range(row, row + h):
                        for xx in range(col, col + w):
                            occ.add((yy, xx))
                    max_row = max(max_row, row + h - 1)
                    placed = True
                    break
            if not placed:
                row += 1
    n_rows = max_row + 1
    total_cells = n_rows * cols
    holes = total_cells - len(occ)
    return n_rows, holes


def assert_rectangle(sizes, cols, label):
    n_rows, holes = simulate_dense(sizes, cols)
    assert holes == 0, f"{label}: {holes} hole(s) over {n_rows} rows x {cols} cols"
    return n_rows


# ------------------------------------------------------- size-mix planner --

def plan_sizes(n):
    """Return (n1, n21, n22) with n1+n21+n22 == n ITEMS and total CELLS
    (n1*1 + n21*2 + n22*4) a multiple of 12. Prefer n21=0: a 2x1 tile's
    CSS aspect-ratio (2/1) only equals two true square columns when the
    4px gap is ignored, so mixing 2x1 into a row with 1x1 siblings can
    make the implicit row track ~2px taller than a square and (in some
    browsers, worse, at the very last row) undersize/overflow. 2x2 tiles
    don't have this problem: aspect-ratio 1/1 over a 2-col x 2-row span
    needs exactly 2*colW + 1*gap in both directions, which is exactly
    what two rows of two columns with a uniform 4px gap provide. So we
    only reach for 2x1 if no clean 2x2-only mix hits the multiple-of-12
    constraint for this n."""
    target_n22 = max(1, round(n * 0.17))
    # pass 1: 2x1-free mixes only
    best = None
    for n22 in range(max(0, target_n22 - 4), target_n22 + 5):
        if n22 < 0 or n22 > n:
            continue
        n1 = n - n22
        if n1 < 0:
            continue
        cells = n1 + 4 * n22
        if cells % 12 == 0:
            score = abs(n22 - target_n22)
            if best is None or score < best[0] or (score == best[0] and n22 > best[3]):
                best = (score, n1, 0, n22, cells)
    if best is not None:
        _, n1, n21, n22, cells = best
        return n1, n21, n22, cells
    # pass 2: fall back to allowing a few 2x1 tiles
    for n22 in range(max(0, target_n22 - 3), target_n22 + 4):
        if n22 < 0 or n22 > n:
            continue
        for n21 in range(0, min(6, n - n22) + 1):
            n1 = n - n22 - n21
            if n1 < 0:
                continue
            cells = n1 + 2 * n21 + 4 * n22
            if cells % 12 == 0:
                score = abs(n22 - target_n22) * 10 + n21
                if best is None or score < best[0]:
                    best = (score, n1, n21, n22, cells)
    assert best is not None, f"no valid size mix found for n={n}"
    _, n1, n21, n22, cells = best
    return n1, n21, n22, cells


# --------------------------------------------------------- chapter packing --

def pack_chapter(cat_items, cat):
    n = len(cat_items)
    n1, n21, n22 = plan_sizes(n)[:3]
    fallback = None  # first seed that at least produces a hole-free full rectangle

    for seed_i in range(MAX_SEED_TRIES):
        rng = random.Random(f"{cat}|{seed_i}")
        sizes = (["2x2"] * n22) + (["2x1"] * n21) + (["1x1"] * n1)
        # keep a free pool to shuffle, but force the tail to 1x1
        tail_n = min(TAIL_1X1, n1)
        non_tail = sizes[:]
        # pull out tail_n worth of 1x1 reserved for the end
        for _ in range(tail_n):
            non_tail.remove("1x1")
        rng.shuffle(non_tail)

        # break up adjacent 2x2 runs greedily
        def has_adjacent_2x2(seq):
            return any(seq[i] == "2x2" and seq[i + 1] == "2x2" for i in range(len(seq) - 1))

        guard = 0
        while has_adjacent_2x2(non_tail) and guard < 200:
            for i in range(len(non_tail) - 1):
                if non_tail[i] == "2x2" and non_tail[i + 1] == "2x2":
                    swap_with = None
                    for j in range(len(non_tail)):
                        if non_tail[j] != "2x2" and (j == 0 or non_tail[j - 1] != "2x2") and (j == len(non_tail) - 1 or non_tail[j + 1] != "2x2"):
                            swap_with = j
                            break
                    if swap_with is not None:
                        non_tail[i + 1], non_tail[swap_with] = non_tail[swap_with], non_tail[i + 1]
                    break
            guard += 1

        seq = non_tail + (["1x1"] * tail_n)
        size_map = {"1x1": (1, 1), "2x1": (2, 1), "2x2": (2, 2)}
        cell_seq = [size_map[s] for s in seq]

        try:
            rows_d = assert_rectangle(cell_seq, DESKTOP_COLS, f"{cat}/desktop/seed{seed_i}")
            rows_m = assert_rectangle(cell_seq, MOBILE_COLS, f"{cat}/mobile/seed{seed_i}")
        except AssertionError:
            continue

        # pick a '더 보기' cut: largest index <= VISIBLE_TARGET whose
        # prefix is ALSO a hole-free rectangle on both widths
        cut = None
        if n > VISIBLE_TARGET:
            for c in range(min(VISIBLE_TARGET, n), 0, -1):
                prefix = cell_seq[:c]
                try:
                    assert_rectangle(prefix, DESKTOP_COLS, "prefix-d")
                    assert_rectangle(prefix, MOBILE_COLS, "prefix-m")
                except AssertionError:
                    continue
                cut = c
                break

        result = (seq, rows_d, rows_m, cut, seed_i, (n1, n21, n22))
        if n <= VISIBLE_TARGET or (cut is not None and cut >= VISIBLE_MIN):
            return result
        if fallback is None or (cut or 0) > (fallback[3] or 0):
            fallback = result  # keep trying other seeds for a bigger valid cut

    if fallback is not None:
        return fallback
    raise AssertionError(f"{cat}: no seed in range produced a hole-free rectangle")


# ------------------------------------------------------------- HTML build --

def item_html(it, size):
    cat = it["category"]
    cls = {"1x1": "", "2x1": " is-2x1", "2x2": " is-2x2"}[size]
    big = size == "2x2"
    link = html.escape(it.get("permalink") or "#")
    src = html.escape(it["src"] if big else it["thumb"])
    alt = html.escape(it["alt"])
    w, h = it.get("w", 720), it.get("h", 900)
    return (f'<a class="mag-item reveal{cls}" data-weedy-cat="{cat}"'
            f' href="{link}" target="_blank" rel="noopener">'
            f'<img src="{src}" width="{w}" height="{h}" alt="{alt}" loading="lazy" decoding="async"></a>')


def item_html_hidden(it, size):
    cat = it["category"]
    cls = {"1x1": "", "2x1": " is-2x1", "2x2": " is-2x2"}[size]
    big = size == "2x2"
    link = html.escape(it.get("permalink") or "#")
    src = html.escape(it["src"] if big else it["thumb"])
    alt = html.escape(it["alt"])
    w, h = it.get("w", 720), it.get("h", 900)
    return (f'<a class="mag-item reveal mag-hide{cls}" data-weedy-cat="{cat}"'
            f' href="{link}" target="_blank" rel="noopener">'
            f'<img src="{src}" width="{w}" height="{h}" alt="{alt}" loading="lazy" decoding="async"></a>')


def chapter_html(cat, cat_items):
    total = len(cat_items)
    seq, rows_d, rows_m, cut, seed_i, (n1, n21, n22) = pack_chapter(cat_items, cat)

    body_parts = []
    for idx, (it, size) in enumerate(zip(cat_items, seq)):
        if cut is not None and idx >= cut:
            body_parts.append(item_html_hidden(it, size))
        else:
            body_parts.append(item_html(it, size))
    body = "\n    ".join(body_parts)

    head = (f'<div class="mag-chapter-head reveal" id="chapter-{cat}">'
            f'<h3>{CAT_KO[cat]}</h3></div>')
    grid = (f'<div class="mag-frame"><div class="mag-grid" data-panel="{PANEL_KEY[cat]}" data-weedy-cat="{cat}">\n    {body}\n  </div></div>')
    more = ('' if cut is None else
            f'<div class="mag-more-wrap" data-more-for="{cat}"><button class="btn btn-outline btn-sm" type="button" data-more-btn="{cat}">더 보기</button></div>')
    print(f"  {cat}: {total} items (1x1={n1} 2x1={n21} 2x2={n22}), seed={seed_i}, "
          f"6-col rows={rows_d}, 4-col rows={rows_m}, holes=0, cut={cut}")
    return (f'<!-- weedy:chapter:{cat} -->\n  <div class="mag-chapter">\n  {head}\n  {grid}\n  {more}\n  </div>\n  <!-- /weedy:chapter:{cat} -->')


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--html", default="v7-magazine.html")
    ap.add_argument("--manifest", default="assets/weedy-manifest.json")
    a = ap.parse_args()

    items = json.load(open(a.manifest, encoding="utf-8"))
    by_cat = {c: [i for i in items if i["category"] == c] for c in CAT_ORDER}

    doc = open(a.html, encoding="utf-8").read()

    print("packing chapters (simple square-cell grid, CSS dense auto-flow does placement):")
    chapters_block = "\n\n  ".join(chapter_html(cat, by_cat[cat]) for cat in CAT_ORDER)
    wrapper = f'<!-- weedy:chapters -->\n  {chapters_block}\n  <!-- /weedy:chapters -->'

    chapters_re = re.compile(r'<!-- weedy:chapters -->.*?<!-- /weedy:chapters -->', re.S)
    assert chapters_re.search(doc), "could not locate <!-- weedy:chapters --> block"
    doc = chapters_re.sub(lambda m: wrapper, doc)

    count_total = len(items)
    doc = re.sub(r'게시물 \d+건', f'게시물 {count_total}건', doc)

    open(a.html, "w", encoding="utf-8").write(doc)
    print("baked chapters:", {c: len(v) for c, v in by_cat.items()}, "total", count_total)


if __name__ == "__main__":
    main()
