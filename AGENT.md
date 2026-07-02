# Agent guide

## Project

Zola static site with four sections: home, weather, MTA subway arrivals, markdown viewer.

Nav: **Home · Weather · MTA · Markdown**

## Commands

```bash
zola serve   # dev, port 1111
zola build   # → public/
```

Do not add npm/Bun build steps. Do not edit `public/` directly.

## File map

| What | Where |
|------|-------|
| Config | `config.toml` |
| Styles + layout | `static/site.css`, `templates/base.html` |
| Home | `content/_index.md`, `templates/home.html` |
| Weather | `content/weather/`, `templates/weather.html`, `static/weather.js` |
| MTA | `content/mta/`, `templates/mta.html`, `static/trains.js` |
| Markdown | `content/markdown/`, `templates/markdown.html`, `static/markdown.js`, `static/intro.md` |

## Conventions

- Section index pages use the `section` Tera variable (not `page`).
- Asset links: `{{ get_url(path='...') | safe }}`
- All CSS in `static/site.css` — no per-section stylesheets.
- `body` grid shell + `<main class="page">` on every section.

## After changes

```bash
zola build
```

Check `public/` has: `index.html`, `weather/`, `mta/`, `markdown/`, `trains.js`, `intro.md`.