"""Convert the Micro-Sprint Android database into words.json (progress of the Words tab).

The phone database is copied first, read-only, with adb (the app must be a debug build):
	adb exec-out run-as com.microsprint.srs cat databases/micro-sprint.db     > micro-sprint.db
	adb exec-out run-as com.microsprint.srs cat databases/micro-sprint.db-wal > micro-sprint.db-wal
	adb exec-out run-as com.microsprint.srs cat databases/micro-sprint.db-shm > micro-sprint.db-shm

Usage:
	python tools/import_microsprint_db.py --db micro-sprint.db --out words.json --epoch 1 [--goal 5] [--deck 7]

The result has a higher `epoch` than the progress already in use, so every device REPLACES its
progress with it on the next sync instead of merging (see mergeProgress in words/core.js).
Exit code 0 on success, 1 on any error (nothing is written then).
"""

import argparse
import json
import logging
import sqlite3
import sys
import time
from pathlib import Path

LOG = logging.getLogger("import_microsprint_db")
STAGES = {"MICRO", "COOLING", "REVIEW", "KNOWN"}
COLUMNS = ["wordId", "stage", "microLevel", "intervalDays", "reviewDueAtMillis", "fsrsStability",
	"fsrsDifficulty", "lastReviewAtMillis", "graduatedAtMillis", "lapses"]


def read_cards(db_path):
	"""Read non-NEW card states from a copy of the database (the WAL next to it is applied)."""
	con = sqlite3.connect(db_path)
	try:
		if con.execute("PRAGMA integrity_check").fetchone()[0] != "ok":
			raise ValueError("database integrity check failed")
		cols = [r[1] for r in con.execute("PRAGMA table_info(card_states)")]
		missing = [c for c in COLUMNS if c not in cols]
		if missing:
			raise ValueError(f"card_states has no columns {missing} (unknown app version)")
		rows = con.execute(f"SELECT {', '.join(COLUMNS)} FROM card_states WHERE stage != 'NEW'").fetchall()
	finally:
		con.close()
	return [dict(zip(COLUMNS, r)) for r in rows]


def to_card(row, fallback_u):
	"""Map one Room row to the words.json card format."""
	if row["stage"] not in STAGES:
		raise ValueError(f"word {row['wordId']}: unknown stage {row['stage']}")
	stamps = [t for t in (row["lastReviewAtMillis"], row["graduatedAtMillis"]) if t]
	return {
		"st": row["stage"], "lv": int(row["microLevel"] or 0), "iv": int(row["intervalDays"] or 0),
		"due": row["reviewDueAtMillis"], "s": row["fsrsStability"], "d": row["fsrsDifficulty"],
		"last": row["lastReviewAtMillis"], "grad": row["graduatedAtMillis"],
		"lapses": int(row["lapses"] or 0), "u": max(stamps) if stamps else fallback_u,
	}


def main():
	"""Parse arguments, convert and write words.json."""
	logging.basicConfig(level=logging.INFO, format="[%(levelname)s] %(message)s")
	ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
	ap.add_argument("--db", required=True, type=Path, help="copied micro-sprint.db (with -wal/-shm next to it)")
	ap.add_argument("--out", required=True, type=Path, help="words.json to write")
	ap.add_argument("--epoch", required=True, type=int, help="must be higher than the epoch currently in words.json")
	ap.add_argument("--goal", type=int, default=40, help="daily goal (5..80)")
	ap.add_argument("--deck", type=int, default=5, help="words in work at once (3..12)")
	args = ap.parse_args()
	try:
		if not args.db.is_file():
			raise ValueError(f"not found: {args.db}")
		if args.epoch < 1 or not 5 <= args.goal <= 80 or not 3 <= args.deck <= 12:
			raise ValueError("epoch must be >= 1, goal 5..80, deck 3..12")
		fallback_u = int(args.db.stat().st_mtime * 1000)
		rows = read_cards(args.db)
		cards = {str(r["wordId"]): to_card(r, fallback_u) for r in sorted(rows, key=lambda r: r["wordId"])}
		now = int(time.time() * 1000)
		doc = {
			"v": 1, "epoch": args.epoch, "su": now,
			"settings": {"goal": args.goal, "deck": args.deck, "auto": False, "secs": 3, "habit": None, "introDone": True},
			"cards": cards,
		}
		# same layout as progressToText() in words/core.js: one card per line for readable diffs
		body =",\n".join(f'"{k}":{json.dumps(v, separators=(",", ":"))}' for k, v in cards.items())
		head = json.dumps({k: doc[k] for k in ("v", "epoch", "su", "settings")}, ensure_ascii=False, separators=(",", ":"))[:-1]
		args.out.write_text(head + ',"cards":{' + body + "}}", encoding="utf-8")
		json.loads(args.out.read_text(encoding="utf-8"))   # self-check
		counts = {}
		for c in cards.values():
			counts[c["st"]] = counts.get(c["st"], 0) + 1
		LOG.info("Wrote %s: %d cards %s, epoch %d", args.out, len(cards), counts, args.epoch)
		return 0
	except (ValueError, OSError, sqlite3.Error) as err:
		LOG.error("Import failed: %s", err)
		return 1


if __name__ == "__main__":
	sys.exit(main())
