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
import { FLOAT_LEAD_CLASS, isPrintChartFigure } from './chart-reflow';
import {
	decideStuckFallback,
	keepsPageFilled,
	maxChartDelayPx,
	needsFillDelay,
	shouldRevertDelay,
} from './page-fill';
import { recordDecisionById } from './page-fill-log';
import { contentBottomOf, pageFill } from './page-measure';

export const DELAYED_ATTR = 'data-print-delayed';
export const REVERTED_ATTR = 'data-print-delay-reverted';
export const STUCK_BREAK_ATTR = 'data-print-stuck-break';
export const HOISTED_ATTR = 'data-print-hoisted';
export const FLOATED_ATTR = 'data-print-floated';
const REPLANNED_ATTR = 'data-print-delay-replanned';
const DELAY_LEAD_ATTR = 'data-print-delay-lead';
const STUCK_ATTR = 'data-print-delay-stuck';
// A delay taken after the chart failed to fit under its intro, even shrunk:
// undoing it because it would fit there (shouldRevertDelay()) would loop.
const FIT_TRIED_ATTR = 'data-print-delay-fit-tried';
// An H5 or H6 a delay stopped at clears the chart above it, so the chart
// does not read as part of that subsection (print.scss).
export const SUBHEADING_CLEAR_CLASS = 'print-engine-subheading--clear';
const CLEARS_FOR_ATTR = 'data-print-clears-for';
// A chart whose delay was undone and that then took a fill delay (once).
export const FILL_USED_ATTR = 'data-print-delay-fill-used';
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
 * The blocks after a chart that fit in `limit` px, within its section. An
 * H5 or H6 also ends the run, so the chart never lands under another
 * subheading.
 *
 * @param {Element}     figure  Chart in the next pass source.
 * @param {HTMLElement} mountEl Preview mount with the finished pass.
 * @param {number}      limit   Most text to keep before the chart in px.
 * @return {{after: Element|null, used: number, sectionEnd: boolean, subheading: boolean}} Last block kept, their total height, whether the section ends there, and whether a subheading ended the run.
 */
function blocksWithin(figure, mountEl, limit) {
	let used = 0;
	let after = null;
	let sectionEnd = false;
	let subheading = false;
	for (let el = figure.nextElementSibling; el; el = el.nextElementSibling) {
		if (delayStopsAt(el, figure)) {
			sectionEnd = !el.classList.contains(LEAD_CLASS);
			break;
		}
		if (el.matches('h5, h6, :has(h5, h6)')) {
			subheading = true;
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
	return { after, used, sectionEnd, subheading };
}

/**
 * Make the H5 or H6 right after a delayed chart clear it.
 *
 * @param {Element} figure Delayed chart in the next pass source.
 */
function clearSubheadingAfter(figure) {
	const next = figure.nextElementSibling;
	const heading = next?.matches('h5, h6')
		? next
		: next?.querySelector(':scope > h5, :scope > h6');
	if (heading) {
		heading.classList.add(SUBHEADING_CLEAR_CLASS);
		heading.setAttribute(
			CLEARS_FOR_ATTR,
			figure.getAttribute('data-print-node')
		);
	}
}

/**
 * Undo clearSubheadingAfter() when a delay is undone or planned again.
 *
 * @param {DocumentFragment} root   Next pass source.
 * @param {Element}          figure Chart that moves back after its intro.
 */
function releaseSubheading(root, figure) {
	root.querySelectorAll(
		`[${CLEARS_FOR_ATTR}="${figure.getAttribute('data-print-node')}"]`
	).forEach((heading) => {
		heading.classList.remove(SUBHEADING_CLEAR_CLASS);
		heading.removeAttribute(CLEARS_FOR_ATTR);
	});
}

/**
 * Whether a fill-only request (a chart whose delay was undone) may apply:
 * the plan fills the intro's page to MIN_PAGE_FILL and the chart has not
 * used its one fill delay.
 *
 * @param {Element} figure Chart in the next pass source.
 * @param {Object}  plan   blocksWithin() result.
 * @param {boolean} fill   Whether the plan is a fill delay.
 * @param {Object}  space  roomBelowLead() result.
 * @return {boolean} True when the fill delay applies.
 */
function fillOnlyApplies(figure, plan, fill, space) {
	return (
		fill &&
		!figure.hasAttribute(FILL_USED_ATTR) &&
		keepsPageFilled(space.filled + plan.used, space.pageHeight)
	);
}

/**
 * Delay requests sorted by their chart's position in the source.
 *
 * @param {HTMLTemplateElement} template Next pass source.
 * @param {Map}                 requests Delay requests by figure id.
 * @return {Array<[string, Object]>} Entries in document order.
 */
function byDocumentOrder(template, requests) {
	const order = new Map(
		Array.from(template.content.querySelectorAll('[data-print-node]')).map(
			(el, index) => [el.getAttribute('data-print-node'), index]
		)
	);
	return Array.from(requests).sort(
		([a], [b]) => (order.get(a) ?? Infinity) - (order.get(b) ?? Infinity)
	);
}

/**
 * Move each delayed chart after the blocks that fit below its intro: up to
 * MAX_CHART_DELAY, or the whole room on the intro's page when that limit
 * would leave the page under MIN_PAGE_FILL (`:fill`; `:subheading` when an
 * H5 or H6 stops it short of half full). A chart whose delay
 * was undone may only take a fill delay that keeps its intro's page half
 * full, once.
 *
 * @param {string}                                                                              html     Content HTML of the finished pass.
 * @param {HTMLElement}                                                                         mountEl  Preview mount with that pass's pages.
 * @param {Map<string, {leadId: string, stuck: boolean, fitTried: boolean, fillOnly: boolean}>} requests Delay requests by figure id.
 * @return {{html: string, decisions: Map<string, string>}} Next pass HTML and labels.
 */
export function planChartDelays(html, mountEl, requests) {
	const template = document.createElement('template');
	template.innerHTML = html;
	const decisions = new Map();
	// A delay reflows the pages right after it, so a later chart may only
	// fill its intro's page when that page starts at least two pages after
	// the last chart delayed in this pass; nearer ones measure a layout that
	// is about to change.
	const pages = Array.from(mountEl.querySelectorAll('.pagedjs_page'));
	const pageIndexOf = (id) =>
		pages.indexOf(
			mountEl
				.querySelector(`.pagedjs_page [data-print-node="${id}"]`)
				?.closest('.pagedjs_page')
		);
	let lastDelayedPage = -Infinity;
	byDocumentOrder(template, requests).forEach(([figureId, request]) => {
		const { leadId, stuck, fitTried, fillOnly } = request;
		const figure = template.content.querySelector(
			`[data-print-node="${figureId}"]`
		);
		const space = roomBelowLead(mountEl, leadId);
		if (!figure || !space || figure.hasAttribute(DELAYED_ATTR)) {
			return;
		}
		let plan = blocksWithin(
			figure,
			mountEl,
			Math.min(space.room, maxChartDelayPx(space.pageHeight))
		);
		let fill = false;
		let subheading = false;
		// The fill extends a one-third delay; it never creates one where no
		// block fits in that limit (the chart then keeps its other options).
		if (
			plan.after &&
			pageIndexOf(leadId) > lastDelayedPage + 1 &&
			needsFillDelay({
				filled: space.filled,
				used: plan.used,
				pageHeight: space.pageHeight,
			})
		) {
			const full = blocksWithin(figure, mountEl, space.room);
			if (full.used > plan.used) {
				plan = full;
				fill = true;
			}
			// An H5 or H6 stopped the fill short of a half-full page.
			subheading =
				full.subheading &&
				!keepsPageFilled(space.filled + plan.used, space.pageHeight);
		}
		if (fillOnly && !fillOnlyApplies(figure, plan, fill, space)) {
			return;
		}
		if (!plan.after) {
			if (stuck) {
				planStuckFallback(template, figure, leadId, space, decisions);
			}
			return;
		}
		plan.after.after(figure);
		clearSubheadingAfter(figure);
		const label = `delay:${Math.round(plan.used)}px${
			plan.sectionEnd ? ':section-end' : ''
		}${stuck ? ':stuck' : ''}${fill ? ':fill' : ''}${
			subheading ? ':subheading' : ''
		}`;
		figure.setAttribute(DELAYED_ATTR, 'true');
		figure.setAttribute(DELAY_LEAD_ATTR, leadId);
		if (stuck) {
			figure.setAttribute(STUCK_ATTR, 'true');
		}
		if (fitTried) {
			figure.setAttribute(FIT_TRIED_ATTR, 'true');
		}
		if (fillOnly) {
			figure.setAttribute(FILL_USED_ATTR, 'true');
		}
		figure.setAttribute('data-print-fill-decision', label);
		decisions.set(figureId, label);
		lastDelayedPage = Math.max(
			pageIndexOf(leadId) + 1,
			pageIndexOf(figureId)
		);
	});
	return { html: decisions.size ? template.innerHTML : html, decisions };
}

/**
 * A chart first on its page that could not be delayed: break before it when
 * the page above stays half full or ends a section (the next pass applies
 * STUCK_BREAK_ATTR); otherwise keep the float guard's unfloated, at most 7%
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
 * 7% shrink, where it was. Also undo a delay whose chart still ended on its
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
	const pages = Array.from(mountEl.querySelectorAll('.pagedjs_page'));
	const pageOf = (id) =>
		mountEl
			.querySelector(`.pagedjs_page [data-print-node="${id}"]`)
			?.closest('.pagedjs_page');
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
			const pageEl = pageOf(leadId);
			const area = pageEl?.querySelector('.pagedjs_page_content');
			if (!lead || !area) {
				return;
			}
			const figurePage = pageOf(figure.getAttribute('data-print-node'));
			// A delay planned on an older layout can leave the chart two pages
			// after its intro: undo it so the next pass plans again on the
			// current layout (once; after that it stays undone).
			const stale =
				Boolean(figurePage) &&
				pages.indexOf(figurePage) - pages.indexOf(pageEl) > 1;
			if (stale && !figure.hasAttribute(REPLANNED_ATTR)) {
				lead.after(figure);
				releaseSubheading(template.content, figure);
				figure.removeAttribute(DELAYED_ATTR);
				figure.removeAttribute(DELAY_LEAD_ATTR);
				figure.removeAttribute(FIT_TRIED_ATTR);
				figure.setAttribute(REPLANNED_ATTR, 'true');
				figure.setAttribute(
					'data-print-fill-decision',
					'delay-replanned'
				);
				reverted += 1;
				return;
			}
			// A delay that did not move the chart off its intro's page only
			// separated them.
			if (
				!stale &&
				figurePage !== pageEl &&
				(figure.hasAttribute(FIT_TRIED_ATTR) ||
					!failedDelay(mountEl, figure, leadId, area))
			) {
				return;
			}
			lead.after(figure);
			releaseSubheading(template.content, figure);
			figure.removeAttribute(DELAYED_ATTR);
			figure.removeAttribute(DELAY_LEAD_ATTR);
			figure.removeAttribute(FIT_TRIED_ATTR);
			figure.setAttribute(REVERTED_ATTR, 'true');
			figure.setAttribute('data-print-fill-decision', 'delay-reverted');
			reverted += 1;
		});
	return { html: reverted ? template.innerHTML : html, reverted };
}

/**
 * Whether a delay left its intro at the top of an under-half-full page while
 * the chart would fit under it (see shouldRevertDelay()).
 *
 * @param {HTMLElement} mountEl Preview mount.
 * @param {Element}     figure  Delayed chart in the next pass source.
 * @param {string}      leadId  data-print-node id of its intro.
 * @param {Element}     area    Content area of the intro's page.
 * @return {boolean} True to undo the delay.
 */
function failedDelay(mountEl, figure, leadId, area) {
	const space = roomBelowLead(mountEl, leadId);
	const chart = renderedChartHeight(
		mountEl,
		figure.getAttribute('data-print-node')
	);
	if (!space || !chart) {
		return false;
	}
	const bounds = area.getBoundingClientRect();
	const intro = mountEl.querySelector(
		`.pagedjs_page [data-print-node="${leadId}"]`
	);
	return shouldRevertDelay({
		opensPage:
			intro.getBoundingClientRect().top - bounds.top <=
			bounds.height * OPENS_PAGE_SHARE,
		pageFill: pageFill(area.closest('.pagedjs_page')),
		roomBelowIntro: space.room,
		chartHeight: chart.height,
		imageHeight: chart.imageHeight,
		chartMargins: chart.margins,
	});
}

/**
 * A rendered chart's content height (image and caption), its image height
 * and its margins.
 *
 * @param {HTMLElement} mountEl Preview mount.
 * @param {string}      id      data-print-node id of the figure.
 * @return {{height: number, imageHeight: number, margins: number}|null} Size, or null.
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
		imageHeight:
			figure.querySelector('img')?.getBoundingClientRect().height || 0,
		margins:
			parseFloat(style.marginTop || '0') +
			parseFloat(style.marginBottom || '0'),
	};
}

/**
 * Apply hoists (move a chart up in its section, in front of a block) and
 * floats (a centered companion-width chart floats right) from a pass.
 *
 * @param {string}                                         html   Content HTML of the finished pass.
 * @param {Map<string, {beforeId: string, label: string}>} hoists Hoist requests by figure id.
 * @param {Set<string>}                                    floats Figure ids to float.
 * @return {{html: string, changed: number}} Next pass HTML and count.
 */
export function applyHoistsAndFloats(html, hoists, floats) {
	if (!hoists.size && !floats.size) {
		return { html, changed: 0 };
	}
	const template = document.createElement('template');
	template.innerHTML = html;
	const byId = (id) =>
		template.content.querySelector(`[data-print-node="${id}"]`);
	let changed = 0;
	floats.forEach((figureId) => {
		const figure = byId(figureId);
		if (!figure || figure.hasAttribute(FLOATED_ATTR)) {
			return;
		}
		figure.classList.remove('aligncenter', 'print-engine-chart--stack');
		figure.classList.add('alignright');
		figure.setAttribute(FLOATED_ATTR, 'true');
		figure.setAttribute('data-print-fill-decision', 'float');
		const lead = figure.previousElementSibling;
		if (lead?.classList.contains(LEAD_CLASS)) {
			lead.classList.add(FLOAT_LEAD_CLASS);
		}
		changed += 1;
	});
	hoists.forEach(({ beforeId, label }, figureId) => {
		const figure = byId(figureId);
		const before = byId(beforeId);
		if (!figure || !before || figure.hasAttribute(HOISTED_ATTR)) {
			return;
		}
		before.before(figure);
		figure.setAttribute(HOISTED_ATTR, 'true');
		figure.setAttribute('data-print-fill-decision', label);
		changed += 1;
	});
	return { html: changed ? template.innerHTML : html, changed };
}
