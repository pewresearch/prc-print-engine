/**
 * Print chart reflow: right-only floats, 640 stack, keep intro+headings with the chart.
 */

const SIZED_IMAGE_CLASSES = [
	'size-200-wide',
	'size-310-wide',
	'size-420-wide',
	'size-640-wide',
];

const STACK_WIDTH = 640;

// The article title header counts as a heading, not body copy.
export const PRINT_HEADING_SELECTOR =
	'h1, h2, h3, h4, h5, h6, .print-engine-body-header';

/**
 * Producer-set display width of a resized chart figure, in px.
 *
 * The editor resize handle writes `width:Npx` on the img and `is-resized` on
 * the figure. PHP copies it to `data-print-width`; the inline style is the
 * fallback for markup that skipped the server pass. Only size-*-wide charts
 * count: a resized photo keeps its own layout (alignment, aspect-ratio crop).
 *
 * @param {Element|null} figure Figure node.
 * @return {number|null} Width in px, or null when the producer set none.
 */
export function getProducerImageWidth(figure) {
	if (
		!figure ||
		figure.tagName !== 'FIGURE' ||
		!SIZED_IMAGE_CLASSES.some((slug) => figure.classList.contains(slug))
	) {
		return null;
	}
	const pinned = parseInt(figure.getAttribute('data-print-width') || '', 10);
	if (pinned > 0) {
		return pinned;
	}
	if (!figure.classList.contains('is-resized')) {
		return null;
	}
	const img = figure.querySelector('img');
	const match = /(?:^|;)\s*width\s*:\s*(\d+(?:\.\d+)?)px/i.exec(
		img?.getAttribute('style') || ''
	);
	return match ? Math.round(parseFloat(match[1])) : null;
}

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
	if (figure.classList.contains('print-engine-chart--stack')) {
		return true;
	}
	const producerWidth = getProducerImageWidth(figure);
	if (producerWidth) {
		return producerWidth >= STACK_WIDTH;
	}
	if (figure.classList.contains('size-640-wide')) {
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
