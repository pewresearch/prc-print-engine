/**
 * Section and node tags for page-fill decisions.
 *
 * A section is the content introduced by an H2, H3 or H4. Each block in the
 * article or chapter body gets `data-print-section` (chapter index and
 * section number) so a delayed chart never leaves its intro's section, and
 * `data-print-node`, a stable id the float guard uses to record decisions
 * and to move a delayed chart between pagination passes.
 */

const CONTENT_ROOTS =
	'.print-engine-article__content, .print-engine-chapter__content';
const SECTION_HEADINGS = new Set(['H2', 'H3', 'H4']);
// Containers whose children take part in chart delays and box splits.
const BLOCK_PARENTS =
	'.print-engine-chart-unit__lead, .wp-block-group, .print-engine-box, details';

/**
 * The section heading an element opens with, if any.
 *
 * @param {Element} el Block element.
 * @return {Element|null} Heading.
 */
function leadingHeading(el) {
	let node = el;
	while (node && !SECTION_HEADINGS.has(node.tagName)) {
		node = node.firstElementChild;
	}
	return node;
}

/**
 * Whether an element is a block that gets section and node tags.
 *
 * @param {Element} el        Element.
 * @param {Element} container Content root.
 * @return {boolean} True for tagged blocks.
 */
function isTaggedBlock(el, container) {
	const parent = el.parentElement;
	return (
		el.tagName === 'FIGURE' ||
		parent === container ||
		Boolean(parent?.matches(BLOCK_PARENTS))
	);
}

/**
 * Tag body blocks with their section and a stable node id.
 *
 * @param {DocumentFragment|Element} root Content root.
 */
export function tagPrintSections(root) {
	let nodeId = 0;
	root.querySelectorAll(CONTENT_ROOTS).forEach((container, chapter) => {
		let section = 0;
		// The chapter title or body header above the content.
		const title = container.previousElementSibling;
		if (title) {
			nodeId += 1;
			title.setAttribute('data-print-section', `${chapter}-0`);
			title.setAttribute('data-print-node', String(nodeId));
		}
		const counted = new Set();
		const walker = container.ownerDocument.createTreeWalker(
			container,
			1 // NodeFilter.SHOW_ELEMENT
		);
		for (let el = walker.nextNode(); el; el = walker.nextNode()) {
			if (
				!isTaggedBlock(el, container) &&
				!SECTION_HEADINGS.has(el.tagName)
			) {
				continue;
			}
			// A block that opens with a section heading starts that section.
			const heading = SECTION_HEADINGS.has(el.tagName)
				? el
				: leadingHeading(el);
			if (heading && !counted.has(heading)) {
				counted.add(heading);
				section += 1;
			}
			if (isTaggedBlock(el, container)) {
				nodeId += 1;
				el.setAttribute('data-print-section', `${chapter}-${section}`);
				el.setAttribute('data-print-node', String(nodeId));
			}
		}
	});
}
