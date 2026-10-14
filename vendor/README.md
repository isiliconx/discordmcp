# Discord API specification

`discord-openapi.json` is a copy of `specs/openapi.json` from
[discord/discord-api-spec](https://github.com/discord/discord-api-spec), commit
`ed014089afa986f2b532ae081c456a85de074d0c` (retrieved 2026-10-14).
The upstream MIT license is preserved in `DISCORD-API-SPEC-LICENSE`.

Discord labels its OpenAPI specification a public preview. The specification can
change or differ from the documentation. This project pins a snapshot for
reproducible catalog generation; it does not fetch new tool definitions at runtime.

To update, review a newer upstream snapshot, replace `discord-openapi.json`, update
the provenance above, run `npm run catalog:generate`, and run `npm run check`.
Changes to generated tools and schemas must be reviewed before publishing.
