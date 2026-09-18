"""The warning on importing another viewer's package - see otherhosts.py."""

import sys
import types
import unittest

from build123d_studio import otherhosts


class OtherHostWarningTest(unittest.TestCase):
    def setUp(self):
        self.said = []
        self.finder = otherhosts.OtherHostWarning(write=self.said.append)
        sys.meta_path.insert(0, self.finder)
        self.addCleanup(self._remove)

    def _remove(self):
        if self.finder in sys.meta_path:
            sys.meta_path.remove(self.finder)
        for name in list(sys.modules):
            if name.startswith("fake_host_"):
                del sys.modules[name]

    def test_each_of_the_three_is_named_once_and_the_import_still_happens(self):
        for host in otherhosts.HOSTS:
            self.assertIsNone(self.finder.find_spec(host))
            self.assertIsNone(self.finder.find_spec(host))
            self.assertIsNone(self.finder.find_spec(f"{host}.show"))
        self.assertEqual(len(self.said), 3)
        for host, text in zip(otherhosts.HOSTS, self.said, strict=True):
            self.assertIn(f"`{host}`", text)
            self.assertIn("from build123d_studio import show", text)

    def test_other_packages_are_not_mentioned(self):
        self.assertIsNone(self.finder.find_spec("json"))
        self.assertIsNone(self.finder.find_spec("build123d"))
        self.assertIsNone(self.finder.find_spec("ocp_viewer_core.viewer"))
        self.assertEqual(self.said, [])

    def test_it_is_asked_by_the_real_import_system_and_does_not_break_the_import(self):
        # A module that exists: the hook must answer None so the ordinary
        # finders load it, and the warning must fire on the way.
        finder = otherhosts.OtherHostWarning(hosts=("fake_host_pkg",), write=self.said.append)
        sys.meta_path.insert(0, finder)
        self.addCleanup(lambda: sys.meta_path.remove(finder) if finder in sys.meta_path else None)
        module = types.ModuleType("fake_host_pkg")
        # Registered by a finder further down the chain, as a real package would be.
        class Loader:
            def create_module(self, spec):
                return module
            def exec_module(self, m):
                m.loaded = True
        class Finder:
            def find_spec(self, name, path=None, target=None):
                if name == "fake_host_pkg":
                    from importlib.machinery import ModuleSpec
                    return ModuleSpec(name, Loader())
                return None
        below = Finder()
        sys.meta_path.append(below)
        self.addCleanup(lambda: sys.meta_path.remove(below))

        imported = __import__("fake_host_pkg")

        self.assertTrue(imported.loaded)
        self.assertEqual(len(self.said), 1)
        self.assertIn("`fake_host_pkg`", self.said[0])

    def test_install_is_idempotent_and_first_in_line(self):
        sys.meta_path.remove(self.finder)
        first = otherhosts.install(write=self.said.append)
        self.addCleanup(lambda: sys.meta_path.remove(first) if first in sys.meta_path else None)
        second = otherhosts.install(write=self.said.append)
        self.assertIs(first, second)
        self.assertIs(sys.meta_path[0], first)
        self.assertEqual(sum(1 for f in sys.meta_path if isinstance(f, otherhosts.OtherHostWarning)), 1)

    def test_importing_the_package_installs_it(self):
        # The kernel's warm-up imports build123d_studio; that import is what
        # puts the hook in place for every cell after it.
        sys.meta_path.remove(self.finder)
        import build123d_studio  # noqa: F401 - the import is the act under test
        installed = [f for f in sys.meta_path if isinstance(f, otherhosts.OtherHostWarning)]
        self.assertEqual(len(installed), 1)
