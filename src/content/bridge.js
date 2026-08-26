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

// ISOLATED world, classic script. Runs in every frame on both Crunchyroll hosts.
// Only the frame that actually holds a <video> does any work; the rest just
// report their state so the popup's diagnostics panel can show where things are.

(function (K) {
  // An orphaned content script keeps running after the extension is reloaded,
  // but its chrome.runtime handle is dead. Every message then rejects with
  // "Extension context invalidated", and because report() runs on an interval,
  // one reload produces an endless error stream. Detect it once and stand down.
  let alive = true;
  const timers = { interval: null, observer: null };

  function shutdown() {
    if (!alive) return;
    alive = false;
    clearInterval(timers.interval);
    if (timers.observer) timers.observer.disconnect();
    state.video = null;
    if (state.root) { state.root.remove(); state.root = null; }
    console.log('[kotoba] extension was reloaded; this page copy has stopped. Refresh to reconnect.');
  }

  const isDead = (e) =>
    /context invalidated|receiving end does not exist|message port closed/i
      .test(String((e && e.message) || e));

  const send = (msg) => {
    // chrome.runtime.id goes undefined the moment the context is invalidated,
    // and sendMessage can throw synchronously rather than reject.
    if (!alive || !chrome.runtime || !chrome.runtime.id) {
      return Promise.reject(new Error('extension reloaded'));
    }
    let p;
    try {
      p = chrome.runtime.sendMessage(msg);
    } catch (e) {
      if (isDead(e)) shutdown();
      return Promise.reject(e);
    }
    return p.then(
      (r) => {
        if (!r || !r.ok) throw new Error((r && r.error) || 'no response from background');
        return r.data;
      },
      (e) => {
        if (isDead(e)) shutdown();
        throw e;
      }
    );
  };

  const state = {
    video: null,
    episode: null,
    series: null,
    title: '',
    jp: new K.Track([]),
    en: new K.Track([]),
    settings: {},
    root: null,
    lastJp: null,
    lastEn: null,
    hooked: false,
    assets: 0,
    net: [],
    crTracks: [],
  };

  // --- player discovery ------------------------------------------------------
  // Crunchyroll has served the player two ways: inside an iframe on
  // static.crunchyroll.com, and inside a Bitmovin container in the top frame.
  // Rather than encode either assumption, look for a <video> that is actually
  // playing something and take whichever frame finds one. all_frames means this
  // script is running in both, so exactly one will win.
  function findVideo() {
    const candidates = Array.from(document.querySelectorAll('video'));
    return candidates.find((v) => v.readyState > 0 && v.videoWidth > 0)
        || candidates.find((v) => v.readyState > 0)
        || null;
  }

  function watchForVideo() {
    if (!alive) return;
    let lastUrl = location.href;

    const tick = async () => {
      if (!alive) return;

      // Episode changes inside the SPA reuse the same <video> element, so
      // watching element identity alone silently keeps the previous episode's
      // track. Watch the URL too.
      if (location.href !== lastUrl) {
        lastUrl = location.href;
        K.log('navigated to', location.href);
        await onNavigate();
      }

      const v = findVideo();
      if (v && v !== state.video) {
        K.log('video found in', location.host, 'frame', { w: v.videoWidth, h: v.videoHeight });
        await attach(v);
      }
      report();
    };
    tick();
    timers.interval = setInterval(tick, 2000);
    timers.observer = new MutationObserver(tick);
    timers.observer.observe(document.documentElement, { childList: true, subtree: true });
  }

  // The Crunchyroll URL slug is the EPISODE title (/watch/GMKUX2G9E/the-witch-
  // and-the-bride), not the series. Searching jimaku for an episode title finds
  // nothing, so the show name has to come from the page. Several fallbacks,
  // because these selectors are the first thing to break on a redesign.
  function detectPage() {
    const info = { seriesTitle: '', episodeNumber: null };

    const link = Array.from(document.querySelectorAll('a[href*="/series/"]'))
      .map((a) => a.textContent.trim())
      .find((t) => t.length > 2);
    if (link) info.seriesTitle = link;

    if (!info.seriesTitle) {
      const og = document.querySelector('meta[property="og:title"]');
      if (og) {
        info.seriesTitle = og.content
          .replace(/^watch\s+/i, '')
          .replace(/\s*[-|]\s*crunchyroll.*$/i, '')
          .trim();
      }
    }

    if (!info.seriesTitle && document.title) {
      info.seriesTitle = document.title
        .replace(/^watch\s+/i, '')
        .replace(/\s*[-|]\s*crunchyroll.*$/i, '')
        .trim();
    }

    // Headings render as "E1 - The Witch and the Bride".
    for (const el of document.querySelectorAll('h1, h2, h3, h4')) {
      const m = /^\s*(?:E|EP|Episode)\s*(\d+)\b/i.exec(el.textContent || '');
      if (m) { info.episodeNumber = Number(m[1]); break; }
    }

    return info;
  }

  // Walk arbitrary JSON collecting {locale, format, url}. Crunchyroll has kept
  // subtitles under 'subtitles', 'captions' and 'hardSubs' at various times and
  // nested them differently each redesign, so match on shape instead: any object
  // with a string url and a language-looking sibling key.
  function findSubtitleTracks(node, out = [], depth = 0) {
    if (!node || typeof node !== 'object' || depth > 6) return out;

    if (Array.isArray(node)) {
      node.forEach((v) => findSubtitleTracks(v, out, depth + 1));
      return out;
    }

    // Check this node first. Tracks sometimes arrive as an array of objects that
    // each carry their own language field, in which case only the node itself
    // looks like a track and inspecting its children finds nothing.
    if (typeof node.url === 'string') {
      const own = node.language || node.locale || node.hlang;
      if (own) {
        out.push({ locale: own, format: node.format || '', url: node.url });
        return out;
      }
    }

    for (const [key, value] of Object.entries(node)) {
      if (value && typeof value === 'object' && typeof value.url === 'string') {
        const locale = value.language || value.locale || value.hlang ||
          (/^[a-z]{2}(-[A-Z]{2})?$/.test(key) ? key : '');
        if (locale) {
          out.push({ locale, format: value.format || '', url: value.url });
          continue;
        }
      }
      findSubtitleTracks(value, out, depth + 1);
    }
    return out;
  }

  // A real subtitle file, not a hardsubbed video stream. The play config lists
  // both: `subtitles` holds .ass files, `hardSubs` holds video manifests with
  // the subtitles burned in, keyed by the same locale codes. Fetching a hardsub
  // manifest as if it were a subtitle file is what returns 401.
  const isSubtitleFile = (t) =>
    /^(ass|ssa|vtt|srt)$/i.test(t.format || '') ||
    (/\.(ass|ssa|vtt|srt)(\?|$)/i.test(t.url) && !/\.mpd|manifest|\.m3u8/i.test(t.url));

  // Fetch through the background: content-script fetches are bound by the page's
  // CORS, while the service worker has host permissions for the CDN.
  async function loadCrunchyrollTracks(all) {
    const tracks = all.filter(isSubtitleFile);
    if (!tracks.length) {
      K.log('play config lists only hardsub streams, no subtitle files');
      return;
    }

    const pick = (re) => tracks.find((t) => re.test(t.locale));
    const ja = pick(/^ja/i);
    const en = pick(/^en/i);

    // A real Crunchyroll Japanese track beats anything from jimaku: it is timed
    // against this exact encode, so it needs no offset at all. Most titles have
    // no such track, which is the entire reason the jimaku path exists.
    if (ja && state.jp.label !== 'crunchyroll-ja') {
      const cues = await fetchTrack(ja.url, 'ja');
      if (cues && cues.length) {
        state.jp = new K.Track(K.dialogueOnly(cues), { label: 'crunchyroll-ja' });
        state.lastJp = null;
        toast('Using Crunchyroll\'s own Japanese track (no sync needed)');
      }
    }

    if (en && !state.en.length) {
      const cues = await fetchTrack(en.url, 'en');
      if (cues && cues.length) {
        state.en = new K.Track(cues, { label: 'crunchyroll-translation' });
        state.lastEn = null;
        K.log('english track loaded:', cues.length, 'cues');
        autoAlign();
      }
    }
  }

  // Once a Japanese track and Crunchyroll's own translation track both exist,
  // the translation is a timing reference for this exact encode. A rip from
  // another service is usually a constant shift away from it, so a median
  // nearest-neighbour estimate lands within a few hundred milliseconds.
  //
  // Only ever runs when the offset is still zero, so it can never overwrite an
  // anchor the user set deliberately with S.
  function autoAlign() {
    if (!state.jp.length || !state.en.length) return;
    if (state.jp.offset) return;

    const est = K.estimateOffset(state.jp, state.en);
    if (!est) return;

    state.jp.offset = est;
    state.lastJp = null;
    persistOffset(est);
    K.log('auto-aligned', est);
    toast('Auto-aligned to Crunchyroll timings: ' +
      (est >= 0 ? '+' : '') + est.toFixed(2) + 's');
  }

  // What fraction of Crunchyroll's lines have a Japanese line at the same
  // moment. Near 0% means the tracks are misaligned or from the wrong episode;
  // a healthy pair sits well above 70%.
  function alignmentScore() {
    if (!state.jp.length || !state.en.length) return null;
    const sample = state.en.cues.slice(0, 120);
    if (sample.length < 5) return null;
    let hit = 0;
    for (const c of sample) {
      if (state.jp.at((c.start + c.end) / 2 + state.en.offset)) hit++;
    }
    return Math.round((hit / sample.length) * 100);
  }

  async function fetchTrack(url, tag) {
    try {
      const { text } = await send({ type: 'fetchSubtitle', url });
      state.assets++;
      return K.parse(text, url);
    } catch (e) {
      K.warn('could not fetch ' + tag + ' track', e);
      return null;
    }
  }

  function report() {
    if (!alive) return;
    const page = detectPage();
    send({
      type: 'frameReport',
      state: {
        host: location.host,
        hasVideo: !!state.video,
        overlay: !!state.root,
        hooked: state.hooked,
        assetsSeen: state.assets,
        jpCues: state.jp.length,
        enCues: state.en.length,
        offset: state.jp.offset,
        episode: state.episode,
        seriesTitle: page.seriesTitle,
        episodeNumber: page.episodeNumber,
        crTracks: state.crTracks,
        jpNow: state.lastJp ? state.lastJp.text.slice(0, 40) : '(no line at this moment)',
        episode: state.episode || '(none resolved)',
        trackLabel: state.jp.label || '(no japanese track)',
        alignment: alignmentScore(),
        renderErrors: state.renderErrors || 0,
        lastRenderError: state.lastRenderError || '',
        net: state.net.slice(-25),
      },
    }).catch(() => {});
  }

  // Everything episode-scoped is cleared here. Leaving the previous episode's
  // cues in place would render dialogue from the wrong show at plausible-looking
  // times, which is harder to notice than showing nothing.
  async function onNavigate() {
    let ctx;
    try {
      ctx = await send({ type: 'context', url: location.href });
    } catch (e) {
      return K.warn('context failed on navigate', e);
    }
    if (!ctx.episode || ctx.episode === state.episode) return;

    state.episode = ctx.episode;
    state.series = ctx.series;
    state.title = ctx.title;
    state.jp = new K.Track([]);
    state.en = new K.Track([]);
    state.lastJp = null;
    state.lastEn = null;
    state.crTracks = [];
    state.assets = 0;
    romajiCache.clear();

    await loadSavedTrack();
  }

  async function attach(v) {
    state.video = v;
    if (!state.root) buildOverlay();

    try {
      const ctx = await send({ type: 'context', url: location.href });
      if (ctx.episode && ctx.episode !== state.episode) {
        state.episode = ctx.episode;
        state.series = ctx.series;
        state.title = ctx.title;
        await loadSavedTrack();
      }
    } catch (e) {
      K.warn('context failed', e);
    }
    requestAnimationFrame(renderLoop);
  }

  async function loadSavedTrack() {
    try {
      const { track, offset } = await send({
        type: 'loadTrack', episode: state.episode, series: state.series,
      });
      if (track) {
        let cues = K.dialogueOnly(K.parse(track.text, track.filename));
        if (state.settings.stripCC !== false) cues = K.stripTrackCC(cues);
        state.jp = new K.Track(cues, { offset, label: track.filename });
        K.log('japanese track', track.filename, cues.length, 'cues, offset', offset);
        toast(`${cues.length} Japanese lines loaded`);
        autoAlign();
      } else {
        state.jp = new K.Track([]);
      }
    } catch (e) {
      K.warn('loadTrack failed', e);
      state.jp = new K.Track([]);
    }
  }

  // --- subtitle assets from the page ----------------------------------------

  window.addEventListener('message', (ev) => {
    const d = ev.data;
    if (!d || d.__src !== 'kotoba') return;
    if (d.type === 'hook-ready') { state.hooked = true; K.log('main-world hook ready'); return; }

    // Every non-segment request the player makes. Kept so the diagnostics panel
    // can show what Crunchyroll actually fetches when the subtitle heuristics
    // come up empty, rather than leaving you to guess at path shapes.
    if (d.type === 'net') {
      try {
        const u = new URL(d.url, location.href);
        const key = u.host + u.pathname;
        if (!state.net.includes(key)) {
          state.net.push(key);
          if (state.net.length > 60) state.net.shift();
        }
      } catch {}
      return;
    }

    // The playback config. Rather than assume a field layout that Crunchyroll
    // has changed several times, walk the whole JSON and collect anything that
    // looks like a subtitle track: an object carrying a URL plus a language tag.
    if (d.type === 'play-config') {
      try {
        const cfg = JSON.parse(d.text);
        const found = findSubtitleTracks(cfg);
        // Report only the real subtitle files. Listing the hardsub manifests
        // alongside them just produced a wall of duplicate locale codes.
        const subs = found.filter(isSubtitleFile);
        const hard = found.length - subs.length;
        state.crTracks = subs.map((t) => t.locale + (t.format ? ':' + t.format : ''));
        if (hard) state.crTracks.push('(' + hard + ' hardsub streams ignored)');
        K.log('play config: ' + (subs.length ? state.crTracks.join(', ') : 'no subtitle files'));
        if (found.length) loadCrunchyrollTracks(found);
      } catch (e) {
        K.warn('play-config parse failed', e);
      }
      return;
    }

    if (d.type !== 'subtitle-asset') return;

    state.assets++;
    try {
      const cues = K.parse(d.text, d.url);
      if (!cues.length) return K.log('asset parsed to zero cues', d.url);

      const ratio = K.japaneseRatio(cues);
      K.log('asset', d.url.slice(-60), cues.length, 'cues, jp ratio', ratio.toFixed(2));

      // A small number of titles do carry a genuine Japanese track. If one shows
      // up, it beats anything you would fetch externally: perfectly timed.
      if (ratio > 0.35) {
        if (!state.jp.length) {
          state.jp = new K.Track(K.dialogueOnly(cues), { label: 'crunchyroll-ja' });
          toast('Japanese track found on Crunchyroll');
        }
      } else {
        state.en = new K.Track(cues, { label: 'crunchyroll-translation' });
        if (state.jp.length && !state.jp.offset) {
          state.jp.offset = K.estimateOffset(state.jp, state.en);
          K.log('auto offset', state.jp.offset);
        }
      }
    } catch (e) {
      K.warn('parse failed', d.url, e);
    }
  });

  // --- overlay ---------------------------------------------------------------

  function buildOverlay() {
    const root = document.createElement('div');
    root.id = 'kotoba-root';
    root.innerHTML =
      '<div id="kotoba-lines">' +
        '<div id="kotoba-jp" class="kotoba-line"></div>' +
        '<div id="kotoba-romaji" class="kotoba-line"></div>' +
        '<div id="kotoba-en" class="kotoba-line"></div>' +
      '</div>' +
      '<div id="kotoba-popup" hidden></div>' +
      '<div id="kotoba-toast" hidden></div>';
    state.root = root;
    ensureOverlayAttached();

    // Entering fullscreen renders ONLY the fullscreen element and its
    // descendants; everything else in the document is hidden, position:fixed
    // included. An overlay parented to documentElement therefore disappears the
    // moment Crunchyroll's fullscreen button is pressed. Follow the fullscreen
    // element instead.
    document.addEventListener('fullscreenchange', ensureOverlayAttached);
    document.addEventListener('webkitfullscreenchange', ensureOverlayAttached);

    // Pause on hover, but only after a short delay. Without the delay, merely
    // moving the cursor across the screen toward something else pauses playback,
    // which is far more annoying than it sounds.
    let pauseTimer = null;
    const lines = root.querySelector('#kotoba-lines');

    lines.addEventListener('mouseenter', () => {
      if (!state.settings.pauseOnHover) return;
      clearTimeout(pauseTimer);
      pauseTimer = setTimeout(() => {
        if (state.video && !state.video.paused) {
          state.video.pause();
          root.dataset.autopaused = '1';
        }
      }, state.settings.hoverDelayMs || 180);
    });

    lines.addEventListener('mouseleave', () => {
      clearTimeout(pauseTimer);
      hidePopup();
      if (root.dataset.autopaused && state.video && state.video.paused) {
        state.video.play().catch(() => {});
        delete root.dataset.autopaused;
      }
    });

    K.log('overlay built in', location.host);
  }

  // A declaration rather than a const arrow: ensureOverlayAttached is hoisted and
  // may be called from buildOverlay before this point in the file is evaluated,
  // which would hit the temporal dead zone on a const.
  function overlayParent() {
    return document.fullscreenElement
        || document.webkitFullscreenElement
        || document.documentElement;
  }

  // Cheap parent check, safe to call every frame. It also recovers the overlay
  // if Crunchyroll's own React tree removes the node while we are parented
  // inside the player container during fullscreen.
  function ensureOverlayAttached() {
    if (!state.root) return;
    const parent = overlayParent();
    if (state.root.parentNode !== parent) {
      parent.appendChild(state.root);
      K.log('overlay attached to', parent === document.documentElement
        ? 'document' : 'fullscreen element');
    }
  }

  function renderLoop() {
    if (!alive) return;
    if (!state.video || !document.contains(state.video)) { state.video = null; return; }

    // Everything inside is wrapped, because an exception here used to escape
    // before requestAnimationFrame and kill the loop for good: the overlay froze
    // on whatever was last painted, with no error visible on screen. A render
    // loop must never be able to stop itself. Failures are counted and surfaced
    // in Diagnose instead.
    try {
      const t = state.video.currentTime;

      const jp = state.jp.at(t);
      if (jp !== state.lastJp) {
        state.lastJp = jp;
        renderJapanese(jp ? jp.text : '');
        renderRomaji(jp ? jp.text : '');
        prefetchRomaji(t);
      }

      const en = state.en.at(t);
      if (en !== state.lastEn) {
        state.lastEn = en;
        const node = state.root.querySelector('#kotoba-en');
        node.textContent = en ? en.text : '';
        node.classList.toggle('blurred', !!state.settings.blurEnglish && !!en);
      }

      ensureOverlayAttached();
      positionOverlay();
    } catch (e) {
      state.renderErrors = (state.renderErrors || 0) + 1;
      if (state.renderErrors <= 3) K.warn('render loop error', e);
      state.lastRenderError = String((e && e.message) || e);
    }

    requestAnimationFrame(renderLoop);
  }

  // Track the video's box every frame rather than reparenting into the player.
  // Fullscreen, theatre mode and the mini player all move the element, and a
  // fixed overlay following getBoundingClientRect survives all three. Reparenting
  // also means their React tree can destroy the node on any re-render.
  function positionOverlay() {
    const r = state.video.getBoundingClientRect();
    const lines = state.root.querySelector('#kotoba-lines');
    const pad = r.height * 0.06;

    lines.style.left = r.left + 'px';
    lines.style.width = r.width + 'px';

    // Scale to the player width so text keeps the same visual proportion in a
    // small window, theatre mode and fullscreen alike. Clamped so it stays
    // legible on a tiny player and does not become absurd on a 4K one.
    const base = state.settings.fontSize || 24;
    const scaled = Math.max(11, Math.min(72, base * (r.width / 1280)));
    state.root.style.setProperty('--kotoba-size', scaled + 'px');

    // Crunchyroll's own subtitles cannot reliably be hidden from the page, so
    // 'top' is the escape hatch: put ours where theirs are not.
    if (state.settings.position === 'top') {
      lines.style.top = (r.top + pad) + 'px';
    } else {
      lines.style.top = (r.bottom - pad - lines.offsetHeight) + 'px';
    }
  }

  // One span per character. Hover resolves the longest match starting there and
  // highlights the span range it consumed, which is what makes 見つけて behave
  // like a single word without shipping a tokenizer.
  // Romaji is resolved in the background (it needs dictionary lookups), so it
  // arrives a beat after the Japanese line. Cache by cue text and prefetch the
  // next few cues so that lag is never visible during normal playback.
  const romajiCache = new Map();
  let romajiSeq = 0;

  async function romajiFor(text) {
    if (!text) return '';
    if (romajiCache.has(text)) return romajiCache.get(text);
    try {
      const { romaji } = await send({ type: 'romajiLine', text });
      romajiCache.set(text, romaji);
      if (romajiCache.size > 600) romajiCache.clear();
      return romaji;
    } catch (e) {
      // No dictionary imported yet is the common case; say it once, not per cue.
      if (!state.romajiWarned) {
        state.romajiWarned = true;
        K.warn('romaji unavailable:', e.message);
        if (/dictionary/i.test(e.message)) toast('Romaji needs the dictionary imported');
      }
      romajiCache.set(text, '');
      return '';
    }
  }

  async function renderRomaji(text) {
    const node = state.root && state.root.querySelector('#kotoba-romaji');
    if (!node) return;
    if (!text || state.settings.showRomaji === false) { node.textContent = ''; return; }

    const seq = ++romajiSeq;
    const cached = romajiCache.get(text);
    // Paint synchronously when cached, so prefetched lines never flicker.
    if (cached !== undefined) { node.textContent = cached; return; }

    node.textContent = '';
    const romaji = await romajiFor(text);
    if (seq === romajiSeq) node.textContent = romaji;
  }

  // Warm the next few cues while the current one is on screen.
  function prefetchRomaji(now) {
    if (state.settings.showRomaji === false) return;
    if (typeof state.jp.next !== 'function') return;   // older Track, nothing to warm
    let t = now;
    for (let n = 0; n < 4; n++) {
      const cue = state.jp.next(t);
      if (!cue) break;
      t = cue.start + state.jp.offset + 0.001;
      if (!romajiCache.has(cue.text)) romajiFor(cue.text);
    }
  }

  function renderJapanese(text) {
    const node = state.root.querySelector('#kotoba-jp');
    node.textContent = '';
    if (!text || state.settings.showJapanese === false) return;

    Array.from(text).forEach((ch, i) => {
      if (ch === '\n') { node.appendChild(document.createElement('br')); return; }
      const span = document.createElement('span');
      span.textContent = ch;
      span.dataset.i = String(i);
      if (K.isJapanese(ch)) {
        span.className = 'tok';
        span.addEventListener('mouseenter', () => onHover(text, i, span));
      }
      node.appendChild(span);
    });
  }

  let hoverSeq = 0;
  async function onHover(text, index, span) {
    const seq = ++hoverSeq;
    let result;
    try {
      result = await send({ type: 'lookup', text: text.slice(index) });
    } catch (e) {
      return K.warn('lookup failed', e);
    }
    if (seq !== hoverSeq) return;          // a later hover already superseded this
    if (!result) return hidePopup();
    highlight(index, result.length);
    showPopup(result, span);
  }

  function highlight(start, len) {
    state.root.querySelectorAll('#kotoba-jp .tok').forEach((el) => {
      const i = Number(el.dataset.i);
      el.classList.toggle('hit', i >= start && i < start + len);
    });
  }

  // Headword selection: an entry tagged "usually written in kana" should show
  // its reading, not its kanji. Otherwise こと displays as 事 and ください as
  // 下さい, neither of which is how you actually read them.
  const headword = (e, fallback) =>
    (e.uk ? (e.r && e.r[0]) : ((e.k && e.k[0]) || (e.r && e.r[0]))) || fallback;

  const badge = (e) =>
    e.f ? '#' + e.f : (e.c ? 'common' : '');

  function showPopup(result, anchor, primaryIndex) {
    const pop = state.root.querySelector('#kotoba-popup');
    const idx = primaryIndex || 0;
    const e = result.entries[idx];
    // Some surfaces are genuinely ambiguous. 行った is the past of both 行く
    // (to go) and 行う (to perform), spelled identically and both common; no
    // ranking can resolve that honestly. Show the alternates rather than
    // silently picking one.
    const others = result.entries.filter((_, i) => i !== idx).slice(0, 3);
    const b = badge(e);

    pop.innerHTML =
      '<div class="hdr">' +
        '<span class="term">' + esc(headword(e, result.matched)) + '</span>' +
        '<span class="reading">' + esc((e.r && e.r[0]) || '') + '</span>' +
        (b ? '<span class="freq">' + esc(b) + '</span>' : '') +
      '</div>' +
      (e.reason ? '<div class="reason">' + esc(result.matched) + ' &larr; ' + esc(e.reason) + '</div>' : '') +
      '<ol class="senses">' +
        e.s.slice(0, 4).map((s) =>
          '<li><span class="pos">' + esc((s.pos || []).join(', ')) + '</span>' +
          esc((s.g || []).join('; ')) + '</li>').join('') +
      '</ol>' +
      (others.length
        ? '<div class="alts">' + others.map((o) =>
            '<button class="alt" data-id="' + esc(o.id) + '">' +
              '<span class="alt-term">' + esc(headword(o, '')) + '</span>' +
              '<span class="alt-gloss">' + esc(((o.s[0] && o.s[0].g) || []).slice(0, 2).join('; ')) + '</span>' +
            '</button>').join('') + '</div>'
        : '') +
      '<button class="mine">Add to Anki</button>';

    pop.querySelector('.mine').onclick = () => mine(result, e);
    pop.querySelectorAll('.alt').forEach((btn) => {
      btn.onclick = () => {
        const i = result.entries.findIndex((x) => String(x.id) === btn.dataset.id);
        if (i >= 0) showPopup(result, anchor, i);
      };
    });

    pop.hidden = false;

    const a = anchor.getBoundingClientRect();
    pop.style.left = Math.max(8, Math.min(a.left, window.innerWidth - pop.offsetWidth - 16)) + 'px';
    // Flip below the line if there is not room above, which happens in the
    // 'top' position mode.
    const above = a.top - pop.offsetHeight - 12;
    pop.style.top = (above > 8 ? above : a.bottom + 12) + 'px';
  }

  function hidePopup() {
    if (!state.root) return;
    state.root.querySelector('#kotoba-popup').hidden = true;
    highlight(-1, 0);
  }

  async function mine(result, entry) {
    const word = headword(entry, result.matched);
    const reading = (entry.r && entry.r[0]) || '';
    const gloss = ((entry.s[0] && entry.s[0].g) || []).slice(0, 4).join('; ');
    const sentence = state.lastJp ? state.lastJp.text : '';
    const translation = state.lastEn ? state.lastEn.text : '';
    const romaji = romajiCache.get(sentence) || '';

    // Bold the target inside the sentence. Standard mining practice: the card
    // should show you which word you were actually stuck on, otherwise a
    // sentence card is ambiguous when several words are unfamiliar.
    const at = sentence.indexOf(result.matched);
    const sentenceHtml = at === -1
      ? esc(sentence)
      : esc(sentence.slice(0, at)) +
        '<b>' + esc(result.matched) + '</b>' +
        esc(sentence.slice(at + result.matched.length));

    const readingLine = reading && reading !== word
      ? '<span style="color:#888">' + esc(reading) + '</span>' : '';

    // Sentence-first is the immersion-learning default: you recall meaning from
    // context rather than from a bare headword, which is closer to how you will
    // actually meet the word again.
    const sentenceFirst = state.settings.cardStyle === 'sentence';

    const front = sentenceFirst
      ? sentenceHtml
      : esc(word) + (readingLine ? '<br>' + readingLine : '');

    const backParts = sentenceFirst
      ? [
          '<b>' + esc(word) + '</b> ' + readingLine,
          esc(gloss),
          '<hr>',
          romaji ? '<i style="color:#888">' + esc(romaji) + '</i>' : '',
          esc(translation),
        ]
      : [
          esc(gloss),
          '<hr>',
          sentenceHtml,
          romaji ? '<i style="color:#888">' + esc(romaji) + '</i>' : '',
          esc(translation),
        ];

    // Tag by series so a deck stays filterable back to where each word came from.
    const tags = ['kotoba', 'crunchyroll'];
    if (state.series) tags.push(state.series.replace(/[^a-z0-9]+/gi, '-').slice(0, 40));

    try {
      await send({
        type: 'ankiAdd',
        note: {
          deckName: state.settings.ankiDeck || 'Mining',
          modelName: state.settings.ankiModel || 'Basic',
          fields: {
            Front: front,
            Back: backParts.filter(Boolean).join('<br>'),
          },
          options: { allowDuplicate: false },
          tags,
        },
      });
      toast('Added: ' + word);
    } catch (e) {
      toast('Anki: ' + e.message);
    }
  }

  // --- sync ------------------------------------------------------------------

  async function persistOffset(offset) {
    if (!state.episode) return;
    await send({
      type: 'saveOffset', episode: state.episode, series: state.series, offset,
    }).catch((e) => K.warn('saveOffset failed', e));
  }

  // Page-level hotkeys. chrome.commands is unreliable here: a suggested binding
  // is silently dropped when it collides with something else, and on macOS the
  // Option-key combos also emit special characters. Plain keys on the page work
  // regardless of platform, and match what other tools in this space use.
  //
  // Guarded so they never fire while the user is typing into Crunchyroll's own
  // search box or any other field.
  function typingInField(target) {
    if (!target) return false;
    const tag = (target.tagName || '').toLowerCase();
    return tag === 'input' || tag === 'textarea' || tag === 'select'
        || target.isContentEditable;
  }

  const HOTKEYS = {
    s: () => doSnap(),
    z: (e) => doNudge(e.shiftKey ? -1 : -0.2),
    x: (e) => doNudge(e.shiftKey ? 1 : 0.2),
    h: () => {
      const jp = state.root && state.root.querySelector('#kotoba-jp');
      if (!jp) return;
      const hidden = jp.style.visibility === 'hidden';
      jp.style.visibility = hidden ? '' : 'hidden';
      toast(hidden ? 'Subtitles shown' : 'Subtitles hidden');
    },
    i: () => {
      state.settings.position = state.settings.position === 'top' ? 'bottom' : 'top';
      toast('Position: ' + state.settings.position);
    },
  };

  document.addEventListener('keydown', (e) => {
    if (!alive || !state.video) return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;   // leave modified combos alone
    if (typingInField(e.target)) return;

    const fn = HOTKEYS[e.key.toLowerCase()];
    if (!fn) return;
    e.stopPropagation();
    fn(e);
  }, true);

  function doSnap() {
    if (!state.jp.length) return toast('No Japanese track loaded');
    const r = state.jp.snapTo(state.video.currentTime);
    if (!r.applied) return toast('Not snapped: ' + r.reason);
    state.lastJp = null;                       // force a re-render at the new offset
    persistOffset(r.offset);
    toast('Snapped. Offset ' + (r.offset >= 0 ? '+' : '') + r.offset.toFixed(2) + 's');
  }

  function doNudge(delta) {
    const offset = state.jp.nudge(delta);
    state.lastJp = null;
    persistOffset(offset);
    toast('Offset ' + (offset >= 0 ? '+' : '') + offset.toFixed(2) + 's');
  }

  chrome.runtime.onMessage.addListener((msg) => {
    if (!state.video) return;   // the frame without the player ignores everything

    if (msg.type === 'selftest') {
      // Paint a known line straight into the overlay. If this shows up, the
      // rendering path is fine and the problem is cue data or timing.
      renderJapanese('日本語のテスト行');
      renderRomaji('日本語のテスト行');
      const en = state.root.querySelector('#kotoba-en');
      en.textContent = 'Overlay self-test. This should be visible.';
      en.classList.remove('blurred');
      state.lastJp = null;
      state.lastEn = null;
      toast('Self-test painted');
    }

    if (msg.type === 'align') {
      // On-demand alignment. Unlike autoAlign this runs even when an offset is
      // already set, because the user asked for it explicitly.
      if (!state.jp.length) return toast('No Japanese track loaded');
      if (!state.en.length) return toast('No Crunchyroll track to align against');

      const est = K.estimateOffset(state.jp, state.en);
      if (!est) {
        return toast('No clear match. Press S on a spoken line instead.');
      }
      state.jp.offset = est;
      state.lastJp = null;
      persistOffset(est);
      const pct = alignmentScore();
      toast('Aligned: ' + (est >= 0 ? '+' : '') + est.toFixed(2) + 's'
        + (pct !== null ? ' (' + pct + '% match)' : ''));
    }

    if (msg.type === 'snap') doSnap();
    if (msg.type === 'nudge') doNudge(msg.delta);
    if (msg.type === 'settings-changed') applySettings(msg.settings);
    if (msg.type === 'track-changed') loadSavedTrack();
  });

  // Font stacks. macOS ships Hiragino in all three flavours, so these resolve to
  // real Japanese faces rather than falling back to a Latin font with substituted
  // kanji, which is where mismatched stroke weights and wandering baselines come
  // from at subtitle sizes.
  const FAMILIES = {
    sans: "'Hiragino Sans', 'Hiragino Kaku Gothic ProN', 'Yu Gothic', " +
          "'Noto Sans JP', Meiryo, sans-serif",
    rounded: "'Hiragino Maru Gothic ProN', 'Rounded Mplus 1c', " +
             "'Noto Sans JP', 'Yu Gothic', sans-serif",
    serif: "'Hiragino Mincho ProN', 'Yu Mincho', 'Noto Serif JP', " +
           "'MS Mincho', serif",
  };

  function applySettings(s) {
    state.settings = s || {};
    if (state.root) {
      state.root.querySelector('#kotoba-en').style.display =
        s.showEnglish === false ? 'none' : '';
      state.root.querySelector('#kotoba-romaji').style.display =
        s.showRomaji === false ? 'none' : '';

      const root = state.root;
      root.style.setProperty('--kotoba-family', FAMILIES[s.fontFamily] || FAMILIES.sans);
      root.style.setProperty('--kotoba-weight', s.bold === false ? '400' : '600');
      root.style.setProperty('--kotoba-backdrop',
        s.backdrop ? 'rgba(0, 0, 0, 0.55)' : 'transparent');

      // Re-render the current line so a toggle takes effect immediately.
      state.lastJp = null;
    }
  }

  let toastTimer;
  function toast(text) {
    if (!state.root) return;
    const el = state.root.querySelector('#kotoba-toast');
    el.textContent = text;
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.hidden = true; }, 2400);
  }

  const esc = (s) => String(s).replace(/[<>&"]/g, (c) =>
    ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]));

  // --- boot ------------------------------------------------------------------

  K.log('bridge booting in', location.host);
  send({ type: 'settings' })
    .then((d) => applySettings(d.settings))
    .catch((e) => { K.warn('settings failed', e); applySettings({}); })
    .finally(watchForVideo);
})(globalThis.Kotoba);
