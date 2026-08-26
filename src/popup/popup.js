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

const send = (msg) =>
  chrome.runtime.sendMessage(msg).then((r) => {
    if (!r || !r.ok) throw new Error((r && r.error) || 'no response');
    return r.data;
  });

const $ = (id) => document.getElementById(id);

let tab = null;
let ctx = { episode: null, series: null, title: '' };
let settings = {};

async function init() {
  [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

  try {
    // Pass the URL explicitly: messages from a popup carry no sender.tab.
    ctx = await send({ type: 'context', url: tab && tab.url, tabId: tab && tab.id });
  } catch { /* background may be cold; the fields just stay empty */ }

  if (ctx.episode) {
    $('episode').textContent = ctx.episode.replace('cr:', 'Episode ') +
      (ctx.title ? ' — ' + ctx.title : '');
    $('search-title').value = ctx.title || '';
    if (ctx.episodeNumber) $('search-ep').value = ctx.episodeNumber;
    // If the title came from the URL slug rather than the page, it is the
    // EPISODE name and will not match anything on jimaku. Say so plainly
    // instead of letting the user burn a search on it.
    if (!ctx.fromDom) {
      setStatus('Could not read the show name from the page. Type the series title.', true);
    }
  }

  const s = await send({ type: 'settings' });
  settings = s.settings;

  for (const k of ['showJapanese', 'showRomaji', 'showEnglish', 'blurEnglish',
                   'pauseOnHover', 'bold', 'backdrop', 'stripCC']) {
    $(k).checked = !!settings[k];
    $(k).addEventListener('change', saveSettings);
  }
  $('position').value = settings.position || 'bottom';
  $('position').addEventListener('change', saveSettings);
  $('fontFamily').value = settings.fontFamily || 'sans';
  $('fontFamily').addEventListener('change', saveSettings);
  $('cardStyle').value = settings.cardStyle || 'sentence';
  $('cardStyle').addEventListener('change', saveSettings);

  // 'input' rather than 'change' so dragging the slider updates the video live,
  // which is the only way to judge a subtitle size.
  $('fontSize').value = settings.fontSize || 24;
  $('size-val').textContent = settings.fontSize || 24;
  $('fontSize').addEventListener('input', () => {
    $('size-val').textContent = $('fontSize').value;
    saveSettings();
  });
  for (const k of ['jimakuKey', 'ankiDeck', 'ankiModel']) {
    $(k).value = settings[k] || '';
    // 'input' as well as 'change': a pasted key should commit immediately rather
    // than waiting for the field to lose focus.
    $(k).addEventListener('change', saveSettings);
    $(k).addEventListener('input', debounce(saveSettings, 400));
  }

  if (ctx.episode) {
    const { track, offset } = await send({
      type: 'loadTrack', episode: ctx.episode, series: ctx.series,
    });
    $('track-status').textContent = track ? track.filename : 'None loaded';
    $('track-status').className = 'status' + (track ? ' good' : '');
    $('offset').value = offset || 0;
  }

  refreshDict();
  refreshAlignment();
  wireDrop();
  wireOffset();
  wireDict();
  wireSearch();
  $('diag-btn').onclick = showDiagnostics;
  $('selftest-btn').onclick = () => {
    notify({ type: 'selftest' });
    setStatus('Painted a test line. Close the popup and look at the video.');
  };
}

async function saveSettings() {
  settings = Object.assign({}, settings, {
    showJapanese: $('showJapanese').checked,
    showRomaji: $('showRomaji').checked,
    showEnglish: $('showEnglish').checked,
    blurEnglish: $('blurEnglish').checked,
    pauseOnHover: $('pauseOnHover').checked,
    bold: $('bold').checked,
    backdrop: $('backdrop').checked,
    stripCC: $('stripCC').checked,
    cardStyle: $('cardStyle').value,
    position: $('position').value,
    fontSize: Number($('fontSize').value) || 24,
    fontFamily: $('fontFamily').value,
    jimakuKey: $('jimakuKey').value.trim(),
    ankiDeck: $('ankiDeck').value.trim() || 'Mining',
    ankiModel: $('ankiModel').value.trim() || 'Basic',
  });
  await chrome.storage.local.set({ settings });
  notify({ type: 'settings-changed', settings });
  // Re-parse the track so a stripCC change applies to the current episode.
  notify({ type: 'track-changed' });
}

const notify = (msg) =>
  tab && tab.id && chrome.tabs.sendMessage(tab.id, msg).catch(() => {});

function debounce(fn, ms) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

// --- diagnostics -------------------------------------------------------------
// Content scripts report their state to the background continuously. Reading it
// here beats hunting through the devtools context dropdown to find out which
// frame actually holds the player.

async function showDiagnostics() {
  const pre = $('diag');
  pre.hidden = false;
  pre.textContent = 'Collecting…';

  try {
    const d = await send({ type: 'diagnostics' });
    if (!d.frames.length) {
      pre.textContent =
        'No content-script frames reporting.\n\n' +
        'The scripts are not running on this page at all. Reload the extension\n' +
        'on brave://extensions, then hard-refresh the Crunchyroll tab.';
      return;
    }
    pre.textContent = d.frames.map((f) =>
      [
        'host        ' + f.host,
        'frameId     ' + f.frameId,
        'video       ' + (f.hasVideo ? 'yes' : 'no'),
        'overlay     ' + (f.overlay ? 'built' : 'not built'),
        'fetch hook  ' + (f.hooked ? 'installed' : 'MISSING'),
        'assets seen ' + f.assetsSeen,
        'cr tracks   ' + (f.crTracks && f.crTracks.length
          ? f.crTracks.join(', ')
          : 'none listed in play config'),
        'jp / en     ' + f.jpCues + ' / ' + f.enCues + ' cues',
        'episode     ' + (f.episode || '?'),
        'track       ' + (f.trackLabel || '?'),
        'jp on screen ' + (f.jpNow || '?'),
        'alignment   ' + (f.alignment === null || f.alignment === undefined
          ? 'n/a'
          : f.alignment + '% of English lines have a Japanese line'
            + (f.alignment < 50 ? '  <- MISALIGNED, press S on a spoken line' : '')),
        (f.renderErrors
          ? 'RENDER ERRS ' + f.renderErrors + ' - ' + f.lastRenderError
          : 'render      ok'),
        'offset      ' + f.offset + 's',
        (f.assetsSeen === 0 && f.net && f.net.length
          ? '\nno subtitle asset matched. recent requests:\n  ' + f.net.join('\n  ')
          : ''),
      ].filter(Boolean).join('\n')
    ).join('\n\n') + '\n\ndictionary  ' + d.dict.toLocaleString() + ' entries';
  } catch (e) {
    pre.textContent = 'Diagnostics failed: ' + e.message;
  }
}

// --- jimaku ------------------------------------------------------------------

function wireSearch() {
  $('search-btn').onclick = async () => {
    const title = $('search-title').value.trim();
    const episode = Number($('search-ep').value) || 1;
    if (!title) return setStatus('Enter a title to search', true);

    $('search-btn').disabled = true;
    setStatus('Searching jimaku…');
    $('files').innerHTML = '';

    try {
      const { entries } = await send({ type: 'jimakuSearch', title });
      if (!entries.length) {
        return setStatus('No entry found. Try the Japanese or romaji title.', true);
      }
      // First hit is nearly always right; jimaku ranks by relevance.
      const entry = entries[0];
      setStatus('Matched "' + (entry.name || entry.english_name || entry.id) + '"');

      const { files } = await send({
        type: 'jimakuFiles', entryId: entry.id, episode,
      });
      if (!files.length) return setStatus('Entry found but no files for that episode', true);
      renderFiles(files);
    } catch (e) {
      setStatus(e.message, true);
    } finally {
      $('search-btn').disabled = false;
    }
  };
}

function renderFiles(files) {
  const ul = $('files');
  ul.innerHTML = '';
  for (const f of files) {
    const li = document.createElement('li');
    for (const t of f.tags) {
      const tag = document.createElement('span');
      tag.className = 'tag' + (t === 'BD' ? ' bd' : '');
      tag.textContent = t;
      li.appendChild(tag);
    }
    const name = document.createElement('span');
    name.className = 'fname';
    name.textContent = f.name;
    li.appendChild(name);

    li.onclick = () => useFile(f);
    ul.appendChild(li);
  }
  setStatus(files.length + ' files. WEB-tagged ones align best with Crunchyroll.');
}

async function useFile(f) {
  if (!ctx.episode) return setStatus('Open a Crunchyroll episode first', true);
  setStatus('Downloading ' + f.name + '…');
  try {
    await send({
      type: 'jimakuFetch', url: f.url, filename: f.name, episode: ctx.episode,
    });
    $('track-status').textContent = f.name;
    $('track-status').className = 'status good';
    notify({ type: 'track-changed' });
    setStatus('Loaded. Press Alt+S on a spoken line to sync.');
  } catch (e) {
    setStatus(e.message, true);
  }
}

function setStatus(text, bad) {
  const el = $('track-status');
  el.textContent = text;
  el.className = 'status' + (bad ? ' bad' : '');
}

// --- manual file, offset, dictionary -----------------------------------------

function wireDrop() {
  const drop = $('drop');
  const input = $('file');
  drop.onclick = () => input.click();
  input.onchange = () => input.files[0] && loadFile(input.files[0]);

  ['dragenter', 'dragover'].forEach((e) =>
    drop.addEventListener(e, (ev) => { ev.preventDefault(); drop.classList.add('over'); }));
  ['dragleave', 'drop'].forEach((e) =>
    drop.addEventListener(e, () => drop.classList.remove('over')));
  drop.addEventListener('drop', (ev) => {
    ev.preventDefault();
    const f = ev.dataTransfer && ev.dataTransfer.files[0];
    if (f) loadFile(f);
  });
}

async function loadFile(file) {
  if (!ctx.episode) return setStatus('Open a Crunchyroll episode first', true);
  const text = await file.text();
  await send({ type: 'saveTrack', episode: ctx.episode, filename: file.name, text });
  $('track-status').textContent = file.name;
  $('track-status').className = 'status good';
  notify({ type: 'track-changed' });
}

function wireOffset() {
  const apply = async (offset) => {
    if (!ctx.episode) return;
    const rounded = Math.round(offset * 1000) / 1000;
    $('offset').value = rounded;
    await send({
      type: 'saveOffset', episode: ctx.episode, series: ctx.series, offset: rounded,
    });
    notify({ type: 'track-changed' });
  };
  // Mouse fallback for the S hotkey. Timing by click is as precise as by
  // keypress, and this works even if the popup is the only thing focused.
  $('snap').onclick = async () => {
    notify({ type: 'snap' });
    // Give the content script a moment to persist, then re-read the offset.
    setTimeout(async () => {
      if (!ctx.episode) return;
      const { offset } = await send({
        type: 'loadTrack', episode: ctx.episode, series: ctx.series,
      });
      $('offset').value = offset || 0;
    }, 250);
  };

  $('align').onclick = async () => {
    notify({ type: 'align' });
    setTimeout(refreshAlignment, 400);
  };

  $('back').onclick = () => apply(Number($('offset').value) - 0.2);
  $('fwd').onclick = () => apply(Number($('offset').value) + 0.2);
  $('offset').onchange = () => apply(Number($('offset').value));
}

// Show alignment health in the popup itself, not buried in Diagnose. This is
// the number that decides whether the Japanese line will ever appear.
async function refreshAlignment() {
  try {
    const d = await send({ type: 'diagnostics' });
    const f = (d.frames || []).find((x) => x.hasVideo);
    if (!f) return;
    if (ctx.episode) {
      const { offset } = await send({
        type: 'loadTrack', episode: ctx.episode, series: ctx.series,
      });
      $('offset').value = offset || 0;
    }
    const el = $('align-status');
    if (f.alignment === null || f.alignment === undefined) {
      el.textContent = f.jpCues
        ? 'Waiting for Crunchyroll\u2019s track to compare against'
        : 'No Japanese track loaded';
      el.className = 'status';
    } else if (f.alignment < 50) {
      el.textContent = 'Out of sync: only ' + f.alignment +
        '% of lines match. Press S on a spoken line.';
      el.className = 'status bad';
    } else {
      el.textContent = 'In sync: ' + f.alignment + '% of lines match.';
      el.className = 'status good';
    }
  } catch { /* background cold, leave it blank */ }
}

async function refreshDict() {
  try {
    const { count } = await send({ type: 'dictStatus' });
    $('dict-status').textContent = count
      ? count.toLocaleString() + ' dictionary entries'
      : 'No dictionary yet. Click Import JMdict and pick dict/dict-common.jsonl';
    $('dict-status').className = 'status' + (count ? ' good' : '');
  } catch {
    $('dict-status').textContent = 'Dictionary unavailable';
  }
}

function wireDict() {
  $('dict-import').onclick = () => $('dict-file').click();
  $('dict-clear').onclick = async () => { await send({ type: 'clearDict' }); refreshDict(); };

  $('dict-file').onchange = async () => {
    const file = $('dict-file').files[0];
    if (!file) return;
    $('dict-status').textContent = 'Reading…';
    const text = await file.text();
    // JSONL keeps peak memory well under a single 300MB JSON.parse, which is
    // what makes this survivable inside a popup.
    const entries = text.split('\n').filter(Boolean).map((l) => JSON.parse(l));
    $('dict-status').textContent = 'Importing ' + entries.length.toLocaleString() + '…';
    await send({ type: 'importDict', entries });
    refreshDict();
  refreshAlignment();
  };
}

init();
