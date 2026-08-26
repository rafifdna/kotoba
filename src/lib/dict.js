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

// JMdict in the extension origin's IndexedDB, owned by the service worker.
// Content scripts query it by message rather than each holding a copy.
//
// Entry shape from tools/build-dict.mjs:
//   { id, k:[kanji], r:[readings], s:[{pos:[], g:[glosses]}], f: freqRank }

(function (K) {
  const DB_NAME = 'kotoba';
  const STORE = 'entries';
  let dbPromise = null;

  function openDB() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE)) {
          const store = db.createObjectStore(STORE, { keyPath: 'id' });
          // multiEntry so one entry is reachable from every surface form.
          store.createIndex('forms', 'forms', { multiEntry: true });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return dbPromise;
  }

  async function importEntries(entries) {
    const db = await openDB();
    const CHUNK = 5000;
    // The first line of a built dictionary is an attribution/metadata record
    // with no id. Filter anything that is not a real entry.
    const real = entries.filter((e) => e && e.id && (e.k || e.r));
    for (let i = 0; i < real.length; i += CHUNK) {
      const slice = real.slice(i, i + CHUNK);
      await new Promise((resolve, reject) => {
        const t = db.transaction(STORE, 'readwrite');
        const store = t.objectStore(STORE);
        for (const e of slice) {
          const forms = [].concat(e.k || [], e.r || []).map(K.normalize);
          store.put(Object.assign({}, e, { forms: Array.from(new Set(forms)) }));
        }
        t.oncomplete = resolve;
        t.onerror = () => reject(t.error);
      });
    }
  }

  async function count() {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const req = db.transaction(STORE, 'readonly').objectStore(STORE).count();
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  async function clear() {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const req = db.transaction(STORE, 'readwrite').objectStore(STORE).clear();
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
  }

  async function byForm(form) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const req = db.transaction(STORE, 'readonly').objectStore(STORE)
        .index('forms').getAll(form);
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => reject(req.error);
    });
  }

  // Reject a hit whose part of speech cannot produce the conjugation we unwound.
  // Without this an unrelated noun sharing a stem outranks the verb you meant.
  function posCompatible(entry, cand) {
    if (!cand.chain.length) return true;
    const pos = (entry.s || []).reduce((acc, s) => acc.concat(s.pos || []), []).join(' ');
    if (!pos) return true;
    const w = cand.types;
    return (w.includes('v1') && /\bv1\b/.test(pos))
      || (w.includes('v5') && /\bv5/.test(pos))
      || (w.includes('vs') && /\bvs/.test(pos))
      || (w.includes('vk') && /\bvk\b/.test(pos))
      || (w.includes('adj-i') && /adj-i/.test(pos));
  }

  // Longest-prefix lookup from the cursor. Given 見つけてしまうだなんて this tries
  // the 12-char prefix, then 11, and so on, deinflecting each. The first length
  // that yields hits wins, which is why it resolves 見つける rather than stopping
  // at 見.
  async function lookupAt(text, maxLength = 12) {
    const slice = String(text).slice(0, maxLength);

    for (let len = slice.length; len > 0; len--) {
      const surface = slice.slice(0, len);
      const hits = [];

      for (const cand of K.deinflect(K.normalize(surface))) {
        for (const e of await byForm(cand.term)) {
          if (!posCompatible(e, cand)) continue;
          hits.push(Object.assign({}, e, {
            reason: cand.chain.join(' < '),
            base: cand.term,
          }));
        }
      }

      if (hits.length) {
        // Sort by the weight computed at build time: common forms first, with
        // archaic and rare-only entries pushed to the back.
        //
        // The kana adjustment breaks homophone ties that weight alone cannot.
        // こと matches both 事 and 琴, and both are common; but 事 is tagged
        // "usually written in kana", so a kana surface almost certainly means
        // that one rather than the zither.
        const kanaSurface = /^[\u3040-\u309f\u30a0-\u30ff\u30fc]+$/.test(surface);
        const weight = (h) => {
          const base = h.w ?? h.f ?? 1e9;
          return kanaSurface && h.uk ? base - 500 : base;
        };
        hits.sort((a, b) => weight(a) - weight(b));
        const seen = new Set();
        const unique = hits.filter((h) => (seen.has(h.id) ? false : (seen.add(h.id), true)));
        return { matched: surface, length: len, entries: unique.slice(0, 8) };
      }
    }
    return null;
  }

  K.dict = { importEntries, count, clear, lookupAt };
})(globalThis.Kotoba);
