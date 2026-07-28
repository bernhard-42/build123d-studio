"""Version and environment facts for the About dialog.

Read from installed package metadata rather than by importing the packages:
importlib.metadata only reads dist-info, so this stays instant and works even
before the measurement backend's OCP import has finished. Importing OCP merely
to read a version number would cost seconds.
"""

import importlib.metadata as metadata
import platform
import sys

# Shown in this order. The left-hand name is what the dialog displays; the right
# is the distribution as it appears on PyPI, which is not always the same as the
# module you import - OCP in particular comes from a wheel called
# cadquery-ocp-novtk, and knowing which one is installed matters when a version
# looks wrong.
PACKAGES = [
    ("build123d", "build123d"),
    ("OCP (cadquery-ocp-novtk)", "cadquery-ocp-novtk"),
    ("ocp_vscode", "ocp_vscode"),
    ("ocp_tessellate", "ocp_tessellate"),
    ("ocpsvg", "ocpsvg"),
    ("ipykernel", "ipykernel"),
    ("jupyter_client", "jupyter_client"),
    ("jupyter_console", "jupyter_console"),
    ("IPython", "ipython"),
    ("prompt_toolkit", "prompt_toolkit"),
    ("numpy", "numpy"),
    ("pyzmq", "pyzmq"),
]


def installed():
    """Every distribution in the environment, as `uv pip list` would report it.

    Read from dist-info rather than by shelling out to uv: the answer is the
    same, it costs no subprocess, and it cannot be wrong about which environment
    was inspected - this is running inside the one being described.

    Distributions can appear twice if a path is repeated on sys.path, so names
    are de-duplicated. Sorted case-insensitively, since the list is long enough
    that people scan it alphabetically.
    """
    found = {}
    for distribution in metadata.distributions():
        name = distribution.metadata["Name"]
        if name is None or name in found:
            continue
        found[name] = distribution.version or "unknown"
    return [
        {"name": name, "version": version}
        for name, version in sorted(found.items(), key=lambda item: item[0].lower())
    ]


def collect(env_root, connection_file):
    """Everything the About dialog shows from the Python side."""
    packages = []
    for label, distribution in PACKAGES:
        try:
            packages.append({"name": label, "version": metadata.version(distribution)})
        except metadata.PackageNotFoundError:
            packages.append({"name": label, "version": "not installed"})

    return {
        "allPackages": installed(),
        "python": platform.python_version(),
        "pythonBuild": " ".join(platform.python_build()),
        "implementation": platform.python_implementation(),
        "executable": sys.executable,
        "envRoot": env_root,
        "connectionFile": connection_file,
        "packages": packages,
    }
