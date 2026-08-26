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

// Parsers for ASS, SRT and WebVTT. Classic script; attaches to Kotoba.
// Every parser returns [{ start, end, text, style }] sorted by start,
// with seconds as floats and \n for hard line breaks.

(function (K) {
  const num = (s) => Number(s) || 0;

  function assTime(t) {
    const m = /^(\d+):(\d{2}):(\d{2})[.,](\d{1,3})$/.exec(String(t).trim());
    if (!m) return 0;
    const frac = m[4].length === 2 ? num(m[4]) / 100 : num(m[4]) / 1000;
    return num(m[1]) * 3600 + num(m[2]) * 60 + num(m[3]) + frac;
  }

  function assText(raw) {
    return String(raw)
      .replace(/\{[^}]*\}/g, '')
      .replace(/\\N/g, '\n')
      .replace(/\\n/g, '\n')
      .replace(/\\h/g, '\u00a0')
      .trim();
  }

  function parseASS(src) {
    const cues = [];
    let inEvents = false;
    let fields = null;

    for (const line of src.split(/\r?\n/)) {
      if (/^\s*\[/.test(line)) {
        inEvents = /^\s*\[events\]/i.test(line);
        fields = null;
        continue;
      }
      if (!inEvents) continue;

      // Column order comes from the Format: line. Encoders reorder these, and a
      // hardcoded index silently yields style names where text was expected.
      if (/^\s*Format\s*:/i.test(line)) {
        fields = line.slice(line.indexOf(':') + 1).split(',').map((f) => f.trim().toLowerCase());
        continue;
      }
      if (!/^\s*Dialogue\s*:/i.test(line) || !fields) continue;

      const body = line.slice(line.indexOf(':') + 1);
      const parts = body.split(',');
      const head = parts.slice(0, fields.length - 1).map((p) => p.trim());
      const tail = parts.slice(fields.length - 1).join(',');   // text may contain commas
      const row = {};
      fields.forEach((f, i) => (row[f] = i === fields.length - 1 ? tail : head[i]));

      const text = assText(row.text ?? '');
      if (!text) continue;
      cues.push({
        start: assTime(row.start ?? '0:00:00.00'),
        end: assTime(row.end ?? '0:00:00.00'),
        text,
        style: row.style ?? '',
      });
    }
    return finish(cues);
  }

  function clockTime(t) {
    const m = /^(?:(\d+):)?(\d{1,2}):(\d{2})[.,](\d{1,3})$/.exec(String(t).trim());
    if (!m) return 0;
    return num(m[1]) * 3600 + num(m[2]) * 60 + num(m[3]) + num(m[4]) / 1000;
  }

  function parseBlocks(src) {
    const cues = [];
    for (const block of src.replace(/^\uFEFF/, '').split(/\r?\n\r?\n+/)) {
      const rows = block.split(/\r?\n/).filter(Boolean);
      const ti = rows.findIndex((r) => r.includes('-->'));
      if (ti === -1) continue;

      const parts = rows[ti].split('-->');
      // Trim BEFORE splitting on whitespace. " 00:00:15,100" starts with a
      // space, so .split(/\s+/)[0] returns an empty string rather than the
      // timestamp, and every end time silently parses as 0. A cue with end 0
      // can never be active, which killed every SRT track without any error.
      const start = clockTime(String(parts[0] || '').trim());
      const end = clockTime(String(parts[1] || '').trim().split(/\s+/)[0]);

      const text = rows.slice(ti + 1).join('\n').replace(/<[^>]+>/g, '').trim();
      if (!text) continue;

      // Defensive: a malformed or unparsed end time degrades to a readable
      // duration instead of a cue that never shows.
      cues.push({ start, end: end > start ? end : start + 2.5, text, style: '' });
    }
    return finish(cues);
  }

  // ASS routinely stacks signs, credits and karaoke on overlapping timings.
  // Collapse exact duplicates so the overlay does not render three copies.
  function finish(cues) {
    const seen = new Set();
    const out = [];
    for (const c of cues.sort((x, y) => x.start - y.start || x.end - y.end)) {
      const key = c.start.toFixed(2) + '|' + c.end.toFixed(2) + '|' + c.text;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(c);
    }
    return out;
  }

  K.parse = function (src, filename = '') {
    if (/^\s*(\[Script Info\]|\[V4\+? Styles\])/i.test(src) || /\.(ass|ssa)$/i.test(filename)) {
      return parseASS(src);
    }
    if (/^\s*WEBVTT/.test(src) || /\.vtt$/i.test(filename)) return parseBlocks(src);
    return parseBlocks(src);
  };

  // Closed-caption tracks carry annotations that are not dialogue. Netflix ja[cc]
  // in particular prefixes lines with the speaker's name in parentheses, so
  // （真樹）うんうん is the character Maki saying うんうん. Left in, that label is
  // romanised as if it were words (真樹 segments to 真 + 樹, "shin ki", when the
  // name reads "Maki"), and hovering it returns a dictionary entry for a kanji
  // that means nothing in context.
  //
  // Length limits matter: a genuine parenthetical aside in dialogue is usually
  // longer than a name, so capping the match keeps real content intact.
  K.stripCC = function (text) {
    return String(text)
      .split('\n')
      .map((line) => line
        .replace(/^[（(][^）)]{1,10}[）)]\s*/, '')        // leading speaker label
        .replace(/^[〔\[［][^〕\]］]{1,14}[〕\]］]\s*/, '')  // bracketed sound cue
        .replace(/[♪♬][\s~〜～]*/g, '')                   // music markers
        .trim())
      .filter(Boolean)
      .join('\n')
      .trim();
  };

  // Apply to a whole track, dropping cues that were nothing but annotation.
  K.stripTrackCC = function (cues) {
    const out = [];
    for (const c of cues) {
      const text = K.stripCC(c.text);
      if (text) out.push(Object.assign({}, c, { text }));
    }
    return out;
  };

  // Tells a real Japanese track apart from Crunchyroll's English translation.
  K.japaneseRatio = function (cues) {
    const sample = cues.slice(0, 200).map((c) => c.text).join('');
    if (!sample) return 0;
    const jp = sample.match(/[\u3040-\u30ff\u4e00-\u9fff]/g);
    return (jp ? jp.length : 0) / sample.length;
  };

  // Signs, songs and typesetting live in named styles. Dropping them makes the
  // track far cleaner. Bail out if the filter would eat most of the file, which
  // means the style names did not follow the usual convention.
  K.dialogueOnly = function (cues) {
    const noise = /sign|song|title|credit|caption|karaoke|note|\bop\b|\bed\b/i;
    const kept = cues.filter((c) => !noise.test(c.style || ''));
    return kept.length > cues.length * 0.3 ? kept : cues;
  };
})(globalThis.Kotoba);
