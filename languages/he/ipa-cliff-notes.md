# Hebrew IPA cliff notes for TTS annotation

A quick reference for writing what a Hebrew TTS voice said and what it should have said, in IPA, without knowing the whole
IPA system. It covers standard Modern Israeli Hebrew, plus the errors you can expect from a TTS voice, especially one
that falls back on English or Arabic sounds or has to guess the vowels.

The **Write** column is what to type in the annotation tool. Where a voice is wrong, write the IPA you actually heard,
not the letter.

## Consonants

| Letter | Write | Sounds like | Example | Typical TTS errors |
| --- | --- | --- | --- | --- |
| ח, and כ / ך without dagesh | **χ** | Scottish "loch", German "Bach" | חַנָּה Chana `ˈχana`, לֶחֶם `ˈleχem` | **tʃ** (English "ch" in *chana masala*), **k**, **h**, silent. **ħ** is the Mizrahi pharyngeal for ח: a regional variant, not an error, but not standard Israeli |
| ר | **ʁ** | French "r", back of the throat | רֶגַע `ˈʁeɡa` | **ɹ** (English r), **r** (trilled: Mizrahi/older variant) |
| צ | **ts** | "ts" in "cats" | צָרִיךְ `tsaˈʁiχ` | **s**, **z**, **tʃ** |
| צ׳ | **tʃ** | "ch" in "chips" | צ׳יפְּס `tʃips` | **ts** (apostrophe ignored) |
| ג | **ɡ** | "g" in "go" | גַּן `ɡan` | **dʒ** (English "j") |
| ג׳ | **dʒ** | "j" in "jeans" | ג׳ינְס `dʒins` | **ɡ** (apostrophe ignored) |
| ז׳ | **ʒ** | "s" in "measure" | ז׳וּרְנָל `ʒuʁˈnal` | **z** |
| שׁ (dot right) | **ʃ** | "sh" | שָׁלוֹם `ʃaˈlom` | **s**, when the shin/sin dot is misread |
| שׂ (dot left), ס | **s** | "s" | שָׂרָה Sarah `saˈʁa` | **ʃ** |
| א, ע | **ʔ** or nothing | catch in the throat, often dropped | אֲנִי `ʔaˈni` | **ʕ** (Arabic ayin: a Mizrahi variant for ע); a hard ʔ where speech drops it is a style problem, not an error |
| ה | **h** or nothing | "h", often dropped mid-word | הוּא `hu` | dropped where it should be heard (a word-initial ה) |
| בּ / ב | **b** / **v** | | בַּיִת `ˈbajit`, אָבִיב `ʔaˈviv` | **b** where **v** belongs (dagesh rule ignored) |
| כּ / כ | **k** / **χ** | | כֶּלֶב `ˈkelev`, לִכְתּוֹב `liχˈtov` | **k** where **χ** belongs |
| פּ / פ | **p** / **f** | | פֶּה `pe`, סֵפֶר `ˈsefeʁ` | **p** where **f** belongs |
| ק | **k** | | קָטָן `kaˈtan` | **q** (Arabic-style uvular) |
| ט, ת | **t** | | | **θ** (English "th"), for ת |
| ו (consonant), וו | **v**; **w** in loanwords | | וְ `ve`, ווֹטְסְאַפּ `ˈwatsap` | **w** where **v** belongs |
| י (consonant) | **j** | English "y" | יֶלֶד `ˈjeled` | **dʒ** (an English reading of "j") |

The rest (ד d, ל l, מ m, נ n, ס s, ז z, ף f, ם m, ן n) are the same as English.

## Vowels

Modern Hebrew has five vowels and no long or short pairs. Every vowel is said fully, even when unstressed.

| Write | Sounds like | Nikud | Typical TTS errors |
| --- | --- | --- | --- |
| **a** | "a" in "father", short | ַ ָ ֲ | **æ** ("cat"), **ə** (reduced when unstressed) |
| **e** | "e" in "bed" | ֶ ֵ ֱ (and a spoken shva) | **eɪ** (English "day"), **ə** |
| **i** | "ee", short | ִ | **ɪ** ("bit") |
| **o** | "o", pure, not gliding | ֹ וֹ ָ (kamatz katan) | **oʊ** (English "go") |
| **u** | "oo", short | ֻ וּ | **ʊ** ("put") |
| **ej**, **aj**, **oj**, **uj** | diphthongs written with י | בֵּיצָה `ˈbejtsa`, בַּיִת `ˈbajit` | **e** (diphthong lost) |

**Shva (ְ)** is either **e** or nothing. זְמַן is `zman` (nothing), and מְדַבֵּר is `medaˈbeʁ` in careful speech
(an *e*). Typical errors are an **e** inserted where speech has none, or a cluster no Israeli would say.

**Hataf vowels (ֲ ֱ ֳ)** are said as plain **a**, **e** and **o**.

## Stress

Put **ˈ** before the stressed syllable: `ʃaˈlom`, `ˈsefeʁ`.

- **Most words are stressed on the last syllable (milra):** `tsaˈʁiχ`, `ʃaˈlom`, `χaˈlon`.
- **The main exceptions are stressed on the second-to-last syllable (mil'el):**
  - **Segolates:** `ˈsefeʁ`, `ˈjeled`, `ˈboker`, `ˈleχem`, `ˈkelev`, `ˈʔeʁev`, `ˈʁeɡa`, `ˈkajits`, `ˈbajit`.
  - **Past-tense first and second person:** `haˈjiti`, `kaˈtavta`.
  - **Many first names and loanwords:** `ˈdani`, `ˈtelefon`.
- **Mil'el words are the most common TTS stress error,** because a voice with no stress information defaults to the
  last syllable (`sefˈeʁ`, `jelˈed`). In the annotation tool, tag them as **stress**: the syllable the voice stressed,
  and the one it should have stressed.

## Errors that are about the words, not the sounds

These come from the voice guessing the vowels of unpointed Hebrew (its **nikud inference**):

- **Homographs:** ספר is `ˈsefeʁ` (book), `saˈpaʁ` (barber) or `saˈfaʁ` (counted); הרגל is `ˈheʁɡel` (habit) or
  `haˈʁeɡel` (the leg). Tag them as **mispronunciation**, with the IPA heard and the IPA expected.
- **The "and" prefix:** ו is `ve` or `u` (`umiˈjad`, not `vemiˈjad`).
- **Loanwords:** מייל is `mejl`, not `mail`; דרייב is `dʁajv`.
- **Gemination:** Modern Hebrew does not double consonants. A strong dagesh (הַסַּפָּר `hasaˈpaʁ`) is not said long.
