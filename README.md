# Guadarrama

A minimal personal site built with [Zola](https://www.getzola.org/).

## Sections

| Route | Description |
|-------|-------------|
| `/` | Home |
| `/weather/` | Hourly feels-like weather near you |
| `/mta/` | Real-time NYC subway arrivals |

## Quick start

```bash
bun scripts/build-stops.mjs
zola serve    # http://127.0.0.1:1111
zola build    # output → public/
```

Requires [Zola](https://www.getzola.org/documentation/getting-started/installation/) 0.22+.

## Layout

```
guadarrama/
├── config.toml
├── content/           # section front matter
├── templates/         # base + one template per section
├── static/
│   ├── site.css       # all styles
│   ├── weather.js
│   ├── trains.js
│   ├── markdown.js
│   └── intro.md       # default markdown sample
└── public/            # build output (gitignored)
```

## Deploy

For Cloudflare Pages, use this build command:

```bash
./scripts/build.sh
```

Serve `public/` with any static host. Set `base_url` in `config.toml` first.