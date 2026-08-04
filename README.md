# build123d Studio

An IDE for [build123d](https://github.com/gumyr/build123d): a Monaco editor, a three-cad-viewer viewport, a real Jupyter console and a variable explorer, in one window, with an encapsulated Python environment it builds for itself on first start.

> **This README is a placeholder.** Only the section below is written. The rest — what the application is, installing it, first start, the panes, running code, debugging, the command line — is still to be written, and `.github/workflows/package.yml` already links here for the install notes it currently carries itself.

## Settings → Packages

Reached from the application menu. The tab reads top to bottom as three things you can do, each with the button that does it directly underneath:

```
build123d      ( ) PyPI   ( ) GitHub dev branch   ( ) Local checkout [path] [Choose…]
               [ Re-install build123d ]

Additional packages
               ┌────────────────────────┐
               │                        │
               └────────────────────────┘
               [ Install packages ]

Upgrade        [ Upgrade packages ]

                                          [ Cancel ]  [ Apply ]
```

**Only Apply and Cancel close the dialog.** Install, Re-install and Upgrade act on the environment and return to it, on success as well as on failure — so there is never a question of what happened or where you now are.

| button | what it does |
| --- | --- |
| **Apply** | Saves every field and closes. Touches nothing else — no uv, no kernel restart. |
| **Install packages** | Saves, then makes the environment match what is declared: `uv lock` then `uv sync`. Adds what is new and leaves every already-locked package where it is. |
| **Re-install build123d** | Saves, then `uv sync --reinstall-package build123d`. For a local checkout: uv installs a `path` source as a built copy, so editing your source tree changes nothing until it is installed again — and since the lock has not changed, an ordinary Install is a no-op. This is the only thing that picks up your edits. |
| **Upgrade packages** | Saves, then `uv lock --upgrade` then `uv sync`. Every package moves as far as its own version range allows. Anything pinned to an exact version cannot move, which is what holds the viewer's packages still. |

Saving without installing is coherent: the application runs `uv sync` on every launch, so a change that was applied but not installed simply lands at the next start.

### Additional packages

One requirement per line. The line itself says where the package comes from — there is no source picker, because the string is the source:

```
ocp-widgets>=0.3                              PyPI, with or without a version range
/Users/me/src/mylib                           a local checkout
git+https://github.com/someone/mylib@main     a git repository
mylib @ git+https://github.com/x/python-lib   named explicitly
```

The name is taken from the last path segment when it is not given, which is right for most repositories and wrong whenever the distribution is not named after its folder — `python-foo` shipping `foo`. The `name @ source` form is the way to say so.

Two rules are enforced here, and only two:

- a package the application already declares — `build123d`, `ocp_vscode` and the rest — cannot be named, because uv *intersects* duplicate declarations rather than letting the later one win, so such an entry would silently do nothing
- the same package cannot be given twice

Everything else — whether a version exists, whether a combination resolves, whether a URL is reachable — is uv's to answer, and it answers better than a rule here would. A line that breaks the environment does not prevent the application from starting: the failed section is dropped for that launch, with the text left in Settings to be corrected.

## Licence

Apache-2.0. See `LICENSE`, `NOTICE` and `THIRD_PARTY_LICENSES.md`.
