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

// jimaku.cc client. Service-worker side, so requests carry the extension's
// host permission rather than the page's origin.
//
// ENDPOINTS ARE NOT OFFICIALLY DOCUMENTED IN A FORM I COULD VERIFY DIRECTLY.
// They follow the shape every community client uses (bazarr's provider,
// jimaku-dl, the Emby plugin): search accepts either anilist_id or query, and
// files hang off an entry id with an optional episode filter. Verify with:
//
//   curl -H "Authorization: $KEY" 'https://jimaku.cc/api/entries/search?query=frieren'
//   curl -H "Authorization: $KEY" 'https://jimaku.cc/api/entries/1/files?episode=1'
//
// If the shape differs, only the three constants below need changing.

(function (K) {
  const BASE = 'https://jimaku.cc/api';
  const SEARCH = (params) => `${BASE}/entries/search?${params}`;
  const FILES = (id, params) => `${BASE}/entries/${id}/files?${params}`;

  // 25 requests per minute per key. Nowhere near a constraint for normal use,
  // but a retry loop on a bad title could burn it, so keep a simple gate.
  let lastCall = 0;
  const MIN_GAP_MS = 2500;

  async function call(url, key) {
    const wait = Math.max(0, lastCall + MIN_GAP_MS - Date.now());
    if (wait) await new Promise((r) => setTimeout(r, wait));
    lastCall = Date.now();

    const res = await fetch(url, { headers: { Authorization: key } });
    if (res.status === 401 || res.status === 403) {
      throw new Error('jimaku rejected the API key');
    }
    if (res.status === 429) throw new Error('jimaku rate limit hit, wait a minute');
    if (!res.ok) throw new Error(`jimaku returned ${res.status}`);
    return res.json();
  }

  async function searchEntries({ key, title, anilistId }) {
    const params = new URLSearchParams();
    if (anilistId) params.set('anilist_id', String(anilistId));
    else params.set('query', K.cleanTitle(title));
    const data = await call(SEARCH(params.toString()), key);
    return Array.isArray(data) ? data : (data.entries || []);
  }

  async function listFiles({ key, entryId, episode }) {
    const params = new URLSearchParams();
    if (episode) params.set('episode', String(episode));
    const data = await call(FILES(entryId, params.toString()), key);
    const files = Array.isArray(data) ? data : (data.files || []);
    return files.map(annotate).sort(rank);
  }

  // Tag the source so the UI can steer toward what aligns with Crunchyroll.
  // WEB rips are cut from the same broadcast master Crunchyroll streams, so they
  // usually need no offset at all. BD rips are recut, often with different OP
  // placement, and will need a snap even after a good match.
  function annotate(file) {
    const name = file.name || file.filename || '';
    const tags = [];
    if (/\b(web|webrip|web-dl|amzn|cr|crunchyroll)\b/i.test(name)) tags.push('WEB');
    if (/\b(bd|bdrip|bluray|blu-ray)\b/i.test(name)) tags.push('BD');
    if (/\.ass$/i.test(name)) tags.push('ASS');
    if (/\.srt$/i.test(name)) tags.push('SRT');
    return Object.assign({}, file, { name, tags });
  }

  function rank(a, b) {
    const score = (f) =>
      (f.tags.includes('WEB') ? -4 : 0) +
      (f.tags.includes('ASS') ? -1 : 0) +
      (f.tags.includes('BD') ? 2 : 0);
    return score(a) - score(b);
  }

  // Files are served from a URL in the listing; fetch the raw text, not JSON.
  async function download(url) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`download failed: ${res.status}`);
    return res.text();
  }

  K.jimaku = { searchEntries, listFiles, download };
})(globalThis.Kotoba);
