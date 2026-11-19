"""Build words/course.json (and optionally words/audio) from the Micro-Sprint Android sources.

Usage:
	python tools/build_course.py --src <path to micro-sprint-srs clone> [--copy-audio]

Reads:
	app/src/main/java/com/microsprint/srs/data/seed/SeedWords.kt   words, examples, categories
	app/src/main/assets/grammar.json                               topics + token analyses
	app/src/main/assets/audio/*.ogg                                pronunciation clips

Writes (relative to the plan-app root):
	words/course.json   compact course used by words/ui.js
	words/audio/        copied clips (only with --copy-audio)

Exit code 0 on success, 1 on any validation error (nothing is written then).
"""

import argparse
import json
import logging
import re
import shutil
import sys
from pathlib import Path

LOG = logging.getLogger("build_course")
ROOT = Path(__file__).resolve().parent.parent
SEED_REL = Path("app/src/main/java/com/microsprint/srs/data/seed/SeedWords.kt")
GRAMMAR_REL = Path("app/src/main/assets/grammar.json")
AUDIO_REL = Path("app/src/main/assets/audio")
COURSE_VERSION = 1


class KotlinReader:
	"""Sequential reader for the few Kotlin literals SeedWords.kt uses (Long, String, listOf)."""

	def __init__(self, text, pos):
		"""Start reading text at pos."""
		self.text = text
		self.pos = pos

	def skip(self):
		"""Skip whitespace, commas and line comments."""
		while self.pos < len(self.text):
			c = self.text[self.pos]
			if c in " \t\r\n,":
				self.pos += 1
			elif self.text.startswith("//", self.pos):
				self.pos = self.text.index("\n", self.pos)
			else:
				break

	def number(self):
		"""Read an integer literal (optional L suffix)."""
		self.skip()
		m = re.compile(r"(\d+)L?").match(self.text, self.pos)
		if not m:
			raise ValueError(f"number expected at {self.pos}")
		self.pos = m.end()
		return int(m.group(1))

	def string(self):
		"""Read a double-quoted Kotlin string with \\ escapes."""
		self.skip()
		if self.text[self.pos] != '"':
			raise ValueError(f"string expected at {self.pos}: {self.text[self.pos:self.pos + 30]!r}")
		self.pos += 1
		out = []
		escapes = {"n": "\n", "t": "\t", '"': '"', "'": "'", "\\": "\\", "$": "$"}
		while True:
			c = self.text[self.pos]
			if c == "\\":
				nxt = self.text[self.pos + 1]
				if nxt not in escapes:
					raise ValueError(f"unsupported escape \\{nxt} at {self.pos}")
				out.append(escapes[nxt])
				self.pos += 2
			elif c == '"':
				self.pos += 1
				return "".join(out)
			else:
				out.append(c)
				self.pos += 1

	def string_list(self):
		"""Read listOf("a", "b")."""
		self.skip()
		if not self.text.startswith("listOf(", self.pos):
			raise ValueError(f"listOf expected at {self.pos}")
		self.pos += len("listOf(")
		items = []
		while True:
			self.skip()
			if self.text[self.pos] == ")":
				self.pos += 1
				return items
			items.append(self.string())


def parse_seed_words(text):
	"""Return the list of SeedWord entries as dicts."""
	words = []
	for m in re.finditer(r"\bSeedWord\(\s*(?=\d)", text):
		r = KotlinReader(text, m.end())
		word = {
			"id": r.number(),
			"fi": r.string(),
			"tr": r.string_list(),
			"exFi": r.string(),
			"exUa": r.string(),
			"fp": r.string(),
			"fn": r.string(),
			"al": r.string(),
		}
		r.skip()
		if text[r.pos] != ")":
			raise ValueError(f"word {word['id']}: unexpected extra arguments")
		words.append(word)
	return words


def parse_categories(text):
	"""Return an ordered list of (matcher, category) rules from categoryFor()."""
	m = re.search(r"fun categoryFor\(id: Long\): String = when \(id\) \{(.*?)\n\}", text, re.S)
	if not m:
		raise ValueError("categoryFor() not found")
	rules = []
	default = None
	for line in m.group(1).splitlines():
		line = line.strip()
		if not line or line.startswith("//"):
			continue
		lhs, _, rhs = line.partition("->")
		cat = json.loads(rhs.strip())
		lhs = lhs.strip()
		if lhs == "else":
			default = cat
			continue
		ids, ranges = set(), []
		for part in lhs.split(","):
			part = part.strip()
			rm = re.fullmatch(r"in (\d+)L\.\.(\d+)L", part)
			if rm:
				ranges.append((int(rm.group(1)), int(rm.group(2))))
			elif re.fullmatch(r"\d+L", part):
				ids.add(int(part[:-1]))
			else:
				raise ValueError(f"unsupported categoryFor clause: {part!r}")
		rules.append((ids, ranges, cat))
	if default is None:
		raise ValueError("categoryFor() has no else branch")
	return rules, default


def category_for(word_id, rules, default):
	"""Evaluate categoryFor() rules in order (first match wins, like Kotlin when)."""
	for ids, ranges, cat in rules:
		if word_id in ids or any(a <= word_id <= b for a, b in ranges):
			return cat
	return default


def build(src, copy_audio):
	"""Read sources, validate, and write the course; returns a process exit code."""
	seed_path, grammar_path, audio_dir = src / SEED_REL, src / GRAMMAR_REL, src / AUDIO_REL
	for p in (seed_path, grammar_path, audio_dir):
		if not p.exists():
			LOG.error("Not found: %s (is --src a micro-sprint-srs clone?)", p)
			return 1

	seed_text = seed_path.read_text(encoding="utf-8")
	words = parse_seed_words(seed_text)
	rules, default_cat = parse_categories(seed_text)
	grammar = json.loads(grammar_path.read_text(encoding="utf-8"))
	analyses = {(e["wordId"], e["exampleIndex"]): e for e in grammar["examples"]}
	LOG.info("Parsed %d words, %d topics, %d analysed examples", len(words), len(grammar["topics"]), len(analyses))

	errors = []
	ids = [w["id"] for w in words]
	if len(ids) != len(set(ids)):
		errors.append("duplicate word ids")
	topic_ids = {t["id"] for t in grammar["topics"]}
	audio_names = {p.name for p in audio_dir.glob("*.ogg")}
	missing_audio = 0
	form_not_found = 0

	out_words = []
	for w in words:
		if not w["tr"]:
			errors.append(f"word {w['id']} has no translations")
		form = w["fp"].replace("+", "")
		if not any(tok.strip(".,!?;:«»\"'()–-") == form for tok in w["exFi"].split()):
			form_not_found += 1
		a = analyses.get((w["id"], 0), {})
		tokens = [{
			"i": t["index"], "l": t["lemma"], "ua": t.get("ua", ""), "n": t["note"],
			"p": t.get("parts", ""), "t": t.get("topicIds", []), "g": t.get("tags", []),
		} for t in a.get("tokens", [])]
		for t in tokens:
			unknown = [x for x in t["t"] if x not in topic_ids]
			if unknown:
				errors.append(f"word {w['id']}: unknown topics {unknown}")
		for name in (f"w{w['id']}.ogg", f"s{w['id']}_0.ogg"):
			if name not in audio_names:
				missing_audio += 1
		out_words.append({
			"id": w["id"], "fi": w["fi"], "tr": w["tr"],
			"cat": category_for(w["id"], rules, default_cat),
			"ex": [{
				"fi": w["exFi"], "ua": w["exUa"], "fp": w["fp"], "fn": w["fn"], "al": w["al"],
				"st": a.get("sentenceTopicIds", []), "tk": tokens,
			}],
		})

	if errors:
		for e in errors[:20]:
			LOG.error(e)
		LOG.error("%d validation errors, nothing written", len(errors))
		return 1
	if form_not_found:
		LOG.warning("%d examples where the form is not a whole token (highlight may be partial)", form_not_found)
	if missing_audio:
		LOG.warning("%d audio clips missing (playback is skipped for them)", missing_audio)

	topics = [{
		"id": t["id"], "title": t["title"], "note": t["note"],
		"section": t.get("section", ""), "level": t.get("level", ""),
		"table": [r.split("||", 1) for r in t.get("table", []) if "||" in r],
	} for t in grammar["topics"]]

	out_dir = ROOT / "words"
	out_dir.mkdir(exist_ok=True)
	course = {"v": COURSE_VERSION, "words": out_words, "topics": topics}
	out_path = out_dir / "course.json"
	out_path.write_text(json.dumps(course, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
	LOG.info("Wrote %s (%.1f KB)", out_path, out_path.stat().st_size / 1024)

	if copy_audio:
		dst = out_dir / "audio"
		dst.mkdir(exist_ok=True)
		copied = 0
		for name in sorted(audio_names):
			target = dst / name
			if not target.exists() or target.stat().st_size != (audio_dir / name).stat().st_size:
				shutil.copy2(audio_dir / name, target)
				copied += 1
		LOG.info("Audio: %d files copied, %d already up to date", copied, len(audio_names) - copied)
	return 0


def main():
	"""Parse arguments and run the build."""
	logging.basicConfig(level=logging.INFO, format="[%(levelname)s] %(message)s")
	ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
	ap.add_argument("--src", required=True, type=Path, help="path to a micro-sprint-srs clone")
	ap.add_argument("--copy-audio", action="store_true", help="also copy audio/*.ogg into words/audio")
	args = ap.parse_args()
	try:
		return build(args.src.resolve(), args.copy_audio)
	except (ValueError, OSError, json.JSONDecodeError) as err:
		LOG.error("Build failed: %s", err)
		return 1


if __name__ == "__main__":
	sys.exit(main())
