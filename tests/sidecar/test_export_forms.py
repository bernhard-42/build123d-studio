"""The sidecar's half of the Export dialog: ask the kernel, answer the request.

The answer always goes back with the request's id - ipc.request in the frontend
drops a reply without it as abandoned - and with forms=None whenever the kernel
was not asked or did not answer, so the dialog can say so rather than wait out
its timeout.
"""

import os
import tempfile
import unittest

from instance import Instance
from main import Sidecar
from test_run_queue import FakeChannel, FakeKernel


class ExportFormsTest(unittest.TestCase):
    def setUp(self):
        root = tempfile.mkdtemp(prefix="studio-export-")
        instance = Instance(root)
        instance.claim()
        self.addCleanup(instance.release)
        self.sidecar = Sidecar(
            env_root=root, app_dir=root, instance=instance, settings_path=os.path.join(root, "settings.json")
        )
        self.channel = FakeChannel()
        self.sidecar.channel = self.channel
        self.sidecar.kernel = FakeKernel()
        self.sidecar.kernel.answers = {".forms()": '[{"format": "STEP", "available": true, "options": []}]'}

    def test_the_kernels_forms_go_back_with_the_requests_id(self):
        self.sidecar.on_export_forms({"id": "export.forms#3"})
        self.assertEqual(
            self.channel.sent,
            [("export.forms", {"id": "export.forms#3", "forms": [{"format": "STEP", "available": True, "options": []}]})],
        )

    def test_the_kernel_is_not_asked_while_the_warm_up_imports(self):
        """For refresh_variables' reason: importing build123d_studio.exporting
        while the main thread initialises the package wedged the kernel."""
        self.sidecar._warm_request = "warm-1"
        self.sidecar.on_export_forms({"id": "export.forms#4"})
        self.assertEqual(self.channel.sent, [("export.forms", {"id": "export.forms#4", "forms": None})])

    def test_no_kernel_is_answered_too(self):
        self.sidecar.kernel = None
        self.sidecar.on_export_forms({"id": "export.forms#5"})
        self.assertEqual(self.channel.sent, [("export.forms", {"id": "export.forms#5", "forms": None})])

    def test_an_inspection_that_does_not_answer_is_none_not_silence(self):
        self.sidecar.kernel.answers = {}
        self.sidecar.on_export_forms({"id": "export.forms#6"})
        self.assertEqual(self.channel.sent, [("export.forms", {"id": "export.forms#6", "forms": None})])


if __name__ == "__main__":
    unittest.main()
