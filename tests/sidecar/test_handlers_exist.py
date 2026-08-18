"""Every handler the sidecar registers must exist.

A registration names its handler as an attribute, so a method that is renamed
or lost takes the whole process with it - `Sidecar.__init__` raises
AttributeError, the sidecar exits before it can announce its port, and the
application shows "Sidecar did not announce a port", which says nothing about
the cause.

That happened: an edit replaced a span of `main.py` that reached from one
method to the next and took two methods in the middle with it, while their
registrations stayed. Nothing caught it - `ruff` cannot see an attribute that
does not exist, the sidecar suite never constructs a `Sidecar`, and the
frontend suite stubs the process away.

Read statically rather than by constructing one: `Sidecar.__init__` binds a
socket, spawns a kernel and starts threads, none of which belongs in a unit
test, and the question here is only whether the names line up.
"""

import ast
import os
import unittest

SIDECAR = os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(
    os.path.abspath(__file__)))), "sidecar", "main.py")

# The calls that register a handler. `channel.on` and `channel.on_binary` take
# it as the second positional argument; ModelSocket takes four by keyword.
REGISTRARS = ("on", "on_binary")


def registered_handlers(tree):
    """Every `self.<name>` handed to a registration call, with its line."""
    found = []
    for node in ast.walk(tree):
        if not isinstance(node, ast.Call):
            continue
        is_channel_registration = (
            isinstance(node.func, ast.Attribute) and node.func.attr in REGISTRARS
        )
        is_model_socket = isinstance(node.func, ast.Name) and node.func.id == "ModelSocket"
        if not (is_channel_registration or is_model_socket):
            continue
        for argument in list(node.args) + [kw.value for kw in node.keywords]:
            if (
                isinstance(argument, ast.Attribute)
                and isinstance(argument.value, ast.Name)
                and argument.value.id == "self"
            ):
                found.append((argument.attr, argument.lineno))
    return found


class HandlersExistTest(unittest.TestCase):
    def setUp(self):
        with open(SIDECAR, "r", encoding="utf-8") as handle:
            self.tree = ast.parse(handle.read())
        self.sidecar = next(
            node
            for node in ast.walk(self.tree)
            if isinstance(node, ast.ClassDef) and node.name == "Sidecar"
        )
        self.methods = {
            node.name
            for node in self.sidecar.body
            if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef))
        }

    def test_every_registered_handler_is_a_method(self):
        missing = [
            f"{name} (line {line})"
            for name, line in registered_handlers(self.sidecar)
            if name not in self.methods
        ]
        self.assertEqual(missing, [], f"registered but not defined: {'; '.join(missing)}")

    def test_the_working_directory_is_recorded_before_anything_can_run(self):
        """kernel.cwd must not be answered on a lane a run can overtake.

        A run and a debug session are answered on the debug lane and read the
        directory the kernel recorded. While kernel.cwd was answered on the
        execute lane, a cell still running held it up and a run started in the
        directory the user had just left - relative writes landed in the home
        directory, which is the fallback the kernel starts with. Intermittent,
        and it took a loaded machine to see it.

        Inline is the only registration with no queue in front of it. Read
        statically because that is where the mistake lives: the behaviour is
        covered by tests/integration.py, which holds the execute lane busy and
        then runs a file.
        """
        lanes = {}
        for node in ast.walk(self.sidecar):
            registers_a_handler = (
                isinstance(node, ast.Call)
                and isinstance(node.func, ast.Attribute)
                and node.func.attr == "on"
                and len(node.args) > 0
                and isinstance(node.args[0], ast.Constant)
            )
            if not registers_a_handler:
                continue
            lane = next((kw for kw in node.keywords if kw.arg == "lane"), None)
            lanes[node.args[0].value] = None if lane is None else ast.unparse(lane.value)

        self.assertIn("kernel.cwd", lanes, "the scan found no kernel.cwd registration")
        self.assertIsNone(
            lanes["kernel.cwd"],
            f"kernel.cwd is answered on the {lanes['kernel.cwd']} lane, where a run can overtake it",
        )
        # And the two that read the directory are not inline, or the point of
        # the contrast is lost: they are slow, they belong on a lane.
        self.assertEqual(lanes.get("run.start"), "DEBUG")
        self.assertEqual(lanes.get("debug.start"), "DEBUG")

    def test_the_scan_finds_the_registrations_it_is_meant_to(self):
        """A test that finds nothing passes for the wrong reason.

        The count is deliberately a floor rather than an exact number: adding a
        handler must not fail this, but a scan that silently matched nothing
        must.
        """
        names = {name for name, _ in registered_handlers(self.sidecar)}
        self.assertGreater(len(names), 10)
        for expected in ("on_model", "on_viewer_changes", "on_viewer_screenshot", "on_execute"):
            self.assertIn(expected, names)


if __name__ == "__main__":
    unittest.main()
