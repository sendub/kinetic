#!/usr/bin/env python3
"""Generate fixtures/lang-demo: the Kinetic translations demo folder.

Usage (from the repo root, Pillow and jsonschema live in the repo venv):

    .venv/bin/python fixtures/build_lang_demo.py [--out DIR]

`--out` (default fixtures/lang-demo) is deleted and recreated; nothing
else is touched, and a folder holding any subfolder but `lang` is
refused. External tools: ffmpeg and ffprobe on PATH, as for
fixtures/build_demo.py.

The folder is fixtures/demo's tour (the same items, media and branches,
drawn and encoded by build_demo's `demo_manifest`) with its own
`storyId`, title and `version`, the base `language` "en", and three
language files (docs/plan.md Phase 56, item 1): German, Japanese and
Arabic, each with `lang/<tag>.json` and its `lang/<tag>.js`, a speaker
table, both decisions' prompts and route labels, the title and the
version. Two faults are deliberate, so the validator's translation
warnings have something to show and the player something to fall back
on:

- German has no translation of `floor-2` (a missing line: the player
  shows the base text);
- German's `text-thought` was made from an earlier wording of its base
  text, so its `from` does not match (a stale line: it still shows).

The output is deterministic: two runs produce byte-identical files.

After generating, the script checks the folder with
tools/validate_content.py and that every image is WIDTH x HEIGHT, as
the demo builder does, and fails on any unreachable item, audio,
voice, character or text tag warning, and on any translation warning
but the two above. It
exits 1 with one line per problem.
"""

from __future__ import annotations

import argparse
import shutil
import sys
from pathlib import Path

from build_demo import (REPO_ROOT, demo_manifest, folder_problems, report,
                        write_manifest)

import validate_content  # on sys.path through build_demo
from kinetic_extract import language_file  # put on sys.path by validate_content

LANG_DEMO_DIR = REPO_ROOT / "fixtures" / "lang-demo"
LANG = language_file.LANG_DIR

TITLE = "Kinetic language demo"
VERSION = "Episode 1"
LANGUAGES = ["de", "ja", "ar"]

# The deliberate faults: German lacks this item's line, and translated
# this one from the wording below, since changed in the base.
MISSING = ("de", "floor-2")
STALE = ("de", "text-thought",
         "A thought: unspoken, so it is drawn in a different style.")

NAMES = {"de": "Deutsch", "ja": "日本語", "ar": "العربية"}

META = {
    "de": {"title": "Kinetic-Sprachdemo", "version": "Folge 1"},
    "ja": {"title": "Kinetic 言語デモ", "version": "第1話"},
    "ar": {"title": "عرض Kinetic للغات", "version": "الحلقة 1"},
}

SPEAKERS = {
    "de": {"Mei": "Mei", "Theo": "Theo", "Ines": "Ines"},
    "ja": {"Mei": "メイ", "Theo": "テオ", "Ines": "イネス"},
    "ar": {"Mei": "مي", "Theo": "ثيو", "Ines": "إينيس"},
}

# Decision id -> (prompt, route id -> label), per language.
DECISIONS = {
    "de": {
        "nested": ("Verschachtelte Entscheidung in Route 1:",
                   {"nest-a": "1a: weiter mit Route 1",
                    "nest-b": "1b: zurück zu dieser Entscheidung"}),
        "outer": ("Demo-Entscheidung: Welche Route?",
                  {"route1": "Route 1: setzt die Geschichte fort",
                   "route2": "Route 2: ein Ende"}),
    },
    "ja": {
        "nested": ("ルート 1 の中の入れ子の選択肢：",
                   {"nest-a": "1a：ルート 1 を続ける",
                    "nest-b": "1b：この選択肢に戻る"}),
        "outer": ("デモの選択肢：どのルートにしますか？",
                  {"route1": "ルート 1：物語が続く",
                   "route2": "ルート 2：結末"}),
    },
    "ar": {
        "nested": ("اختيار متداخل داخل المسار 1:",
                   {"nest-a": "1أ: يواصل المسار 1",
                    "nest-b": "1ب: يعود إلى هذا الاختيار"}),
        "outer": ("اختيار العرض التوضيحي: أي مسار؟",
                  {"route1": "المسار 1: يواصل القصة",
                   "route2": "المسار 2: نهاية"}),
    },
}

# Item id -> its text, per language, for every demo item with text.
ITEMS = {
    "de": {
        "intro-title":
            "Kinetic-Demo. Jede Zeile erklärt, was Sie sehen. Die "
            "Leertaste zeigt das Nächste, das Mausrad blättert durch das "
            "Gelesene vor und zurück, Esc zeigt Tasten und Einstellungen.",
        "text-speech":
            "Gesprochener Dialog: Der Name der Sprecherin, Mei, steht "
            "darüber.",
        "text-thought":
            "Ein Gedanke: unausgesprochen, darum anders dargestellt.",
        "text-narration":
            "Erzählung hat keinen Namen. Mit h blenden Sie allen Text aus, "
            "ein weiteres h holt ihn zurück.",
        "anim-orbit":
            "Eine Animation: vier Bilder mit 8 pro Sekunde, zweimal "
            "gezeigt, dann bleibt das letzte stehen.",
        "video-chain":
            "Ein Video. Es wiederholt sich, solange diese und die nächsten "
            "zwei Zeilen gelesen werden.",
        "video-chain-2":
            "Zweite Zeile der Kette: Derselbe Clip läuft darunter weiter.",
        "video-chain-3":
            "Dritte Zeile, ein Gedanke. Scrollen Sie zurück zum Video, um "
            "sein Standbild zu sehen.",
        "chain-still-2":
            "Zeilen lassen sich auch über einem Standbild verketten.",
        "chain-still-3": "Ein Gedanke über demselben Standbild.",
        "video-loops": "Schleifenzahl 3: drei Durchläufe.",
        "video-hold":
            "Ein WebM-Clip, 4 s lang gezeigt, im Hintergrund in Schleife.",
        "range-a":
            "Eine Videodatei, erster Abschnitt: Sekunde 0 bis 1 (grün, "
            "dann violett).",
        "range-b":
            "Dieselbe Datei, Sekunde 1 bis 2, zweimal gezeigt. Die "
            "Wiederholung beginnt bei 1,5 s und überspringt so den "
            "rostroten Teil.",
        "look-dissolve":
            "Dieses Bild wurde in einer Sekunde über das vorige "
            "eingeblendet. Ein Übergang hält den Text nie auf.",
        "look-speaker":
            "Ines hat eigene Farben: eine für ihren Namen, eine für ihre "
            "Zeilen.",
        "look-tags":
            "Auch Ren'Py-Text-Tags funktionieren: {i}kursiv{/i} und "
            "{b}fett{/b}.",
        "look-fade":
            "Eine Abblende: Das letzte Bild wurde schwarz, das Schwarz "
            "hielt kurz, dann kam dieses.",
        "floor-title":
            "Als Nächstes: ein Clip mit 4,5 s Mindestspielzeit. Im "
            "Automodus laufen seine drei kurzen Zeilen schnell, dann "
            "wartet die letzte auf den Clip. Leertaste und Tab warten nie.",
        "floor-clip": "Kurze Zeile eins.",
        "floor-3": "Zeile drei wartet.",
        "branch-title":
            "Als Nächstes: eine Entscheidung. Route 1 führt die Geschichte "
            "fort und enthält eine weitere Entscheidung, Route 2 ist ein "
            "Ende. Danach können Sie eine andere Route wählen.",
        "branch-lead":
            "Gemeinsamer Auftakt: Jede Route beginnt danach. Die "
            "Entscheidung erscheint, wenn Sie hier die Leertaste drücken.",
        "route1-start":
            "Route 1, erste Zeile. Nach der nächsten Zeile erscheint eine "
            "verschachtelte Entscheidung.",
        "route1-nest":
            "Route 1, zweite Zeile: An ihr hängt die verschachtelte "
            "Entscheidung.",
        "nest-continue": "Verschachtelt 1a: Danach geht Route 1 weiter.",
        "nest-return":
            "Verschachtelt 1b: Danach wird die verschachtelte Entscheidung "
            "erneut angeboten.",
        "route1-end":
            "Wieder Route 1, nach der verschachtelten Entscheidung. Ihr "
            "Ende führt zum gemeinsamen Schlussteil.",
        "route2-start":
            "Route 2: ein eigener Weg, der nicht zur Geschichte "
            "zurückkehrt.",
        "route2-end":
            "Route 2 endet hier: Das ist ein Ende. Die Leertaste bietet die "
            "Routen erneut an.",
        "after-start":
            "Gemeinsamer Ausklang: erreicht, wenn Route 1 zu Ende ist. "
            "„Zurück zur Hauptroute“ springt hierher, sobald Route 1 "
            "fertig ist.",
        "after-end":
            "Ende. Probieren Sie auch: u für Ungesehenes, e zum Ende des "
            "Gelesenen, b und t für Lesezeichen, Esc für Tasten und "
            "Einstellungen, a für Auto-Play, Tab überspringt Gelesenes.",
    },
    "ja": {
        "intro-title":
            "Kinetic デモ。各行が、いま見ているものを説明します。Space で次の"
            "項目へ、マウスホイールで読んだ内容を前後にスクロールし、Esc で"
            "キーと設定を表示します。",
        "text-speech": "せりふ：話し手の名前「メイ」がその上に表示されます。",
        "text-thought": "心の声：口には出さないので、せりふとは違う見た目で表示されます。",
        "text-narration":
            "地の文には名前がありません。h ですべての文字を隠し、もう一度 h "
            "を押すと元に戻ります。",
        "anim-orbit":
            "アニメーション：4 枚の絵を毎秒 8 枚で 2 回表示し、最後の 1 枚で"
            "止まります。",
        "video-chain": "動画です。この行と次の 2 行を読む間、繰り返し再生されます。",
        "video-chain-2": "連なりの 2 行目：同じ動画が下で再生され続けます。",
        "video-chain-3": "3 行目は心の声。動画まで戻ると、その静止画が見られます。",
        "chain-still-2": "静止画の上でも行を連ねられます。",
        "chain-still-3": "同じ静止画の上の心の声。",
        "video-loops": "ループ回数 3：3 回再生します。",
        "video-hold": "WebM の動画を 4 秒表示し、背景で繰り返し再生します。",
        "range-a": "1 つの動画ファイルの最初の区間：0 秒から 1 秒（緑、次に紫）。",
        "range-b":
            "同じファイルの 1 秒から 2 秒を 2 回表示します。繰り返しは 1.5 秒"
            "から始まるので、さび色の部分は飛ばされます。",
        "look-dissolve":
            "この画像は1秒かけて前の画像に重なって現れました。切り替えが"
            "文章を待たせることはありません。",
        "look-speaker":
            "イネスには自分の色があります。名前に一色、台詞に一色。",
        "look-tags":
            "Ren'Py のテキストタグも使えます：{i}斜体{/i}と{b}太字{/b}。",
        "look-fade":
            "フェード：前の画像が黒くなり、黒が少し続いてから、この画像が"
            "現れました。",
        "floor-title":
            "次は最低再生時間 4.5 秒の動画です。自動モードでは短い 3 行がすぐ"
            "に進み、最後の行は動画の終わりを待ちます。Space と Tab は待ちま"
            "せん。",
        "floor-clip": "短い 1 行目。",
        "floor-2": "短い 2 行目。",
        "floor-3": "3 行目は待ちます。",
        "branch-title":
            "次は選択肢です。ルート 1 は物語の続きで、中に入れ子の選択肢があ"
            "ります。ルート 2 は結末です。ルートが終わったら、別のルートを選"
            "べます。",
        "branch-lead":
            "共通の導入：すべてのルートはこの後に始まります。ここで Space を"
            "押すと選択肢が開きます。",
        "route1-start": "ルート 1、1 行目。次の行のあとに入れ子の選択肢が開きます。",
        "route1-nest": "ルート 1、2 行目：入れ子の選択肢はこの行のあとに出ます。",
        "nest-continue": "入れ子 1a：終わるとルート 1 が続きます。",
        "nest-return": "入れ子 1b：終わると入れ子の選択肢がもう一度表示されます。",
        "route1-end":
            "入れ子の選択肢のあと、再びルート 1。その終わりは共通の結末へ続き"
            "ます。",
        "route2-start": "ルート 2：物語に戻らない別の道です。",
        "route2-end":
            "ルート 2 はここで終わります。これは結末です。Space でルートをも"
            "う一度選べます。",
        "after-start":
            "共通の後日談：ルート 1 を最後まで読むと到達します。ルート 1 を終"
            "えると「メインルートに戻る」でここへ移動します。",
        "after-end":
            "おしまい。ほかにも：u で未読の内容、e で読んだところの最後、b と"
            " t でブックマーク、Esc でキーと設定、a で自動再生、Tab で既読を"
            "スキップ。",
    },
    "ar": {
        "intro-title":
            "عرض Kinetic التوضيحي. كل سطر يشرح ما تراه. مفتاح Space يعرض "
            "العنصر التالي، وعجلة الفأرة تتنقل ذهابًا وإيابًا فيما قرأته، "
            "ومفتاح Esc يعرض المفاتيح والإعدادات.",
        "text-speech": "حوار منطوق: اسم المتحدثة، مي، يظهر فوقه.",
        "text-thought": "خاطرة: غير منطوقة، لذا تُعرض بشكل مختلف عن الكلام.",
        "text-narration":
            "السرد بلا اسم. اضغط h لإخفاء كل النصوص، واضغط h مرة أخرى "
            "لإظهارها.",
        "anim-orbit":
            "رسوم متحركة: أربع صور بمعدل 8 في الثانية، تُعرض مرتين ثم تتوقف "
            "عند الأخيرة.",
        "video-chain":
            "فيديو. يستمر في التكرار أثناء قراءة هذا السطر والسطرين "
            "التاليين.",
        "video-chain-2":
            "السطر الثاني في السلسلة: المقطع نفسه يستمر في العرض تحته.",
        "video-chain-3":
            "السطر الثالث، خاطرة. مرّر للخلف إلى الفيديو لترى صورته الثابتة.",
        "chain-still-2": "يمكن أيضًا أن تتتابع الأسطر فوق صورة ثابتة.",
        "chain-still-3": "خاطرة فوق الصورة الثابتة نفسها.",
        "video-loops": "عدد التكرارات 3: ثلاث مرات.",
        "video-hold": "مقطع WebM يُعرض 4 ثوانٍ ويتكرر في الخلفية.",
        "range-a":
            "ملف فيديو واحد، المقطع الأول: من الثانية 0 إلى 1 (أخضر ثم "
            "بنفسجي).",
        "range-b":
            "الملف نفسه، من الثانية 1 إلى 2، يُعرض مرتين. يبدأ التكرار من "
            "1.5 ثانية، فيتخطى الجزء الصدئ اللون.",
        "look-dissolve":
            "ظهرت هذه الصورة فوق السابقة تدريجيًا خلال ثانية واحدة. "
            "الانتقال لا يؤخر النص أبدًا.",
        "look-speaker":
            "لإينيس ألوانها الخاصة: لون لاسمها ولون لسطورها.",
        "look-tags":
            "وسوم نص Ren'Py تعمل أيضًا: {i}مائل{/i} و{b}عريض{/b}.",
        "look-fade":
            "تلاشٍ: اسودّت الصورة السابقة، وبقي السواد لحظة، ثم ظهرت "
            "هذه.",
        "floor-title":
            "التالي: مقطع بحد أدنى للعرض قدره 4.5 ثانية. في الوضع التلقائي "
            "تمر أسطره القصيرة الثلاثة بسرعة، ثم ينتظر الأخير انتهاء "
            "المقطع. مفتاحا Space وTab لا ينتظران أبدًا.",
        "floor-clip": "سطر قصير أول.",
        "floor-2": "سطر قصير ثانٍ.",
        "floor-3": "السطر الثالث ينتظر.",
        "branch-title":
            "التالي: اختيار. المسار 1 يواصل القصة ويضم اختيارًا متداخلًا، "
            "والمسار 2 نهاية. بعد انتهاء أي مسار يمكنك اختيار مسار آخر.",
        "branch-lead":
            "مقدمة مشتركة: كل المسارات تبدأ بعد هذا. يظهر الاختيار عندما "
            "تضغط Space هنا.",
        "route1-start":
            "المسار 1، السطر الأول. بعد السطر التالي يظهر اختيار متداخل.",
        "route1-nest":
            "المسار 1، السطر الثاني: الاختيار المتداخل مرتبط بهذا السطر.",
        "nest-continue": "المتداخل 1أ: عند انتهائه يستمر المسار 1.",
        "nest-return": "المتداخل 1ب: عند انتهائه يُعرض الاختيار المتداخل مرة أخرى.",
        "route1-end":
            "المسار 1 مجددًا، بعد الاختيار المتداخل. نهايته تقود إلى قسم "
            "الختام المشترك.",
        "route2-start": "المسار 2: طريق منفصل لا يعود إلى القصة.",
        "route2-end":
            "ينتهي المسار 2 هنا: هذه نهاية. يعرض مفتاح Space المسارات مرة "
            "أخرى.",
        "after-start":
            "خاتمة مشتركة: تصل إليها بإنهاء المسار 1. خيار «العودة إلى "
            "المسار الرئيسي» يقفز إلى هنا بعد إتمام المسار 1.",
        "after-end":
            "النهاية. جرّب أيضًا: u للمحتوى غير المقروء، وe لنهاية ما "
            "قرأته، وb وt للإشارات المرجعية، وEsc للمفاتيح والإعدادات، وa "
            "للتشغيل التلقائي، وTab لتخطي ما قرأته.",
    },
}


def translated(text: str, base: str) -> dict:
    """A translation of the base string `base`, with its hash."""
    return {"text": text, "from": language_file.base_hash(base)}


def language_data(tag: str, manifest: dict) -> dict:
    """The language file for `tag`, every string hashed against the
    manifest's base text, but for the deliberate faults."""
    texts = {item["id"]: item["text"] for item in manifest["items"]
             if item.get("text")}
    items: dict[str, dict] = {}
    for item_id, base in texts.items():
        if (tag, item_id) == MISSING:
            continue
        entry = translated(ITEMS[tag][item_id], base)
        if (tag, item_id) == STALE[:2]:
            entry["from"] = language_file.base_hash(STALE[2])
        items[item_id] = entry
    decisions: dict[str, dict] = {}
    for branch in manifest["branches"]:
        prompt, labels = DECISIONS[tag][branch["id"]]
        decisions[branch["id"]] = {
            "prompt": translated(prompt, branch["prompt"]),
            "routes": {route["id"]: translated(labels[route["id"]],
                                               route["label"])
                       for route in branch["routes"]},
        }
    return {
        "language": tag,
        "name": NAMES[tag],
        "title": translated(META[tag]["title"], manifest["title"]),
        "version": translated(META[tag]["version"], manifest["version"]),
        "speakers": SPEAKERS[tag],
        "items": items,
        "decisions": decisions,
    }


def expected_warnings() -> set[str]:
    """The translation warnings the deliberate faults cause, as
    (file: location) prefixes."""
    return {f"{language_file.json_path(MISSING[0])}: items.{MISSING[1]}",
            f"{language_file.json_path(STALE[0])}: items.{STALE[1]}.from"}


def warning_problems(manifest: dict, out: Path) -> list[str]:
    """Every validator warning but the expected translation warnings,
    and any expected one that is absent."""
    problems = (validate_content.reach_warnings(manifest)
                + validate_content.audio_warnings(manifest, out)
                + validate_content.voice_warnings(manifest)
                + validate_content.character_warnings(manifest)
                + validate_content.text_tag_warnings(manifest, out))
    translated_warnings, _coverage = validate_content.language_warnings(
        manifest, out)
    found: set[str] = set()
    for warning in translated_warnings:
        where = ": ".join(
            warning[len(validate_content.WARNING_PREFIX):].split(": ")[:2])
        if where in expected_warnings():
            found.add(where)
        else:
            problems.append(warning)
    problems += [f"expected a translation warning at {where}"
                 for where in sorted(expected_warnings() - found)]
    return problems


def reset_dir(out: Path) -> None:
    """Delete and recreate `out`. A build holds one subfolder, `lang`,
    with files only; a folder holding anything else is not a build:
    refuse to delete it."""
    if out.is_dir():
        foreign = [p for p in out.iterdir() if p.is_dir()
                   and (p.name != LANG
                        or any(q.is_dir() for q in p.iterdir()))]
        if foreign:
            sys.exit(f"{out}: holds {foreign[0].name}/, so it is not a "
                     "language demo build; not deleting it")
        shutil.rmtree(out)
    out.mkdir(parents=True)


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Generate the Kinetic translations demo folder.")
    parser.add_argument("--out", type=Path, default=LANG_DEMO_DIR,
                        help="folder to delete and recreate "
                             f"(default: {LANG_DEMO_DIR})")
    out = parser.parse_args().out
    reset_dir(out)

    demo = demo_manifest(out)
    manifest = {
        "schemaVersion": 1,
        "storyId": "kinetic-lang-demo",
        "title": TITLE,
        "version": VERSION,
        "language": "en",
        "languages": LANGUAGES,
        **{key: value for key, value in demo.items()
           if key not in ("schemaVersion", "storyId", "title")},
    }
    write_manifest(out, manifest)
    for tag in LANGUAGES:
        language_file.write_language_file(out, language_data(tag, manifest))
    report(out, folder_problems(out, manifest["items"])
           + warning_problems(manifest, out))


if __name__ == "__main__":
    main()
