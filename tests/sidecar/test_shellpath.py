"""The PATH a run gets, and where its entries come from - see shellpath.py."""

import os
import stat
import tempfile
import unittest

from shellpath import default_shell, login_shell_path, merged_path


class MergedPathTest(unittest.TestCase):
    def test_environment_bin_first_then_login_then_what_was_there(self):
        self.assertEqual(
            merged_path("/env/bin", ["/opt/homebrew/bin", "/usr/bin"], ["/usr/bin", "/bin"]),
            os.pathsep.join(["/env/bin", "/opt/homebrew/bin", "/usr/bin", "/bin"]),
        )

    def test_each_entry_once_and_first_mention_wins(self):
        self.assertEqual(
            merged_path("/env/bin", ["/env/bin", "/a", "/a"], ["/a", "/env/bin"]),
            os.pathsep.join(["/env/bin", "/a"]),
        )

    def test_a_shell_that_could_not_answer_costs_nothing(self):
        self.assertEqual(merged_path("/env/bin", None, ["/usr/bin"]),
                         os.pathsep.join(["/env/bin", "/usr/bin"]))
        self.assertEqual(merged_path("/env/bin", [], []), "/env/bin")


@unittest.skipIf(os.name == "nt", "a login shell is a POSIX idea; Windows keeps its PATH")
class LoginShellPathTest(unittest.TestCase):
    def shell(self, script):
        directory = tempfile.mkdtemp()
        self.addCleanup(lambda: __import__("shutil").rmtree(directory, ignore_errors=True))
        path = os.path.join(directory, "sh")
        with open(path, "w", encoding="utf-8") as handle:
            handle.write("#!/bin/sh\n" + script)
        os.chmod(path, os.stat(path).st_mode | stat.S_IXUSR)
        return path

    def test_reads_the_path_the_shell_prints(self):
        # A stand-in shell that ignores its arguments and behaves like a login
        # shell whose profile put two directories first.
        shell = self.shell('PATH="/opt/tool/bin:/home/me/.local/bin:$PATH"\nprintf "%s" "$PATH"\n')
        entries = login_shell_path(shell=shell)
        self.assertEqual(entries[:2], ["/opt/tool/bin", "/home/me/.local/bin"])

    def test_a_profile_that_talks_first_is_still_read(self):
        shell = self.shell('echo "Welcome back"\nprintf "%s" "/x/bin:/usr/bin"\n')
        self.assertEqual(login_shell_path(shell=shell), ["/x/bin", "/usr/bin"])

    def test_a_shell_that_fails_or_hangs_answers_none(self):
        self.assertIsNone(login_shell_path(shell=self.shell("exit 3\n")))
        self.assertIsNone(login_shell_path(shell=self.shell("sleep 5\n"), timeout=0.3))
        self.assertIsNone(login_shell_path(shell="/no/such/shell"))

    def test_the_default_shell_is_the_accounts_not_the_environments(self):
        # A process the Finder started has no $SHELL; the passwd entry is what
        # a terminal would open, and it is asked first.
        import pwd
        expected = pwd.getpwuid(os.getuid()).pw_shell
        saved = os.environ.pop("SHELL", None)
        try:
            self.assertEqual(default_shell(), expected)
            os.environ["SHELL"] = "/bin/other"
            self.assertEqual(default_shell(), expected)
        finally:
            if saved is None:
                os.environ.pop("SHELL", None)
            else:
                os.environ["SHELL"] = saved

    def test_the_real_login_shell_answers_here(self):
        # Not a claim about its contents - only that the mechanism works with
        # whatever $SHELL this machine has.
        entries = login_shell_path()
        self.assertIsInstance(entries, list)
        self.assertGreater(len(entries), 0)

    def test_windows_is_left_alone(self):
        self.assertIsNone(login_shell_path(platform="win32"))
