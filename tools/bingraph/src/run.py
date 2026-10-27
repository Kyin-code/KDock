"""Portable entry point bundled with KDock."""
from __future__ import annotations

import os
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
PKG = HERE / "site-packages"
LAUNCHER = HERE / "launcher"
sys.path.insert(0, str(PKG))
sys.path.insert(0, str(LAUNCHER))
gv = HERE / "graphviz" / "bin"
if gv.is_dir():
    os.environ.setdefault("BINGRAPH_NATIVE_GRAPHVIZ", str(gv))

from bingraph_native.launcher import main  # noqa: E402

if __name__ == "__main__":
    main()
