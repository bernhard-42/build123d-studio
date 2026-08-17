"""This host's transport: what the shared show pipeline needs from us.

`Comms` is a *client* transport and only that - every method on it exists
because the core has to initiate something. The measurement backend is the
other direction and needs nothing here: it always answers someone who already
reached in, so `sidecar/measure_process.py` computes and returns, and
`main.on_viewer_changes` writes the answer back on the websocket the request
arrived on.

The two reads a show makes - `status` and `workspace_config` - are questions,
and they are asked before any model is sent. They are answered from different
places, and the split is the point: the persistent settings are a file this
host owns, so `settings.py` reads them here, while the viewer's live state
belongs to the frontend and comes back over the socket. Neither asks the
browser anything synchronously, which is what every other host does too.
"""

from ocp_viewer_core.comms import Comms

from . import settings
from .buffers import split_buffers
from .transport import ask, send_config, send_mapping, send_model


class StudioComms(Comms[None]):
    """build123d Studio's viewer, at the other end of a local socket.

    `H` is `None`: there is no handle to hand back. The viewer is the pane
    above the editor, there is only ever one of it, and `show()` returns
    nothing - as it does in ocp_vscode and the standalone.
    """

    def send_data(self, data, timeit=False):
        """Send a model, as a JSON header and one contiguous block of buffers.

        The tessellation arrives with every array base64'd inside the JSON,
        because `numpy_to_buffer_json` was written for a text websocket. This
        host does not have one: `split_buffers` pulls each array out into a
        binary payload and leaves an {offset, length} reference behind, and the
        frontend builds typed-array views straight onto the received frame
        without copying or parsing anything numeric.

        A model with no geometry is refused rather than sent. `_convert` will
        produce one from a list of floats - a header describing shapes with no
        buffers behind them - and three-cad-viewer does not come back from it;
        the application had to be force-quit. Refusing here covers every caller.
        """
        payload_free, payload = split_buffers(data.get("data"))

        if len(payload) == 0:
            raise ValueError(
                "nothing to show: the objects given have no geometry the viewer can draw"
            )

        header = {
            "type": data.get("type", "data"),
            "config": data.get("config", {}),
            "count": data.get("count"),
            "data": payload_free,
        }
        send_model(header, payload)
        return None

    def send_backend(self, data, timeit=False):
        """Send the id-to-shape mapping of the model just drawn.

        Its own message rather than a field of the model's, because the mapping
        is full of serialised BREP that the frontend cannot use and must not be
        made to carry - it would roughly double the traffic to the webview. The
        sidecar keeps it and the measurement process reads it.

        **Unwrapped here.** The core sends `{"model": mapping}`, and every host
        takes the mapping out of it before the backend sees it - ocp_viewer at
        `sockets.py`'s `handle_event(orjson.loads(payload)["model"], ...)`, the
        websocket client at `websocket.py:341`. This host unwraps at the sending
        end rather than the receiving one, because unwrapping on the sidecar
        would mean parsing and re-encoding the whole mapping - kilobytes for a
        box and far more for an assembly - to remove one key.

        (The sidecar does not in fact hand the bytes on untouched, as an earlier
        version of this said: they are decoded, wrapped, re-encoded and parsed
        again on the way to the measurement process. That is worth removing, and
        it is a separate matter from where the unwrap belongs.)

        Getting this wrong is silent, which is the reason for the paragraph:
        `load_model` walks an envelope, finds no shapes, indexes nothing, and
        every measurement afterwards answers with nothing at all.
        """
        send_mapping(data.get("model", data) if isinstance(data, dict) else data)

    def send_config(self, config, timeit=False):
        """Send a `ui` config block to the viewer that is already on screen."""
        send_config(config)

    def send_command(self, data, timeit=False):
        """Send a command and return the viewer's answer."""
        return ask(data)

    def status(self):
        """The viewer's live state - what the user has changed at the toolbar.

        Answered by the sidecar from the picture the frontend pushes up as it
        changes. Frontend-to-Python notification is asynchronous everywhere
        else, so a stale status is merged and never depended on; ours happens
        to have no kernel in the path and so can be fresh - a property to keep
        here and never to rely on in shared code, or the same script would
        behave differently in this application than in VS Code.
        """
        return ask({"command": "status"})

    def workspace_config(self):
        """Every viewer setting this host persists, plus the splash flag.

        The Settings dialog's Viewer tab, as ocp_vscode's answer is its viewer
        settings section, the standalone's is `~/.ocpvscode_standalone` and
        Jupyter CadQuery's is `~/.jcq_config`. All four answer the *whole* set
        rather than the changed part of it: this is the top layer of the merge,
        the one Python cannot know by itself, and a key left out of it is not a
        default - it is a key the renderer never hears about, so whatever the
        viewer already holds survives. After startup that is the splash logo's
        own configuration.

        Read here rather than asked of the sidecar: it is a file this host
        owns, and `Comms` is what reaches the host's persistent settings. Only
        `_splash` needs the round trip - whether the logo is still on screen is
        the frontend's fact, and a second process cannot guess it.
        """
        config = settings.workspace_config()
        config["_splash"] = bool(ask({"command": "splash"}).get("_splash", False))
        return config
