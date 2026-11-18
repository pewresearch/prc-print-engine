/* eslint-env browser */
/**
 * Paged.js passes. Paginate once; when the float guard delayed a chart, move
 * it in the source (chart-delay.js) and paginate again. Undo a delay that a
 * later pass left on a page under MIN_PAGE_FILL. Stops when nothing moves or
 * after MAX_EXTRA_PASSES.
 */

/**
 * External Dependencies
 */
import { Previewer } from 'pagedjs';

/**
 * Internal Dependencies
 */
import {
	DELAYED_ATTR,
	planChartDelays,
	revertFailedDelays,
} from './chart-delay';
import {
	getDecisions,
	getDelayRequests,
	resetPageFillLog,
} from './page-fill-log';

// Extra pagination passes allowed for delayed charts and undone delays.
export const MAX_EXTRA_PASSES = 3;

/**
 * Stamp the last pass's decisions on the rendered pages.
 *
 * @param {HTMLElement} mountEl Preview mount element.
 */
export function stampFillDecisions(mountEl) {
	const decisions = getDecisions();
	mountEl.querySelectorAll(`[${DELAYED_ATTR}]`).forEach((node) => {
		decisions.set(
			node.getAttribute('data-print-node'),
			node.getAttribute('data-print-fill-decision')
		);
	});
	if (decisions.size) {
		// eslint-disable-next-line no-console
		console.info(
			`Print engine fill decisions: ${Array.from(decisions)
				.map(([id, decision]) => `node ${id} ${decision}`)
				.join('; ')}`
		);
	}
	getDecisions().forEach((decision, id) => {
		mountEl
			.querySelectorAll(`[data-print-node="${id}"]`)
			.forEach((node) => {
				if (!node.hasAttribute(DELAYED_ATTR)) {
					node.setAttribute('data-print-fill-decision', decision);
				}
			});
	});
}

/**
 * Paginate, then paginate again while the float guard asks to delay charts.
 *
 * @param {string}      html        Prepared content HTML.
 * @param {Array}       stylesheets Paged.js stylesheets.
 * @param {HTMLElement} contentEl   Preview mount element.
 * @return {Promise<{flow: Object, html: string, passes: number}>} Last pass.
 */
export async function paginate(html, stylesheets, contentEl) {
	let source = html;
	for (let pass = 0; ; pass += 1) {
		resetPageFillLog();
		contentEl.innerHTML = '';
		const previewer = new Previewer();
		const flow = await previewer.preview(source, stylesheets, contentEl);
		const delays = getDelayRequests();
		let next = source;
		if (pass < MAX_EXTRA_PASSES) {
			next = revertFailedDelays(next, contentEl).html;
			if (delays.size) {
				next = planChartDelays(next, contentEl, delays).html;
			}
		}
		if (next === source) {
			return { flow, html: source, passes: pass + 1 };
		}
		source = next;
		previewer.polisher.destroy();
		previewer.chunker.destroy();
	}
}
