# PRC Print Engine

> Canonical docs: [docs/plugins/prc-print-engine/](../../docs/plugins/prc-print-engine/)

Standalone WordPress plugin that serves a print-styled document for posts and generates server-side PDFs via a Firebase headless Chromium Cloud Function.

## Features

- `/print` URL endpoint for logged-in users (path interception; legacy `?pdf=true` redirects to `/print`)
- Cover sheet, About page, static TOC, and article/report body
- Paged.js client pagination for print preview
- Server-side PDF generation on `prc_platform_async_on_publish` / `prc_platform_async_on_update` (Action Scheduler → Firebase `generatePdf` → WP media attachment)
- Editor **Print Engine** sidebar for ad-hoc PDF regeneration
- REST: `POST /prc-print-engine/v1/posts/{id}/generate-pdf`, `GET …/pdf`, `POST /prc-print-engine/v1/screenshot`
- Block callback registry (`prc_print_engine_register_block_callbacks`) for print markup and styles
- Editor Block Visibility controls for hide-on-print / display-on-print
- Chart-builder integration emits static PNG figures when available

## Soft dependencies

Guarded at call sites — plugin boots without them:

- `prc-firebase` — OIDC token minting for Cloud Function calls
- `prc-report-package` — multi-chapter report assembly
- `prc-staff-bylines` — cover bylines
- `prc-schema-seo` — cover media contact resolver
- `prc-chart-builder` — chart print callbacks
- Action Scheduler — async PDF jobs (via post-publish-pipeline)

## Requires

- `prc-scripts`

## Firebase render functions

Deploy from `firebase/`:

```bash
./bin/deploy-render-functions.sh staging /path/to/firebase-service-account-staging.json
./bin/deploy-render-functions.sh production /path/to/firebase-service-account-prod.json
```

WordPress resolves URLs via `client-mu-plugins/firebase-render.php` (`prc_platform_firebase_render_endpoints`).

Stored PDF meta on the post:

- `_print_engine_pdf_attachment_id`
- `_print_engine_pdf_url`
- `_print_engine_content_hash`
- `_print_engine_pdf_generated_at`

## Development

```bash
npx turbo build --filter=@prc/print-engine
php plugins/prc-print-engine/tests/test-block-print-registry.php
php plugins/prc-print-engine/tests/test-visibility-helpers.php
```

Playwright (VIP dev-env required):

```bash
npx playwright test tests/prc-print-engine/
```

## Registry

```php
add_action( 'prc_print_engine_register_block_callbacks', function () {
	\PRC\Platform\Print_Engine\Block_Print_Registry::register(
		'my-plugin/my-block',
		function ( string $content, array $block, \WP_Post $post ): string {
			return $content;
		}
	);
} );
```

## Access model

Staff-beta: browser `/print` and print discovery / report-materials links require a logged-in WordPress user. Anonymous requests fall through (no login redirect). Server-side PDF generation continues without a WP session by minting a short-lived, post-bound machine-fetch ticket on the `/print` URL Firebase fetches.

Content eligibility is unchanged and separate from audience access: published posts/pages with `prc-print-engine` support may be printable; password-protected posts require a valid password cookie (or `read_post`); drafts require capability or a valid preview nonce. Automatic PDF generation still runs only for publicly published, non-password-protected posts.
