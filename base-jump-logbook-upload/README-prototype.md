# BASE Jump Logbook MVP — prototype

A mobile-first, dark-mode, local-first prototype based on the agreed logbook specification.

## Run it

Open `index.html` in a modern browser. For best results, serve this directory over localhost/HTTPS because geolocation and browser speech recognition may require a secure context.

For example, with Python installed:

```bash
python3 -m http.server 8000
```

Then open `http://localhost:8000`.

## Included in this prototype

- Jump logbook with create/edit/delete, sequential jump numbering, search and filters
- Agreed jump fields and object type validation (B/A/S/E/Other; Other requires a description)
- Coordinates via manual entry and current GPS location
- Saved objects and reusable gear presets
- Configurable dropdown values
- Photo/video attachment previews (small local files only)
- Private notes with browser speech-to-text where supported
- Settings for height/wind units and time-zone preference
- JSON backup/restore and CSV export
- Responsive dark UI

## Prototype limitations — important

- Data is stored in browser `localStorage` on this device. It is not a secure multi-user database and does not synchronize between devices.
- Full AI extraction from speech into every individual field is **not implemented**. The microphone currently transcribes into Private Notes; automatic field mapping requires an AI backend and a configured speech/LLM service. The UI explicitly tells the user this.
- Map tile selection, FlySight track parsing/visualization, server-side authentication, encryption at rest, and production-grade offline sync are not implemented.
- Large photo/video files are skipped above 3 MB to avoid exhausting browser storage. Production needs object storage.
- The current location field uses browser geolocation; map selection is not yet implemented.

This is an early functional prototype, not production-ready software. Do not store sensitive or irreplaceable records without exporting backups.
