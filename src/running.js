// What this application has started and can still stop.
//
// Apart from proc.js, and apart from Neutralino, for the same reason quoting.js
// is: what matters here is the bookkeeping - what goes in, what comes out, and
// what a quit does with whatever is left - and none of that needs a process to
// be tested against.
//
// It exists because the fire-and-forget spawns had no teardown at all. uv, the
// curl that fetches it, the tar that unpacks it and the interpreter that warms
// the geometry kernel were all started by run(), which awaits the exit and
// discards the handle - the only thing carrying kill(). Nothing recorded their
// ids anywhere, and Neutralino kills nothing of its own at exit, so closing the
// window during a first run left uv installing into an environment belonging to
// an application that was no longer there. Usually it finishes. Given a package
// source it has to reach the network for, it need not.

/**
 * A set of running processes, and the one thing a quit has to do with them.
 *
 * A factory rather than a module-level set, so that a test gets its own and the
 * order tests run in cannot matter.
 */
export function createRegistry() {
  const live = new Set();

  return {
    /** Record a process as running. Returns it, so it can wrap a spawn. */
    track(handle) {
      live.add(handle);
      return handle;
    },

    /** Forget one that has ended. Idempotent: an unknown handle is not an error. */
    forget(handle) {
      live.delete(handle);
    },

    /** How many are running, for a test or a log line. */
    count() {
      return live.size;
    },

    /**
     * Stop everything still running, and report how many that was.
     *
     * **Awaited, because killing is asynchronous.** Neutralino's kill is an IPC
     * call to the native side, so a caller that does not wait can reach
     * app.exit() before the request has been sent - which would leave exactly
     * the processes this exists to collect.
     *
     * Isolated per process for the same reason the sidecar's teardown is: one
     * that cannot be killed - it may have exited a moment ago, and its handle is
     * then stale - is no reason to leave the rest running.
     *
     * The set is cleared whatever happens. A second call during the same quit
     * has nothing to do rather than killing twice.
     */
    async stopAll({ onError } = {}) {
      const stopping = [...live];
      live.clear();
      await Promise.all(stopping.map(async (handle) => {
        try {
          await handle.kill();
        } catch (error) {
          if (onError !== undefined) {
            onError(handle, error);
          }
        }
      }));
      return stopping.length;
    },
  };
}
