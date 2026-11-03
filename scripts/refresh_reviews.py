#!/usr/bin/env python3
"""Weekly review refresh for the Windows server: replace the site's review gallery
and hero wall with the current Weedy best list, without ever exposing a half-built site.

Steps (all inside a staging dir under logs/, same volume as the live files):
  1. index.html baseline from git HEAD + existing assets/reviews as download cache
  2. weedy_reviews.py -> cache_reviews.py -> drop items without local images
  3. prune unreferenced .webp, bake_magazine.py, rebuild hero wall
  4. validate, then publish: new .webp -> manifests -> index.html -> delete old .webp
     (index.html flips last, so it never references a missing file)

--git-sync-only moves the checkout to origin/main (see sync_git); the batch file runs
it first as a separate process so the build always uses the freshly pulled scripts.

Usage:
  python3 scripts/refresh_reviews.py [--dry-run] [--min-items N]
  python3 scripts/refresh_reviews.py --git-sync-only
"""
import argparse, collections, filecmp, html, json, os, random, re, shutil, subprocess, sys, tempfile, time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SCRIPTS = ROOT / "scripts"
LOGS = ROOT / "logs"
INDEX = "index.html"
MANIFEST = "assets/weedy-manifest.json"
CLIENT = "assets/weedy-manifest.client.json"
REVIEWS = "assets/reviews"
GENERATED = [MANIFEST, CLIENT, INDEX]  # publish order: index.html must stay last
MIN_ITEMS = 40
STEP_TIMEOUT = 3600  # seconds per child step; a hung CDN must not hang the scheduled task
STALE_STAGING = 86400
GIT_TIMEOUTS = {"fetch": 300, "merge": 300}
GIT_TIMEOUT = 60
LOCK = LOGS / "refresh.lock"
LOCK_STALE = 7200
EXIT_LOCKED = 3

HERO_RE = re.compile(r'(<div class="hero-wall" id="heroWall" aria-hidden="true">)(.*?)(\n  </div>\n  <div class="hero-overlay")', re.S)
HERO_COL_RE = re.compile(r'<div class="hero-col (hero-col-(?:up|down))">')
JS_RE = re.compile(rb'<!-- weedy:js -->.*?<!-- /weedy:js -->', re.S)
REVIEW_REF_RE = re.compile(r'assets/reviews/[^"\'\s)]+')
TILES_PER_COL = 8


class RefreshError(Exception):
    pass


class RestoreError(RefreshError):
    """The git-sync snapshot could not be put back, so the live site may have changed."""


class LockHeld(Exception):
    pass


def log(msg):
    print(msg, flush=True)


# ----------------------------------------------------------------- helpers --

def git(*args):
    env = dict(os.environ, GIT_TERMINAL_PROMPT="0", GCM_INTERACTIVE="never")
    timeout = GIT_TIMEOUTS.get(args[0], GIT_TIMEOUT)
    # files, not pipes: after a timeout, a killed git's helper process could keep a pipe open and block us
    with tempfile.TemporaryFile() as out, tempfile.TemporaryFile() as err:
        try:
            p = subprocess.run(["git", *args], cwd=str(ROOT), env=env, stdin=subprocess.DEVNULL,
                               stdout=out, stderr=err, timeout=timeout)
        except subprocess.TimeoutExpired:
            raise RefreshError(f"git {args[0]} 시간 초과 ({timeout}초)")
        if p.returncode:
            err.seek(0)
            detail = " ".join(err.read().decode("utf-8", "replace").split())
            raise RefreshError(f"git {args[0]} 실패: {detail}")
        out.seek(0)
        return out.read()


def acquire_lock():
    """Create logs/refresh.lock exclusively and return its content; a lock older than LOCK_STALE is taken over."""
    LOGS.mkdir(exist_ok=True)
    token = f"{os.getpid()} {time.time()}"
    for _ in range(2):
        try:
            fd = os.open(str(LOCK), os.O_CREAT | os.O_EXCL | os.O_WRONLY)
        except FileExistsError:
            try:
                age = time.time() - LOCK.stat().st_mtime
                if age < LOCK_STALE:
                    raise LockHeld(f"다른 실행이 진행 중 ({LOCK.name}, {int(age // 60)}분 전 생성)")
                LOCK.unlink()
            except FileNotFoundError:  # the other run just released it
                pass
            continue
        with os.fdopen(fd, "w") as f:
            f.write(token)
        return token
    raise LockHeld(f"다른 실행과 동시에 잠금을 시도함 ({LOCK.name})")


def release_lock(token):
    try:
        if LOCK.read_text() == token:  # after a takeover the file belongs to the other run
            LOCK.unlink()
    except OSError as e:
        log(f"잠금 해제 실패: {e}")


def run_script(name, *args, cwd):
    env = dict(os.environ, PYTHONUTF8="1", PYTHONIOENCODING="utf-8")
    p = subprocess.run([sys.executable, str(SCRIPTS / name), *args], cwd=str(cwd), env=env,
                       stdout=subprocess.PIPE, stderr=subprocess.STDOUT, timeout=STEP_TIMEOUT)
    out = p.stdout.decode("utf-8", "replace")
    if p.returncode:
        print(out, file=sys.stderr, flush=True)
        raise RefreshError(f"{name} 실패 (exit {p.returncode})")
    return out


def new_staging(prefix=".refresh-staging-"):
    LOGS.mkdir(exist_ok=True)
    for old in LOGS.glob(".refresh-staging-*"):  # left behind by a killed run
        if time.time() - old.stat().st_mtime > STALE_STAGING:
            shutil.rmtree(old, ignore_errors=True)
    return Path(tempfile.mkdtemp(prefix=prefix, dir=str(LOGS)))


def webps(root):
    """Set of 'assets/reviews/...' paths of the .webp files under root."""
    out = set()
    for sub in (root / REVIEWS, root / REVIEWS / "t"):
        out.update(p.relative_to(root).as_posix() for p in sub.glob("*.webp"))
    return out


def replace_retry(src, dst):
    """os.replace; IIS can hold a served file open for a moment on Windows."""
    for attempt in range(5):
        try:
            os.replace(str(src), str(dst))
            return
        except PermissionError:
            if attempt == 4:
                raise
            time.sleep(1)


def publish(src_root):
    """Make the live generated files match src_root, consuming it. Rolls back if a swap fails.
    Returns (added, removed, kept_locked) .webp counts."""
    wanted, live = webps(src_root), webps(ROOT)
    backup = src_root / ".backup"
    # same name can mean different bytes when a merged commit added that path
    changed = [r for r in sorted(wanted) if r not in live or not filecmp.cmp(str(src_root / r), str(ROOT / r), shallow=False)]
    swapped = []
    try:
        (ROOT / REVIEWS / "t").mkdir(parents=True, exist_ok=True)
        for rel in changed + GENERATED:
            if (ROOT / rel).exists():
                (backup / rel).parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(str(ROOT / rel), str(backup / rel))
            replace_retry(src_root / rel, ROOT / rel)
            swapped.append(rel)
    except Exception:
        for rel in reversed(swapped):
            if (backup / rel).exists():
                replace_retry(backup / rel, ROOT / rel)
            else:
                (ROOT / rel).unlink()
        raise
    added = len(wanted - live)
    removed = locked = 0
    for rel in sorted(live - wanted):
        try:
            (ROOT / rel).unlink()
            removed += 1
        except OSError:  # harmless orphan, the next run prunes it
            locked += 1
    return added, removed, locked


# ---------------------------------------------------------------- git sync --

def sync_git():
    """Move the checkout to origin/main; generated files are left exactly as they were live.

    The refresh leaves index.html, the manifests and assets/reviews dirty, so a plain pull
    can refuse to run. They are reset for the fast-forward and then restored, so the live
    site shows the committed baseline only for the seconds the merge takes, and a failed
    refresh later on still leaves last week's gallery rather than the baseline. The build
    takes its index.html from HEAD, so new baseline changes go live with the next refresh.
    """
    git("fetch", "origin", "main")
    head = git("rev-parse", "HEAD").strip()
    target = git("rev-parse", "origin/main").strip()
    if head == target:
        log("코드 동기화: 이미 최신")
        return
    try:
        git("merge-base", "--is-ancestor", "HEAD", "origin/main")
    except RefreshError:  # stop before touching anything
        raise RefreshError("origin/main으로 fast-forward 불가 (서버에 로컬 커밋이 있거나 이력이 갈라짐)")

    snapshot = new_staging(".refresh-snapshot-")  # own prefix: stale staging cleanup must not remove it
    keep_snapshot = False
    try:
        for rel in GENERATED:
            (snapshot / rel).parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(str(ROOT / rel), str(snapshot / rel))
        shutil.copytree(str(ROOT / REVIEWS), str(snapshot / REVIEWS))
        try:
            git("checkout", "--", *GENERATED, REVIEWS)
            # untracked images from past refreshes would block a merge that adds the same path
            for name in git("ls-files", "--others", "-z", "--", REVIEWS).decode("utf-8").split("\0"):
                if name:
                    (ROOT / name).unlink()
            git("merge", "--ff-only", "origin/main")
        finally:
            work = new_staging()  # publish consumes its source; the snapshot stays whole for manual recovery
            try:
                shutil.copytree(str(snapshot), str(work), dirs_exist_ok=True)
                publish(work)
            except Exception as e:
                keep_snapshot = True
                raise RestoreError(f"스냅샷 복원 실패, 사이트가 바뀌었을 수 있음: {e}. README대로 수동 복구 필요: {snapshot}")
            finally:
                shutil.rmtree(work, ignore_errors=True)
    finally:
        if not keep_snapshot:
            shutil.rmtree(snapshot, ignore_errors=True)
    log(f"코드 동기화: {head.decode()[:7]} -> {target.decode()[:7]}")


# ------------------------------------------------------------------- build --

def write_json(path, data, **kw):
    with open(path, "w", encoding="utf-8", newline="\n") as f:
        json.dump(data, f, ensure_ascii=False, **kw)


def read_json(path):
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def keep_local_items(stage):
    """Drop items whose image did not download. cache_reviews.py builds paths with os.path.join,
    so on Windows they arrive with backslashes; turn them into URL paths first."""
    items, client = read_json(stage / MANIFEST), read_json(stage / CLIENT)
    if len(items) != len(client):
        raise RefreshError("manifest와 client manifest의 항목 수가 다름")
    kept, kept_client = [], []
    for it, slim in zip(items, client):
        for d in (it, slim):
            for k in ("src", "thumb"):
                if d.get(k):
                    d[k] = d[k].replace("\\", "/")
        if it["src"].startswith(REVIEWS + "/") and (it.get("thumb") or "").startswith(REVIEWS + "/"):
            kept.append(it)
            kept_client.append(slim)
    write_json(stage / MANIFEST, kept, indent=1)
    write_json(stage / CLIENT, kept_client, separators=(",", ":"))
    return kept, len(items) - len(kept)


def hero_html(doc, items):
    pool = [i for i in items if i["type"] == "image" and i.get("thumb")]
    if not pool:
        raise RefreshError("히어로 월에 쓸 이미지가 없음")
    random.seed(42)
    random.shuffle(pool)
    m = HERO_RE.search(doc)
    if not m:
        raise RefreshError("index.html에서 hero-wall 영역을 찾지 못함")
    out = ""
    for ci, cls in enumerate(HERO_COL_RE.findall(m.group(2))):
        tiles = [pool[(ci * TILES_PER_COL + k) % len(pool)] for k in range(TILES_PER_COL)]
        imgs = "\n      ".join(
            '<img src="{}" data-cat="{}" width="1080" height="1440" alt="" loading="lazy" decoding="async">'.format(
                html.escape(t["thumb"]), t["category"])
            for t in tiles * 2)
        out += f'\n    <div class="hero-col {cls}">\n      {imgs}\n    </div>'
    return doc[:m.start()] + m.group(1) + out + m.group(3) + doc[m.end():]


def validate(stage, baseline, items, min_items):
    if len(items) < min_items:
        raise RefreshError(f"리뷰 {len(items)}건으로 최소 {min_items}건 미달")
    referenced = {i[k] for i in items for k in ("src", "thumb")}
    on_disk = webps(stage)
    if referenced != on_disk:
        raise RefreshError(f"manifest와 webp 파일 불일치: 없음 {len(referenced - on_disk)}, 남음 {len(on_disk - referenced)}")

    data = (stage / INDEX).read_bytes()
    doc = data.decode("utf-8")
    missing = [r for r in set(REVIEW_REF_RE.findall(doc)) if not (stage / r).is_file()]
    if missing:
        raise RefreshError(f"index.html이 없는 파일 {len(missing)}개를 참조: {missing[0]}")
    tiles = doc.count('class="mag-item')
    if tiles != len(items):
        raise RefreshError(f"갤러리 타일 {tiles}개, manifest {len(items)}건으로 불일치")

    js_new, js_old = JS_RE.search(data), JS_RE.search(baseline)
    if not js_new or not js_old or js_new.group() != js_old.group():
        raise RefreshError("weedy:js 블록이 기준본과 달라짐")
    cols_new = HERO_COL_RE.findall(HERO_RE.search(doc).group(2))
    cols_old = HERO_COL_RE.findall(HERO_RE.search(baseline.decode("utf-8")).group(2))
    if not cols_new or cols_new != cols_old:
        raise RefreshError("히어로 월 열 구성이 기준본과 달라짐")


def build(stage, min_items):
    baseline = git("show", f"HEAD:{INDEX}")
    (stage / INDEX).write_bytes(baseline)
    (stage / "assets").mkdir()
    shutil.copytree(str(ROOT / REVIEWS), str(stage / REVIEWS))

    run_script("weedy_reviews.py", "-o", MANIFEST, cwd=stage)
    fetched = len(read_json(stage / MANIFEST))
    if fetched < min_items:  # before spending minutes on downloads
        raise RefreshError(f"위디 응답 {fetched}건으로 최소 {min_items}건 미달")
    run_script("cache_reviews.py", "--manifest", MANIFEST, "--out-dir", REVIEWS, cwd=stage)
    items, dropped = keep_local_items(stage)
    if len(items) < min_items:
        raise RefreshError(f"이미지 확보 {len(items)}건으로 최소 {min_items}건 미달")

    referenced = {i[k] for i in items for k in ("src", "thumb")}
    for rel in webps(stage) - referenced:
        (stage / rel).unlink()

    run_script("bake_magazine.py", "--html", INDEX, "--manifest", MANIFEST, cwd=stage)
    # bake_magazine writes in text mode, i.e. CRLF on Windows; keep the baseline's line endings
    doc = (stage / INDEX).read_bytes().replace(b"\r\n", b"\n").decode("utf-8")
    data = hero_html(doc, items).encode("utf-8")
    if b"\r\n" in baseline:
        data = data.replace(b"\n", b"\r\n")
    (stage / INDEX).write_bytes(data)

    validate(stage, baseline, items, min_items)
    return items, dropped


def refresh(dry_run, min_items):
    stage = new_staging()
    try:
        items, dropped = build(stage, min_items)
        cats = collections.Counter(i["category"] for i in items)
        counts = " ".join(f"{c}={n}" for c, n in sorted(cats.items()))
        summary = f"{len(items)}건 ({counts}), 이미지 없어 제외 {dropped}건"
        if dry_run:
            log(f"리뷰 갱신 dry-run 통과: {summary}, 사이트 변경 없음")
            return
        added, removed, locked = publish(stage)
        note = f", 삭제 보류 {locked}개" if locked else ""
        log(f"리뷰 갱신 완료: {summary}, 이미지 추가 {added}개·삭제 {removed}개{note}")
    finally:
        shutil.rmtree(stage, ignore_errors=True)


def main():
    for stream in (sys.stdout, sys.stderr):  # Task Scheduler log redirect would default to cp949
        stream.reconfigure(encoding="utf-8", errors="replace")
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true", help="build and validate in staging only")
    ap.add_argument("--min-items", type=int, default=MIN_ITEMS, help="abort below this many items")
    ap.add_argument("--git-sync-only", action="store_true", help="fast-forward to origin/main, keep generated files")
    a = ap.parse_args()
    try:
        token = acquire_lock()
        try:
            if a.git_sync_only:
                sync_git()
            else:
                refresh(a.dry_run, a.min_items)
        finally:
            release_lock(token)
    except LockHeld as e:
        log(f"리뷰 갱신 건너뜀: {e}")
        return EXIT_LOCKED
    except RestoreError as e:
        log(f"리뷰 갱신 실패: {e}")
        return 1
    except Exception as e:
        log(f"리뷰 갱신 실패: {e} (사이트는 이전 상태 유지)")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
