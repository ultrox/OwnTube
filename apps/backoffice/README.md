# OwnTube backoffice

- `desk/`: live editorial History/Searches at `/`, with scope totals, complete
  pagination and exact-version evidence. See [desk behavior and checks](desk/README.md).
- `history/`: the existing Elm dashboard at `/legacy/`, including device management.
- `design-preview/`: the independently designed OwnTube curation prototype,
  with local example data. It is not part of the production build.
- `dist/`: generated production assets, served by the Rust service.
- `modules/languages/`: independent live-data language review page, served at
  `/modules/languages/`. It uses the owner session and its own APIs and filters.

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm preview:design
```

History assets use content-addressed URLs as before. The server owns login and API
access; its default local static directory points here. The design preview is
served independently at <http://127.0.0.1:4187>.

Feed control will be implemented against a versioned server API; its approved
prototype remains separate from live History. Shared authentication does not require sharing the old
dashboard's styling or page structure.

Language corrections are real server-side annotations, separate from collector
evidence and global history. Optional API configuration and semantics are in
[`docs/languages-module.md`](../../docs/languages-module.md).
