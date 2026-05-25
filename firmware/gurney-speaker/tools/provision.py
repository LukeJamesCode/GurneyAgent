#!/usr/bin/env python3
"""Generate an NVS partition image with the credentials the gurney-speaker
firmware needs.

Why this exists: ESP-IDF ships `nvs_partition_gen.py`, but it wants a CSV
input with the exact field names our firmware reads. This script keeps the
field names + types in one place so you can't accidentally provision the
wrong key.

Usage:
    python tools/provision.py \\
        --device-id puck-living-room \\
        --secret <value from gurney config gurney-speaker device_shared_secret> \\
        --server-url ws://192.168.1.42:7820/ \\
        --wifi-ssid MyWiFi \\
        --wifi-psk hunter2 \\
        --output nvs.bin

Then flash it onto the nvs partition:
    idf.py -p /dev/ttyUSB0 partition-table-flash
    parttool.py -p /dev/ttyUSB0 write_partition --partition-name nvs --input nvs.bin
"""

from __future__ import annotations

import argparse
import csv
import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

CSV_HEADER = ["key", "type", "encoding", "value"]


def build_csv_rows(args: argparse.Namespace) -> list[list[str]]:
    rows: list[list[str]] = [
        ["gurney_spk", "namespace", "", ""],
        ["dev.id", "data", "string", args.device_id],
        ["dev.secret", "data", "string", args.secret],
        ["srv.url", "data", "string", args.server_url],
        ["wifi.ssid", "data", "string", args.wifi_ssid],
        ["wifi.psk", "data", "string", args.wifi_psk],
    ]
    if args.wake_model:
        rows.append(["wake.model_id", "data", "string", args.wake_model])
    return rows


def find_nvs_gen() -> Path:
    """Find ESP-IDF's nvs_partition_gen.py on disk via $IDF_PATH."""
    idf = os.environ.get("IDF_PATH")
    if not idf:
        print(
            "error: IDF_PATH is not set. Run `. $IDF_PATH/export.sh` first.",
            file=sys.stderr,
        )
        sys.exit(2)
    candidate = Path(idf) / "components" / "nvs_flash" / "nvs_partition_generator" / "nvs_partition_gen.py"
    if not candidate.exists():
        print(f"error: nvs_partition_gen.py not found at {candidate}", file=sys.stderr)
        sys.exit(2)
    return candidate


def main() -> int:
    ap = argparse.ArgumentParser(description="Generate gurney-speaker NVS image")
    ap.add_argument("--device-id", required=True, help="Unique id for this puck (e.g. puck-living-room)")
    ap.add_argument("--secret", required=True, help="device_shared_secret from gurney-speaker setup")
    ap.add_argument("--server-url", required=True, help="WebSocket URL, e.g. ws://192.168.1.42:7820/")
    ap.add_argument("--wifi-ssid", required=True)
    ap.add_argument("--wifi-psk", required=True)
    ap.add_argument("--wake-model", default="wakenet9_hiesp",
                    help="WakeNet model id (default: wakenet9_hiesp)")
    ap.add_argument("--size", default="0x6000",
                    help="NVS partition size in bytes, must match partitions.csv (default 0x6000)")
    ap.add_argument("--output", default="nvs.bin", help="Output path for the partition image")
    args = ap.parse_args()

    rows = build_csv_rows(args)
    with tempfile.NamedTemporaryFile("w", suffix=".csv", delete=False, newline="") as tmp:
        writer = csv.writer(tmp)
        writer.writerow(CSV_HEADER)
        writer.writerows(rows)
        csv_path = Path(tmp.name)

    gen = find_nvs_gen()
    cmd = [sys.executable, str(gen), "generate", str(csv_path), args.output, args.size]
    print(f"running: {' '.join(cmd)}")
    result = subprocess.run(cmd)
    csv_path.unlink(missing_ok=True)
    if result.returncode != 0:
        print("error: nvs_partition_gen.py failed", file=sys.stderr)
        return result.returncode
    print(f"\nNVS image written to {args.output}")
    print(f"Flash with:\n  parttool.py -p <PORT> write_partition --partition-name nvs --input {args.output}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
