# VOID Fest Interactive Map v2

Interactive map and assets for VOID Fest.

Live demo
 - https://mrsannaclarke.github.io/book_void_2027/

Quick local preview
- Open `index.html` in your browser, or run a simple server:

```bash
python3 -m http.server 8000
# then open http://localhost:8000
```

Deployment
- This repository is published with GitHub Pages (site is public).
- To update the live site, commit and push changes to the `main` branch.

Repository layout
- `index.html` — entry point for the interactive map
- `voidfest-map.*` — assets and images
- `email_parser_script.gs` — Google Apps Script for email parsing

Contributing
- Open an issue or submit a pull request. Keep commits small and descriptive.

Contact
- GitHub: https://github.com/mrsannaclarke

License
- Add a license file if you want this project to be reused.
# VOID Fest Interactive Map

Clean project scaffold for the next iteration of the VOID Fest booking map.

## Core Files

- `index.html`: copied app shell from the prior Jupiter map project, retargeted to the new assets
- `voidfest-map.svg`: browser-stable SVG map with the desired colors baked in
- `voidfest-map.png`: raster base image rendered from the current `.ai` file for visual alignment
- `voidfest-map-data.json`: generated data file in the old `jupitervoid.json` style
- `void-space-inventory.csv`: working inventory scaffold for room/booth/vendor assignments
- `void-space-review.json`: small mismatch/review summary

## Current State

- The framework is preserved from the older project.
- Geometry is regenerated from the new SVG.
- `bookwhen_url` is allowed to be blank.
- Occupancy feed is disabled for now by setting `FEED_URL` to an empty string.
- The only remaining review key is `ij`, which is a combined vendor spot.

## Notes

- Numeric room IDs remain `_202`-style in the raw SVG but are normalized in the JSON and inventory to `202`.
- `A1`-style and `AA`-style IDs are normalized to lowercase keys like `a1` and `aa` in the data file.
- Street fair spaces are intentionally out of scope for this map project.
