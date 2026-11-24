/* eslint-env browser */
/**
 * Center a chart that is the only content on its page.
 *
 * After the last pass, a chart with no text or other media beside or below
 * it on its page is centered horizontally instead of sitting at the right
 * edge with an empty column beside it. Only its horizontal position
 * changes, so the chart keeps its size and the page breaks stay as laid
 * out.
 */

export const LONE_CHART_CLASS = 'print-engine-figure--alone';

const MEDIA = 'img, svg, table, hr, iframe, video';

/**
 * Whether a node lies in the first column of the page (Paged.js pushes
 * overflow into later columns to the right).
 *
 * @param {Element} el     Element.
 * @param {DOMRect} bounds Page content area.
 * @return {boolean} True when part of it shows on the page.
 */
function onPage(el, bounds) {
	return Array.from(el.getClientRects()).some(
		(rect) =>
			rect.height > 0 && rect.width > 0 && rect.left < bounds.right - 1
	);
}

/**
 * The one chart figure on a page with no other content, if any.
 *
 * @param {Element} area Page content area (`.pagedjs_page_content`).
 * @return {Element|null} Figure, or null.
 */
export function loneChartOn(area) {
	const bounds = area.getBoundingClientRect();
	const figures = Array.from(area.querySelectorAll('figure')).filter(
		(figure) => figure.querySelector('img, svg') && onPage(figure, bounds)
	);
	if (figures.length !== 1) {
		return null;
	}
	const [figure] = figures;
	const walker = area.ownerDocument.createTreeWalker(
		area,
		NodeFilter.SHOW_TEXT
	);
	for (let text = walker.nextNode(); text; text = walker.nextNode()) {
		if (
			text.textContent.trim() &&
			!figure.contains(text) &&
			text.parentElement &&
			onPage(text.parentElement, bounds)
		) {
			return null;
		}
	}
	const otherMedia = Array.from(area.querySelectorAll(MEDIA)).some(
		(el) => !figure.contains(el) && onPage(el, bounds)
	);
	return otherMedia ? null : figure;
}

/**
 * Center each chart that is alone on its page.
 *
 * @param {HTMLElement} mountEl Preview mount element of the last pass.
 * @return {number} Charts centered.
 */
export function centerLoneCharts(mountEl) {
	let centered = 0;
	mountEl.querySelectorAll('.pagedjs_page_content').forEach((area) => {
		const figure = loneChartOn(area);
		if (figure) {
			figure.classList.add(LONE_CHART_CLASS);
			centered += 1;
		}
	});
	return centered;
}
