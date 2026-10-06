/* eslint-env browser */
/**
 * Paged.js handler: a chart figure that comes before the first paragraph on
 * its page drops its top margin, so it lines up with the copy beside it.
 * Headings (and heading-only lead wrappers) may come before it.
 *
 * Runs after each page is laid out. Removing a top margin only shortens the
 * page content, so pagination and TOC page numbers stay as Paged.js set them.
 */

/**
 * External Dependencies
 */
import { Handler, registerHandlers } from 'pagedjs';

/**
 * Internal Dependencies
 */
import { isPrintChartFigure, PRINT_HEADING_SELECTOR } from './chart-reflow';

const PAGE_TOP_CLASS = 'print-engine-figure--page-top';
const LEAD_CLASS = 'print-engine-chart-unit__lead';

/**
 * @param {Element} el Node.
 * @return {boolean} True for a heading, the title header, or a lead wrapper of
 *                   only headings.
 */
function isHeadingOnly(el) {
	if (el.matches(PRINT_HEADING_SELECTOR)) {
		return true;
	}
	return (
		el.classList.contains(LEAD_CLASS) &&
		Array.from(el.children).every(isHeadingOnly)
	);
}

/**
 * @param {Element} figure Chart figure.
 * @param {Element} root   Page content area.
 * @return {boolean} True when only headings come before the figure on the page.
 */
function opensPage(figure, root) {
	for (let el = figure; el && el !== root; el = el.parentElement) {
		for (
			let prev = el.previousElementSibling;
			prev;
			prev = prev.previousElementSibling
		) {
			if (!isHeadingOnly(prev)) {
				return false;
			}
		}
	}
	return true;
}

class PageTopFigures extends Handler {
	afterPageLayout(pageElement) {
		const root = pageElement.querySelector('.pagedjs_page_content');
		if (!root) {
			return;
		}
		root.querySelectorAll('figure').forEach((figure) => {
			if (isPrintChartFigure(figure) && opensPage(figure, root)) {
				figure.classList.add(PAGE_TOP_CLASS);
			}
		});
	}
}

let registered = false;

/**
 * Register the handler once, before the Previewer starts.
 */
export function registerPageTopFigures() {
	if (registered) {
		return;
	}
	registered = true;
	registerHandlers(PageTopFigures);
}
