// The user's keyboard shortcuts: keys.js plus settings.json plus this platform.
//
// Split from keys.js so that the half worth testing stays testable. Everything
// that decides what a chord *means* is pure and lives there, exercised under
// `node --test` against all three platforms; this file is the wiring that
// reaches the settings file and NL_OS, neither of which exists in node. It is
// the same split as quoting.js and proc.js.

import { COMMANDS, monacoBindings, describeChord, usableChords } from "./keys.js";
import { getSetting, setSetting } from "./store.js";
import * as log from "./log.js";

const SETTING = "keybindings";

/**
 * The chords bound to one command: the user's if they are usable, else the
 * shipped ones.
 *
 * A rejected chord is reported once and costs only itself. That is what makes
 * hand-editing settings.json safe: the worst a typo can do is leave one command
 * on its default.
 */
export function chordsFor(commandId) {
  const stored = getSetting(SETTING, {}) ?? {};
  const { chords, rejected } = usableChords(commandId, stored[commandId]);
  if (rejected.length > 0) {
    log.warn(`Ignoring unreadable shortcut(s) for ${commandId}:`, rejected);
  }
  return chords;
}

/** Bind a command, or pass null to restore its default. */
export function setChordsFor(commandId, chords) {
  const stored = { ...(getSetting(SETTING, {}) ?? {}) };
  if (chords === null) {
    delete stored[commandId];
  } else {
    stored[commandId] = chords;
  }
  return setSetting(SETTING, stored);
}

/** Monaco keybindings for one command, on this platform. */
export function bindingsFor(monaco, commandId) {
  return monacoBindings(NL_OS, monaco, chordsFor(commandId));
}

/** How this command's shortcut should be shown to a person, on this platform. */
export function labelFor(commandId) {
  const chords = chordsFor(commandId);
  return chords.length === 0 ? "" : describeChord(NL_OS, chords[0]);
}

/** Every command with its current chords, for the menu and for group 4's dialog. */
export function currentBindings() {
  return COMMANDS.map((command) => ({
    id: command.id,
    label: command.label,
    chords: chordsFor(command.id),
    shortcut: labelFor(command.id),
  }));
}
