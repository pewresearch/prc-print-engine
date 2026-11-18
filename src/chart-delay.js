/* eslint-env browser */
/**
 * Delayed charts: between pagination passes, move a chart the float guard
 * delayed so the next pass opens a page with it.
 *
 * Paged.js checks overflow right after it adds a float, before the text
 * that follows the chart is on the page, so the guard cannot measure that
 * text. The finished pass can: the intro's page shows how much room is left
 * below the intro, and each following block shows its height. The chart
 * moves after the last block that fits in that room and in MAX_CHART_DELAY,
 * without leaving its section or passing the next chart or intro.
 */

/**
 * Internal Dependencies
 */
import { isPrintChartFigure } from './chart-reflow';
import {
	decideStuckFallback,
	maxChartDelayPx,
	shouldRevertDelay,
} from './page-fill';
import { recordDecisionById } from './page-fill-log';
import { contentBottomOf, pageFill } from './page-measure';

export const DELAYED_ATTR = 'data-print-delayed';
export const REVERTED_ATTR = 'data-print-delay-reverted';
export const STUCK_BREAK_ATTR = 'data-print-stuck-break';
const DELAY_LEAD_ATTR = 'data-print-delay-lead';
const STUCK_ATTR = 'data-print-delay-stuck';
// An intro this close to the top of its page opens the page.
const OPENS_PAGE_SHARE = 0.1;

const LEAD_CLASS = 'print-engine-chart-unit__lead';

/**
 * Whether a delayed chart must stay before a block: the block opens a new
 * section, or belongs to another chart.
 *
 * @param {Element} el     Block after the chart in the source.
 * @param {Element} figure The delayed chart.
 * @return {boolean} True when the delay stops before `el`.
 */
export function delayStopsAt(el, figure) {
	if (el.matches('h1, h2, h3, h4')) {
		return true;
	}
	const section = figure.getAttribute('data-print-section');
	if (section && el.getAttribute('data-print-section') !== section) {
		return true;
	}
	if (el.classList.contains(LEAD_CLASS) || isPrintChartFigure(el)) {
		return true;
	}
	return Boolean(
		el.querySelector(
			'h1, h2, h3, h4, figure.print-engine-chart, figure[class*="size-"]'
		)
	);
}

/**
 * Estimated height of a block at full column width, with margins.
 *
 * After a pass the blocks that follow a delayed chart sit beside it on the
 * next page, in shortened lines. Scale each fragment by how much of its
 * width the lines use, so the estimate matches the full-width room below
 * the intro.
 *
 * @param {HTMLElement} mountEl Preview mount.
 * @param {string}      id      data-print-node id.
 * @return {number} Height in px.
 */
function fullWidthHeight(mountEl, id) {
	const parts = Array.from(
		mountEl.querySelectorAll(`.pagedjs_page [data-print-node="${id}"]`)
	);
	if (!parts.length) {
		return Infinity;
	}
	const range = document.createRange();
	const height = parts.reduce((sum, el) => {
		const box = el.getBoundingClientRect();
		range.selectNodeContents(el);
		const lines = Array.from(range.getClientRects()).filter(
			(rect) => rect.width > 0 && rect.height > 0
		);
		if (
			!lines.length ||
			box.width <= 0 ||
			el.querySelector('img, svg, table')
		) {
			return sum + box.height;
		}
		const left = Math.min(...lines.map((rect) => rect.left));
		const right = Math.max(...lines.map((rect) => rect.right));
		const used = Math.min(Math.max((right - left) / box.width, 0.3), 1);
		return sum + box.height * used;
	}, 0);
	const first = getComputedStyle(parts[0]);
	const last = getComputedStyle(parts[parts.length - 1]);
	return (
		height +
		parseFloat(first.marginTop || '0') +
		parseFloat(last.marginBottom || '0')
	);
}

/**
 * Room below an intro on the page where it ended, in px.
 *
 * @param {HTMLElement} mountEl Preview mount.
 * @param {string}      leadId  data-print-node id of the intro.
 * @return {{room: number, filled: number, pageHeight: number, bottom: number}|null} Room, or null.
 */
function roomBelowLead(mountEl, leadId) {
	const parts = Array.from(
		mountEl.querySelectorAll(`.pagedjs_page [data-print-node="${leadId}"]`)
	);
	const last = parts[parts.length - 1];
	const area = last
		?.closest('.pagedjs_page')
		?.querySelector('.pagedjs_page_content');
	if (!area) {
		return null;
	}
	const bounds = area.getBoundingClientRect();
	const bottom = contentBottomOf(last, bounds);
	if (null === bottom) {
		return null;
	}
	return {
		room: bounds.bottom - bottom,
		filled: bottom - bounds.top,
		pageHeight: bounds.height,
		bottom,
	};
}

/**
 * Move each delayed chart after the blocks that fit below its intro.
 *
 * @param {string}                                        html     Content HTML of the finished pass.
 * @param {HTMLElement}                                   mountEl  Preview mount with that pass's pages.
 * @param {Map<string, {leadId: string, stuck: boolean}>} requests Delay requests by figure id.
 * @return {{html: string, decisions: Map<string, string>}} Next pass HTML and labels.
 */
export function planChartDelays(html, mountEl, requests) {
	const template = document.createElement('template');
	template.innerHTML = html;
	const decisions = new Map();
	requests.forEach(({ leadId, stuck }, figureId) => {
		const figure = template.content.querySelector(
			`[data-print-node="${figureId}"]`
		);
		const space = roomBelowLead(mountEl, leadId);
		if (!figure || !space || figure.hasAttribute(DELAYED_ATTR)) {
			return;
		}
		const limit = Math.min(space.room, maxChartDelayPx(space.pageHeight));
		let used = 0;
		let after = null;
		let sectionEnd = false;
		for (
			let el = figure.nextElementSibling;
			el;
			el = el.nextElementSibling
		) {
			if (delayStopsAt(el, figure)) {
				sectionEnd = !el.classList.contains(LEAD_CLASS);
				break;
			}
			const height = fullWidthHeight(
				mountEl,
				el.getAttribute('data-print-node')
			);
			if (used + height > limit) {
				break;
			}
			used += height;
			after = el;
		}
		if (!after) {
			if (stuck) {
				planStuckFallback(template, figure, leadId, space, decisions);
			}
			return;
		}
		after.after(figure);
		const label = `delay:${Math.round(used)}px${
			sectionEnd ? ':section-end' : ''
		}${stuck ? ':stuck' : ''}`;
		figure.setAttribute(DELAYED_ATTR, 'true');
		figure.setAttribute(DELAY_LEAD_ATTR, leadId);
		if (stuck) {
			figure.setAttribute(STUCK_ATTR, 'true');
		}
		figure.setAttribute('data-print-fill-decision', label);
		decisions.set(figureId, label);
	});
	return { html: decisions.size ? template.innerHTML : html, decisions };
}

/**
 * A chart first on its page that could not be delayed: break before it when
 * the page above stays half full or ends a section (the next pass applies
 * STUCK_BREAK_ATTR); otherwise keep the float guard's unfloated, at most 5%
 * shrunk layout from this pass.
 *
 * @param {DocumentFragment} template  Next pass source.
 * @param {Element}          figure    Chart in that source.
 * @param {string}           leadId    data-print-node id of the block above.
 * @param {Object}           space     roomBelowLead() result.
 * @param {Map}              decisions Labels by figure id, updated here.
 */
function planStuckFallback(template, figure, leadId, space, decisions) {
	if (figure.hasAttribute(STUCK_BREAK_ATTR)) {
		return;
	}
	const lead = template.content.querySelector(
		`[data-print-node="${leadId}"]`
	);
	const decision = decideStuckFallback({
		filledAbove: space.filled,
		pageHeight: space.pageHeight,
		endsSection:
			Boolean(lead) &&
			lead.getAttribute('data-print-section') !==
				figure.getAttribute('data-print-section'),
	});
	if ('break-before' !== decision) {
		return;
	}
	figure.setAttribute(STUCK_BREAK_ATTR, 'true');
	figure.setAttribute('data-print-fill-decision', 'stuck:break-before');
	recordDecisionById(
		figure.getAttribute('data-print-node'),
		'stuck:break-before'
	);
	decisions.set(figure.getAttribute('data-print-node'), 'stuck:break-before');
}

/**
 * Undo a delay that left its intro's page under MIN_PAGE_FILL with the intro
 * at the top of that page. That happens when an earlier delay moved the
 * intro to a new page and the chart now fits under its intro with at most a
 * 5% shrink, where it was. Also undo a delay whose chart still ended on its
 * intro's page: an earlier pass changed the layout above, and the delay now
 * only separates intro and chart. A delay made because the chart was already
 * first on its page stays.
 *
 * @param {string}      html    Content HTML of the finished pass.
 * @param {HTMLElement} mountEl Preview mount with that pass's pages.
 * @return {{html: string, reverted: number}} Next pass HTML and count.
 */
export function revertFailedDelays(html, mountEl) {
	const template = document.createElement('template');
	template.innerHTML = html;
	let reverted = 0;
	template.content
		.querySelectorAll(
			`[${DELAYED_ATTR}][${DELAY_LEAD_ATTR}]:not([${STUCK_ATTR}])`
		)
		.forEach((figure) => {
			const leadId = figure.getAttribute(DELAY_LEAD_ATTR);
			const lead = template.content.querySelector(
				`[data-print-node="${leadId}"]`
			);
			const rendered = mountEl.querySelector(
				`.pagedjs_page [data-print-node="${leadId}"]`
			);
			const pageEl = rendered?.closest('.pagedjs_page');
			const area = pageEl?.querySelector('.pagedjs_page_content');
			if (!lead || !area) {
				return;
			}
			const bounds = area.getBoundingClientRect();
			const space = roomBelowLead(mountEl, leadId);
			const chart = renderedChartHeight(
				mountEl,
				figure.getAttribute('data-print-node')
			);
			const figurePage = mountEl
				.querySelector(
					`.pagedjs_page [data-print-node="${figure.getAttribute(
						'data-print-node'
					)}"]`
				)
				?.closest('.pagedjs_page');
			// A delay that did not move the chart off its intro's page only
			// separated them.
			const samePage = figurePage === pageEl;
			const revert =
				samePage ||
				(space &&
					chart &&
					shouldRevertDelay({
						opensPage:
							rendered.getBoundingClientRect().top - bounds.top <=
							bounds.height * OPENS_PAGE_SHARE,
						pageFill: pageFill(pageEl),
						roomBelowIntro: space.room,
						chartHeight: chart.height,
						chartMargins: chart.margins,
					}));
			if (!revert) {
				return;
			}
			lead.after(figure);
			figure.removeAttribute(DELAYED_ATTR);
			figure.removeAttribute(DELAY_LEAD_ATTR);
			figure.setAttribute(REVERTED_ATTR, 'true');
			figure.setAttribute('data-print-fill-decision', 'delay-reverted');
			reverted += 1;
		});
	return { html: reverted ? template.innerHTML : html, reverted };
}

/**
 * A rendered chart's content height (image and caption) and its margins.
 *
 * @param {HTMLElement} mountEl Preview mount.
 * @param {string}      id      data-print-node id of the figure.
 * @return {{height: number, margins: number}|null} Size, or null.
 */
function renderedChartHeight(mountEl, id) {
	const figure = mountEl.querySelector(
		`.pagedjs_page [data-print-node="${id}"]`
	);
	if (!figure) {
		return null;
	}
	const style = getComputedStyle(figure);
	return {
		height: figure.getBoundingClientRect().height,
		margins:
			parseFloat(style.marginTop || '0') +
			parseFloat(style.marginBottom || '0'),
	};
}
