import json, os, glob
src_dir = r"C:/Users/Administrator/agents/workbuddy/spaces/2026_11_14_14-27-03/research/qexo-src/hexoweb/libs/i18n/languages"
out_dir = r"C:/Users/Administrator/agents/workbuddy/spaces/2026_11_14_14-27-03/qexo-workers/src/ui/locales"
os.makedirs(out_dir, exist_ok=True)
for f in sorted(glob.glob(os.path.join(src_dir, "*.py"))):
    code = open(f, encoding="utf-8").read().replace("from ..core import Language", "")
    ns = {"Language": type("Language", (), {})}
    exec(compile(code, f, "exec"), ns)
    d = ns["Main"].default
    name = d["name"]
    with open(os.path.join(out_dir, name + ".json"), "w", encoding="utf-8") as fp:
        json.dump(d, fp, ensure_ascii=False, indent=1)
    print(name, len(d["data"]), "keys")
