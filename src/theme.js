import { getSetting, setSetting } from "./store.js";

// One place decides light or dark, and everything else follows.
//
// Four independent things need theming - the app shell, Monaco, xterm and
// three-cad-viewer - and each has its own API. Rather than have every module
// read a setting and guess, they subscribe here and are told.
//
// The stored preference is "system", "light" or "dark". "system" tracks the OS
// setting live, so changing appearance in System Settings switches the app
// without a restart.

const STORAGE_KEY = "theme";
const PREFERENCES = ["system", "light", "dark"];

const listeners = new Set();

let preference = "system";

function systemTheme() {
  return window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
}

/** The theme actually in force: always "light" or "dark", never "system". */
export function resolvedTheme() {
  return preference === "system" ? systemTheme() : preference;
}

export function themePreference() {
  return preference;
}

/**
 * Subscribe to theme changes. Called immediately with the current theme, so a
 * subscriber never has to apply it once itself and then subscribe.
 */
export function onThemeChange(listener) {
  listeners.add(listener);
  listener(resolvedTheme());
  return () => listeners.delete(listener);
}

function apply() {
  const theme = resolvedTheme();
  // Drives the CSS custom properties for the shell.
  document.documentElement.dataset.theme = theme;
  for (const listener of listeners) {
    try {
      listener(theme);
    } catch (error) {
      console.error("Theme listener failed:", error);
    }
  }
}

export async function setThemePreference(next) {
  if (!PREFERENCES.includes(next)) {
    return;
  }
  preference = next;
  apply();
  await setSetting(STORAGE_KEY, preference);
}

/**
 * The next preference for the toolbar button, skipping any that would not
 * change what is on screen.
 *
 * A plain three-way cycle has a dead click in it, because "system" resolves to
 * whichever of light and dark the OS is using. On a light desktop, stepping
 * system → light changes nothing visible, so the button had to be pressed twice
 * to get to dark; on a dark desktop the dead step is dark → system instead.
 *
 * Skipping the no-op step means the preference that matches the OS is no longer
 * reachable from the button - on a light desktop it cycles system ↔ dark, never
 * settling on a pinned "light". That is the right trade for a toggle: the two
 * differ only in what happens when the OS theme later changes, and the settings
 * dialog can still set the preference explicitly.
 */
export function nextPreference() {
  const current = resolvedTheme();
  const start = PREFERENCES.indexOf(preference);
  for (let step = 1; step <= PREFERENCES.length; step += 1) {
    const candidate = PREFERENCES[(start + step) % PREFERENCES.length];
    const theme = candidate === "system" ? systemTheme() : candidate;
    if (theme !== current) {
      return candidate;
    }
  }
  // Unreachable while PREFERENCES holds both light and dark, but a toolbar
  // button that does nothing beats one that throws.
  return preference;
}

export async function initTheme() {
  const stored = getSetting(STORAGE_KEY);
  if (PREFERENCES.includes(stored)) {
    preference = stored;
  }

  // Only relevant while the preference is "system", but harmless otherwise and
  // simpler than adding and removing the listener.
  window
    .matchMedia("(prefers-color-scheme: light)")
    .addEventListener("change", () => {
      if (preference === "system") {
        apply();
      }
    });

  apply();
}
