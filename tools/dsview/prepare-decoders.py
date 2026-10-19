import re
import sys
from pathlib import Path

src = Path(sys.argv[1])
dst = Path(sys.argv[2])
dst.mkdir(parents=True, exist_ok=True)

for child in src.iterdir():
    if child.is_dir():
        target = dst / child.name
        target.mkdir(parents=True, exist_ok=True)
        for f in child.rglob("*"):
            if f.is_file():
                out = target / f.relative_to(child)
                out.parent.mkdir(parents=True, exist_ok=True)
                out.write_bytes(f.read_bytes())

# libsigrokdecode imports decoders by directory name, and the name has to
# match the id. DSView uses numeric prefixes for its stacking variants.
for old, new in (
    ("0-uart", "dsv0_uart"),
    ("1-uart", "dsv1_uart"),
    ("0-i2c", "dsv0_i2c"),
    ("1-i2c", "dsv1_i2c"),
    ("0-spi", "dsv0_spi"),
    ("1-spi", "dsv1_spi"),
):
    src_dir = dst / old
    if src_dir.is_dir():
        target = dst / new
        if target.exists():
            continue
        src_dir.rename(target)

ann = re.compile(
    r"^(\s*)\(\s*('(?:[^'\\]|\\.)*'|\"(?:[^\"\\]|\\.)*\")\s*,\s*"
    r"('(?:[^'\\]|\\.)*'|\"(?:[^\"\\]|\\.)*\")\s*,\s*"
    r"(?:'[^']*'|\"[^\"]*\"|\[[^\]]*\])\s*\)(,?)\s*$",
    re.M,
)

changed = 0
for f in dst.rglob("pd.py"):
    text = f.read_text(encoding="utf-8", errors="replace")
    orig = text
    text = re.sub(r",\s*'idn'\s*:\s*'[^']*'", "", text)
    text = re.sub(r',\s*"idn"\s*:\s*"[^"]*"', "", text)
    text = text.replace("id = '0:", "id = 'dsv0_").replace("id = '1:", "id = 'dsv1_")
    text = ann.sub(lambda m: f"{m.group(1)}({m.group(2)}, {m.group(3)}){m.group(4)}", text)
    if text != orig:
        with open(f, "w", encoding="utf-8", newline="\n") as fh:
            fh.write(text)
        changed += 1

# DSView's libsigrokdecode4DSL exposes self.matched as an int bitmask.
# Upstream libsigrokdecode exposes a tuple of per-channel bools. Convert on
# every read so the DSView decoder expressions keep their original meaning.
helper = dst / "common" / "kdock_dsv.py"
helper.parent.mkdir(parents=True, exist_ok=True)
helper.write_text(
    "def kd_matched(decoder):\n"
    "    value = decoder.matched\n"
    "    if isinstance(value, int):\n"
    "        return value\n"
    "    return sum(1 << i for i, bit in enumerate(value) if bit)\n",
    encoding="utf-8",
)

patched = 0
for f in dst.rglob("pd.py"):
    text = f.read_text(encoding="utf-8", errors="replace")
    if "self.matched" not in text:
        continue
    text = text.replace("self.matched", "kd_matched(self)")
    if "from common.kdock_dsv import kd_matched" not in text:
        text = "from common.kdock_dsv import kd_matched\n\n" + text
    with open(f, "w", encoding="utf-8", newline="\n") as fh:
        fh.write(text)
    patched += 1

print(f"adapted {changed} decoder files, matched shim in {patched}")
