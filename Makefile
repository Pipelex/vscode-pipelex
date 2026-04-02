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
.PHONY: build cli pipelex-tools env lock ext ext-deps ext-install ext-uninstall vsix clean test check check-no-local-deps fmt-check fmt lint plxt-lint docs setup-hooks
.PHONY: use-github use-local ug ul pin-mthds-ui

help: ## Show this help
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | \
		awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-20s\033[0m %s\n", $$1, $$2}'

# ── Build ────────────────────────────────────────────────────────────────────

build: cli pipelex-tools ext ## Build everything (CLI + Python package + VS Code extension)

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

pipelex-tools: env ## Build and install the pipelex-tools Python package (dev)
	@. "$(VIRTUAL_ENV)/bin/activate" && maturin develop --release

lock: ## Update Cargo.lock after version bumps
	cargo update --workspace

ext-deps: ## Build the @pipelex/lsp WASM bundle (prerequisite for ext)
	cd $(JS_LSP_DIR) && yarn install && yarn build

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

plxt-lint: ## Lint TOML/MTHDS files with plxt
	cargo run --bin plxt -- lint

test: ## Run all tests (Rust + VS Code extension)
	cargo test -p pipelex-common
	cargo test -p pipelex-cli
	cargo test -p taplo
	cargo test -p taplo-lsp
	cd $(EXT_DIR) && yarn test

check-no-local-deps: ## Fail if a local mthds-ui link would be committed
	@! grep -qE 'mthds-ui.*(portal:|file:)' $(EXT_DIR)/package.json || \
		{ echo "ERROR: Local mthds-ui link in $(EXT_DIR)/package.json. Run 'make use-github' first."; exit 1; }

setup-hooks: ## Configure git to use .githooks/ for hooks
	@git config core.hooksPath .githooks

check: check-no-local-deps fmt-check lint test ## Full quality gate (format + lint + test + compilation)
	cargo check -p pipelex-cli --locked
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
# use-local: portal link to sibling ../mthds-ui for live development
# use-github: install from GitHub to test the published version

use-github: ## Switch back to pinned GitHub mthds-ui
	cd $(EXT_DIR) && git checkout -- package.json yarn.lock && yarn install --immutable
	@echo "Restored pinned GitHub mthds-ui. Run 'make use-local' to switch back."

use-local: setup-hooks ## Switch to local mthds-ui (portal link)
	cd $(EXT_DIR) && yarn add @pipelex/mthds-ui@portal:../../../mthds-ui
	@echo "Switched to local mthds-ui (portal link). Run 'make use-github' to switch back."

pin-mthds-ui: ## Pin mthds-ui to a tag (default: latest). Usage: make pin-mthds-ui [TAG=v0.3.0]
	@if [ -n "$${TAG:-}" ]; then \
		SHA=$$(gh api repos/Pipelex/mthds-ui/tags --jq ".[] | select(.name == \"$$TAG\") | .commit.sha") && \
		if [ -z "$$SHA" ]; then echo "ERROR: Tag $$TAG not found in Pipelex/mthds-ui"; exit 1; fi; \
	else \
		PAIR=$$(gh api repos/Pipelex/mthds-ui/tags --jq '.[0] | "\(.name) \(.commit.sha)"') && \
		TAG=$$(echo "$$PAIR" | cut -d' ' -f1) && SHA=$$(echo "$$PAIR" | cut -d' ' -f2) && \
		if [ -z "$$TAG" ]; then echo "ERROR: No tags found in Pipelex/mthds-ui"; exit 1; fi; \
	fi && \
	echo "Pinning @pipelex/mthds-ui to $$TAG ($$SHA)" && \
	cd $(EXT_DIR) && yarn add "@pipelex/mthds-ui@github:Pipelex/mthds-ui#$$SHA" && \
	echo "Done. Review the diff, then commit package.json + yarn.lock."

ug: use-github
ul: use-local
pmu: pin-mthds-ui

$(GRAMMAR_DST): $(GRAMMAR_SRC)
	@mkdir -p $(WEBSITE_SHIKI_DIR)
	cp $(GRAMMAR_SRC) $(GRAMMAR_DST)
	@echo "Synced $< -> $@"
