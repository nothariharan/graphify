"""Find and vendor the sigma/graphology browser bundles locally.

  python harness/fetch_libs.py            # list candidate files
  python harness/fetch_libs.py --get      # download the chosen ones into data/
"""
import io, json, os, re, sys, urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
LAB = os.path.dirname(HERE)
DATA = os.path.join(LAB, "data")
os.makedirs(DATA, exist_ok=True)

PKGS = {
    "sigma": "4.0.3",
    "graphology": "0.26.0",
}
WANT = {
    "sigma": "sigma.min.js",
    "graphology": "graphology.umd.min.js",
}


def get_json(url):
    req = urllib.request.Request(url, headers={"User-Agent": "graphify-perf-lab"})
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.loads(r.read().decode("utf-8", "replace"))


def get_bytes(url):
    req = urllib.request.Request(url, headers={"User-Agent": "graphify-perf-lab"})
    with urllib.request.urlopen(req, timeout=120) as r:
        return r.read()


def walk(node, prefix=""):
    out = []
    for f in node.get("files", []):
        p = prefix + f["path"]
        if f.get("type") == "directory":
            out += walk(f, p)
        else:
            out.append((p, f.get("size", 0)))
    return out


listing = {}
for name, ver in PKGS.items():
    url = f"https://unpkg.com/{name}@{ver}/?meta"
    try:
        meta = get_json(url)
        files = [p for p, size in walk(meta) if p.endswith(".js")]
        listing[name] = files
        print(f"== {name}@{ver}")
        for p in files:
            print("   ", p)
    except Exception as e:
        print(f"== {name}@{ver} ERROR {e}")

print()
if "--get" not in sys.argv:
    print("re-run with --get to download.")
    sys.exit(0)

for name, ver in PKGS.items():
    files = listing.get(name, [])
    target = WANT.get(name, "")
    pick = next((p for p in files if p.split("/")[-1] == target), None)
    if not pick:
        cands = [p for p in files if re.search(r"(umd|\.min\.js$|browser)", p)]
        pick = cands[0] if cands else (files[0] if files else None)
    if not pick:
        print(f"!! no file for {name}")
        continue
    url = f"https://unpkg.com/{name}@{ver}/" + pick.lstrip("/")
    dest = os.path.join(DATA, os.path.basename(pick))
    try:
        b = get_bytes(url)
    except Exception as e:
        print(f"!! {name} download failed from {url}: {e}")
        continue
    io.open(dest, "wb").write(b)
    print(f"downloaded {name:<32} {pick.lstrip('/'):<52} -> {os.path.basename(dest)}  {len(b)//1024} KB")
