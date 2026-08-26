# Kotoba

Dual Japanese/English subtitles with romaji, hover dictionary lookup and Anki
export, on Crunchyroll. Chrome/Brave extension, Manifest V3, no build step.

Self-contained: the dictionary is prebuilt and included, so there is nothing to
compile and no Node required to use it.

    海 話って…                              Japanese, hoverable per word
    umi hanashi tte...                     romaji, pronunciation aid
    Umi? Talk about what?                  translation, blurred until hover

---

## Install

    brave://extensions  (or chrome://extensions)
      -> Developer mode on
      -> Load unpacked -> select this folder

After editing any file, press the reload icon on the extension card **and**
hard-refresh the Crunchyroll tab. The old content script is already injected in
the live page, so reloading the extension alone leaves an orphan behind. Orphans
detect the dead runtime and shut down quietly, but they do not come back to life.

## First run

1. Open an episode. Click the Kotoba icon, then **Diagnose**. You want one frame
   reporting `video yes`, `overlay built`, `fetch hook installed`. If nothing
   reports at all, the scripts are not running: reload and hard-refresh.
2. Paste your jimaku.cc API key (from <https://jimaku.cc/profile>) into
   **Keys and dictionary**.
3. Search the series title, pick a **WEB**-tagged file. It downloads and loads.
4. Click **Import JMdict** and pick `dict/dict-common.jsonl`. Romaji and hover
   lookup do nothing until this is done.
5. Check the sync line in the popup. It should say **in sync**. If not, press
   **S** on the page the instant you hear a line.

A healthy setup looks like this in Diagnose:

    jp / en      407 / 360 cues
    alignment    100% of English lines have a Japanese line
    render       ok
    offset       0.039s

## Keys

Press these on the page with the video visible and the popup closed. They are
handled by the content script, so they work on any platform.

| Key       | Action                                             |
| --------- | -------------------------------------------------- |
| `S`       | Snap the current line to now, and anchor the series |
| `Z` / `X` | Japanese 200ms earlier / later (Shift for 1s)       |
| `H`       | Hide or show the Japanese line                      |
| `I`       | Flip the overlay between top and bottom             |

They never fire while you are typing in a field, so Crunchyroll's search box is
unaffected.

Browser-level shortcuts also exist through `chrome.commands` (Alt+S, Alt+comma,
Alt+period). **On macOS, Alt is the Option key.** Treat them as secondary:
Chrome silently drops a suggested binding when another extension claims it, and
Option combos also emit special characters. Rebind at
`brave://extensions/shortcuts`. The popup has Snap and Align buttons too.

---

## How the pieces fit

**Crunchyroll has no Japanese subtitle track for most titles.** Their subtitle
assets are English translations, not transcriptions. So the English line comes
from the page and the Japanese line must come from outside. That asymmetry is
the whole architecture. Check `cr tracks` in Diagnose: if there is no `ja-JP`
entry, that is normal and permanent for that show, and it is why the jimaku path
exists. If `ja-JP` ever does appear it replaces the jimaku track and resets the
offset to zero, since a native track is timed against that exact encode.

**The player moved.** It used to live in an iframe on `static.crunchyroll.com`;
it now runs in a Bitmovin container in the top frame. The content script runs in
both and whichever finds a `<video>` with real dimensions does the work.

**Playback is DASH + Widevine.** Subtitle URLs live inside the
`/playback/v3/<id>/web/chrome/play` JSON, which the MAIN-world hook captures and
`findSubtitleTracks` walks. That JSON lists two things under the same locale
keys: `subtitles` (real `.ass` files, what you want) and `hardSubs` (video
manifests with the text burned in). Fetching a hardsub manifest as a subtitle
file returns 401, so `isSubtitleFile` filters them and Diagnose reports how many
were ignored.

**Crunchyroll episode changes do not reload the page.** It is a single-page app
that reuses the same `<video>` element, so watching element identity alone
silently keeps the previous episode's track. A URL watcher handles it and clears
all episode-scoped state, because stale dialogue rendering at plausible times is
harder to notice than nothing rendering.

**No ES modules anywhere.** Dynamic `import()` of a web-accessible module inside
a content script fails as an unhandled rejection when anything about the path,
CSP or extension reload is off, and the symptom is a silently dead extension.
Everything is classic scripts sharing a `Kotoba` namespace, loaded via the
manifest `js` array and `importScripts` in the service worker.

## Layout

    manifest.json
    src/main/hook.js          MAIN world: patches fetch/XHR, captures subtitle
                              assets and the playback config
    src/content/bridge.js     overlay, cue scheduling, hover lookup, sync keys
    src/content/overlay.css
    src/background/sw.js      dictionary, jimaku, romaji, storage, AnkiConnect
    src/lib/ns.js             shared namespace, logger, URL and title parsing
    src/lib/subtitle-parse.js ASS / SRT / VTT parsers, CC annotation stripping
    src/lib/cue-index.js      binary-searched cue index, snap, offset estimation
    src/lib/deinflect.js      rule-based deinflection
    src/lib/dict.js           IndexedDB JMdict store and longest-prefix lookup
    src/lib/romaji.js         kana to romaji, inflected reading reconstruction
    src/lib/jimaku.js         jimaku.cc client
    src/popup/                settings, jimaku browse, diagnostics
    tools/build-dict.mjs      JMdict -> compact JSONL
    dict/dict-common.jsonl    22,636 entries, 4MB   <- start here
    dict/dict-full.jsonl      218,577 entries, 33MB
    dict/LICENCE-JMdict.txt

---

## Sync

**Auto-alignment.** Once a Japanese track and Crunchyroll's translation track
both exist, the translation is a timing reference for this exact encode, so the
shift is estimated automatically. It only runs while the offset is still zero,
so it can never overwrite an anchor you set with `S`.

The estimate bins every pairwise delta between the two tracks and takes the
peak. The obvious method, matching each cue to its nearest neighbour and taking
the median, fails exactly when it matters: once the shift exceeds the gap
between cues, every cue's nearest neighbour is a different line and the deltas
collapse toward zero. A 12s shift on 5s-spaced dialogue estimates as roughly
nothing. Pairwise binning recovers shifts up to two minutes to within about
0.03s, and refuses when no clear peak exists, which stops a file from the wrong
episode being fitted to noise.

**Alignment percentage.** Diagnose and the popup report how many of
Crunchyroll's lines have a Japanese line at the same moment. Above 70% is
healthy. Below 50% means misaligned. Exactly 0% means something is broken rather
than merely out of sync, because a genuinely misaligned pair still overlaps
30-40% by chance.

**Snap** refuses to apply if the nearest cue is more than 12 seconds away.
Pressing it during a silent stretch would otherwise anchor to a line a minute
out and destroy a working offset. The threshold is `maxJump` in `cue-index.js`.

All of this corrects a constant shift only. A framerate mismatch needs
stretching and shows as drift growing across the episode; the fix is a different
file, ideally WEB-tagged rather than a BD or Netflix rip.

## Typography

Size, typeface, weight and a backdrop panel are in the popup. The size slider
updates the video live, because that is the only way to judge a subtitle size.

Size is pixels at a 1280px-wide player and scales with the actual player width,
so text keeps its proportion in a window, theatre mode and fullscreen alike.
Clamped to 11-72px.

Three faces, all resolving to real Japanese fonts on macOS rather than a Latin
face with substituted kanji, which is where mismatched stroke weights and
wandering baselines come from at subtitle sizes:

- **Gothic (sans)** — Hiragino Sans. Clearest at small sizes; the default.
- **Maru Gothic (rounded)** — softer, slightly wider.
- **Mincho (serif)** — elegant, but thin strokes suffer over busy frames.

The outline is a four-way stroke rather than a blur, because haze reads as fog
over bright scenes while an outline stays legible over anything. It is sized in
em so it stays proportional instead of becoming a slab at small sizes. If a
scene still defeats it, the dark panel option puts a translucent box behind the
whole block.

## Romaji

**Requires the dictionary**, because romanising 本当に means resolving 本当 to
ほんとう first. There is no morphological analyser, so segmentation reuses the
longest-prefix dictionary matching that powers hover lookup, and each chunk's
reading is reconstructed from the entry's headword and reading.

The reconstruction is the interesting part. Hovering 見つけて matches the entry
見つける / みつける, but the surface reads みつけて. Comparing headword against
reading gives a shared suffix つける; strip it from both and you learn 見 reads
み, then re-attach the actual tail for みつけて. That is `readingForSurface`.

It handles conjugation but not irregularity, so 来る is tabled explicitly: its
stem reads く, き or こ by form, and the generic algorithm renders 来て as
"kute" rather than "kite".

Expect roughly the right answer, not a perfect one. Ambiguous surfaces take the
better-ranked entry, and a kanji the dictionary cannot resolve passes through
unromanised so the gap is visible rather than silently wrong. Romaji is computed
in the background and cached, with the next four cues prefetched.

## Dictionary

Prebuilt from JMdict via jmdict-simplified. To rebuild:

    node --max-old-space-size=3000 tools/build-dict.mjs jmdict-eng.json out.jsonl [freq.txt]

Start with `dict-common.jsonl` (22,636 entries, 4MB). It covers essentially all
dialogue and imports in seconds. Use `dict-full.jsonl` (218,577 entries, 33MB)
only if you hit gaps.

No tokenizer: shipping kuromoji or MeCab costs 15-50MB before the first lookup,
so `deinflect.js` unwinds conjugation with a rule table and `dict.js` does
longest-prefix matching from the hovered character. That is Yomitan's approach.

**Ranking.** jmdict-simplified drops JMdict's nfXX frequency bands and keeps
only a boolean `common`, so there is no true frequency ordering available. The
build instead demotes senses tagged `arch` / `rare` / `hist` / `obs` and
reorders them last, which targets the actual failure (archaic glosses leading)
more precisely than a coarse frequency proxy. Pass a real frequency list as the
third argument and it overrides the derived weight.

**Kana headwords.** Entries tagged `uk` ("usually written in kana") display
their reading rather than their kanji, so ください shows as ください and not
下さい. The same tag breaks homophone ties: こと resolves to 事, not the zither 琴.

**Ambiguity is surfaced, not guessed.** 行った is the past of both 行く and 行う,
spelled identically, both common. No heuristic settles that honestly, so the
card lists alternates beneath the main entry; click one to promote it.

## Caption annotations

Netflix ja[cc] tracks, which is most of what jimaku hosts, are closed captions
rather than plain subtitles. They carry things that are not dialogue:

    （真樹）うんうん なるほどね      speaker label
    〔ドアが開く音〕                 sound cue
    ♪～                              music marker

Left in, a speaker label gets romanised as though it were words (真樹 segments
to 真 + 樹, "shin ki", when the name reads "Maki"), and hovering it returns a
dictionary entry for a kanji that means nothing in that context. `stripCC`
removes them. On by default, toggleable in the popup.

The length limits are deliberate. A genuine parenthetical inside dialogue is
usually longer than a name, so `これは（たぶん）普通の会話だよ` survives intact
while a leading `（真樹）` does not.

Name readings would otherwise need JMnedict, which is not loaded. Stripping the
labels removes the need.

## Anki

Install AnkiConnect, add your extension origin to its `webCorsOriginList`, and
restart Anki. Without this every add fails silently:

    "webCorsOriginList": ["http://localhost", "chrome-extension://YOUR_EXTENSION_ID"]

The ID is on the extension card.

Two card styles. **Sentence to meaning** is the default and the immersion
convention: the front shows the line with your target word bolded, the back
gives the word, reading, glosses, romaji and translation. You recall meaning
from context, which is closer to how you will meet the word again. **Word to
meaning** is the plainer alternative.

The target is bolded inside the sentence because a sentence card is otherwise
ambiguous: with several unfamiliar words on screen, the card cannot tell you
which one you were stuck on.

Cards are tagged `kotoba`, `crunchyroll` and the series name, so a mixed deck
stays filterable back to its source.

Cards are text-only: screenshot and audio mining return black frames and blocked
capture on DRM-protected playback, so do not build those before testing them.

---

## Known limits

- **jimaku endpoints are unverified.** `src/lib/jimaku.js` targets the shape
  every community client uses (bazarr's provider, jimaku-dl, the Emby plugin).
  The official docs block automated reading. Confirm with:

      curl -H "Authorization: $KEY" 'https://jimaku.cc/api/entries/search?query=frieren'
      curl -H "Authorization: $KEY" 'https://jimaku.cc/api/entries/1/files?episode=1'

  If the shape differs, three constants at the top of that file change. Search
  rejects queries containing a year; `cleanTitle` strips years plus season and
  episode noise. Rate limit is 25/min per key; the client self-limits to one
  call per 2.5s.

- **Series title comes from the DOM.** The URL slug is the *episode* title
  (`/watch/GMKUX2G9E/the-witch-and-the-bride`), so searching jimaku with it
  finds nothing. `detectPage()` scrapes the `/series/` link, then og:title, then
  document title. These selectors are the first thing to break on a redesign.

- **Fullscreen hides anything outside the fullscreen element.** Entering
  fullscreen renders only that element and its descendants; the rest of the
  document is not painted, `position: fixed` included. `ensureOverlayAttached`
  follows `document.fullscreenElement` and runs each frame, so the overlay also
  recovers if Crunchyroll's React tree removes the node.

- **Cue timings deserve a test, not a glance.** The SRT/VTT parser once split
  `00:00:12,300 --> 00:00:15,100` on `-->` then called `.split(/\s+/)[0]` on the
  second half. That half begins with a space, so the call returned an empty
  string and every end time parsed as 0. A cue with `end: 0` can never be
  active, so every SRT track was silently dead while `.ass` tracks worked fine.
  Nothing errored. If a track loads with a plausible cue count and shows
  nothing, check cue *spans* first.

- **The render loop must never be able to stop itself.** An exception that
  escapes before `requestAnimationFrame` freezes the overlay on whatever was
  last painted, with no error on screen. The body is wrapped and failures are
  counted into the `render` line in Diagnose.

- **The fetch hook depends on `window.fetch`.** If subtitle loading moves into a
  worker, the English line stops. The Japanese line is unaffected.

- **Deinflection is rules, not morphology.** It covers te/ta forms, polite,
  negative, passive, causative, potential, volitional, conditional, the common
  te-form auxiliaries, たい / すぎる / ながら, and i-adjectives. Rarer or heavily
  contracted colloquial forms will miss.

## Licences

**Extension code: GNU GPL v3 or later.** Full text in `LICENSE`. Every source
file carries an `SPDX-License-Identifier: GPL-3.0-or-later` tag and the FSF's
recommended notice.

Anyone may use, study, modify and redistribute this, but derivative works must
also be GPLv3 and must ship their source. If you publish a modified build to the
Chrome Web Store, the source has to be available to its users.

**Dictionary data: CC BY-SA 4.0.** The files under `dict/` are derived from
JMdict, property of the Electronic Dictionary Research and Development Group.
See `dict/LICENCE-JMdict.txt`. They stay under CC BY-SA 4.0; shipping them
alongside GPL code is mere aggregation and does not relicense either one.

## Legal note

This overlays subtitles on content you are already authenticated to watch. It
does not touch DRM and does not redistribute video, the same posture as
asbplayer and Language Reactor.