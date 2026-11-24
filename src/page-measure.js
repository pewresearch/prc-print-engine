/* eslint-env browser */
/**
 * Measurements on a Paged.js page that the float guard and box guard share.
 *
 * Paged.js pages are CSS columns: content Chromium pushed off the page sits
 * in a later column to the right, so measurements keep to the first column.
 */

/**
 * Internal Dependencies
 */
import { PRINT_HEADING_SELECTOR } from './chart-reflow';

// Sub-pixel rounding in Paged.js bounds; anything smaller is not a clip.
export const TOLERANCE_PX = 1;

/**
 * Height of an element including its vertical margins.
 *
 * @param {Element} el Element.
 * @return {number} Outer height in px.
 */
export function outerHeight(el) {
	const style = getComputedStyle(el);
	return (
		el.getBoundingClientRect().height +
		parseFloat(style.marginTop || '0') +
		parseFloat(style.marginBottom || '0')
	);
}

/**
 * Lowest bottom edge (plus bottom margin) of content before a node on this
 * page, in its first column.
 *
 * @param {Element} node     Node to measure above.
 * @param {Element} rendered Page content wrapper.
 * @param {DOMRect} bounds   Page content area.
 * @return {number} Viewport y coordinate.
 */
export function contentBottomBefore(node, rendered, bounds) {
	let bottom = bounds.top;
	// querySelectorAll is in document order: stop at the node, skip its
	// ancestors, and everything else seen so far precedes it.
	for (const el of rendered.querySelectorAll('*')) {
		if (el === node) {
			break;
		}
		if (el.contains(node)) {
			continue;
		}
		const margin = parseFloat(getComputedStyle(el).marginBottom || '0');
		// Chromium can stretch a heading's box (`break-after: avoid`) down the
		// column; use its last text line instead.
		const textBottom =
			STRETCHABLE.test(el.tagName) || el.matches(TITLE_BLOCKS)
				? contentBottomOf(el, bounds)
				: null;
		for (const rect of el.getClientRects()) {
			if (rect.height > 0 && rect.left < bounds.right - TOLERANCE_PX) {
				const elBottom =
					null === textBottom
						? rect.bottom
						: Math.min(rect.bottom, textBottom);
				bottom = Math.max(bottom, elBottom + margin);
			}
		}
	}
	return bottom;
}

const STRETCHABLE = /^H[1-6]$/;
const TITLE_BLOCKS =
	'.print-engine-body-header, .print-engine-body-header > *, .print-engine-chapter__title';

/**
 * Content height left on the page if it breaks before a node, in px.
 *
 * @param {Element} node     Break target.
 * @param {Element} rendered Page content wrapper.
 * @param {DOMRect} bounds   Page content area.
 * @return {number} Height in px, at most the page height.
 */
export function filledBefore(node, rendered, bounds) {
	return Math.min(
		contentBottomBefore(node, rendered, bounds) - bounds.top,
		bounds.height
	);
}

/**
 * Whether `other` comes before `node` in document order (and does not
 * contain it).
 *
 * @param {Node} node  Reference node.
 * @param {Node} other Node to test.
 * @return {boolean} True when other precedes node.
 */
export function precedes(node, other) {
	const position = node.compareDocumentPosition(other);
	return (
		Math.floor(position / Node.DOCUMENT_POSITION_PRECEDING) % 2 === 1 &&
		Math.floor(position / Node.DOCUMENT_POSITION_CONTAINS) % 2 === 0
	);
}

/**
 * Whether text or media other than headings precedes a point on the page.
 *
 * @param {Element} rendered Page content wrapper.
 * @param {Node}    node     Break candidate, or the container of `offset`.
 * @param {number}  [offset] Offset in `node`; omit to test before `node`.
 * @return {boolean} True when body content sits before the point.
 */
export function hasBodyContentBefore(rendered, node, offset) {
	const range = document.createRange();
	range.setStart(rendered, 0);
	if (typeof offset === 'number') {
		range.setEnd(node, offset);
	} else {
		range.setEndBefore(node);
	}
	return hasBodyContentIn(range, rendered);
}

/**
 * Whether text or media other than headings lies between the start of a
 * range (such as a Paged.js overflow) and a node after it.
 *
 * @param {Element} rendered Page content wrapper.
 * @param {Range}   from     Range whose start is tested.
 * @param {Node}    node     Node after that start.
 * @return {boolean} True when body content sits between them.
 */
export function hasBodyContentBetween(rendered, from, node) {
	const range = document.createRange();
	range.setStart(from.startContainer, from.startOffset);
	range.setEndBefore(node);
	return !range.collapsed && hasBodyContentIn(range, rendered);
}

/**
 * Whether a range on the page holds text or media other than headings.
 *
 * @param {Range}   range    Range on the page.
 * @param {Element} rendered Page content wrapper.
 * @return {boolean} True when it holds body content.
 */
function hasBodyContentIn(range, rendered) {
	// Runs on every Paged.js overflow check, so count characters instead of
	// cloning the page.
	const visibleChars = (text) => text.replace(/\s+/g, '').length;
	let chars = visibleChars(range.toString());
	rendered.querySelectorAll(PRINT_HEADING_SELECTOR).forEach((heading) => {
		const inHeader = heading.parentElement?.closest(
			'.print-engine-body-header'
		);
		if (!inHeader && range.intersectsNode(heading)) {
			chars -= visibleChars(heading.textContent);
		}
	});
	if (chars > 0) {
		return true;
	}
	return Array.from(
		rendered.querySelectorAll('img, svg, table, figure, hr')
	).some((media) => range.intersectsNode(media));
}

/**
 * A range from just before a node to the end of the page content.
 *
 * @param {Node}    node     Break target.
 * @param {Element} rendered Page content wrapper.
 * @return {Range} Overflow range.
 */
export function rangeFromNode(node, rendered) {
	const range = document.createRange();
	range.setStartBefore(node);
	range.setEndAfter(rendered.lastChild);
	return range;
}

/**
 * The element a range starts at (the child at its offset, or the parent of
 * its text node).
 *
 * @param {Range} range Overflow range.
 * @return {Element|null} Element.
 */
export function rangeStartElement(range) {
	const container = range.startContainer;
	if (container.nodeType === Node.ELEMENT_NODE) {
		return container.childNodes[range.startOffset] instanceof Element
			? container.childNodes[range.startOffset]
			: container;
	}
	return container.parentElement;
}

/**
 * How far down a Paged.js page its content reaches, from text lines and
 * media in the first column, as a share of the text well height.
 *
 * @param {Element} pageEl `.pagedjs_page` element.
 * @return {number} Fill, 0–1.
 */
export function pageFill(pageEl) {
	const area = pageEl.querySelector('.pagedjs_page_content');
	if (!area) {
		return 0;
	}
	const box = area.getBoundingClientRect();
	let bottom = box.top;
	const take = (rect) => {
		if (
			rect.width > 0 &&
			rect.height > 0 &&
			rect.left < box.right - TOLERANCE_PX &&
			rect.top < box.bottom - TOLERANCE_PX
		) {
			bottom = Math.max(bottom, Math.min(rect.bottom, box.bottom));
		}
	};
	const walker = document.createTreeWalker(area, NodeFilter.SHOW_TEXT);
	const range = document.createRange();
	for (let text = walker.nextNode(); text; text = walker.nextNode()) {
		if (text.textContent.trim()) {
			range.selectNodeContents(text);
			Array.from(range.getClientRects()).forEach(take);
		}
	}
	area.querySelectorAll('img, svg, table, hr').forEach((el) => {
		Array.from(el.getClientRects()).forEach(take);
	});
	return box.height > 0 ? (bottom - box.top) / box.height : 0;
}

/**
 * Lowest text line or image of an element in the first column of a page.
 * Element boxes are not used: with `break-after: avoid` Chromium can stretch
 * a heading's box down the column.
 *
 * @param {Element} el     Element.
 * @param {DOMRect} bounds Page content area.
 * @return {number|null} Viewport y coordinate, or null without visible content.
 */
export function contentBottomOf(el, bounds) {
	let bottom = null;
	const take = (rect) => {
		if (
			rect.width > 0 &&
			rect.height > 0 &&
			rect.left < bounds.right - TOLERANCE_PX &&
			rect.top < bounds.bottom - TOLERANCE_PX
		) {
			bottom = Math.max(bottom ?? rect.bottom, rect.bottom);
		}
	};
	const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
	const range = document.createRange();
	for (let text = walker.nextNode(); text; text = walker.nextNode()) {
		if (text.textContent.trim()) {
			range.selectNodeContents(text);
			Array.from(range.getClientRects()).forEach(take);
		}
	}
	el.querySelectorAll('img, svg, table').forEach((media) => {
		Array.from(media.getClientRects()).forEach(take);
	});
	return bottom;
}
