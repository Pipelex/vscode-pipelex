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

EXT_DIR           := editors/vscode
JS_LSP_DIR        := js/lsp
VSIX              := $(EXT_DIR)/pipelex.vsix
VIRTUAL_ENV       := $(CURDIR)/.venv
PYTHON_VERSION    ?= 3.13

# ── Targets ──────────────────────────────────────────────────────────────────

.PHONY: help sync-grammar s update-schema up
.PHONY: build cli pipelex-tools env lock ext ext-deps ext-install ext-uninstall vsix clean test check fmt-check fmt lint plxt-lint docs

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
	cargo test -p taplo
	cargo test -p taplo-lsp
	cd $(EXT_DIR) && yarn test

check: fmt-check lint test ## Full quality gate (format + lint + test + compilation)
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

$(GRAMMAR_DST): $(GRAMMAR_SRC)
	@mkdir -p $(WEBSITE_SHIKI_DIR)
	cp $(GRAMMAR_SRC) $(GRAMMAR_DST)
	@echo "Synced $< -> $@"
