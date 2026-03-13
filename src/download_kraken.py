#!/usr/bin/env python3
"""
download_kraken.py
------------------
Downloads the complete Kraken OHLCVT ZIP from Google Drive and extracts
only the target pairs (ARB/USD, OP/USD, STRK/USD, ZK/USD) for all
available intervals.

Run: python3 src/download_kraken.py
"""

import os
import sys
import zipfile
import fnmatch
from pathlib import Path

# ── Config ────────────────────────────────────────────────────────────────────

GOOGLE_DRIVE_FILE_ID = "1ptNqWYidLkhb2VAKuLCxmp2OXEfGO-AP"

BASE_DIR   = Path(__file__).parent.parent          # project root
DATA_DIR   = BASE_DIR / "data"
RAW_DIR    = DATA_DIR / "raw"
ZIP_PATH   = DATA_DIR / "Kraken_OHLCVT.zip"

# Kraken internal pair names for the 4 target assets
TARGET_PAIRS = ["ARBUSD", "OPUSD", "STRKUSD", "ZKUSD"]

# Kraken publishes OHLCVT CSVs at these minute intervals
INTERVALS = [1, 5, 15, 60, 240, 1440, 10080, 21600]

# ── Helpers ───────────────────────────────────────────────────────────────────

def download_zip():
    """Download the Kraken OHLCVT ZIP via gdown (handles large GDrive files)."""
    try:
        import gdown
    except ImportError:
        sys.exit("❌  gdown is not installed. Run: pip3 install gdown")

    DATA_DIR.mkdir(parents=True, exist_ok=True)

    if ZIP_PATH.exists():
        size_mb = ZIP_PATH.stat().st_size / 1_048_576
        print(f"✅  ZIP already exists ({size_mb:.1f} MB): {ZIP_PATH}")
        ans = input("   Re-download? [y/N] ").strip().lower()
        if ans != "y":
            return
        ZIP_PATH.unlink()

    print(f"\n📥  Downloading Kraken_OHLCVT.zip from Google Drive …")
    print(f"    File ID: {GOOGLE_DRIVE_FILE_ID}")
    print(f"    Destination: {ZIP_PATH}\n")

    url = f"https://drive.google.com/uc?id={GOOGLE_DRIVE_FILE_ID}"
    gdown.download(url, str(ZIP_PATH), quiet=False, fuzzy=True)

    if not ZIP_PATH.exists():
        sys.exit("❌  Download failed — ZIP file not found after download attempt.")

    size_mb = ZIP_PATH.stat().st_size / 1_048_576
    print(f"\n✅  Download complete ({size_mb:.1f} MB)")


def extract_target_pairs():
    """
    Stream-extract only the files matching our target pairs from the ZIP.
    Kraken names files like:  ARBUSD_1.csv  ARBUSD_60.csv  etc.
    They may be at the root of the ZIP or inside a sub-folder.
    """
    RAW_DIR.mkdir(parents=True, exist_ok=True)

    # Build a set of filename patterns to look for
    patterns = set()
    for pair in TARGET_PAIRS:
        for interval in INTERVALS:
            patterns.add(f"{pair}_{interval}.csv")

    print(f"\n🔍  Scanning ZIP for {len(patterns)} target files …")
    print(f"    Pairs: {', '.join(TARGET_PAIRS)}")
    print(f"    Intervals (minutes): {INTERVALS}\n")

    extracted = []
    skipped   = []

    with zipfile.ZipFile(ZIP_PATH, "r") as zf:
        all_names = zf.namelist()
        print(f"    ZIP contains {len(all_names):,} files total")

        for name in all_names:
            basename = os.path.basename(name)
            if basename in patterns:
                dest = RAW_DIR / basename
                if dest.exists():
                    skipped.append(basename)
                    continue
                print(f"    ✔  Extracting: {basename}")
                with zf.open(name) as src, open(dest, "wb") as dst:
                    dst.write(src.read())
                extracted.append(basename)

    print(f"\n✅  Extracted {len(extracted)} file(s)  |  {len(skipped)} already existed")

    # Report what we found vs what was missing
    extracted_set  = set(extracted) | set(skipped)
    missing        = patterns - extracted_set
    if missing:
        print(f"\n⚠️   {len(missing)} expected file(s) not found in ZIP:")
        for m in sorted(missing):
            print(f"     - {m}")
    else:
        print("✅  All expected files found in ZIP.")


def show_summary():
    """Print a quick summary of what's in data/raw/."""
    files = sorted(RAW_DIR.glob("*.csv"))
    if not files:
        print("\n⚠️   No CSV files in data/raw/ yet.")
        return

    print(f"\n📂  data/raw/ — {len(files)} file(s):")
    by_pair = {}
    for f in files:
        stem = f.stem          # e.g. "ARBUSD_60"
        parts = stem.rsplit("_", 1)
        pair     = parts[0]
        interval = parts[1] if len(parts) == 2 else "?"
        by_pair.setdefault(pair, []).append(interval)

    for pair, intervals in sorted(by_pair.items()):
        intervals_sorted = sorted(intervals, key=lambda x: int(x) if x.isdigit() else 0)
        print(f"    {pair}: intervals [{', '.join(intervals_sorted)}] min")


# ── Main ──────────────────────────────────────────────────────────────────────

if __name__ == "__main__":
    print("=" * 60)
    print("  Kraken OHLCVT Downloader")
    print("  Pairs: ARB/USD  OP/USD  STRK/USD  ZK/USD")
    print("=" * 60)

    download_zip()
    extract_target_pairs()
    show_summary()

    print("\n🎯  Next step: run  python3 src/ingest.py  to load into SQLite\n")
