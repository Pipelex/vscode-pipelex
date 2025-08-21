# Documentation System

This repository uses a documentation composition system to keep Pipelex-specific content while staying in sync with upstream Taplo documentation.

## How it works

- **Header files** in `docs/pipelex/` contain Pipelex-specific content
- **Upstream files** are pulled from the `upstream` branch into `docs/upstream/`
- **Final docs** are composed by prepending headers to upstream content

## Files structure

```
docs/
├── pipelex/                    # Pipelex-specific headers (EDIT THESE)
│   ├── README.header.md        # Header for root README.md
│   ├── CONTRIBUTING.header.md  # Header for CONTRIBUTING.md
│   └── VSCODE_README.header.md # Header for editors/vscode/README.md
└── upstream/                   # Upstream content (AUTO-GENERATED)
    ├── README.UPSTREAM.md
    ├── CONTRIBUTING.UPSTREAM.md
    └── VSCODE_README.UPSTREAM.md
```

## Usage

### Update documentation
```bash
./scripts/compose-docs.sh
```

### Edit Pipelex-specific content
1. Edit files in `docs/pipelex/`
2. Run `./scripts/compose-docs.sh`
3. Review and commit changes

### SourceTree Custom Action (Optional)
Add a custom action in SourceTree:
- **Menu Caption**: Update Docs
- **Script to run**: `$REPO/scripts/compose-docs.sh`
- **Parameters**: (leave empty)

## Generated files
- `README.md` - Root repository README
- `CONTRIBUTING.md` - Contributing guidelines  
- `editors/vscode/README.md` - VS Code extension README

⚠️ **Important**: Never edit the generated files directly! Always edit the header files in `docs/pipelex/` and run the compose script.
