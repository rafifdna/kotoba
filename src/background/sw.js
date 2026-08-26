// SPDX-License-Identifier: GPL-3.0-or-later
/*
 * Kotoba - dual Japanese/English subtitles for Crunchyroll
 * Copyright (C) 2026 Rafif Dzakwan Nur Azhari
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <https://www.gnu.org/licenses/>.
 */

// Classic (non-module) service worker so importScripts works. Module workers
// cannot importScripts, and ES-module loading is exactly the failure mode this
// rewrite removes.
importScripts(
  '/src/lib/ns.js',
  '/src/lib/deinflect.js',
  '/src/lib/dict.js',
  '/src/lib/jimaku.js',
  '/src/lib/romaji.js'
);

const K = globalThis.Kotoba;

// --- keys -------------------------------------------------------------------
// Offsets are stored per SERIES, not per episode. Episodes from one release
// group share timing within a few hundred ms, so anchoring once carries the
// whole season. The per-episode value is only written when you deliberately
// override it.
const trackKey  = (ep)     => `track:${ep}`;
const epOffset  = (ep)     => `offset:ep:${ep}`;
const serOffset = (series) => `offset:series:${series}`;

// --- frame registry ---------------------------------------------------------
// Every content-script frame reports its state here. The popup reads it for the
// diagnostics panel, which is how you find out which frame holds the video
// without hunting through the devtools context dropdown.
const frames = new Map();

const handlers = {
  // The popup has no sender.tab, so it passes the tab URL explicitly. Content
  // scripts have one and pass nothing. Reading sender.tab unconditionally was
  // the bug that made the popup always report "no episode detected".
  //
  // The series title cannot come from the URL: the slug is the EPISODE title.
  // Content scripts scrape the show name from the page and report it here, so
  // whatever they last saw for this tab wins over the slug.
  async context(msg, sender) {
    const url = (msg && msg.url) || (sender.tab && sender.tab.url) || '';
    const tabId = (msg && msg.tabId) || (sender.tab && sender.tab.id);
    const watch = K.parseWatchUrl(url);
    if (!watch) return { episode: null, title: '', series: null, episodeNumber: null };

    const page = latestPageInfo(tabId);
    const title = page.seriesTitle || K.cleanTitle(watch.slug);

    return {
      episode: `cr:${watch.id}`,
      title: K.cleanTitle(title),
      series: K.cleanTitle(title).toLowerCase() || null,
      episodeNumber: page.episodeNumber || null,
      fromDom: !!page.seriesTitle,
    };
  },

  async frameReport(msg, sender) {
    frames.set(`${sender.tab?.id}:${sender.frameId}`, Object.assign(
      { frameId: sender.frameId, url: sender.url, at: Date.now() },
      msg.state
    ));
    return { ok: true };
  },

  async diagnostics() {
    const now = Date.now();
    const live = Array.from(frames.values()).filter((f) => now - f.at < 15000);
    return { frames: live, dict: await K.dict.count().catch(() => 0) };
  },

  async lookup({ text }) { return K.dict.lookupAt(text); },

  async romajiLine({ text }) {
    if (!(await K.dict.count())) throw new Error('no dictionary imported');
    return { romaji: await lineToRomaji(text) };
  },
  async dictStatus()     { return { count: await K.dict.count() }; },
  async importDict({ entries }) {
    await K.dict.importEntries(entries);
    return { count: await K.dict.count() };
  },
  async clearDict() { await K.dict.clear(); return { count: 0 }; },

  async saveTrack({ episode, filename, text }) {
    await chrome.storage.local.set({
      [trackKey(episode)]: { filename, text, at: Date.now() },
    });
    return { ok: true };
  },

  async loadTrack({ episode, series }) {
    const keys = [trackKey(episode), epOffset(episode)];
    if (series) keys.push(serOffset(series));
    const store = await chrome.storage.local.get(keys);
    // Episode override wins; otherwise inherit the series anchor.
    const offset = store[epOffset(episode)]
      ?? (series ? store[serOffset(series)] : undefined)
      ?? 0;
    return { track: store[trackKey(episode)] || null, offset };
  },

  async saveOffset({ episode, series, offset }) {
    const patch = { [epOffset(episode)]: offset };
    if (series) patch[serOffset(series)] = offset;   // anchor the whole series
    await chrome.storage.local.set(patch);
    return { ok: true };
  },

  async settings() {
    const { settings } = await chrome.storage.local.get('settings');
    return { settings: Object.assign({}, DEFAULTS, settings || {}) };
  },

  // --- jimaku ---------------------------------------------------------------

  async jimakuSearch({ title, anilistId }) {
    const key = await apiKey();
    return { entries: await K.jimaku.searchEntries({ key, title, anilistId }) };
  },

  async jimakuFiles({ entryId, episode }) {
    const key = await apiKey();
    return { files: await K.jimaku.listFiles({ key, entryId, episode }) };
  },

  async jimakuFetch({ url, filename, episode }) {
    const text = await K.jimaku.download(url);
    await chrome.storage.local.set({
      [trackKey(episode)]: { filename, text, at: Date.now() },
    });
    return { ok: true, bytes: text.length };
  },

  // Fetched here rather than in the content script: a content-script fetch is
  // bound by the page's CORS policy, while the worker carries host permissions.
  // credentials:'include' matters because some of these URLs are session-scoped
  // rather than pre-signed.
  async fetchSubtitle({ url }) {
    const res = await fetch(url, { credentials: 'include' });
    if (res.status === 401 || res.status === 403) {
      throw new Error(
        `subtitle fetch returned ${res.status} (not a subtitle file, or session-scoped)`
      );
    }
    if (!res.ok) throw new Error(`subtitle fetch returned ${res.status}`);
    return { text: await res.text() };
  },

  async ankiAdd({ note }) {
    const res = await fetch('http://127.0.0.1:8765', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'addNote', version: 6, params: { note } }),
    });
    const body = await res.json();
    if (body.error) throw new Error(body.error);
    return { id: body.result };
  },
};

// --- romaji ------------------------------------------------------------------
// Segment a subtitle line and romanise it. There is no morphological analyser
// here, so segmentation reuses the same longest-prefix dictionary matching that
// powers hover lookup: walk the line, resolve each chunk to an entry, and
// reconstruct that chunk's reading from the entry's headword and reading.
//
// This is good but not perfect. Where a surface is ambiguous (行った is both
// いった and おこなった) it takes the better-ranked entry, and a kanji the
// dictionary cannot resolve is passed through unromanised so the gap is visible
// rather than silently wrong.

function resolveReading(matched, entry) {
  for (const kf of entry.k || []) {
    for (const r of entry.r || []) {
      const read = K.romaji.readingForSurface(matched, kf, r);
      if (read) return read;
    }
  }
  if (K.romaji.isKana(matched)) return matched;
  return (entry.r && entry.r[0]) || '';
}

const JP_CHAR = /[\u3040-\u30ff\u4e00-\u9fff\u3005\u30fc]/;

async function lineToRomaji(text) {
  const words = [];
  let i = 0;
  let guard = 0;

  while (i < text.length && guard++ < 300) {
    const ch = text[i];

    if (ch === '\n') { words.push({ t: '\n', w: false }); i++; continue; }

    if (/[0-9A-Za-z\uff10-\uff19\uff21-\uff5a]/.test(ch)) {
      // Latin and digits are words for spacing purposes, so 2番目 renders as
      // "2 banme" rather than gluing the digit onto the preceding word.
      let j = i;
      while (j < text.length && /[0-9A-Za-z\uff10-\uff19\uff21-\uff5a]/.test(text[j])) j++;
      words.push({ t: text.slice(i, j), w: true });
      i = j;
      continue;
    }

    if (!JP_CHAR.test(ch)) {           // punctuation and everything else
      words.push({ t: ch, w: false });
      i++;
      continue;
    }

    if (K.romaji.isKana(ch)) {
      // A kana run still goes through the dictionary first, because it may be a
      // whole word worth spacing separately. If nothing matches, convert the run.
      const hit = await K.dict.lookupAt(text.slice(i));
      if (hit && hit.length > 1) {
        words.push({ t: K.romaji.fromKana(resolveReading(hit.matched, hit.entries[0])), w: true });
        i += hit.length;
        continue;
      }
      // Stop the run at the hiragana/katakana boundary. Without this, のテスト
      // is consumed as one run and romanises to "notesuto" instead of
      // "no tesuto", because katakana almost always marks a separate word.
      const katakana = (c) => /[\u30a1-\u30fa]/.test(c);
      const startKata = katakana(text[i]);
      let j = i;
      while (j < text.length && K.romaji.isKana(text[j])
             && (katakana(text[j]) === startKata || text[j] === '\u30fc')) j++;
      words.push({ t: K.romaji.fromKana(text.slice(i, j)), w: true });
      i = j;
      continue;
    }

    const hit = await K.dict.lookupAt(text.slice(i));
    if (hit) {
      const reading = resolveReading(hit.matched, hit.entries[0]);
      words.push({ t: reading ? K.romaji.fromKana(reading) : hit.matched, w: true });
      i += hit.length;
      continue;
    }

    words.push({ t: ch, w: true });    // unresolvable kanji, shown as-is
    i++;
  }

  // Space between words, but never before punctuation.
  let out = '';
  for (const p of words) {
    if (p.t === '\n') { out += '\n'; continue; }
    if (p.w && out && !out.endsWith('\n') && !out.endsWith(' ')) out += ' ';
    out += p.t;
  }
  return out.replace(/ +/g, ' ').replace(/ ([,.!?\u3001\u3002\uff01\uff1f])/g, '$1').trim();
}

async function apiKey() {
  const { settings } = await chrome.storage.local.get('settings');
  const key = settings && settings.jimakuKey;
  if (!key) throw new Error('No jimaku API key. Add one in the popup.');
  return key;
}

// Most recent DOM-scraped page info for a tab. Frames report continuously; the
// one holding the player is the one that finds a series link, so prefer any
// frame that actually produced a title over one that produced nothing.
function latestPageInfo(tabId) {
  let best = { seriesTitle: '', episodeNumber: null };
  for (const [key, f] of frames) {
    if (tabId != null && !key.startsWith(tabId + ':')) continue;
    if (Date.now() - f.at > 15000) continue;
    if (f.seriesTitle && !best.seriesTitle) best.seriesTitle = f.seriesTitle;
    if (f.episodeNumber && !best.episodeNumber) best.episodeNumber = f.episodeNumber;
  }
  return best;
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const fn = handlers[msg && msg.type];
  if (!fn) return false;
  Promise.resolve(fn(msg, sender))
    .then((data) => sendResponse({ ok: true, data }))
    .catch((err) => {
      K.warn(msg.type, err);
      sendResponse({ ok: false, error: String((err && err.message) || err) });
    });
  return true;   // keep the channel open for the async reply
});

chrome.commands.onCommand.addListener(async (command) => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !tab.id) return;
  const map = {
    snap: { type: 'snap' },
    'nudge-back': { type: 'nudge', delta: -0.2 },
    'nudge-forward': { type: 'nudge', delta: 0.2 },
  };
  const msg = map[command];
  if (msg) chrome.tabs.sendMessage(tab.id, msg).catch(() => {});
});

// One-time migration. Offsets saved before 0.5.2 were computed against cues
// whose end times all parsed as 0, so every one of them is meaningless. Clearing
// them lets auto-alignment run again on the corrected timings rather than
// deferring to a stored value that was never valid.
chrome.runtime.onInstalled.addListener(async (details) => {
  if (details.reason !== 'update') return;
  const all = await chrome.storage.local.get(null);
  const stale = Object.keys(all).filter((k) => k.startsWith('offset:'));
  if (!stale.length) return;
  await chrome.storage.local.remove(stale);
  K.warn('cleared ' + stale.length + ' offsets saved against the broken parser');
});

const DEFAULTS = {
  showJapanese: true,
  showRomaji: true,
  showEnglish: true,
  blurEnglish: true,     // reveal on hover, so you attempt the Japanese first
  position: 'bottom',    // 'top' avoids colliding with Crunchyroll's own subs
  pauseOnHover: true,
  hoverDelayMs: 180,
  fontSize: 24,           // px at a 1280px-wide player, scaled from there
  fontFamily: 'sans',
  bold: true,
  backdrop: false,
  stripCC: true,          // drop （speaker）labels and sound cues from CC tracks
  cardStyle: 'sentence',  // sentence-first is the immersion-learning default
  jimakuKey: '',
  ankiDeck: 'Mining',
  ankiModel: 'Basic',
};
