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
"""

import importlib.util

print("Importing OCP the first time (takes about 30 sec)", flush=True)
import OCP  # noqa: E402, F401  - the import is the work being timed

print("Importing build123d the first time (takes about 30 sec)", flush=True)
import build123d  # noqa: E402, F401

if importlib.util.find_spec("cadquery") is not None:
    print("Importing cadquery the first time (takes about 60 sec)", flush=True)
    import cadquery  # noqa: E402, F401
