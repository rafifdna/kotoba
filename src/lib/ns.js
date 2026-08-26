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

// Classic script, not a module. Loaded first everywhere: content scripts get it
// from the manifest js array, the service worker via importScripts. Everything
// else hangs off this one global.
//
// The reason this is not an ES module: dynamic import() of a web-accessible
// module inside a content script fails as an unhandled rejection when anything
// about the path, CSP or extension reload is off, and the symptom is a silently
// dead extension. Classic scripts in a shared isolated-world scope cannot fail
// that way.

var Kotoba = (globalThis.Kotoba = globalThis.Kotoba || {});

Kotoba.DEBUG = true;

Kotoba.log = function (...args) {
  if (Kotoba.DEBUG) console.log('%c[kotoba]', 'color:#7aa2f7;font-weight:bold', ...args);
};
Kotoba.warn = function (...args) {
  console.warn('[kotoba]', ...args);
};

Kotoba.isJapanese = (ch) => /[\u3040-\u30ff\u4e00-\u9fff\u3005\u30fc]/.test(ch);

// NFKC plus katakana folded to hiragana, so lookups converge regardless of script.
Kotoba.normalize = (s) =>
  String(s)
    .normalize('NFKC')
    .replace(/[\u30a1-\u30f6]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0x60));

// Crunchyroll watch URLs are /watch/<ID>/<slug>, sometimes with a locale prefix.
Kotoba.parseWatchUrl = function (url = '') {
  const m = /crunchyroll\.com\/(?:[a-z]{2}(?:-[a-z]{2})?\/)?watch\/([A-Z0-9]+)(?:\/([^/?#]+))?/i.exec(url);
  if (!m) return null;
  return { id: m[1], slug: m[2] ? decodeURIComponent(m[2]).replace(/-/g, ' ') : '' };
};

// jimaku's search rejects queries containing a year, and Crunchyroll slugs carry
// season and episode noise that never matches an entry name. Strip both.
Kotoba.cleanTitle = function (title = '') {
  return title
    .replace(/\b(19|20)\d{2}\b/g, '')
    .replace(/\b(season|s)\s*\d+\b/gi, '')
    .replace(/\b(episode|ep)\s*\d+\b/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
};

Kotoba.round = (n, places = 3) => {
  const f = 10 ** places;
  return Math.round(n * f) / f;
};
