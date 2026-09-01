// Whether the link to the application itself is still there.
//
// The window talks to Neutralino over a WebSocket, and everything that is not
// drawing goes down it: writing a file, spawning a process, closing the window.
// When it dies, the client library queues each call and never rejects it - so
// nothing is saved, nothing is logged, and the X does nothing, with no error
// anywhere.
//
// Waiting for the socket's own `close` event is not enough, and that is the
// whole reason this module exists. Measured on Windows waking from sleep,
// 0.3.0.dev175: the sidecar's connection was reset and reported 1006, while
// this one stayed open as far as the page could tell and simply swallowed
// everything. A half-open socket cannot be noticed by listening; it has to be
// asked a question.
//
// Pure given a probe and a clock, because what has to be right is the policy -
// how long to wait, how many misses mean gone, and that a machine which was
// merely asleep is not condemned for the one call that spanned the suspend.

/** How often to ask, in milliseconds. Cheap enough to be unnoticeable. */
export const PROBE_INTERVAL = 15000;

/**
 * How often the clock is read, and what counts as it having jumped.
 *
 * A suspended machine runs no timers, so a tick that should have come a second
 * ago and arrives twenty seconds late means the machine slept - which is the
 * event that breaks the link, and the only one worth reacting to instantly. It
 * is the difference between a banner in a few seconds and a banner in up to
 * forty, and after a wake there is nothing to lose by asking straight away.
 */
export const TICK = 500;
export const JUMP = 5000;

/**
 * How long one answer may take when the machine has just woken.
 *
 * A tenth of the patient deadline below, because this is a loopback call - the
 * page asking the process that owns it, normally well under a millisecond - and
 * after a wake the answer either comes at once or is never coming. Half a
 * second is a thousand-fold margin on the call itself and leaves room for a
 * machine still gathering itself.
 *
 * Two of these in a row before the banner, so a single hiccup on a busy resume
 * does not tell somebody to reload a window that was fine: about a second in
 * total, plus up to one tick to notice the wake.
 */
export const WAKE_DEADLINE = 500;

/** How long one answer may take before that attempt counts as a miss. */
export const PROBE_DEADLINE = 5000;

/**
 * Consecutive misses before the link is called dead.
 *
 * Two, because the first probe after a resume is exactly the one likely to have
 * been in flight across the suspend - and a false alarm here tells somebody to
 * reload a window that was fine, which costs them whatever is unsaved.
 */
export const MISSES_ALLOWED = 2;

// Long native work, during which a slow answer is not a dead link.
//
// The probe is a loopback call that normally answers in well under a
// millisecond, so five seconds is a thousand-fold margin - except while this
// application is itself hammering the same connection. `uv sync` on a local
// checkout spawns processes and pumps their output through it line by line,
// and on Windows that was enough for two probes in a row to miss: the banner
// told somebody their window was dead while the install it was running
// finished perfectly.
//
// A count rather than a flag, because the actions nest - a re-install stages
// files, runs uv, then restarts the language server and the kernel.
let held = 0;

/**
 * Stop probing until the returned function is called.
 *
 * Not "stop watching": if the link really does die during an install, the next
 * probe after the hold says so. This only declines to draw a conclusion from
 * an answer that was late because we were busy.
 */
export function holdNativeLink() {
  held += 1;
  let released = false;
  return () => {
    if (!released) {
      released = true;
      held = Math.max(0, held - 1);
    }
  };
}

/** Whether probing is suspended. Exported for the test, which owns the clock. */
export function nativeLinkHeld() {
  return held > 0;
}

/**
 * Ask, repeatedly, and say when the answers stop.
 *
 * @param options.probe a native call that resolves when the link works
 * @param options.onLost called once, when the link is judged gone
 * @param options.interval milliseconds between probes
 * @param options.deadline milliseconds one probe may take
 * @param options.misses consecutive misses before onLost
 * @returns {() => void} stops watching
 */
export function watchNativeLink({
  probe,
  onLost,
  interval = PROBE_INTERVAL,
  deadline = PROBE_DEADLINE,
  misses = MISSES_ALLOWED,
  // The clock and its beat, as parameters, because a test cannot sleep a
  // machine - and a test that waited a real second per tick would be a test
  // nobody runs.
  now = () => Date.now(),
  tick = TICK,
  jump = JUMP,
  wakeDeadline = WAKE_DEADLINE,
  isHeld = nativeLinkHeld,
}) {
  let missed = 0;
  let stopped = false;
  let timer = null;
  let ticker = null;
  let lastTick = now();
  let asking = false;

  const answered = async (limit) => {
    // Raced rather than awaited, because the failure being watched for is a
    // call that never answers at all - awaiting it would hang this watch in
    // exactly the case it exists to report.
    let timeout = null;
    const expiry = new Promise((settle) => {
      timeout = setTimeout(() => settle(false), limit);
    });
    try {
      return await Promise.race([probe().then(() => true, () => true), expiry]);
    } finally {
      clearTimeout(timeout);
    }
  };

  /**
   * Ask straight away, and keep asking briefly, because the machine just woke.
   *
   * Back to back rather than on the interval: the link is either there or it is
   * not, and every second spent finding out is a second somebody spends typing
   * into a window that cannot save. The ordinary schedule resumes if it answers.
   */
  const afterWake = async () => {
    if (stopped || asking) {
      return;
    }
    if (isHeld()) {
      // A wake during a long install. The ordinary round will ask once we are
      // no longer the reason an answer might be slow.
      return;
    }
    asking = true;
    try {
      for (let attempt = 0; attempt < misses; attempt += 1) {
        if (stopped) {
          return;
        }
        if (await answered(wakeDeadline)) {
          missed = 0;
          timer = setTimeout(round, interval);
          return;
        }
      }
      if (!stopped) {
        stopped = true;
        onLost();
      }
    } finally {
      asking = false;
    }
  };

  const round = async () => {
    if (stopped || asking) {
      return;
    }
    if (isHeld()) {
      // Busy on our own account. Reschedule rather than conclude: a late answer
      // now says nothing about the link, only about what we asked it to do.
      timer = setTimeout(round, interval);
      return;
    }
    asking = true;
    try {
      await ask();
    } finally {
      asking = false;
    }
  };

  const ask = async () => {
    // A rejected probe still counts as an answer: the link carried the question
    // and brought back a refusal, which is the opposite of the silence this
    // watches for.
    missed = (await answered(deadline)) ? 0 : missed + 1;
    if (stopped) {
      return;
    }
    if (missed >= misses) {
      stopped = true;
      onLost();
      return;
    }
    timer = setTimeout(round, interval);
  };

  timer = setTimeout(round, interval);

  // The machine waking up, noticed by the clock rather than by an event nobody
  // sends. Asking immediately turns "up to forty seconds" into "about three".
  ticker = setInterval(() => {
    const beat = now();
    const slept = beat - lastTick > jump;
    lastTick = beat;
    if (slept && !stopped) {
      if (timer !== null) {
        clearTimeout(timer);
      }
      void afterWake();
    }
  }, tick);

  return () => {
    stopped = true;
    if (timer !== null) {
      clearTimeout(timer);
    }
    if (ticker !== null) {
      clearInterval(ticker);
    }
  };
}
