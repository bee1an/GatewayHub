SHELL := /bin/zsh

APP_NAME := GatewayHub
BINARY := gatewayhub
VERSION := $(shell sed -n 's/^version = "\([^\"]*\)"/\1/p' Cargo.toml | head -1)

ICON_SOURCE := assets/gatewayhub-logo-octopus-line.svg
ICONSET := target/$(BINARY).iconset
ICON_PNG := build/icon.png
ICON_ICNS := build/icon.icns
APP_BUNDLE := target/release/bundle/osx/$(APP_NAME).app
DMG_STAGE := target/dmg/stage
DMG_OUTPUT := target/release/$(APP_NAME)-$(VERSION).dmg

.PHONY: all check lint fmt fmt-check test dev debug release icon bundle run-bundle dmg \
        deny udeps msrv bloat clean version version-patch version-minor version-major

all: check

# Fast compiler gate used by editors and CI.
check:
	cargo check --workspace --all-targets

# Full source hygiene gate. `typos` is optional locally but expected in CI.
lint:
	typos
	cargo fmt --all -- --check
	cargo clippy --workspace --all-targets --all-features -- -D warnings

fmt:
	cargo fmt --all

fmt-check:
	cargo fmt --all -- --check

test:
	cargo test --workspace

dev:
	cargo run --bin $(BINARY)

debug:
	RUST_LOG=DEBUG $(MAKE) dev

release:
	cargo build --release

# Render the selected SVG at every macOS icon size and assemble the ICNS file.
# This is intentionally macOS-only, matching the GPUI application's support
# matrix and keeping alpha edges intact instead of relying on a checkerboard
# thumbnailer.
icon:
	@mkdir -p build $(ICONSET)
	swift scripts/render-icon.swift $(ICON_SOURCE) $(ICONSET) $(ICON_ICNS)
	cp $(ICONSET)/icon_512x512.png $(ICON_PNG)

bundle: icon
	cargo bundle --release --format osx

run-bundle: bundle
	open $(APP_BUNDLE)

dmg: bundle
	./scripts/make-dmg.sh $(DMG_OUTPUT) $(APP_BUNDLE) $(ICON_ICNS) $(DMG_STAGE)

# Dependency gate (advisories / licenses / bans / sources). Install once with:
#   cargo install cargo-deny --locked
deny:
	cargo deny check advisories bans licenses sources

udeps:
	cargo +nightly udeps --workspace

msrv:
	cargo msrv list

bloat:
	cargo bloat --release --crates --bin $(BINARY)

clean:
	cargo clean
	rm -rf $(ICONSET) target/dmg

version:
	git cliff --unreleased --tag v$(VERSION) --prepend CHANGELOG.md

version-patch:
	./scripts/bump-version.sh patch
	$(MAKE) version

version-minor:
	./scripts/bump-version.sh minor
	$(MAKE) version

version-major:
	./scripts/bump-version.sh major
	$(MAKE) version
