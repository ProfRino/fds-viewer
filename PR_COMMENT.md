Hi all, thanks a lot for the detailed review! I've addressed every point, each as its own commit:

- **Tick loop (point 1):** Axis ticks are now computed from an integer index, so the loop can no longer hang on tiny spans. A test with a timeout catches any regression.
- **Conflicts with `main` (point 2):** The branch is built on the current `upstream/main`. Vismap mode is fully preserved, the `?v=` cache tags are bumped past upstream's, and the mode row uses 5 columns.
- **Semicolon CSVs (point 3):** The separator is detected from the header line. Files that fail to parse show an error message.
- **3D view after Charts (point 4):** Leaving Charts re-fits the 3D view, and resizing at zero size is skipped.
- **Downsampling (point 5):** Each bucket keeps its min and max, so short peaks stay visible.
- **Hover (point 6):** Time extents are cached, the lookup uses binary search, and mousemove is throttled with `requestAnimationFrame`.
- **Drop outside Output (point 7):** A dropped CSV switches to Output → Charts.
- **Help text (point 8):** The description now matches the current UI.
- **Cleanup (point 9):** Linter, `.out` loader, CHANGELOG, `.gitignore` and whitespace changes are gone. This PR contains only the Charts feature.
- **Minor points:** Escaping of channel keys and filenames, state handling on re-parse, files without a Time column, same-name files, SVG URL revoke, and theme tokens instead of hard-coded colours.

The Node tests in `tests/` all pass. I haven't checked the browser yet, especially Vismap, mode switching, drag-and-drop, export and the light/dark theme, so feedback there would be very welcome!

Branch: `review-test` (https://github.com/dihydrogenmonoxid-ama/fds-viewer/tree/review-test)
