"""A jupyter console that behaves properly when another client is executing.

build123d-studio runs a real ``jupyter console`` attached to the shared kernel, so the
bottom-left pane is genuine IPython - one transcript, an inline ``In [n]:``
prompt, real line editing, magics, ``?``/``??``. Code the user runs from the
Monaco pane is sent to the same kernel over ZMQ, so it shows up here too.

Stock jupyter_console has two problems in exactly that situation:

* multi-line output staircases across the screen, because
  ``handle_external_iopub`` writes bare ``\\n`` to ``sys.stdout`` while
  prompt_toolkit holds the terminal in raw mode;
* the ``In [n]:`` prompt is intermittently missing, because the same code
  writes over prompt_toolkit's screen without telling it.

Both are fixed here by printing through ``run_in_terminal`` - prompt_toolkit's
supported way to write while a prompt is live - with newline translation done
explicitly on the way out.

Everything is done by subclassing. Nothing is monkey-patched onto
jupyter_console's classes.
"""

import asyncio
import io
import signal
import sys
import time
from functools import partial

from jupyter_client.utils import ensure_async
from jupyter_console.app import JupyterConsoleApp, ZMQTerminalIPythonApp
from jupyter_console.ptshell import ZMQTerminalInteractiveShell
from prompt_toolkit.application import run_in_terminal
from traitlets import Bool, Unicode

# Prompt colours, matching the convention used elsewhere in these tools:
# green for input, red for output.
GREEN = "\x1b[32m"
RED = "\x1b[31m"
DIM = "\x1b[2m"
RESET = "\x1b[0m"

# Continuation marker for the second and later lines of another client's code,
# aligned under the "In [n]: " prompt exactly as IPython indents its own.
CONTINUATION = "   ...: "

# How many lines of another client's code to echo before truncating. Running a
# whole file is a normal action here, and echoing every line of a module would
# bury the transcript.
MAX_ECHO_LINES = 10

# How often iopub is drained while the terminal is held for another client's
# execution. handle_external_iopub's own half-second poll is fine for noticing
# that something started; once it has, output should appear as it is produced
# rather than in half-second batches.
FOLLOW_POLL = 0.05


class _CrlfWriter:
    """Stream wrapper translating "\\n" into "\\r\\n".

    prompt_toolkit keeps the terminal in raw mode for the whole session, so a
    bare line feed moves the cursor down a row without returning it to column
    zero. Text printed by anything other than prompt_toolkit itself therefore
    walks diagonally down the screen unless it is translated here.

    It also formats the one write that carries another client's code, so that a
    multi-line editor run reads the way IPython's own multi-line input does.
    See Build123dStudioShell.print_remote_prompt for why that is done here.
    """

    def __init__(self, stream, shell=None):
        self._stream = stream
        self._shell = shell

    def write(self, text):
        if self._shell is not None and self._shell._expect_remote_code:
            self._shell._expect_remote_code = False
            text = format_remote_code(text)
        return self._stream.write(text.replace("\n", "\r\n"))

    def flush(self):
        self._stream.flush()

    def __getattr__(self, name):
        return getattr(self._stream, name)


def format_remote_code(code, max_lines=MAX_ECHO_LINES):
    """Lay another client's code out like IPython's own multi-line input.

    The first line follows the "In [n]: " prompt already on the screen and the
    rest are indented under a "...:" continuation, matching what the user sees
    when typing a block directly into the console.

    Long input is truncated: "run whole file" would otherwise echo an entire
    module into the transcript every time it is used.
    """
    lines = code.rstrip("\n").split("\n")
    if len(lines) == 1:
        return lines[0] + "\n"

    shown = lines if len(lines) <= max_lines else lines[:max_lines]
    out = [shown[0]]
    out.extend(f"{CONTINUATION}{line}" for line in shown[1:])
    if len(lines) > max_lines:
        remaining = len(lines) - max_lines
        out.append(f"{DIM}{CONTINUATION}[+ {remaining} more lines]{RESET}")
    return "\n".join(out) + "\n"


class Build123dStudioShell(ZMQTerminalInteractiveShell):
    """ZMQTerminalInteractiveShell that plays nicely with a second client."""

    # Show what other clients do. Without this the console stays silent while
    # the editor runs code against the same kernel, which is the opposite of
    # what this pane is for.
    include_other_output = Bool(True)

    # Stock jupyter_console labels other clients' input "Remote In [n]:". Here
    # "the other client" is the user's own editor pane, so the distinction is
    # noise - drop the prefix and let it read as a plain "In [n]:".
    other_output_prefix = Unicode("")

    # Set by print_remote_prompt, consumed by the very next write. See there.
    _expect_remote_code = False

    # Set when another client's *code* has just been echoed, which is what tells
    # _render_pending to hold the terminal until that execution finishes.
    #
    # Deliberately not driven by _execution_state alone. The sidecar issues
    # silent execute_requests of its own - the build123d warm-up at startup, and
    # a namespace inspection after every single idle - and those move the
    # execution state to busy exactly like a user's cell does. Holding the
    # terminal for them would take the prompt away for the two seconds of the
    # warm-up and flicker it after every command. A silent request publishes no
    # execute_input, so it never reaches print_remote_prompt, which makes "did we
    # echo somebody's code" precisely the distinction that is wanted.
    _saw_remote_input = False

    # The In[n] of the other client's cell being echoed, so the prompt that
    # follows it can be numbered after it. See _follow_remote_execution.
    _remote_execution_count = None

    # --- prompts ---
    #
    # The base class draws prompts with print_formatted_text() against
    # prompt_toolkit's application output, while the payload that follows (the
    # code echo, the repr of a result) goes to sys.stdout. Two sinks with
    # different buffering, so the transcript came out as "Out[2]: In [2]: 21 * 2"
    # with the value stranded on the next line.
    #
    # Rendering the tokens into a detached Vt100_Output and writing the result
    # to sys.stdout looks like the fix and is not: print_formatted_text produces
    # nothing at all when an Application is already running. Since these prompts
    # are three short fixed strings, they are simply written as ANSI text, which
    # puts them in the same ordered stream as everything else.

    def print_out_prompt(self):
        sys.stdout.write(f"{RED}Out[{self.execution_count}]: {RESET}")

    def print_remote_prompt(self, ec=None):
        # Two call sites in the base class: one echoes another client's input
        # and passes the execution count, the other tacks a fresh prompt on
        # after that client's output and passes nothing. The second is
        # redundant here - run_in_terminal redraws the real prompt immediately
        # afterwards - and printing it produced a doubled "In [2]: In [2]:".
        if ec is None:
            return
        sys.stdout.write(f"{GREEN}{self.other_output_prefix}In [{ec}]: {RESET}")
        self._saw_remote_input = True
        self._remote_execution_count = int(ec)

        # In the base class this call is immediately followed by
        # `sys.stdout.write(content['code'] + '\n')`, with nothing in between.
        # Flagging it here lets the writer format that one string, which is far
        # less fragile than duplicating handle_iopub's ~120 lines just to reach
        # a single write - a copy that would quietly drift from upstream.
        self._expect_remote_code = True

    def _drain_pending(self):
        """Consume pending iopub messages, capturing what they would print.

        Deliberately *not* inside run_in_terminal, which is the whole point.
        Most of what arrives here prints nothing at all: a silent
        execute_request still publishes status busy and status idle, and the
        application makes those constantly on its own behalf - the warm-up
        import and every variable-explorer refresh. Rendering them inside
        run_in_terminal meant erasing and redrawing the prompt for traffic with
        no output, and a redraw is not free: prompt_toolkit reserves room below
        the prompt by writing a screenful of newlines and then moving the cursor
        back up, so in a pane shorter than that reservation each one scrolls.

        The result was a console that pushed its own banner off the top and left
        a column of stale "In [1]:" prompts behind - reported as four of them
        with only the last still on screen. It appeared when the warm-up moved
        after the console's handshake, because that put the application's own
        kernel traffic *after* the first prompt was drawn rather than before.

        So the messages are consumed with output captured to a buffer, and the
        terminal is only taken if there is something to put in it.
        """
        buffer = io.StringIO()
        real_stdout, real_stderr = sys.stdout, sys.stderr
        sys.stdout = _CrlfWriter(buffer, shell=self)
        sys.stderr = _CrlfWriter(buffer)
        self._expect_remote_code = False
        try:
            self.handle_iopub()
        except Exception as exc:  # noqa: BLE001 - one bad message must not stop the stream
            buffer.write(f"\r\n[build123d-studio] error rendering kernel output: {exc}\r\n")
        finally:
            sys.stdout, sys.stderr = real_stdout, real_stderr
        return buffer.getvalue()

    def _emit(self, text):
        """Print captured output with the prompt out of the way.

        Called from run_in_terminal, so the prompt has already been erased and
        the cursor sits on a clean line. The text arrives already translated by
        _CrlfWriter, so it goes to the real stream untouched; only the follow
        below prints anything new, and that needs the wrapper again.
        """
        real_stdout, real_stderr = sys.stdout, sys.stderr
        try:
            real_stdout.write(text)
            real_stdout.flush()
            if self._saw_remote_input:
                self._saw_remote_input = False
                sys.stdout = _CrlfWriter(real_stdout, shell=self)
                sys.stderr = _CrlfWriter(real_stderr)
                self._follow_remote_execution()
        except Exception as exc:  # noqa: BLE001 - one bad message must not stop the stream
            real_stderr.write(f"\r\n[build123d-studio] error rendering kernel output: {exc}\r\n")
        finally:
            try:
                sys.stdout.flush()
                sys.stderr.flush()
            finally:
                sys.stdout, sys.stderr = real_stdout, real_stderr

    def _follow_remote_execution(self):
        """Keep the terminal until the other client's execution finishes.

        Called from inside run_in_terminal, so the prompt is already erased and
        returning is what redraws it. Staying here is therefore the same thing
        as not showing a prompt.

        Without it the prompt came back the instant the code had been echoed.
        Running

            for i in range(10):
                sleep(1)

        from the editor printed "In [5]:" immediately and the session looked
        finished for the ten seconds it was actually running - and with prints
        in the loop the output arrived underneath a prompt that had been sitting
        there the whole time. The console has no notion of "somebody else is
        executing": only run_cell waits on _execution_state, and that runs for
        the console's own input.

        A wedged kernel leaves this waiting with no prompt. That is recoverable
        - the toolbar's Interrupt ends the execution and the prompt returns -
        and it is the honest display, since a prompt would not accept anything
        either.
        """
        while (
            self.keep_running
            and self._execution_state == "busy"
            and self.client.is_alive()
        ):
            try:
                time.sleep(FOLLOW_POLL)
                self.handle_iopub()
            except KeyboardInterrupt:
                # Ctrl-C cannot interrupt the kernel from here - this console
                # attached with --existing and has no kernel manager, so
                # handle_sigint raises rather than interrupting. Give the prompt
                # back instead of looking stuck.
                break

        # Number the next prompt after the cell that has just run.
        #
        # handle_iopub keeps the kernel's counter in two places: execute_input
        # sets it to ec + 1, and execute_result sets it back to ec so that
        # "Out[n]" carries the number of the cell it belongs to. For the
        # console's own input, handle_execute_reply then puts it back to ec + 1
        # - but another client's reply goes to that client, so nothing restored
        # it here. A cell run from the editor that *returned a value* therefore
        # left the counter one short and the next prompt repeated the number
        # that had just been used:
        #
        #     Out[1]: bbox: -5.0 <= x <= 5.0, ...
        #
        #     In [1]:
        #
        # A cell returning nothing publishes no execute_result and was
        # unaffected, which is what made it look intermittent rather than
        # systematic.
        if self._remote_execution_count is not None:
            self.execution_count = max(self.execution_count, self._remote_execution_count + 1)
            self._remote_execution_count = None

    async def handle_external_iopub(self, loop=None):
        """Poll iopub while sitting at the prompt, printing above it.

        Same polling loop as the base class, but the printing is handed to
        run_in_terminal rather than written straight at sys.stdout.

        patch_stdout looks like the obvious tool here and is not: its
        StdoutProxy only ever flushes up to the last newline and holds a
        trailing partial line back in a buffer that is dropped when the context
        exits. Prompts are exactly that - "Out[2]: " has its value printed after
        it on the same line - so they disappeared. run_in_terminal instead
        erases the prompt, runs everything with the terminal free, and redraws
        afterwards, which is what this situation actually calls for.
        """
        while self.keep_running:
            poll_result = await ensure_async(self.client.iopub_channel.socket.poll(0))
            if poll_result:
                # Consumed first, printed second, and only if there is anything
                # to print - see _drain_pending. _saw_remote_input is checked as
                # well as the text, because following another client's run to
                # its end is a reason to hold the terminal even for a moment
                # when nothing has been written yet.
                pending = self._drain_pending()
                if pending != "" or self._saw_remote_input:
                    await run_in_terminal(partial(self._emit, pending))
            await asyncio.sleep(0.5)


class Build123dStudioConsoleApp(ZMQTerminalIPythonApp):
    """jupyter console app that instantiates the patched shell."""

    def init_shell(self):
        # Mirrors ZMQTerminalIPythonApp.init_shell but builds our subclass. The
        # base implementation names ZMQTerminalInteractiveShell directly, so
        # there is no configuration hook that would avoid overriding this.
        JupyterConsoleApp.initialize(self)
        signal.signal(signal.SIGINT, self.handle_sigint)
        self.shell = Build123dStudioShell.instance(
            parent=self,
            manager=self.kernel_manager,
            client=self.kernel_client,
            confirm_exit=self.confirm_exit,
        )
        self.shell.own_kernel = not self.existing


main = Build123dStudioConsoleApp.launch_instance

if __name__ == "__main__":
    main()
