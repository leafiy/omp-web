# Showcase site

`site/` is a static page published to <https://leafiy.github.io/omp-web/> by
`.github/workflows/pages.yml` whenever `site/**` changes on `main`. It has no
build step: edit `site/index.html`, `site/assets/site.css` and
`site/assets/site.js` directly. Text is bilingual: every visible string exists
as a `lang="en"` and a `lang="zh-CN"` element, and `<html data-lang>` hides one.

## Regenerating screenshots

Screenshots must never show real sessions, so they come from a separate,
temporary omp-web instance whose `HOME` contains only demo data. Running it is a
runtime operation; get explicit approval first (see `AGENTS.md`).

```bash
# 1. Demo HOME: three git projects, sessions for all four engines, a neutral PS1.
node scripts/site/demo-data.mjs /home/demo
printf '<demo-password>\n' | env -i HOME=/home/demo PATH="$PATH" OMP_WEB_USERNAME=demo node bin/omp-web.js passwd

# 2. Serve the existing build on loopback with an isolated, key-free environment.
#    (Bypasses the launcher only because its workspace check is HOME-relative.)
env -i HOME=/home/demo PATH="$PATH" SHELL=/bin/bash LANG=C.UTF-8 TERM=xterm-256color \
  NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 PI_WEB_HOSTNAME=127.0.0.1 \
  OMP_WEB_APP_DIR="$PWD" node node_modules/next/dist/bin/next start -p 30199 -H 127.0.0.1

# 3. Capture with any playwright-core + Chromium, then convert to WebP.
PLAYWRIGHT_CORE=/path/to/playwright-core CHROME=/path/to/chrome \
  DEMO_PASSWORD='<demo-password>' OUT=/tmp/shots node scripts/site/screenshots.mjs
for f in /tmp/shots/*.png; do magick "$f" -quality 86 "site/assets/shots/$(basename "${f%.png}").webp"; done

# 4. Stop the server and delete /home/demo.
```

Only Claude Code and Codex sessions are opened by the capture script: the demo
HOME has no OMP/Pi model login, so opening those sessions would show a startup
error banner. Never send a prompt from the demo instance.
