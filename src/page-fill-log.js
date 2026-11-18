/* eslint-env browser */
/**
 * Page-fill decisions recorded during pagination.
 *
 * Handlers record decisions by `data-print-node` id, because the clones they
 * see are discarded when Paged.js lays a page out again. After the last pass,
 * view.js stamps each decision on the rendered nodes as
 * `data-print-fill-decision` so QA and tests can read them, and logs each
 * one to the console at debug level.
 */

const decisions = new Map();
const delays = new Map();

/**
 * Forget every decision and delay request (start of a pass).
 */
export function resetPageFillLog() {
	decisions.clear();
	delays.clear();
}

/**
 * Record a decision for a node. The last decision for a node wins.
 *
 * @param {Element} node     Rendered node with a data-print-node id.
 * @param {string}  decision Decision label, e.g. `shrink:0.970`.
 */
export function recordDecision(node, decision) {
	const id = node?.getAttribute?.('data-print-node');
	if (id) {
		decisions.set(id, decision);
	}
}

/**
 * Record a decision by data-print-node id (between passes, no node at hand).
 *
 * @param {string} id       data-print-node id.
 * @param {string} decision Decision label.
 */
export function recordDecisionById(id, decision) {
	if (id) {
		decisions.set(id, decision);
	}
}

/**
 * Ask for the chart to open the next page after its intro. chart-delay.js
 * picks how much of the following text stays with the intro once the pass
 * ends.
 *
 * @param {Element} figure        Chart figure.
 * @param {Element} lead          Its intro.
 * @param {Object}  [options]     Options.
 * @param {boolean} options.stuck Whether the chart was first on its page.
 */
export function requestDelay(figure, lead, { stuck = false } = {}) {
	const figureId = figure.getAttribute('data-print-node');
	const leadId = lead.getAttribute('data-print-node');
	if (figureId && leadId) {
		delays.set(figureId, { leadId, stuck });
	}
	recordDecision(figure, stuck ? 'stuck:delay:0px' : 'delay:0px');
}

/**
 * @return {Map<string, {leadId: string, stuck: boolean}>} Delay requests by figure id.
 */
export function getDelayRequests() {
	return new Map(delays);
}

/**
 * @return {Map<string, string>} Decisions by data-print-node id.
 */
export function getDecisions() {
	return new Map(decisions);
}
