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
const hoists = new Map();
const floats = new Set();

/**
 * Forget every decision and delay request (start of a pass).
 */
export function resetPageFillLog() {
	decisions.clear();
	delays.clear();
	hoists.clear();
	floats.clear();
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
 * Whether a node already has a decision in this pass.
 *
 * @param {Element} node Rendered node with a data-print-node id.
 * @return {boolean} True when a decision is recorded.
 */
export function hasDecision(node) {
	return decisions.has(node?.getAttribute?.('data-print-node'));
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
 * @param {Element} figure           Chart figure.
 * @param {Element} lead             Its intro.
 * @param {Object}  [options]        Options.
 * @param {boolean} options.stuck    Whether the chart was first on its page.
 * @param {boolean} options.fitTried Whether the chart already failed to fit under its intro, even shrunk.
 * @param {boolean} options.fillOnly Whether only a delay that fills the intro's page may apply (a chart whose delay was undone).
 */
export function requestDelay(
	figure,
	lead,
	{ stuck = false, fitTried = false, fillOnly = false } = {}
) {
	const figureId = figure.getAttribute('data-print-node');
	const leadId = lead.getAttribute('data-print-node');
	if (figureId && leadId) {
		delays.set(figureId, { leadId, stuck, fitTried, fillOnly });
	}
	recordDecision(figure, stuck ? 'stuck:delay:0px' : 'delay:0px');
}

/**
 * Ask the next pass to move a chart up in its section, before a block.
 *
 * @param {Element} figure Chart figure.
 * @param {Element} before Block the chart moves in front of.
 * @param {string}  label  Decision label.
 */
export function requestHoist(figure, before, label) {
	const figureId = figure.getAttribute('data-print-node');
	const beforeId = before.getAttribute('data-print-node');
	if (figureId && beforeId) {
		hoists.set(figureId, { beforeId, label });
	}
	recordDecision(figure, label);
}

/**
 * Ask the next pass to float a centered companion chart right.
 *
 * @param {Element} figure Chart figure.
 */
export function requestFloat(figure) {
	const figureId = figure.getAttribute('data-print-node');
	if (figureId) {
		floats.add(figureId);
	}
}

/**
 * @return {Map<string, {beforeId: string, label: string}>} Hoist requests by figure id.
 */
export function getHoistRequests() {
	return new Map(hoists);
}

/**
 * @return {Set<string>} Figure ids to float.
 */
export function getFloatRequests() {
	return new Set(floats);
}

/**
 * @return {Map<string, {leadId: string, stuck: boolean, fitTried: boolean, fillOnly: boolean}>} Delay requests by figure id.
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
