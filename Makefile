.DEFAULT_GOAL := help
SHELL := /bin/bash
.SHELLFLAGS := -eu -o pipefail -c

# ── Paths ────────────────────────────────────────────────────────────────────

GRAMMAR_SRC       := editors/vscode/mthds.tmLanguage.json
WEBSITE_DIR       := ../pipelex-website-2
WEBSITE_SHIKI_DIR := $(WEBSITE_DIR)/src/lib/shiki
GRAMMAR_DST       := $(WEBSITE_SHIKI_DIR)/mthds.tmLanguage.json

MTHDS_SCHEMA_URL  := https://mthds.ai/mthds_schema.json
MTHDS_SCHEMA_FILE := crates/taplo-common/schemas/mthds_schema.json

# note that editors/vscode has its own package.json, yarn.lock, node_modules
EXT_DIR           := editors/vscode

JS_LSP_DIR        := js/lsp
VSIX              := $(EXT_DIR)/pipelex.vsix
VIRTUAL_ENV       := $(CURDIR)/.venv
PYTHON_VERSION    ?= 3.13

# ── Targets ──────────────────────────────────────────────────────────────────

.PHONY: help sync-grammar s update-schema up
.PHONY: build cli pipelex-tools pipelex-lib pipelex-lib-smoke env lock ext ext-deps lsp-types ext-install ext-uninstall vsix clean test check check-no-local-deps fmt-check fmt lint plxt-lint docs setup-hooks
.PHONY: use-local use-npm ul un

help: ## Show this help
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | \
		awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-20s\033[0m %s\n", $$1, $$2}'

# ── Build ────────────────────────────────────────────────────────────────────

build: cli pipelex-tools pipelex-lib ext ## Build everything (CLI + Python CLI/library wheels + VS Code extension)

cli: ## Build the plxt CLI (release mode)
	cargo build -p pipelex-cli --release
	@echo "Binary: target/release/plxt"

env: ## Create Python virtual env (if missing)
	@command -v uv >/dev/null 2>&1 || { \
		echo "uv not found – installing latest …"; \
		curl -LsSf https://astral.sh/uv/install.sh | sh; \
	} && \
	export PATH="$$HOME/.local/bin:$$PATH" && \
	if [ ! -d "$(VIRTUAL_ENV)" ]; then \
		echo "Creating Python virtual env in \`$(VIRTUAL_ENV)\`"; \
		uv venv "$(VIRTUAL_ENV)" --python $(PYTHON_VERSION); \
	fi

pipelex-tools: env ## Build and install the pipelex-tools CLI wheel (native plxt binary, dev)
	@. "$(VIRTUAL_ENV)/bin/activate" && maturin develop --release

pipelex-lib: env ## Build and install the pipelex-tools-lib Python library (import pipelex_tools, dev)
	@. "$(VIRTUAL_ENV)/bin/activate" && cd crates/pipelex-py && maturin develop --release

pipelex-lib-smoke: pipelex-lib ## Build the library wheel (dev) and run the Python import smoke test
	@. "$(VIRTUAL_ENV)/bin/activate" && cd crates/pipelex-py && python -m unittest discover -s tests -p 'test_*.py'

lock: ## Update Cargo.lock after version bumps
	cargo update --workspace

ext-deps: ## Build the @pipelex/lsp WASM bundle (prerequisite for ext)
	cd $(JS_LSP_DIR) && yarn install && yarn build

lsp-types: ## Emit @pipelex/lsp type declarations only (fast, no WASM) for the typecheck gate
	cd $(JS_LSP_DIR) && yarn install && yarn build:types

ext: ext-deps ## Build the VS Code extension
	cd $(EXT_DIR) && yarn install && yarn build

vsix: ext ## Package the extension into a .vsix file
	cd $(EXT_DIR) && vsce package -o pipelex.vsix --no-dependencies
	@echo "VSIX: $(VSIX)"

# ── Install / Uninstall ─────────────────────────────────────────────────────

ext-install: vsix ## Install the .vsix into your VS Code-based IDE
	@if command -v cursor >/dev/null 2>&1; then \
		echo "Installing into Cursor…"; \
		cursor --install-extension $(VSIX); \
	elif command -v code >/dev/null 2>&1; then \
		echo "Installing into VS Code…"; \
		code --install-extension $(VSIX); \
	else \
		echo "ERROR: No VS Code-compatible CLI found (tried: cursor, code)."; \
		echo "Install manually: open your IDE → Extensions → ⋯ → Install from VSIX → $(VSIX)"; \
		exit 1; \
	fi

ext-uninstall: ## Uninstall the extension from your VS Code-based IDE
	@if command -v cursor >/dev/null 2>&1; then \
		cursor --uninstall-extension Pipelex.pipelex 2>/dev/null || true; \
	elif command -v code >/dev/null 2>&1; then \
		code --uninstall-extension Pipelex.pipelex 2>/dev/null || true; \
	fi
	@echo "Done. Restart your IDE to complete removal."

# ── Test / Check ─────────────────────────────────────────────────────────────

fmt: ## Format Rust source and TOML/MTHDS files
	cargo fmt
	cargo run --bin plxt -- fmt

fmt-check: ## Check Rust and TOML/MTHDS formatting
	cargo fmt --check
	cargo run --bin plxt -- fmt --check --diff

lint: ## Run Clippy on the workspace
	cargo clippy --workspace --all-targets -- -D warnings
	# The PyO3 glue in pipelex-py is `#[cfg(feature = "python")]`-gated, so the
	# workspace clippy above (feature off) never sees it. Lint it feature-on too.
	cargo clippy -p pipelex-py --features python --all-targets -- -D warnings

plxt-lint: ## Lint TOML/MTHDS files with plxt
	cargo run --bin plxt -- lint

test: lsp-types ## Run all tests (Rust + VS Code extension)
	cargo test -p pipelex-common
	cargo test -p pipelex-cli
	cargo test -p pipelex-py
	cargo test -p taplo
	cargo test -p taplo-lsp
	cd $(EXT_DIR) && { yarn typecheck; tc=$$?; yarn test; vt=$$?; [ $$tc -eq 0 ] && [ $$vt -eq 0 ]; }

check-no-local-deps: ## Fail if mthds-ui is not the npm spec
	@grep -qE '"@pipelex/mthds-ui":[[:space:]]*"npm:' $(EXT_DIR)/package.json || \
		{ echo "ERROR: @pipelex/mthds-ui in $(EXT_DIR)/package.json is not the npm spec. Run 'make use-npm' first."; exit 1; }

setup-hooks: ## Configure git to use .githooks/ for hooks
	@git config core.hooksPath .githooks

check: check-no-local-deps fmt-check lint test ## Full quality gate (format + lint + test + compilation)
	cargo check -p pipelex-cli --locked
	cargo check -p pipelex-py --locked
	# Compile the PyO3 bindings too — `src/python.rs` is feature-gated and is
	# otherwise only ever built at `maturin develop` time, outside the gate.
	cargo check -p pipelex-py --features python --locked
	cargo check -p pipelex-wasm --target wasm32-unknown-unknown --locked

# ── Misc ─────────────────────────────────────────────────────────────────────

docs: ## Compose README/CONTRIBUTING from headers + upstream
	./scripts/compose-docs.sh

sync-grammar: $(GRAMMAR_DST) ## Copy the MTHDS TextMate grammar to the website
s: sync-grammar

clean: ## Remove build artifacts
	cargo clean
	rm -rf $(JS_LSP_DIR)/dist
	rm -rf $(EXT_DIR)/dist $(VSIX)

update-schema: ## Download the latest MTHDS JSON Schema
	@mkdir -p $(dir $(MTHDS_SCHEMA_FILE))
	curl -fsSL $(MTHDS_SCHEMA_URL) -o $(MTHDS_SCHEMA_FILE)
	@echo "Downloaded MTHDS schema -> $(MTHDS_SCHEMA_FILE)"

up: update-schema

# --- Switch mthds-ui source ---
# use-local:  portal link to sibling ../mthds-ui for live development
# use-npm:    install from the npm registry (latest by default, or VERSION=x.y.z)

use-local: setup-hooks ## Switch to local mthds-ui (portal link)
	@if [ ! -d ../mthds-ui ]; then echo "ERROR: ../mthds-ui not found. Clone it next to vscode-pipelex."; exit 1; fi
	cd ../mthds-ui && yarn install && yarn build
	cd $(EXT_DIR) && yarn add @pipelex/mthds-ui@portal:../../../mthds-ui
	@echo "Switched to local mthds-ui (portal link). Run 'make use-npm' to switch back."

use-npm: ## Switch to @pipelex/mthds-ui from npm registry (default: latest). Usage: make use-npm [VERSION=0.5.0]
	@VERSION="$${VERSION:-latest}" && \
	echo "Installing @pipelex/mthds-ui@$$VERSION from npm" && \
	cd $(EXT_DIR) && yarn add "@pipelex/mthds-ui@npm:$$VERSION" && \
	echo "Switched to npm @pipelex/mthds-ui@$$VERSION. Review the diff, then commit package.json + yarn.lock."

ul: use-local
un: use-npm

$(GRAMMAR_DST): $(GRAMMAR_SRC)
	@mkdir -p $(WEBSITE_SHIKI_DIR)
	cp $(GRAMMAR_SRC) $(GRAMMAR_DST)
	@echo "Synced $< -> $@"
