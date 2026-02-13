.DEFAULT_GOAL := help
SHELL := /bin/bash
.SHELLFLAGS := -eu -o pipefail -c

# ── Paths ────────────────────────────────────────────────────────────────────

GRAMMAR_SRC       := editors/vscode/mthds.tmLanguage.json
WEBSITE_DIR       := ../pipelex-website-2
WEBSITE_SHIKI_DIR := $(WEBSITE_DIR)/src/lib/shiki
GRAMMAR_DST       := $(WEBSITE_SHIKI_DIR)/mthds.tmLanguage.json

# ── Targets ──────────────────────────────────────────────────────────────────

.PHONY: help sync-grammar s

help: ## Show this help
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | \
		awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-20s\033[0m %s\n", $$1, $$2}'

sync-grammar: $(GRAMMAR_DST) ## Copy the MTHDS TextMate grammar to the website
s: sync-grammar

$(GRAMMAR_DST): $(GRAMMAR_SRC)
	@mkdir -p $(WEBSITE_SHIKI_DIR)
	cp $(GRAMMAR_SRC) $(GRAMMAR_DST)
	@echo "Synced $< -> $@"
