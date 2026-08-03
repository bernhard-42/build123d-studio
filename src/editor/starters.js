// The two texts the application puts in front of a user who has not typed
// anything yet: the first-run sample, and the default New File template.
//
// They live together, and in a module that imports nothing, for one reason.
// Both explain the run shortcuts in prose, and prose does not follow keys.js
// when a binding moves. That has already gone wrong once: the New File draft
// described three of the four chords backwards and never mentioned F5, and it
// was caught by somebody reading it rather than by anything running. A module
// with no Neutralino and no monaco in its import graph can be loaded under
// `node --test`, which is what starters.test.mjs does - see the pure/impure
// pairs elsewhere (keys/keybindings, tabs/tabstrip, tree/sidebar).
//
// A test cannot check that the sentence attached to a chord is the right
// sentence. It can check that every run command's default chord is named at
// all, which is the half that was missing, and it fails loudly when a default
// changes underneath text that still describes the old one.

/**
 * The jump start, shown once: on the very first run and never again.
 *
 * Whether it belongs in the buffer is a startup decision, not an editor one -
 * see startWithSampleOrEmpty. The editor itself opens empty.
 */
export const SAMPLE_SOURCE = `# %%
from build123d import *
from build123d_studio import show

# %%
part = Box(10, 10, 10) - Cylinder(3, 12)
show(part)
print(f"volume = {part.volume:.3f}")

# %%
# Shift+Enter runs the cell at the cursor and moves on, Ctrl/Cmd+Enter runs it
# and stays, Ctrl/Cmd+Shift+Enter runs the selection or the current line, and F5
# runs the whole file. Output appears in the console below as In [n]:, and the
# kernel is shared with it - so you can poke at "part" down there straight
# after running this.
part.bounding_box()
`;

/**
 * What a new buffer starts with when the user has not said otherwise.
 *
 * The imports, because almost every build123d file opens with those two and
 * typing them again is a small tax paid several times a day. The cell markers,
 * because "# %%" is the one piece of syntax this application gives meaning to
 * and nothing else in the window says so. And the chords, because they are the
 * whole point of the editor and are otherwise found only in a menu.
 */
export const DEFAULT_NEW_FILE_TEMPLATE = `# Default code for new files. It can be adapted in settings
#
# Note: lines starting with "# %%" are cell boundaries for "Run cell"
#
# Shift+Enter runs the cell at the cursor and moves on, Ctrl/Cmd+Enter runs
# it and stays, Ctrl/Cmd+Shift+Enter runs the selection or the current line,
# and F5 runs the whole file. Output appears in the console below as In [n]:,
# and the kernel is shared with it - so you can poke at "b" down there
# straight after running this.

from build123d import *
from build123d_studio import show

# %%

b = Box(1, 2, 3)

show(b)
# %%
`;
