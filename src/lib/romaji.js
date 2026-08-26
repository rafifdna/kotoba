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

// Kana to romaji, and reading reconstruction for inflected surfaces.
//
// Straight Hepburn with doubled vowels rather than macrons: ほんとう becomes
// "hontou", not "hontō". Macrons look tidier but they throw away which kana
// produced them, and for someone reading along with the kana line a reversible
// transliteration is more useful than a typographically correct one.

(function (K) {
  const DIGRAPHS = {
    きゃ:'kya', きゅ:'kyu', きょ:'kyo', しゃ:'sha', しゅ:'shu', しょ:'sho',
    ちゃ:'cha', ちゅ:'chu', ちょ:'cho', にゃ:'nya', にゅ:'nyu', にょ:'nyo',
    ひゃ:'hya', ひゅ:'hyu', ひょ:'hyo', みゃ:'mya', みゅ:'myu', みょ:'myo',
    りゃ:'rya', りゅ:'ryu', りょ:'ryo', ぎゃ:'gya', ぎゅ:'gyu', ぎょ:'gyo',
    じゃ:'ja',  じゅ:'ju',  じょ:'jo',  ぢゃ:'ja',  ぢゅ:'ju',  ぢょ:'jo',
    びゃ:'bya', びゅ:'byu', びょ:'byo', ぴゃ:'pya', ぴゅ:'pyu', ぴょ:'pyo',
    // Loanword clusters, which turn up constantly in katakana names.
    しぇ:'she', ちぇ:'che', じぇ:'je', てぃ:'ti', でぃ:'di', どぅ:'du',
    ふぁ:'fa', ふぃ:'fi', ふぇ:'fe', ふぉ:'fo', ふゅ:'fyu',
    うぃ:'wi', うぇ:'we', うぉ:'wo', つぁ:'tsa', つぃ:'tsi', つぇ:'tse', つぉ:'tso',
    ゔぁ:'va', ゔぃ:'vi', ゔぇ:'ve', ゔぉ:'vo', ゔゅ:'vyu',
  };

  const MONO = {
    あ:'a', い:'i', う:'u', え:'e', お:'o',
    か:'ka', き:'ki', く:'ku', け:'ke', こ:'ko',
    が:'ga', ぎ:'gi', ぐ:'gu', げ:'ge', ご:'go',
    さ:'sa', し:'shi', す:'su', せ:'se', そ:'so',
    ざ:'za', じ:'ji', ず:'zu', ぜ:'ze', ぞ:'zo',
    た:'ta', ち:'chi', つ:'tsu', て:'te', と:'to',
    だ:'da', ぢ:'ji', づ:'zu', で:'de', ど:'do',
    な:'na', に:'ni', ぬ:'nu', ね:'ne', の:'no',
    は:'ha', ひ:'hi', ふ:'fu', へ:'he', ほ:'ho',
    ば:'ba', び:'bi', ぶ:'bu', べ:'be', ぼ:'bo',
    ぱ:'pa', ぴ:'pi', ぷ:'pu', ぺ:'pe', ぽ:'po',
    ま:'ma', み:'mi', む:'mu', め:'me', も:'mo',
    や:'ya', ゆ:'yu', よ:'yo',
    ら:'ra', り:'ri', る:'ru', れ:'re', ろ:'ro',
    わ:'wa', ゐ:'wi', ゑ:'we', を:'wo', ん:'n', ゔ:'vu',
    ぁ:'a', ぃ:'i', ぅ:'u', ぇ:'e', ぉ:'o', ゃ:'ya', ゅ:'yu', ょ:'yo',
  };

  const toHiragana = (s) =>
    String(s).replace(/[\u30a1-\u30f6]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0x60));

  const isKana = (s) => /^[\u3040-\u30ff\u30fc]+$/.test(s);

  function fromKana(input) {
    const s = toHiragana(input);
    let out = '';
    let i = 0;

    while (i < s.length) {
      const ch = s[i];

      // Sokuon: doubles the next consonant. まって -> matte. Before ch it
      // becomes t, which is why 抹茶 is matcha and not chcha.
      if (ch === 'っ') {
        const rest = fromKana(s.slice(i + 1));
        if (!rest) { out += 't'; i++; continue; }
        out += rest.startsWith('ch') ? 't' + rest : rest[0] + rest;
        return out;
      }

      // Chouonpu: repeat the preceding vowel. ラーメン -> raamen.
      if (ch === 'ー') {
        const prev = out[out.length - 1];
        if (/[aiueo]/.test(prev || '')) out += prev;
        i++;
        continue;
      }

      const two = s.slice(i, i + 2);
      if (DIGRAPHS[two]) { out += DIGRAPHS[two]; i += 2; continue; }

      if (MONO[ch]) {
        // Syllabic n takes an apostrophe before a vowel or y, so しんいち reads
        // shin'ichi rather than the ambiguous shinichi.
        if (ch === 'ん') {
          const nxt = s.slice(i + 1, i + 3);
          const nr = DIGRAPHS[nxt] || MONO[s[i + 1]] || '';
          out += /^[aiueoy]/.test(nr) ? "n'" : 'n';
        } else {
          out += MONO[ch];
        }
        i++;
        continue;
      }

      out += ch;   // punctuation, latin, anything unmapped passes through
      i++;
    }
    return out;
  }

  // Reconstruct the reading of an INFLECTED surface from a dictionary entry.
  //
  // The problem: hovering 見つけて matches the entry 見つける / みつける, but the
  // surface reads みつけて, not みつける. Using the dictionary reading directly
  // would romanise every conjugated verb into its plain form and be wrong most
  // of the time.
  //
  // The fix: 見つける and みつける share the suffix つける. Strip it from both and
  // you learn that 見 reads み. Re-attach whatever tail the actual surface has,
  // giving み + つけて.
  // 来る is irregular in a way no suffix rule can express: its stem reads く,
  // き or こ depending on the form. The generic algorithm derives 来 -> く from
  // 来る/くる and then renders 来て as "kute" instead of "kite". Table it.
  const IRREGULAR = {
    '来る':'くる', '来て':'きて', '来た':'きた', '来ない':'こない',
    '来ます':'きます', '来ました':'きました', '来ません':'きません',
    '来れば':'くれば', '来い':'こい', '来よう':'こよう',
    '来られる':'こられる', '来させる':'こさせる', '来なかった':'こなかった',
    '来てる':'きてる', '来ている':'きている', '来られた':'こられた',
  };

  function readingForSurface(surface, kanjiForm, reading) {
    if (!surface) return '';
    if (IRREGULAR[surface]) return IRREGULAR[surface];
    if (isKana(surface)) return surface;          // already kana, nothing to do
    if (!kanjiForm || !reading) return '';

    let shared = 0;
    while (
      shared < kanjiForm.length &&
      shared < reading.length &&
      kanjiForm[kanjiForm.length - 1 - shared] === reading[reading.length - 1 - shared]
    ) shared++;

    const stemKanji = kanjiForm.slice(0, kanjiForm.length - shared);
    const stemReading = reading.slice(0, reading.length - shared);

    if (stemKanji && surface.startsWith(stemKanji)) {
      return stemReading + surface.slice(stemKanji.length);
    }
    // Surface is not a straightforward inflection of this headword. Only trust
    // the dictionary reading when the surface IS the headword.
    return surface === kanjiForm ? reading : '';
  }

  K.romaji = { fromKana, readingForSurface, toHiragana, isKana };
})(globalThis.Kotoba);
