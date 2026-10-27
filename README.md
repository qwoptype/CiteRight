# CiteRight APA 7

CiteRight is a small, self-hosted APA 7 citation generator. It includes a browser interface and a Node.js backend that extracts metadata from public webpages and public document links, reads uploaded documents, and looks up academic DOI records through Crossref.

## Features

- Scan public website URLs and common citation metadata (`citation_*`, Dublin Core, Open Graph, and JSON-LD).
- Scan direct PDF, DOCX, TXT, and RTF links.
- Upload PDF, DOCX, TXT, or RTF files (15 MB limit).
- Extract selectable PDF text and embedded document metadata; read DOCX/text files for a title clue and text preview.
- Look up DOI records and search Crossref bibliographic records.
- Edit author, date, title, publication, DOI, and URL fields before generating a citation.
- Generate web page, journal article, book, report/document, and online video reference formats plus parenthetical in-text citations.
- Save a bibliography in the current browser; copy individual citations; export a `.txt` list or formatted `.html` reference page.
- Serve the web app and API from the same origin by default, avoiding browser CORS problems in the normal deployment.

## Deploy the whole app on Render

This is the simplest setup because the frontend and backend are deployed as one web service.

1. Put this project folder in a GitHub repository. Keep `server.js`, `package.json`, `render.yaml`, and the `public` folder at the repository root.
2. In Render, choose **New → Web Service** and connect that repository. You can use the included `render.yaml` Blueprint or enter the commands manually.
3. Use **Build Command** `npm install` and **Start Command** `npm start`. Use Node 22 or newer (the project requests Node 22.12.0 in `render.yaml`).
4. Deploy. Open the generated `https://...onrender.com` address. The homepage and `/health` endpoint should load from the same address.
5. In the app's **Settings**, the backend URL should normally match the site URL. If it does not, choose **Use this website** and test the connection.

Render's service configuration reference: https://render.com/docs/web-services and https://render.com/docs/deploy-node-express-app.

## If the frontend is hosted separately

The app can be hosted on a static site, but the API still needs to run on a Node host such as Render.

1. Deploy the backend as a Render web service.
2. Publish the contents of `public/` on your static host.
3. On the backend's environment settings, set `FRONTEND_ORIGINS` to the exact frontend origin, for example `https://yourname.github.io`. Do not include a page path, trailing slash, or `/api`. Multiple origins can be comma-separated.
4. In CiteRight **Settings**, enter the backend's base address, such as `https://your-citeright-api.onrender.com` (not `/api`), save, and test it.

CORS permissions must be configured on the backend. Opening `public/index.html` as a local file is not a supported complete setup because it has no running backend. Use the combined deployment above or publish the frontend over HTTPS.

## Endpoints

- `GET /health` — health check.
- `POST /api/inspect` with `{ "url": "https://..." }` — inspect a webpage or hosted document.
- `POST /api/upload` as `multipart/form-data` with a `file` field — extract uploaded document details.
- `GET /api/doi?doi=10...` — DOI lookup through Crossref.
- `GET /api/search?q=...` — Crossref bibliographic search.

## Important limitations

- A backend proxy avoids **browser-side CORS restrictions**, but it cannot guarantee that every website can be scanned. Sites can require sign-in, block automated requests, use anti-bot challenges, or expose little/no metadata. CiteRight does not bypass authentication or paywalls.
- Scanned/image-only PDFs usually need OCR, which is not included here. The app warns when little or no selectable text is extracted.
- Citation extraction is a starting point. Confirm author names, publication dates, title capitalization, volume/issue/pages, DOI, and publisher against the original source and your instructor's APA 7 guidelines.
- APA has exceptions for many source-specific cases. The generator covers common web pages, journal articles, books, reports/documents, and videos; it is not a substitute for reviewing the APA manual or your assignment requirements.
- Browser bibliography data is stored in that browser's `localStorage`. It is not synced across devices and may be erased if local browser data is cleared.
- Uploaded files are processed in server memory and are not saved to disk by this application. A hosting provider may still have request/operational logs; avoid uploading sensitive documents.

## Security notes

- The URL fetcher only supports HTTP/HTTPS, checks hostname resolution for private/reserved IP addresses, pins the approved DNS addresses for the connection, re-checks redirects, limits downloads to 15 MB, and uses timeouts and rate limiting.
- CORS is not authentication. If the API is exposed publicly, retain the URL validation and rate limits, monitor usage, and add stronger abuse controls before using it at large scale.
