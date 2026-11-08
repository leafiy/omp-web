# Contributing to omp-web

Thank you for considering contributing to `omp-web`!

## Getting Started

1. Use the single checkout at `~/code/omp-web` for development, commits, builds and runtime. Keep dependencies and build artifacts there; follow the [workspace procedure](./docs/workspace.zh-CN.md) when deploying.
2. Ensure Node.js >= 22.19.0 is installed.
3. Install dependencies:
   ```bash
   npm install
   ```
4. Start the local development server:
   ```bash
   npm run dev
   ```

## Development Guidelines

- **TypeScript & Linting**: Always verify your code passes type checks and linter rules before submitting a PR:
  ```bash
  npx tsc --noEmit
  npm run lint
  ```
- **Service Caution**: Stop production and development servers before building `.next` in this workspace. Use `npm run build`; its preflight checks the canonical location and managed service state.
- **Code Style**: Follow existing project conventions. Keep components clean, modular, and performance-conscious.

## Submitting a Pull Request

1. Create a descriptive branch name (`git checkout -b feat/my-feature` or `git checkout -b fix/my-bug`).
2. Commit your changes with clear, concise commit messages.
3. Push to your fork and open a Pull Request against `main`.
