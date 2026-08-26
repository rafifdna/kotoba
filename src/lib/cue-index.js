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

// A track queried once per animation frame. Linear scanning a 1200-cue ASS file
// at 60fps is wasteful, so index start times once and binary search.

(function (K) {
  class Track {
    constructor(cues = [], opts = {}) {
      this.cues = cues;
      this.starts = cues.map((c) => c.start);
      this.offset = opts.offset || 0;   // seconds; positive means the file runs late
      this.label = opts.label || '';
    }

    get length() { return this.cues.length; }

    // Largest index whose start <= t, or -1.
    _floor(t) {
      let lo = 0, hi = this.starts.length - 1, ans = -1;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (this.starts[mid] <= t) { ans = mid; lo = mid + 1; } else { hi = mid - 1; }
      }
      return ans;
    }

    at(t) {
      const time = t - this.offset;
      const i = this._floor(time);
      if (i === -1) return null;
      // Walk back a few: ASS stacks signs over dialogue, so the newest start is
      // not always the one still on screen.
      for (let k = i; k >= 0 && k > i - 8; k--) {
        const c = this.cues[k];
        if (time >= c.start && time <= c.end) return c;
      }
      return null;
    }

    // The cue on screen now, or the next one coming up. This is what snap-sync
    // anchors to: when you press the key at the instant a line is spoken, the
    // line you meant is either showing or about to.
    currentOrNext(t) {
      const time = t - this.offset;
      const cur = this.at(t);
      if (cur) return cur;
      const i = this._floor(time);
      return this.cues[i + 1] || null;
    }

    // The cue after the given time, and the one before. Used by the romaji
    // prefetcher to warm upcoming lines. These were dropped during the rewrite
    // to classic scripts while a caller still depended on next(), which threw
    // inside the render loop and killed it.
    next(t) {
      const i = this._floor(t - this.offset);
      return this.cues[i + 1] || null;
    }

    prev(t) {
      const i = this._floor(t - this.offset);
      return this.cues[Math.max(0, i - 1)] || null;
    }

    nudge(delta) {
      this.offset = K.round(this.offset + delta);
      return this.offset;
    }

    // Snap-sync. Press at the moment a line is spoken and the whole file shifts
    // so that line starts now. One keypress replaces a dozen 100ms nudges, and
    // it is the single biggest usability difference in a tool like this.
    //
    // Returns { offset, applied, reason }. The guard matters: pressing snap
    // during a long silent stretch anchors to a cue that may be a minute away,
    // which silently destroys a good offset. Anything beyond maxJump is almost
    // certainly a mistimed keypress rather than an intended correction.
    snapTo(playerTime, maxJump = 12) {
      const cue = this.currentOrNext(playerTime);
      if (!cue) return { offset: this.offset, applied: false, reason: 'no cue to anchor' };

      const candidate = K.round(playerTime - cue.start);
      if (Math.abs(candidate - this.offset) > maxJump) {
        return {
          offset: this.offset,
          applied: false,
          reason: 'nearest line is ' + Math.abs(candidate - this.offset).toFixed(1) + 's away',
        };
      }

      this.offset = candidate;
      return { offset: candidate, applied: true, reason: '' };
    }
  }

  // Estimate the constant shift between a track and a timing reference.
  //
  // The obvious approach, matching each cue to its nearest neighbour and taking
  // the median delta, fails precisely when it matters: once the shift exceeds
  // the gap between cues, every cue's "nearest" neighbour is a different line
  // and the deltas collapse toward zero. A 12s shift on 5s-spaced dialogue
  // estimates as roughly nothing.
  //
  // So score every pair instead. Bin the pairwise deltas and take the peak: the
  // true shift is the one value that lines up many cues at once, and unrelated
  // pairs spread themselves thinly across every other bin.
  function estimateOffset(target, reference, opts) {
    const o = opts || {};
    const maxShift = o.maxShift || 120;   // seconds
    const bin = o.bin || 0.2;    // wide enough to hold a jittery peak in one bin
    const minConfidence = o.minConfidence || 0.35;

    const a = target.cues.slice(0, 200).map((c) => c.start);
    const b = reference.cues.slice(0, 200).map((c) => c.start);
    if (a.length < 8 || b.length < 8) return 0;

    const hist = new Map();
    for (const x of a) {
      for (const y of b) {
        // reference minus target: Track.at() renders a cue at cue.start +
        // offset, so a file running late needs a NEGATIVE offset to pull it
        // back. Computing this the other way round shifts subtitles further
        // out of sync by exactly twice the error.
        const d = y - x;
        if (Math.abs(d) > maxShift) continue;
        const k = Math.round(d / bin);
        hist.set(k, (hist.get(k) || 0) + 1);
      }
    }
    if (!hist.size) return 0;

    // Smooth across adjacent bins so a peak split by rounding is not missed.
    let bestK = null;
    let bestCount = 0;
    for (const [k] of hist) {
      let smoothed = 0;
      for (let d = -2; d <= 2; d++) smoothed += hist.get(k + d) || 0;
      if (smoothed > bestCount) { bestCount = smoothed; bestK = k; }
    }
    if (bestK === null) return 0;

    // Confidence: what share of the shorter track the peak accounts for. Two
    // unrelated tracks produce a flat histogram and no peak clears this, which
    // is what stops a wrong episode's file being auto-aligned to nonsense.
    const confidence = bestCount / Math.min(a.length, b.length);
    if (confidence < minConfidence) return 0;

    // Refine: average the actual deltas inside the winning peak rather than
    // returning the bin centre, which recovers sub-bin precision.
    const lo = (bestK - 2) * bin;
    const hi = (bestK + 2) * bin;
    let sum = 0;
    let n = 0;
    for (const x of a) {
      for (const y of b) {
        const d = y - x;
        if (d >= lo && d <= hi) { sum += d; n++; }
      }
    }
    return n ? K.round(sum / n) : K.round(bestK * bin);
  }

  K.Track = Track;
  K.estimateOffset = estimateOffset;
})(globalThis.Kotoba);
