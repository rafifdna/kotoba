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

// MAIN world. Runs in the page's own JS realm so it can see window.fetch as the
// player uses it. No chrome.* here; everything leaves via window.postMessage.

(() => {
  const TAG = 'kotoba';

  // URL heuristic. Deliberately loose: Crunchyroll has served subtitle assets
  // from several path shapes and will again.
  const urlLooksLikeSubtitle = (url) =>
    /\.(ass|ssa|vtt|srt)(\?|$)/i.test(url) ||
    /subtitle|caption|\/(vtt|ass|srt)\b/i.test(url);

  // Content-type heuristic. Catches the case the URL heuristic misses, which is
  // an asset served from an opaque path with no extension. This is the addition
  // that matters: a signed CDN URL ending in a hash tells you nothing, but the
  // response headers still say what it is.
  const typeLooksLikeSubtitle = (ct = '') =>
    /text\/vtt|x-subrip|x-ssa|x-ass|dfxp|ttml/i.test(ct);

  // The playback config. Crunchyroll's DASH player does not fetch a plain .ass
  // any more; the subtitle track URLs are listed inside this JSON, and the
  // player pulls them lazily (or not at all, if the stream is hardsubbed).
  // Capturing this settles which of those is happening.
  const isPlayConfig = (url) => /\/playback\/v\d+\/[^?#]*\/play(\?|$)/i.test(url);

  // Segments and images would drown the log. Everything else is worth seeing.
  const NOISE = /\.(ts|m4s|jpg|jpeg|png|webp|gif|svg|ico|woff2?|css)(\?|$)/i;

  const emit = (payload) => window.postMessage(Object.assign({ __src: TAG }, payload), '*');

  const publish = (url, text) => {
    if (typeof text !== 'string' || text.length < 32) return;
    emit({ type: 'subtitle-asset', url, text });
  };

  const note = (url) => {
    if (!url || /^(data|blob):/.test(url) || NOISE.test(url)) return;
    emit({ type: 'net', url });
  };

  const nativeFetch = window.fetch;
  window.fetch = async function (input) {
    const res = await nativeFetch.apply(this, arguments);
    try {
      const url = typeof input === 'string' ? input : (input && input.url) || '';
      note(url);
      const ct = res.headers.get('content-type') || '';
      // Clone first. Never consume the caller's body.
      if (urlLooksLikeSubtitle(url) || typeLooksLikeSubtitle(ct)) {
        res.clone().text().then((t) => publish(url, t)).catch(() => {});
      } else if (isPlayConfig(url)) {
        res.clone().text()
          .then((t) => emit({ type: 'play-config', url, text: t }))
          .catch(() => {});
      }
    } catch { /* the player must never break because of us */ }
    return res;
  };

  const open = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url) {
    this.__kotobaUrl = String(url);
    return open.apply(this, arguments);
  };

  const send = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.send = function () {
    this.addEventListener('load', () => {
      try {
        const url = this.__kotobaUrl || '';
        note(url);
        const ct = this.getResponseHeader('content-type') || '';
        if ((urlLooksLikeSubtitle(url) || typeLooksLikeSubtitle(ct))
            && typeof this.responseText === 'string') {
          publish(url, this.responseText);
        } else if (isPlayConfig(url) && typeof this.responseText === 'string') {
          emit({ type: 'play-config', url, text: this.responseText });
        }
      } catch {}
    });
    return send.apply(this, arguments);
  };

  emit({ type: 'hook-ready' });
})();
