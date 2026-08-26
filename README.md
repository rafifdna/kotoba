# Kotoba 0.3.0

Dual Japanese/English subtitles with hover dictionary lookup and Anki export,
on Crunchyroll. Chrome/Brave extension, Manifest V3, no build step.

Self-contained: the dictionary is prebuilt and included, so there is nothing to
compile and no Node required to use it.

## Install

    brave://extensions  (or chrome://extensions)
      -> Developer mode on
      -> Load unpacked -> select this folder

After editing any file, press the reload icon on the extension card AND
hard-refresh the Crunchyroll tab. The old content script is already injected in
the live page; reloading the extension alone leaves an orphan behind.

## First run

1. Open an episode. Click the Kotoba icon, then **Diagnose**.
   You want one frame reporting `video yes`, `overlay built`,
   `fetch hook installed`. If nothing reports, the scripts are not running:
   reload the extension and hard-refresh.
2. Paste your jimaku.cc API key (from https://jimaku.cc/profile) into the
   "Keys and dictionary" section.
3. Search the series title, pick a **WEB**-tagged file, and it downloads.
4. Press **Alt+S** the instant you hear a line. That anchors the whole series;
   episodes 2..N inherit the offset.
5. Click **Import JMdict** in the popup and pick `dict/dict-common.jsonl`.
   It ships prebuilt; there is no build step and no Node required.

## How the pieces fit

**Crunchyroll has no Japanese subtitle track for most titles.** Their subtitle
assets are English translations. So the English line (if obtainable) comes from
the page, and the Japanese line has to come from outside. That asymmetry is the
whole architecture.

**The player has moved.** It used to live in an iframe on
`static.crunchyroll.com`; it now runs in a Bitmovin container in the top frame.
Rather than encode either assumption, the content script runs in both frames and
whichever finds a `<video>` with real dimensions does the work.

**Playback is DASH + Widevine.** The player fetches
`/playback/v2/manifest/<id>/.../<locale>/dash/manifest.mpd` and a Widevine
licence. Subtitle track URLs live inside the `/playback/v3/<id>/web/chrome/play`
JSON, which the MAIN-world hook captures and `findSubtitleTracks` walks.

That JSON lists two different things keyed by the same locale codes:

- `subtitles` - real `.ass` files. These are what you want.
- `hardSubs`  - video manifests with the subtitles burned in. Fetching one of
  these as if it were a subtitle file returns 401. `isSubtitleFile` filters them
  out, and Diagnose reports how many were ignored.

Check the `cr tracks` line in Diagnose to see what a title actually offers. For
most anime there is **no `ja-JP` entry**, because Crunchyroll ships translations
rather than transcriptions. That is not a bug and no amount of fixing changes
it; it is why the jimaku path exists. If `ja-JP` ever does appear, it replaces
the jimaku track and resets the offset to zero, since a native track is timed
against that exact encode.

If the whole list is hardsubs with no subtitle files at all, the English line is
not obtainable. Uncheck "English line" and set Position to **Top** so your
Japanese sits clear of Crunchyroll's burned-in text.

**No ES modules anywhere.** Dynamic `import()` of web-accessible modules inside a
content script fails as an unhandled rejection when anything about the path, CSP
or extension reload is off, and the symptom is a silently dead extension.
Everything is classic scripts sharing a `Kotoba` namespace, loaded via the
manifest `js` array and `importScripts` in the service worker.

## Layout

    manifest.json
    src/main/hook.js          MAIN world: patches fetch/XHR, captures subtitle
                              assets and the playback config
    src/content/bridge.js     overlay, cue scheduling, hover lookup, sync keys
    src/content/overlay.css
    src/background/sw.js      dictionary, jimaku, storage, AnkiConnect
    src/lib/ns.js             shared namespace, logger, URL and title parsing
    src/lib/subtitle-parse.js ASS / SRT / VTT parsers
    src/lib/cue-index.js      binary-searched cue index, snap-sync
    src/lib/deinflect.js      rule-based deinflection
    src/lib/dict.js           IndexedDB JMdict store and longest-prefix lookup
    src/lib/jimaku.js         jimaku.cc client
    src/popup/                settings, jimaku browse, diagnostics
    tools/build-dict.mjs      JMdict -> compact JSONL
    dict/dict-common.jsonl    22,636 entries, 4MB   <- start here
    dict/dict-full.jsonl      218,577 entries, 33MB
    dict/LICENCE-JMdict.txt

## Keys

Press these on the page with the video visible and the popup closed. They are
handled by the content script, so they work regardless of platform.

| Key       | Action                                                  |
| --------- | ------------------------------------------------------- |
| `S`       | Snap the current line to now, and anchor the series      |
| `Z` / `X` | Japanese 200ms earlier / later (hold Shift for 1s)       |
| `H`       | Hide or show the Japanese line                           |
| `I`       | Flip the overlay between top and bottom                  |

They never fire while you are typing in a field, so Crunchyroll's own search box
is unaffected.

There are also browser-level shortcuts (Alt+S, Alt+comma, Alt+period) registered
through `chrome.commands`. **On macOS, Alt is the Option key**, so those read as
Option+S and so on. Treat them as a secondary path: Chrome silently drops a
suggested binding when another extension already claims it, and Option combos on
macOS also emit special characters. Check and rebind at
`brave://extensions/shortcuts`. The popup also has a Snap button if you would
rather click.

**Auto-alignment.** Once a Japanese track and Crunchyroll's own translation
track both exist, the translation is a timing reference for this exact encode,
so the shift is estimated automatically. It only runs while the offset is still
zero, so it can never overwrite an anchor you set with S.

The estimate bins every pairwise delta between the two tracks and takes the peak.
The obvious method, matching each cue to its nearest neighbour and taking the
median, fails exactly when it matters: once the shift exceeds the gap between
cues, every cue's nearest neighbour is a different line and the deltas collapse
toward zero. A 12s shift on 5s-spaced dialogue estimates as roughly nothing.
Pairwise binning recovers shifts up to two minutes to within about 0.03s, and
refuses to align at all when no clear peak exists, which is what stops a file
from the wrong episode being fitted to noise.

Diagnose reports an `alignment` percentage: how many of Crunchyroll's lines have
a Japanese line at the same moment. Above 70% is healthy. Near zero means
misaligned or the wrong episode's file.

Snap refuses to apply if the nearest cue is more than 12 seconds away. Pressing
it during a silent stretch would otherwise anchor to a line a minute out and
destroy a working offset. The threshold is `maxJump` in `cue-index.js`.

## Typography

Size, typeface, weight and a backdrop panel are all in the popup, and the size
slider updates the video live because that is the only way to judge a subtitle
size.

Size is expressed as pixels at a 1280px-wide player and scales with the actual
player width, so the text keeps its proportion in a small window, theatre mode
and fullscreen alike. It is clamped to 11-72px so it stays legible on a tiny
player and does not become absurd on a 4K one.

Three faces, all of which resolve to real Japanese fonts on macOS rather than a
Latin face with substituted kanji, which is where mismatched stroke weights and
wandering baselines come from at subtitle sizes:

- **Gothic (sans)** - Hiragino Sans. Clearest at small sizes; the default.
- **Maru Gothic (rounded)** - softer, slightly wider.
- **Mincho (serif)** - elegant, but thin strokes suffer over busy frames.

The outline is a four-way stroke rather than a blur, because haze reads as fog
over bright scenes while an outline stays legible over anything. It is sized in
em so it stays proportional instead of turning into a slab at small sizes. If a
scene still defeats it, the dark panel option puts a translucent box behind the
whole block.

## The three subtitle lines

    本当に見つけてしまうだなんて      <- Japanese, hoverable per word
    hontouni mitsuketeshimau danante  <- romaji, pronunciation aid
    I can't believe we really found them.   <- translation, blurred until hover

Each is toggleable in the popup. The English line is blurred by default so you
attempt the Japanese first; that is the whole point of a dual-sub tool.

**Romaji requires the dictionary**, because romanising 本当に means resolving 本当
to ほんとう first. There is no morphological analyser here, so segmentation
reuses the same longest-prefix dictionary matching that powers hover lookup, and
each chunk's reading is reconstructed from the entry's headword and reading.

The reconstruction is the interesting part. Hovering 見つけて matches the entry
見つける / みつける, but the surface reads みつけて. Comparing headword and reading
gives a shared suffix つける; strip it from both and you learn 見 reads み, then
re-attach the actual surface tail for みつけて. That is `readingForSurface`.

It handles conjugation but not irregularity, so 来る is tabled explicitly: its
stem reads く, き or こ by form, and the generic algorithm would render 来て as
"kute" rather than "kite".

Expect roughly the right answer, not a perfect one. Where a surface is genuinely
ambiguous the better-ranked entry wins, and a kanji the dictionary cannot resolve
is passed through unromanised so the gap is visible rather than silently wrong.

Romaji is computed in the background and cached, with the next four cues
prefetched while the current one is on screen, so the lag is not visible during
normal playback.

## Dictionary

Prebuilt from JMdict via jmdict-simplified 3.6.2 (2026-08-24). To rebuild:

    node --max-old-space-size=3000 tools/build-dict.mjs jmdict-eng.json out.jsonl [freq.txt]

There is no tokenizer. Shipping kuromoji or MeCab costs 15-50MB before the first
lookup, so `deinflect.js` unwinds conjugation with a rule table and `dict.js`
does longest-prefix matching from the hovered character. That is Yomitan's
approach.

**Ranking.** jmdict-simplified drops JMdict's nfXX frequency bands and keeps only
a boolean `common`, so there is no true frequency ordering available. The build
instead demotes senses tagged `arch` / `rare` / `hist` / `obs` and reorders them
last, which targets the actual failure (archaic glosses leading) more precisely
than a coarse frequency proxy. Pass a real frequency list as the third argument
and it overrides the derived weight.

**Kana headwords.** Entries tagged `uk` ("usually written in kana") display their
reading rather than their kanji, so ください shows as ください and not 下さい. The
same tag breaks homophone ties: こと resolves to 事, not the zither 琴.

**Ambiguity is surfaced, not guessed.** 行った is the past of both 行く and 行う,
spelled identically, both common. No heuristic settles that honestly, so the card
lists alternates beneath the main entry; click one to promote it.

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

## Caption annotations

Netflix ja[cc] tracks, which is most of what jimaku hosts, are closed captions
rather than plain subtitles. They carry things that are not dialogue:

    （真樹）うんうん なるほどね      <- speaker label
    〔ドアが開く音〕                 <- sound cue
    ♪～                              <- music marker

Left in, a speaker label gets romanised as though it were words (真樹 segments to
真 + 樹, "shin ki", when the name reads "Maki"), and hovering it returns a
dictionary entry for a kanji that means nothing in that context. `stripCC`
removes them. On by default, toggleable in the popup.

The length limits are deliberate. A genuine parenthetical inside dialogue is
usually longer than a name, so `これは（たぶん）普通の会話だよ` survives intact
while a leading `（真樹）` does not.

Name readings would otherwise need JMnedict, which is not loaded. Stripping the
labels removes the need.

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

- **Constant shift only.** Snap and `estimateOffset` correct a fixed offset. A
  framerate mismatch needs stretching and shows as drift growing across the
  episode. The fix is a different file, ideally WEB-tagged rather than a BD or
  Netflix rip, not more nudging.

- **Cue timings deserve a test, not a glance.** The SRT/VTT parser once split
  `00:00:12,300 --> 00:00:15,100` on `-->` and then called `.split(/\s+/)[0]` on
  the second half. That half begins with a space, so the call returned an empty
  string and every end time parsed as 0. A cue with `end: 0` can never be active,
  so every SRT-sourced track was silently dead while `.ass` tracks worked fine.
  Nothing errored; the overlay just stayed empty. If a track loads with a
  plausible cue count and still shows nothing, check cue *spans* before anything
  else, and check the `alignment` percentage: a genuinely misaligned pair still
  overlaps 30-40% by chance, so exactly 0% means broken data rather than bad sync.

- **Fullscreen hides anything outside the fullscreen element.** Entering
  fullscreen renders only that element and its descendants; the rest of the
  document is not painted, `position: fixed` included. An overlay parented to
  `documentElement` simply disappears. `ensureOverlayAttached` follows
  `document.fullscreenElement` instead, and runs each frame so the overlay also
  recovers if Crunchyroll's React tree removes the node while it is parented
  inside the player container.

- **The fetch hook depends on `window.fetch`.** If subtitle loading moves into a
  worker, the English line stops. The Japanese line is unaffected.

- **Series title comes from the DOM.** The URL slug is the *episode* title
  (`/watch/GMKUX2G9E/the-witch-and-the-bride`), so searching jimaku with it finds
  nothing. `detectPage()` scrapes the `/series/` link, then og:title, then
  document title. Selectors are the first thing to break on a redesign.

- **Deinflection is rules, not morphology.** It covers te/ta forms, polite,
  negative, passive, causative, potential, volitional, conditional, the common
  te-form auxiliaries, たい / すぎる / ながら, and i-adjectives. Rarer or heavily
  contracted colloquial forms will miss.

## Licences

**Extension code: GNU GPL v3 or later.** Full text in `LICENSE`. Every source
file carries an `SPDX-License-Identifier: GPL-3.0-or-later` tag and the FSF's
recommended notice. Copyright is asserted to Rafif Dzakwan Nur Azhari; change
the holder line in `LICENSE`-adjacent headers if you would rather use a handle
or an organisation.

What GPLv3 means in practice here: anyone may use, study, modify and
redistribute this, but derivative works must also be GPLv3 and must ship their
source. If you publish a modified build to the Chrome Web Store, the source has
to be available to its users.

**Dictionary data: CC BY-SA 4.0.** The files under `dict/` are derived from
JMdict, property of the Electronic Dictionary Research and Development Group.
See `dict/LICENCE-JMdict.txt`. They stay under CC BY-SA 4.0; shipping them in
the same archive as GPL code is mere aggregation and does not relicense either
one. Keep the attribution if you redistribute.

## Legal note

This overlays subtitles on content you are already authenticated to watch. It
does not touch DRM and does not redistribute video, the same posture as asbplayer
and Language Reactor. It is still likely against Crunchyroll's terms of service,
and extensions in this category have been removed from the Chrome Web Store
before. Fine for personal use; think hard before publishing.
