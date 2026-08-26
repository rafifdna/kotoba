#!/usr/bin/env node
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

// Build the compact JSONL dictionary the extension imports.
//
//   node --max-old-space-size=3000 tools/build-dict.mjs jmdict-eng.json dict.jsonl [freq.txt]
//
// Source: jmdict-simplified releases (scriptin/jmdict-simplified), "jmdict-eng"
// or "jmdict-eng-common". JMdict is CC BY-SA 4.0 from the EDRDG; the attribution
// record written at the top of the output satisfies that.
//
// RANKING. jmdict-simplified drops JMdict's nfXX frequency bands and keeps only
// a boolean `common`, so there is no true frequency ordering in the data. But
// the problem frequency was meant to solve is "the first gloss shown is an
// obscure archaic sense", and JMdict labels those directly. Demoting on
// arch / rare / hist / obs addresses that far more precisely than a coarse
// frequency proxy would. Supply a real frequency list as the third argument if
// you have one and it overrides the derived weight.

import { readFileSync, createWriteStream } from 'node:fs';

const [, , input, output, freqFile] = process.argv;
if (!input || !output) {
  console.error('usage: build-dict.mjs <jmdict-eng.json> <out.jsonl> [freq.txt]');
  process.exit(1);
}

const freq = new Map();
if (freqFile) {
  readFileSync(freqFile, 'utf8').split('\n').forEach((line, i) => {
    const term = line.trim().split(/\s+/)[0];
    if (term && !freq.has(term)) freq.set(term, i + 1);
  });
  console.error(`loaded ${freq.size} frequency ranks`);
}

// Lower sorts first. The gaps are wide so a penalty cannot accidentally promote
// an entry past a whole tier.
const W_COMMON = 1000;
const W_NORMAL = 500000;
const P_DATED_FIRST = 100000;    // leading sense is archaic / rare / historical
const P_ALL_DATED   = 1000000;   // every sense is
const P_UNC         = 50000;     // pos 'unc', usually punctuation or fragments

const DATED = /^(arch|obs|obsc|rare|hist)$/;
const isDated = (s) => (s.misc || []).some((m) => DATED.test(m));

// sK / sk are search-only forms: spellings recorded so lookups resolve but that
// nobody writes. Keep them out of the display list. rK / rk are rarely-used
// forms: searchable, but never the headword, so they sort to the back.
function forms(list, rareTag, searchOnlyTag) {
  const usable = (list || []).filter((x) => !(x.tags || []).includes(searchOnlyTag));
  const common = usable.filter((x) => x.common && !(x.tags || []).includes(rareTag));
  const plain  = usable.filter((x) => !x.common && !(x.tags || []).includes(rareTag));
  const rare   = usable.filter((x) => (x.tags || []).includes(rareTag));
  return common.concat(plain, rare).map((x) => x.text);
}

const raw = JSON.parse(readFileSync(input, 'utf8'));
const out = createWriteStream(output);

out.write(JSON.stringify({
  _source: 'JMdict via jmdict-simplified',
  _version: raw.version,
  _date: raw.dictDate,
  _licence: 'JMdict is the property of the Electronic Dictionary Research and Development Group, used under CC BY-SA 4.0',
}) + '\n');

let written = 0, commonCount = 0;

for (const entry of raw.words) {
  const k = forms(entry.kanji, 'rK', 'sK');
  const r = forms(entry.kana, 'rk', 'sk');
  if (!k.length && !r.length) continue;

  const senses = (entry.sense || [])
    .map((s) => ({
      pos: s.partOfSpeech || [],
      g: (s.gloss || []).map((g) => g.text).filter(Boolean),
      dated: isDated(s),
      uk: (s.misc || []).includes('uk'),
    }))
    .filter((s) => s.g.length);
  if (!senses.length) continue;

  // Current senses ahead of dated ones, order preserved within each group, so
  // the leading gloss is the one a learner actually wants.
  const ordered = senses.filter((s) => !s.dated).concat(senses.filter((s) => s.dated));

  const common = (entry.kanji || []).some((x) => x.common)
              || (entry.kana  || []).some((x) => x.common);

  let w = common ? W_COMMON : W_NORMAL;
  if (ordered[0].dated) w += P_DATED_FIRST;
  if (ordered.every((s) => s.dated)) w += P_ALL_DATED;
  if (ordered[0].pos.includes('unc')) w += P_UNC;

  let f;
  for (const form of k.concat(r)) {
    const rank = freq.get(form);
    if (rank && (f === undefined || rank < f)) f = rank;
  }
  if (f !== undefined) w = f;   // a real rank beats every derived signal

  const rec = { id: entry.id, k, r, s: ordered.map((s) => ({ pos: s.pos, g: s.g })), w };
  if (common) { rec.c = 1; commonCount++; }
  if (f !== undefined) rec.f = f;
  // Usually written in kana: the headword should be the reading, not the kanji,
  // which is what makes ある / いる / こと display the way you actually read them.
  if (ordered[0].uk) rec.uk = 1;

  out.write(JSON.stringify(rec) + '\n');
  written++;
}

out.end(() => console.error(`wrote ${written} entries (${commonCount} common) to ${output}`));
