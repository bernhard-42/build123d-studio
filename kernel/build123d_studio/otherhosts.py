"""A word of warning when another viewer's package is imported into this kernel.

`from ocp_vscode import *` in a Studio cell binds `show` to a websocket client
that looks for a VS Code viewer, and with none running it waits - the kernel
sits busy, nothing reaches the viewer on screen, and the log says only that an
execute has not finished. Measured on 2026-09-18, on a machine that was
"stuck" for three minutes while its kernel slept in a socket wait. The same
holds for `jupyter_cadquery` and `ocp_viewer`, each of which talks to its own
host and not to this one.

The warning is an import hook: a finder at the front of `sys.meta_path`,
which the import system asks first about every module. It looks at the name,
says its sentence once for one of those packages, and answers "not mine" so
the real import proceeds untouched. Nothing is patched and nothing is
replaced - a script that means to use ocp_vscode still can - and the package
need not even be installed for the warning to fire, since the hook runs before
anything is looked for.

Installed when `build123d_studio` is imported, which the kernel's warm-up does
at every start. A process nothing of ours runs in first - a Run File, a test
run, a Make target - has no hook, and its `ocp_vscode` waits as before.
"""

import sys

# The packages, each with the import that reaches this viewer instead.
HOSTS = ("ocp_vscode", "jupyter_cadquery", "ocp_viewer")

MESSAGE = (
    "build123d Studio: `{name}` talks to its own viewer, not to this one - its "
    "show() will look for one that is not running and wait for it. In Studio "
    "use `from build123d_studio import show` or "
    "`from ocp_viewer_core.viewer import show`."
)


def _package_of(name):
    return name.split(".", 1)[0]


class OtherHostWarning:
    """A meta-path finder that finds nothing and says something."""

    def __init__(self, hosts=HOSTS, write=None):
        self._hosts = frozenset(hosts)
        self._write = write
        self.warned = set()

    def find_spec(self, name, path=None, target=None):
        package = _package_of(name)
        if package in self._hosts and package not in self.warned:
            self.warned.add(package)
            self._say(MESSAGE.format(name=package))
        return None

    def _say(self, text):
        if self._write is not None:
            self._write(text)
            return
        # stderr: the console shows it in red, beside the traceback it would
        # otherwise stand in for. Looked up at call time, since IPython swaps
        # sys.stderr for a capturing stream after this module is imported.
        print(text, file=sys.stderr)


def install(hosts=HOSTS, write=None):
    """Put the hook first on sys.meta_path, once. Returns it."""
    for finder in sys.meta_path:
        if isinstance(finder, OtherHostWarning):
            return finder
    finder = OtherHostWarning(hosts, write)
    sys.meta_path.insert(0, finder)
    return finder
