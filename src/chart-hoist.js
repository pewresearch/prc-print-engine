/* eslint-env browser */
/**
 * Moving a chart up in its section (page-fill rule: a chart that does not
 * fit below its intro may move up by at most MAX_CHART_DELAY, so the intro
 * and following text wrap beside it), and the measurements that decide it.
 */

/**
 * Internal Dependencies
 */
import {
	DELAYED_ATTR,
	FLOATED_ATTR,
	HOISTED_ATTR,
	REVERTED_ATTR,
} from './chart-delay';
import { isPrintChartFigure } from './chart-reflow';
import { figureContentHeight } from './figure-measure';
import { maxChartHoistPx } from './page-fill';
import {
	contentBottomBefore,
	hasBodyContentBefore,
	outerHeight,
	precedes,
	TOLERANCE_PX,
} from './page-measure';

const LEAD_CLASS = 'print-engine-chart-unit__lead';

/**
 * A centered sized chart no wider than 420px: in print it may float right
 * like a companion chart when that keeps it with its intro.
 *
 * @param {Element} figure Figure node.
 * @return {boolean} True for a stacked companion-width chart.
 */
export function isStackedCompanion(figure) {
	if (!isPrintChartFigure(figure) || figure.hasAttribute(FLOATED_ATTR)) {
		return false;
	}
	return ['size-200-wide', 'size-310-wide', 'size-420-wide'].some((slug) =>
		figure.classList.contains(slug)
	);
}

/**
 * First child of a lead that is not a heading (its intro text), or null.
 *
 * @param {Element|null} lead Lead wrapper.
 * @return {Element|null} Intro element.
 */
export function firstNonHeadingChild(lead) {
	if (!lead) {
		return null;
	}
	return (
		Array.from(lead.children).find(
			(child) => !/^H[1-6]$/.test(child.tagName)
		) || null
	);
}

/**
 * Whether a lead and its chart fit on an empty page with the intro text
 * wrapping beside the chart (the chart placed right after the headings).
 *
 * @param {Element} lead   Lead wrapper.
 * @param {Element} figure Floated figure.
 * @param {DOMRect} bounds Page content area.
 * @return {boolean} True when headings plus chart fit in the page height.
 */
export function fitsOnePageHoisted(lead, figure, bounds) {
	const headings = Array.from(lead.children).filter((child) =>
		/^H[1-6]$/.test(child.tagName)
	);
	const headingHeight = headings.reduce(
		(sum, child) => sum + outerHeight(child),
		0
	);
	const style = getComputedStyle(figure);
	return (
		headingHeight +
			figureContentHeight(figure) +
			parseFloat(style.marginBottom || '0') <=
		bounds.height - TOLERANCE_PX
	);
}

/**
 * Whether a block opens a section (an H2, H3 or H4, or a wrapper that opens
 * with one).
 *
 * @param {Element} el Block.
 * @return {boolean} True for a section start.
 */
export function opensSection(el) {
	let node = el;
	while (node && !/^H[1-6]$/.test(node.tagName)) {
		node = node.firstElementChild;
	}
	return Boolean(node && /^H[234]$/.test(node.tagName));
}

/**
 * Where a chart that does not fit below its intro could move up to on this
 * page: in front of an earlier block of its section, at most
 * MAX_CHART_DELAY above where it sits now, so the text from there on wraps
 * beside it. Never above its section heading, a block that started on an
 * earlier page, or another chart.
 *
 * @param {Element} figure   Floated chart.
 * @param {Element} rendered Page content wrapper.
 * @param {DOMRect} bounds   Page content area.
 * @return {{before: Element, distance: number}|null} Target, or null.
 */
export function hoistTarget(figure, rendered, bounds) {
	if (
		!isPrintChartFigure(figure) ||
		figure.hasAttribute(HOISTED_ATTR) ||
		figure.hasAttribute(DELAYED_ATTR) ||
		figure.hasAttribute(REVERTED_ATTR)
	) {
		return null;
	}
	const style = getComputedStyle(figure);
	const chartHeight =
		figureContentHeight(figure) + parseFloat(style.marginBottom || '0');
	const natural = contentBottomBefore(figure, rendered, bounds);
	const limit = maxChartHoistPx(bounds.height);
	const fits = (candidate) => {
		const rect = Array.from(candidate.getClientRects()).find(
			(r) => r.height > 0
		);
		if (!rect || rect.left > bounds.right || rect.top < bounds.top - 1) {
			return null;
		}
		const distance = natural - rect.top;
		if (distance > limit) {
			return false;
		}
		// Only headings above: the page-top rule drops the chart's top margin.
		const marginTop = hasBodyContentBefore(rendered, candidate)
			? parseFloat(style.marginTop || '0')
			: 0;
		const top = Math.max(rect.top, floatBottomBefore(candidate, rendered));
		return top + marginTop + chartHeight <= bounds.bottom - TOLERANCE_PX
			? distance
			: null;
	};
	for (
		let prev = figure.previousElementSibling;
		prev;
		prev = prev.previousElementSibling
	) {
		if (
			prev.hasAttribute('data-split-from') ||
			isPrintChartFigure(prev) ||
			prev.querySelector('figure')
		) {
			return null;
		}
		const sectionStart = opensSection(prev);
		// A lead that opens the section: the chart goes after its headings.
		const candidate = sectionStart
			? prev.classList.contains(LEAD_CLASS) && firstNonHeadingChild(prev)
			: prev;
		if (candidate) {
			const distance = fits(candidate);
			if (false === distance) {
				return null;
			}
			if (null !== distance) {
				return { before: candidate, distance };
			}
		}
		if (sectionStart) {
			return null;
		}
	}
	return null;
}

/**
 * Lowest bottom of floats before a node on the page (charts clear earlier
 * floats, so a moved chart starts below them).
 *
 * @param {Element} node     Node.
 * @param {Element} rendered Page content wrapper.
 * @return {number} Viewport y coordinate, or -Infinity.
 */
export function floatBottomBefore(node, rendered) {
	let bottom = -Infinity;
	for (const figure of rendered.querySelectorAll('figure')) {
		if (
			precedes(node, figure) &&
			getComputedStyle(figure).float !== 'none'
		) {
			const rect = figure.getBoundingClientRect();
			bottom = Math.max(
				bottom,
				rect.bottom +
					parseFloat(getComputedStyle(figure).marginBottom || '0')
			);
		}
	}
	return bottom;
}
