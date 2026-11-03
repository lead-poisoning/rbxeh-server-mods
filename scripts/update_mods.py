#!/usr/bin/env python3
"""Update the jars in mods/ and new_mods/ to the newest Modrinth builds that stay compatible.

How it works
  1. Hash every jar and ask Modrinth for the newest Fabric build for the target Minecraft version.
  2. Download the candidates and read each jar's fabric.mod.json (id, version, depends, breaks).
  3. Check the whole pack (current jars + candidates). If an update would break a dependency range,
     a `breaks` rule, or a Minecraft version pin, that update is rolled back and the check repeats
     until the pack is consistent.
  4. Replace the old jars in place (same folder, old file removed) and write a markdown report.

Standard library only. Needs network access to api.modrinth.com / cdn.modrinth.com
(true on GitHub Actions runners).

This checks declared metadata only. It cannot see mixin clashes at runtime, so boot the server
with the result before you merge.
"""
import argparse
import hashlib
import io
import json
import re
import shutil
import sys
import tempfile
import urllib.request
import zipfile
from pathlib import Path

API = "https://api.modrinth.com/v2"
UA = "rbxeh-server-mods-updater/1.0 (github.com/lead-poisoning/rbxeh-server-mods)"
FOLDERS = ("mods", "new_mods")
UNCHECKED = {"java", "fabricloader", "fabric-loader"}  # provided by the server, not by a jar
CHANNEL_RANK = {"release": 2, "beta": 1, "alpha": 0}


# --------------------------------------------------------------------------- versions
class Ver:
    """Fabric-style semantic version: build metadata ignored, trailing '-' = lowest pre-release."""

    def __init__(self, text):
        s = str(text).strip()
        low = s.endswith("-")
        if low:
            s = s[:-1]
        s = s.split("+", 1)[0]
        core, _, pre = s.partition("-")
        self.core = []
        for part in core.split("."):
            if part in ("x", "X", "*"):
                self.core.append(None)
            elif part.isdigit():
                self.core.append(int(part))
            else:
                raise ValueError(text)
        self.pre = [""] if low else (pre.split(".") if pre else [])


def _cmp_pre(a, b):
    if not a and not b:
        return 0
    if not a:
        return 1  # a release outranks any pre-release
    if not b:
        return -1
    for x, y in zip(a, b):
        if x == y:
            continue
        if x.isdigit() and y.isdigit():
            return -1 if int(x) < int(y) else 1
        if x.isdigit():
            return -1
        if y.isdigit():
            return 1
        return -1 if x < y else 1
    return (len(a) > len(b)) - (len(a) < len(b))


def cmp_ver(a, b):
    for i in range(max(len(a.core), len(b.core))):
        x = (a.core[i] if i < len(a.core) else 0) or 0
        y = (b.core[i] if i < len(b.core) else 0) or 0
        if x != y:
            return -1 if x < y else 1
    return _cmp_pre(a.pre, b.pre)


def _token_ok(ver, token):
    m = re.match(r"^(>=|<=|>|<|=|~|\^)?(.*)$", token)
    op, text = m.group(1), m.group(2)
    if text in ("", "*"):
        return True
    t = Ver(text)
    if None in t.core:  # wildcard such as 0.9.x or 26.2.x
        prefix = [c for c in t.core if c is not None]
        have = ver.core + [0] * (len(prefix) - len(ver.core))
        return have[: len(prefix)] == prefix
    c = cmp_ver(ver, t)
    if op in (None, "="):
        return c == 0
    if op == ">=":
        return c >= 0
    if op == ">":
        return c > 0
    if op == "<=":
        return c <= 0
    if op == "<":
        return c < 0
    upper = Ver("1")
    if op == "~" and len(t.core) >= 2:
        upper.core = [t.core[0], t.core[1] + 1]
    else:  # '^', or '~' with a single component
        upper.core = [t.core[0] + 1]
    upper.pre = [""]
    return c >= 0 and cmp_ver(ver, upper) < 0


def satisfies(version, rng):
    """True/False, or None when a version string is not parseable (treated as 'unknown')."""
    try:
        ver = Ver(version)
        alts = rng if isinstance(rng, list) else [rng]
        for alt in alts:
            for clause in str(alt).split("||"):
                tokens = re.findall(r"(?:>=|<=|>|<|=|~|\^)?\s*[^\s<>=~^]+", clause.strip())
                if all(_token_ok(ver, t.replace(" ", "")) for t in tokens):
                    return True
        return False
    except ValueError:
        return None


def highest(candidates):
    best = candidates[0]
    for cand in candidates[1:]:
        try:
            if cmp_ver(Ver(cand[1]), Ver(best[1])) > 0:
                best = cand
        except ValueError:
            pass
    return best


# --------------------------------------------------------------------------- jar metadata
def _load_json(raw):
    raw = re.sub(r",\s*([}\]])", r"\1", raw.decode("utf-8", errors="replace"))
    return json.loads(raw, strict=False)


def parse_jar(path, key):
    rec = {"_key": key, "file": Path(path).name}
    try:
        with zipfile.ZipFile(path) as z:
            if "fabric.mod.json" not in z.namelist():
                rec["error"] = "no fabric.mod.json"
                return rec
            data = _load_json(z.read("fabric.mod.json"))
            rec.update(
                id=data.get("id"),
                version=str(data.get("version", "")),
                provides=[p if isinstance(p, str) else p.get("id") for p in data.get("provides", [])],
                depends=data.get("depends", {}) or {},
                breaks=data.get("breaks", {}) or {},
                nested=[],
            )
            for name in z.namelist():
                if name.startswith("META-INF/jars/") and name.endswith(".jar"):
                    try:
                        with zipfile.ZipFile(io.BytesIO(z.read(name))) as nz:
                            if "fabric.mod.json" in nz.namelist():
                                nd = _load_json(nz.read("fabric.mod.json"))
                                rec["nested"].append((nd.get("id"), str(nd.get("version", ""))))
                    except Exception:
                        pass
    except Exception as exc:  # unreadable jar
        rec["error"] = f"{type(exc).__name__}: {exc}"
    return rec


# --------------------------------------------------------------------------- compatibility check
def check(records, mc):
    """Return violations for the pack. Each: kind, declarer (key), dep, rng, have, targets (keys)."""
    prov = {"minecraft": [(None, mc)]}
    for r in records:
        if not r.get("id"):
            continue
        prov.setdefault(r["id"], []).append((r["_key"], r["version"]))
        for alias in r.get("provides", []):
            prov.setdefault(alias, []).append((r["_key"], r["version"]))
        for nid, nver in r.get("nested", []):
            if nid:
                prov.setdefault(nid, []).append((r["_key"], nver))

    out = []
    for r in records:
        if not r.get("id"):
            continue
        for dep, rng in r["depends"].items():
            if dep in UNCHECKED:
                continue
            if dep not in prov:
                out.append(dict(kind="missing", declarer=r["_key"], dep=dep, rng=rng, have=None, targets=[]))
                continue
            _, have = highest(prov[dep])
            if satisfies(have, rng) is False:
                out.append(dict(kind="range", declarer=r["_key"], dep=dep, rng=rng, have=have,
                                targets=[k for k, _ in prov[dep] if k]))
        for dep, rng in r["breaks"].items():
            if dep in UNCHECKED or dep not in prov:
                continue
            _, have = highest(prov[dep])
            if satisfies(have, rng) is True:
                out.append(dict(kind="breaks", declarer=r["_key"], dep=dep, rng=rng, have=have,
                                targets=[k for k, _ in prov[dep] if k]))
    return out


def _sig(v):
    return (v["kind"], v["declarer"], v["dep"])


def _reason(v, new_version):
    rng = json.dumps(v["rng"]) if isinstance(v["rng"], (list, dict)) else v["rng"]
    if v["kind"] == "missing":
        return f"{new_version} needs {v['dep']}, which isn't in the pack"
    if v["kind"] == "breaks":
        return f"{new_version} declares it breaks {v['dep']} {rng} (pack has {v['have']})"
    return f"{new_version} needs {v['dep']} {rng} (pack has {v['have']})"


def resolve(old, new, mc):
    """old/new: {key: record}. Returns (chosen_keys, held_reasons). Rolls back updates that break the pack."""
    chosen = set(new)
    held = {}
    baseline = {_sig(v) for v in check(list(old.values()), mc)}
    while True:
        current = [new[k] if k in chosen else old[k] for k in old]
        violations = [v for v in check(current, mc) if _sig(v) not in baseline]
        revert = {}
        for v in violations:
            if v["declarer"] in chosen:
                revert.setdefault(v["declarer"], _reason(v, new[v["declarer"]]["version"]))
            else:
                for t in v["targets"]:
                    if t in chosen:
                        why = (f"{new[t]['version']} would leave {old[v['declarer']]['id']} "
                               f"({old[v['declarer']]['version']}) unable to run: "
                               f"it needs {v['dep']} {v['rng']}")
                        revert.setdefault(t, why)
        if not revert:
            return chosen, held
        for k, why in revert.items():
            chosen.discard(k)
            held[k] = why


# --------------------------------------------------------------------------- Modrinth
def _request(url, body=None):
    headers = {"User-Agent": UA}
    data = None
    if body is not None:
        data = json.dumps(body).encode()
        headers["Content-Type"] = "application/json"
    req = urllib.request.Request(url, data=data, headers=headers, method="POST" if body is not None else "GET")
    with urllib.request.urlopen(req, timeout=120) as resp:
        return resp.read()


def sha1_of(path):
    return hashlib.sha1(Path(path).read_bytes()).hexdigest()


def pick_file(version):
    files = version["files"]
    return next((f for f in files if f.get("primary")), files[0])


# --------------------------------------------------------------------------- main
def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--repo", default=".", help="repo root containing mods/ and new_mods/")
    ap.add_argument("--mc", default="26.2", help="Minecraft version to target")
    ap.add_argument("--loader", default="fabric")
    ap.add_argument("--report", default="update-report.md")
    ap.add_argument("--dry-run", action="store_true", help="report only, don't touch any jar")
    args = ap.parse_args()

    repo = Path(args.repo)
    jars = {}  # key (folder/filename) -> path
    for folder in FOLDERS:
        for p in sorted((repo / folder).glob("*.jar")):
            jars[f"{folder}/{p.name}"] = p
    if not jars:
        sys.exit("No jars found under mods/ or new_mods/")

    hashes = {k: sha1_of(p) for k, p in jars.items()}
    hash_list = sorted(set(hashes.values()))
    current = json.loads(_request(f"{API}/version_files", {"hashes": hash_list, "algorithm": "sha1"}))
    latest = json.loads(_request(f"{API}/version_files/update", {
        "hashes": hash_list, "algorithm": "sha1", "loaders": [args.loader], "game_versions": [args.mc]}))

    old, new, staged = {}, {}, {}
    notes = {"uptodate": [], "unknown": [], "skipped": []}  # skipped: (key, why)
    stage_dir = Path(tempfile.mkdtemp(prefix="mod-stage-"))
    info = {}  # key -> (current_version_obj, latest_version_obj)

    for key, path in jars.items():
        rec = parse_jar(path, key)
        old[key] = rec
        cur, lat = current.get(hashes[key]), latest.get(hashes[key])
        if cur is None:
            notes["unknown"].append(key)
            continue
        if rec.get("error") or not rec.get("id"):
            notes["skipped"].append((key, "can't read fabric.mod.json, so compatibility can't be verified"))
            continue
        if lat is None or lat["id"] == cur["id"] or lat["date_published"] <= cur["date_published"]:
            notes["uptodate"].append(key)
            continue
        if CHANNEL_RANK.get(lat["version_type"], 0) < CHANNEL_RANK.get(cur["version_type"], 0):
            notes["skipped"].append((key, f"newest 26.2 build ({lat['version_number']}) is a {lat['version_type']}, "
                                          f"current is a {cur['version_type']}"))
            continue
        f = pick_file(lat)
        dest = stage_dir / key.replace("/", "__")
        dest.mkdir()
        target = dest / f["filename"]
        target.write_bytes(_request(f["url"]))
        if sha1_of(target) != f["hashes"]["sha1"]:
            notes["skipped"].append((key, "download failed its checksum"))
            continue
        nrec = parse_jar(target, key)
        if nrec.get("error") or not nrec.get("id"):
            notes["skipped"].append((key, "new build has no readable fabric.mod.json"))
            continue
        new[key], staged[key], info[key] = nrec, target, (cur, lat)

    chosen, held = resolve(old, new, args.mc)
    for key, why in held.items():
        notes["skipped"].append((key, why))

    # ---- apply
    if not args.dry_run:
        for key in chosen:
            old_path = jars[key]
            shutil.copy2(staged[key], old_path.parent / staged[key].name)
            if old_path.name != staged[key].name:
                old_path.unlink()
    shutil.rmtree(stage_dir, ignore_errors=True)

    # ---- report
    lines = [f"# Mod update report (Minecraft {args.mc}, {args.loader})", ""]
    lines += [f"**{len(chosen)} updated**, {len(notes['skipped'])} held back, "
              f"{len(notes['uptodate'])} already current or no newer {args.mc} build, "
              f"{len(notes['unknown'])} not recognised by Modrinth.", ""]
    if chosen:
        lines += ["## Updated", "", "| Mod | From | To |", "|---|---|---|"]
        for key in sorted(chosen):
            cur, lat = info[key]
            lines.append(f"| {old[key]['id']} | {cur['version_number']} | {lat['version_number']} "
                         f"({lat['version_type']}) |")
        lines.append("")
    if notes["skipped"]:
        lines += ["## Held back (would break compatibility or not safe to auto-update)", ""]
        for key, why in sorted(notes["skipped"]):
            lines.append(f"- `{key}`: {why}")
        lines.append("")
    if notes["unknown"]:
        lines += ["## Not on Modrinth (left alone)", ""] + [f"- `{k}`" for k in sorted(notes["unknown"])] + [""]
    lines += ["---", "Checked: dependency ranges, `breaks` rules and the Minecraft version pin of every jar "
              "against the final set. Not checked: runtime mixin clashes. Start the server once before merging."]
    Path(args.report).write_text("\n".join(lines) + "\n")
    print("\n".join(lines))


if __name__ == "__main__":
    main()
