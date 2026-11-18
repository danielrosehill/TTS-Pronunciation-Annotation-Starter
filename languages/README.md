# Language packs

A language pack tells the app how to help annotators write IPA for one language:

- **Keypad:** the symbols on the IPA keypad, each with a tooltip that says what the symbol is and which error it
  usually replaces.
- **IPA help drawer:** a searchable list of the language's IPA symbols, opened from the keypad and from the help
  sheet.
- **Cliff notes:** an optional longer note, shown in the drawer.

Select a pack with `"language_pack": "<code>"` in `config.json`. Set `ipa_keypad` there only if you want to override
the pack's keypad.

## Layout

    languages/<code>/
      ipa.json             required: machine-readable, drives the keypad and the drawer
      ipa-cliff-notes.md   optional: the human-readable notes, shown in the drawer

## `ipa.json`

```json
{
  "language": "he",
  "name": "Modern Israeli Hebrew",
  "notes": "ipa-cliff-notes.md",
  "source": "Where the content comes from",
  "keypad": ["ˈ", "ʔ", "ʁ", "χ", "ts"],
  "symbols": [
    {
      "symbol": "χ",
      "kind": "consonant",
      "letters": "ח; כ / ך without dagesh",
      "sounds_like": "Scottish \"loch\"",
      "example": "לֶחֶם ˈleχem",
      "common_errors": ["tʃ (English \"ch\")", "k", "h"]
    }
  ]
}
```

| Field | Required | Meaning |
| --- | --- | --- |
| `language` | yes | Language code |
| `name` | yes | Display name |
| `notes` | no | File name of the cliff notes in the same folder, or `null` |
| `source` | no | Where the content comes from |
| `keypad` | yes | The symbols on the keypad, in order. Multi-character entries such as `ts` are inserted whole. |
| `symbols` | yes | One entry per symbol, used for keypad tooltips and the drawer. Keypad symbols should have an entry. |
| `symbols[].symbol` | yes | The IPA to type |
| `symbols[].kind` | yes | `consonant`, `vowel`, `stress` or `other` |
| `symbols[].letters` | no | The letters or diacritics that make the sound |
| `symbols[].sounds_like` | no | A plain-language comparison |
| `symbols[].example` | no | A word and its IPA |
| `symbols[].common_errors` | no | What TTS voices typically say instead (the IPA first, then a note) |

## Adding a language

1. Copy `languages/en/` to `languages/<code>/`. It is a stub that shows the shape.
2. Write `ipa.json`. Give the keypad the symbols annotators need that aren't on a normal keyboard, and the stress mark
   `ˈ`.
3. Optionally write `ipa-cliff-notes.md`, using `languages/he/ipa-cliff-notes.md` as a model: consonants, vowels,
   stress, and errors that are about the words rather than the sounds.
4. Set `"language_pack": "<code>"` in your `config.json`.
5. Validate the pack: `python3 -c "import json,sys; json.load(open(sys.argv[1]))" languages/<code>/ipa.json`. The
   server also logs a warning when a keypad symbol has no entry.
