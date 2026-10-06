/**
 * Print layout helpers: expand details, heading ids, page footnotes, sized images.
 */

/**
 * Internal dependencies
 */
import { getProducerImageWidth } from './chart-reflow';

const SIZED_IMAGE_WIDTHS = {
	'size-200-wide': 200,
	'size-310-wide': 310,
	'size-420-wide': 420,
	'size-640-wide': 640,
};
const PAGE_CONTENT_MAX = '7.5in';
// 7.5in at 96 CSS px per inch.
const PAGE_CONTENT_MAX_PX = 720;
const originalHeadingIds = new WeakMap();

/**
 * Apply print-only DOM fixes before Paged.js paginates.
 *
 * @param {DocumentFragment|Element} root Content root.
 */
export function preparePrintLayout(root) {
	if (!root || !root.querySelectorAll) {
		return;
	}
	expandDetails(root);
	ensureHeadingIds(root);
	ensureSelectorSafeTocTargets(root);
	reflowFootnotes(root);
	clampSizedImages(root);
}

/**
 * Scale script-drawn SVG charts that are taller than the page content area.
 *
 * Feature scripts size their SVG to the viewport (1080px in the Firebase
 * renderer), which is taller than the 8.5in text well. Paged.js cannot split
 * an SVG and loops on it ("Layout repeated"). Add a viewBox and shrink the
 * width/height attributes so the drawing scales to 7.5in. Call on the live
 * DOM: the size only exists after the feature script ran.
 *
 * @param {Element} contentEl Print content mount.
 */
export function fitTallSvgs(contentEl) {
	contentEl.querySelectorAll('svg').forEach((svg) => {
		if (svg.parentElement?.closest('svg')) {
			return;
		}
		const { width, height } = svg.getBoundingClientRect();
		if (height <= PAGE_CONTENT_MAX_PX || width <= 0) {
			return;
		}
		if (!svg.hasAttribute('viewBox')) {
			svg.setAttribute(
				'viewBox',
				`0 0 ${Math.round(width)} ${Math.round(height)}`
			);
		}
		const scale = PAGE_CONTENT_MAX_PX / height;
		svg.setAttribute('width', String(Math.floor(width * scale)));
		svg.setAttribute('height', String(PAGE_CONTENT_MAX_PX));
	});
}

/**
 * Keep body details open so images and copy inside them print.
 *
 * @param {DocumentFragment|Element} root Content root.
 */
function expandDetails(root) {
	root.querySelectorAll('details').forEach((el) => {
		el.setAttribute('open', '');
	});
}

/**
 * Give content H2/H3 elements unique ids, then point TOC hrefs at them.
 *
 * Core heading render stamps `sanitize_title` ids without de-duplicating, so
 * repeated titles (e.g. "Overview" in every chapter) share one id. TOC hrefs
 * are built separately from `attrs.anchor` / `sanitize_title` and are never
 * updated. Uniquify first, then rewrite TOC links to the ids that landed.
 *
 * @param {DocumentFragment|Element} root Content root.
 */
function ensureHeadingIds(root) {
	const contentHeadings = getPrintContentHeadings(root);
	const contentSet = new Set(contentHeadings);
	const used = new Set();
	root.querySelectorAll('[id]').forEach((el) => {
		if (el.id && !contentSet.has(el)) {
			used.add(el.id);
		}
	});

	contentHeadings.forEach((el) => {
		assignUniqueHeadingId(el, used);
	});

	// Front-matter / chapter-title headings are not TOC targets (`#chapter-N`,
	// `#print-engine-*`). Assign leftover ids after content so they cannot
	// steal slugs such as `overview`.
	root.querySelectorAll('h2, h3').forEach((el) => {
		if (contentSet.has(el) || el.id) {
			return;
		}
		assignUniqueHeadingId(el, used);
	});

	syncTocHeadingHrefs(root);
}

/**
 * H2/H3 elements in article or chapter body content.
 *
 * @param {DocumentFragment|Element} root Content root.
 * @return {HTMLElement[]} Headings in document order.
 */
function getPrintContentHeadings(root) {
	const containers = root.querySelectorAll(
		'.print-engine-article__content, .print-engine-chapter__content'
	);
	const scopes = containers.length ? Array.from(containers) : [root];
	const headings = [];
	scopes.forEach((scope) => {
		scope.querySelectorAll('h2, h3').forEach((el) => {
			headings.push(el);
		});
	});
	return headings;
}

/**
 * Set a unique id on a heading, keeping an existing id when it is free.
 *
 * @param {HTMLElement} el   Heading element.
 * @param {Set<string>} used Ids already claimed in this document.
 */
function assignUniqueHeadingId(el, used) {
	if (!originalHeadingIds.has(el)) {
		originalHeadingIds.set(el, el.id || '');
	}
	const base = el.id || slugify(el.textContent || '');
	if (!base) {
		return;
	}
	let id = base;
	let n = 2;
	while (used.has(id)) {
		id = `${base}-${n}`;
		n += 1;
	}
	el.id = id;
	used.add(id);
}

/**
 * Rewrite TOC hrefs so each entry targets the heading it lists.
 *
 * Matches by original slug (and label fallback), not list position, so a
 * missing `hideOnPrint` heading or an extra non-heading `h3` cannot shift
 * later rows. Skips headings inside `details` because the PHP TOC walker
 * does not recurse into those blocks.
 *
 * @param {DocumentFragment|Element} root Content root.
 */
function syncTocHeadingHrefs(root) {
	root.querySelectorAll('.print-engine-chapter[id]').forEach((chapter) => {
		const item = findChapterTocItem(root, chapter.id);
		if (!item) {
			return;
		}
		const links = item.querySelectorAll('.print-engine-toc__link--h3');
		const headings = tocTargetHeadings(
			chapter.querySelector('.print-engine-chapter__content'),
			'h3'
		);
		assignTocHrefs(links, headings);
	});

	const article = root.querySelector('.print-engine-article__content');
	if (!article) {
		return;
	}
	const headings = tocTargetHeadings(article, 'h2, h3');
	const articleLinks = [];
	root.querySelectorAll(
		'.print-engine-toc__list > .print-engine-toc__item'
	).forEach((item) => {
		const link = item.querySelector(':scope > .print-engine-toc__link');
		if (!link) {
			return;
		}
		const href = link.getAttribute('href') || '';
		if (isReservedTocHref(href)) {
			return;
		}
		articleLinks.push(link);
		item.querySelectorAll('.print-engine-toc__link--h3').forEach(
			(child) => {
				articleLinks.push(child);
			}
		);
	});
	assignTocHrefs(articleLinks, headings);
}

/**
 * Front-matter (`#print-engine-*`) and report chapter (`#chapter-{id}`) rows.
 *
 * Article headings titled "Chapter 1" slug to `#chapter-1-…` and must sync.
 *
 * @param {string} href TOC href.
 * @return {boolean} True when the row is not a body heading.
 */
function isReservedTocHref(href) {
	return href.startsWith('#print-engine-') || /^#chapter-\d+$/.test(href);
}

/**
 * Chapter TOC row for a `#chapter-N` target (not the part label that reuses it).
 *
 * @param {DocumentFragment|Element} root      Content root.
 * @param {string}                   chapterId Chapter element id.
 * @return {HTMLElement|null} List item or null.
 */
function findChapterTocItem(root, chapterId) {
	const want = `#${chapterId}`;
	const links = root.querySelectorAll('.print-engine-toc__link');
	for (const link of links) {
		if (link.getAttribute('href') !== want) {
			continue;
		}
		const item = link.closest('li.print-engine-toc__item');
		if (item && !item.classList.contains('print-engine-toc__item--part')) {
			return item;
		}
	}
	return null;
}

/**
 * Headings that correspond to TOC entries.
 *
 * @param {Element|null} container Content container.
 * @param {string}       selector  Heading selector.
 * @return {HTMLElement[]} Matching headings in document order.
 */
function tocTargetHeadings(container, selector) {
	if (!container) {
		return [];
	}
	return Array.from(container.querySelectorAll(selector)).filter(
		(el) =>
			!el.closest('details') &&
			el.id &&
			el.classList.contains('wp-block-heading')
	);
}

/**
 * @param {Iterable<HTMLElement>} links    TOC anchors.
 * @param {HTMLElement[]}         headings Target headings.
 */
function assignTocHrefs(links, headings) {
	const remaining = headings.slice();
	Array.from(links).forEach((link) => {
		assignTocHref(link, remaining);
	});
}

/**
 * Point one TOC link at the heading it names, consuming that heading.
 *
 * @param {HTMLElement}   link      TOC anchor.
 * @param {HTMLElement[]} remaining Unmatched headings in document order.
 */
function assignTocHref(link, remaining) {
	const href = link.getAttribute('href') || '';
	const fragment = href.startsWith('#') ? href.slice(1) : href;
	const labelEl = link.querySelector('.print-engine-toc__label');
	const label = (labelEl?.textContent || '').replace(/\s+/g, ' ').trim();

	let index = -1;
	if (fragment) {
		index = remaining.findIndex((el) => {
			const originalId = originalHeadingIds.get(el) || '';
			return originalId === fragment || el.id === fragment;
		});
	}
	if (index < 0 && label) {
		const needle = label.toLowerCase();
		index = remaining.findIndex((el) => {
			const originalId = originalHeadingIds.get(el) || '';
			if (originalId) {
				return false;
			}
			const headingText = (el.textContent || '')
				.replace(/\s+/g, ' ')
				.trim()
				.toLowerCase();
			return headingText === needle;
		});
	}
	if (index < 0) {
		return;
	}
	const heading = remaining.splice(index, 1)[0];
	if (heading?.id) {
		link.setAttribute('href', `#${heading.id}`);
	}
}

/**
 * Rename TOC targets whose ids are not valid CSS id selectors.
 *
 * Paged.js resolves `target-counter(attr(href url))` with querySelector, so a
 * heading anchor such as `2024-vote-choice` throws and aborts pagination.
 *
 * @param {DocumentFragment|Element} root Content root.
 */
function ensureSelectorSafeTocTargets(root) {
	const used = new Set(
		Array.from(root.querySelectorAll('[id]')).map((el) => el.id)
	);
	root.querySelectorAll('.print-engine-toc__link').forEach((link) => {
		const href = link.getAttribute('href') || '';
		if (!href.startsWith('#') || isSelectorSafeId(href.slice(1))) {
			return;
		}
		const fragment = href.slice(1);
		const target = Array.from(root.querySelectorAll('[id]')).find(
			(el) => el.id === fragment
		);
		let id = `h-${slugify(fragment) || 'target'}`;
		let n = 2;
		while (used.has(id)) {
			id = `h-${slugify(fragment) || 'target'}-${n}`;
			n += 1;
		}
		used.add(id);
		if (target) {
			target.id = id;
		}
		root.querySelectorAll('a[href]').forEach((anchor) => {
			if (anchor.getAttribute('href') === href) {
				anchor.setAttribute('href', `#${id}`);
			}
		});
	});
}

/**
 * Whether `#id` parses as a CSS id selector without escaping.
 *
 * @param {string} id Element id.
 * @return {boolean} True when the id is a valid CSS identifier.
 */
function isSelectorSafeId(id) {
	return /^(?:-?[A-Za-z_\u00a0-\uffff]|--)[\w\u00a0-\uffff-]*$/.test(id);
}

/**
 * @param {string} text Heading text.
 * @return {string} URL fragment.
 */
function slugify(text) {
	return text
		.toLowerCase()
		.normalize('NFKD')
		.replace(/[\u0300-\u036f]/g, '')
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '')
		.slice(0, 80);
}

/**
 * Move footnote list items next to their superscripts for Paged.js `float: footnote`.
 *
 * @param {DocumentFragment|Element} root Content root.
 */
function reflowFootnotes(root) {
	const lists = root.querySelectorAll(
		'ol.wp-block-prc-block-footnotes, ol#footnotes'
	);
	lists.forEach((list) => {
		const scope =
			list.closest('.print-engine-chapter, .print-engine-article') ||
			root;
		const byId = new Map();
		list.querySelectorAll('li[id]').forEach((item) => {
			const clone = item.cloneNode(true);
			clone
				.querySelectorAll(
					'.wp-block-prc-block-footnotes__footnote__return'
				)
				.forEach((node) => {
					node.remove();
				});
			byId.set(item.id, clone.innerHTML.trim());
		});
		if (byId.size) {
			scope
				.querySelectorAll('sup.footnote a[href^="#"]')
				.forEach((anchor) => {
					const id = (anchor.getAttribute('href') || '').replace(
						/^#/,
						''
					);
					const html = byId.get(id);
					if (!html) {
						return;
					}
					const sup = anchor.closest('sup') || anchor;
					if (
						sup.nextElementSibling?.classList.contains(
							'print-engine-fn'
						)
					) {
						return;
					}
					const note = anchor.ownerDocument.createElement('span');
					note.className = 'print-engine-fn';
					note.setAttribute(
						'data-n',
						(anchor.textContent || '').trim()
					);
					note.innerHTML = html;
					sup.insertAdjacentElement('afterend', note);
				});
		}
		list.remove();
	});
}

/**
 * Print display width of a sized or producer-resized image figure.
 *
 * @param {Element} figure Figure node.
 * @return {number|null} Width in px, or null when neither is set.
 */
export function getPrintImageWidth(figure) {
	return getProducerImageWidth(figure) || getSizeClassWidth(figure);
}

/**
 * Width from a size-{200,310,420,640}-wide class.
 *
 * @param {Element} figure Figure node.
 * @return {number|null} Width in px, or null without a size class.
 */
function getSizeClassWidth(figure) {
	for (const [slug, width] of Object.entries(SIZED_IMAGE_WIDTHS)) {
		if (figure.classList.contains(slug)) {
			return width;
		}
	}
	return null;
}

/**
 * Pin sized/resized figures to their print width, and cap tall ones.
 *
 * A figure taller than 7.5in shrinks proportionally (width follows height) so
 * the chart keeps its aspect ratio. A width that differs from the size class
 * lands in `data-print-pin`, and getPrintImageCss() turns it into rules:
 * Paged.js marks any element with an inline style attribute as undisplayed
 * and will not break before it, which would stop the float guard from moving
 * the figure. Figures at their class width keep the print.scss class rules.
 *
 * @param {DocumentFragment|Element} root Content root.
 */
function clampSizedImages(root) {
	root.querySelectorAll('figure.wp-block-image').forEach((figure) => {
		let width = getPrintImageWidth(figure);
		const img = figure.querySelector('img');
		if (!width || !img) {
			return;
		}

		const ratio = getImageAspectRatio(img);
		if (ratio && width * ratio > PAGE_CONTENT_MAX_PX) {
			width = Math.floor(PAGE_CONTENT_MAX_PX / ratio);
			figure.classList.add('print-engine-image--capped');
		}

		if (width !== getSizeClassWidth(figure)) {
			figure.setAttribute('data-print-pin', String(width));
		}
	});
}

/**
 * Stylesheet that pins each `data-print-pin` on its figure and image.
 *
 * @param {DocumentFragment|Element} root Prepared content root.
 * @return {string} CSS text, empty when no figure is pinned.
 */
export function getPrintImageCss(root) {
	const widths = new Set(
		Array.from(
			root.querySelectorAll('figure.wp-block-image[data-print-pin]')
		).map((figure) => parseInt(figure.getAttribute('data-print-pin'), 10))
	);
	return Array.from(widths)
		.filter((width) => width > 0)
		.map((width) => {
			const figure = `.print-engine-pdf-view figure.wp-block-image[data-print-pin="${width}"]`;
			return (
				`${figure}{width:min(${width}px,100%)!important;max-width:min(${width}px,100%)!important}` +
				`${figure} img{width:${width}px!important;max-width:100%!important;height:auto!important;max-height:${PAGE_CONTENT_MAX}!important;object-fit:fill!important}`
			);
		})
		.join('\n');
}

/**
 * Height / width of an image from the preloaded file or its attributes.
 *
 * @param {HTMLImageElement} img Image node.
 * @return {number|null} Aspect ratio, or null when unknown.
 */
function getImageAspectRatio(img) {
	const pairs = [
		[
			img.getAttribute('data-natural-width'),
			img.getAttribute('data-natural-height'),
		],
		[img.getAttribute('width'), img.getAttribute('height')],
	];
	for (const [w, h] of pairs) {
		const width = parseFloat(w || '');
		const height = parseFloat(h || '');
		if (width > 0 && height > 0) {
			return height / width;
		}
	}
	return null;
}
