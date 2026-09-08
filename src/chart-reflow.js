/**
 * Print chart reflow: right-only floats, 640 stack, keep intro+headings with the chart.
 */

const SIZED_IMAGE_CLASSES = [
	'size-200-wide',
	'size-310-wide',
	'size-420-wide',
	'size-640-wide',
];

/**
 * Whether a node is a print chart or sized Excel/Illustrator figure.
 *
 * @param {Element|null} el Candidate node.
 * @return {boolean} True when the figure participates in print reflow.
 */
export function isPrintChartFigure(el) {
	if (!el || el.tagName !== 'FIGURE') {
		return false;
	}
	const className = typeof el.className === 'string' ? el.className : '';
	if (className.split(/\s+/).includes('print-engine-chart')) {
		return true;
	}
	if (!className.split(/\s+/).includes('wp-block-image')) {
		return false;
	}
	return SIZED_IMAGE_CLASSES.some((slug) =>
		className.split(/\s+/).includes(slug)
	);
}

/**
 * Remap alignment and wrap heading+intro leads before Paged.js runs.
 *
 * @param {DocumentFragment|Element} root Content root.
 */
export function reflowPrintCharts(root) {
	if (!root || !root.querySelectorAll) {
		return;
	}
	remapFloatedCharts(root);
	wrapChartIntroLeads(root);
}

/**
 * Force companion charts to float right. Stack 640-wide figures.
 *
 * @param {DocumentFragment|Element} root Content root.
 */
function remapFloatedCharts(root) {
	root.querySelectorAll('figure').forEach((figure) => {
		if (!isPrintChartFigure(figure)) {
			return;
		}
		if (shouldStackFigure(figure)) {
			figure.classList.remove('alignleft', 'alignright');
			figure.classList.add('aligncenter', 'print-engine-chart--stack');
			return;
		}
		if (figure.classList.contains('alignleft')) {
			figure.classList.remove('alignleft');
			figure.classList.add('alignright');
		}
	});
}

/**
 * @param {Element} figure Figure node.
 * @return {boolean} True when the figure should not float.
 */
function shouldStackFigure(figure) {
	if (figure.classList.contains('size-640-wide')) {
		return true;
	}
	if (figure.classList.contains('print-engine-chart--stack')) {
		return true;
	}
	const style = figure.getAttribute('style') || '';
	return /(?:^|[^\d])640px/.test(style);
}

/**
 * Wrap headings + the intro paragraph immediately before each chart.
 *
 * `break-after: avoid` on the lead keeps that group with the figure when
 * Paged.js introduces a page break. The figure stays a sibling so floats
 * still wrap following copy.
 *
 * @param {DocumentFragment|Element} root Content root.
 */
function wrapChartIntroLeads(root) {
	const figures = Array.from(root.querySelectorAll('figure')).filter(
		isPrintChartFigure
	);

	figures.forEach((figure) => {
		const prev = figure.previousElementSibling;
		if (
			prev &&
			prev.classList &&
			prev.classList.contains('print-engine-chart-unit__lead')
		) {
			return;
		}

		const collected = collectLeadNodes(figure);
		if (!collected.length || !figure.parentNode) {
			return;
		}

		const lead = figure.ownerDocument.createElement('div');
		lead.className = 'print-engine-chart-unit__lead';
		figure.parentNode.insertBefore(lead, collected[0]);
		collected.forEach((node) => {
			lead.appendChild(node);
		});
	});
}

/**
 * Headings that immediately precede the intro paragraph, plus that paragraph.
 *
 * @param {Element} figure Chart figure.
 * @return {Element[]} Nodes to keep with the figure, document order.
 */
function collectLeadNodes(figure) {
	const collected = [];
	let node = previousSignificantElement(figure);

	if (node && node.tagName === 'P') {
		collected.unshift(node);
		node = previousSignificantElement(node);
	}

	while (node && isHeadingElement(node)) {
		collected.unshift(node);
		node = previousSignificantElement(node);
	}

	return collected;
}

/**
 * @param {Element} el Node.
 * @return {boolean} True for h1–h6.
 */
function isHeadingElement(el) {
	return /^H[1-6]$/.test(el.tagName);
}

/**
 * Previous element sibling, skipping empty paragraphs.
 *
 * @param {Element} el Node.
 * @return {Element|null} Previous significant sibling.
 */
function previousSignificantElement(el) {
	let node = el.previousElementSibling;
	while (node && node.tagName === 'P' && isEmptyElement(node)) {
		node = node.previousElementSibling;
	}
	return node;
}

/**
 * @param {Element} el Node.
 * @return {boolean} True when the node has no visible text.
 */
function isEmptyElement(el) {
	const text = (el.textContent || '').replace(/\u00a0/g, ' ').trim();
	return text === '';
}
