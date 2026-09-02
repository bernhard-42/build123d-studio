# The commands this project is driven by, so that none of them has to be
# remembered - and so that the multi-step ones cannot be half-done.
#
# Two things here are not conveniences and should not be run any other way:
#
#   bump      writes the version into *two* files that must agree. package.json
#             is what the About dialog reads; neutralino.config.json is what the
#             CLI stamps into the packaged binary's metadata, which on Windows
#             is what the Properties dialog shows.
#   package   builds the bundle before packaging it. A package built from stale
#             resources looks exactly like a fresh one, and that mistake has
#             cost a testing round more than once.
#
# The four suites are separate targets because they cost different amounts:
# `test` is under a second, `test-frontend` is six minutes. `check` is the lint
# pass over both languages.

.PHONY: help clean install check test test-sidecar test-frontend test-integration \
        tests build package package-mac package-win package-linux \
        bump release sums version

NODE_MODULES := node_modules
VERSION := $(shell node -p "require('./package.json').version")
DEV_BUILD := $(shell cat .dev-build 2>/dev/null || echo 0)

help:
	@echo "build123d Studio $(VERSION) (dev build $(DEV_BUILD))"
	@echo
	@echo "  make install           yarn install"
	@echo "  make check             eslint over src/tests, ruff over sidecar/kernel"
	@echo
	@echo "  make test              unit suite        (node --test, ~1s)"
	@echo "  make test-sidecar      sidecar suite     (~80s, needs the runtime env)"
	@echo "  make test-frontend     frontend suite    (~6min, Playwright/WebKit)"
	@echo "  make test-integration  integration suite (~3min, real kernel)"
	@echo "  make tests             all four, in that order"
	@echo
	@echo "  make build             vite + neu build into resources/"
	@echo "  make package           this platform, with the dev build number bumped"
	@echo "  make package-mac|-win|-linux   one target, without bumping"
	@echo
	@echo "  make bump part=minor   or  make bump version=1.2.3"
	@echo "  make release           commit the version and tag it"
	@echo "  make sums              checksums of this version's packages"
	@echo "  make version           what this tree says it is"
	@echo "  make clean             build output, packages and test results"

version:
	@echo "$(VERSION) (dev build $(DEV_BUILD))"

clean:
	@echo "=> Cleaning"
	@rm -rf dist resources release/dmg release/build123d-studio \
	        release/build123d-studio.AppDir test-results tests/frontend/build

install:
	yarn install

# --- checking and testing ---------------------------------------------------

check:
	npx eslint .
	uvx ruff@0.16.3 check sidecar/ kernel/ tests/

test:
	yarn test

test-sidecar:
	yarn test:sidecar

test-frontend:
	yarn test:frontend

test-integration:
	yarn test:integration

# Cheapest first, so a failure that any of them would catch is reported by the
# one that costs the least.
tests: test test-sidecar test-integration test-frontend

# --- building and packaging -------------------------------------------------

build:
	yarn package:build

# The dev build number is bumped here and nowhere else. Two packages of one
# version are otherwise indistinguishable once installed, which has already
# cost a Windows fix being tested twice against a package that predated it.
package:
	yarn package:dev

package-mac: build
	node scripts/package.mjs --target darwin-arm64

package-win: build
	node scripts/package.mjs --target win32-x64

# The AppImage cannot be built here - appimagetool is an x86_64 ELF and dies
# with ENOEXEC on macOS - so this leaves the AppDir, which CI turns into an
# AppImage. See scripts/package.mjs.
package-linux: build
	node scripts/package.mjs --target linux-x64

# --- version and release ----------------------------------------------------

# What SHA256SUMS.txt will hold for this version, so a local package can be
# checked the same way a released one is.
sums:
	@cd release && shasum -a 256 -- *-$(VERSION)-*.dmg *-$(VERSION)-*.zip \
	  *-$(VERSION)-*.AppImage 2>/dev/null || true

bump:
	@echo "Current version: $(VERSION)"
ifdef part
	@node scripts/bump.mjs --part $(part)
else ifdef version
	@node scripts/bump.mjs --version $(version)
else
	@echo "Provide part=major|minor|patch or version=x.y.z"
	@exit 1
endif

# Commits the three files bump touched and tags them. Pushing is deliberately
# not here: the tag is what starts the release workflow, and that is a decision
# rather than a build step.
#
# runtime/pyproject.toml is one of the three, and leaving it out is not
# cosmetic: its version is the stamp the application compares against to decide
# that the app and core_cad groups are out of date. A tag without it ships an
# environment that never notices a new release.
release:
	@git diff --quiet package.json neutralino.config.json runtime/pyproject.toml || \
	  git commit -m "Version $(VERSION)" package.json neutralino.config.json runtime/pyproject.toml
	git tag -a v$(VERSION) -m "Version $(VERSION)"
	@echo
	@echo "Tagged v$(VERSION). To release it:"
	@echo "    git push origin main && git push origin v$(VERSION)"
