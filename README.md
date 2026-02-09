# Eve

Self-hosted LLM interface supporting multiple providers (Claude, Gemini, LM Studio) with persistent sessions, project grouping, and minimal dependencies.

## Repository Structure

The repo is organized as a monorepo to house the core application and future integration modules:

- **[`web/`](./web/)** -- The main application. See its [README](./web/README.md) for installation, configuration, and usage.
- Additional modules (messaging bridges, API services, etc.) will live alongside `web/` as sibling directories.

## Quick Start

```bash
cd web
npm install
npm start
```

See [`web/README.md`](./web/README.md) for full documentation.

## License

[MIT License](./LICENSE)
