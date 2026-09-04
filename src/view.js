/* eslint-disable max-len */
/* eslint-env browser */
/**
 * WordPress Dependencies
 */
import domReady from '@wordpress/dom-ready';

/**
 * External Dependencies
 */
import { Previewer } from 'pagedjs';

/**
 * Lets webpack process CSS, SASS or SCSS files referenced in JavaScript files.
 *
 * @see https://www.npmjs.com/package/@wordpress/scripts#using-css
 */
import './print.scss';

/**
 * Remove `@media print { ... }` blocks with brace-balanced matching.
 *
 * @param {string} css CSS text.
 * @return {string} CSS without print media blocks.
 */
function stripAtMediaPrintBlocks(css) {
	const source = String(css || '');
	let out = '';
	let i = 0;
	const re = /@media\s+print\b/gi;
	let match = re.exec(source);
	while (match) {
		out += source.slice(i, match.index);
		let pos = match.index + match[0].length;
		while (pos < source.length && /\s/.test(source[pos])) {
			pos += 1;
		}
		if (source[pos] !== '{') {
			// Malformed — keep the token and continue.
			out += source.slice(match.index, pos);
			i = pos;
			match = re.exec(source);
			continue;
		}
		let depth = 0;
		for (let j = pos; j < source.length; j += 1) {
			const ch = source[j];
			if (ch === '{') {
				depth += 1;
			} else if (ch === '}') {
				depth -= 1;
				if (depth === 0) {
					i = j + 1;
					break;
				}
			}
			if (j === source.length - 1) {
				// Unclosed — drop from @media to end.
				i = source.length;
			}
		}
		match = re.exec(source);
	}
	out += source.slice(i);
	return out;
}

/**
 * Collect stylesheet hrefs for Paged.js (Typekit + print engine + block view CSS).
 * Passing every wp_head stylesheet can stall or fight Paged.js layout, but
 * block `view.css` sheets carry logo sizes and alignment rules we need.
 *
 * @return {Array<string|Object>} Stylesheet URLs and inline CSS maps.
 */
function getPrintStylesheets() {
	const urls = Array.from(document.querySelectorAll('link[rel="stylesheet"]'))
		.map((link) => link.href)
		.filter((href) => {
			if (!href) {
				return false;
			}
			return (
				href.includes('typekit.net') ||
				href.includes('prc-print-engine') ||
				href.includes('/print-engine/') ||
				/\/view(\.min)?\.css(\?|$)/.test(href)
			);
		});

	// Block_Print_Registry / block-style inline CSS — strip nested @media print
	// so page-break rules are not double-applied inside Paged.js.
	const inline = Array.from(
		document.querySelectorAll(
			'style[id^="prc-print-engine"], style#prc-print-engine-view'
		)
	)
		.map((styleEl, index) => {
			const css = stripAtMediaPrintBlocks(styleEl.textContent || '');
			return css.trim()
				? { [`prc-print-engine-inline-${index}`]: css }
				: null;
		})
		.filter(Boolean);

	return [...urls, ...inline];
}

/**
 * Strip scripts and import maps so chapter block markup cannot throw
 * during Paged.js layout (e.g. bare "@wordpress/interactivity" imports).
 *
 * @param {string} html Source HTML.
 * @return {string} Sanitized HTML.
 */
function sanitizeContentHtml(html) {
	const template = document.createElement('template');
	template.innerHTML = html;
	template.content
		.querySelectorAll(
			'script, link[rel="modulepreload"], link[rel="preload"][as="script"]'
		)
		.forEach((node) => node.remove());
	return template.innerHTML;
}

/**
 * Rewrite VIP local upload URLs to the production media host so Paged.js
 * does not stall on the media-redirect 302 during layout.
 *
 * @param {string} src Image src.
 * @return {string} Resolved src.
 */
function resolvePrintImageSrc(src) {
	try {
		const url = new URL(src, window.location.href);
		if (
			url.hostname.includes('vipdev.lndo.site') &&
			url.pathname.includes('/uploads/')
		) {
			return `https://www.pewresearch.org${url.pathname}${url.search}`;
		}
	} catch (e) {
		// Keep original src.
	}
	return src;
}

const PRINT_SIZED_IMAGE_WIDTHS = {
	'size-200-wide': 200,
	'size-310-wide': 310,
	'size-420-wide': 420,
	'size-640-wide': 640,
};

/**
 * Return the class-name display width for a sized wp-block-image.
 *
 * @param {Element|null} el Figure or image.
 * @return {number|null} Width in px, or null.
 */
function getPrintSizedImageWidth(el) {
	if (!el) {
		return null;
	}
	const figure = el.closest ? el.closest('figure.wp-block-image') : null;
	const node = figure || el;
	const className = typeof node.className === 'string' ? node.className : '';
	const classes = className.split(/\s+/);
	if (!classes.includes('wp-block-image')) {
		return null;
	}
	for (const slug of Object.keys(PRINT_SIZED_IMAGE_WIDTHS)) {
		if (classes.includes(slug)) {
			return PRINT_SIZED_IMAGE_WIDTHS[slug];
		}
	}
	return null;
}

/**
 * Strip Photon/VIP size query args so print uses the original file.
 *
 * @param {string} src Image src.
 * @return {string} Src without size queries.
 */
function stripPhotonSizeQuery(src) {
	try {
		const url = new URL(src, window.location.href);
		['w', 'h', 'crop', 'resize', 'fit', 'zoom'].forEach((key) => {
			url.searchParams.delete(key);
		});
		return url.toString();
	} catch (e) {
		return src;
	}
}

/**
 * Preload every <img> in the content HTML so Paged.js does not stall
 * waiting on media redirects / late-decoding images mid-chunk.
 *
 * @param {string} html Content HTML.
 * @return {Promise<string>} HTML with resolved image srcs.
 */
async function preloadContentImages(html) {
	const template = document.createElement('template');
	template.innerHTML = html;

	template.content.querySelectorAll('img').forEach((img) => {
		const raw = img.getAttribute('src') || img.currentSrc || '';
		if (!raw) {
			return;
		}
		const sizedWidth = getPrintSizedImageWidth(img);
		let resolved = resolvePrintImageSrc(raw);
		if (sizedWidth) {
			resolved = stripPhotonSizeQuery(resolved);
		}
		img.setAttribute('src', resolved);
		img.removeAttribute('srcset');
		img.removeAttribute('sizes');
		img.setAttribute('loading', 'eager');
		img.setAttribute('decoding', 'sync');
		if (sizedWidth) {
			img.style.width = `${sizedWidth}px`;
			img.style.maxWidth = `${sizedWidth}px`;
		} else {
			img.style.maxWidth = '100%';
		}
		img.style.height = 'auto';
	});

	const urls = Array.from(
		new Set(
			Array.from(template.content.querySelectorAll('img'))
				.map((img) => img.getAttribute('src') || '')
				.filter(Boolean)
		)
	);

	await Promise.all(
		urls.map(
			(src) =>
				new Promise((resolve) => {
					const img = new Image();
					let settled = false;
					const done = () => {
						if (!settled) {
							settled = true;
							resolve();
						}
					};
					img.onload = done;
					img.onerror = done;
					img.decoding = 'sync';
					img.crossOrigin = 'anonymous';
					img.src = src;
					setTimeout(done, 10000);
				})
		)
	);

	return template.innerHTML;
}

/**
 * Prepare content for Paged.js: clamp print-chart figures that can exceed the
 * page box. Do not rewrite general image alignment — that belongs to block CSS.
 *
 * Paged.js silently stops pagination when a single unbreakable element is
 * taller than the page content area (GitHub pagedjs/pagedjs#274).
 *
 * @param {string} html Content HTML.
 * @return {string} Prepared HTML.
 */
function prepareContentForPagination(html) {
	const template = document.createElement('template');
	template.innerHTML = html;

	const pageContentMax = '7.5in';

	template.content.querySelectorAll('.print-engine-chart').forEach((el) => {
		el.style.setProperty('max-height', pageContentMax, 'important');
		el.style.setProperty('break-inside', 'auto', 'important');
		el.style.setProperty('page-break-inside', 'auto', 'important');
	});

	template.content
		.querySelectorAll('.print-engine-chart img')
		.forEach((img) => {
			img.style.setProperty('max-height', pageContentMax, 'important');
			img.style.setProperty('height', 'auto', 'important');
			img.style.setProperty('max-width', '100%', 'important');
		});

	return template.innerHTML;
}

/**
 * Wait for document fonts (Typekit) before paginating.
 *
 * @return {Promise<void>}
 */
async function waitForFonts() {
	if (document.fonts && document.fonts.ready) {
		try {
			await document.fonts.ready;
		} catch (e) {
			// Continue without blocking if Font Loading API fails.
		}
	}
}

/**
 * Enable or disable the print/download action buttons.
 *
 * @param {boolean} ready Whether Paged.js preview finished.
 */
function setToolbarReady(ready) {
	const downloadBtn = document.getElementById('print-engine-download-pdf');
	const printBtn = document.getElementById('print-engine-print-pdf');

	[downloadBtn, printBtn].forEach((btn) => {
		if (!btn) {
			return;
		}
		btn.disabled = !ready;
		btn.title = ready
			? btn.getAttribute('data-label') || btn.getAttribute('aria-label')
			: 'Preparing pages…';
	});
}

/**
 * Update action button titles with live page count while Paged.js runs.
 *
 * @param {HTMLElement} mountEl Mount element for the preview.
 * @return {Function} Disconnect cleanup.
 */
function watchPageProgress(mountEl) {
	const downloadBtn = document.getElementById('print-engine-download-pdf');
	const printBtn = document.getElementById('print-engine-print-pdf');
	const update = () => {
		const count = mountEl.querySelectorAll('.pagedjs_page').length;
		if (count <= 0) {
			return;
		}
		const title = `Preparing pages… (${count})`;
		[downloadBtn, printBtn].forEach((btn) => {
			if (btn && btn.disabled) {
				btn.title = title;
			}
		});
	};
	const observer = new MutationObserver(update);
	observer.observe(mountEl, { childList: true, subtree: true });
	return () => observer.disconnect();
}

/**
 * Read Paged.js target-counter page numbers from injected counter-reset rules
 * and write them into .print-engine-toc__page spans.
 *
 * Falls back to locating each href target (id or data-id) inside a
 * .pagedjs_page when CSS counters are missing — common when pagination
 * previously stopped early or targets lived on split continuations.
 *
 * @param {HTMLElement} mountEl Preview mount element.
 */
function fillTocPageNumbers(mountEl) {
	const pageByTarget = new Map();

	for (const sheet of document.styleSheets) {
		let rules;
		try {
			rules = sheet.cssRules;
		} catch (e) {
			continue;
		}
		if (!rules) {
			continue;
		}
		for (const rule of rules) {
			const text = rule.cssText || '';
			const match = text.match(
				/\[(data-target-counter-[^\]]+="[^"]+")\]::after\s*\{[^}]*counter-reset:\s*[^\s]+\s+(\d+)/
			);
			if (match) {
				pageByTarget.set(match[1], match[2]);
			}
		}
	}

	const pages = Array.from(mountEl.querySelectorAll('.pagedjs_page'));

	/**
	 * Resolve a fragment id to a 1-based page number via DOM position.
	 *
	 * @param {string} fragmentId Target id without '#'.
	 * @return {string|null} Page number or null.
	 */
	const pageForFragment = (fragmentId) => {
		if (!fragmentId || pages.length === 0) {
			return null;
		}
		const el =
			mountEl.querySelector(`#${CSS.escape(fragmentId)}`) ||
			mountEl.querySelector(`[data-id="${CSS.escape(fragmentId)}"]`);
		if (!el) {
			return null;
		}
		const pageEl = el.closest('.pagedjs_page');
		if (!pageEl) {
			return null;
		}
		const index = pages.indexOf(pageEl);
		return index >= 0 ? String(index + 1) : null;
	};

	mountEl.querySelectorAll('.print-engine-toc__link').forEach((link) => {
		const pageEl = link.querySelector('.print-engine-toc__page');
		if (!pageEl) {
			return;
		}

		const counterAttr = Array.from(link.attributes).find((attr) =>
			attr.name.startsWith('data-target-counter-')
		);
		if (counterAttr) {
			const key = `${counterAttr.name}="${counterAttr.value}"`;
			const fromCss = pageByTarget.get(key);
			if (fromCss) {
				pageEl.textContent = fromCss;
				return;
			}
		}

		const href = link.getAttribute('href') || '';
		const fragment = href.startsWith('#') ? href.slice(1) : '';
		const fromDom = pageForFragment(fragment);
		if (fromDom) {
			pageEl.textContent = fromDom;
		}
	});
}

/**
 * Re-parent chapter articles that escaped #print-engine-content during HTML
 * parsing (orphan </div> closed the mount early). Without this, Paged.js only
 * sees the overview and later chapters render full-width outside the page box.
 *
 * @param {HTMLElement} contentEl Print content mount.
 */
function reparentEscapedChapters(contentEl) {
	const escaped = [];
	let sibling = contentEl.nextElementSibling;
	while (sibling) {
		const next = sibling.nextElementSibling;
		const isChapter =
			sibling.matches?.(
				'article.print-engine-chapter, .print-engine-page.print-engine-chapter'
			) ||
			(typeof sibling.id === 'string' &&
				sibling.id.startsWith('chapter-'));
		if (isChapter) {
			escaped.push(sibling);
			sibling = next;
			continue;
		}
		// Chapters are contiguous before footer scripts; stop at the first
		// non-chapter node once we have started collecting, or at scripts.
		if (
			escaped.length > 0 ||
			sibling.tagName === 'SCRIPT' ||
			sibling.tagName === 'STYLE' ||
			sibling.id === 'wp-footer' ||
			sibling.classList?.contains('print-engine-actions')
		) {
			break;
		}
		sibling = next;
	}
	escaped.forEach((node) => {
		contentEl.appendChild(node);
	});
	if (escaped.length > 0) {
		// eslint-disable-next-line no-console
		console.warn(
			`Print engine: re-parented ${escaped.length} chapters that escaped the content mount.`
		);
	}
}

/**
 * Run Paged.js on the print content root.
 *
 * @return {Promise<void>}
 */
async function runPagedPreview() {
	const contentEl = document.getElementById('print-engine-content');
	if (!contentEl) {
		return;
	}

	setToolbarReady(false);

	await waitForFonts();

	// Repair parse damage from orphan </div>s before reading innerHTML.
	reparentEscapedChapters(contentEl);

	// Strip hide-on-print nodes before pagination.
	contentEl
		.querySelectorAll('[data-hide-on-print="true"]')
		.forEach((node) => node.remove());
	contentEl
		.querySelectorAll('[data-display-on-print="true"]')
		.forEach((node) => {
			node.style.setProperty('display', 'block', 'important');
			node.style.setProperty('visibility', 'visible', 'important');
		});

	setToolbarReady(false);
	const contentHtml = prepareContentForPagination(
		await preloadContentImages(sanitizeContentHtml(contentEl.innerHTML))
	);
	const stylesheets = getPrintStylesheets();

	contentEl.innerHTML = '';
	contentEl.classList.add('pagedjs-ready');

	setToolbarReady(false);
	const stopWatch = watchPageProgress(contentEl);
	const previewer = new Previewer();

	try {
		const flow = await previewer.preview(
			contentHtml,
			stylesheets,
			contentEl
		);

		if (flow && typeof flow.total === 'number') {
			// eslint-disable-next-line no-console
			console.log(`Print engine: laid out ${flow.total} pages.`);
		}

		const chapterTargets = (contentHtml.match(/\sid="chapter-\d+"/g) || [])
			.length;
		const chapterPages = new Set(
			Array.from(
				contentEl.querySelectorAll(
					'[id^="chapter-"], [data-id^="chapter-"]'
				)
			).map((el) => el.id || el.getAttribute('data-id'))
		).size;
		if (chapterTargets > 0 && chapterPages < chapterTargets) {
			// eslint-disable-next-line no-console
			console.warn(
				`Print engine: pagination incomplete — ${chapterPages}/${chapterTargets} chapters placed.`
			);
		}
	} catch (error) {
		// Restore sanitized markup so browser print still has content.
		contentEl.classList.remove('pagedjs-ready');
		contentEl.innerHTML = contentHtml;
		throw error;
	} finally {
		stopWatch();
	}

	// Best-effort TOC numbers — never discard a successful pagination.
	try {
		fillTocPageNumbers(contentEl);
	} catch (e) {
		// eslint-disable-next-line no-console
		console.warn('Print engine: TOC page numbers unavailable.', e);
	}

	setToolbarReady(true);
	document.body.dataset.printReady = 'true';
}

/**
 * Wire Print → window.print(); Download → stored PDF URL when present.
 */
function initPrintActions() {
	const downloadBtn = document.getElementById('print-engine-download-pdf');
	const printBtn = document.getElementById('print-engine-print-pdf');

	const triggerPrint = (event) => {
		event.preventDefault();
		// Apply chrome resets before print layout is captured. beforeprint is
		// still registered as a backup for system print (Ctrl/Cmd+P).
		document.body.classList.add('is-printing');
		window.print();
	};

	const triggerDownload = (event) => {
		event.preventDefault();
		const pdfUrl = downloadBtn?.getAttribute('data-pdf-url');
		if (pdfUrl) {
			window.location.assign(pdfUrl);
			return;
		}
		triggerPrint(event);
	};

	if (downloadBtn) {
		downloadBtn.addEventListener('click', triggerDownload);
	}
	if (printBtn) {
		printBtn.addEventListener('click', triggerPrint);
	}
}

domReady(() => {
	const isPdfView = document.body.classList.contains('print-engine-pdf-view');

	if (!isPdfView) {
		return;
	}

	initPrintActions();
	runPagedPreview().catch((error) => {
		// eslint-disable-next-line no-console
		console.error('Paged.js preview failed:', error);
		setToolbarReady(true);
		// Soft-fail still marks ready so headless PDF capture can proceed.
		// Do not alert() — a blocking dialog stalls Puppeteer page.pdf().
		document.body.dataset.printReady = 'true';
	});
});
