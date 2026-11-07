"""What this host's transport sends for a model, and what it refuses.

Two kinds of model carry no geometry, and only one of them is dangerous. A
header listing shapes with no buffers behind them hung three-cad-viewer until
the application was force-quit, so it is refused. A model with no shapes at all
- `show(1)`, `show((1, 2, 3))` - is what the shared page drops without a word in
every other host, so it is dropped here too, and so is the mapping after it.
"""

import base64
import sys
import unittest
from unittest import mock

from build123d_studio.comms import StudioComms

# The module, not `build123d_studio.comms`: the package exports its instance of
# StudioComms under that name, which hides the module from a plain import.
TRANSPORT = sys.modules[StudioComms.__module__]

ARRAY = {"shape": [3], "dtype": "float32", "codec": "b64",
         "buffer": base64.b64encode(b"\0" * 12).decode()}


def model(parts):
    return {"type": "data", "config": {}, "count": len(parts), "data": {"shapes": {"parts": parts}}}


class ModelTest(unittest.TestCase):
    def setUp(self):
        self.models = []
        self.mappings = []
        patches = (
            mock.patch.object(TRANSPORT, "send_model", lambda header, payload: self.models.append((header, payload))),
            mock.patch.object(TRANSPORT, "send_mapping", lambda mapping: self.mappings.append(mapping)),
        )
        for patch in patches:
            patch.start()
            self.addCleanup(patch.stop)
        self.comms = StudioComms()

    def test_a_model_with_geometry_is_sent_with_its_mapping(self):
        self.comms.send_data(model([{"id": "/Box", "shape": {"vertices": ARRAY}}]))
        self.comms.send_backend({"model": {"/Box": "brep"}})

        self.assertEqual(len(self.models), 1)
        self.assertGreater(len(self.models[0][1]), 0, "the geometry did not travel")
        self.assertEqual(self.mappings, [{"/Box": "brep"}])

    def test_shapes_without_geometry_are_refused(self):
        with self.assertRaises(ValueError):
            self.comms.send_data(model([{"id": "/Floats", "shape": {}}]))
        self.assertEqual(self.models, [])

    def test_a_model_with_no_shapes_is_dropped_quietly_with_its_mapping(self):
        """show(1): nothing to draw, nothing raised, and the measurement model kept."""
        self.assertIsNone(self.comms.send_data(model([])))
        self.comms.send_backend({"model": {}})

        self.assertEqual(self.models, [])
        self.assertEqual(self.mappings, [])

    def test_and_the_next_real_model_sends_its_mapping_again(self):
        self.comms.send_data(model([]))
        self.comms.send_backend({"model": {}})
        self.comms.send_data(model([{"id": "/Box", "shape": {"vertices": ARRAY}}]))
        self.comms.send_backend({"model": {"/Box": "brep"}})

        self.assertEqual(len(self.models), 1)
        self.assertEqual(self.mappings, [{"/Box": "brep"}])

    def test_a_clear_frame_still_goes_through(self):
        self.comms.send_data({"type": "clear"})
        self.assertEqual(self.models[0][0]["type"], "clear")


if __name__ == "__main__":
    unittest.main()
