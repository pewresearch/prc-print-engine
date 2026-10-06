/* eslint-env browser */
/**
 * Paged.js handler: move a floated figure to the next page instead of losing it.
 *
 * Paged.js never breaks before a float (layout.js findOverflow skips floats)
 * and only checks vertical overflow. A right-floated chart that runs past the
 * page bottom, or that Chrome moves into the next CSS column because it does
 * not fit below its lead, stays outside the clipped page box and vanishes from
 * the PDF. When that happens, break before the figure (or its heading + intro
 * lead) so it starts the next page. Short floats that fit are left alone.
 *
 * A tall chart that is already first on its page (often right under a section
 * or chapter heading) cannot move. It is scaled to the space below that
 * heading and stays floated; if it still does not land on the page it is
 * unfloated (kept right-aligned) at the scaled size, so heading and chart
 * share the page either way. Only a chart that would drop below half size is
 * unfloated at full size.
 *
 * Measurements use each piece's own client rects: Paged.js pages are CSS
 * columns, and a pushed-aside float (or its parent) spans two columns, so a
 * single getBoundingClientRect() mixes both.
 */

/**
 * External Dependencies
 */
import { Handler, registerHandlers } from 'pagedjs';

/**
 * Internal Dependencies
 */
import { PRINT_HEADING_SELECTOR } from './chart-reflow';

// Sub-pixel rounding in Paged.js bounds; anything smaller is not a clip.
const TOLERANCE_PX = 1;
const UNFLOATED_CLASS = 'print-engine-figure--unfloated';
// Below this the chart would be too small to read; unfloat at full size.
const MIN_KEEP_SCALE = 0.5;
// Room left under a scaled chart for rounding in Chrome's column layout.
const SHRINK_SLACK_PX = 4;

class FloatOverflowGuard extends Handler {
	/**
	 * @param {Range|undefined} overflow Overflow range Paged.js found.
	 * @param {Element}         rendered Page content wrapper.
	 * @param {DOMRect}         bounds   Page content area.
	 * @param {Object}          layout   Paged.js Layout for this page.
	 * @return {Range|null|undefined} New overflow, null for none, or undefined to keep.
	 */
	onOverflow(overflow, rendered, bounds, layout) {
		const clip = findClippedFloat(rendered, overflow, bounds);
		if (!clip) {
			return undefined;
		}
		if (clip.breakBefore) {
			const range = document.createRange();
			range.setStartBefore(clip.breakBefore);
			range.setEndAfter(rendered.lastChild);
			return range;
		}
		fitStuckFloat(clip.stuck, rendered, bounds);
		return layout.findOverflow(rendered, bounds) || null;
	}
}

/**
 * Scale a float that is first on its page to the space below what precedes
 * it, then keep it floated or unfloat it at that size.
 *
 * Runs on the rendered page clone only, so the inline style here does not
 * hit Paged.js's undisplayed filter (that runs on the source).
 *
 * @param {Element} figure   Floated figure that cannot move.
 * @param {Element} rendered Page content wrapper.
 * @param {DOMRect} bounds   Page content area.
 */
function fitStuckFloat(figure, rendered, bounds) {
	const img = figure.querySelector('img');
	if (!img || figure.hasAttribute('data-print-shrunk')) {
		figure.classList.add(UNFLOATED_CLASS);
		return;
	}
	const style = getComputedStyle(figure);
	const available =
		bounds.bottom -
		contentBottomBefore(figure, rendered, bounds) -
		parseFloat(style.marginTop || '0') -
		parseFloat(style.marginBottom || '0') -
		SHRINK_SLACK_PX;
	const imgRect = img.getBoundingClientRect();
	const otherHeight = figureParts(figure).others.reduce(
		(sum, child) => sum + outerHeight(child),
		0
	);
	const scale = Math.min((available - otherHeight) / imgRect.height, 1);

	if (!(scale >= MIN_KEEP_SCALE)) {
		figure.classList.add(UNFLOATED_CLASS);
		return;
	}

	const imgWidth = Math.floor(imgRect.width * scale);
	figure.setAttribute('data-print-shrunk', String(imgWidth));
	// The 7.5in box cap would hide the caption and note from layout.
	figure.style.setProperty('max-height', 'none', 'important');
	if (!otherHeight) {
		figure.style.setProperty('width', `${imgWidth}px`, 'important');
		figure.style.setProperty('max-width', `${imgWidth}px`, 'important');
	}
	// Set both sides: with max-height already binding, a width-only change
	// would neither shorten the image nor keep its aspect ratio.
	img.style.setProperty('width', `${imgWidth}px`, 'important');
	img.style.setProperty(
		'height',
		`${Math.floor(imgRect.height * scale)}px`,
		'important'
	);

	if (figureOnPage(figure, bounds)) {
		return;
	}
	// Keep the scaled size: at full size the heading plus chart would not fit
	// and Paged.js would split the heading across pages.
	figure.classList.add(UNFLOATED_CLASS);
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
function contentBottomBefore(node, rendered, bounds) {
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
		for (const rect of el.getClientRects()) {
			if (rect.height > 0 && rect.left < bounds.right - TOLERANCE_PX) {
				bottom = Math.max(bottom, rect.bottom + margin);
			}
		}
	}
	return bottom;
}

/**
 * Height of an element including its vertical margins.
 *
 * @param {Element} el Element.
 * @return {number} Outer height in px.
 */
function outerHeight(el) {
	const style = getComputedStyle(el);
	return (
		el.getBoundingClientRect().height +
		parseFloat(style.marginTop || '0') +
		parseFloat(style.marginBottom || '0')
	);
}

/**
 * A figure's image and the children that are not the image (or its link).
 *
 * The image is often wrapped in an inline <a>, whose own rects do not
 * describe the block image inside it, so measure the image directly.
 *
 * @param {Element} figure Figure node.
 * @return {{img: Element|null, others: Element[]}} Parts.
 */
function figureParts(figure) {
	const img = figure.querySelector('img');
	const holder = img
		? [...figure.children].find((child) => child.contains(img))
		: null;
	return {
		img,
		others: [...figure.children].filter((child) => child !== holder),
	};
}

/**
 * Height of a figure's content: the image plus its other children.
 *
 * @param {Element} figure Figure node.
 * @return {number} Content height in px.
 */
function figureContentHeight(figure) {
	const { img, others } = figureParts(figure);
	return (
		(img ? img.getBoundingClientRect().height : 0) +
		others.reduce((sum, child) => sum + outerHeight(child), 0)
	);
}

/**
 * Client rects of a figure's pieces (image and other children, one rect per
 * column).
 *
 * @param {Element} figure Figure node.
 * @return {DOMRect[]} Non-empty rects.
 */
function figurePieces(figure) {
	const { img, others } = figureParts(figure);
	const parts = img ? [img, ...others] : [figure];
	return parts
		.flatMap((part) => [...part.getClientRects()])
		.filter((rect) => rect.width > 0 && rect.height > 0);
}

/**
 * Whether every piece of a figure sits inside the page content area.
 *
 * @param {Element} figure Figure node.
 * @param {DOMRect} bounds Page content area.
 * @return {boolean} True when nothing is clipped or pushed aside.
 */
function figureOnPage(figure, bounds) {
	return figurePieces(figure).every(
		(rect) =>
			rect.left < bounds.right - TOLERANCE_PX &&
			rect.right <= bounds.right + TOLERANCE_PX &&
			rect.bottom <= bounds.bottom + TOLERANCE_PX
	);
}

/**
 * Fix for the first floated figure that is clipped or pushed off the page.
 *
 * Prefers breaking before the figure's heading + intro lead when both fit on
 * one page. Falls back to the figure alone when moving the lead would leave
 * only headings behind (a chapter title stranded on its own page). A figure
 * that is already first on the page is reported as stuck.
 *
 * @param {Element}         rendered Page content wrapper.
 * @param {Range|undefined} overflow Current overflow range.
 * @param {DOMRect}         bounds   Page content area.
 * @return {{breakBefore?: Element, stuck?: Element}|null} Fix, or null.
 */
function findClippedFloat(rendered, overflow, bounds) {
	// Overflow from the very top means Paged.js would repeat this page.
	let wholePage;
	const overflowsWholePage = () => {
		if (undefined === wholePage) {
			wholePage = !hasBodyContentBefore(
				rendered,
				overflow.startContainer,
				overflow.startOffset
			);
		}
		return wholePage;
	};
	for (const figure of rendered.querySelectorAll('figure')) {
		const isFloat = getComputedStyle(figure).float !== 'none';
		// A break inside the float (even at offset 0) leaves an empty figure
		// shell here and its heading + intro without the chart; move the
		// whole unit instead.
		const splitsFigure =
			isFloat && overflow && figure.contains(overflow.startContainer);
		if (
			!splitsFigure &&
			overflow &&
			overflow.isPointInRange(figure, 0) &&
			!overflowsWholePage()
		) {
			return null;
		}
		if (!isFloat) {
			continue;
		}
		if (!splitsFigure && figureOnPage(figure, bounds)) {
			continue;
		}
		const lead = leadFor(figure);
		if (
			lead &&
			fitsOnePage(lead, figure, bounds) &&
			hasBodyContentBefore(rendered, lead)
		) {
			return { breakBefore: lead };
		}
		// Without body content before it, the node is already first on the
		// page (moving it again would loop) or would strand a heading.
		if (hasBodyContentBefore(rendered, figure)) {
			return { breakBefore: figure };
		}
		if (figureContentHeight(figure) > bounds.height / 2) {
			return { stuck: figure };
		}
	}
	return null;
}

/**
 * Whether the lead and the figure below it fit together on an empty page.
 *
 * @param {Element} lead   Heading + intro wrapper.
 * @param {Element} figure Floated figure.
 * @param {DOMRect} bounds Page content area.
 * @return {boolean} True when both fit in the page height.
 */
function fitsOnePage(lead, figure, bounds) {
	const leadHeight = Array.from(lead.children).reduce(
		(sum, child) => sum + outerHeight(child),
		0
	);
	const style = getComputedStyle(figure);
	return (
		leadHeight +
			figureContentHeight(figure) +
			parseFloat(style.marginTop || '0') +
			parseFloat(style.marginBottom || '0') <=
		bounds.height - TOLERANCE_PX
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
function hasBodyContentBefore(rendered, node, offset) {
	const range = document.createRange();
	range.setStart(rendered, 0);
	if (typeof offset === 'number') {
		range.setEnd(node, offset);
	} else {
		range.setEndBefore(node);
	}
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
 * Heading + intro wrapper kept with the figure by chart-reflow.
 *
 * @param {Element} figure Figure node.
 * @return {Element|null} Lead element, or null.
 */
function leadFor(figure) {
	const prev = figure.previousElementSibling;
	return prev && prev.classList.contains('print-engine-chart-unit__lead')
		? prev
		: null;
}

let registered = false;

/**
 * Register the guard with Paged.js once, before the Previewer runs.
 */
export function registerFloatGuard() {
	if (registered) {
		return;
	}
	registered = true;
	registerHandlers(FloatOverflowGuard);
}
