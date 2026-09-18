"""The PATH a child of this process should see, and where it comes from.

Started from the Finder, the application - and so this process, and so every
kernel, console, test run and make it spawns - gets macOS's launchd PATH:
`/usr/bin:/bin:/usr/sbin:/sbin`, measured in the log. Nothing the user put on
their PATH is there - no Homebrew, no pipx - and nor is this environment's own
`bin/`, so a Makefile's `pytest` was "command not found" in an application
whose whole point is that pytest is installed. The pytest menu never noticed,
because it names the interpreter by absolute path.

Two additions, in this order:

  1. the environment's `bin/` - the directory this interpreter lives in - so
     `python`, `pytest` and `ruff` are the ones this application installed;
  2. what the user's login shell puts on PATH, asked of the shell once at
     startup, the way an editor launched from a dock asks. The shell is the
     account's own - the one in the passwd database, which is what a terminal
     opens - and not `$SHELL`, because a process the Finder started has no
     `$SHELL` at all (measured: `launchctl getenv SHELL` is empty) and
     `/bin/sh -l` would read .profile where a zsh or bash user's PATH is in
     .zprofile or .bash_profile. Run as `-lc`, so the profile is read and the
     rc file - prompts, banners - is not.

Then whatever was there already. Asked once and applied to this process's
own environment, so every child inherits it without each caller remembering.

The shell is given a few seconds and no more. A shell whose profile prompts or
hangs would otherwise hold the whole startup; past the deadline the login PATH
is simply not adopted, and the log says so. Windows is left alone: a GUI
process there already has the user's PATH from the registry.
"""

import os
import subprocess
import sys

try:
    import pwd
except ImportError:  # Windows, where the account has no shell to ask
    pwd = None

# What a login shell gets to print its PATH. Measured at 30-80 ms for zsh with
# an ordinary profile; three seconds is for a profile that does real work.
SHELL_TIMEOUT = 3.0


def default_shell():
    """The account's login shell: the passwd entry, then $SHELL, then /bin/sh."""
    if pwd is not None:
        try:
            shell = pwd.getpwuid(os.getuid()).pw_shell
            if shell != "":
                return shell
        except KeyError:
            pass
    return os.environ.get("SHELL") or "/bin/sh"


def login_shell_path(shell=None, timeout=SHELL_TIMEOUT, platform=sys.platform):
    """The PATH entries a login shell would have, or None if it cannot say.

    `-l` and not `-i`: PATH belongs in the profile, and an interactive shell
    would also run the rc file - prompts, banners, and the things that make a
    terminal a terminal - none of which we want the output of.
    """
    if platform == "win32":
        return None
    shell = shell or default_shell()
    try:
        result = subprocess.run(
            [shell, "-lc", 'printf "%s" "$PATH"'],
            capture_output=True, text=True, timeout=timeout, stdin=subprocess.DEVNULL,
        )
    except (OSError, subprocess.TimeoutExpired):
        return None
    if result.returncode != 0:
        return None
    # The last line, because a profile that echoes something prints it first;
    # printf without a newline leaves PATH as the tail of whatever came out.
    text = result.stdout.strip().split("\n")[-1].strip()
    if text == "":
        return None
    return [entry for entry in text.split(os.pathsep) if entry != ""]


def merged_path(environment_bin, login, current):
    """One PATH: the environment's bin, the login shell's entries, then the rest.

    Each entry once, first mention wins - so the environment's python shadows
    a Homebrew one, which shadows the system one, which is the order somebody
    who installed all three would draw on a whiteboard.
    """
    seen = set()
    merged = []
    for entry in [environment_bin, *(login or []), *(current or [])]:
        if entry is None or entry == "" or entry in seen:
            continue
        seen.add(entry)
        merged.append(entry)
    return os.pathsep.join(merged)


def adopt_path(log, environment_bin=None):
    """Set this process's PATH as merged_path describes, and say what changed."""
    environment_bin = environment_bin or os.path.dirname(sys.executable)
    current = [e for e in os.environ.get("PATH", "").split(os.pathsep) if e != ""]
    login = login_shell_path()
    os.environ["PATH"] = merged_path(environment_bin, login, current)
    if sys.platform == "win32":
        log(f"PATH: {environment_bin} first, then the process's own - no login shell on Windows")
    elif login is None:
        log(f"PATH: {environment_bin} first; {default_shell()} did not answer, its PATH not adopted")
    else:
        added = [e for e in login if e not in current]
        log(f"PATH: {environment_bin} first, then {len(added)} entr{'y' if len(added) == 1 else 'ies'} from {default_shell()} -l")
