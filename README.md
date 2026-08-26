# DMTG GSC Collector

Minimal Google Search Console read-only collector for `sc-domain:dalianmachine.com`.

This public repository contains only the generic collector, GitHub Actions workflows, executable security checks, and a source manifest. It does not contain quotation-workbench source code, customer or product data, production configuration, Search Console rows, or credentials.

The private Codeup repository remains the only source of truth. Public updates are exported from a clean commit that exactly matches the latest merged `codeup/main`, then reviewed through a GitHub pull request; business code must not be edited directly in this repository.

The scheduled workflow runs at `22:05 UTC` (`06:05 Asia/Shanghai`) and uploads a signed, bounded batch to the existing DMTG ingest endpoint. Manual validation is read-only and cannot access the ingest HMAC secret.

Required GitHub Environment secrets in `production-gsc`:

- `GOOGLE_CLIENT_ID`
- `GOOGLE_CLIENT_SECRET`
- `GOOGLE_REFRESH_TOKEN`
- `INGEST_HMAC_SECRET`

The OAuth consent configuration must be Workspace Internal or External/In production. The OAuth scope is fixed to `https://www.googleapis.com/auth/webmasters.readonly`.

After a successful scheduled collection, a separate secret-free job writes at most one operational evidence record per ISO week to `automation-evidence`. The record contains only completion time, GitHub SHA, Codeup source SHA, and status.

All rights reserved. No license is granted to copy, modify, distribute, sublicense, or use this code beyond rights provided by applicable law or the GitHub Terms of Service.
