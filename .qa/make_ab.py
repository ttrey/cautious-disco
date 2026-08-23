#!/usr/bin/env python3
"""Build a blind A/B comparison page for the hostile visual critic.

Usage: python3 .qa/make_ab.py <candidate.png> <out.html> [caption]
Randomizes which side (A/B) holds the reference. The mapping is written to
<out.html>.map.json so the verdict can be revealed AFTER the critic commits.
The critic must never see this file's source before voting.
"""
import json
import random
import sys
from pathlib import Path

root = Path(__file__).resolve().parent.parent
candidate = Path(sys.argv[1]).resolve()
out = Path(sys.argv[2]).resolve()
caption = sys.argv[3] if len(sys.argv) > 3 else "FIRST-PERSON STREET VIEW"

ref_rel = ".qa/reference_csgo_street.png"
cand_rel = str(candidate.relative_to(root))

left_is_ref = random.random() < 0.5
a_src, b_src = (ref_rel, cand_rel) if left_is_ref else (cand_rel, ref_rel)
(out.parent / (out.name + ".map.json")).write_text(json.dumps({
    "A": "reference" if left_is_ref else "candidate",
    "B": "candidate" if left_is_ref else "reference",
    "candidate": cand_rel,
}))

html = f"""<!doctype html><html><head><meta charset="utf-8"><style>
body{{margin:0;background:#101214;color:#e8e8e4;font-family:-apple-system,sans-serif}}
.wrap{{max-width:1500px;margin:0 auto;padding:18px}}
h1{{font-size:15px;letter-spacing:.14em;font-weight:600;opacity:.85;margin:0 0 12px}}
.grid{{display:grid;grid-template-columns:1fr 1fr;gap:14px}}
figure{{margin:0;border:1px solid #333;border-radius:6px;overflow:hidden;background:#000}}
figcaption{{padding:8px 12px;font-size:12px;letter-spacing:.22em;color:#9aa;font-weight:700}}
img{{width:100%;display:block}}
.note{{margin-top:12px;font-size:12px;opacity:.55;line-height:1.5}}
</style></head><body><div class="wrap">
<h1>BLIND COMPARISON — {caption}</h1>
<div class="grid">
<figure><figcaption>IMAGE A</figcaption><img src="../../{a_src}"></figure>
<figure><figcaption>IMAGE B</figcaption><img src="../../{b_src}"></figure>
</div>
<p class="note">Two screenshots of the same kind of scene, produced by different teams.
Vote honestly: which one looks like a real shipped AAA game?</p>
</div></body></html>"""
out.write_text(html)
print(f"wrote {out}\nmap: A={'REF' if left_is_ref else 'CAND'} B={'CAND' if left_is_ref else 'REF'}")
