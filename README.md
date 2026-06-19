# VOID Fest Interactive Map

Clean project scaffold for the next iteration of the VOID Fest booking map.

## Core Files

- `index.html`: copied app shell from the prior Jupiter map project, retargeted to the new assets
- `voidfest-map.svg`: Illustrator-exported SVG with the new geometry and preserved shape IDs
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
