# Platinum Companion

Free open-source Android trophy companion, built with Flutter, with a Node.js PSN library, SQLite, provenance-aware game journeys and optional MCP integration. Russian UI, offline snapshot import, paginated library, lazy artwork cache and separately confirmed progress updates.

## Availability

Freshoryx Cloud is currently a private single-owner deployment. It does **not** accept new users. Public source and APKs do not give access to its owner's library or credentials. Self-hosting is experimental; registration and owner isolation must remain enforced. No credentials or personal library are included in this repository or APK.

ChatGPT Plan Usage is an integration experiment, not a guaranteed entitlement. Device-local OAuth and inference must obtain actual granted permissions and completed Responses events before being reported as working. No ChatGPT tokens may be sent to the shared cloud. The Android platform is the target; individual devices require verification.

## Build Android

Install Flutter stable compatible with Dart >=3.13.5, Java 21 and Android SDK/build tools. Configure your SDK through Flutter; generated local.properties is not tracked.

```sh
cd apps/android
flutter pub get
flutter analyze
flutter test
flutter build apk --debug
```

The app starts empty. Use the system file picker to import a normalized snapshot matching `schemas/mobile-snapshot-v2.schema.json`; private data must be transferred separately with its owner's consent. Tests use synthetic accounts and progress, not a functioning public PSN account. Debug builds use your own signing key and cannot replace the maintainer's signed APK. Production update signing keys are deliberately excluded.

## Backend and tests

```sh
npm ci
npm test
```

Requires Node.js >=24 (SQLite API). Core modules are in `src/`. `test/fixtures.mjs` and `test/synthetic-recording.mjs` are synthetic test data. `deploy/keycloak-realm.example.json` illustrates PKCE and owner-only authorization; it is not production configuration. `scripts/serve-remote.mjs` reads a separately provided local configuration. Inspect its required fields before running; never expose an unauthenticated personal service. A full self-hosted installation guide is still pending.

## Boundaries

Sony alone confirms earned trophies. Imported snapshots retain their provenance and dates. Game events require player confirmation; inferred AI replies cannot overwrite confirmed facts. The trophy library is not the user's complete store purchase inventory. Limited Knowledge Packs disclose uncertainty instead of claiming complete platinum coverage.

MIT applies to our original code. See THIRD_PARTY_NOTICES.md for dependencies, Sony metadata/artwork and service restrictions. Not affiliated with Sony or OpenAI.
