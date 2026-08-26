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

// Deinflection, not tokenization. Service-worker side only.
//
// Shipping kuromoji or MeCab costs 15-50MB before the first lookup. Yomitan does
// not do that: it walks back from the cursor, tries a longest-prefix match, and
// unwinds conjugation with a rule table. Same approach here.
//
// Rule shape: [inflectedSuffix, baseSuffix, appliesToTypes, producesTypes]
//   v1 ichidan, v5 godan, vs suru, vk kuru, adj-i i-adjective
// The type gate is what stops mihitsuke-style nonsense reaching the dictionary.

(function (K) {
  const RULES = [
    ['って','う',['v5'],[]], ['って','つ',['v5'],[]], ['って','る',['v5'],[]],
    ['った','う',['v5'],[]], ['った','つ',['v5'],[]], ['った','る',['v5'],[]],
    ['んで','ぬ',['v5'],[]], ['んで','ぶ',['v5'],[]], ['んで','む',['v5'],[]],
    ['んだ','ぬ',['v5'],[]], ['んだ','ぶ',['v5'],[]], ['んだ','む',['v5'],[]],
    ['いて','く',['v5'],[]], ['いた','く',['v5'],[]],
    ['いで','ぐ',['v5'],[]], ['いだ','ぐ',['v5'],[]],
    ['して','す',['v5'],[]], ['した','す',['v5'],[]],
    ['て','る',['v1','vk'],[]], ['た','る',['v1','vk'],[]],
    ['して','する',['vs'],[]], ['した','する',['vs'],[]],
    ['きて','くる',['vk'],[]], ['きた','くる',['vk'],[]],
    ['行って','行く',['v5'],[]], ['行った','行く',['v5'],[]],

    ['います','う',['v5'],[]], ['きます','く',['v5'],[]], ['ぎます','ぐ',['v5'],[]],
    ['します','す',['v5'],[]], ['ちます','つ',['v5'],[]], ['にます','ぬ',['v5'],[]],
    ['びます','ぶ',['v5'],[]], ['みます','む',['v5'],[]], ['ります','る',['v5'],[]],
    ['ます','る',['v1','vk'],[]], ['します','する',['vs'],[]], ['きます','くる',['vk'],[]],
    ['ました','ます',[],['v1']], ['ません','ます',[],['v1']],
    // Volitional and past-negative polite. Without these, 会いましょう never
    // reaches 会う and fragments into meaningless pieces.
    ['ましょう','ます',[],[]], ['ませんでした','ません',[],[]],
    ['まして','ます',[],[]], ['ましたら','ました',[],[]],

    ['わない','う',['v5'],['adj-i']], ['かない','く',['v5'],['adj-i']],
    ['がない','ぐ',['v5'],['adj-i']], ['さない','す',['v5'],['adj-i']],
    ['たない','つ',['v5'],['adj-i']], ['なない','ぬ',['v5'],['adj-i']],
    ['ばない','ぶ',['v5'],['adj-i']], ['まない','む',['v5'],['adj-i']],
    ['らない','る',['v5'],['adj-i']],
    ['ない','る',['v1','vk'],['adj-i']], ['しない','する',['vs'],['adj-i']],
    ['こない','くる',['vk'],['adj-i']],

    ['られる','る',['v1','vk'],['v1']], ['させる','する',['vs'],['v1']],
    ['える','う',['v5'],['v1']], ['ける','く',['v5'],['v1']],
    ['げる','ぐ',['v5'],['v1']], ['せる','す',['v5'],['v1']],
    ['てる','つ',['v5'],['v1']], ['ねる','ぬ',['v5'],['v1']],
    ['べる','ぶ',['v5'],['v1']], ['める','む',['v5'],['v1']],
    ['れる','る',['v5'],['v1']],

    ['おう','う',['v5'],[]], ['こう','く',['v5'],[]], ['そう','す',['v5'],[]],
    ['とう','つ',['v5'],[]], ['ろう','る',['v5'],[]], ['もう','む',['v5'],[]],
    ['よう','る',['v1','vk'],[]], ['しよう','する',['vs'],[]],
    ['えば','う',['v5'],[]], ['けば','く',['v5'],[]], ['せば','す',['v5'],[]],
    ['れば','る',['v1','v5'],[]], ['すれば','する',['vs'],[]],
    ['たら','た',[],[]], ['たり','た',[],[]],

    ['ている','て',[],[]], ['てる','て',[],[]], ['ちゃう','て',[],[]],
    ['てしまう','て',[],[]], ['ておく','て',[],[]], ['とく','て',[],[]],
    ['てある','て',[],[]], ['ていく','て',[],[]], ['てくる','て',[],[]],
    ['てください','て',[],[]], ['てみる','て',[],[]],


    // Godan passive: -areru. 言われる -> 言う, 読まれる -> 読む.
    ['われる','う',['v5'],['v1']], ['かれる','く',['v5'],['v1']],
    ['がれる','ぐ',['v5'],['v1']], ['される','す',['v5'],['v1']],
    ['たれる','つ',['v5'],['v1']], ['なれる','ぬ',['v5'],['v1']],
    ['ばれる','ぶ',['v5'],['v1']], ['まれる','む',['v5'],['v1']],

    // Godan causative: -aseru. 書かせる -> 書く.
    ['わせる','う',['v5'],['v1']], ['かせる','く',['v5'],['v1']],
    ['がせる','ぐ',['v5'],['v1']], ['させる','す',['v5'],['v1']],
    ['たせる','つ',['v5'],['v1']], ['なせる','ぬ',['v5'],['v1']],
    ['ばせる','ぶ',['v5'],['v1']], ['ませる','む',['v5'],['v1']],
    ['らせる','る',['v5'],['v1']],

    // Ichidan causative, and suru passive.
    ['させる','る',['v1'],['v1']], ['される','する',['vs'],['v1']],

    // Concessive and contracted conditionals: 言っても, 読んでも, 行っちゃ.
    ['ても','て',[],[]], ['でも','で',[],[]],
    ['ちゃ','て',[],[]], ['じゃ','で',[],[]],
    ['では','で',[],[]], ['ては','て',[],[]],

    // Negative past: 行かなかった -> 行かない -> 行く.
    ['なかった','ない',['adj-i'],[]],
    ['なくて','ない',['adj-i'],[]], ['なければ','ない',['adj-i'],[]],

    // Desiderative, excess, simultaneous. All extremely common in dialogue.
    ['たい','',['v5','v1','vs','vk'],['adj-i']],
    ['たがる','',['v5','v1','vs','vk'],['v5']],
    ['すぎる','',['v5','v1','vs','vk'],['v1']],
    ['ながら','',['v5','v1','vs','vk'],[]],

    ['くない','い',['adj-i'],['adj-i']], ['かった','い',['adj-i'],[]],
    ['くて','い',['adj-i'],[]], ['く','い',['adj-i'],[]],
    ['ければ','い',['adj-i'],[]], ['さ','い',['adj-i'],[]],
  ];

  const ALL = ['v1', 'v5', 'vs', 'vk', 'adj-i'];

  K.deinflect = function (term, maxDepth = 6) {
    const results = [{ term, types: ALL, chain: [] }];
    const seen = new Set([term + '|0']);

    for (let i = 0; i < results.length; i++) {
      const cur = results[i];
      if (cur.chain.length >= maxDepth) continue;

      for (const [suffix, base, appliesTo, produces] of RULES) {
        if (!cur.term.endsWith(suffix)) continue;
        if (cur.term.length - suffix.length + base.length <= 0) continue;

        const outTypes = produces.length ? produces : ALL;
        if (!outTypes.some((t) => cur.types.includes(t))) continue;

        const candidate = cur.term.slice(0, cur.term.length - suffix.length) + base;
        const key = candidate + '|' + cur.chain.length;
        if (seen.has(key)) continue;
        seen.add(key);

        results.push({
          term: candidate,
          types: appliesTo.length ? appliesTo : ALL,
          chain: cur.chain.concat(suffix),
        });
      }
    }
    return results;
  };
})(globalThis.Kotoba);
