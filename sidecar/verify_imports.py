"""Import what the application needs, saying which one is happening.

Run once by the bootstrap, after a first install and after any package change.
The imports themselves are not the point - the kernel would do them anyway - the
point is *when* they are paid. macOS verifies OpenCascade's signed libraries the
first time they are loaded after they change, and that is minutes nobody
expects. Measured on an M1, each step after the one before it:

    import OCP          28.0 s
    import build123d    28.5 s
    import cadquery     49.5 s

and microseconds each on the second run. Paid here it is progress on a splash;
paid at the user's first Run it is a kernel that appears to have hung.

**The imports are deliberately not at the top of this file**, which is the one
place that rule does not serve its purpose: the whole job is to announce each
one *before* it blocks. A single line sitting unchanged for a hundred seconds
says nothing about whether anything is happening, and the cost is paid in three
distinct chunks that are worth naming separately.

cadquery only when it is there. It is not one of this application's own
dependencies - a user adds it - and importing it when it is absent would turn a
verification into a failure.

**REQUIRED_READY is printed once the two that matter are in**, so the caller can
tell "this environment cannot import OCP" from "the optional third one was
unhappy". Without it every non-zero exit read as the former, and the message the
user got named OCP and build123d whatever had actually gone wrong.

**And the process leaves through os._exit**, which is the one place in this
codebase that is right. Measured on gauss (Windows, 2026-09-07): with cadquery
installed, all three imports succeed - faulthandler shows `cadquery imported ok`
- and the interpreter then faults with 0xC0000374, heap corruption, in teardown
with no Python frame on the stack. Unloading the OpenCascade DLL set corrupts
the heap there. The caller reads the exit code, so a run that did its whole job
was reported as an environment that cannot import anything. Three runs with
os._exit: 0, 0, 0. There is nothing to clean up here - the process exists to
warm a cache and say so - so skipping the teardown costs nothing and removes the
only part of the run that has ever failed.
"""

import importlib.util
import os
import sys

# Printed when OCP and build123d are in. Matched by src/bootstrap/setup.js;
# changing the text means changing it there.
REQUIRED_READY = "OCP and build123d are ready"

print("Importing OCP the first time (takes about 30 sec)", flush=True)
import OCP  # noqa: E402, F401  - the import is the work being timed

print("Importing build123d the first time (takes about 30 sec)", flush=True)
import build123d  # noqa: E402, F401

print(REQUIRED_READY, flush=True)

if importlib.util.find_spec("cadquery") is not None:
    print("Importing cadquery the first time (takes about 60 sec)", flush=True)
    import cadquery  # noqa: E402, F401

sys.stdout.flush()
sys.stderr.flush()
os._exit(0)
