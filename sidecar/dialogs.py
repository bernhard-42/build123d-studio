"""Whether file dialogs can open on Linux.

Neutralino draws its file dialogs with portable-file-dialogs, and on Linux that
runs an outside program: the first of zenity, matedialog, qarma and kdialog it
finds with `which`. With none of them installed it runs `echo` instead, whose
empty line is read as a dialog the user cancelled - so Open, Save As, Import
and Export all do nothing, and nothing anywhere says why. Found on an
elementary OS 8 machine with none of the four installed; Ubuntu 26.04's desktop
brought zenity with it.

Asked here with a PATH lookup rather than through Neutralino: it is the lookup
pfd makes, and the four live in /usr/bin, which both PATHs include. pfd scans
once per process and keeps the answer, so a program installed while the
application runs is only seen after a restart - which is what the window's
banner tells somebody to do.
"""

import shutil
import sys

# The programs portable-file-dialogs looks for, in its own order
# (portable-file-dialogs.h, settings::settings).
HELPERS = ("zenity", "matedialog", "qarma", "kdialog")

def dialog_helper(which=shutil.which, platform=sys.platform):
    """The program file dialogs will use, or None when there is none.

    Only Linux needs one: Windows and macOS draw their own. Elsewhere this
    answers "native", so the caller has a word to report either way.
    """
    if not platform.startswith("linux"):
        return "native"
    for name in HELPERS:
        if which(name) is not None:
            return name
    return None
