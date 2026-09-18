import * as monaco from "monaco-editor/editor/editor.api.js";

// TOML, for pyproject.toml: highlighting only.
//
// monaco-editor ships no TOML grammar, and its nearest, ini, would colour
// tables and inline arrays wrongly. This is a Monarch grammar like the Python
// and YAML ones - tokens, brackets, comments - with no language service behind
// it: nothing is validated, and nothing is sent anywhere. A few kilobytes.
//
// Monarch tokenises one line at a time, so the multi-line string states below
// carry their token across lines by staying in the state until the closing
// quotes. Case-insensitivity per regex is not a thing in Monarch - it rebuilds
// each pattern from its source - so inf and nan are matched as TOML spells
// them, lowercase.
//
// Registered the way monaco-editor registers its own grammars: the language
// now, the configuration and the tokenizer when a buffer first uses it.
// setLanguageConfiguration and setMonarchTokensProvider both reach for
// Monaco's services at call time, and the first such call freezes the set of
// services with whatever has been registered by then - so called at import,
// ahead of the contributions monaco.js imports after this file, they would
// leave the suggest widget and the hover without the services they depend on,
// and both would fail to construct without a word.

export const TOML_LANGUAGE_ID = "toml";

const configuration = {
  comments: { lineComment: "#" },
  brackets: [
    ["{", "}"],
    ["[", "]"],
  ],
  autoClosingPairs: [
    { open: '"', close: '"' },
    { open: "'", close: "'" },
    { open: "[", close: "]" },
    { open: "{", close: "}" },
  ],
  surroundingPairs: [
    { open: '"', close: '"' },
    { open: "'", close: "'" },
    { open: "[", close: "]" },
    { open: "{", close: "}" },
  ],
};

const grammar = {
  defaultToken: "",
  tokenizer: {
    root: [
      [/#.*$/, "comment"],

      // An array-of-tables header before a table header, or [[a]] reads as
      // a table named "[a".
      [/\[\[[^\]\r\n]+\]\]/, "type.identifier"],
      [/\[[^\]\r\n]+\]/, "type.identifier"],

      // A key - bare, dotted, or quoted - is whatever stands before `=`.
      [
        /(?:[A-Za-z0-9_-]+|"(?:\\.|[^"\\])*"|'[^']*')(?=\s*(?:\.\s*(?:[A-Za-z0-9_-]+|"(?:\\.|[^"\\])*"|'[^']*'))*\s*=)/,
        "key",
      ],
      [/=/, "delimiter"],

      [/"""/, { token: "string", next: "@multiBasicString" }],
      [/'''/, { token: "string", next: "@multiLiteralString" }],
      [/"(?:\\.|[^"\\\r\n])*"/, "string"],
      [/'[^'\r\n]*'/, "string"],

      // Dates and times, before numbers, or a date is three integers.
      [/\b\d{4}-\d{2}-\d{2}(?:[Tt ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:[Zz]|[+-]\d{2}:\d{2})?)?\b/, "number"],
      [/\b\d{2}:\d{2}:\d{2}(?:\.\d+)?\b/, "number"],

      [/\b(?:true|false)\b/, "keyword"],
      [/[+-]?\b(?:inf|nan)\b/, "number"],
      [/[+-]?0x[0-9A-Fa-f_]+/, "number.hex"],
      [/[+-]?0o[0-7_]+/, "number.octal"],
      [/[+-]?0b[01_]+/, "number.binary"],
      [/[+-]?(?:\d(?:[\d_]*\d)?)(?:\.(?:\d(?:[\d_]*\d)?))?(?:[eE][+-]?\d(?:[\d_]*\d)?)?/, "number"],

      [/[{}[\],.]/, "delimiter"],
      [/[A-Za-z0-9_-]+/, "identifier"],
      [/\s+/, "white"],
    ],

    multiBasicString: [
      [/"""/, { token: "string", next: "@pop" }],
      [/[^"]+/, "string"],
      [/"/, "string"],
    ],

    multiLiteralString: [
      [/'''/, { token: "string", next: "@pop" }],
      [/[^']+/, "string"],
      [/'/, "string"],
    ],
  },
};

monaco.languages.register({
  id: TOML_LANGUAGE_ID,
  extensions: [".toml"],
  aliases: ["TOML", "toml"],
  mimetypes: ["application/toml"],
});
monaco.languages.registerTokensProviderFactory(TOML_LANGUAGE_ID, { create: () => grammar });
monaco.languages.onLanguageEncountered(TOML_LANGUAGE_ID, () => {
  monaco.languages.setLanguageConfiguration(TOML_LANGUAGE_ID, configuration);
});
